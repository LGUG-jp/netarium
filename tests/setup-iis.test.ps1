<#
.SYNOPSIS
    setup-iis.ps1 runtime and IIS binding behavior checks

.DESCRIPTION
    Exercises PHP preflight and IIS HTTP/HTTPS/existing binding functions with
    mocked IIS cmdlets, including certificate, SNI, and verification URLs.
#>

[CmdletBinding()]
param(
    # Runs only real release copying and PHP checks; no IIS or protected bootstrap ACLs.
    [switch]$PasswordBlocklistOnly,
    [switch]$ReleaseManifestOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
$setupIisScript = Join-Path $repoRoot 'scripts/setup-iis.ps1'
$commonScript = Join-Path $repoRoot 'scripts/deployment-common.ps1'
$script:NetariumPasswordRuntimeProbe = Join-Path $repoRoot 'scripts/check-password-runtime.php'

if (-not (Test-Path -LiteralPath $setupIisScript -PathType Leaf)) {
    throw "setup-iis.ps1 not found at $setupIisScript"
}

# Extract function definitions from setup-iis.ps1 without executing the script body
$ast = [System.Management.Automation.Language.Parser]::ParseFile($setupIisScript, [ref]$null, [ref]$null)
$functionAsts = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)

foreach ($fn in $functionAsts) {
    if ($fn.Name -in @('Get-NetariumPhpCliPath', 'ConvertFrom-NetariumPhpSize', 'Get-NetariumPhpIniValue', 'Get-NetariumSQLiteVersion', 'Assert-NetariumPhpRuntime', 'New-NetariumRuntimeTree', 'New-NetariumAppConfig', 'Ensure-NetariumSite', 'Ensure-NetariumBinding', 'Get-NetariumSitePath', 'Get-NetariumVerificationUrl', 'Get-NetariumExistingVerificationUrl', 'Resolve-NetariumVerificationUrl', 'Assert-NetariumCertificate', 'Assert-NetariumBindingMatches', 'Ensure-NetariumPhpFastCgi', 'Ensure-NetariumPhpHandler', 'Ensure-NetariumRequestLimit', 'Assert-NetariumIisConfigurationPreflight')) {
        Invoke-Expression $fn.Extent.Text
    }
}
foreach ($fn in $functionAsts) {
    if ($fn.Name -in @('Assert-NetariumFreshDestination', 'Copy-NetariumReleaseManifest', 'Invoke-NetariumInstallCheck')) {
        Invoke-Expression $fn.Extent.Text
    }
}
$commonAst = [System.Management.Automation.Language.Parser]::ParseFile($commonScript, [ref]$null, [ref]$null)
foreach ($assignment in $commonAst.FindAll({ $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] -and $args[0].Left.Extent.Text -eq '$script:NetariumReleaseManifest' }, $true)) {
    Invoke-Expression $assignment.Extent.Text
}
foreach ($fn in $commonAst.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($fn.Name -in @('ConvertTo-NetariumAbsolutePath', 'Copy-NetariumDirectoryContents', 'Assert-NetariumArgon2Runtime', 'Get-FileInventory', 'Assert-NetariumAppPoolIdentityIsolation', 'Get-NetariumAccountSid')) {
        Invoke-Expression $fn.Extent.Text
    }
}
Invoke-Expression (($functionAsts | Where-Object { $_.Name -eq 'Invoke-NetariumBootstrapSecret' }).Extent.Text)
foreach ($fn in $commonAst.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($fn.Name -in @('Set-NetariumBootstrapAcl', 'New-NetariumPrivateDirectory', 'Set-NetariumPrivateAcl')) { Invoke-Expression $fn.Extent.Text }
}

$testsRun = 0
$testsPassed = 0

function Assert-Test {
    param(
        [string]$Name,
        [scriptblock]$Condition,
        [string]$ErrorMessage = ''
    )

    $script:testsRun++
    try {
        $result = & $Condition
        if ($result) {
            Write-Host "  [PASS] $Name" -ForegroundColor Green
            $script:testsPassed++
        } else {
            Write-Host "  [FAIL] ${Name}: $ErrorMessage" -ForegroundColor Red
            throw "Assertion failed: $Name"
        }
    } catch {
        Write-Host "  [FAIL] ${Name}: $($_.Exception.Message)" -ForegroundColor Red
        throw
    }
}

# Use the real manifest and filesystem; no IIS or PHP is needed for placement checks.
$manifestRoot = Join-Path ([IO.Path]::GetTempPath()) ('netarium-manifest-' + [guid]::NewGuid().ToString('N'))
try {
    foreach ($layout in @('absent', 'empty-root', 'empty-directories')) {
        Assert-Test -Name "Fresh manifest preserves release paths in $layout" -Condition {
            $target = Join-Path $manifestRoot $layout
            if ($layout -eq 'empty-root') { New-Item -ItemType Directory -Path $target -Force | Out-Null }
            if ($layout -eq 'empty-directories') {
                foreach ($directory in @($script:NetariumReleaseManifest.Directories) + @('config')) {
                    New-Item -ItemType Directory -Path (Join-Path $target $directory) -Force | Out-Null
                }
            }
            Copy-NetariumReleaseManifest -SourceRoot $repoRoot -DestinationRoot $target
            foreach ($directory in $script:NetariumReleaseManifest.Directories) {
                if (Test-Path -LiteralPath (Join-Path $target "$directory/$directory")) { return $false }
                $sourceInventory = @(Get-FileInventory -Root (Join-Path $repoRoot $directory)) | ConvertTo-Json -Depth 5 -Compress
                $targetInventory = @(Get-FileInventory -Root (Join-Path $target $directory)) | ConvertTo-Json -Depth 5 -Compress
                if ($sourceInventory -cne $targetInventory) { return $false }
            }
            return (Test-Path -LiteralPath (Join-Path $target 'public/web.config') -PathType Leaf) -and
                (Test-Path -LiteralPath (Join-Path $target 'config/app.example.php') -PathType Leaf) -and
                !(Test-Path -LiteralPath (Join-Path $target 'config/app.php'))
        }
    }
    foreach ($relativePath in @('public/custom.txt', 'src/.hidden', 'config/app.php', 'data/db/data.sqlite', 'bootstrap.php', 'unknown.txt', 'public')) {
        Assert-Test -Name "Fresh manifest refuses existing $relativePath without modifying files" -Condition {
            $target = Join-Path $manifestRoot ('unsafe-' + [guid]::NewGuid().ToString('N'))
            $file = Join-Path $target $relativePath
            New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
            [IO.File]::WriteAllText($file, 'unmanaged bytes')
            if ($relativePath -like '*/.hidden') { (Get-Item -LiteralPath $file).Attributes = 'Hidden' }
            $before = @(Get-FileInventory -Root $target) | ConvertTo-Json -Depth 5 -Compress
            $rejected = $false
            try { Copy-NetariumReleaseManifest -SourceRoot $repoRoot -DestinationRoot $target } catch {
                $rejected = $_.Exception.Message -like '*existing item is not supported*'
            }
            $after = @(Get-FileInventory -Root $target) | ConvertTo-Json -Depth 5 -Compress
            return $rejected -and $before -ceq $after -and
                @(Get-ChildItem -LiteralPath $target -Force).Count -eq 1
        }
    }
    Assert-Test -Name 'Fresh manifest refuses a destination file without changing it' -Condition {
        $target = Join-Path $manifestRoot 'file-root'
        [IO.File]::WriteAllText($target, 'not a directory')
        try { Copy-NetariumReleaseManifest -SourceRoot $repoRoot -DestinationRoot $target; return $false } catch {
            return $_.Exception.Message -like '*directory without reparse points*' -and
                [IO.File]::ReadAllText($target) -ceq 'not a directory'
        }
    }
    foreach ($junctionLocation in @('root', 'public', 'ancestor')) {
        Assert-Test -Name "Fresh manifest refuses a $junctionLocation junction without writing through it" -Condition {
            $external = Join-Path $manifestRoot ('external-' + $junctionLocation)
            New-Item -ItemType Directory -Path $external -Force | Out-Null
            $target = Join-Path $manifestRoot ('junction-' + $junctionLocation)
            $link = $target
            if ($junctionLocation -eq 'public') {
                New-Item -ItemType Directory -Path $target -Force | Out-Null
                $link = Join-Path $target 'public'
            }
            New-Item -ItemType Junction -Path $link -Target $external | Out-Null
            if ($junctionLocation -eq 'ancestor') { $target = Join-Path $link 'absent-app' }
            try {
                $rejected = $false
                try { Copy-NetariumReleaseManifest -SourceRoot $repoRoot -DestinationRoot $target } catch {
                    $rejected = $_.Exception.Message -like '*reparse points*' -or
                        $_.Exception.Message -like '*existing item is not supported*'
                }
                return $rejected -and @(Get-ChildItem -LiteralPath $external -Force).Count -eq 0
            } finally {
                # Delete only the test junction itself, never recurse into its target.
                [IO.Directory]::Delete($link)
            }
        }
    }
} finally {
    if (Test-Path -LiteralPath $manifestRoot) { Remove-Item -LiteralPath $manifestRoot -Recurse -Force }
}
if ($ReleaseManifestOnly) {
    Write-Host "$testsPassed/$testsRun tests passed."
    exit 0
}

