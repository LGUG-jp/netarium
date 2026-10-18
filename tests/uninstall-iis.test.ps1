[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceScript = Join-Path $repoRoot 'scripts/uninstall-iis.ps1'
$sourceCommon = Join-Path $repoRoot 'scripts/deployment-common.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('netarium-uninstall-' + [guid]::NewGuid().ToString('N'))
$previousState = Get-Variable -Name netariumUninstallState -Scope Global -ErrorAction SilentlyContinue

# The release script is executed, including its entry point. Only the two
# environment preflights and IIS/console cmdlets are replaced in its own scope.
$mockCommands = @'
function Assert-Administrator {}
function Assert-WebAdministration {}
function Test-Path {
    param([string]$LiteralPath, [string]$Path, [string]$PathType)
    $target = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
    if ($target -eq "IIS:\AppPools\$($global:netariumUninstallState.PoolName)") {
        return $global:netariumUninstallState.PoolExists
    }
    return Microsoft.PowerShell.Management\Test-Path -LiteralPath $target -PathType $(if ($PathType) { $PathType } else { 'Any' })
}
function Get-Website {
    param([string]$Name, [string]$ErrorAction)
    if ($PSBoundParameters.ContainsKey('Name')) {
        foreach ($site in $global:netariumUninstallState.Sites) {
            if ($site.Name -eq $Name) { $site }
        }
    } else {
        $global:netariumUninstallState.Sites
    }
}
function Get-WebApplication {
    param([string]$Site, [string]$ErrorAction)
    foreach ($app in $global:netariumUninstallState.Applications) {
        if ($app.Site -eq $Site) { $app }
    }
}
function Get-WebConfigurationLocation {
    param([string]$Name, [string]$PSPath, [string]$ErrorAction)
    if ($Name -eq $global:netariumUninstallState.SiteName -and $global:netariumUninstallState.LocationExists) {
        [pscustomobject]@{ Name = $Name }
    }
}
function Get-WebConfigurationProperty {
    param([string]$PSPath, [string]$Location, [string]$Filter, [string]$Name, [string]$ErrorAction)
    if ($Filter -eq 'system.webServer/fastCgi/application') {
        $global:netariumUninstallState.FastCgi
    } elseif ($Filter -eq 'system.webServer/handlers/add') {
        if ($Location -eq $global:netariumUninstallState.SiteName) {
            $global:netariumUninstallState.LocationHandlers
        } elseif ($global:netariumUninstallState.Handlers.ContainsKey($PSPath)) {
            $global:netariumUninstallState.Handlers[$PSPath]
        }
    } else {
        throw "Unexpected IIS configuration query: $Filter"
    }
}
function Get-WebSiteState { param([string]$Name) [pscustomobject]@{ Value = $(if ($global:netariumUninstallState.SiteRunning) { 'Started' } else { 'Stopped' }) } }
function Get-WebAppPoolState { param([string]$Name) [pscustomobject]@{ Value = $(if ($global:netariumUninstallState.PoolRunning) { 'Started' } else { 'Stopped' }) } }
function Stop-Website { param([string]$Name, [string]$ErrorAction) $global:netariumUninstallState.Operations.Add('stop-site'); $global:netariumUninstallState.SiteRunning = $false }
function Stop-WebAppPool { param([string]$Name, [string]$ErrorAction) $global:netariumUninstallState.Operations.Add('stop-pool'); $global:netariumUninstallState.PoolRunning = $false }
function Remove-WebConfigurationLocation { param([string]$Name, [string]$PSPath, [string]$ErrorAction) $global:netariumUninstallState.Operations.Add('remove-location'); $global:netariumUninstallState.LocationExists = $false }
function Remove-Website {
    param([string]$Name, [string]$ErrorAction)
    $global:netariumUninstallState.Operations.Add('remove-site')
    $global:netariumUninstallState.Sites = @($global:netariumUninstallState.Sites | Where-Object { $_.Name -ne $Name })
}
function Remove-WebAppPool {
    param([string]$Name, [string]$ErrorAction)
    if ($global:netariumUninstallState.FailPoolOnce) {
        $global:netariumUninstallState.FailPoolOnce = $false
        throw 'Injected pool removal failure.'
    }
    $global:netariumUninstallState.Operations.Add('remove-pool')
    $global:netariumUninstallState.PoolExists = $false
}
function Remove-WebConfigurationProperty {
    param([string]$PSPath, [string]$Filter, [string]$Name, $AtElement, [string]$ErrorAction)
    if ($PSPath -ne 'MACHINE/WEBROOT/APPHOST' -or $Filter -ne 'system.webServer/fastCgi' -or
        $Name -ne '.' -or $AtElement.fullPath -ne $global:netariumUninstallState.Cgi) {
        throw 'FastCGI deletion must target the collection and the owned executable.'
    }
    if ($global:netariumUninstallState.FailCgiOnce) {
        $global:netariumUninstallState.FailCgiOnce = $false
        throw 'Injected FastCGI removal failure.'
    }
    $global:netariumUninstallState.Operations.Add('remove-cgi')
    $global:netariumUninstallState.FastCgi = @()
}
function Get-CimInstance {
    param([string]$ClassName, [string]$Filter, [string]$ErrorAction)
    if ($ClassName -ne 'Win32_UserProfile' -or $Filter -notmatch "^SID='([^']+)'$") {
        throw "Unexpected profile query: $ClassName $Filter"
    }
    $sid = $Matches[1]
    $global:netariumUninstallState.Profiles | Where-Object { $_.SID -eq $sid }
}
function Remove-CimInstance {
    param($InputObject, [string]$ErrorAction)
    if ($InputObject.Loaded -or $InputObject.Special -or $global:netariumUninstallState.PoolExists) {
        throw 'Unsafe profile deletion.'
    }
    $global:netariumUninstallState.Profiles = @($global:netariumUninstallState.Profiles | Where-Object { $_.SID -ne $InputObject.SID })
}
function Read-Host {
    param([string]$Prompt)
    $global:netariumUninstallState.Prompts++
    return $global:netariumUninstallState.Answer
}
'@

function Assert-Case {
    param([string]$Name, [bool]$Condition)
    if (-not $Condition) { throw "FAIL: $Name" }
    Write-Host "  [PASS] $Name" -ForegroundColor Green
}

function New-Case {
    param([string]$Name)
    $parent = Join-Path $sandbox $Name
    $install = Join-Path $parent 'install'
    $rollback = Join-Path $parent 'rollback'
    $cgi = Join-Path $sandbox 'php-cgi.exe'
    foreach ($dir in @($install, $rollback, (Join-Path $install 'config'), (Join-Path $install 'data'), (Join-Path $install 'public'), (Join-Path $install 'src'), (Join-Path $install 'templates'), (Join-Path $install 'scripts'))) {
        [void][IO.Directory]::CreateDirectory($dir)
    }
    $config = Join-Path $install 'config/app.php'
    [IO.File]::WriteAllText($config, "<?php return ['storage_dir' => '" + (Join-Path $install 'data').Replace('\', '\\') + "',];")
    foreach ($file in @('bootstrap.php', 'auth.php', 'database.php', 'version.php', 'config/app.example.php', 'public/index.php', 'data/private.db')) {
        [IO.File]::WriteAllText((Join-Path $install $file), $file)
    }
    [IO.File]::WriteAllText((Join-Path $install 'unmanaged.keep'), 'keep')
    $snapshot = Join-Path $rollback 'snapshot-1'
    [void][IO.Directory]::CreateDirectory($snapshot)
    $siteName = 'NetariumUninstallTest'
    $poolName = 'NetariumUninstallPool'
    [IO.File]::WriteAllText((Join-Path $snapshot 'manifest.json'), ([pscustomobject]@{
        TargetPath = $install; SnapshotPath = $snapshot; SiteName = $siteName; ApplicationPoolName = $poolName
    } | ConvertTo-Json))
    [IO.File]::WriteAllText((Join-Path $snapshot 'snapshot.keep'), 'snapshot')
    [IO.File]::WriteAllText((Join-Path $rollback 'update.lock'), 'lock')
    $site = [pscustomobject]@{ Name = $siteName; PhysicalPath = (Join-Path $install 'public'); ApplicationPool = $poolName }
    $global:netariumUninstallState = @{
        SiteName = $siteName; PoolName = $poolName; Cgi = $cgi
        Sites = @($site); Applications = @(); PoolExists = $true; LocationExists = $true
        SiteRunning = $true; PoolRunning = $true
        LocationHandlers = @([pscustomobject]@{ name = 'Netarium-PHP'; path = '*.php'; modules = 'FastCgiModule'; scriptProcessor = $cgi })
        Handlers = @{ "IIS:\Sites\$siteName" = @([pscustomobject]@{ name = 'Netarium-PHP'; path = '*.php'; modules = 'FastCgiModule'; scriptProcessor = $cgi }) }
        FastCgi = @([pscustomobject]@{ fullPath = $cgi })
        Operations = (New-Object 'System.Collections.Generic.List[string]')
        Prompts = 0; Answer = ''; FailCgiOnce = $false; FailPoolOnce = $false
        Profiles = @()
    }
    return @{ Install = $install; Rollback = $rollback; Config = $config; Parent = $parent; Snapshot = $snapshot }
}

function Invoke-Case {
    param([hashtable]$Case, [switch]$RemoveData, [switch]$Force, [switch]$NonInteractive, [switch]$WhatIf, [string]$PhpCgiPath)
    $parameters = @{
        InstallRoot = $Case.Install; RollbackRoot = $Case.Rollback
        SiteName = $global:netariumUninstallState.SiteName
        ApplicationPoolName = $global:netariumUninstallState.PoolName
    }
    if ($RemoveData) { $parameters.RemoveData = $true }
    if ($Force) { $parameters.Force = $true }
    if ($NonInteractive) { $parameters.NonInteractive = $true }
    if ($WhatIf) { $parameters.WhatIf = $true }
    if ($PhpCgiPath) { $parameters.PhpCgiPath = $PhpCgiPath }
    & $fixtureScript @parameters
}

function Assert-Rejected {
    param([string]$Name, [hashtable]$Case, [string]$Message, [hashtable]$Options = @{})
    $caught = $null
    try { Invoke-Case -Case $Case @Options | Out-Null } catch { $caught = $_.Exception.Message }
    Assert-Case $Name ($null -ne $caught -and $caught -like "*$Message*" -and
        $global:netariumUninstallState.Operations.Count -eq 0 -and
        (Microsoft.PowerShell.Management\Test-Path -LiteralPath $Case.Config) -and
        (Microsoft.PowerShell.Management\Test-Path -LiteralPath (Join-Path $Case.Install 'public/index.php')) -and
        (Microsoft.PowerShell.Management\Test-Path -LiteralPath (Join-Path $Case.Install 'data/private.db')) -and
        (Microsoft.PowerShell.Management\Test-Path -LiteralPath (Join-Path $Case.Snapshot 'snapshot.keep')))
}

function Add-CaseProfiles {
    $profile = [pscustomobject]@{
        SID = 'S-1-5-82-1361224279-997977655-3500212106-1233922396-1472451381'
        LocalPath = 'C:\Users\NetariumUninstallPool.old'; Loaded = $false; Special = $false
    }
    $foreign = [pscustomobject]@{
        SID = 'S-1-5-21-1-2-3-1001'
        LocalPath = 'C:\Users\NetariumUninstallPool'; Loaded = $false; Special = $false
    }
    $global:netariumUninstallState.Profiles = @($profile, $foreign)
    return $profile
}

try {
    [void][IO.Directory]::CreateDirectory($sandbox)
    $release = Join-Path $sandbox 'release'
    [void][IO.Directory]::CreateDirectory($release)
    $fixtureScript = Join-Path $release 'uninstall-iis.ps1'
    [IO.File]::Copy($sourceCommon, (Join-Path $release 'deployment-common.ps1'))
    $source = [IO.File]::ReadAllText($sourceScript)
    $commonInclude = ". (Join-Path `$PSScriptRoot 'deployment-common.ps1')"
    if (-not $source.Contains($commonInclude)) { throw 'Cannot insert IIS test doubles after the common preflight definitions.' }
    [IO.File]::WriteAllText($fixtureScript, $source.Replace($commonInclude, $commonInclude + [Environment]::NewLine + $mockCommands))

    # Stop at the admin preflight after the real entry point resolves its targets.
    $inputScript = Join-Path $release 'uninstall-input.ps1'
    $inputMock = @'
function Assert-Administrator {
    $global:netariumInputCaptured = [pscustomobject]@{
        Root = (Get-Variable Root -Scope 1).Value
        Rollback = (Get-Variable Rollback -Scope 1).Value
        Name = (Get-Variable Name -Scope 1).Value
        Pool = (Get-Variable Pool -Scope 1).Value
    }
    throw 'Input targets captured before IIS access.'
}
function Read-Host {
    param([string]$Prompt)
    $global:netariumInputPrompts.Add($Prompt)
    return $global:netariumInputAnswers.Dequeue()
}
'@
    [IO.File]::WriteAllText($inputScript, $source.Replace($commonInclude, $commonInclude + [Environment]::NewLine + $inputMock))
    function Invoke-InputCase {
        param([hashtable]$Parameters = @{})
        $global:netariumInputCaptured = $null
        $caught = $null
        try { & $inputScript @Parameters | Out-Null } catch { $caught = $_.Exception.Message }
        if ($caught -ne 'Input targets captured before IIS access.' -or $null -eq $global:netariumInputCaptured) {
            throw "Uninstall did not reach the safe input preflight: $caught"
        }
        return $global:netariumInputCaptured
    }
    $global:netariumInputAnswers = New-Object 'System.Collections.Generic.Queue[string]'
    $global:netariumInputPrompts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($answer in @('', '', '')) { $global:netariumInputAnswers.Enqueue($answer) }
    $inputResult = Invoke-InputCase
    Assert-Case 'Enter selects the standard installation, site, pool and derived rollback path' (
        $inputResult.Root -eq 'C:\Netarium\app' -and
        $inputResult.Name -eq 'Netarium' -and $inputResult.Pool -eq 'Netarium' -and
        $inputResult.Rollback -eq 'C:\Netarium\app-rollback' -and
        ($global:netariumInputPrompts -join '|') -eq 'InstallRoot [C:\Netarium\app]|SiteName [Netarium]|ApplicationPoolName [Netarium]')

    $global:netariumInputPrompts.Clear()
    $global:netariumInputAnswers.Enqueue('CustomPool')
    $inputResult = Invoke-InputCase -Parameters @{ InstallRoot = 'C:\Custom\app'; SiteName = 'CustomSite' }
    Assert-Case 'Explicit installation and site override defaults; pool prompt accepts a custom name' (
        $inputResult.Root -eq 'C:\Custom\app' -and $inputResult.Name -eq 'CustomSite' -and
        $inputResult.Pool -eq 'CustomPool' -and $inputResult.Rollback -eq 'C:\Custom\app-rollback' -and
        ($global:netariumInputPrompts -join '|') -eq 'ApplicationPoolName [CustomSite]')

    $global:netariumInputPrompts.Clear()
    $inputResult = Invoke-InputCase -Parameters @{
        InstallRoot = 'C:\Custom\app'; SiteName = 'CustomSite'
        ApplicationPoolName = 'ExplicitPool'; RollbackRoot = 'C:\Snapshots'; NonInteractive = $true
    }
    Assert-Case 'NonInteractive uses every explicit target without prompting' (
        $inputResult.Root -eq 'C:\Custom\app' -and $inputResult.Name -eq 'CustomSite' -and
        $inputResult.Pool -eq 'ExplicitPool' -and $inputResult.Rollback -eq 'C:\Snapshots' -and
        $global:netariumInputPrompts.Count -eq 0)
    $global:netariumInputPrompts.Clear()
    $global:netariumInputAnswers.Enqueue('Valid-Site')
    $global:netariumInputAnswers.Enqueue('')
    $inputResult = Invoke-InputCase -Parameters @{ InstallRoot = 'C:\Custom\app' }
    Assert-Case 'Custom site input is accepted and becomes the pool default' (
        $inputResult.Name -eq 'Valid-Site' -and $inputResult.Pool -eq 'Valid-Site' -and
        ($global:netariumInputPrompts -join '|') -eq 'SiteName [Netarium]|ApplicationPoolName [Valid-Site]')

    foreach ($invalid in @(
        @{ Name = 'SiteName'; Parameters = @{ InstallRoot = 'C:\Custom\app'; ApplicationPoolName = 'ValidPool' } },
        @{ Name = 'ApplicationPoolName'; Parameters = @{ InstallRoot = 'C:\Custom\app'; SiteName = 'ValidSite' } }
    )) {
        $global:netariumInputPrompts.Clear()
        $global:netariumInputAnswers.Enqueue('Invalid/Name')
        $global:netariumInputCaptured = $null
        $caught = $null
        $arguments = $invalid.Parameters
        try { & $inputScript @arguments | Out-Null } catch { $caught = $_.Exception.Message }
        Assert-Case "Invalid interactive $($invalid.Name) is rejected before IIS access" (
            $caught -like '*Invalid/Name*' -and $caught -like "*$($invalid.Name)*" -and
            $null -eq $global:netariumInputCaptured -and
            $global:netariumInputPrompts.Count -eq 1)
    }
    $global:netariumInputPrompts.Clear()
    $global:netariumInputCaptured = $null
    $caught = $null
    try {
        & $inputScript -InstallRoot 'C:\Custom\app' -SiteName 'Invalid/Name' -ApplicationPoolName ValidPool | Out-Null
    } catch { $caught = $_.Exception.Message }
    Assert-Case 'Invalid explicit site name is rejected before prompting or IIS access' (
        $caught -like '*Invalid/Name*' -and $caught -like '*SiteName*' -and
        $null -eq $global:netariumInputCaptured -and $global:netariumInputPrompts.Count -eq 0)
    $global:netariumInputPrompts.Clear()
    foreach ($missing in @(
        @{ Parameters = @{ NonInteractive = $true }; Name = 'InstallRoot' },
        @{ Parameters = @{ InstallRoot = 'C:\Custom\app'; NonInteractive = $true }; Name = 'SiteName' },
        @{ Parameters = @{ InstallRoot = 'C:\Custom\app'; SiteName = 'CustomSite'; NonInteractive = $true }; Name = 'ApplicationPoolName' }
    )) {
        $caught = $null
        $arguments = $missing.Parameters
        try { & $inputScript @arguments | Out-Null } catch { $caught = $_.Exception.Message }
        Assert-Case "NonInteractive rejects missing $($missing.Name) without prompting" (
            $caught -like "*Missing required deployment parameter: -$($missing.Name)*" -and
            $global:netariumInputPrompts.Count -eq 0)
    }

    Write-Host '=== Uninstall script behavior (isolated IIS and filesystem fixtures) ===' -ForegroundColor Cyan
    $case = New-Case 'dedicated'
    Invoke-Case $case -PhpCgiPath $global:netariumUninstallState.Cgi
    Assert-Case 'Dedicated site, location, pool and FastCGI are removed in order' (($global:netariumUninstallState.Operations -join '|') -eq 'stop-site|remove-cgi|remove-location|remove-site|stop-pool|remove-pool')
    Assert-Case 'Only program is removed; data, config, snapshots and unmanaged files remain' (
        -not (Test-Path -LiteralPath (Join-Path $case.Install 'public')) -and
        -not (Test-Path -LiteralPath (Join-Path $case.Install 'bootstrap.php')) -and
        (Test-Path -LiteralPath (Join-Path $case.Install 'data/private.db')) -and
        (Test-Path -LiteralPath $case.Config) -and
        (Test-Path -LiteralPath (Join-Path $case.Snapshot 'snapshot.keep')) -and
        (Test-Path -LiteralPath (Join-Path $case.Install 'unmanaged.keep')) -and
        $global:netariumUninstallState.Prompts -eq 0)
    $global:netariumUninstallState.Operations.Clear()
    Invoke-Case $case
    Assert-Case 'Re-running after program removal is harmless' ($global:netariumUninstallState.Operations.Count -eq 0)
    Invoke-Case $case -RemoveData -NonInteractive -Force
    Assert-Case 'RemoveData after normal uninstall deletes retained data, config and snapshots only' (
        -not (Test-Path -LiteralPath (Join-Path $case.Install 'data')) -and
        -not (Test-Path -LiteralPath $case.Config) -and
        -not (Test-Path -LiteralPath $case.Rollback) -and
        (Test-Path -LiteralPath (Join-Path $case.Install 'unmanaged.keep')) -and
        $global:netariumUninstallState.Operations.Count -eq 0)

    $case = New-Case 'shared-cgi'
    $other = [pscustomobject]@{ Name = 'OtherSite'; PhysicalPath = (Join-Path $sandbox 'other-site'); ApplicationPool = 'OtherPool' }
    $global:netariumUninstallState.Sites += $other
    $global:netariumUninstallState.Applications = @([pscustomobject]@{ Site = 'OtherSite'; Path = '/blog'; ApplicationPool = 'BlogPool' })
    $global:netariumUninstallState.Handlers['IIS:\Sites\OtherSite\blog'] = @([pscustomobject]@{ name = 'PHP'; path = '*.php'; modules = 'FastCgiModule'; scriptProcessor = $global:netariumUninstallState.Cgi })
    Invoke-Case $case
    Assert-Case 'Another application using PHP retains its shared FastCGI mapping' (
        $global:netariumUninstallState.FastCgi.Count -eq 1 -and
        $global:netariumUninstallState.Sites.Count -eq 1 -and
        $global:netariumUninstallState.Sites[0].Name -eq 'OtherSite' -and
        $global:netariumUninstallState.PoolExists -eq $false)

    $case = New-Case 'shared-global-cgi'
    $global:netariumUninstallState.Handlers['MACHINE/WEBROOT/APPHOST'] = @([pscustomobject]@{
        name = 'GlobalPHP'; path = '*.php'; modules = 'FastCgiModule'; scriptProcessor = $global:netariumUninstallState.Cgi
    })
    Invoke-Case $case
    Assert-Case 'Global PHP handler retains shared FastCGI mapping' ($global:netariumUninstallState.FastCgi.Count -eq 1)

    $case = New-Case 'foreign-handler'
    $global:netariumUninstallState.Handlers["IIS:\Sites\$($global:netariumUninstallState.SiteName)"][0].name = 'ExistingPHP'
    Invoke-Case $case
    Assert-Case 'Pre-existing PHP handler never transfers FastCGI ownership' ($global:netariumUninstallState.FastCgi.Count -eq 1)

    $case = New-Case 'delete-confirmed'
    $global:netariumUninstallState.Answer = 'REMOVE'
    Invoke-Case $case -RemoveData
    Assert-Case 'Explicit REMOVE deletes data, config and owned snapshots without a Force flag' (
        $global:netariumUninstallState.Prompts -eq 1 -and
        -not (Test-Path -LiteralPath (Join-Path $case.Install 'data')) -and
        -not (Test-Path -LiteralPath $case.Config) -and
        -not (Test-Path -LiteralPath $case.Rollback) -and
        (Test-Path -LiteralPath (Join-Path $case.Install 'unmanaged.keep')))

    $global:netariumUninstallState.Operations.Clear()
    Invoke-Case $case -RemoveData -NonInteractive -Force
    Assert-Case 'Complete uninstall may be repeated without touching unrelated files' (
        $global:netariumUninstallState.Operations.Count -eq 0 -and
        (Test-Path -LiteralPath (Join-Path $case.Install 'unmanaged.keep')))

    $case = New-Case 'force-interactive'
    $global:netariumUninstallState.Answer = 'wrong'
    Assert-Rejected 'Force alone does not bypass interactive data confirmation' $case 'not confirmed' @{ RemoveData = $true; Force = $true }
    Assert-Case 'Interactive Force still prompts' ($global:netariumUninstallState.Prompts -eq 1)

    $case = New-Case 'delete-unattended'
    Assert-Rejected 'NonInteractive RemoveData refuses to delete without Force' $case 'requires -Force' @{ RemoveData = $true; NonInteractive = $true }
    $global:netariumUninstallState.Answer = 'wrong'
    Assert-Rejected 'Incorrect interactive confirmation preserves all resources' $case 'not confirmed' @{ RemoveData = $true }
    Invoke-Case $case -RemoveData -NonInteractive -Force
    Assert-Case 'NonInteractive Force deletes owned data without prompting' ($global:netariumUninstallState.Prompts -eq 1 -and -not (Test-Path -LiteralPath $case.Rollback) -and -not (Test-Path -LiteralPath $case.Config))

    $case = New-Case 'whatif'
    Invoke-Case $case -RemoveData -NonInteractive -WhatIf
    Assert-Case 'WhatIf has no IIS or filesystem side effects and never prompts' (
        $global:netariumUninstallState.Operations.Count -eq 0 -and
        $global:netariumUninstallState.Prompts -eq 0 -and
        $global:netariumUninstallState.PoolExists -and
        (Test-Path -LiteralPath (Join-Path $case.Install 'public/index.php')) -and
        (Test-Path -LiteralPath (Join-Path $case.Install 'data/private.db')) -and
        (Test-Path -LiteralPath (Join-Path $case.Snapshot 'snapshot.keep')))

    $case = New-Case 'partial'
    $global:netariumUninstallState.Sites = @()
    $global:netariumUninstallState.PoolRunning = $false
    Invoke-Case $case
    Assert-Case 'Site already gone: owned location removed but unverified pool retained' (
        ($global:netariumUninstallState.Operations -join '|') -eq 'remove-location' -and
        $global:netariumUninstallState.PoolExists -and
        -not (Test-Path -LiteralPath (Join-Path $case.Install 'public')))
    $global:netariumUninstallState.Operations.Clear()
    Invoke-Case $case
    Assert-Case 'Repeated partial uninstall never deletes the unverified pool' (
        $global:netariumUninstallState.Operations.Count -eq 0 -and $global:netariumUninstallState.PoolExists)

    $case = New-Case 'foreign-unassigned-pool'
    $global:netariumUninstallState.Sites = @()
    $global:netariumUninstallState.LocationExists = $false
    Invoke-Case $case
    Assert-Case 'An unrelated unassigned pool is retained when no site proves ownership' (
        $global:netariumUninstallState.PoolExists -and
        @($global:netariumUninstallState.Operations | Where-Object { $_ -eq 'remove-pool' }).Count -eq 0)

    $case = New-Case 'cgi-removal-failure'
    $global:netariumUninstallState.FailCgiOnce = $true
    $caught = $null
    try { Invoke-Case $case | Out-Null } catch { $caught = $_.Exception.Message }
    Assert-Case 'FastCGI removal failure preserves the site and its handler evidence' (
        $caught -like '*Injected FastCGI removal failure*' -and
        $global:netariumUninstallState.Sites.Count -eq 1 -and
        $global:netariumUninstallState.LocationExists -and
        $global:netariumUninstallState.FastCgi.Count -eq 1)
    Invoke-Case $case
    Assert-Case 'Retry removes the dedicated FastCGI mapping' (
        $global:netariumUninstallState.FastCgi.Count -eq 0 -and
        $global:netariumUninstallState.Sites.Count -eq 0)

    $case = New-Case 'pool-removal-failure'
    $global:netariumUninstallState.FailPoolOnce = $true
    $caught = $null
    try { Invoke-Case $case | Out-Null } catch { $caught = $_.Exception.Message }
    Assert-Case 'Pool removal failure leaves no dedicated FastCGI mapping behind' (
        $caught -like '*Injected pool removal failure*' -and
        $global:netariumUninstallState.Sites.Count -eq 0 -and
        $global:netariumUninstallState.PoolExists -and
        $global:netariumUninstallState.FastCgi.Count -eq 0)
    $global:netariumUninstallState.Operations.Clear()
    Invoke-Case $case
    Assert-Case 'Retry retains the unverified pool without restoring the FastCGI mapping' (
        $global:netariumUninstallState.PoolExists -and
        $global:netariumUninstallState.FastCgi.Count -eq 0 -and
        @($global:netariumUninstallState.Operations | Where-Object { $_ -eq 'remove-pool' }).Count -eq 0)

    $case = New-Case 'site-ownership'
    $global:netariumUninstallState.Sites[0].PhysicalPath = (Join-Path $sandbox 'foreign-site')
    Assert-Rejected 'Foreign IIS site physical path is refused' $case 'does not match'
    $case = New-Case 'parent-directory'
    $caught = $null
    try {
        & $fixtureScript -InstallRoot $case.Parent -RollbackRoot (Join-Path $sandbox 'other-rollback') `
            -SiteName $global:netariumUninstallState.SiteName `
            -ApplicationPoolName $global:netariumUninstallState.PoolName | Out-Null
    } catch { $caught = $_.Exception.Message }
    Assert-Case 'Parent directory cannot replace the deployed app root' (
        $caught -like '*IIS site physical path or application pool does not match*' -and
        $global:netariumUninstallState.Operations.Count -eq 0 -and
        (Test-Path -LiteralPath (Join-Path $case.Install 'public/index.php')) -and
        (Test-Path -LiteralPath (Join-Path $case.Install 'data/private.db')))
    $case = New-Case 'config-ownership'
    [IO.File]::WriteAllText($case.Config, "<?php return 'another-storage';")
    Assert-Rejected 'Foreign config storage is refused' $case 'does not point'
    $case = New-Case 'site-application'
    $global:netariumUninstallState.Applications = @([pscustomobject]@{
        Site = $global:netariumUninstallState.SiteName; Path = '/foreign'; ApplicationPool = 'ForeignPool'
    })
    Assert-Rejected 'Site with additional IIS application is refused' $case 'additional IIS applications'
    $case = New-Case 'cgi-ownership'
    Assert-Rejected 'Different requested PHP CGI path is refused' $case 'does not match PhpCgiPath' @{ PhpCgiPath = (Join-Path $sandbox 'other-php-cgi.exe') }
    $case = New-Case 'pool-shared-site'
    $global:netariumUninstallState.Sites += [pscustomobject]@{ Name = 'OtherSite'; PhysicalPath = (Join-Path $sandbox 'other'); ApplicationPool = $global:netariumUninstallState.PoolName }
    Assert-Rejected 'Another site sharing this pool blocks uninstall' $case 'Another IIS site uses application pool'
    $case = New-Case 'pool-shared-application'
    $global:netariumUninstallState.Sites += [pscustomobject]@{ Name = 'OtherSite'; PhysicalPath = (Join-Path $sandbox 'other'); ApplicationPool = 'OtherPool' }
    $global:netariumUninstallState.Applications = @([pscustomobject]@{ Site = 'OtherSite'; Path = '/app'; ApplicationPool = $global:netariumUninstallState.PoolName })
    Assert-Rejected 'Another application sharing this pool blocks uninstall' $case 'Another IIS application uses application pool'
    $case = New-Case 'location-ownership'
    $global:netariumUninstallState.Sites = @()
    $global:netariumUninstallState.LocationHandlers = @()
    Assert-Rejected 'Location without Netarium ownership is refused' $case 'Cannot prove ownership'
    $case = New-Case 'snapshot-ownership'
    $manifestPath = Join-Path $case.Snapshot 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.TargetPath = Join-Path $sandbox 'another-install'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json))
    Assert-Rejected 'Another installation snapshot blocks RemoveData' $case 'does not belong' @{ RemoveData = $true; Force = $true }
    $case = New-Case 'unknown-rollback'
    [IO.File]::WriteAllText((Join-Path $case.Rollback 'foreign.txt'), 'foreign')
    Assert-Rejected 'Unknown rollback content blocks RemoveData' $case 'unrecognized item' @{ RemoveData = $true; Force = $true }
    $case = New-Case 'symlink'
    $outside = Join-Path $case.Parent 'outside'
    [void][IO.Directory]::CreateDirectory($outside)
    [IO.File]::WriteAllText((Join-Path $outside 'external.keep'), 'safe')
    $junction = Join-Path $case.Install 'src/link'
    New-Item -ItemType Junction -Path $junction -Target $outside -ErrorAction Stop | Out-Null
    Assert-Rejected 'Reparse point inside program tree blocks all deletions' $case 'reparse point'
    Assert-Case 'External junction target remains untouched' (Test-Path -LiteralPath (Join-Path $outside 'external.keep'))
    [IO.Directory]::Delete($junction)

    $case = New-Case 'profile-retained'
    $profile = Add-CaseProfiles
    Invoke-Case $case
    Assert-Case 'Normal uninstall preserves virtual and ordinary user profiles' (
        $global:netariumUninstallState.Profiles.Count -eq 2)
    Invoke-Case $case -RemoveData -NonInteractive -WhatIf
    Assert-Case 'RemoveData WhatIf preserves the orphaned profile and retained data' (
        $global:netariumUninstallState.Profiles.Count -eq 2 -and (Test-Path -LiteralPath $case.Config))
    Invoke-Case $case -RemoveData -NonInteractive -Force
    Assert-Case 'RemoveData after normal uninstall removes only the exact virtual SID, not a matching folder name' (
        $global:netariumUninstallState.Profiles.Count -eq 1 -and
        $global:netariumUninstallState.Profiles[0].SID -eq 'S-1-5-21-1-2-3-1001' -and
        -not (Test-Path -LiteralPath $case.Config))

    $case = New-Case 'profile-direct'
    $profile = Add-CaseProfiles
    Invoke-Case $case -RemoveData -NonInteractive -Force
    Assert-Case 'Direct RemoveData removes the pool before deleting its virtual profile' (
        -not $global:netariumUninstallState.PoolExists -and
        $global:netariumUninstallState.Profiles.Count -eq 1)

    $case = New-Case 'profile-loaded'
    $profile = Add-CaseProfiles
    $profile.Loaded = $true
    $caught = $null
    try { Invoke-Case $case -RemoveData -NonInteractive -Force } catch { $caught = $_.Exception.Message }
    Assert-Case 'Loaded profile blocks profile and data deletion, preserving ownership for retry' (
        $caught -like '*still loaded or special*' -and
        $global:netariumUninstallState.Profiles.Count -eq 2 -and
        (Test-Path -LiteralPath $case.Config) -and
        (Test-Path -LiteralPath (Join-Path $case.Install 'data/private.db')))
    $profile.Loaded = $false
    Invoke-Case $case -RemoveData -NonInteractive -Force
    Assert-Case 'Retry after profile unload removes the orphaned profile and retained data' (
        $global:netariumUninstallState.Profiles.Count -eq 1 -and -not (Test-Path -LiteralPath $case.Config))

    $case = New-Case 'profile-special'
    $profile = Add-CaseProfiles
    $profile.Special = $true
    Assert-Rejected 'Special profile blocks destructive operations' $case 'special user profile' @{ RemoveData = $true; NonInteractive = $true; Force = $true }

    $case = New-Case 'profile-unverified'
    $profile = Add-CaseProfiles
    $global:netariumUninstallState.Sites = @()
    $global:netariumUninstallState.LocationExists = $false
    Invoke-Case $case -RemoveData -NonInteractive -Force
    Assert-Case 'Unverified remaining pool and its profile are retained' (
        $global:netariumUninstallState.PoolExists -and $global:netariumUninstallState.Profiles.Count -eq 2)

    $case = New-Case 'profile-shared-orphan'
    $profile = Add-CaseProfiles
    $global:netariumUninstallState.Sites = @([pscustomobject]@{
        Name = 'OtherSite'; PhysicalPath = (Join-Path $sandbox 'other')
        ApplicationPool = $global:netariumUninstallState.PoolName
    })
    $global:netariumUninstallState.PoolExists = $false
    $global:netariumUninstallState.LocationExists = $false
    Assert-Rejected 'Another site referencing the absent pool blocks orphan profile cleanup' $case 'Another IIS site uses application pool' @{ RemoveData = $true; NonInteractive = $true; Force = $true }
    Write-Host 'All uninstall behavior checks passed.' -ForegroundColor Green
} finally {
    if ($previousState) {
        Set-Variable -Name netariumUninstallState -Scope Global -Value $previousState.Value
    } else {
        Remove-Variable -Name netariumUninstallState -Scope Global -ErrorAction SilentlyContinue
    }
    if ([IO.Directory]::Exists($sandbox)) {
        # Never recurse through a test junction if an assertion failed before it was removed.
        $pendingJunction = Join-Path $sandbox 'symlink/install/src/link'
        if ([IO.Directory]::Exists($pendingJunction)) { [IO.Directory]::Delete($pendingJunction) }
        Remove-Item -LiteralPath $sandbox -Recurse -Force
    }
}
