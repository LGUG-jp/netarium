[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repoRoot 'scripts/deployment-common.ps1')

# Resolve only the synthetic IIS identity; exercise real filesystem ACLs in the isolated fixture.
$poolSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-82-123')
function New-Object {
    param([string]$TypeName, [object[]]$ArgumentList)
    if ($TypeName -eq 'System.Security.AccessControl.FileSystemAccessRule' -and $ArgumentList[0] -like 'IIS AppPool\*') {
        $ArgumentList[0] = $poolSid
    }
    Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList
}
# Execute fresh setup through publication, with real CLI issuance and isolated ACLs.
$setupPath = Join-Path $repoRoot 'scripts/setup-iis.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($setupPath, [ref]$null, [ref]$null)
foreach ($fn in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($fn.Name -in @('Assert-NetariumFreshDestination', 'Copy-NetariumReleaseManifest', 'New-NetariumRuntimeTree', 'New-NetariumAppConfig', 'Merge-NetariumTree', 'Invoke-NetariumInstallCheck', 'Get-NetariumPhpCliPath', 'Invoke-NetariumBootstrapSecret')) {
        Invoke-Expression $fn.Extent.Text
    }
}
$script:realInstallCheck = (Get-Command Invoke-NetariumInstallCheck).ScriptBlock
$setupTry = $ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] } | Select-Object -First 1
$statements = @($setupTry.Body.Statements)
$first = -1
$last = -1
for ($index = 0; $index -lt $statements.Count; $index++) {
    $statement = $statements[$index]
    if ($statement.Extent.Text -like 'Assert-NetariumFreshDestination*') { $first = $index }
    if ($statement.Extent.Text -like 'Start-Website*') { $last = $index }
}
if ($first -lt 0 -or $last -le $first) { throw 'Fresh-setup transaction statements were not found.' }
$transaction = [scriptblock]::Create(([string]::Join("`n", @($statements[$first..$last] | ForEach-Object { $_.Extent.Text }))))