Write-Host "=== Testing setup-iis.ps1 PHP Runtime Preflight ===" -ForegroundColor Cyan

# 1. Test PHP Executables exist in current test environment
$phpCliCommand = Get-Command php -ErrorAction Stop
$phpCliPath = $phpCliCommand.Source
if (-not (Test-Path -LiteralPath $phpCliPath -PathType Leaf)) {
    throw "PHP CLI executable not found on PATH: $phpCliPath"
}

$phpDir = Split-Path -Parent $phpCliPath
$phpCgiCandidate = Join-Path $phpDir 'php-cgi.exe'
$phpCgiPath = if (Test-Path -LiteralPath $phpCgiCandidate -PathType Leaf) { $phpCgiCandidate } else { $null }
if (-not $phpCgiPath) {
    throw "PHP CGI executable not found alongside PHP CLI: $phpCgiCandidate"
}

$releaseCopyRoot = Join-Path ([IO.Path]::GetTempPath()) ('netarium-release-copy-' + [guid]::NewGuid().ToString('N'))
try {
    $copiedApp = Join-Path $releaseCopyRoot 'app'
    Copy-NetariumReleaseManifest -SourceRoot $repoRoot -DestinationRoot $copiedApp
    $blocklistPaths = @(
        'resources/password-blocklist/pwdb-policy-top-3000.txt',
        'resources/password-blocklist/pwdb-metadata.json'
    )
    $copiedStorage = Join-Path $releaseCopyRoot 'storage'
    New-NetariumRuntimeTree -StorageDir $copiedStorage
    $corpusProbe = @'
require $argv[1] . '/bootstrap.php';
$corpus = new \Netarium\Services\Auth\PasswordBlocklist();
$values = file($argv[1] . '/resources/password-blocklist/pwdb-policy-top-3000.txt', FILE_IGNORE_NEW_LINES);
$rejected = 0;
foreach ($values as $value) {
    if ($corpus->check($value) !== null) $rejected++;
}
exit($corpus->isAvailable() && count($values) === 3000 && $rejected === 3000
    && $corpus->check('cedar-lantern-orbit-74!') === null ? 0 : 1);
'@
    Assert-Test -Name 'Fresh release rejects all adopted values and permits an independent passphrase' -Condition {
        $result = Invoke-NetariumInstallCheck -AppRoot $copiedApp -StorageDir $copiedStorage -PhpCgiPath $phpCgiPath
        & $phpCliPath -d opcache.enable_cli=0 -r $corpusProbe $copiedApp
        return $LASTEXITCODE -eq 0 -and $result.ok -and $result.password_blocklist_available
    }
    $updateAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repoRoot 'scripts/update.ps1'), [ref]$null, [ref]$null)
    foreach ($fn in $updateAst.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
        if ($fn.Name -in @('Copy-NetariumUpdateManifest', 'Replace-NetariumProgramManifest')) {
            Invoke-Expression $fn.Extent.Text
        }
    }
    $stagedUpdate = Join-Path $releaseCopyRoot 'staged-update'
    Copy-NetariumUpdateManifest -SourceRoot $repoRoot -DestinationRoot $stagedUpdate
    $optional = Join-Path $copiedStorage 'password-blocklist'
    New-Item -ItemType Directory -Path $optional | Out-Null
    [IO.File]::WriteAllText((Join-Path $copiedStorage 'password-blocklist.json'), '{"format_version":1,"enabled":false}')
    [IO.File]::WriteAllText((Join-Path $optional 'dictionary-preserved.txt'), "preserved`n")
    $optionalBefore = @(Get-FileInventory -Root $optional) | ConvertTo-Json -Compress
    foreach ($relativePath in $blocklistPaths) {
        [IO.File]::WriteAllText((Join-Path $copiedApp $relativePath), 'previous release bytes')
    }
    Replace-NetariumProgramManifest -StagedRoot $stagedUpdate -InstallRoot $copiedApp
    if ((@(Get-FileInventory -Root $optional) | ConvertTo-Json -Compress) -cne $optionalBefore) { throw '更新が追加辞書を変更しました。' }
    if ([IO.File]::ReadAllText((Join-Path $copiedStorage 'password-blocklist.json')) -cne '{"format_version":1,"enabled":false}') { throw '更新が追加manifestを変更しました。' }
    Assert-Test -Name 'Update restores adopted-value rejection after replacing damaged old resources' -Condition {
        $result = Invoke-NetariumInstallCheck -AppRoot $copiedApp -StorageDir $copiedStorage -PhpCgiPath $phpCgiPath
        & $phpCliPath -d opcache.enable_cli=0 -r $corpusProbe $copiedApp
        return $LASTEXITCODE -eq 0 -and $result.ok -and $result.password_blocklist_available
    }
    $storageBefore = @(Get-FileInventory -Root $copiedStorage) | ConvertTo-Json -Compress
    foreach ($relativePath in $blocklistPaths) {
        $resourcePath = Join-Path $copiedApp $relativePath
        $originalBytes = [IO.File]::ReadAllBytes($resourcePath)
        foreach ($damage in @('missing', 'corrupt')) {
            Assert-Test -Name "Installation check rejects $damage $relativePath without changing runtime files" -Condition {
                try {
                    if ($damage -eq 'missing') {
                        Remove-Item -LiteralPath $resourcePath -Force
                    } else {
                        [IO.File]::WriteAllText($resourcePath, 'corrupt resource')
                    }
                    $rejected = $false
                    $savedErrorPreference = $ErrorActionPreference
                    try {
                        $ErrorActionPreference = 'Continue'
                        Invoke-NetariumInstallCheck -AppRoot $copiedApp -StorageDir $copiedStorage -PhpCgiPath $phpCgiPath | Out-Null
                    } catch {
                        $rejected = $_.Exception.Message -like '*Offline password blocklist is missing or corrupt*'
                    } finally {
                        $ErrorActionPreference = $savedErrorPreference
                    }
                    $storageAfter = @(Get-FileInventory -Root $copiedStorage) | ConvertTo-Json -Compress
                    return $rejected -and $storageAfter -ceq $storageBefore
                } finally {
                    [IO.File]::WriteAllBytes($resourcePath, $originalBytes)
                }
            }
        }
    }
    Assert-Test -Name 'Installation check succeeds after both PWDB resources are restored' -Condition {
        $result = Invoke-NetariumInstallCheck -AppRoot $copiedApp -StorageDir $copiedStorage -PhpCgiPath $phpCgiPath
        return $result.ok -and $result.password_blocklist_available
    }
} finally {
    if (Test-Path -LiteralPath $releaseCopyRoot) { Remove-Item -LiteralPath $releaseCopyRoot -Recurse -Force }
}
if ($PasswordBlocklistOnly) {
    Write-Host "`nAll $testsRun password blocklist deployment tests passed ($testsPassed/$testsRun)." -ForegroundColor Green
    exit 0
}

# 2. Get-NetariumPhpCliPath
Assert-Test -Name 'Get-NetariumPhpCliPath finds php.exe from CGI directory' -Condition {
    $foundCli = Get-NetariumPhpCliPath -CgiPath $phpCgiCandidate
    Test-Path -LiteralPath $foundCli -PathType Leaf
}

# 3. Get-NetariumPhpIniValue with plain text
Assert-Test -Name 'Get-NetariumPhpIniValue parses plain text double values' -Condition {
    $sampleText = @"
upload_max_filesize => 32M => 32M
post_max_size => 34M => 34M
max_file_uploads => 20 => 20
memory_limit => 256M => 256M
max_execution_time => 30 => 30
"@
    $val = Get-NetariumPhpIniValue -Info $sampleText -Name 'upload_max_filesize'
    $val -eq '32M'
}

Assert-Test -Name 'Get-NetariumPhpIniValue parses plain text single values' -Condition {
    $sampleText = @"
upload_max_filesize => 128M
memory_limit => 512M
"@
    $val = Get-NetariumPhpIniValue -Info $sampleText -Name 'upload_max_filesize'
    $val -eq '128M'
}

foreach ($value in @('C:\Logs\A&B\errors.log', 'C:\Logs\A&amp;B\errors.log', 'C:\Logs\A&#38;B\errors.log')) {
    foreach ($suffix in @('', " => $value")) {
        Assert-Test -Name "Plain PHP info preserves literal entities: $value$suffix" -Condition {
            (Get-NetariumPhpIniValue -Info "error_log => $value$suffix" -Name 'error_log') -ceq $value
        }
    }
}

