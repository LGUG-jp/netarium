[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repoRoot 'scripts/deployment-common.ps1')
Assert-Administrator

# Execute the real existing-setup path and NTFS ACLs; only IIS and faults are simulated.
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repoRoot 'scripts/setup-iis.ps1'), [ref]$null, [ref]$null)
foreach ($fn in $ast.FindAll({ $args[0] -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($fn.Name -in @('Assert-NetariumExistingConfiguration', 'Get-NetariumEnvironmentMap')) { Invoke-Expression $fn.Extent.Text }
}
$poolSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-82-123')
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function New-Object {
    param([string]$TypeName, [object[]]$ArgumentList)
    if ($TypeName -eq 'System.Security.AccessControl.FileSystemAccessRule' -and $ArgumentList[0] -eq 'IIS AppPool\ExistingSetupAclTest') {
        $ArgumentList[0] = $poolSid
    }
    Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList
}
function Test-Path {
    param([string]$LiteralPath, [string]$PathType, $ErrorAction)
    if ($LiteralPath -eq 'IIS:\AppPools\ExistingSetupAclTest') { return $true }
    Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
}
function Get-ItemProperty {
    param([string]$LiteralPath, [string]$Name, $ErrorAction)
    if ($LiteralPath -eq 'IIS:\AppPools\ExistingSetupAclTest' -and $Name -eq 'processModel') {
        return [pscustomobject]@{ identityType = 'ApplicationPoolIdentity'; userName = '' }
    }
    Microsoft.PowerShell.Management\Get-ItemProperty @PSBoundParameters
}
function Get-IisState {
    param($SiteName, $ApplicationPoolName, $PhpCgiPath)
    return [pscustomobject]@{
        SiteExists = $true; AppPoolExists = $true
        Site = [pscustomobject]@{ PhysicalPath = (Join-Path $script:install 'public'); ApplicationPool = 'ExistingSetupAclTest'; State = $script:siteState; EnvironmentVariables = @() }
        AppPool = [pscustomobject]@{ State = $script:poolState; EnvironmentVariables = @() }
        Handler = @(); FastCgi = @()
    }
}
$script:realStopSite = (Get-Command Stop-NetariumSiteIfRunning).ScriptBlock
function Stop-NetariumSiteIfRunning {
    param([Parameter(Mandatory = $true)][string]$SiteName, [int]$TimeoutSeconds = 30)
    $timeout = if ($script:fault -like '*-timeout') { 1 } else { $TimeoutSeconds }
    & $script:realStopSite -SiteName $SiteName -TimeoutSeconds $timeout
}
$script:realStopPool = (Get-Command Stop-NetariumAppPoolIfRunning).ScriptBlock
function Stop-NetariumAppPoolIfRunning {
    param([Parameter(Mandatory = $true)][string]$ApplicationPoolName, [int]$TimeoutSeconds = 30)
    $timeout = if ($script:fault -like '*-timeout') { 1 } else { $TimeoutSeconds }
    & $script:realStopPool -ApplicationPoolName $ApplicationPoolName -TimeoutSeconds $timeout
}
function Get-Website { param($Name, $ErrorAction) return [pscustomobject]@{ Name = $Name } }
function Get-WebSiteState {
    param($Name)
    if ($script:siteTransitionalCount -gt 0) {
        $script:siteTransitionalCount--
        if ($script:siteTransitionalCount -eq 0) {
            $script:siteState = $script:siteTransitionalTarget
        }
    }
    return [pscustomobject]@{ Value = $script:siteState }
}
function Get-WebAppPoolState {
    param($Name)
    if ($script:poolTransitionalCount -gt 0) {
        $script:poolTransitionalCount--
        if ($script:poolTransitionalCount -eq 0) {
            $script:poolState = $script:poolTransitionalTarget
        }
    }
    return [pscustomobject]@{ Value = $script:poolState }
}
function Stop-Website {
    param($Name, $ErrorAction)
    $script:stopAttempts++
    $script:events.Add('stop-site')
    if ($script:fault -eq 'stop-always' -or ($script:fault -eq 'stop-once' -and $script:stopAttempts -eq 1)) {
        throw 'Injected site stop failure'
    }
    $script:siteState = 'Stopped'
}
function Stop-WebAppPool {
    param($Name, $ErrorAction)
    $script:events.Add('stop-pool')
    $script:poolState = 'Stopped'
}
function Wait-NetariumRequestDrain {
    param($ApplicationPoolName)
    if ($script:siteState -ne 'Stopped') { throw 'Requests were drained before new admission was stopped' }
    $script:events.Add('drain')
    if ($script:fault -eq 'drain') { throw 'Injected request drain timeout' }
    $script:drained = $true
}
function Invoke-NetariumInstallCheck {
    param($AppRoot, $StorageDir, $PhpCgiPath)
    $script:events.Add('preflight')
    if ($script:fault -eq 'preflight') { throw 'Injected preflight failure' }
}
function Set-Acl {
    param($LiteralPath, $AclObject, $ErrorAction)
    if ($script:siteState -ne 'Stopped' -or $script:poolState -ne 'Stopped' -or -not $script:drained) {
        throw 'Confidential ACL mutation while requests can still run'
    }
    $script:aclWrites++
    if ($LiteralPath -eq $script:child -and $script:fault -eq 'set-acl') { throw 'Injected child Set-Acl failure' }
    Microsoft.PowerShell.Security\Set-Acl -LiteralPath $LiteralPath -AclObject $AclObject -ErrorAction Stop
}
function Get-Acl {
    param($LiteralPath)
    $acl = Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath
    if ($LiteralPath -eq $script:child -and $script:fault -eq 'owner') { $acl.SetOwner($ownerSid) }
    return $acl
}
function Ensure-NetariumPhpFastCgi {
    param($PhpCgiPath, $ActivityTimeout, $RequestTimeout, $SiteName)
    if ($script:fault -eq 'configuration') { throw 'Injected FastCGI configuration failure' }
}
function Ensure-NetariumPhpHandler { param($SiteName, $PhpCgiPath) }
function Ensure-NetariumRequestLimit { param($SiteName) }
function Ensure-NetariumDefaultDocument { param($SiteName) $script:configurationComplete = $true }
function Assert-ReadyToRestart {
    if (-not $script:configurationComplete) { throw 'Restart before ACL and configuration completed' }
    foreach ($path in @($script:child, (Join-Path $script:install 'config/app.php'))) {
        if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') {
            throw 'Restart with an unprotected confidential owner'
        }
    }
}
function Start-WebAppPool {
    param($Name, $ErrorAction)
    Assert-ReadyToRestart
    $script:events.Add('start-pool')
    if ($script:fault -eq 'start-pool') { throw 'Injected pool startup failure' }
    if ($script:fault -eq 'start-pool-leaves-starting') {
        $script:poolState = 'Starting'
        $script:poolTransitionalCount = 2
        $script:poolTransitionalTarget = 'Started'
        throw 'Injected pool startup failure leaving starting state'
    }
    $script:poolState = 'Started'
}
function Start-Website {
    param($Name, $ErrorAction)
    Assert-ReadyToRestart
    $script:events.Add('start-site')
    if ($script:fault -eq 'start-site') { throw 'Injected site startup failure' }
    if ($script:fault -eq 'start-site-leaves-starting') {
        $script:siteState = 'Starting'
        $script:siteTransitionalCount = 2
        $script:siteTransitionalTarget = 'Started'
        throw 'Injected site startup failure leaving starting state'
    }
    $script:siteState = 'Started'
}

$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('netarium-existing-setup-acl-' + [guid]::NewGuid().ToString('N'))
function Invoke-ExistingSetupCase {
    param([string]$Fault, [string]$SiteState = 'Started', [string]$PoolState = 'Started')
    $script:install = Join-Path $sandbox ([guid]::NewGuid().ToString('N'))
    $storage = Join-Path $script:install 'data'
    foreach ($relative in @('public', 'config', 'data/db')) {
        New-Item -ItemType Directory -Path (Join-Path $script:install $relative) -Force | Out-Null
    }
    $script:child = Join-Path $storage 'db/synthetic.sqlite'
    [IO.File]::WriteAllText($script:child, 'synthetic-database-content')
    $config = Join-Path $script:install 'config/app.php'
    $configText = "<?php return ['storage_dir' => '" + $storage.Replace('\', '\\') + "'];"
    [IO.File]::WriteAllText($config, $configText)
    foreach ($file in @($script:child, $config)) {
        $acl = [IO.File]::GetAccessControl($file)
        $acl.SetOwner($ownerSid)
        [IO.File]::SetAccessControl($file, $acl)
    }
    $script:fault = $Fault
    $script:siteState = $SiteState; $script:poolState = $PoolState
    $script:siteTransitionalCount = 0; $script:siteTransitionalTarget = 'Started'
    $script:poolTransitionalCount = 0; $script:poolTransitionalTarget = 'Started'
    if ($SiteState -eq 'Starting') {
        $script:siteTransitionalCount = 2
        $script:siteTransitionalTarget = 'Started'
    }
    if ($PoolState -eq 'Starting') {
        $script:poolTransitionalCount = 2
        $script:poolTransitionalTarget = 'Started'
    }
    if ($Fault -eq 'site-stop-timeout') {
        $script:siteState = 'Starting'
        $script:siteTransitionalCount = 999
        $script:siteTransitionalTarget = 'Starting'
    }
    if ($Fault -eq 'pool-stop-timeout') {
        $script:poolState = 'Starting'
        $script:poolTransitionalCount = 999
        $script:poolTransitionalTarget = 'Starting'
    }
    $script:drained = $PoolState -eq 'Stopped'
    $script:events = [Collections.Generic.List[string]]::new()
    $script:aclWrites = 0; $script:stopAttempts = 0
    $failure = $null
    try {
        Assert-NetariumExistingConfiguration -InstallRoot $script:install -StorageDir $storage -SiteName 'ExistingSetupAclTest' -ApplicationPoolName 'ExistingSetupAclTest' -PhpCgiPath 'C:\php\php-cgi.exe' -BaseUrl 'http://synthetic.invalid/' -ActivityTimeout 300 -RequestTimeout 300
    } catch { $failure = $_ }
    if ($Fault -eq '') {
        if ($failure) { throw $failure }
        $finalExpectedSite = if ($SiteState -in @('Started', 'Starting')) { 'Started' } else { 'Stopped' }
        $finalExpectedPool = if ($PoolState -in @('Started', 'Starting')) { 'Started' } else { 'Stopped' }
        if ($script:siteState -ne $finalExpectedSite -or $script:poolState -ne $finalExpectedPool) { throw 'Original site/pool running states were not preserved' }
        $starts = @($script:events | Where-Object { $_ -like 'start-*' })
        $expectedStarts = @()
        if ($PoolState -in @('Started', 'Starting')) { $expectedStarts += 'start-pool' }
        if ($SiteState -in @('Started', 'Starting')) { $expectedStarts += 'start-site' }
        if (($starts -join ',') -cne ($expectedStarts -join ',')) { throw 'Stopped services were started or restart order changed' }
        foreach ($file in @($script:child, $config)) {
            if ((Microsoft.PowerShell.Security\Get-Acl -LiteralPath $file).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw 'Confidential owner was not protected' }
        }
    } else {
        $expectedErrors = @{
            'set-acl' = '*Injected child Set-Acl failure*'
            'owner' = '*Failed to enforce Administrators ownership*'
            'drain' = '*Injected request drain timeout*'
            'configuration' = '*Injected FastCGI configuration failure*'
            'start-pool' = '*Injected pool startup failure*'
            'start-site' = '*Injected site startup failure*'
            'start-pool-leaves-starting' = '*Injected pool startup failure leaving starting state*'
            'start-site-leaves-starting' = '*Injected site startup failure leaving starting state*'
            'site-stop-timeout' = '*Failed to stop site*'
            'pool-stop-timeout' = '*Failed to stop application pool*'
            'preflight' = '*Injected preflight failure*'
            'stop-once' = '*Injected site stop failure*'
            'stop-always' = '*Injected site stop failure*'
        }
        if (-not $failure -or $failure.Exception.Message -notlike $expectedErrors[$Fault]) { throw "Expected $Fault failure was not reported: $failure" }
        if ($Fault -eq 'preflight') {
            if ($script:siteState -ne $SiteState -or $script:poolState -ne $PoolState -or $script:events.Count -ne 1) { throw 'Read-only preflight failure changed running state' }
        } elseif ($Fault -in @('stop-always', 'site-stop-timeout', 'pool-stop-timeout')) {
            if ($script:aclWrites -ne 0 -or $failure.Exception.Message -notlike '*Could not stop*') { throw 'Stop failure was hidden or allowed ACL mutations' }
        } elseif ($script:siteState -ne 'Stopped' -or $script:poolState -ne 'Stopped') { throw 'Failed existing setup left site/pool running' }
        if ($Fault -in @('drain', 'stop-once') -and $script:aclWrites -ne 0) { throw 'ACL changed before requests were drained and workers stopped' }
        if ($Fault -eq 'set-acl' -and (Microsoft.PowerShell.Security\Get-Acl -LiteralPath $script:child).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid.Value) { throw 'The failed child did not preserve the old-owner fault condition' }
        if ($Fault -in @('set-acl', 'owner', 'drain', 'configuration', 'stop-once', 'stop-always', 'start-pool-leaves-starting', 'start-site-leaves-starting', 'site-stop-timeout', 'pool-stop-timeout') -and @($script:events | Where-Object { $_ -like 'start-*' -and $Fault -notlike 'start-*' }).Count -ne 0) { throw 'Failed protection was followed by an unexpected restart' }
    }
    if ([IO.File]::ReadAllText($script:child) -cne 'synthetic-database-content' -or [IO.File]::ReadAllText($config) -cne $configText) { throw 'Existing database/config contents changed' }
    Write-Host "[PASS] existing setup fault='$Fault', initial site=$SiteState pool=$PoolState"
}
try {
    foreach ($site in @('Started', 'Stopped', 'Starting')) {
        foreach ($pool in @('Started', 'Stopped')) { Invoke-ExistingSetupCase -Fault '' -SiteState $site -PoolState $pool }
    }
    Invoke-ExistingSetupCase -Fault '' -SiteState 'Started' -PoolState 'Starting'
    foreach ($fault in @('set-acl', 'owner', 'drain', 'configuration', 'start-pool', 'start-site', 'start-pool-leaves-starting', 'start-site-leaves-starting', 'site-stop-timeout', 'pool-stop-timeout', 'preflight', 'stop-once', 'stop-always')) { Invoke-ExistingSetupCase -Fault $fault }
} finally {
    if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
