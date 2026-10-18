$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$repo = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $repo 'scripts/test-iis-lifecycle.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('netarium-lifecycle-test-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($sandbox)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$php = (Get-Command php -ErrorAction Stop).Source
$required = @('-Scenario', 'Compare', '-CompareScenario', 'Inspect', '-SiteName', 'Netarium-Lifecycle-Test', '-ApplicationPoolName', 'Netarium-Lifecycle-Test', '-InstallRoot', (Join-Path $sandbox 'app'), '-PhpCgiPath', (Join-Path (Split-Path -Parent $php) 'php-cgi.exe'))
function Save-Fixture($path, $value) {
    [IO.File]::WriteAllText($path, (ConvertTo-Json -InputObject $value -Depth 30), $utf8)
}
function Assert-Case {
    param($name, $before, $after, $expectedExit, $expectedCheck, $mode = 'Inspect')
    $id = [guid]::NewGuid().ToString('N')
    $beforeFile = Join-Path $sandbox "$id-before.json"
    $afterFile = Join-Path $sandbox "$id-after.json"
    $reportFile = Join-Path $sandbox "$id-report.json"
    Save-Fixture $beforeFile $before
    Save-Fixture $afterFile $after
    $caseArguments = @($required)
    $caseArguments[3] = $mode
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner @caseArguments -BeforeJson $beforeFile -AfterJson $afterFile -ReportPath $reportFile | Out-Null
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne $expectedExit) { throw "$name exit $exitCode, expected $expectedExit" }
    $report = Get-Content -LiteralPath $reportFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $row = @($report.Rows | Where-Object { $_.Check -eq $expectedCheck })
    if ($row.Count -ne 1 -or $row[0].Result -ne $(if ($expectedExit -eq 0) { 'PASS' } else { 'FAIL' })) {
        throw "$name missing expected result for $expectedCheck"
    }
    Write-Host "PASS $name"
}
try {
    $empty = @()
    $site = [pscustomobject]@{ Exists = $false; Name = 'Netarium-Lifecycle-Test'; State = $null; PhysicalPath = $null; ApplicationPool = $null; Bindings = @(); Handlers = @(); Applications = @() }
    $pool = [pscustomobject]@{ Exists = $false; Name = 'Netarium-Lifecycle-Test'; State = $null }
    $base = [pscustomobject]@{
        Iis = [pscustomobject]@{ Site = $site; Pool = $pool; Sites = @(); Pools = @(); FastCgi = @(); Locations = @(); GlobalHandlers = @() }
        Files = [pscustomobject]@{ Program = @(); Config = @(); Data = @(); Db = @(); Rollback = @(); Unmanaged = @(); Paths = @() }
        Db = [pscustomobject]@{ Hash = $null; Version = $null; Exists = $false; Counts = [pscustomobject]@{ Users = $null; Views = $null; Devices = $null; Links = $null } }
        Http = [pscustomobject]@{ StatusCode = $null }
        Acl = @()
    }
    $same = ($base | ConvertTo-Json -Depth 30) | ConvertFrom-Json
    Assert-Case 'unchanged inspection' $base $same 0 'foreign IIS unchanged'

    $foreign = ($base | ConvertTo-Json -Depth 30) | ConvertFrom-Json
    $foreign.Iis.Sites = @([pscustomobject]@{ Name = 'OtherSite'; PhysicalPath = 'C:\other'; State = 'Started'; Bindings = @() })
    Assert-Case 'foreign site injection rejected' $base $foreign 1 'foreign IIS unchanged'
    $sharedBefore = ($base | ConvertTo-Json -Depth 30) | ConvertFrom-Json
    $sharedAfter = ($base | ConvertTo-Json -Depth 30) | ConvertFrom-Json
    foreach ($state in @($sharedBefore, $sharedAfter)) {
        $state.Iis.GlobalHandlers = @([pscustomobject]@{ ScriptProcessor = $required[-1]; HasArguments = $false })
        $state.Iis.FastCgi = @([pscustomobject]@{ FullPath = $required[-1]; HasArguments = $false; RequestTimeout = 300 })
    }
    $sharedAfter.Iis.FastCgi[0].RequestTimeout = 60
    Assert-Case 'shared FastCGI change rejected' $sharedBefore $sharedAfter 1 'shared FastCGI unchanged'
    $preservedCgi = ($sharedBefore | ConvertTo-Json -Depth 30) | ConvertFrom-Json
    Assert-Case 'uninstall preserves one shared FastCGI entry' $sharedBefore $preservedCgi 0 'shared FastCGI preservation' 'Uninstall'
    Assert-Case 'uninstall rejects modified shared FastCGI entry' $sharedBefore $sharedAfter 1 'shared FastCGI preservation' 'Uninstall'
    Assert-Case 'uninstall without FastCGI entries' $base $same 0 'shared FastCGI preservation' 'Uninstall'

    $tampered = ($base | ConvertTo-Json -Depth 30) | ConvertFrom-Json
    $tampered.Files.Unmanaged = @([pscustomobject]@{ RelativePath = 'unmanaged.txt'; Sha256 = 'changed'; IsDirectory = $false })
    Assert-Case 'unmanaged file injection rejected' $base $tampered 1 'Unmanaged restored/unchanged'

    $changedDb = ($base | ConvertTo-Json -Depth 30) | ConvertFrom-Json
    $changedDb.Db.Hash = 'different'
    Assert-Case 'database mutation rejected' $base $changedDb 1 'Db restored/unchanged'

    $safetyReport = Join-Path $sandbox 'safety.json'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Scenario Fresh -SiteName 'Netarium-Lifecycle-Test' -ApplicationPoolName 'Netarium-Lifecycle-Test' -InstallRoot (Join-Path $sandbox 'app') -PhpCgiPath (Join-Path (Split-Path -Parent $php) 'php-cgi.exe') -VerificationUrl 'http://localhost/' -ReportPath $safetyReport | Out-Null
    if ($LASTEXITCODE -eq 0 -or -not (Test-Path -LiteralPath $safetyReport)) { throw 'Destructive scenario lacked approval but was not rejected and reported.' }
    Write-Host 'PASS destructive scenario requires explicit approval'
    . (Join-Path $repo 'scripts/iis-lifecycle-state.ps1')
    $pathLocation = [pscustomobject]@{ Path = 'Server-Site'; Name = 'Other-Site' }
    $nameLocation = [pscustomobject]@{ Name = 'Windows11-Site' }
    $emptyPathLocation = [pscustomobject]@{ Path = ' '; Name = 'Fallback-Site' }
    if ((Get-LifecycleLocationPath -Location $pathLocation) -cne 'Server-Site' -or
        (Get-LifecycleLocationPath -Location $nameLocation) -cne 'Windows11-Site' -or
        (Get-LifecycleLocationPath -Location $emptyPathLocation) -cne 'Fallback-Site') {
        throw 'IIS location identifier did not prefer a nonempty Path then fall back to Name.'
    }
    $missingLocationRejected = $false
    try { Get-LifecycleLocationPath -Location ([pscustomobject]@{ Path = ' '; Name = '' }) | Out-Null }
    catch { $missingLocationRejected = $true }
    if (-not $missingLocationRejected) { throw 'IIS location without Path or Name was accepted.' }
    Write-Host 'PASS IIS location Path and Name compatibility'
    function Test-LifecycleLocationCollections {
        function Import-Module { [CmdletBinding()] param([string]$Name) }
        function Get-Website { [CmdletBinding()] param() [pscustomobject]@{ Name = 'Fixture-Site'; Bindings = [pscustomobject]@{ Collection = @() }; PhysicalPath = 'C:\fixture'; ApplicationPool = 'Fixture-Pool' } }
        function Get-WebsiteState { [CmdletBinding()] param([string]$Name) [pscustomobject]@{ Value = 'Started' } }
        function Get-WebApplication { [CmdletBinding()] param([string]$Site) }
        function Get-WebAppPoolState { [CmdletBinding()] param([string]$Name) }
        function Get-WebConfigurationLocation { [CmdletBinding()] param([string]$PSPath) [pscustomobject]@{ Name = 'Fixture-Site' } }
        function Get-ChildItem {
            [CmdletBinding()] param([string]$LiteralPath)
            if ($LiteralPath -ne 'IIS:\AppPools') { throw "Unexpected directory read: $LiteralPath" }
        }
        function Get-WebConfigurationProperty {
            [CmdletBinding()] param([string]$PSPath, [string]$Location, [string]$Filter, [string]$Name)
            switch ($Filter) {
                'system.webServer/defaultDocument/files/add' {
                    [pscustomobject]@{ value = 'index.php' }
                    [pscustomobject]@{ value = 'home.php' }
                }
                'system.webServer/security/requestFiltering/fileExtensions/add' {
                    [pscustomobject]@{ fileExtension = '.db'; allowed = $false }
                    [pscustomobject]@{ fileExtension = '.php'; allowed = $true }
                }
                'system.webServer/security/requestFiltering/requestLimits' { 120000000 }
                'system.webServer/handlers/add' {}
                'system.webServer/fastCgi/application' {}
                default { throw "Unexpected IIS filter: $Filter" }
            }
        }
        $snapshot = Get-LifecycleSnapshot -SiteName 'Fixture-Site' -ApplicationPoolName 'Fixture-Pool' `
            -InstallRoot (Join-Path $sandbox 'collection-fixture') -RollbackRoot (Join-Path $sandbox 'collection-rollback') `
            -PhpCgiPath $required[-1] -VerificationUrl ([uri]'http://localhost/') -FingerprintKey (New-Object byte[] 32) -SkipHttp
        $location = @($snapshot.Iis.Locations)
        if ($location.Count -ne 1 -or $location[0].Path -ne 'Fixture-Site' -or
            (@($location[0].DefaultDocuments) -join ',') -cne 'home.php,index.php' -or
            @($location[0].PhpFilters).Count -ne 1 -or
            $location[0].PhpFilters[0].FileExtension -ne '.php' -or
            -not $location[0].PhpFilters[0].Allowed) {
            throw 'IIS location snapshot did not select and normalize collection elements.'
        }
    }
    Test-LifecycleLocationCollections
    Write-Host 'PASS IIS location collection elements'
    $dbFile = Join-Path $sandbox 'schema.sqlite'
    $create = @'
$db = new SQLite3($argv[1]); $db->exec('CREATE TABLE users (id INTEGER PRIMARY KEY)'); $db->exec('INSERT INTO users VALUES (1)'); $db->exec('PRAGMA user_version = 4'); $db->close();
'@
    & $php -r $create -- $dbFile | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'SQLite fixture creation failed.' }
    $hash = (Get-FileHash -LiteralPath $dbFile -Algorithm SHA256).Hash
    $schemaDirectory = Join-Path $sandbox 'src/Core'
    [void][IO.Directory]::CreateDirectory($schemaDirectory)
    Copy-Item -LiteralPath (Join-Path $repo 'src/Core/DatabaseSchema.php') -Destination $schemaDirectory
    $db = Get-LifecycleDatabase -InstallRoot $sandbox -DbPath $dbFile -PhpCgiPath (Join-Path (Split-Path -Parent $php) 'php-cgi.exe') -DbHash $hash
    if ($db.Error -or $db.Version -ne 4 -or $db.Counts.Users -ne 1 -or $db.Counts.Views -ne $null -or
        (Get-FileHash -LiteralPath $dbFile -Algorithm SHA256).Hash -ne $hash) {
        throw 'Read-only SQLite probe changed data or returned the wrong schema and row counts.'
    }
    Write-Host 'PASS read-only SQLite schema and row-count probe'
    $key = New-Object byte[] 32
    $key[0] = 73
    $fingerprint = Get-LifecycleFingerprint -Value 'synthetic-secret' -Key $key
    if ($fingerprint -ne (Get-LifecycleFingerprint -Value 'synthetic-secret' -Key $key) -or
        $fingerprint -eq (Get-LifecycleFingerprint -Value 'different-secret' -Key $key) -or
        $fingerprint.Contains('synthetic-secret')) { throw 'Sensitive IIS setting fingerprint is unstable or exposed.' }
    Write-Host 'PASS sensitive IIS value fingerprint'
    function Get-LifecycleCollection {
        param([string]$PSPath, [string]$Location, [string]$Filter)
        return @([pscustomobject]@{
            name = 'PHP'; path = '*.php'; verb = '*'; modules = 'FastCgiModule'
            scriptProcessor = $required[-1] + '|--secret=synthetic-secret'
            resourceType = 'Either'; requireAccess = 'Script'
        })
    }
    $handlers = @(Get-LifecycleHandlers -PSPath 'fixture' -FingerprintKey $key)
    if ($handlers.Count -ne 1 -or -not $handlers[0].HasArguments -or
        $handlers[0].ScriptProcessor -ne $required[-1] -or
        $handlers[0].ArgumentsFingerprint -ne (Get-LifecycleFingerprint -Value '--secret=synthetic-secret' -Key $key) -or
        $handlers[0].ArgumentsFingerprint.Contains('synthetic-secret')) {
        throw 'PHP handler argument evidence was lost or exposed.'
    }
    Write-Host 'PASS PHP handler argument detection without raw secrets'

    $ast = [System.Management.Automation.Language.Parser]::ParseFile($runner, [ref]$null, [ref]$null)
    foreach ($name in @('Assert-Lifecycle', 'Test-LifecycleTarget', 'Assert-LifecycleOwnership')) {
        $functions = @($ast.FindAll({
            $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq $name
        }, $true))
        if ($functions.Count -ne 1) { throw "Ownership evaluator missing: $name" }
        Invoke-Expression $functions[0].Extent.Text
    }
    $InstallRoot = Join-Path $sandbox 'retained-app'
    $RollbackRoot = Join-Path $sandbox 'retained-rollback'
    $SiteName = 'Netarium-Lifecycle-Test'
    $ApplicationPoolName = $SiteName
    $PhpCgiPath = $required[-1]
    [void][IO.Directory]::CreateDirectory((Join-Path $InstallRoot 'config'))
    [void][IO.Directory]::CreateDirectory((Join-Path $InstallRoot 'data'))
    [void][IO.Directory]::CreateDirectory($RollbackRoot)
    $configPath = Join-Path $InstallRoot 'config/app.php'
    $storage = (Join-Path $InstallRoot 'data').Replace('\', '\\')
    [IO.File]::WriteAllText($configPath, "'storage_dir' => '$storage',", $utf8)
    $retained = ($base | ConvertTo-Json -Depth 30) | ConvertFrom-Json
    $retained.Files.Data = @([pscustomobject]@{ RelativePath = 'db/data.sqlite' })
    $retained.Files.Rollback = @([pscustomobject]@{ RelativePath = 'snapshot/manifest.json' })
    Assert-LifecycleOwnership -State $retained -MustExist $true -AllowRetainedUninstall $true
    Write-Host 'PASS RemoveData accepts retained uninstall state'
    $rejected = $false
    try { Assert-LifecycleOwnership -State $retained -MustExist $true } catch { $rejected = $true }
    if (-not $rejected) { throw 'Other installed-only scenarios accepted an absent site.' }
    $retained.Files.Program = @([pscustomobject]@{ RelativePath = 'public/web.config' })
    $rejected = $false
    try { Assert-LifecycleOwnership -State $retained -MustExist $true -AllowRetainedUninstall $true } catch { $rejected = $true }
    if (-not $rejected) { throw 'Retained uninstall accepted remaining program files.' }
    $retained.Files.Program = @()
    $retained.Iis.Locations = @([pscustomobject]@{ Path = $SiteName })
    $rejected = $false
    try { Assert-LifecycleOwnership -State $retained -MustExist $true -AllowRetainedUninstall $true } catch { $rejected = $true }
    if (-not $rejected) { throw 'Retained uninstall accepted a target IIS location.' }
    $retained.Iis.Locations = @()
    $retained.Files.Rollback = @()
    $rejected = $false
    try { Assert-LifecycleOwnership -State $retained -MustExist $true -AllowRetainedUninstall $true } catch { $rejected = $true }
    if (-not $rejected) { throw 'Retained uninstall accepted missing rollback evidence.' }
    $retained.Files.Rollback = @([pscustomobject]@{ RelativePath = 'snapshot/manifest.json' })
    [IO.File]::WriteAllText($configPath, "'storage_dir' => 'C:\\Other\data',", $utf8)
    $rejected = $false
    try { Assert-LifecycleOwnership -State $retained -MustExist $true -AllowRetainedUninstall $true } catch { $rejected = $true }
    if (-not $rejected) { throw 'Retained uninstall accepted foreign config storage.' }
    Write-Host 'PASS retained uninstall ownership guards'
    [IO.File]::WriteAllText($configPath, "'storage_dir' => '$storage',", $utf8)
    $aclFunction = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $args[0].Name -eq 'Test-LifecycleAcl' }, $true)
    if (@($aclFunction).Count -ne 1) { throw 'ACL evaluator not found.' }
    Invoke-Expression $aclFunction[0].Extent.Text
    $InstallRoot = Join-Path $sandbox 'app'
    $ApplicationPoolName = 'Netarium-Lifecycle-Test'
    $aclEntries = @()
    foreach ($name in @('', 'public', 'src', 'templates', 'resources', 'scripts', 'config', 'data')) {
        $aclEntries += [pscustomobject]@{
            Path = if ($name) { Join-Path $InstallRoot $name } else { $InstallRoot }
            Exists = $true
            Protected = $true
            Rules = @([pscustomobject]@{
                Identity = 'IIS AppPool\Netarium-Lifecycle-Test'
                Sid = 'S-1-5-82-123'
                Type = 'Allow'
                Rights = if ($name -eq 'data') { 'Modify' } else { 'ReadAndExecute' }
            })
        }
    }
    $aclSnapshot = [pscustomobject]@{ Acl = $aclEntries }
    if (-not (Test-LifecycleAcl -Snapshot $aclSnapshot)) { throw 'Valid least-privilege ACL was rejected.' }
    $aclEntries[1].Rules += [pscustomobject]@{ Identity = 'Everyone'; Sid = 'S-1-1-0'; Type = 'Allow'; Rights = 'Write' }
    if (Test-LifecycleAcl -Snapshot $aclSnapshot) { throw 'Broad write permission on public code was accepted.' }
    Write-Host 'PASS ACL least-privilege and broad-write rejection'
} finally {
    Remove-Item -LiteralPath $sandbox -Recurse -Force
}