# 4. Get-NetariumPhpIniValue with HTML
Assert-Test -Name 'Get-NetariumPhpIniValue parses HTML table rows' -Condition {
    $sampleHtml = @"
<tr><td class="e">upload_max_filesize</td><td class="v">32M</td><td class="v">32M</td></tr>
<tr><td class="e">post_max_size</td><td class="v">34M</td><td class="v">34M</td></tr>
<tr><td class="e">max_file_uploads</td><td class="v">20</td><td class="v">20</td></tr>
<tr><td class="e">memory_limit</td><td class="v">256M</td><td class="v">256M</td></tr>
<tr><td class="e">max_execution_time</td><td class="v">30</td><td class="v">30</td></tr>
"@
    $valUpload = Get-NetariumPhpIniValue -Info $sampleHtml -Name 'upload_max_filesize'
    $valMemory = Get-NetariumPhpIniValue -Info $sampleHtml -Name 'memory_limit'
    $valUpload -eq '32M' -and $valMemory -eq '256M'
}
Assert-Test -Name 'Get-NetariumPhpIniValue strips HTML tags and extracts no value' -Condition {
    $sampleHtml = '<tr><td class="e">error_log</td><td class="v"><i>no value</i></td><td class="v"><i>no value</i></td></tr>'
    $val = Get-NetariumPhpIniValue -Info $sampleHtml -Name 'error_log'
    $val -eq 'no value'
}

foreach ($case in @(
    @{ Name = 'ampersands'; Html = 'C:\Logs\A&amp;B\errors.log'; Value = 'C:\Logs\A&B\errors.log' }
    @{ Name = 'quotes and apostrophes'; Html = 'C:\Logs\&quot;A&#039;B&quot;\errors.log'; Value = 'C:\Logs\"A''B"\errors.log' }
    @{ Name = 'decimal and hexadecimal entities'; Html = 'C:\Logs\A&#38;B&#x26;C\errors.log'; Value = 'C:\Logs\A&B&C\errors.log' }
    @{ Name = 'encoded angle brackets after tag removal'; Html = '<i>C:\Logs\&lt;A&gt;\errors.log</i>'; Value = 'C:\Logs\<A>\errors.log' }
    @{ Name = 'entities decoded exactly once'; Html = 'C:\Logs\A&amp;amp;B&amp;#38;C\errors.log'; Value = 'C:\Logs\A&amp;B&#38;C\errors.log' }
)) {
    Assert-Test -Name "HTML PHP info decodes $($case.Name)" -Condition {
        $sampleHtml = '<tr><td class="e">error_log</td><td class="v">' + $case.Html + '</td><td class="v">master-value</td></tr>'
        (Get-NetariumPhpIniValue -Info $sampleHtml -Name 'error_log') -ceq $case.Value
    }
}


Assert-Test -Name 'Get-NetariumPhpIniValue throws when key is missing' -Condition {
    try {
        Get-NetariumPhpIniValue -Info "some text" -Name 'non_existent_key'
        return $false
    } catch {
        return $_.Exception.Message -like "*Active PHP INI value is unavailable: non_existent_key*"
    }
}