$root = Join-Path ([IO.Path]::GetTempPath()) ('netarium-setup-order-' + [guid]::NewGuid().ToString('N'))
$SiteName = 'NetariumSetupOrderTest'
$ApplicationPoolName = $SiteName
$PhpCgiPath = Join-Path (Split-Path -Parent (Get-Command php -ErrorAction Stop).Source) 'php-cgi.exe'
$FastCgiActivityTimeoutSeconds = 300
$FastCgiRequestTimeoutSeconds = 300
$Port = 80
$Protocol = 'http'
$HostName = 'example.test'
$CertificateThumbprint = ''
$VerificationUrl = 'http://example.test/'
$HostHeader = $HostName
$release = [pscustomobject]@{ Root = $repoRoot }
function Get-IisState {
    param([string]$SiteName, [string]$ApplicationPoolName, [string]$PhpCgiPath)
    return [pscustomobject]@{ SiteExists = $true; AppPoolExists = $true; FastCgi = @() }
}
function Invoke-NetariumInstallCheck {
    param(
        [Parameter(Mandatory = $true)][string]$AppRoot,
        [Parameter(Mandatory = $true)][string]$StorageDir,
        [Parameter(Mandatory = $true)][string]$PhpCgiPath
    )
    if ([System.IO.Path]::GetFullPath($AppRoot).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($stagingPath).TrimEnd('\')) {
        if ($script:mockSiteRunning -ne $script:initialRunning) { throw 'Existing IIS site state changed before staging CLI install check.' }
        $result = & $script:realInstallCheck @PSBoundParameters
        $script:stagingCheckCompleted = $true
        return $result
    }
    return & $script:realInstallCheck @PSBoundParameters
}
function Stop-Website {
    param([string]$Name, [string]$ErrorAction)
    if (-not $script:stagingCheckCompleted) { throw 'Existing IIS site was stopped before staging CLI install check completed.' }
    if (Test-Path -LiteralPath (Join-Path $publicPath 'web.config') -PathType Leaf) {
        throw 'Existing IIS site was stopped after copying the staged release into InstallRoot.'
    }
    $script:mockSiteRunning = $false
}

function Ensure-NetariumAppPool {
    param([string]$ApplicationPoolName, [string]$SiteName)
    return $true
}
function Get-WebAppPoolState {
    param([string]$Name)
    return [pscustomobject]@{ Value = if ($script:mockPoolRunning) { 'Started' } else { 'Stopped' } }
}
function Stop-WebAppPool {
    param([string]$Name, [string]$ErrorAction)
    $script:mockPoolRunning = $false
}
function Ensure-NetariumSite {
    param([string]$SiteName, [string]$PhysicalPath, [string]$ApplicationPoolName, [string]$Protocol, [int]$Port, [string]$HostName, [string]$CertificateThumbprint, [string]$HostHeader)
    if ($script:mockSiteRunning) { throw 'IIS site was running before site configuration.' }
    if ($script:mockPoolRunning) { throw 'IIS pool was running before site configuration.' }
    $webConfig = Join-Path $PhysicalPath 'web.config'
    if (-not (Test-Path -LiteralPath $webConfig -PathType Leaf)) { throw "IIS cannot read $webConfig" }
    [xml]$config = Get-Content -LiteralPath $webConfig -Raw
    if (-not $config.configuration) { throw 'The IIS configuration is invalid.' }
    $script:publicWasReady = $true
}
function Ensure-NetariumPhpFastCgi { param($PhpCgiPath, $ActivityTimeout, $RequestTimeout, $SiteName) }
function Ensure-NetariumPhpHandler { param($SiteName, $PhpCgiPath) }
function Ensure-NetariumRequestLimit { param($SiteName) }
function Ensure-NetariumDefaultDocument { param($SiteName) }
function Set-NetariumAcl {
    param($InstallRoot, $StorageDir, $ApplicationPoolName)
    if ($script:mockPoolRunning -or $script:mockSiteRunning) { throw 'ACL was applied while IIS was running.' }
    Set-NetariumBootstrapAcl -StorageDir $StorageDir
}
function Start-WebAppPool {
    param($Name, $ErrorAction)
    $files = @(Get-ChildItem -LiteralPath (Join-Path $storagePath 'bootstrap') -File)
    if ($files.Count -ne 1 -or [IO.File]::ReadAllText($files[0].FullName) -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Pool publication preceded bootstrap issuance.'
    }
    $rules = @((Get-Acl -LiteralPath $files[0].FullName).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (@($rules | Where-Object { $_.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544') }).Count) {
        throw 'Issued secret is accessible outside local administrators/SYSTEM.'
    }
    $script:mockPoolRunning = $true
}
function Start-Website {
    param($Name, $ErrorAction)
    if (-not $script:mockPoolRunning) { throw 'Site publication preceded pool startup.' }
    throw 'Deliberate IIS setup failure after public was placed.'
}
function Restore-NetariumIisState {
    param([psobject]$State, [switch]$KeepStopped)
    $script:mockSiteRunning = $State.Iis.Site.State -eq 'Started'
    $script:mockPoolRunning = $State.Iis.AppPool.State -eq 'Started'
}

try {
    foreach ($layout in @('absent', 'empty-root', 'empty-public')) {
        $installRootPath = Join-Path $root $layout
        $storagePath = Join-Path $installRootPath 'data'
        $publicPath = Join-Path $installRootPath 'public'
        $stagingPath = $installRootPath + '.staging'
        $RollbackRoot = Join-Path $root ('rollback-' + $layout)
        if ($layout -eq 'empty-root') { New-Item -ItemType Directory -Path $installRootPath -Force | Out-Null }
        if ($layout -eq 'empty-public') { New-Item -ItemType Directory -Path $publicPath -Force | Out-Null }
        $publicAcl = if ($layout -eq 'empty-public') { (Get-Acl -LiteralPath $publicPath).Sddl } else { '' }
        $script:initialRunning = $layout -ne 'empty-public'
        $initialState = if ($script:initialRunning) { 'Started' } else { 'Stopped' }
        $iisBefore = [pscustomobject]@{
            SiteExists = $true; Site = [pscustomobject]@{ State = $initialState; PhysicalPath = $publicPath }
            AppPoolExists = $true; AppPool = [pscustomobject]@{ State = $initialState }
            PhpCgiPath = $PhpCgiPath; FastCgi = @()
        }
        $Protocol = if ($layout -eq 'empty-public') { 'existing' } else { 'http' }
        $snapshotPath = $null
        $script:publicWasReady = $false
        $script:mockPoolRunning = $script:initialRunning
        $script:mockSiteRunning = $script:initialRunning
        $script:stagingCheckCompleted = $false
        try {
            . $transaction
            throw 'IIS setup failure was not triggered.'
        } catch {
            if ($_.Exception.Message -ne 'Deliberate IIS setup failure after public was placed.') { throw }
        }
        if (-not $script:publicWasReady -or -not $snapshotPath) { throw 'public was not ready when the IIS site was created.' }
        if ($script:mockSiteRunning) { throw 'Existing IIS site was not stopped before IIS site configuration.' }
        Restore-NetariumSnapshot -SnapshotPath $snapshotPath -InstallRoot $installRootPath -StorageDir $storagePath | Out-Null
        if ($layout -eq 'absent') {
            if (Test-Path -LiteralPath $installRootPath) { throw 'Fresh-setup rollback left installation files behind.' }
        } else {
            $children = @(Get-ChildItem -LiteralPath $installRootPath -Force)
            $expectedCount = if ($layout -eq 'empty-public') { 1 } else { 0 }
            if ($children.Count -ne $expectedCount) { throw "Fresh-setup rollback left files in $layout." }
            if ($layout -eq 'empty-public' -and
                (!(Test-Path -LiteralPath $publicPath -PathType Container) -or
                @(Get-ChildItem -LiteralPath $publicPath -Force).Count -ne 0 -or
                (Get-Acl -LiteralPath $publicPath).Sddl -cne $publicAcl)) {
                throw 'Fresh-setup rollback did not preserve the empty public directory and ACL.'
            }
        }
        if ($script:mockSiteRunning -ne $script:initialRunning -or $script:mockPoolRunning -ne $script:initialRunning) {
            throw 'Rollback did not restore the initial IIS state.'
        }
        Remove-Item -LiteralPath $stagingPath -Recurse -Force
        Write-Host "  [PASS] $layout staging, publication ordering and post-bootstrap rollback preserve files, ACL and initial IIS state" -ForegroundColor Green
    }
    # Old fresh snapshots may contain data that the new preflight would refuse.
    foreach ($layout in @('legacy-data', 'external-storage')) {
        $installRootPath = Join-Path $root $layout
        New-Item -ItemType Directory -Path $installRootPath -Force | Out-Null
        $storagePath = if ($layout -eq 'legacy-data') { Join-Path $installRootPath 'data' } else { Join-Path $root 'external-data' }
        New-NetariumRuntimeTree -StorageDir $storagePath
        New-Item -ItemType Directory -Path (Join-Path $storagePath 'bootstrap') -Force | Out-Null
        foreach ($file in @('db/existing.sqlite', 'logs/existing.log', 'bootstrap/existing.secret')) {
            [IO.File]::WriteAllText((Join-Path $storagePath $file), 'synthetic preserved data')
        }
        $before = @(Get-FileInventory -Root $storagePath) | ConvertTo-Json -Depth 5 -Compress
        $snapshotPath = New-NetariumSnapshot -RollbackRoot (Join-Path $root ('rollback-' + $layout)) -InstallRoot $installRootPath -StorageDir $storagePath -SiteName $SiteName -ApplicationPoolName $ApplicationPoolName -Stage 'fresh-setup' -IisState $iisBefore
        Restore-NetariumSnapshot -SnapshotPath $snapshotPath -InstallRoot $installRootPath -StorageDir $storagePath | Out-Null
        $after = @(Get-FileInventory -Root $storagePath) | ConvertTo-Json -Depth 5 -Compress
        if ($before -cne $after) { throw "Fresh rollback removed pre-existing $layout files." }
        Write-Host "  [PASS] fresh rollback preserves $layout database, logs and bootstrap files" -ForegroundColor Green
    }
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
