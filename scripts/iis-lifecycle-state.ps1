Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-LifecycleCollection {
    param([string]$PSPath, [string]$Filter, [string]$Location)
    $options = @{ PSPath = $PSPath; Filter = $Filter; Name = '.'; ErrorAction = 'Stop' }
    if ($Location) { $options.Location = $Location }
    return @(Get-WebConfigurationProperty @options)
}

function Get-LifecycleFingerprint {
    param([string]$Value, [byte[]]$Key)
    $hmac = New-Object System.Security.Cryptography.HMACSHA256 (,$Key)
    try {
        return [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))
    } finally {
        $hmac.Dispose()
    }
}

function Get-LifecycleHandlers {
    param([string]$PSPath, [string]$Location, [byte[]]$FingerprintKey)
    $items = @(
        Get-LifecycleCollection -PSPath $PSPath -Location $Location -Filter 'system.webServer/handlers/add' |
            ForEach-Object {
                $processor = ([string]$_.scriptProcessor).Split([char[]]@('|'), 2)
                [pscustomobject]@{
                    Name = [string]$_.name
                    Path = [string]$_.path
                    Verb = [string]$_.verb
                    Modules = [string]$_.modules
                    ScriptProcessor = $processor[0]
                    HasArguments = $processor.Count -gt 1
                    ArgumentsFingerprint = if ($processor.Count -gt 1) {
                        Get-LifecycleFingerprint -Value $processor[1] -Key $FingerprintKey
                    } else { $null }
                    ResourceType = [string]$_.resourceType
                    RequireAccess = [string]$_.requireAccess
                }
            }
    )
    return @($items | Sort-Object Name, Path, ScriptProcessor, Verb)
}