if ($phpCgiPath) {
    # 5. Get-NetariumSQLiteVersion with real CGI path
    Assert-Test -Name 'Get-NetariumSQLiteVersion retrieves SQLite version from PHP CGI' -Condition {
        $version = Get-NetariumSQLiteVersion -CgiPath $phpCgiPath
        $version -ge [version]'3.51.3'
    }

    # 6. Assert-NetariumPhpRuntime with real environment
    Assert-Test -Name 'Assert-NetariumPhpRuntime succeeds with valid PHP CGI runtime' -Condition {
        $runtime = Assert-NetariumPhpRuntime -CgiPath $phpCgiPath -MinimumMemoryMiB 128 -MinimumExecutionSeconds 0
        $runtime.PhpVersion -and $runtime.SQLiteVersion -and ($runtime.UploadMaxFilesize -ge (32MB)) -and ($runtime.PostMaxSize -ge (34MB)) -and
            $runtime.ErrorLog -and $runtime.ErrorLog -ne 'no value'
    }

    # 7. Assert-NetariumPhpRuntime fails if CGI executable does not exist
    Assert-Test -Name 'Assert-NetariumPhpRuntime fails if CGI executable does not exist' -Condition {
        try {
            Assert-NetariumPhpRuntime -CgiPath 'C:\non_existent_php\php-cgi.exe' -MinimumMemoryMiB 128 -MinimumExecutionSeconds 0
            return $false
        } catch {
            return $_.Exception.Message -like "*PHP CGI executable does not exist*"
        }
    }

    # CGI reports an old SQLite library while the real CLI on PATH is newer.
    $mockDir = Join-Path ([IO.Path]::GetTempPath()) ('netarium-preflight-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $mockDir | Out-Null
    $mockCgi = Join-Path $mockDir 'php-cgi.cmd'
    $previousSqliteVersion = [Environment]::GetEnvironmentVariable('NETARIUM_TEST_SQLITE_VERSION', 'Process')
    $previousMissingExtension = [Environment]::GetEnvironmentVariable('NETARIUM_TEST_MISSING_EXTENSION', 'Process')
    try {
        [IO.File]::WriteAllText($mockCgi, @'
@echo off
if "%~1"=="-v" goto version
if "%~1"=="-m" goto modules
if "%~1"=="-q" goto sqlite
exit /b 1
:version
echo PHP 8.5.5
exit /b 0
:modules
echo pdo
if not "%NETARIUM_TEST_MISSING_EXTENSION%"=="pdo_sqlite" echo pdo_sqlite
if not "%NETARIUM_TEST_MISSING_EXTENSION%"=="sqlite3" echo sqlite3
echo fileinfo
echo zip
echo session
echo json
echo gd
echo exif
if not "%NETARIUM_TEST_MISSING_EXTENSION%"=="mbstring" echo mbstring
exit /b 0
:sqlite
echo %NETARIUM_TEST_SQLITE_VERSION%
exit /b 0
'@)
        $env:NETARIUM_TEST_SQLITE_VERSION = '3.50.0'
        $env:NETARIUM_TEST_MISSING_EXTENSION = ''
        Assert-Test -Name 'CGI SQLite version is used instead of a newer PATH CLI' -Condition {
            (Get-NetariumSQLiteVersion -CgiPath $mockCgi) -eq [version]'3.50.0'
        }
        Assert-Test -Name 'Old CGI SQLite is rejected even when CLI is newer' -Condition {
            try {
                Assert-NetariumPhpRuntime -CgiPath $mockCgi -MinimumMemoryMiB 128 -MinimumExecutionSeconds 0
                return $false
            } catch {
                return $_.Exception.Message -like '*SQLite 3.51.3 or newer is required; found 3.50.0*'
            }
        }
        foreach ($missingExtension in @('sqlite3', 'pdo_sqlite', 'mbstring')) {
            $env:NETARIUM_TEST_MISSING_EXTENSION = $missingExtension
            Assert-Test -Name "Missing CGI $missingExtension is reported before SQLite probing" -Condition {
                try {
                    Assert-NetariumPhpRuntime -CgiPath $mockCgi -MinimumMemoryMiB 128 -MinimumExecutionSeconds 0
                    return $false
                } catch {
                    return $_.Exception.Message -like "*Required PHP extension is missing: $missingExtension*"
                }
            }
        }
    } finally {
        [Environment]::SetEnvironmentVariable('NETARIUM_TEST_SQLITE_VERSION', $previousSqliteVersion, 'Process')
        [Environment]::SetEnvironmentVariable('NETARIUM_TEST_MISSING_EXTENSION', $previousMissingExtension, 'Process')
        Remove-Item -LiteralPath $mockDir -Recurse -Force
    }

    $logFixture = Join-Path ([IO.Path]::GetTempPath()) ('netarium-log-preflight-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $logFixture | Out-Null
    $logCgi = Join-Path $logFixture 'php-cgi.cmd'
    try {
        foreach ($directory in @('A&B', 'A&amp;B', 'Logs123')) {
            New-Item -ItemType Directory -Path (Join-Path $logFixture $directory) | Out-Null
        }
        foreach ($case in @(
            @{ Name = 'rejects an empty error_log'; Value = ''; Error = '*error_log is not configured*' }
            @{ Name = 'rejects STDERR URI'; Value = 'php://stderr'; Error = '*absolute file path*' }
            @{ Name = 'rejects relative log paths'; Value = 'php-errors.log'; Error = '*absolute file path*' }
            @{ Name = 'rejects a missing log directory'; Value = (Join-Path $logFixture 'absent\errors.log'); Error = '*existing directory*' }
            @{ Name = 'rejects a directory as the log file'; Value = $logFixture; Error = '*existing directory*' }
            @{ Name = 'rejects an encoded directory as the log file'; Value = (Join-Path $logFixture 'A&B'); Error = '*existing directory*' }
            @{ Name = 'rejects a missing directory containing an ampersand'; Value = (Join-Path $logFixture 'absent&missing\errors.log'); Error = '*existing directory*' }
            @{ Name = 'accepts a file in a prepared directory'; Value = (Join-Path $logFixture 'errors.log') }
            @{ Name = 'accepts an alphanumeric log directory'; Value = (Join-Path $logFixture 'Logs123\errors.log') }
            @{ Name = 'accepts an HTML-encoded ampersand directory'; Value = (Join-Path $logFixture 'A&B\errors.log') }
            @{ Name = 'does not double-decode a literal entity directory'; Value = (Join-Path $logFixture 'A&amp;B\errors.log') }
        )) {
            # Quote the INI string as well as the cmd argument so PHP does not interpret & as an operator.
            [IO.File]::WriteAllText($logCgi, "@echo off`r`n`"$phpCgiPath`" -d `"error_log='$($case.Value)'`" %*`r`n")
            Assert-Test -Name "PHP log preflight $($case.Name)" -Condition {
                try {
                    $runtime = Assert-NetariumPhpRuntime -CgiPath $logCgi -MinimumMemoryMiB 128 -MinimumExecutionSeconds 0
                    return -not $case.ContainsKey('Error') -and $runtime.ErrorLog -eq $case.Value
                } catch {
                    return $case.ContainsKey('Error') -and $_.Exception.Message -like $case.Error
                }
            }
        }
        foreach ($case in @(
            @{ Name = 'accepts exact 32M and 34M thresholds'; Upload = '32M'; Post = '34M' }
            @{ Name = 'rejects one byte below 32M'; Upload = '33554431'; Post = '34M'; Error = '*upload_max_filesize must be at least 32M*' }
            @{ Name = 'rejects one byte below 34M'; Upload = '32M'; Post = '35651583'; Error = '*post_max_size must be at least 34M*' }
        )) {
            $logPath = Join-Path $logFixture 'errors.log'
            [IO.File]::WriteAllText($logCgi, "@echo off`r`n`"$phpCgiPath`" -d `"error_log=$logPath`" -d `"upload_max_filesize=$($case.Upload)`" -d `"post_max_size=$($case.Post)`" %*`r`n")
            Assert-Test -Name "PHP runtime preflight $($case.Name)" -Condition {
                try {
                    $runtime = Assert-NetariumPhpRuntime -CgiPath $logCgi -MinimumMemoryMiB 128 -MinimumExecutionSeconds 0
                    return -not $case.ContainsKey('Error') -and $runtime.UploadMaxFilesize -eq (ConvertFrom-NetariumPhpSize $case.Upload) -and $runtime.PostMaxSize -eq (ConvertFrom-NetariumPhpSize $case.Post)
                } catch {
                    return $case.ContainsKey('Error') -and $_.Exception.Message -like $case.Error
                }
            }
        }
    } finally {
        Remove-Item -LiteralPath $logFixture -Recurse -Force
    }
}

Assert-Test -Name 'Argon2id generation and whole-input verification succeed in CLI' -Condition {
    $runtime = Assert-NetariumArgon2Runtime -PhpPath $phpCliPath -ProbePath (Join-Path $repoRoot 'scripts/check-password-runtime.php')
    $runtime.ok -and $runtime.sapi -eq 'cli' -and $runtime.algorithm -eq 'argon2id'
}

$argonMockDir = Join-Path ([IO.Path]::GetTempPath()) ('netarium-argon-' + [guid]::NewGuid().ToString('N'))
try {
    [void][IO.Directory]::CreateDirectory($argonMockDir)
    $unsupportedCgi = Join-Path $argonMockDir 'unsupported.cmd'
    [IO.File]::WriteAllText($unsupportedCgi, "@echo off`r`necho {`"ok`":false}`r`nexit /b 1`r`n")
    Assert-Test -Name 'Unavailable Argon2id is rejected without bcrypt fallback' -Condition {
        try {
            Assert-NetariumArgon2Runtime -PhpPath $unsupportedCgi -Cgi
            return $false
        } catch {
            $_.Exception.Message -like '*bcrypt fallback is not permitted*'
        }
    }
} finally {
    Remove-Item -LiteralPath $argonMockDir -Recurse -Force
}

$configRoot = Join-Path ([IO.Path]::GetTempPath()) ('netarium-config-' + [guid]::NewGuid().ToString('N'))
try {
    New-NetariumAppConfig -InstallRoot $configRoot -StorageDir (Join-Path $configRoot 'data')
    $configPath = Join-Path $configRoot 'config/app.php'
    Assert-Test -Name 'Generated app.php has no BOM and PHP accepts strict_types' -Condition {
        $bytes = [IO.File]::ReadAllBytes($configPath)
        $phpOutput = & $phpCliPath -l $configPath 2>&1
        ($bytes.Length -ge 5) -and
        ([Text.Encoding]::ASCII.GetString($bytes, 0, 5) -ceq '<?php') -and
        ($LASTEXITCODE -eq 0) -and
        ($phpOutput -match 'No syntax errors detected')
    }
} finally {
    if (Test-Path -LiteralPath $configRoot) {
        Remove-Item -LiteralPath $configRoot -Recurse -Force
    }
}

$script:mockSite = $null
$script:mockBindings = @()
$script:mockSiteRunning = $false
$script:bindingMutations = 0
$script:certificateAssignments = 0
$script:expectedPublicPath = 'C:\site\public'
$script:expectedPool = 'NetariumTest'
function New-TestBinding {
    param([string]$Protocol, [string]$Information, [string]$CertificateHash = '', [int]$SslFlags = 0)
    $binding = [pscustomobject]@{
        protocol = $Protocol
        bindingInformation = $Information
        certificateHash = $CertificateHash
        certificateStoreName = $(if ($CertificateHash) { 'My' } else { '' })
        sslFlags = $SslFlags
    }
    $binding | Add-Member -MemberType ScriptMethod -Name AddSslCertificate -Value {
        param($thumbprint, $store)
        $this.certificateHash = $thumbprint
        $this.certificateStoreName = $store
        $script:certificateAssignments++
    }
    return $binding
}
function Reset-TestSite {
    param([switch]$Existing, [object[]]$Bindings = @())
    $script:mockSite = if ($Existing) {
        [pscustomobject]@{ Name = 'NetariumTest'; PhysicalPath = $script:expectedPublicPath; ApplicationPool = $script:expectedPool }
    } else { $null }
    $script:mockBindings = @($Bindings)
    $script:mockSiteRunning = [bool]$Existing
    $script:bindingMutations = 0
    $script:certificateAssignments = 0
}
$script:configurationWrites = @()
$script:fastCgiApps = @()
function Set-WebConfigurationProperty {
    param([string]$PSPath, [string]$Location, [string]$Filter, [string]$Name, $Value, [string]$ErrorAction)
    $script:configurationWrites += [pscustomobject]@{ Command = 'Set'; PSPath = $PSPath; Location = $Location; Filter = $Filter; Name = $Name; Value = $Value }
    if ($Filter -like 'system.webServer/fastCgi/application*' -and $script:fastCgiApps.Count -gt 0) {
        if ($Name -eq 'activityTimeout') { $script:fastCgiApps[0].activityTimeout = [int]$Value }
        if ($Name -eq 'requestTimeout') { $script:fastCgiApps[0].requestTimeout = [int]$Value }
    }
}
function Get-Website {
    param([string]$Name, [string]$ErrorAction)
    if ($script:mockSite -and (!$Name -or $Name -eq $script:mockSite.Name)) { return $script:mockSite }
}
function New-Website {
    param([string]$Name, [string]$PhysicalPath, [string]$ApplicationPool, [int]$Port, [string]$HostHeader, [switch]$Force, [string]$ErrorAction)
    $script:mockSite = [pscustomobject]@{ Name = $Name; PhysicalPath = $PhysicalPath; ApplicationPool = $ApplicationPool }
    $script:mockSiteRunning = $true
    $script:mockBindings = @(New-TestBinding -Protocol http -Information "*:${Port}:$HostHeader")
    $script:bindingMutations++
}
function Stop-Website { param([string]$Name, [string]$ErrorAction) $script:mockSiteRunning = $false }
function Get-WebBinding {
    param([string]$Name, [string]$Protocol, [string]$Port, [string]$HostHeader, [string]$ErrorAction)
    return @($script:mockBindings | Where-Object {
        (!$Protocol -or $_.protocol -eq $Protocol) -and
        (!$Port -or (($_.bindingInformation -split ':')[1] -eq $Port)) -and
        (!$HostHeader -or $_.bindingInformation.EndsWith(":$HostHeader", [StringComparison]::OrdinalIgnoreCase))
    })
}
function New-WebBinding {
    param([string]$Name, [string]$Protocol, [int]$Port, [string]$HostHeader, [string]$IPAddress, [string]$BindingInformation, [int]$SslFlags, [string]$ErrorAction)
    if (!$BindingInformation) { $BindingInformation = "$(if ($IPAddress) { $IPAddress } else { '*' }):${Port}:$HostHeader" }
    $script:mockBindings += New-TestBinding -Protocol $Protocol -Information $BindingInformation -SslFlags $SslFlags
    $script:bindingMutations++
}
function Remove-WebConfigurationProperty {
    param([string]$PSPath, [string]$Filter, [string]$Name, $AtElement, [string]$ErrorAction)
    if ($PSPath -ne 'MACHINE/WEBROOT/APPHOST' -or $Filter -ne "system.applicationHost/sites/site[@name='NetariumTest']/bindings") {
        throw 'Binding removal is not scoped to the requested site.'
    }
    $script:mockBindings = @($script:mockBindings | Where-Object {
        -not ($_.protocol -eq $AtElement.protocol -and $_.bindingInformation -eq $AtElement.bindingInformation)
    })
    $script:bindingMutations++
}

Reset-TestSite
Assert-Test -Name 'New HTTP IIS site remains stopped until setup is ready' -Condition {
    $created = Ensure-NetariumSite -SiteName 'NetariumTest' -PhysicalPath $script:expectedPublicPath -ApplicationPoolName $script:expectedPool -Protocol http -Port 80 -HostName 'example.test'
    $created -and -not $script:mockSiteRunning -and
    @($script:mockBindings | Where-Object { $_.protocol -eq 'http' -and $_.bindingInformation -eq '*:80:example.test' }).Count -eq 1
}

Reset-TestSite
Assert-Test -Name 'New HTTPS site installs certificate and SNI binding without retaining HTTP' -Condition {
    $created = Ensure-NetariumSite -SiteName 'NetariumTest' -PhysicalPath $script:expectedPublicPath -ApplicationPoolName $script:expectedPool -Protocol https -Port 443 -HostName 'secure.example.test' -CertificateThumbprint 'AABBCCDD'
    $https = @($script:mockBindings | Where-Object { $_.protocol -eq 'https' -and $_.bindingInformation -eq '*:443:secure.example.test' -and $_.certificateHash -eq 'AABBCCDD' -and $_.certificateStoreName -eq 'My' -and $_.sslFlags -eq 1 })
    $created -and -not $script:mockSiteRunning -and $https.Count -eq 1 -and $script:certificateAssignments -eq 1 -and
    @($script:mockBindings | Where-Object { $_.protocol -eq 'http' }).Count -eq 0
}

Reset-TestSite -Existing -Bindings @(
    (New-TestBinding -Protocol https -Information '*:443:other.example.test' -CertificateHash 'OLDHASH' -SslFlags 1)
)
Assert-Test -Name 'HTTP setup adds its own binding without changing another HTTPS endpoint' -Condition {
    $created = Ensure-NetariumSite -SiteName 'NetariumTest' -PhysicalPath $script:expectedPublicPath -ApplicationPoolName $script:expectedPool -Protocol http -Port 8080 -HostName 'plain.example.test'
    !$created -and $script:mockSiteRunning -and $script:bindingMutations -eq 1 -and
    @($script:mockBindings | Where-Object { $_.protocol -eq 'http' -and $_.bindingInformation -eq '*:8080:plain.example.test' }).Count -eq 1 -and
    @($script:mockBindings | Where-Object { $_.protocol -eq 'https' -and $_.bindingInformation -eq '*:443:other.example.test' -and $_.certificateHash -eq 'OLDHASH' }).Count -eq 1
}
Assert-Test -Name 'Repeating HTTP setup does not duplicate its IIS binding' -Condition {
    $created = Ensure-NetariumSite -SiteName 'NetariumTest' -PhysicalPath $script:expectedPublicPath -ApplicationPoolName $script:expectedPool -Protocol http -Port 8080 -HostName 'plain.example.test'
    !$created -and $script:bindingMutations -eq 1 -and $script:mockBindings.Count -eq 2
}

Reset-TestSite -Existing -Bindings @(
    (New-TestBinding -Protocol http -Information '*:8080:existing.example.test'),
    (New-TestBinding -Protocol https -Information '*:8443:secure.example.test' -CertificateHash 'OLDHASH' -SslFlags 1)
)
Assert-Test -Name 'Existing mode preserves all bindings and certificates without stopping the site' -Condition {
    $before = @($script:mockBindings | ForEach-Object { "$($_.protocol)|$($_.bindingInformation)|$($_.certificateHash)|$($_.sslFlags)" })
    $created = Ensure-NetariumSite -SiteName 'NetariumTest' -PhysicalPath $script:expectedPublicPath -ApplicationPoolName $script:expectedPool -Protocol existing -Port 80
    $after = @($script:mockBindings | ForEach-Object { "$($_.protocol)|$($_.bindingInformation)|$($_.certificateHash)|$($_.sslFlags)" })
    !$created -and $script:mockSiteRunning -and $script:bindingMutations -eq 0 -and $script:certificateAssignments -eq 0 -and
    [string]::Join(';', $before) -ceq [string]::Join(';', $after)
}

Reset-TestSite -Existing -Bindings @((New-TestBinding -Protocol https -Information '*:443:secure.example.test' -CertificateHash 'OTHERHASH' -SslFlags 1))
Assert-Test -Name 'HTTPS refuses to replace an existing binding certificate' -Condition {
    try {
        Ensure-NetariumSite -SiteName 'NetariumTest' -PhysicalPath $script:expectedPublicPath -ApplicationPoolName $script:expectedPool -Protocol https -Port 443 -HostName 'secure.example.test' -CertificateThumbprint 'AABBCCDD' | Out-Null
        return $false
    } catch {
        return $script:mockBindings[0].certificateHash -eq 'OTHERHASH' -and $script:certificateAssignments -eq 0 -and $script:bindingMutations -eq 0
    }
}

Reset-TestSite -Existing -Bindings @((New-TestBinding -Protocol https -Information '*:443:secure.example.test' -SslFlags 0))
Assert-Test -Name 'HTTPS refuses an existing binding without SNI' -Condition {
    try {
        Ensure-NetariumSite -SiteName 'NetariumTest' -PhysicalPath $script:expectedPublicPath -ApplicationPoolName $script:expectedPool -Protocol https -Port 443 -HostName 'secure.example.test' -CertificateThumbprint 'AABBCCDD' | Out-Null
        return $false
    } catch {
        return $script:mockBindings[0].sslFlags -eq 0 -and $script:certificateAssignments -eq 0
    }
}

$script:testCertificate = $null
function Get-Item {
    param([string]$LiteralPath, [string]$ErrorAction)
    if ($LiteralPath -like 'Cert:\LocalMachine\My\*') { return $script:testCertificate }
    return Microsoft.PowerShell.Management\Get-Item @PSBoundParameters
}
$thumbprint = 'A' * 40
$script:testCertificate = [pscustomobject]@{
    HasPrivateKey = $true
    NotBefore = (Get-Date).AddDays(-1)
    NotAfter = (Get-Date).AddDays(1)
    DnsNameList = @([pscustomobject]@{ Unicode = 'secure.example.test' })
    EnhancedKeyUsageList = @([pscustomobject]@{ ObjectId = '1.3.6.1.5.5.7.3.1' })
}
Assert-Test -Name 'Valid HTTPS certificate resolves from LocalMachine personal store' -Condition {
    (Assert-NetariumCertificate -Thumbprint $thumbprint -HostName 'secure.example.test') -ceq $thumbprint
}
Assert-Test -Name 'HTTPS rejects certificate without private key' -Condition {
    $script:testCertificate.HasPrivateKey = $false
    try {
        Assert-NetariumCertificate -Thumbprint $thumbprint -HostName 'secure.example.test' | Out-Null
        return $false
    } catch {
        return $_.Exception.Message -like '*private key*'
    } finally {
        $script:testCertificate.HasPrivateKey = $true
    }
}
Assert-Test -Name 'HTTPS rejects certificate without requested FQDN in SAN' -Condition {
    try {
        Assert-NetariumCertificate -Thumbprint $thumbprint -HostName 'another.example.test' | Out-Null
        return $false
    } catch {
        return $_.Exception.Message -like '*SAN*'
    }
}
Assert-Test -Name 'HTTPS rejects invalid certificate thumbprint' -Condition {
    try {
        Assert-NetariumCertificate -Thumbprint 'NOT-A-THUMBPRINT' -HostName 'secure.example.test' | Out-Null
        return $false
    } catch {
        return $_.Exception.Message -like '*thumbprint*'
    }
}

Reset-TestSite -Existing -Bindings @((New-TestBinding -Protocol https -Information '*:443:secure.example.test' -CertificateHash 'AABBCCDD' -SslFlags 1))
Assert-Test -Name 'Already-configured HTTPS binding matches its SNI certificate' -Condition {
    Assert-NetariumBindingMatches -SiteName 'NetariumTest' -Protocol https -Port 443 -HostName 'secure.example.test' -CertificateThumbprint 'AABBCCDD'
    $script:bindingMutations -eq 0 -and $script:certificateAssignments -eq 0
}
Assert-Test -Name 'Existing setup rejects HTTPS certificate mismatch without rewriting binding' -Condition {
    try {
        Assert-NetariumBindingMatches -SiteName 'NetariumTest' -Protocol https -Port 443 -HostName 'secure.example.test' -CertificateThumbprint 'DIFFERENT'
        return $false
    } catch {
        return $script:mockBindings[0].certificateHash -eq 'AABBCCDD' -and $script:bindingMutations -eq 0
    }
}

Reset-TestSite
Assert-Test -Name 'Existing mode rejects a missing IIS site without creating it' -Condition {
    try {
        Ensure-NetariumSite -SiteName 'NetariumTest' -PhysicalPath $script:expectedPublicPath -ApplicationPoolName $script:expectedPool -Protocol existing -Port 80 | Out-Null
        return $false
    } catch {
        return !$script:mockSite -and $script:bindingMutations -eq 0
    }
}

Assert-Test -Name 'Binding verification URLs use scheme, FQDN and nondefault ports' -Condition {
    (Get-NetariumVerificationUrl -Protocol http -Port 80 -HostName 'plain.example.test') -eq 'http://plain.example.test/' -and
    (Get-NetariumVerificationUrl -Protocol https -Port 443 -HostName 'secure.example.test') -eq 'https://secure.example.test/' -and
    (Get-NetariumVerificationUrl -Protocol https -Port 8443 -HostName 'secure.example.test') -eq 'https://secure.example.test:8443/'
}

Reset-TestSite -Existing -Bindings @((New-TestBinding -Protocol https -Information '*:8443:existing.example.test' -CertificateHash 'OLDHASH' -SslFlags 1))
Assert-Test -Name 'Existing HTTPS binding provides a usable verification URL' -Condition {
    (Get-NetariumExistingVerificationUrl -SiteName 'NetariumTest') -eq 'https://existing.example.test:8443/'
}

Assert-Test -Name 'Explicit verification URL overrides the derived HTTPS endpoint' -Condition {
    (Resolve-NetariumVerificationUrl -VerificationUrl 'https://probe.example.test/' -Protocol https -Port 443 -HostName 'secure.example.test' -SiteName 'NetariumTest') -eq 'https://probe.example.test/'
}
Assert-Test -Name 'Verification URL derives from existing binding when not overridden' -Condition {
    (Resolve-NetariumVerificationUrl -Protocol existing -Port 80 -SiteName 'NetariumTest') -eq 'https://existing.example.test:8443/'
}

foreach ($hostlessBinding in @('*:443:', '192.0.2.10:8443:')) {
    Reset-TestSite -Existing -Bindings @((New-TestBinding -Protocol https -Information $hostlessBinding -CertificateHash 'OLDHASH'))
    Assert-Test -Name "Hostless existing binding $hostlessBinding requires an explicit verification URL" -Condition {
        try {
            Resolve-NetariumVerificationUrl -Protocol existing -SiteName 'NetariumTest' | Out-Null
            return $false
        } catch {
            return $_.Exception.Message -like '*-VerificationUrl*' -and $script:bindingMutations -eq 0
        }
    }
    Assert-Test -Name "Explicit verification URL preserves hostless binding $hostlessBinding" -Condition {
        $url = Resolve-NetariumVerificationUrl -Protocol existing -SiteName 'NetariumTest' -VerificationUrl 'https://service.example.test/'
        $unchanged = Ensure-NetariumSite -SiteName 'NetariumTest' -PhysicalPath $script:expectedPublicPath -ApplicationPoolName $script:expectedPool -Protocol existing -Port 80
        $url -eq 'https://service.example.test/' -and !$unchanged -and
        $script:bindingMutations -eq 0 -and $script:mockBindings[0].bindingInformation -eq $hostlessBinding
    }
}
Reset-TestSite -Existing
Assert-Test -Name 'Existing mode rejects an IIS site without usable bindings' -Condition {
    try {
        Ensure-NetariumSite -SiteName 'NetariumTest' -PhysicalPath $script:expectedPublicPath -ApplicationPoolName $script:expectedPool -Protocol existing -Port 80 | Out-Null
        return $false
    } catch {
        return $script:bindingMutations -eq 0 -and $script:mockBindings.Count -eq 0
    }
}

$script:configurationReads = @()
$script:preflightFailureFilter = $null
$script:phpHandlerCollection = @()
$script:silentFastCgiAdd = $false
$script:silentHandlerAdd = $false
function Get-WebConfiguration {
    param([string]$PSPath, [string]$Location, [string]$Filter, [string]$ErrorAction)
    $script:configurationReads += [pscustomobject]@{ PSPath = $PSPath; Location = $Location; Filter = $Filter }
    if ($script:preflightFailureFilter -and $Filter -eq $script:preflightFailureFilter) {
        throw 'configuration section is inaccessible'
    }
    if ($Filter -eq 'system.webServer/fastCgi/application') {
        return $script:fastCgiApps
    }
    return @()
}
function Get-NetariumWebCollection {
    param([string]$PSPath, [string]$Filter, [string]$Location)
    if ($PSPath -eq 'IIS:\Sites\OtherSite') {
        return @([pscustomobject]@{ path = '*.php'; scriptProcessor = 'C:\php\php-cgi.exe' })
    }
    return @($script:phpHandlerCollection)
}
function Add-WebConfigurationProperty {
    param([string]$PSPath, [string]$Location, [string]$Filter, [string]$Name, $Value, [string]$ErrorAction)
    $script:configurationWrites += [pscustomobject]@{ Command = 'Add'; PSPath = $PSPath; Location = $Location; Filter = $Filter; Name = $Name; Value = $Value }
    if ($Filter -eq 'system.webServer/fastCgi' -and -not $script:silentFastCgiAdd) {
        $script:fastCgiApps += [pscustomobject]@{
            fullPath = [string]$Value.fullPath
            activityTimeout = [int]$Value.activityTimeout
            requestTimeout = [int]$Value.requestTimeout
        }
    }
    if ($Filter -eq 'system.webServer/handlers' -and -not $script:silentHandlerAdd) {
        $script:phpHandlerCollection += [pscustomobject]@{ path = [string]$Value.path; scriptProcessor = [string]$Value.scriptProcessor }
    }
}
$script:mockAppPools = @{}
$script:mockAppPoolPathFailure = $false
$script:mockAppPoolReadFailure = ''
$script:mockAppPoolModels = @{}
$script:mockAppPoolEnumerationFailure = $false
function Test-Path {
    param([string]$LiteralPath, [string]$Path, [string]$PathType, $ErrorAction)
    $target = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
    if ($target -like 'IIS:\AppPools\*') {
        if ($script:mockAppPoolPathFailure) {
            Write-Error 'AppPool existence check failed' -ErrorAction $ErrorAction
            return $false
        }
        $poolName = $target.Substring('IIS:\AppPools\'.Length)
        return $script:mockAppPools.ContainsKey($poolName)
    }
    Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
}
function Get-ItemProperty {
    param([string]$LiteralPath, [string]$Path, [string]$Name, $ErrorAction)
    $target = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
    if ($target -like 'IIS:\AppPools\*') {
        $poolName = $target.Substring('IIS:\AppPools\'.Length)
        if ($script:mockAppPoolReadFailure -eq $poolName) {
            Write-Error "processModel read failed for $poolName" -ErrorAction $ErrorAction
            return $null
        }
        if ($Name -eq 'processModel' -and $script:mockAppPoolModels.ContainsKey($poolName)) {
            return $script:mockAppPoolModels[$poolName]
        }
        if ($script:mockAppPools.ContainsKey($poolName)) {
            $poolObj = $script:mockAppPools[$poolName]
            if ($Name -eq 'processModel') { return [pscustomobject]@{ identityType = $poolObj.identityType; userName = $poolObj.userName } }
            if ($Name -eq 'processModel.identityType') { return $poolObj.identityType }
            if ($Name -eq 'processModel.userName') { return $poolObj.userName }
        }
    }
    Microsoft.PowerShell.Management\Get-ItemProperty @PSBoundParameters
}
function Get-ChildItem {
    param([string]$LiteralPath, [string]$Path, $ErrorAction)
    $target = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
    if ($target -eq 'IIS:\AppPools') {
        if ($script:mockAppPoolEnumerationFailure) {
            Write-Error 'AppPool enumeration failed' -ErrorAction $ErrorAction
            return @()
        }
        return @($script:mockAppPools.Keys | ForEach-Object {
            [pscustomobject]@{
                Name = $_
                processModel = [pscustomobject]@{
                    identityType = $script:mockAppPools[$_].identityType
                    userName = $script:mockAppPools[$_].userName
                }
            }
        })
    }
    Microsoft.PowerShell.Management\Get-ChildItem @PSBoundParameters
}

Assert-Test -Name 'PHP handler mutations are scoped to the target site location' -Condition {
    $script:configurationWrites = @()
    $script:phpHandlerCollection = @()
    Ensure-NetariumPhpHandler -SiteName 'NetariumTest' -PhpCgiPath 'C:\php\php-cgi.exe' | Out-Null
    $write = $script:configurationWrites | Select-Object -First 1
    $script:configurationWrites.Count -eq 1 -and $write.Command -eq 'Add' -and
        $write.PSPath -eq 'MACHINE/WEBROOT/APPHOST' -and $write.Location -eq 'NetariumTest' -and
        $write.Filter -eq 'system.webServer/handlers' -and $write.Value.path -eq '*.php'
}

Assert-Test -Name 'Request limit mutations are scoped to the target site location' -Condition {
    $script:configurationWrites = @()
    Ensure-NetariumRequestLimit -SiteName 'NetariumTest'
    $write = $script:configurationWrites | Select-Object -First 1
    $script:configurationWrites.Count -eq 1 -and $write.Command -eq 'Set' -and
        $write.PSPath -eq 'MACHINE/WEBROOT/APPHOST' -and $write.Location -eq 'NetariumTest' -and
        $write.Filter -eq 'system.webServer/security/requestFiltering/requestLimits' -and
        [int64]$write.Value -eq 33554432
    }

    Assert-Test -Name 'web.config keeps normal 32MiB and image-only 31MiB request limits independent' -Condition {
        [xml]$webConfig = Get-Content -LiteralPath (Join-Path $repoRoot 'public/web.config') -Raw
        $normalLimit = [int64]$webConfig.configuration.'system.webServer'.security.requestFiltering.requestLimits.maxAllowedContentLength
        $imageLocation = @($webConfig.configuration.location | Where-Object { $_.path -eq 'image_upload.php' })[0]
        $imageLimit = [int64]$imageLocation.'system.webServer'.security.requestFiltering.requestLimits.maxAllowedContentLength
        $normalLimit -eq 33554432 -and $imageLimit -eq 32505856
}


Assert-Test -Name 'IIS configuration preflight reads server sections before site-specific sections' -Condition {
    $script:configurationReads = @()
    $script:configurationWrites = @()
    $script:preflightFailureFilter = $null
    Assert-NetariumIisConfigurationPreflight -SiteName 'NetariumTest' -SiteExists $true -SiteLocationExists $true
    $machineReads = @($script:configurationReads | Where-Object { $_.PSPath -eq 'MACHINE/WEBROOT/APPHOST' -and -not $_.Location })
    $siteReads = @($script:configurationReads | Where-Object { $_.PSPath -eq 'MACHINE/WEBROOT/APPHOST' -and $_.Location -eq 'NetariumTest' })
    $machineReads.Count -eq 4 -and $siteReads.Count -eq 4 -and
        $script:configurationWrites.Count -eq 0 -and
        [string]::Join(';', @($machineReads | ForEach-Object Filter)) -eq [string]::Join(';', @($siteReads | ForEach-Object Filter))
}

Assert-Test -Name 'IIS configuration preflight failure is explicit and performs no configuration writes' -Condition {
    $script:configurationReads = @()
    $script:configurationWrites = @()
    $script:preflightFailureFilter = 'system.webServer/security/requestFiltering/requestLimits'
    try {
        Assert-NetariumIisConfigurationPreflight -SiteName 'NetariumTest' -SiteExists $false -SiteLocationExists $false
        return $false
    } catch {
        return $_.Exception.Message -like '*IIS configuration preflight failed*' -and
            $_.Exception.Message -like '*No installation files, site, or application pool have been changed*' -and
            $script:configurationWrites.Count -eq 0
    } finally {
        $script:preflightFailureFilter = $null
    }
}

Assert-Test -Name 'Pre-existing site location without a site is rejected before mutation' -Condition {
    $script:configurationReads = @()
    $script:configurationWrites = @()
    try {
        Assert-NetariumIisConfigurationPreflight -SiteName 'NetariumTest' -SiteExists $false -SiteLocationExists $true
        return $false
    } catch {
        return $_.Exception.Message -like '*site*NetariumTest*absent*location configuration already exists*' -and
            $script:configurationReads.Count -eq 4 -and $script:configurationWrites.Count -eq 0
    }
}

$script:phpHandlerCollection = @([pscustomobject]@{ path = '*.php'; scriptProcessor = 'C:\php\php-cgi.exe' })
Assert-Test -Name 'Existing matching PHP handler is not duplicated' -Condition {
    $script:configurationWrites = @()
    $created = Ensure-NetariumPhpHandler -SiteName 'NetariumTest' -PhpCgiPath 'C:\php\php-cgi.exe'
    !$created -and $script:configurationWrites.Count -eq 0
}

Assert-Test -Name 'Conflicting site PHP handler is rejected without mutation' -Condition {
    $script:configurationWrites = @()
    try {
        Ensure-NetariumPhpHandler -SiteName 'NetariumTest' -PhpCgiPath 'C:\php\other-php-cgi.exe' | Out-Null
        return $false
    } catch {
        return $_.Exception.Message -like '*different PHP CGI*' -and $script:configurationWrites.Count -eq 0
    }
}

Assert-Test -Name 'Fresh FastCGI registration persists the PHP executable and timeouts' -Condition {
    $script:fastCgiApps = @()
    $script:configurationWrites = @()
    $script:mockSite = $null
    $created = Ensure-NetariumPhpFastCgi -PhpCgiPath 'C:\php\php-cgi.exe' -ActivityTimeout 300 -RequestTimeout 360 -SiteName 'NetariumTest'
    $created -and $script:fastCgiApps.Count -eq 1 -and
        $script:fastCgiApps[0].fullPath -eq 'C:\php\php-cgi.exe' -and
        $script:fastCgiApps[0].activityTimeout -eq 300 -and
        $script:fastCgiApps[0].requestTimeout -eq 360
}
Assert-Test -Name 'Repeated FastCGI setup updates the existing application without duplication' -Condition {
    $created = Ensure-NetariumPhpFastCgi -PhpCgiPath 'C:\php\php-cgi.exe' -ActivityTimeout 400 -RequestTimeout 420 -SiteName 'NetariumTest'
    -not $created -and $script:fastCgiApps.Count -eq 1 -and
        $script:fastCgiApps[0].activityTimeout -eq 400 -and
        $script:fastCgiApps[0].requestTimeout -eq 420
}
Assert-Test -Name 'Shared FastCGI settings remain unchanged on conflicting timeout request' -Condition {
    $script:mockSite = [pscustomobject]@{ Name = 'OtherSite' }
    try {
        Ensure-NetariumPhpFastCgi -PhpCgiPath 'C:\php\php-cgi.exe' -ActivityTimeout 500 -RequestTimeout 520 -SiteName 'NetariumTest' | Out-Null
        return $false
    } catch {
        return $_.Exception.Message -like '*shared with another site*' -and
            $script:fastCgiApps.Count -eq 1 -and
            $script:fastCgiApps[0].activityTimeout -eq 400 -and
            $script:fastCgiApps[0].requestTimeout -eq 420
    } finally {
        $script:mockSite = $null
    }
}
Assert-Test -Name 'Silent FastCGI registration failure is rejected before handler setup' -Condition {
    $script:fastCgiApps = @()
    $script:silentFastCgiAdd = $true
    try {
        Ensure-NetariumPhpFastCgi -PhpCgiPath 'C:\php\php-cgi.exe' -ActivityTimeout 300 -RequestTimeout 300 -SiteName 'NetariumTest' | Out-Null
        return $false
    } catch {
        return $_.Exception.Message -like '*PHP FastCGI registration failed*' -and $script:fastCgiApps.Count -eq 0
    } finally {
        $script:silentFastCgiAdd = $false
    }
}
Assert-Test -Name 'Silent PHP handler registration failure is rejected before site startup' -Condition {
    $script:phpHandlerCollection = @()
    $script:silentHandlerAdd = $true
    try {
        Ensure-NetariumPhpHandler -SiteName 'NetariumTest' -PhpCgiPath 'C:\php\php-cgi.exe' | Out-Null
        return $false
    } catch {
        return $_.Exception.Message -like '*does not match FastCGI application*' -and
            $script:phpHandlerCollection.Count -eq 0
    } finally {
        $script:silentHandlerAdd = $false
    }
}
Assert-Test -Name 'Account SID resolver rejects empty account names' -Condition {
    try {
        Get-NetariumAccountSid -AccountName ' ' | Out-Null
        return $false
    } catch {
        return $_.Exception.Message -like '*account name is empty*'
    }
}

# Identity isolation tests control SID resolution; no Windows account lookup is performed.
$savedAccountSidResolver = ${function:Get-NetariumAccountSid}
function Get-NetariumAccountSid {
    param([string]$AccountName)
    if (-not $script:mockAccountSids.ContainsKey($AccountName)) {
        throw "Cannot resolve SID for account '$AccountName': fixture resolution failure."
    }
    return $script:mockAccountSids[$AccountName]
}
try {
    $identityCases = @(
        @{ Name = 'permits a missing pool for fresh installation'; MissingPool = $true }
        @{ Name = 'permits ApplicationPoolIdentity'; Identity = 'ApplicationPoolIdentity' }
        @{ Name = 'rejects LocalSystem'; Identity = 'LocalSystem'; Error = '*must not use built-in shared identity*LocalSystem*' }
        @{ Name = 'rejects NetworkService'; Identity = 'NetworkService'; Error = '*must not use built-in shared identity*NetworkService*' }
        @{ Name = 'rejects LocalService'; Identity = 'LocalService'; Error = '*must not use built-in shared identity*LocalService*' }
        @{ Name = 'rejects unknown identity types'; Identity = 'Unknown'; Error = '*unsupported identity type*' }
        @{ Name = 'rejects empty identity types'; Identity = ''; Error = '*unsupported identity type*' }
        @{ Name = 'rejects an empty custom account'; User = ' '; Error = '*empty SpecificUser account*' }
        @{ Name = 'rejects an unresolved target account'; UnresolvedTarget = $true; Error = '*Cannot resolve SID*fixture resolution failure*' }
        @{ Name = 'rejects a null target SID'; NullTargetSid = $true; Error = '*Cannot resolve SID*' }
        @{ Name = 'rejects the same custom account'; OtherUser = 'fixture\dedicated'; OtherSid = 'S-1-5-21-1-2-3-1001'; Error = '*shares custom user identity*with application pool*Pool2*' }
        @{ Name = 'rejects different spellings with the same SID'; OtherUser = 'dedicated@fixture'; OtherSid = 'S-1-5-21-1-2-3-1001'; Error = '*shares custom user identity*with application pool*Pool2*' }
        @{ Name = 'permits distinct custom SIDs'; OtherUser = 'fixture\other'; OtherSid = 'S-1-5-21-1-2-3-1002' }
        @{ Name = 'rejects an unresolved other account'; OtherUser = 'fixture\other'; Error = "*Cannot resolve SID*fixture\other*fixture resolution failure*" }
        @{ Name = 'rejects a null other SID'; OtherUser = 'fixture\other'; OtherSid = $null; Error = "*Cannot resolve SID*fixture\other*" }
        @{ Name = 'rejects an empty other custom account'; OtherUser = ' '; Error = "*Pool2*empty SpecificUser account*" }
        @{ Name = 'rejects failed pool enumeration'; EnumerationFailure = $true; Error = '*AppPool enumeration failed*' }
        @{ Name = 'rejects failed pool existence checks'; PathFailure = $true; Error = '*AppPool existence check failed*' }
        @{ Name = 'rejects failed target processModel reads'; ReadFailure = 'Pool1'; Error = '*processModel read failed for Pool1*' }
        @{ Name = 'rejects failed other processModel reads'; OtherUser = 'fixture\other'; ReadFailure = 'Pool2'; Error = '*processModel read failed for Pool2*' }
        @{ Name = 'rejects a missing target processModel'; ModelPool = 'Pool1'; Model = $null; Error = '*Cannot read processModel identity type*Pool1*' }
        @{ Name = 'rejects a missing target identity property'; ModelPool = 'Pool1'; Model = [pscustomobject]@{}; Error = '*Cannot read processModel identity type*Pool1*' }
        @{ Name = 'rejects a missing target user property'; ModelPool = 'Pool1'; Model = [pscustomobject]@{ identityType = 'SpecificUser' }; Error = '*empty SpecificUser account*' }
        @{ Name = 'rejects a missing other processModel'; OtherUser = 'fixture\other'; ModelPool = 'Pool2'; Model = $null; Error = '*Cannot read processModel identity type*Pool2*' }
        @{ Name = 'rejects a missing other identity property'; OtherUser = 'fixture\other'; ModelPool = 'Pool2'; Model = [pscustomobject]@{}; Error = '*Cannot read processModel identity type*Pool2*' }
        @{ Name = 'rejects a missing other user property'; OtherUser = 'fixture\other'; ModelPool = 'Pool2'; Model = [pscustomobject]@{ identityType = 'SpecificUser' }; Error = '*Pool2*empty SpecificUser account*' }
        @{ Name = 'rejects an unsupported other identity'; OtherUser = 'fixture\other'; ModelPool = 'Pool2'; Model = [pscustomobject]@{ identityType = 'Unknown' }; Error = '*Pool2*unsupported identity type*' }
    )
    foreach ($case in $identityCases) {
        Assert-Test -Name "AppPool identity isolation $($case.Name)" -Condition {
            $script:mockAppPools = @{}
            $script:mockAppPoolModels = @{}
            $script:mockAccountSids = @{ 'fixture\dedicated' = 'S-1-5-21-1-2-3-1001' }
            $script:mockAppPoolPathFailure = $case.ContainsKey('PathFailure')
            $script:mockAppPoolEnumerationFailure = $case.ContainsKey('EnumerationFailure')
            $script:mockAppPoolReadFailure = if ($case.ContainsKey('ReadFailure')) { $case.ReadFailure } else { '' }
            if (-not $case.ContainsKey('MissingPool')) {
                $script:mockAppPools['Pool1'] = [pscustomobject]@{
                    identityType = if ($case.ContainsKey('Identity')) { $case.Identity } else { 'SpecificUser' }
                    userName = if ($case.ContainsKey('User')) { $case.User } else { 'fixture\dedicated' }
                }
            }
            if ($case.ContainsKey('OtherUser')) {
                $script:mockAppPools['Pool2'] = [pscustomobject]@{ identityType = 'SpecificUser'; userName = $case.OtherUser }
                if ($case.ContainsKey('OtherSid')) { $script:mockAccountSids[$case.OtherUser] = $case.OtherSid }
            }
            if ($case.ContainsKey('UnresolvedTarget')) { $script:mockAccountSids.Remove('fixture\dedicated') }
            if ($case.ContainsKey('NullTargetSid')) { $script:mockAccountSids['fixture\dedicated'] = $null }
            if ($case.ContainsKey('ModelPool')) { $script:mockAppPoolModels[$case.ModelPool] = $case.Model }
            try {
                Assert-NetariumAppPoolIdentityIsolation -ApplicationPoolName 'Pool1'
                return -not $case.ContainsKey('Error')
            } catch {
                return $case.ContainsKey('Error') -and $_.Exception.Message -like $case.Error
            } finally {
                $script:mockAppPools = @{}
                $script:mockAppPoolModels = @{}
                $script:mockAppPoolPathFailure = $false
                $script:mockAppPoolEnumerationFailure = $false
                $script:mockAppPoolReadFailure = ''
            }
        }
    }
} finally {
    ${function:Get-NetariumAccountSid} = $savedAccountSidResolver
}

Assert-Test -Name 'Bootstrap issuer preserves existing files and never prints the secret' -Condition {
    $storage = Join-Path ([IO.Path]::GetTempPath()) ('netarium-bootstrap-' + [Guid]::NewGuid().ToString('N'))
    New-NetariumRuntimeTree -StorageDir $storage
    try {
        & $phpCliPath (Join-Path $repoRoot 'scripts/check-install.php') --app-root $repoRoot --storage-dir $storage | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Bootstrap fixture initialization failed.' }
        $unsafeParent = Join-Path $storage 'unprotected'
        New-Item -ItemType Directory -Path $unsafeParent | Out-Null
        $unsafeFile = Join-Path $unsafeParent 'must-not-exist.secret'
        $savedErrorPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $phpCliPath (Join-Path $repoRoot 'scripts/issue-bootstrap-secret.php') --secret-file $unsafeFile --db (Join-Path $storage 'db/data.sqlite') 2>&1 | Out-Null
            $unsafeExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $savedErrorPreference
        }
        if ($unsafeExitCode -eq 0 -or (Test-Path -LiteralPath $unsafeFile)) { throw 'CLI wrote a secret before protecting its parent.' }
        $file = Invoke-NetariumBootstrapSecret -AppRoot $repoRoot -StorageDir $storage -PhpCgiPath $phpCgiCandidate
        $secret = [IO.File]::ReadAllText($file)
        if ($secret -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid generated secret.' }
        $savedErrorPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = @(& $phpCliPath (Join-Path $repoRoot 'scripts/issue-bootstrap-secret.php') --secret-file $file --db (Join-Path $storage 'db/data.sqlite') 2>&1)
            $issuerExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $savedErrorPreference
        }
        if ($issuerExitCode -eq 0 -or [IO.File]::ReadAllText($file) -cne $secret -or ($output -join "`n").Contains($secret)) {
            throw 'Existing secret file was overwritten or leaked.'
        }
        $replacement = Invoke-NetariumBootstrapSecret -AppRoot $repoRoot -StorageDir $storage -PhpCgiPath $phpCgiCandidate
        if ($replacement -eq $file -or [IO.File]::ReadAllText($file) -cne $secret) { throw 'Reissue did not preserve the old physical copy.' }
        return $true
    } finally {
        if (Test-Path -LiteralPath $storage) { Remove-Item -LiteralPath $storage -Recurse -Force }
    }
}

Write-Host "`nAll $testsRun tests passed ($testsPassed/$testsRun)." -ForegroundColor Green
exit 0
