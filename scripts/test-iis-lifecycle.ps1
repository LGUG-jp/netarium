# Dedicated-machine acceptance harness. No deployment script is dot-sourced or modified.
# Inspect and Compare are non-destructive; all other scenarios require -AllowDestructive,
# -ConfirmTarget '<SiteName>/<ApplicationPoolName>/<HostName>', dedicated names and a .test/localhost URL.
# Rollback fixtures require a disposable release copy and a dedicated site: login.php is replaced
# ONLY inside a temporary release fixture with valid PHP returning 503. This passes source syntax
# preflight and CLI installation checks, then fails the post-start HTTP probe. Exit must be nonzero.
[CmdletBinding()]
param(
    [ValidateSet('Inspect', 'DryRun', 'Fresh', 'Repeat', 'Uninstall', 'RemoveData', 'Update', 'SetupRollback', 'UpdateRollback', 'Compare')]
    [string]$Scenario = 'Inspect',
    [ValidateSet('Inspect', 'DryRun', 'Fresh', 'Repeat', 'Uninstall', 'RemoveData', 'Update', 'SetupRollback', 'UpdateRollback')]
    [string]$CompareScenario = 'UpdateRollback',
    [ValidateSet('Fresh', 'Repeat', 'Uninstall', 'RemoveData', 'Update', 'SetupRollback', 'UpdateRollback')]
    [string]$DryRunAction = 'Uninstall',
    [string]$SiteName,
    [string]$ApplicationPoolName,
    [string]$InstallRoot,
    [string]$RollbackRoot,
    [string]$PhpCgiPath,
    [uri]$VerificationUrl,
    [string]$SourcePath,
    [ValidateSet('http', 'https')][string]$Protocol = 'http',
    [ValidateRange(1, 65535)][int]$Port = 80,
    [string]$HostName,
    [string]$CertificateThumbprint,
    [int]$MinimumPhpMemoryLimitMiB = 512,
    [int]$MinimumPhpMaxExecutionTimeSeconds = 300,
    [int]$FastCgiActivityTimeoutSeconds = 300,
    [int]$FastCgiRequestTimeoutSeconds = 300,
    [string]$ReportPath,
    [string]$BeforeJson,
    [string]$AfterJson,
    [switch]$AllowDestructive,
    [string]$ConfirmTarget,
    [switch]$RemoveData,
    [string]$ConfirmRemoveData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$rows = New-Object System.Collections.ArrayList
$script:failed = $false
$script:scenarioName = $Scenario
$script:phase = 'preflight'

function Add-LifecycleCheck {
    param([string]$Check, [bool]$Ok, [object]$Expected, [object]$Actual, [string]$ErrorText = '')
    if (-not $Ok) { $script:failed = $true }
    [void]$rows.Add([pscustomobject][ordered]@{
        Scenario = $script:scenarioName; Check = $Check; Result = if ($Ok) { 'PASS' } else { 'FAIL' }
        Expected = $Expected; Actual = $Actual; Timestamp = [DateTime]::UtcNow.ToString('o')
        Error = $ErrorText
    })
}
function Add-LifecycleSkip {
    param([string]$Check, [string]$Reason)
    [void]$rows.Add([pscustomobject][ordered]@{
        Scenario = $script:scenarioName; Check = $Check; Result = 'SKIP'
        Expected = 'Human or prerequisite-dependent verification'; Actual = $Reason
        Timestamp = [DateTime]::UtcNow.ToString('o'); Error = ''
    })
}
function Assert-Lifecycle {
    param([bool]$Condition, [string]$Reason)
    if (-not $Condition) { throw $Reason }
}
function Save-LifecycleJson {
    param([string]$Path, [object]$Value)
    $json = ConvertTo-Json -InputObject $Value -Depth 70
    [IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}
function Compare-LifecycleValue {
    param([object]$Left, [object]$Right)
    return ((ConvertTo-Json -InputObject $Left -Depth 70 -Compress) -ceq (ConvertTo-Json -InputObject $Right -Depth 70 -Compress))
}
function Assert-LifecycleSnapshotShape {
    param([object]$Snapshot)
    Assert-Lifecycle ($null -ne $Snapshot -and $null -ne $Snapshot.Iis -and $null -ne $Snapshot.Files -and
        $null -ne $Snapshot.Db -and $null -ne $Snapshot.Http -and $null -ne $Snapshot.Acl) 'Snapshot is missing required groups.'
    foreach ($name in @('Site', 'Pool', 'Sites', 'Pools', 'FastCgi', 'Locations', 'GlobalHandlers')) {
        Assert-Lifecycle ($Snapshot.Iis.PSObject.Properties.Name -contains $name) 'Snapshot IIS group is incomplete.'
    }
    foreach ($name in @('Program', 'Config', 'Data', 'Db', 'Rollback', 'Unmanaged', 'Paths')) {
        Assert-Lifecycle ($Snapshot.Files.PSObject.Properties.Name -contains $name) 'Snapshot file inventory is incomplete.'
        Assert-Lifecycle ($null -ne $Snapshot.Files.$name -and $Snapshot.Files.$name -is [array]) 'Snapshot file inventory must be an array.'
    }
    Assert-Lifecycle ($Snapshot.Iis.Site.PSObject.Properties.Name -contains 'Exists' -and
        $Snapshot.Iis.Pool.PSObject.Properties.Name -contains 'Exists' -and
        $Snapshot.Db.PSObject.Properties.Name -contains 'Hash' -and
        $Snapshot.Db.PSObject.Properties.Name -contains 'Version' -and
        $Snapshot.Http.PSObject.Properties.Name -contains 'StatusCode') 'Snapshot target evidence is incomplete.'
}

function Get-LifecycleForeign {
    param([object]$Snapshot, [string]$Name, [string]$Pool, [string]$Cgi)
    return [pscustomobject]@{
        Sites = @($Snapshot.Iis.Sites | Where-Object { $_.Name -ine $Name })
        Pools = @($Snapshot.Iis.Pools | Where-Object { $_.Name -ine $Pool })
        Locations = @($Snapshot.Iis.Locations | Where-Object { $_.Path -ine $Name })
        FastCgi = @($Snapshot.Iis.FastCgi | Where-Object { $_.FullPath -ine $Cgi -or $_.HasArguments })
        GlobalHandlers = @($Snapshot.Iis.GlobalHandlers)
    }
}
function Test-LifecycleTarget {
    param([object]$Snapshot, [bool]$Installed)
    $site = $Snapshot.Iis.Site
    $pool = $Snapshot.Iis.Pool
    if (-not $Installed) { return (-not $site.Exists -and -not $pool.Exists) }
    $expected = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'public')).TrimEnd('\', '/')
    if (-not $site.Exists -or -not $pool.Exists -or $site.ApplicationPool -ine $ApplicationPoolName) { return $false }
    if ([string]::IsNullOrWhiteSpace([string]$site.PhysicalPath)) { return $false }
    return ([IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$site.PhysicalPath)).TrimEnd('\', '/') -ieq $expected)
}
function Test-LifecycleAcl {
    param([object]$Snapshot)
    $identity = 'IIS AppPool\' + $ApplicationPoolName
    $write = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($name in @('', 'public', 'src', 'templates', 'resources', 'scripts', 'config', 'data')) {
        $path = if ($name) { Join-Path $InstallRoot $name } else { $InstallRoot }
        $items = @($Snapshot.Acl | Where-Object { $_.Path -ieq $path })
        if ($items.Count -ne 1 -or -not $items[0].Exists) { return $false }
        $entry = $items[0]
        if ($name -ne 'data' -and -not $entry.Protected) { return $false }
        foreach ($rule in @($entry.Rules | Where-Object { $_.Type -eq 'Allow' -and $_.Sid -in @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-568') })) {
            try { $broadRights = [Security.AccessControl.FileSystemRights][Enum]::Parse([Security.AccessControl.FileSystemRights], [string]$rule.Rights) }
            catch { return $false }
            if (($broadRights -band $write) -ne 0) { return $false }
        }
        $found = $false
        foreach ($rule in @($entry.Rules | Where-Object { $_.Identity -ieq $identity -and $_.Type -eq 'Allow' })) {
            try { $rights = [Security.AccessControl.FileSystemRights][Enum]::Parse([Security.AccessControl.FileSystemRights], [string]$rule.Rights) }
            catch { return $false }
            if ($name -eq 'data') {
                if (($rights -band [Security.AccessControl.FileSystemRights]::Modify) -eq [Security.AccessControl.FileSystemRights]::Modify) { $found = $true }
            } else {
                if (($rights -band $write) -ne 0) { return $false }
                if (($rights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq [Security.AccessControl.FileSystemRights]::ReadAndExecute) { $found = $true }
            }
        }
        if (-not $found) { return $false }
    }
    return $true
}

function Compare-LifecycleSnapshots {
    param([object]$Before, [object]$After, [string]$Mode, [string]$Name, [string]$Pool, [string]$Cgi)
    $foreignBefore = Get-LifecycleForeign -Snapshot $Before -Name $Name -Pool $Pool -Cgi $Cgi
    $foreignAfter = Get-LifecycleForeign -Snapshot $After -Name $Name -Pool $Pool -Cgi $Cgi
    Add-LifecycleCheck 'foreign IIS unchanged' (Compare-LifecycleValue $foreignBefore $foreignAfter) 'Identical sites, pools, locations, global handlers and foreign FastCGI' 'See before/after snapshots'
    $sharedCgi = @($Before.Iis.GlobalHandlers | Where-Object { $_.ScriptProcessor -ieq $Cgi -and -not $_.HasArguments }).Count -gt 0
    foreach ($foreignSite in @($Before.Iis.Sites | Where-Object { $_.Name -ine $Name })) {
        if (@($foreignSite.Handlers | Where-Object { $_.ScriptProcessor -ieq $Cgi -and -not $_.HasArguments }).Count -gt 0) { $sharedCgi = $true }
        foreach ($application in @($foreignSite.Applications)) {
            if (@($application.Handlers | Where-Object { $_.ScriptProcessor -ieq $Cgi -and -not $_.HasArguments }).Count -gt 0) { $sharedCgi = $true }
        }
    }
    if ($sharedCgi) {
        $beforeShared = @($Before.Iis.FastCgi | Where-Object { $_.FullPath -ieq $Cgi -and -not $_.HasArguments })
        $afterShared = @($After.Iis.FastCgi | Where-Object { $_.FullPath -ieq $Cgi -and -not $_.HasArguments })
        Add-LifecycleCheck 'shared FastCGI unchanged' (Compare-LifecycleValue $beforeShared $afterShared) 'Shared PHP mapping unchanged' 'See before/after FastCGI snapshots'
    }
    $expectInstalled = $Mode -in @('Fresh', 'Repeat', 'Update', 'UpdateRollback')
    if ($Mode -notin @('Inspect', 'DryRun', 'Compare')) {
        Add-LifecycleCheck 'target IIS ownership' (Test-LifecycleTarget -Snapshot $After -Installed $expectInstalled) $(if ($expectInstalled) { 'Dedicated site and pool mapped to InstallRoot/public' } else { 'Target site and pool absent' }) 'See after snapshot'
    }
    if ($expectInstalled) {
        Add-LifecycleCheck 'site and pool running' ($After.Iis.Site.State -eq 'Started' -and $After.Iis.Pool.State -eq 'Started') 'Both Started' "Site=$($After.Iis.Site.State); Pool=$($After.Iis.Pool.State)"
        Add-LifecycleCheck 'target IIS uniqueness' (@($After.Iis.Sites | Where-Object { $_.Name -ieq $Name }).Count -eq 1 -and
            @($After.Iis.Pools | Where-Object { $_.Name -ieq $Pool }).Count -eq 1) 'One site and one pool' 'See after IIS lists'
        $phpHandlers = @($After.Iis.Site.Handlers | Where-Object {
            $_.Name -eq 'Netarium-PHP' -and $_.Path -eq '*.php' -and $_.Modules -eq 'FastCgiModule' -and $_.ScriptProcessor -ieq $Cgi -and -not $_.HasArguments
        })
        Add-LifecycleCheck 'PHP handler and FastCGI' ($phpHandlers.Count -eq 1 -and
            @($After.Iis.FastCgi | Where-Object { $_.FullPath -ieq $Cgi -and -not $_.HasArguments }).Count -eq 1) 'One matched PHP handler and FastCGI application' 'See after IIS handlers and FastCGI'
        Add-LifecycleCheck 'target location present' (@($After.Iis.Locations | Where-Object { $_.Path -ieq $Name }).Count -eq 1) 'One site-specific location' 'See after IIS locations'
        $required = @('public', 'src', 'templates', 'resources', 'scripts', 'config', 'config/app.php', 'data', 'data/db', 'data/uploads', 'data/backups', 'data/temp', 'data/logs')
        $missing = @($required | Where-Object {
            $expectedPath = Join-Path $InstallRoot $_
            @($After.Files.Paths | Where-Object { $_.Path -ieq $expectedPath -and $_.Exists }).Count -ne 1
        })
        Add-LifecycleCheck 'runtime tree' ($missing.Count -eq 0) 'All managed directories and config/app.php exist' ($missing -join ', ')
        if ($Mode -ne 'UpdateRollback') {
            Add-LifecycleCheck 'current database schema' ($After.Db.Exists -and -not $After.Db.Error -and
                $null -ne $After.Db.Version -and $null -ne $After.Db.ExpectedSchemaVersion -and
                [int]$After.Db.Version -eq [int]$After.Db.ExpectedSchemaVersion) 'DB user_version equals release schema' "Version=$($After.Db.Version); expected=$($After.Db.ExpectedSchemaVersion)"
        }
        Add-LifecycleCheck 'application pool ACL least privilege' (Test-LifecycleAcl -Snapshot $After) 'Pool read/execute on code and config, Modify only on data' 'See after snapshot ACL rights'
    }
    if ($expectInstalled -and $HostName) {
        $binding = '*:{0}:{1}' -f $Port, $HostName
        Add-LifecycleCheck 'dedicated IIS binding' (@($After.Iis.Site.Bindings).Count -eq 1 -and @($After.Iis.Site.Bindings | Where-Object {
            $_.Protocol -ieq $Protocol -and $_.BindingInformation -ieq $binding
        }).Count -eq 1) 'Exactly one binding for dedicated host/protocol/port' 'See after snapshot bindings'
    }
    if ($Mode -in @('Uninstall', 'RemoveData', 'SetupRollback')) {
        Add-LifecycleCheck 'target location removed/restored' (@($After.Iis.Locations | Where-Object { $_.Path -ieq $Name }).Count -eq
            @($Before.Iis.Locations | Where-Object { $_.Path -ieq $Name -and $Mode -eq 'SetupRollback' }).Count) 'No target location after removal, or original location after rollback' 'See before/after IIS locations'
    }
    if ($Mode -in @('Inspect', 'DryRun', 'Compare', 'Repeat', 'SetupRollback', 'UpdateRollback')) {
        foreach ($part in @('Iis', 'Config', 'Data', 'Db', 'Program', 'Unmanaged', 'Acl')) {
            $a = switch ($part) { 'Iis' { $Before.Iis } 'Acl' { $Before.Acl } 'Db' { $Before.Db } default { $Before.Files.$part } }
            $b = switch ($part) { 'Iis' { $After.Iis } 'Acl' { $After.Acl } 'Db' { $After.Db } default { $After.Files.$part } }
            if ($part -eq 'Db') { $a = [pscustomobject]@{ Version = $a.Version; Hash = $a.Hash; Counts = $a.Counts }; $b = [pscustomobject]@{ Version = $b.Version; Hash = $b.Hash; Counts = $b.Counts } }
            Add-LifecycleCheck "$part restored/unchanged" (Compare-LifecycleValue $a $b) 'Identical snapshot fields' 'See before/after snapshots'
        }
        if ($Mode -in @('SetupRollback', 'UpdateRollback')) {
            Add-LifecycleCheck 'rollback snapshot created' (@($After.Files.Rollback).Count -gt @($Before.Files.Rollback).Count) 'New rollback inventory after post-snapshot failure' "Before=$(@($Before.Files.Rollback).Count); After=$(@($After.Files.Rollback).Count)"
        }
    } elseif ($Mode -eq 'Uninstall') {
        foreach ($part in @('Data', 'Db', 'Rollback')) {
            $a = if ($part -eq 'Db') { $Before.Db.Hash } else { $Before.Files.$part }
            $b = if ($part -eq 'Db') { $After.Db.Hash } else { $After.Files.$part }
            Add-LifecycleCheck "$part retained" (Compare-LifecycleValue $a $b) 'Identical retained data' 'See before/after snapshots'
        }
        $configBefore = @($Before.Files.Config | Where-Object { $_.RelativePath -ne 'app.example.php' })
        Add-LifecycleCheck 'runtime config retained' (Compare-LifecycleValue $configBefore $After.Files.Config) 'Only managed app.example.php removed; other config retained' 'See before/after snapshots'
        Add-LifecycleCheck 'unmanaged files retained' (Compare-LifecycleValue $Before.Files.Unmanaged $After.Files.Unmanaged) 'Identical unmanaged inventory' 'See before/after snapshots'
        Add-LifecycleCheck 'program removed' (@($After.Files.Program).Count -eq 0) 'No managed program files' "Count=$(@($After.Files.Program).Count)"
    } elseif ($Mode -eq 'RemoveData') {
        foreach ($part in @('Config', 'Data', 'Db', 'Rollback', 'Program')) {
            $entries = $After.Files.$part
            Add-LifecycleCheck "$part removed" (@($entries).Count -eq 0) 'No managed entries' "Count=$(@($entries).Count)"
        }
        Add-LifecycleCheck 'database removed' (-not $After.Db.Exists) 'Absent' ([string]$After.Db.Exists)
        Add-LifecycleCheck 'unmanaged files retained' (Compare-LifecycleValue $Before.Files.Unmanaged $After.Files.Unmanaged) 'Identical unmanaged inventory' 'See before/after snapshots'
    } else {
        foreach ($part in @('Config', 'Data', 'Db')) {
            if ($Mode -eq 'Update' -and $part -ne 'Db') {
                $a = if ($part -eq 'Config') {
                    @($Before.Files.Config | Where-Object { $_.RelativePath -ne 'app.example.php' })
                } else {
                    @($Before.Files.Data | Where-Object { $_.RelativePath -notmatch '\A(?:db|logs|temp)(?:[\\/]|$)' })
                }
                $b = if ($part -eq 'Config') {
                    @($After.Files.Config | Where-Object { $_.RelativePath -ne 'app.example.php' })
                } else {
                    @($After.Files.Data | Where-Object {
                        $_.RelativePath -notmatch '\A(?:db|logs|temp)(?:[\\/]|$)' -and
                        ($_.RelativePath -notmatch '\Asessions[\\/]sess_[A-Za-z0-9,-]+\z' -or
                            $Before.Files.Data.RelativePath -ccontains $_.RelativePath)
                    })
                }
                Add-LifecycleCheck "$part retained" (Compare-LifecycleValue $a $b) 'Identical runtime inventory' 'See before/after snapshots'
            } else {
                $entries = $After.Files.$part
                Add-LifecycleCheck "$part exists" (@($entries).Count -gt 0) 'Nonempty inventory' "Count=$(@($entries).Count)"
            }
        }
        if ($Mode -eq 'Update') {
            $schemaOk = $null -ne $Before.Db.Version -and $null -ne $After.Db.Version -and
                $null -ne $After.Db.ExpectedSchemaVersion -and
                [int]$After.Db.Version -ge [int]$Before.Db.Version -and
                [int]$After.Db.Version -eq [int]$After.Db.ExpectedSchemaVersion
            foreach ($table in @('Users', 'Views', 'Devices', 'Links')) {
                if ($null -ne $Before.Db.Counts.$table -and
                    ($null -eq $After.Db.Counts.$table -or [int]$After.Db.Counts.$table -lt [int]$Before.Db.Counts.$table)) {
                    $schemaOk = $false
                }
            }
            Add-LifecycleCheck 'database schema and rows' $schemaOk 'Current schema; no row loss across core tables' "Before=$($Before.Db.Version); After=$($After.Db.Version); See count snapshots"
            if ($schemaOk -and [int]$Before.Db.Version -lt [int]$After.Db.ExpectedSchemaVersion) {
                Add-LifecycleCheck 'database migration' ([int]$After.Db.Version -gt [int]$Before.Db.Version) 'Old schema advanced to current schema' "Before=$($Before.Db.Version); After=$($After.Db.Version)"
            } elseif ($schemaOk) {
                Add-LifecycleSkip 'database migration' 'Before DB already used the current schema; supply an older test fixture to exercise migration.'
            }
            $priorLogs = @($Before.Files.Data | Where-Object { $_.RelativePath.Replace('\', '/') -like 'logs/*' -and -not $_.IsDirectory })
            $logsPreserved = $true
            foreach ($old in $priorLogs) {
                $current = @($After.Files.Data | Where-Object { $_.RelativePath -ceq $old.RelativePath -and -not $_.IsDirectory })
                if ($current.Count -ne 1) { $logsPreserved = $false; continue }
                if ($current[0].Sha256 -ceq $old.Sha256) { continue }
                $evidence = @()
                if ($After.Files.PSObject.Properties.Name -contains 'LogEvidence') {
                    $evidence = @($After.Files.LogEvidence | Where-Object {
                        $_.RelativePath -ceq $old.RelativePath.Replace('\', '/') -and $_.PriorLength -eq $old.Length
                    })
                }
                if ($evidence.Count -ne 1) { $logsPreserved = $false; continue }
                if ($old.RelativePath.Replace('\', '/') -ceq 'logs/audit/.security-window') {
                    if (-not $evidence[0].SecurityStateValid) { $logsPreserved = $false }
                } elseif ($evidence[0].PrefixSha256 -cne $old.Sha256) { $logsPreserved = $false }
            }
            Add-LifecycleCheck 'prior logs preserved' $logsPreserved 'Every old log retained byte-for-byte as prefix; security-window must remain valid' 'See before/after log inventories and prefix evidence'
        }
        Add-LifecycleCheck 'program present' (@($After.Files.Program).Count -gt 0) 'Managed program installed' "Count=$(@($After.Files.Program).Count)"
        Add-LifecycleCheck 'database readable' ([bool]$After.Db.Exists -and $null -ne $After.Db.Version -and -not $After.Db.Error) 'Read-only schema available' 'See after snapshot'
        Add-LifecycleCheck 'unmanaged files retained' (Compare-LifecycleValue $Before.Files.Unmanaged $After.Files.Unmanaged) 'Identical unmanaged inventory' 'See before/after snapshots'
    }
    if ($Mode -in @('Uninstall', 'RemoveData')) {
        $beforeCgi = @($Before.Iis.FastCgi | Where-Object { $_.FullPath -ieq $Cgi })
        $afterCgi = @($After.Iis.FastCgi | Where-Object { $_.FullPath -ieq $Cgi })
        $owned = @($Before.Iis.Site.Handlers | Where-Object { $_.Name -eq 'Netarium-PHP' -and $_.ScriptProcessor -ieq $Cgi -and -not $_.HasArguments }).Count -gt 0
        $shared = @($Before.Iis.GlobalHandlers | Where-Object { $_.ScriptProcessor -ieq $Cgi -and -not $_.HasArguments }).Count -gt 0
        foreach ($foreignSite in @($Before.Iis.Sites | Where-Object { $_.Name -ine $Name })) {
            if (@($foreignSite.Handlers | Where-Object { $_.ScriptProcessor -ieq $Cgi -and -not $_.HasArguments }).Count -gt 0) { $shared = $true }
            foreach ($app in @($foreignSite.Applications)) {
                if (@($app.Handlers | Where-Object { $_.ScriptProcessor -ieq $Cgi -and -not $_.HasArguments }).Count -gt 0) { $shared = $true }
            }
        }
        $expectedCgi = @(if ($owned -and -not $shared -and $beforeCgi.Count -eq 1) { @() } else { $beforeCgi })
        Add-LifecycleCheck 'shared FastCGI preservation' (Compare-LifecycleValue $expectedCgi $afterCgi) 'Unshared owned mapping removed, shared or foreign mapping retained' 'See before/after FastCGI snapshots'
    }
    if ($Mode -in @('Fresh', 'Repeat', 'Update', 'UpdateRollback')) {
        $healthy = if ($Mode -eq 'Fresh') { $After.Http.StatusCode -eq 302 -and $After.Http.RedirectsToSetup } else { $After.Http.StatusCode -eq 200 }
        Add-LifecycleCheck 'login.php HTTP available' ($healthy -and -not $After.Http.Error) $(if ($Mode -eq 'Fresh') { '302 to setup.php' } else { '200' }) "Status=$($After.Http.StatusCode); setupRedirect=$($After.Http.RedirectsToSetup)"
    }
    if ($Mode -in @('Fresh', 'Update')) {
        Add-LifecycleCheck 'snapshot created' (@($After.Files.Rollback).Count -gt @($Before.Files.Rollback).Count) 'Rollback inventory grows after deployment' "Before=$(@($Before.Files.Rollback).Count); After=$(@($After.Files.Rollback).Count)"
    }
}
function Get-LifecycleReleaseInventory {
    param([string]$Root)
    $items = @()
    foreach ($directory in @('public', 'src', 'templates', 'resources', 'scripts')) {
        foreach ($entry in @(Get-LifecycleInventory -Root (Join-Path $Root $directory) | Where-Object { -not $_.IsDirectory })) {
            $items += [pscustomobject]@{ RelativePath = "$directory/$($entry.RelativePath)"; Sha256 = $entry.Sha256 }
        }
    }
    foreach ($name in @('bootstrap.php', 'version.php')) {
        $file = Join-Path $Root $name
        Assert-Lifecycle (Test-Path -LiteralPath $file -PathType Leaf) "Release file missing: $name"
        $items += [pscustomobject]@{ RelativePath = $name; Sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    return @($items | Sort-Object RelativePath)
}
function Assert-LifecycleReportPath {
    param([string]$Path)
    $current = Split-Path -Parent $Path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            Assert-Lifecycle (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Report directory chain contains a reparse point.'
        }
        $parent = Split-Path -Parent $current
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-LifecyclePaths {
    param([string]$Release)
    $paths = @($InstallRoot, $RollbackRoot, $ReportPath)
    if ($Release) { $paths += $Release }
    $absolute = @($paths | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\', '/') })
    $scripts = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/')
    foreach ($candidate in @($absolute[0], $absolute[1])) {
        Assert-Lifecycle (-not ($candidate -ieq $scripts -or $scripts.StartsWith($candidate + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $candidate.StartsWith($scripts + '\', [StringComparison]::OrdinalIgnoreCase))) 'InstallRoot and RollbackRoot must not contain or be contained by the running scripts.'
    }
    for ($i = 0; $i -lt $absolute.Count; $i++) {
        for ($j = $i + 1; $j -lt $absolute.Count; $j++) {
            Assert-Lifecycle (-not ($absolute[$i] -ieq $absolute[$j] -or $absolute[$i].StartsWith($absolute[$j] + '\', [StringComparison]::OrdinalIgnoreCase) -or $absolute[$j].StartsWith($absolute[$i] + '\', [StringComparison]::OrdinalIgnoreCase))) 'Report, release, install and rollback paths must not overlap.'
        }
    }
}
function Invoke-LifecycleNative {
    param([string]$ScriptPath, [string[]]$Arguments, [bool]$ShouldSucceed, [string]$ExpectedFailureMarker = '')
    $exe = (Get-Command powershell.exe -ErrorAction Stop).Source
    $script:failureMarkerSeen = $false
    # Discard native output immediately; retain only a boolean for the known HTTP 503 failure.
    $ErrorActionPreference = 'Continue' # Native stderr is an ErrorRecord in Windows PowerShell 5.1.
    & $exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1 |
        ForEach-Object {
            if ($ExpectedFailureMarker -and $_.ToString().Contains($ExpectedFailureMarker)) {
                $script:failureMarkerSeen = $true
            }
        } | Out-Null
    $code = $LASTEXITCODE
    Add-LifecycleCheck 'process exit' ($null -ne $code -and (($code -eq 0) -eq $ShouldSucceed)) $(if ($ShouldSucceed) { '0' } else { 'nonzero (injected HTTP failure)' }) ([string]$code)
    return $code
}
function Assert-LifecycleOwnership {
    param([object]$State, [bool]$MustExist, [bool]$AllowRetainedUninstall = $false)
    if ($MustExist) {
        if ($AllowRetainedUninstall -and -not $State.Iis.Site.Exists -and -not $State.Iis.Pool.Exists) {
            Assert-Lifecycle (Test-LifecycleTarget -Snapshot $State -Installed $false) 'Retained uninstall must have no target site or pool.'
            Assert-Lifecycle (@($State.Iis.Locations | Where-Object { $_.Path -ieq $SiteName -or $_.Path -ilike ($SiteName + '/*') }).Count -eq 0) 'Retained uninstall must have no target IIS location.'
            Assert-Lifecycle (@($State.Files.Program).Count -eq 0 -and
                @($State.Files.Data).Count -gt 0 -and @($State.Files.Rollback).Count -gt 0) 'Retained uninstall must have data and rollback evidence but no program files.'
        } else {
            Assert-Lifecycle (Test-LifecycleTarget -Snapshot $State -Installed $true) 'Existing IIS site/pool does not match the dedicated install target.'
            Assert-Lifecycle (Test-Path -LiteralPath (Join-Path $InstallRoot 'public/web.config') -PathType Leaf) 'Existing Netarium web.config required to prove ownership.'
            Assert-Lifecycle (Test-Path -LiteralPath (Join-Path $InstallRoot 'scripts/check-install.php') -PathType Leaf) 'Existing release check-install.php required to prove ownership.'
            Assert-Lifecycle (@($State.Iis.Site.Handlers | Where-Object {
                $_.Name -eq 'Netarium-PHP' -and $_.Path -eq '*.php' -and $_.Modules -eq 'FastCgiModule' -and $_.ScriptProcessor -ieq $PhpCgiPath -and -not $_.HasArguments
            }).Count -eq 1) 'Dedicated Netarium PHP handler does not match PhpCgiPath.'
        }
        Assert-Lifecycle (Test-Path -LiteralPath (Join-Path $InstallRoot 'config/app.php') -PathType Leaf) 'Existing config/app.php required to prove ownership.'
        $configText = [IO.File]::ReadAllText((Join-Path $InstallRoot 'config/app.php'))
        $storage = (Join-Path $InstallRoot 'data').Replace('\', '\\')
        Assert-Lifecycle ($configText -match ("'storage_dir'\s*=>\s*'" + [regex]::Escape($storage) + "'\s*,")) 'Existing config does not belong to InstallRoot/data.'
    } else {
        Assert-Lifecycle (Test-LifecycleTarget -Snapshot $State -Installed $false) 'Fresh target site/pool already exists.'
        Assert-Lifecycle (-not (Test-Path -LiteralPath $InstallRoot)) 'Fresh InstallRoot must not already exist.'
        Assert-Lifecycle (-not (Test-Path -LiteralPath $RollbackRoot)) 'Fresh RollbackRoot must not already exist.'
    }
    foreach ($site in @($State.Iis.Sites)) {
        if ($site.Name -ine $SiteName) {
            Assert-Lifecycle ($site.ApplicationPool -ine $ApplicationPoolName) 'A foreign IIS site uses the dedicated target pool.'
            foreach ($app in @($site.Applications)) {
                Assert-Lifecycle ($app.ApplicationPool -ine $ApplicationPoolName) 'A foreign IIS application uses the dedicated target pool.'
            }
        }
    }
    if ($State.Iis.Site.Exists) {
        $expectedBinding = '*:{0}:{1}' -f $Port, $HostName
        Assert-Lifecycle ($State.Iis.Site.Bindings.Count -eq 1 -and @($State.Iis.Site.Bindings | Where-Object {
            $_.Protocol -ieq $Protocol -and $_.BindingInformation -ieq $expectedBinding
        }).Count -eq 1) 'Target IIS binding must be exclusively dedicated to the specified host.'
        Assert-Lifecycle (@($State.Iis.Site.Applications).Count -eq 0) 'Target IIS site contains additional applications.'
        Assert-Lifecycle (@($State.Iis.Locations | Where-Object { $_.Path -ilike ($SiteName + '/*') }).Count -eq 0) 'Target contains nested IIS locations outside harness ownership.'
    }
}
function New-LifecycleFixture {
    param([string]$ReleaseRoot, [string]$FixturePath)
    $fixture = $FixturePath
    New-Item -Path $fixture -ItemType Directory -ErrorAction Stop | Out-Null
    foreach ($dir in @('public', 'src', 'templates', 'resources', 'scripts')) {
        Copy-Item -LiteralPath (Join-Path $ReleaseRoot $dir) -Destination (Join-Path $fixture $dir) -Recurse -ErrorAction Stop
    }
    foreach ($name in @('bootstrap.php', 'version.php', 'config/app.example.php')) {
        $destination = Join-Path $fixture $name
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $ReleaseRoot $name) -Destination $destination -ErrorAction Stop
    }
    [IO.File]::WriteAllText((Join-Path $fixture 'public/login.php'), '<?php http_response_code(503);', (New-Object System.Text.UTF8Encoding($false)))
    return $fixture
}

$before = $null
$after = $null
$fixturePath = $null
$fingerprintKey = $null
$originalReleaseHash = $null
$expectedProgram = $null
$expectedExampleHash = $null
try {
    if (-not $ReportPath) { $ReportPath = Join-Path ([IO.Path]::GetTempPath()) ('netarium-lifecycle-' + [guid]::NewGuid().ToString('N') + '.json') }
    $ReportPath = [IO.Path]::GetFullPath($ReportPath)
    Assert-Lifecycle (Test-Path -LiteralPath (Split-Path -Parent $ReportPath) -PathType Container) 'Report parent directory must exist outside deployment roots.'
    Assert-LifecycleReportPath -Path $ReportPath
    Assert-Lifecycle (-not (Test-Path -LiteralPath $ReportPath)) 'Report path must be new (reports must not be overwritten).'
    if ($Scenario -ne 'Compare') {
        foreach ($extension in @('.before.json', '.after.json')) {
            Assert-Lifecycle (-not (Test-Path -LiteralPath ([IO.Path]::ChangeExtension($ReportPath, $extension)))) 'Snapshot evidence path must be new (existing evidence must not be overwritten).'
        }
    }
    if ($Scenario -eq 'Compare') {
        Assert-Lifecycle ($BeforeJson -and $AfterJson -and $SiteName -and $ApplicationPoolName -and $InstallRoot -and $PhpCgiPath) 'Compare requires BeforeJson, AfterJson, target identifiers, InstallRoot and PhpCgiPath.'
        $before = Get-Content -LiteralPath $BeforeJson -Raw -Encoding UTF8 | ConvertFrom-Json
        $after = Get-Content -LiteralPath $AfterJson -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-LifecycleSnapshotShape -Snapshot $before
        Assert-LifecycleSnapshotShape -Snapshot $after
        Compare-LifecycleSnapshots -Before $before -After $after -Mode $CompareScenario -Name $SiteName -Pool $ApplicationPoolName -Cgi $PhpCgiPath
    } else {
        Assert-Lifecycle ($SiteName -and $ApplicationPoolName -and $InstallRoot -and $PhpCgiPath -and $VerificationUrl) 'Target site, pool, root, PHP CGI and verification URL are required.'
        $installAbsolute = [IO.Path]::GetFullPath($InstallRoot)
        Assert-Lifecycle ($installAbsolute.TrimEnd('\', '/') -ine [IO.Path]::GetPathRoot($installAbsolute).TrimEnd('\', '/')) 'InstallRoot must not be a filesystem root.'
        if (-not $RollbackRoot) { $RollbackRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/') + '-rollback' }
        if (-not $SourcePath) { $SourcePath = Split-Path -Parent $PSScriptRoot }
        foreach ($candidate in @($RollbackRoot, $SourcePath)) {
            $absoluteCandidate = [IO.Path]::GetFullPath($candidate)
            Assert-Lifecycle ($absoluteCandidate.TrimEnd('\', '/') -ine [IO.Path]::GetPathRoot($absoluteCandidate).TrimEnd('\', '/')) 'RollbackRoot and SourcePath must not be filesystem roots.'
        }
        $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
        $RollbackRoot = [IO.Path]::GetFullPath($RollbackRoot).TrimEnd('\', '/')
        $SourcePath = [IO.Path]::GetFullPath($SourcePath).TrimEnd('\', '/')
        $PhpCgiPath = [IO.Path]::GetFullPath($PhpCgiPath)
        Assert-LifecyclePaths -Release $SourcePath
        foreach ($path in @($InstallRoot, $RollbackRoot, $SourcePath)) {
            Assert-LifecycleReportPath -Path (Join-Path $path 'netarium-lifecycle-reparse-guard')
        }
        Assert-Lifecycle ($VerificationUrl.IsAbsoluteUri -and $VerificationUrl.Scheme -in @('http', 'https') -and $VerificationUrl.AbsolutePath -eq '/' -and -not $VerificationUrl.Query -and -not $VerificationUrl.Fragment -and -not $VerificationUrl.UserInfo) 'VerificationUrl must be a root HTTP(S) URL without credentials, query or fragment.'
        Assert-Lifecycle ($SiteName -cmatch '^Netarium-Lifecycle-[A-Za-z0-9-]+$' -and $ApplicationPoolName -cmatch '^Netarium-Lifecycle-[A-Za-z0-9-]+$') 'Site and pool must have dedicated Netarium-Lifecycle- names.'
        Assert-Lifecycle ($VerificationUrl.Host -eq 'localhost' -or $VerificationUrl.Host.EndsWith('.localhost') -or $VerificationUrl.Host.EndsWith('.test')) 'Only localhost or reserved .test DNS hosts are permitted.'
        if (-not $HostName) { $HostName = $VerificationUrl.Host }
        Assert-Lifecycle ($HostName -ieq $VerificationUrl.Host -and $VerificationUrl.Scheme -eq $Protocol -and $VerificationUrl.Port -eq $Port) 'HostName, Protocol and Port must match VerificationUrl exactly.'
        if ($Protocol -eq 'https' -and $Scenario -in @('Fresh', 'Repeat', 'SetupRollback')) {
            Assert-Lifecycle ($CertificateThumbprint -match '\A[0-9a-fA-F]{40,64}\z') 'HTTPS setup requires explicit hexadecimal CertificateThumbprint.'
        }
        Assert-Lifecycle (-not $RemoveData -or $Scenario -eq 'RemoveData') 'RemoveData switch is permitted only in RemoveData scenario.'
        if ($Scenario -eq 'RemoveData') { Assert-Lifecycle ($RemoveData -and $ConfirmRemoveData -ceq ('REMOVE-DATA:' + $SiteName)) 'RemoveData requires -RemoveData and -ConfirmRemoveData REMOVE-DATA:<SiteName>.' }
        if ($Scenario -notin @('Inspect', 'DryRun')) {
            Assert-Lifecycle ($AllowDestructive -and $ConfirmTarget -ceq ($SiteName + '/' + $ApplicationPoolName + '/' + $HostName)) 'Destructive scenario requires -AllowDestructive and exact -ConfirmTarget Site/Pool/Host.'
            $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            Assert-Lifecycle ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'Administrator privileges required for destructive acceptance scenarios.'
        }
        . (Join-Path $PSScriptRoot 'iis-lifecycle-state.ps1')
        $fingerprintKey = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($fingerprintKey) } finally { $rng.Dispose() }
        $snapshotArguments = @{ SiteName = $SiteName; ApplicationPoolName = $ApplicationPoolName; InstallRoot = $InstallRoot; RollbackRoot = $RollbackRoot; PhpCgiPath = $PhpCgiPath; VerificationUrl = $VerificationUrl; FingerprintKey = $fingerprintKey; SkipHttp = $true }
        $script:phase = 'before snapshot'
        $before = Get-LifecycleSnapshot @snapshotArguments
        Assert-LifecycleSnapshotShape -Snapshot $before
        Save-LifecycleJson -Path ([IO.Path]::ChangeExtension($ReportPath, '.before.json')) -Value $before
        if ($Scenario -notin @('Inspect', 'DryRun')) {
            $exists = $Scenario -in @('Repeat', 'Uninstall', 'RemoveData', 'Update', 'UpdateRollback')
            Assert-LifecycleOwnership -State $before -MustExist $exists -AllowRetainedUninstall ($Scenario -eq 'RemoveData')
            if ($Scenario -in @('Fresh', 'Update', 'SetupRollback', 'UpdateRollback')) {
                Assert-Lifecycle (Test-Path -LiteralPath (Join-Path $SourcePath 'public/login.php') -PathType Leaf) 'Release login.php missing.'
                Assert-Lifecycle (Test-Path -LiteralPath (Join-Path $SourcePath 'scripts/check-install.php') -PathType Leaf) 'Release check-install.php missing.'
            }
            if ($Scenario -in @('Fresh', 'Update')) {
                $expectedProgram = @(Get-LifecycleReleaseInventory -Root $SourcePath)
                $example = Join-Path $SourcePath 'config/app.example.php'
                Assert-Lifecycle (Test-Path -LiteralPath $example -PathType Leaf) 'Release config/app.example.php missing.'
                $expectedExampleHash = (Get-FileHash -LiteralPath $example -Algorithm SHA256).Hash.ToLowerInvariant()
            }
            $release = $SourcePath
            if ($Scenario -in @('SetupRollback', 'UpdateRollback')) {
                $originalReleaseHash = (Get-FileHash -LiteralPath (Join-Path $release 'public/login.php') -Algorithm SHA256).Hash
                $fixturePath = Join-Path ([IO.Path]::GetDirectoryName($ReportPath)) ('netarium-lifecycle-fixture-' + [guid]::NewGuid().ToString('N'))
                $release = New-LifecycleFixture -ReleaseRoot $release -FixturePath $fixturePath
            }
            $commonArgs = @('-InstallRoot', $InstallRoot, '-SiteName', $SiteName, '-ApplicationPoolName', $ApplicationPoolName, '-PhpCgiPath', $PhpCgiPath, '-RollbackRoot', $RollbackRoot)
            $setupArgs = @($commonArgs) + @('-SourcePath', $release, '-Protocol', $Protocol, '-Port', [string]$Port, '-HostName', $HostName, '-VerificationUrl', $VerificationUrl.AbsoluteUri, '-MinimumPhpMemoryLimitMiB', [string]$MinimumPhpMemoryLimitMiB, '-MinimumPhpMaxExecutionTimeSeconds', [string]$MinimumPhpMaxExecutionTimeSeconds, '-FastCgiActivityTimeoutSeconds', [string]$FastCgiActivityTimeoutSeconds, '-FastCgiRequestTimeoutSeconds', [string]$FastCgiRequestTimeoutSeconds, '-NonInteractive')
            if ($Protocol -eq 'https') { $setupArgs += @('-CertificateThumbprint', $CertificateThumbprint) }
            $updateArgs = @($commonArgs) + @('-SourcePath', $release, '-VerificationUrl', $VerificationUrl.AbsoluteUri)
            $uninstallArgs = @($commonArgs) + @('-NonInteractive', '-Force')
            $scriptName = switch ($Scenario) { { $_ -in @('Fresh', 'Repeat', 'SetupRollback') } { 'setup-iis.ps1'; break } { $_ -in @('Update', 'UpdateRollback') } { 'update.ps1'; break } default { 'uninstall-iis.ps1' } }
            $arguments = switch ($scriptName) { 'setup-iis.ps1' { $setupArgs } 'update.ps1' { $updateArgs } default { $uninstallArgs } }
            if ($Scenario -eq 'RemoveData') { $arguments += '-RemoveData' }
            # Native deployment is invoked only after ownership and opt-in guards.
            $marker = switch ($Scenario) {
                'SetupRollback' { 'status=503' }
                'UpdateRollback' { 'update: 503' }
                default { '' }
            }
            $script:phase = "invoke $scriptName"
            $exitCode = Invoke-LifecycleNative -ScriptPath (Join-Path $PSScriptRoot $scriptName) -Arguments $arguments -ShouldSucceed ($Scenario -notin @('SetupRollback', 'UpdateRollback')) -ExpectedFailureMarker $marker
            if ($marker) {
                Add-LifecycleCheck 'injected failure reached HTTP probe' $script:failureMarkerSeen 'Known post-start login.php HTTP 503 failure' $(if ($script:failureMarkerSeen) { 'Marker found without logging child output' } else { 'Marker not found' })
            }
        }
        if ($Scenario -in @('Fresh', 'Repeat', 'Update', 'UpdateRollback')) { $snapshotArguments.Remove('SkipHttp') }
        if ($Scenario -eq 'Update') {
            $snapshotArguments.PriorData = @($before.Files.Data)
            $snapshotArguments.PriorSecurityState = $before.Files.SecurityState
        }
        $script:phase = 'after snapshot'
        $after = Get-LifecycleSnapshot @snapshotArguments
        Assert-LifecycleSnapshotShape -Snapshot $after
        Save-LifecycleJson -Path ([IO.Path]::ChangeExtension($ReportPath, '.after.json')) -Value $after
        $script:phase = 'compare snapshots'
        Compare-LifecycleSnapshots -Before $before -After $after -Mode $Scenario -Name $SiteName -Pool $ApplicationPoolName -Cgi $PhpCgiPath
        if ($null -ne $expectedProgram) {
            $actualProgram = @($after.Files.Program | Where-Object { -not $_.IsDirectory } | ForEach-Object {
                [pscustomobject]@{ RelativePath = $_.RelativePath; Sha256 = $_.Sha256 }
            })
            Add-LifecycleCheck 'deployed release files' (Compare-LifecycleValue $expectedProgram $actualProgram) 'Every managed program file matches source release' 'See source and after program inventory'
            $exampleEntries = @($after.Files.Config | Where-Object { $_.RelativePath -eq 'app.example.php' -and -not $_.IsDirectory })
            Add-LifecycleCheck 'deployed config example' ($exampleEntries.Count -eq 1 -and $exampleEntries[0].Sha256 -ieq $expectedExampleHash) 'config/app.example.php matches source release' 'See after config inventory'
        }
        if ($Scenario -in @('Inspect', 'DryRun')) {
            $action = if ($Scenario -eq 'DryRun') { $DryRunAction } else { 'Inspect only' }
            Add-LifecycleCheck 'preview action' $true 'No deployment script invoked; ownership is not authorized by preview' $action
            Add-LifecycleCheck 'preview target' $true 'Requested target; no mutation' "$SiteName / $ApplicationPoolName / $HostName / $InstallRoot / $RollbackRoot"
            Add-LifecycleCheck 'preview current IIS' $true 'Snapshot evidence only' "SiteExists=$($before.Iis.Site.Exists); PoolExists=$($before.Iis.Pool.Exists)"
            if ($Scenario -eq 'DryRun' -and $DryRunAction -eq 'RemoveData') {
                Add-LifecycleCheck 'preview data deletion' $true 'Requires separate RemoveData and ConfirmRemoveData approval for execution' 'Would remove data, config and rollback snapshots'
            }
        }
        if ($originalReleaseHash) {
            $unchanged = $originalReleaseHash -ceq (Get-FileHash -LiteralPath (Join-Path $SourcePath 'public/login.php') -Algorithm SHA256).Hash
            Add-LifecycleCheck 'source release untouched' $unchanged 'Identical source login.php SHA256' 'Compare original release hash'
        }
        if ($Scenario -in @('Repeat', 'Update', 'UpdateRollback')) {
            $script:phase = 'security probe'
            $securityCode = Invoke-LifecycleNative -ScriptPath (Join-Path $PSScriptRoot 'verify-security.ps1') -Arguments @('-VerificationUrl', $VerificationUrl.AbsoluteUri) -ShouldSucceed $true
            Add-LifecycleCheck 'security verification' ($securityCode -eq 0) 'verify-security.ps1 exit 0' ([string]$securityCode)
        }
        if ($Scenario -eq 'Fresh') {
            Add-LifecycleSkip 'verify-security.ps1' 'Initial login redirects to setup.php; run Repeat after creating the initial administrator.'
        }
        Add-LifecycleSkip 'browser acceptance' 'Initial administrator, login, layout and interaction require the human #72/#73 checklist.'
    }
} catch {
    # Never store exception messages or captured HTTP/native output: they may include credentials.
    Add-LifecycleCheck 'runner error' $false 'Scenario completed with evidence' ("Phase=$script:phase; type=" + $_.Exception.GetType().Name) 'Exception text and child output omitted to protect secrets; inspect saved snapshots and the phase.'
    if ($null -ne $before -and $null -eq $after -and $Scenario -ne 'Compare') {
        try {
            $after = Get-LifecycleSnapshot @snapshotArguments
            Save-LifecycleJson -Path ([IO.Path]::ChangeExtension($ReportPath, '.after.json')) -Value $after
            Add-LifecycleCheck 'post-failure snapshot' $true 'Captured' 'Captured'
        } catch { Add-LifecycleCheck 'post-failure snapshot' $false 'Captured' 'Unavailable' 'Snapshot failed; no PASS for this scenario.' }
    }
} finally {
    if ($fixturePath -and (Test-Path -LiteralPath $fixturePath)) {
        try { Remove-Item -LiteralPath $fixturePath -Recurse -Force -ErrorAction Stop }
        catch { Add-LifecycleCheck 'fixture cleanup' $false 'Fixture removed' 'Removal failed' 'Remove temporary fixture manually.' }
    }
    if ($fingerprintKey) { [Array]::Clear($fingerprintKey, 0, $fingerprintKey.Length) }
    $report = [pscustomobject]@{ Scenario = $Scenario; Before = if ($before -and $Scenario -ne 'Compare') { [IO.Path]::ChangeExtension($ReportPath, '.before.json') } else { $BeforeJson }; After = if ($after -and $Scenario -ne 'Compare') { [IO.Path]::ChangeExtension($ReportPath, '.after.json') } else { $AfterJson }; Rows = @($rows.ToArray()) }
    try { Save-LifecycleJson -Path $ReportPath -Value $report }
    catch { $script:failed = $true; Write-Host 'FAIL: unable to persist lifecycle report.' }
    foreach ($row in $rows) { Write-Host ($row.Result + ' ' + $row.Scenario + ' / ' + $row.Check + ' (' + $row.Actual + ')') }
    Write-Host ('Lifecycle: {0} PASS, {1} FAIL, {2} SKIP; report: {3}' -f @($rows | Where-Object { $_.Result -eq 'PASS' }).Count, @($rows | Where-Object { $_.Result -eq 'FAIL' }).Count, @($rows | Where-Object { $_.Result -eq 'SKIP' }).Count, $ReportPath)
}
if ($script:failed -or $rows.Count -eq 0) { exit 1 }
exit 0