function Get-LifecycleSite {
    param([object]$Site, [byte[]]$FingerprintKey)
    $name = [string]$Site.Name
    $bindings = @(
        $Site.Bindings.Collection | ForEach-Object {
            [pscustomobject]@{
                Protocol = [string]$_.protocol
                BindingInformation = [string]$_.bindingInformation
                SslFlags = [int]$_.sslFlags
                CertificateHash = if ($_.certificateHash -is [byte[]]) {
                    [BitConverter]::ToString($_.certificateHash).Replace('-', '')
                } else { [string]$_.certificateHash }
                CertificateStoreName = [string]$_.certificateStoreName
            }
        } | Sort-Object Protocol, BindingInformation, CertificateHash
    )
    $applications = @(
        Get-WebApplication -Site $name -ErrorAction Stop | ForEach-Object {
            $appPath = [string]$_.Path
            [pscustomobject]@{
                Path = $appPath
                ApplicationPool = [string]$_.ApplicationPool
                PhysicalPath = [string]$_.PhysicalPath
                Handlers = @(Get-LifecycleHandlers -PSPath ("IIS:\Sites\$name\" + $appPath.TrimStart('/').Replace('/', '\')) -FingerprintKey $FingerprintKey)
            }
        } | Sort-Object Path, ApplicationPool
    )
    return [pscustomobject]@{
        Exists = $true
        Name = $name
        State = [string](Get-WebsiteState -Name $name -ErrorAction Stop).Value
        PhysicalPath = [string]$Site.PhysicalPath
        ApplicationPool = [string]$Site.ApplicationPool
        Bindings = @($bindings)
        Applications = @($applications)
        Handlers = @(Get-LifecycleHandlers -PSPath "IIS:\Sites\$name" -FingerprintKey $FingerprintKey)
    }
}

function Get-LifecycleInventory {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    $entries = @(
        Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction Stop | ForEach-Object {
            $item = $_
            [pscustomobject]@{
                RelativePath = $item.FullName.Substring($Root.TrimEnd('\', '/').Length + 1).Replace('\', '/')
                IsDirectory = [bool]$item.PSIsContainer
                Length = if ($item.PSIsContainer) { $null } else { [int64]$item.Length }
                Sha256 = if ($item.PSIsContainer) { $null } else {
                    (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
                }
            }
        }
    )
    return @($entries | Sort-Object RelativePath)
}

function Test-LifecycleSecurityState {
    param([string]$Path, [object]$PriorState = $null)
    try {
        $file = Get-Item -LiteralPath $Path -ErrorAction Stop
        if ($file.Length -gt 4096) { return $false }
        $state = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        $keys = @('authentication_required', 'password_change_required', 'insufficient_role', 'invalid_csrf', 'logout')
        if (@($state.PSObject.Properties).Count -ne $keys.Count) { return $false }
        $window = [math]::Floor(([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalSeconds / 60)
        foreach ($key in $keys) {
            if ($state.PSObject.Properties.Name -cnotcontains $key) { return $false }
            $value = $state.$key
            if (@($value.PSObject.Properties).Count -ne 2 -or
                $value.PSObject.Properties.Name -cnotcontains 'window' -or
                $value.PSObject.Properties.Name -cnotcontains 'count' -or
                ($value.window -isnot [long] -and $value.window -isnot [int]) -or
                ($value.count -isnot [long] -and $value.count -isnot [int]) -or
                $value.window -lt 0 -or $value.window -gt $window -or
                $value.count -lt 0 -or $value.count -gt 11) { return $false }
            if ($null -ne $PriorState) {
                $prior = $PriorState.$key
                if ($value.window -lt $prior.window -or
                    ($value.window -eq $prior.window -and $value.count -lt $prior.count) -or
                    ($value.window -gt $prior.window -and $value.count -lt 1)) { return $false }
            }
        }
        return $true
    } catch { return $false }
}

function Get-LifecycleLogEvidence {
    param([string]$Root, [object[]]$PriorData, [object]$PriorSecurityState = $null)
    foreach ($old in @($PriorData | Where-Object { -not $_.IsDirectory -and $_.RelativePath.Replace('\', '/') -like 'logs/*' })) {
        $relative = $old.RelativePath.Replace('\', '/')
        $path = Join-Path $Root $relative
        $prefixHash = $null
        $validState = $false
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            if ($relative -ceq 'logs/audit/.security-window') {
                $validState = $null -ne $PriorSecurityState -and (Test-LifecycleSecurityState -Path $path -PriorState $PriorSecurityState)
            } else {
                $stream = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
                $sha = [Security.Cryptography.SHA256]::Create()
                try {
                    if ($stream.Length -ge [long]$old.Length) {
                        $remaining = [long]$old.Length
                        $buffer = New-Object byte[] 65536
                        while ($remaining -gt 0) {
                            $count = $stream.Read($buffer, 0, [int][math]::Min($buffer.Length, $remaining))
                            if ($count -eq 0) { throw 'Unexpected end of log' }
                            [void]$sha.TransformBlock($buffer, 0, $count, $buffer, 0)
                            $remaining -= $count
                        }
                        [void]$sha.TransformFinalBlock($buffer, 0, 0)
                        $prefixHash = [BitConverter]::ToString($sha.Hash).Replace('-', '').ToLowerInvariant()
                    }
                } finally { $sha.Dispose(); $stream.Dispose() }
            }
        }
        [pscustomobject]@{ RelativePath = $relative; PriorLength = $old.Length; PrefixSha256 = $prefixHash; SecurityStateValid = $validState }
    }
}

function Get-LifecycleAcl {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{ Path = $Path; Exists = $false; Protected = $null; Rules = @() }
    }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $rules = @(
        $acl.Access | ForEach-Object {
            $sid = try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $null }
            [pscustomobject]@{
                Identity = [string]$_.IdentityReference
                Sid = $sid
                Rights = [string]$_.FileSystemRights
                Type = [string]$_.AccessControlType
                Inherited = [bool]$_.IsInherited
                InheritanceFlags = [string]$_.InheritanceFlags
                PropagationFlags = [string]$_.PropagationFlags
            }
        } | Sort-Object Identity, Type, Rights, Inherited, InheritanceFlags
    )
    return [pscustomobject]@{
        Path = $Path
        Exists = $true
        Protected = [bool]$acl.AreAccessRulesProtected
        Rules = @($rules)
    }
}

function Get-LifecycleDatabase {
    param([string]$InstallRoot, [string]$DbPath, [string]$PhpCgiPath, [string]$DbHash)
    $exists = Test-Path -LiteralPath $DbPath -PathType Leaf
    $expected = $null
    $source = Join-Path $InstallRoot 'src/Core/DatabaseSchema.php'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        # Evaluate rollback results against the schema contract of that version.
        $source = Join-Path $InstallRoot 'database.php'
    }
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        $databaseSource = Get-Content -LiteralPath $source -Raw -Encoding UTF8 -ErrorAction Stop
        if ($databaseSource -match '(?m)^\s*const\s+APP_DATABASE_SCHEMA_VERSION\s*=\s*(\d+)\s*;') {
            $expected = [int]$Matches[1]
        }
    }
    $hash = if ($exists) { $DbHash } else { $null }
    $result = [pscustomobject]@{
        Path = $DbPath
        Exists = [bool]$exists
        Hash = $hash
        ExpectedSchemaVersion = $expected
        Version = $null
        SchemaVersion = $null
        TableCount = $null
        Counts = [pscustomobject]@{ Users = $null; Views = $null; Devices = $null; Links = $null }
        Error = $null
    }
    if (-not $exists) { return $result }
    $php = Join-Path (Split-Path -Parent $PhpCgiPath) 'php.exe'
    if (-not (Test-Path -LiteralPath $php -PathType Leaf)) {
        $result.Error = 'PHP CLI beside PhpCgiPath is unavailable'
        return $result
    }
    # Query SQLite in read-only mode without loading initialization routines.
    # OPEN_READONLY prevents database creation, and no statement in this probe changes persistent state.
    $probe = @'
$db = new SQLite3($argv[1], SQLITE3_OPEN_READONLY);
$db->enableExceptions(true);
$db->busyTimeout(1000);
if (!$db->exec('PRAGMA query_only = ON')) { throw new RuntimeException('Cannot enable read-only query mode'); }
$version = (int)$db->querySingle('PRAGMA user_version');
$q = chr(39);
$tableCount = (int)$db->querySingle('SELECT count(*) FROM sqlite_master WHERE type = ' . $q . 'table' . $q . ' AND name NOT LIKE ' . $q . 'sqlite_%' . $q);
$counts = [];
foreach (['users', 'views', 'devices', 'links'] as $table) {
    $present = (int)$db->querySingle('SELECT count(*) FROM sqlite_master WHERE type = ' . $q . 'table' . $q . ' AND name = ' . $q . $table . $q);
    $counts[ucfirst($table)] = $present ? (int)$db->querySingle('SELECT count(*) FROM [' . $table . ']') : null;
}
echo json_encode(['Version' => $version, 'TableCount' => $tableCount, 'Counts' => $counts], JSON_THROW_ON_ERROR);
$db->close();
'@
    try {
        $raw = & $php -d 'auto_prepend_file=' -d 'auto_append_file=' -r $probe -- $DbPath 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'Read-only SQLite probe failed' }
        $info = ($raw | Out-String).Trim() | ConvertFrom-Json -ErrorAction Stop
        $result.Version = [int]$info.Version
        $result.SchemaVersion = [int]$info.Version
        $result.TableCount = [int]$info.TableCount
        $result.Counts = $info.Counts
    } catch {
        # No PHP diagnostic text is copied into the report: it may contain deployment-specific values.
        $result.Error = 'Read-only SQLite probe failed'
    }
    return $result
}

function Get-LifecycleHttp {
    param([uri]$Url, [switch]$SkipHttp)
    $result = [pscustomobject]@{
        Url = $Url.Scheme + '://' + $Url.DnsSafeHost + ':' + $Url.Port + $Url.AbsolutePath
        StatusCode = $null
        RedirectsToSetup = $false
        Error = $null
    }
    if ($SkipHttp) {
        $result.Error = 'Probe skipped (read-only inspection)'
        return $result
    }
    $response = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Method = 'GET'
        $request.AllowAutoRedirect = $false
        $request.Timeout = 10000
        $request.ReadWriteTimeout = 10000
        $request.CachePolicy = New-Object System.Net.Cache.RequestCachePolicy([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)
        try {
            $response = [System.Net.HttpWebResponse]$request.GetResponse()
        } catch [System.Net.WebException] {
            if ($_.Exception.Response) {
                $response = [System.Net.HttpWebResponse]$_.Exception.Response
            } else {
                $result.Error = [string]$_.Exception.Status
            }
        }
        if ($response) {
            $result.StatusCode = [int]$response.StatusCode
            $redirect = [string]$response.Headers['Location']
            if ($result.StatusCode -eq 302 -and -not [string]::IsNullOrEmpty($redirect)) {
                $redirectUri = $null
                if ([uri]::TryCreate($Url, $redirect, [ref]$redirectUri)) {
                    $result.RedirectsToSetup = $redirectUri.AbsolutePath -match '(?i)(^|/)setup\.php$'
                }
            }
        }
    } catch {
        $result.Error = $_.Exception.GetType().Name
    } finally {
        if ($response) { $response.Dispose() }
    }
    return $result
}

function Get-LifecycleLocationPath {
    param([object]$Location)
    if ($Location.PSObject.Properties['Path'] -and -not [string]::IsNullOrWhiteSpace([string]$Location.Path)) {
        return [string]$Location.Path
    }
    if ($Location.PSObject.Properties['Name'] -and -not [string]::IsNullOrWhiteSpace([string]$Location.Name)) {
        return [string]$Location.Name
    }
    throw 'IIS location has no path.'
}

function Get-LifecycleSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SiteName,
        [Parameter(Mandatory = $true)][string]$ApplicationPoolName,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$RollbackRoot,
        [Parameter(Mandatory = $true)][string]$PhpCgiPath,
        [Parameter(Mandatory = $true)][uri]$VerificationUrl,
        [Parameter(Mandatory = $true)][byte[]]$FingerprintKey,
        [switch]$SkipHttp,
        [object[]]$PriorData = @(),
        [object]$PriorSecurityState = $null
    )

    Import-Module WebAdministration -ErrorAction Stop
    foreach ($name in @('Get-Website', 'Get-WebsiteState', 'Get-WebApplication', 'Get-WebAppPoolState', 'Get-WebConfigurationLocation', 'Get-WebConfigurationProperty')) {
        if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "IIS query command unavailable: $name" }
    }
    $root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
    $rollback = [IO.Path]::GetFullPath($RollbackRoot).TrimEnd('\', '/')
    $cgi = [IO.Path]::GetFullPath($PhpCgiPath)
    $machine = 'MACHINE/WEBROOT/APPHOST'

    $sites = @(Get-Website -ErrorAction Stop | ForEach-Object { Get-LifecycleSite -Site $_ -FingerprintKey $FingerprintKey } | Sort-Object Name)
    $site = @($sites | Where-Object { $_.Name -ieq $SiteName } | Select-Object -First 1)
    if ($site.Count -eq 0) {
        $site = @([pscustomobject]@{ Exists = $false; Name = $SiteName; State = $null; PhysicalPath = $null; ApplicationPool = $null; Bindings = @(); Applications = @(); Handlers = @() })
    }
    $pools = @(
        Get-ChildItem -LiteralPath 'IIS:\AppPools' -ErrorAction Stop | ForEach-Object {
            [pscustomobject]@{
                Exists = $true
                Name = [string]$_.Name
                State = [string](Get-WebAppPoolState -Name ([string]$_.Name) -ErrorAction Stop).Value
                StartMode = [string]$_.startMode
                ManagedRuntimeVersion = [string]$_.managedRuntimeVersion
                IdentityType = [string]$_.processModel.identityType
                UserName = [string]$_.processModel.userName
                PasswordFingerprint = if ([string]::IsNullOrEmpty([string]$_.processModel.password)) { $null } else {
                    Get-LifecycleFingerprint -Value ([string]$_.processModel.password) -Key $FingerprintKey
                }
            }
        } | Sort-Object Name
    )
    $pool = @($pools | Where-Object { $_.Name -ieq $ApplicationPoolName } | Select-Object -First 1)
    if ($pool.Count -eq 0) {
        $pool = @([pscustomobject]@{ Exists = $false; Name = $ApplicationPoolName; State = $null; StartMode = $null; ManagedRuntimeVersion = $null; IdentityType = $null; UserName = $null; PasswordFingerprint = $null })
    }
    $fastCgi = @(
        Get-LifecycleCollection -PSPath $machine -Filter 'system.webServer/fastCgi/application' | ForEach-Object {
            [pscustomobject]@{
                FullPath = [string]$_.fullPath
                HasArguments = -not [string]::IsNullOrEmpty([string]$_.arguments)
                ArgumentsFingerprint = if ([string]::IsNullOrEmpty([string]$_.arguments)) { $null } else {
                    Get-LifecycleFingerprint -Value ([string]$_.arguments) -Key $FingerprintKey
                }
                ActivityTimeout = [int]$_.activityTimeout
                RequestTimeout = [int]$_.requestTimeout
                InstanceMaxRequests = [int]$_.instanceMaxRequests
                EnvironmentVariables = if ($_.PSObject.Properties.Name -contains 'environmentVariables' -and
                    $null -ne $_.environmentVariables -and
                    $_.environmentVariables.PSObject.Properties.Name -contains 'add') {
                    @($_.environmentVariables.add | ForEach-Object {
                        [pscustomobject]@{
                            Name = [string]$_.name
                            Fingerprint = Get-LifecycleFingerprint -Value ([string]$_.value) -Key $FingerprintKey
                        }
                    } | Sort-Object Name, Fingerprint)
                } else { @() }
            }
        } | Sort-Object FullPath, HasArguments
    )
    $locations = @(
        Get-WebConfigurationLocation -PSPath $machine -ErrorAction Stop | ForEach-Object {
            $locationPath = Get-LifecycleLocationPath -Location $_
            $requestLimit = Get-WebConfigurationProperty -PSPath $machine -Location $locationPath -Filter 'system.webServer/security/requestFiltering/requestLimits' -Name 'maxAllowedContentLength' -ErrorAction Stop
            $defaultDocuments = @(Get-LifecycleCollection -PSPath $machine -Location $locationPath -Filter 'system.webServer/defaultDocument/files/add' |
                ForEach-Object { [string]$_.value } | Sort-Object)
            $phpFilters = @(Get-LifecycleCollection -PSPath $machine -Location $locationPath -Filter 'system.webServer/security/requestFiltering/fileExtensions/add' |
                Where-Object { [string]$_.fileExtension -ieq '.php' } |
                ForEach-Object { [pscustomobject]@{ FileExtension = [string]$_.fileExtension; Allowed = [bool]$_.allowed } } |
                Sort-Object FileExtension, Allowed)
            [pscustomobject]@{
                Path = $locationPath
                Handlers = @(Get-LifecycleHandlers -PSPath $machine -Location $locationPath -FingerprintKey $FingerprintKey)
                RequestLimit = if ($null -eq $requestLimit) { $null } else { [string]$requestLimit }
                DefaultDocuments = @($defaultDocuments)
                PhpFilters = @($phpFilters)
            }
        } | Sort-Object Path
    )
    $paths = @(
        @($root, (Join-Path $root 'public'), (Join-Path $root 'src'), (Join-Path $root 'templates'),
          (Join-Path $root 'resources'), (Join-Path $root 'scripts'), (Join-Path $root 'config'), (Join-Path $root 'config/app.php'),
          (Join-Path $root 'data'), (Join-Path $root 'data/db'), (Join-Path $root 'data/db/data.sqlite'),
          (Join-Path $root 'data/uploads'), (Join-Path $root 'data/backups'), (Join-Path $root 'data/logs'),
          (Join-Path $root 'data/temp'), $rollback) | ForEach-Object {
            [pscustomobject]@{ Path = $_; Exists = [bool](Test-Path -LiteralPath $_); IsDirectory = [bool](Test-Path -LiteralPath $_ -PathType Container) }
        }
    )
    $program = @()
    foreach ($relative in @('public', 'src', 'templates', 'resources', 'scripts')) {
        $dir = Join-Path $root $relative
        foreach ($item in @(Get-LifecycleInventory -Root $dir)) {
            $program += [pscustomobject]@{ RelativePath = "$relative/$($item.RelativePath)"; IsDirectory = $item.IsDirectory; Length = $item.Length; Sha256 = $item.Sha256 }
        }
    }
    foreach ($relative in @('bootstrap.php', 'auth.php', 'database.php', 'version.php')) {
        $file = Join-Path $root $relative
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $program += [pscustomobject]@{ RelativePath = $relative; IsDirectory = $false; Length = (Get-Item -LiteralPath $file -ErrorAction Stop).Length; Sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() }
        }
    }
    $config = @(Get-LifecycleInventory -Root (Join-Path $root 'config'))
    $data = @(Get-LifecycleInventory -Root (Join-Path $root 'data'))
    $dbItems = @($data | Where-Object { $_.RelativePath -like 'db/*' } | ForEach-Object {
        [pscustomobject]@{
            RelativePath = $_.RelativePath.Substring(3)
            IsDirectory = $_.IsDirectory
            Length = $_.Length
            Sha256 = $_.Sha256
        }
    })
    $rollbackItems = @(Get-LifecycleInventory -Root $rollback)
    $unmanaged = @()
    if (Test-Path -LiteralPath $root -PathType Container) {
        $managedNames = @('public', 'src', 'templates', 'resources', 'scripts', 'config', 'data', 'bootstrap.php', 'auth.php', 'database.php', 'version.php')
        foreach ($entry in @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)) {
            if ($managedNames -contains $entry.Name) { continue }
            if ($entry.PSIsContainer) {
                $unmanaged += [pscustomobject]@{ RelativePath = $entry.Name; IsDirectory = $true; Length = $null; Sha256 = $null }
                foreach ($child in @(Get-LifecycleInventory -Root $entry.FullName)) {
                    $unmanaged += [pscustomobject]@{
                        RelativePath = ($entry.Name + '/' + $child.RelativePath)
                        IsDirectory = $child.IsDirectory
                        Length = $child.Length
                        Sha256 = $child.Sha256
                    }
                }
            } else {
                $unmanaged += [pscustomobject]@{
                    RelativePath = $entry.Name
                    IsDirectory = $false
                    Length = [int64]$entry.Length
                    Sha256 = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
                }
            }
        }
    }
    $dbPath = Join-Path $root 'data/db/data.sqlite'
    $mainDb = @($data | Where-Object { $_.RelativePath -eq 'db/data.sqlite' -and -not $_.IsDirectory })
    $dbHash = if ($mainDb.Count -eq 1) { $mainDb[0].Sha256 } else { $null }
    $database = Get-LifecycleDatabase -InstallRoot $root -DbPath $dbPath -PhpCgiPath $cgi -DbHash $dbHash
    $aclPaths = @($root, (Join-Path $root 'public'), (Join-Path $root 'src'), (Join-Path $root 'templates'), (Join-Path $root 'resources'), (Join-Path $root 'scripts'), (Join-Path $root 'config'), (Join-Path $root 'data'))
    $acl = @($aclPaths | ForEach-Object { Get-LifecycleAcl -Path $_ } | Sort-Object Path)
    return [pscustomobject]@{
        Iis = [pscustomobject]@{
            Site = $site[0]
            Sites = @($sites)
            Pool = $pool[0]
            Pools = @($pools)
            FastCgi = @($fastCgi)
            Locations = @($locations)
            GlobalHandlers = @(Get-LifecycleHandlers -PSPath $machine -FingerprintKey $FingerprintKey)
            DuplicateCounts = [pscustomobject]@{
                Sites = @($sites | Group-Object Name | Where-Object { $_.Count -gt 1 }).Count
                Pools = @($pools | Group-Object Name | Where-Object { $_.Count -gt 1 }).Count
                FastCgi = @($fastCgi | Group-Object FullPath, HasArguments | Where-Object { $_.Count -gt 1 }).Count
                Locations = @($locations | Group-Object Path | Where-Object { $_.Count -gt 1 }).Count
            }
        }
        Files = [pscustomobject]@{
            InstallRoot = $root
            RollbackRoot = $rollback
            Paths = @($paths)
            Program = @($program | Sort-Object RelativePath)
            Config = @($config)
            Data = @($data)
            Db = @($dbItems)
            Rollback = @($rollbackItems)
            Unmanaged = @($unmanaged | Sort-Object RelativePath)
            LogEvidence = @(Get-LifecycleLogEvidence -Root (Join-Path $root 'data') -PriorData $PriorData -PriorSecurityState $PriorSecurityState)
            SecurityState = $(
                $statePath = Join-Path $root 'data/logs/audit/.security-window'
                if (Test-LifecycleSecurityState -Path $statePath) {
                    Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
                } else { $null }
            )
            Counts = [pscustomobject]@{ Program = $program.Count; Config = $config.Count; Data = $data.Count; Db = $dbItems.Count; Rollback = $rollbackItems.Count; Unmanaged = $unmanaged.Count }
        }
        Db = $database
        Http = (Get-LifecycleHttp -Url ([uri]($VerificationUrl.GetLeftPart([UriPartial]::Path).TrimEnd('/') + '/login.php')) -SkipHttp:$SkipHttp)
        Acl = @($acl)
    }
}
