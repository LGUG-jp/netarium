[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repoRoot 'scripts/full-backup-common.ps1')
. (Join-Path $PSScriptRoot 'maintenance-fixture.ps1')
# These tests substitute only OS/IIS/HTTP boundaries, not the ownership or orchestration functions.
function Assert-Administrator {}
function Assert-WebAdministration {}
function New-NetariumPrivateDirectory { param($Path) New-Item -ItemType Directory -Path $Path -Force | Out-Null }
function Assert-True { param($Condition, $Message) if (-not $Condition) { throw $Message } }
function Assert-Fails { param([scriptblock]$Action, [string]$Pattern) $failure = $null; try { & $Action } catch { $failure = $_.Exception.Message }; if (-not $failure -or $failure -notlike $Pattern) { throw "Expected $Pattern; got $failure" } }
$script:siteState = 'Started'; $script:poolState = 'Started'
function Get-WebSiteState { param($Name) [pscustomobject]@{ Value = $script:siteState } }
function Get-WebAppPoolState { param($Name) [pscustomobject]@{ Value = $script:poolState } }
function Stop-NetariumSiteIfRunning { param($SiteName) $script:siteState = 'Stopped'; $script:maintenanceEvents += 'stop-site' }
function Stop-NetariumAppPoolIfRunning { param($ApplicationPoolName) $script:poolState = 'Stopped'; $script:maintenanceEvents += 'stop-pool' }
function Start-Website { param($Name, $ErrorAction) $script:siteState = 'Started'; $script:maintenanceEvents += 'start-site' }
function Start-WebAppPool { param($Name, $ErrorAction) $script:poolState = 'Started'; $script:maintenanceEvents += 'start-pool' }
$script:recoveryReassigned = $false; $script:recoveryShared = $false
function Get-Website {
    param($Name, $ErrorAction)
    $physical = if ($script:recoveryReassigned) { Join-Path $script:maintenanceFixtureRoot 'another-app' } else { $public }
    [pscustomobject]@{ Name = 'TestSite'; PhysicalPath = $physical; ApplicationPool = 'TestPool'; Bindings = [pscustomobject]@{ Collection = @([pscustomobject]@{ protocol = 'http'; bindingInformation = '127.0.0.1:49249:' }) } }
    if (-not $Name -and $script:recoveryShared) { [pscustomobject]@{ Name = 'OtherSite'; PhysicalPath = $physical; ApplicationPool = 'TestPool' } }
}
$script:nestedApplication = $false
function Get-WebApplication {
    param($Site, $ErrorAction)
    if ($script:nestedApplication -and $Site -eq 'TestSite') { [pscustomobject]@{ ApplicationPool = 'TestPool' } }
}
$script:drainFailure = $false; $script:gateFailure = $false
function Get-WebRequest { param($AppPool, $ErrorAction) $script:maintenanceEvents += 'drain'; if ($script:drainFailure) { throw 'drain failure' }; return @() }
function Invoke-FullWorker { param($Worker, $Request) if ($Request.command -eq 'lock') { $script:maintenanceEvents += 'gate'; if ($script:gateFailure) { throw 'gate busy' } } }
$public = Join-Path $script:maintenanceFixtureRoot 'public'
New-Item -ItemType Directory -Path $public | Out-Null
$lock = $null
try {
    # A genuine second process cannot acquire the common FileShare.None ownership stream.
    $lock = Enter-NetariumMaintenanceLock $repoRoot
    $common = (Join-Path $repoRoot 'scripts/deployment-common.ps1').Replace("'", "''")
    $directory = $script:maintenanceFixtureRoot.Replace("'", "''")
    $childCode = @'
. '__COMMON__'
function Assert-Administrator {}
function New-NetariumPrivateDirectory { param($Path) }
function Get-NetariumMaintenancePaths { param($InstallRoot) return [pscustomobject]@{ Directory = '__DIRECTORY__'; Lock = '__DIRECTORY__\owner.lock'; Journal = '__DIRECTORY__\journal.json' } }
try { $owner = Enter-NetariumMaintenanceLock 'same-install'; $owner.Stream.Dispose(); exit 19 } catch { if ($_.Exception.Message -like 'Another maintenance CLI*') { exit 0 }; exit 20 }
'@
    $childCode = $childCode.Replace('__COMMON__', $common).Replace('__DIRECTORY__', $directory)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Process -Id $PID).Path
    $info.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCode))
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $child = [Diagnostics.Process]::Start($info)
    try { if (-not $child.WaitForExit(15000)) { $child.Kill(); throw 'Lock child timed out' }; Assert-True ($child.ExitCode -eq 0) 'Another process acquired a live ownership lock' } finally { $child.Dispose() }
    $lock.Stream.Dispose(); $lock = $null
    # Every initial state must reject nested boundaries before installing any configuration.
    foreach ($initialSite in @('Started','Stopped')) { foreach ($initialPool in @('Started','Stopped')) {
        $script:siteState = $initialSite; $script:poolState = $initialPool
        $script:nestedApplication = $true; $script:maintenanceEvents = @()
        $lock = Enter-NetariumMaintenanceLock $repoRoot
        Assert-Fails { Set-NetariumMaintenance 'TestSite' $public 'TestPool' $lock } '*additional application boundary*'
        Assert-True ($script:maintenanceEvents.Count -eq 0) 'Unsupported boundary changed configuration or stopped a resource'
        Assert-True (-not (Test-Path -LiteralPath $lock.Paths.Journal)) 'Unsupported boundary installed an ownership journal'
        $lock.Stream.Dispose(); $lock = $null
    } }
    $script:nestedApplication = $false

    # Exact local configuration, including inherited absence, collection order and 404.13, returns unchanged.
    foreach ($original in @('<configuration />', '<configuration><location path="TestSite"><system.webServer><security><requestFiltering><requestLimits maxAllowedContentLength="32505856" /><fileExtensions><clear /><add fileExtension=".txt" allowed="true" /><add fileExtension=".php" allowed="true" /></fileExtensions></requestFiltering></security><httpErrors existingResponse="PassThrough"><remove statusCode="404" subStatusCode="13" /><error statusCode="404" subStatusCode="13" path="existing.json" responseMode="File" /></httpErrors><httpProtocol><customHeaders><clear /><add name="X-Keep" value="original" /></customHeaders></httpProtocol></system.webServer></location></configuration>')) {
        foreach ($initialSite in @('Started','Stopped')) { foreach ($initialPool in @('Started','Stopped')) {
            $script:maintenanceConfigurationXml = $original
            $script:siteState = $initialSite; $script:poolState = $initialPool; $script:maintenanceEvents = @()
            $lock = Enter-NetariumMaintenanceLock $repoRoot
            $m = Set-NetariumMaintenance 'TestSite' $public 'TestPool' $lock
            Assert-True ($m.OperationId -cne $m.Token) 'Public operation ID exposed ownership token'
            Assert-True ([IO.File]::ReadAllText($m.JournalPath) -notlike '*original*') 'Journal stored configuration plaintext'
            Wait-NetariumMaintenanceReady $m @('http://127.0.0.1:49249/')
            $probeCount = @($script:maintenanceEvents | Where-Object { $_ -eq 'probe' }).Count
            Assert-True (($probeCount -eq 2) -eq ($initialSite -eq 'Started' -and $initialPool -eq 'Started')) 'Stopped resources were probed/started'
            Complete-NetariumMaintenance $m
            Assert-True ($script:siteState -eq $initialSite -and $script:poolState -eq $initialPool) 'Initial site/pool state changed'
            $restored = Get-NetariumMaintenanceConfiguration
            $location = Get-NetariumMaintenanceLocation $restored.Xml 'TestSite'
            foreach ($record in $m.Sections) {
                $node = if ($location) { Get-NetariumMaintenanceNode $location $record.Path } else { $null }
                $text = if ($node) { $node.OuterXml } else { $null }
                Assert-True ($text -ceq $record.Original) "Original local/inherited section was not restored: $($record.Path)"
            }
            $lock.Stream.Dispose(); $lock = $null
        } }
    }

    # Shared protocol order and no stop/mutation boundary on drain or gate failure.
    foreach ($failure in @('none','drain','gate')) {
        $script:siteState = 'Started'; $script:poolState = 'Started'; $script:maintenanceEvents = @()
        $script:maintenanceConfigurationXml = '<configuration />'
        $script:drainFailure = $failure -eq 'drain'; $script:gateFailure = $failure -eq 'gate'
        $lock = Enter-NetariumMaintenanceLock $repoRoot
        $context = [pscustomobject]@{ State = [pscustomobject]@{ SiteName = 'TestSite'; ApplicationPoolName = 'TestPool'; Site = [pscustomobject]@{ PhysicalPath = $public } }; Maintenance = $null }
        if ($failure -eq 'none') {
            Stop-FullSite $context $null $lock @('http://127.0.0.1:49249/')
            Assert-True (($script:maintenanceEvents -join '|') -eq 'commit|probe|probe|drain|gate|stop-site|stop-pool') 'Maintenance/drain/gate/stop ordering changed'
        } else {
            Assert-Fails { Stop-FullSite $context $null $lock @('http://127.0.0.1:49249/') } '*'
            Assert-True ($script:siteState -eq 'Started' -and $script:poolState -eq 'Started') 'Drain/gate failure crossed stop/mutation boundary'
        }
        Resume-FullSite $context
        if ($failure -ne 'none') {
            Assert-True (@($script:maintenanceEvents | Where-Object { $_ -like 'stop-*' }).Count -eq 0) 'Pre-mutation cleanup terminated existing requests'
        }
        $lock.Stream.Dispose(); $lock = $null
    }
    $script:drainFailure = $false; $script:gateFailure = $false

    # Real probe verifier rejects normal 404, missing cache policy, redirects and malformed/extra contract data.
    $lock = Enter-NetariumMaintenanceLock $repoRoot
    $m = Set-NetariumMaintenance 'TestSite' $public 'TestPool' $lock
    $realHttpFixture = (Get-Command Invoke-NetariumProbe).ScriptBlock
    $script:probeCase = 'valid'
    function Invoke-NetariumProbe {
        param($Url, [switch]$IncludeBody)
        $r = & $realHttpFixture -Url $Url -IncludeBody:$IncludeBody
        switch ($script:probeCase) {
            '404' { $r.Body = '<html>Not found</html>' }
            '503' { $r.StatusCode = 503 }
            'redirect' { $r.Location = '/netarium-maintenance.json' }
            'cache' { $r.Headers['Cache-Control'] = 'public' }
            'type' { $r.Headers['Content-Type'] = 'text/html' }
            'extra' { $r.Body = $r.Body.TrimEnd('}') + ',"extra":true}' }
            'version' { $r.Body = $r.Body.Replace('"contract_version":1', '"contract_version":2') }
            'operation' { $r.Body = $r.Body.Replace($m.OperationId, 'other-operation') }
        }
        return $r
    }
    Assert-NetariumMaintenanceProbe 'http://127.0.0.1:49249/' $m
    foreach ($case in @('404','503','redirect','cache','type','extra','version','operation')) {
        $script:probeCase = $case
        Assert-Fails { Assert-NetariumMaintenanceProbe 'http://127.0.0.1:49249/' $m } '*Strict maintenance contract*'
    }
    Assert-Fails { Wait-NetariumMaintenanceReady $m @('http://127.0.0.1:49249/') -TimeoutSeconds 0 } '*did not become effective*'
    $script:probeCase = 'valid'
    $script:maintenanceEvents = @()
    Complete-NetariumMaintenance $m
    Assert-True (@($script:maintenanceEvents | Where-Object { $_ -like 'stop-*' }).Count -eq 0) 'Probe timeout cleanup cut off pre-existing requests'
    Assert-True ($script:siteState -eq 'Started' -and $script:poolState -eq 'Started') 'Probe timeout cleanup changed running state'
    $m = Set-NetariumMaintenance 'TestSite' $public 'TestPool' $lock
    # Ownership conflicts preserve the third party's change and leave resources stopped.
    $installed = $script:maintenanceConfigurationXml
    $script:maintenanceConfigurationXml = $installed.Replace('no-store', 'private')
    Assert-Fails { Complete-NetariumMaintenance $m } '*ownership conflict*'
    Assert-True ($script:maintenanceConfigurationXml -like '*private*' -and $script:siteState -eq 'Stopped' -and $script:poolState -eq 'Stopped') 'Recovery overwrote another administrator or restarted on conflict'
    $script:maintenanceConfigurationXml = $installed
    [IO.File]::WriteAllText($m.OwnerPath, 'wrong-owner')
    Assert-Fails { Complete-NetariumMaintenance $m } '*token mismatch*'
    [IO.File]::WriteAllText($m.OwnerPath, $m.Token)
    $m.Phase = 'mutating'; Save-NetariumMaintenanceJournal $m
    $lock.Stream.Dispose(); $lock = $null
    $script:maintenanceEvents = @()
    $script:recoveryReassigned = $true
    Assert-Fails { Repair-NetariumMaintenance $script:maintenanceFixtureRoot -DataSafetyConfirmed } '*target was reassigned*'
    Assert-True (@($script:maintenanceEvents | Where-Object { $_ -like 'stop-*' }).Count -eq 0) 'Recovery stopped a reassigned application'
    $script:recoveryReassigned = $false; $script:recoveryShared = $true
    Assert-Fails { Repair-NetariumMaintenance $script:maintenanceFixtureRoot -DataSafetyConfirmed } '*pool is shared*'
    Assert-True (@($script:maintenanceEvents | Where-Object { $_ -like 'stop-*' }).Count -eq 0) 'Recovery stopped another site sharing the pool'
    $script:recoveryShared = $false
    Assert-Fails { Repair-NetariumMaintenance $script:maintenanceFixtureRoot } '*Data mutation was interrupted*'
    Repair-NetariumMaintenance $script:maintenanceFixtureRoot -DataSafetyConfirmed
    Assert-True (-not (Test-Path -LiteralPath $m.JournalPath)) 'Administrator recovery left unfinished ownership journal'
    Write-Host 'PASS: maintenance ownership, state restoration, strict probes, order and recovery'
} finally {
    if ($lock) { $lock.Stream.Dispose() }
    Remove-Item -LiteralPath $script:maintenanceFixtureRoot -Recurse -Force
}
