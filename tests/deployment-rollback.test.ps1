[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/deployment-common.ps1')
$updateScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/update.ps1'
$updateAst = [System.Management.Automation.Language.Parser]::ParseFile($updateScript, [ref]$null, [ref]$null)
foreach ($fn in $updateAst.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($fn.Name -in @('Copy-NetariumUpdateManifest', 'Replace-NetariumProgramManifest')) {
        Invoke-Expression $fn.Extent.Text
    }
}

# Resolve only the synthetic IIS identity; exercise the actual Windows filesystem DACL.
$poolSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-82-123')
$sitePoolSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-82-999')
function New-Object {
    param([string]$TypeName, [object[]]$ArgumentList)
    if ($TypeName -eq 'System.Security.AccessControl.FileSystemAccessRule' -and $ArgumentList[0] -eq 'IIS AppPool\NetariumSiteAssignedPool') {
        $ArgumentList[0] = $sitePoolSid
    } elseif ($TypeName -eq 'System.Security.AccessControl.FileSystemAccessRule' -and $ArgumentList[0] -like 'IIS AppPool\*') {
        $ArgumentList[0] = $poolSid
    }
    Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList
}
# IIS が使えない開発端末でも、サイト・プール・FastCGI の状態遷移を確認する。
$script:siteExists = $false
$script:siteLocationExists = $false
$script:poolExists = $false
$script:siteRunning = $false
$script:poolRunning = $false
$script:fastCgiExists = $false
$script:fastCgiActivityTimeout = 300
$script:fastCgiRequestTimeout = 300
$script:fastCgiInstanceMaxRequests = 1000
$script:fastCgiEnvironmentVariables = @()
$script:defaultDocuments = @()
$script:defaultDocumentEnabled = $true
$script:phpFilters = @()
$script:configurationMutations = @()
$script:siteSettingsRestored = 0
$script:poolSettingsRestored = 0
$script:rollbackOperations = @()
$script:siteName = 'NetariumRollbackTest'
$script:poolName = 'NetariumRollbackTest'
$script:phpCgiPath = 'C:\php\php-cgi.exe'

function Assert-WebAdministration {}
function Test-Path {
    param([string]$LiteralPath, [string]$Path, [string]$PathType)
    $target = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
    if ($target -eq "IIS:\AppPools\$script:poolName") { return $script:poolExists }
    if ($target -eq "IIS:\Sites\$script:siteName") { return $script:siteExists }
    if ($PSBoundParameters.ContainsKey('PathType')) {
        return Microsoft.PowerShell.Management\Test-Path -LiteralPath $target -PathType $PathType
    }
    return Microsoft.PowerShell.Management\Test-Path -LiteralPath $target
}
function Get-Website {
    param([string]$Name, [string]$ErrorAction)
    if ($script:siteExists) {
        return [pscustomobject]@{
            Name = $Name
            PhysicalPath = (Join-Path $install 'public')
            ApplicationPool = $script:poolName
            Bindings = [pscustomobject]@{ Collection = @() }
        }
    }
}
function Get-WebConfigurationLocation {
    param([string]$Name, [string]$PSPath, [string]$ErrorAction)
    if ($script:siteLocationExists -and $Name -eq $script:siteName) {
        return [pscustomobject]@{ Name = $Name }
    }
}
function Remove-WebConfigurationLocation {
    param([string]$Name, [string]$PSPath, [string]$ErrorAction)
    if ($Name -ne $script:siteName -or $PSPath -ne 'MACHINE/WEBROOT/APPHOST' -or -not $script:siteLocationExists) {
        throw 'Rollback attempted to remove an unexpected IIS configuration location.'
    }
    $script:rollbackOperations += 'remove-location'
    $script:siteLocationExists = $false
}
function Get-WebSiteState { param([string]$Name) return [pscustomobject]@{ Value = if ($script:siteRunning) { 'Started' } else { 'Stopped' } } }
function Get-WebAppPoolState { param([string]$Name) return [pscustomobject]@{ Value = if ($script:poolRunning) { 'Started' } else { 'Stopped' } } }
function Stop-Website { param([string]$Name, [string]$ErrorAction) $script:rollbackOperations += 'stop-site'; $script:siteRunning = $false }
function Stop-WebAppPool { param([string]$Name, [string]$ErrorAction) $script:rollbackOperations += 'stop-pool'; $script:poolRunning = $false }
function Remove-Website { param([string]$Name, [string]$ErrorAction) $script:rollbackOperations += 'remove-site'; $script:siteExists = $false }
function Remove-WebAppPool { param([string]$Name, [string]$ErrorAction) $script:rollbackOperations += 'remove-pool'; $script:poolExists = $false }
function New-Website {
    param([string]$Name, [string]$PhysicalPath, [string]$ApplicationPool, [string]$IPAddress, [int]$Port, [string]$HostHeader, [switch]$Force, [string]$ErrorAction)
    $script:createdBinding = "${IPAddress}:${Port}:${HostHeader}"
    $script:siteExists = $true
    $script:siteRunning = $false
}
function New-WebAppPool { param([string]$Name, [string]$ErrorAction) $script:poolExists = $true; $script:poolRunning = $false }
function Start-Website { param([string]$Name, [string]$ErrorAction) $script:siteRunning = $true }
function Start-WebAppPool { param([string]$Name, [string]$ErrorAction) $script:poolRunning = $true }
$script:bindings = @()
function Get-WebBinding {
    param([string]$Name, [string]$Protocol, [string]$BindingInformation, [string]$ErrorAction)
    return @($script:bindings | Where-Object {
        (!$Protocol -or $_.protocol -eq $Protocol) -and (!$BindingInformation -or $_.bindingInformation -eq $BindingInformation)
    })
}
function New-WebBinding {
    param([string]$Name, [string]$Protocol, [string]$IPAddress, [int]$Port, [string]$HostHeader, [int]$SslFlags, [string]$ErrorAction)
    $binding = [pscustomobject]@{
        protocol = $Protocol
        bindingInformation = "${IPAddress}:${Port}:${HostHeader}"
        sslFlags = $SslFlags
        certificateStoreName = ''
        certificateHash = ''
    }
    $binding | Add-Member -MemberType ScriptMethod -Name AddSslCertificate -Value {
        param($hash, $store)
        $this.certificateHash = $hash
        $this.certificateStoreName = $store
    }
    $script:bindings += $binding
}
function Set-ItemProperty {
    param([string]$LiteralPath, [string]$Name, $Value, [string]$ErrorAction)
    if ($LiteralPath -like 'IIS:\Sites\*') { $script:siteSettingsRestored++ }
    if ($LiteralPath -like 'IIS:\AppPools\*') { $script:poolSettingsRestored++ }
}
function Get-WebConfigurationProperty {
    param([string]$PSPath, [string]$Filter, [string]$Location, [string]$Name, [string]$ErrorAction)
    if ($Filter -eq 'system.webServer/security/requestFiltering/requestLimits' -and $Name -eq 'maxAllowedContentLength') {
        return [pscustomobject]@{ Value = [int64]115343360; Schema = [pscustomobject]@{ Name = 'maxAllowedContentLength' } }
    }
    if ($PSPath -like 'IIS:\Sites\*') {
        return @()
    }
    if ($Filter -eq 'system.webServer/defaultDocument/files') {
        return [pscustomobject]@{ Collection = @($script:defaultDocuments | ForEach-Object { [pscustomobject]@{ value = [string]$_ } }) }
    }
    if ($Filter -eq 'system.webServer/security/requestFiltering/fileExtensions') {
        return [pscustomobject]@{ Collection = @($script:phpFilters) }
    }
    if ($Filter -like '*applicationPools/add*' -and -not $script:poolExists) {
        return @()
    }
    if ($script:fastCgiExists -and $Filter -like 'system.webServer/fastCgi/application*/environmentVariables') {
        return @($script:fastCgiEnvironmentVariables)
    }
    if ($script:fastCgiExists -and $Filter -like 'system.webServer/fastCgi/application*') {
        return [pscustomobject]@{
            fullPath = $script:phpCgiPath
            activityTimeout = $script:fastCgiActivityTimeout
            requestTimeout = $script:fastCgiRequestTimeout
            instanceMaxRequests = $script:fastCgiInstanceMaxRequests
            environmentVariables = [pscustomobject]@{
                add = @($script:fastCgiEnvironmentVariables)
            }
        }
    }
    return @()
}
function Remove-WebConfigurationProperty {
    param([string]$PSPath, [string]$Location, [string]$Filter, [string]$Name, $AtElement, [string]$ErrorAction)
    $script:configurationMutations += [pscustomobject]@{ Command = 'Remove'; PSPath = $PSPath; Location = $Location; Filter = $Filter }
    if ($Filter -eq "system.applicationHost/sites/site[@name='$script:siteName']/bindings") {
        $script:bindings = @($script:bindings | Where-Object {
            -not ($_.protocol -eq $AtElement.protocol -and $_.bindingInformation -eq $AtElement.bindingInformation)
        })
    } elseif ($Filter -like '*/bindings') {
        throw 'Binding removal is not scoped to the requested site.'
    }
    if ($Filter -eq 'system.webServer/fastCgi/application') { throw 'FastCGI application is not a removable collection.' }
    if ($Filter -eq 'system.webServer/fastCgi') {
        if ($AtElement.fullPath -ine $script:phpCgiPath) { throw 'FastCGI deletion targeted another executable.' }
        $script:fastCgiExists = $false
    }
    if ($Filter -like 'system.webServer/fastCgi/application*/environmentVariables') {
        $script:fastCgiEnvironmentVariables = @($script:fastCgiEnvironmentVariables | Where-Object { $_.name -ne $AtElement.name })
    }
    if ($Filter -eq 'system.webServer/defaultDocument/files') {
        $script:defaultDocuments = @($script:defaultDocuments | Where-Object { $_ -ne [string]$AtElement.value })
    }
    if ($Filter -eq 'system.webServer/security/requestFiltering/fileExtensions') {
        $script:phpFilters = @($script:phpFilters | Where-Object { $_.fileExtension -ine [string]$AtElement.fileExtension })
    }
}
function Add-WebConfigurationProperty {
    param([string]$PSPath, [string]$Location, [string]$Filter, [string]$Name, [int]$AtIndex, $Value, [string]$ErrorAction)
    $script:configurationMutations += [pscustomobject]@{ Command = 'Add'; PSPath = $PSPath; Location = $Location; Filter = $Filter }
    if ($Filter -eq 'system.webServer/fastCgi/application') { throw 'FastCGI application is not an appendable collection.' }
    if ($Filter -eq 'system.webServer/fastCgi') {
        $script:fastCgiExists = $true
        $script:fastCgiActivityTimeout = [int]$Value.activityTimeout
        $script:fastCgiRequestTimeout = [int]$Value.requestTimeout
        $script:fastCgiInstanceMaxRequests = [int]$Value.instanceMaxRequests
        $script:fastCgiEnvironmentVariables = @()
    }
    if ($Filter -like 'system.webServer/fastCgi/application*/environmentVariables') {
        $script:fastCgiEnvironmentVariables += [pscustomobject]@{ name = [string]$Value.name; value = [string]$Value.value }
    }
    if ($Filter -eq 'system.webServer/defaultDocument/files') {
        $documents = New-Object 'System.Collections.Generic.List[string]'
        foreach ($document in $script:defaultDocuments) { $documents.Add([string]$document) }
        $index = if ($PSBoundParameters.ContainsKey('AtIndex')) { $AtIndex } else { 0 }
        $documents.Insert($index, [string]$Value.value)
        $script:defaultDocuments = @($documents.ToArray())
    }
    if ($Filter -eq 'system.webServer/security/requestFiltering/fileExtensions') {
        $script:phpFilters += [pscustomobject]@{ fileExtension = [string]$Value.fileExtension; allowed = [bool]$Value.allowed }
    }
}
function Set-WebConfigurationProperty {
    param([string]$PSPath, [string]$Location, [string]$Filter, [string]$Name, $Value, [string]$ErrorAction)
    if ($Filter -eq 'system.webServer/defaultDocument' -and $Name -eq 'enabled') {
        $script:defaultDocumentEnabled = [bool]$Value
        $script:configurationMutations += [pscustomobject]@{ Command = 'Set'; PSPath = $PSPath; Location = $Location; Filter = $Filter }
    }
    if ($PSPath -like 'IIS:\Sites\*') { $script:siteSettingsRestored++ }
    if ($Filter -like 'system.webServer/fastCgi/application*') {
        if ($Name -eq 'activityTimeout') { $script:fastCgiActivityTimeout = [int]$Value }
        if ($Name -eq 'requestTimeout') { $script:fastCgiRequestTimeout = [int]$Value }
        if ($Name -eq 'instanceMaxRequests') { $script:fastCgiInstanceMaxRequests = [int]$Value }
    }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('netarium-rollback-' + [guid]::NewGuid().ToString('N'))
$install = Join-Path $root 'app'
$storage = Join-Path $install 'data'
$rollbackRoot = Join-Path $root 'rollback'
$state = [pscustomobject]@{
    SiteExists = $false
    SiteLocationExists = $false
    AppPoolExists = $false
    SiteName = $script:siteName
    ApplicationPoolName = $script:poolName
    PhpCgiPath = $script:phpCgiPath
    Site = [pscustomobject]@{ PhysicalPath = (Join-Path $install 'public'); State = 'Stopped'; ApplicationPool = $script:poolName; Bindings = @(); EnvironmentVariables = @() }
    AppPool = [pscustomobject]@{ State = 'Stopped'; StartMode = 'OnDemand'; IdentityType = 'ApplicationPoolIdentity'; UserName = $null; Password = $null; EnvironmentVariables = @() }
    FastCgi = @()
    Handler = @()
    RequestLimit = $null
    DefaultDocuments = @()
    PhpFilters = @()
}
try {
    $snapshot = New-NetariumSnapshot -RollbackRoot $rollbackRoot -InstallRoot $install -StorageDir $storage -SiteName $script:siteName -ApplicationPoolName $script:poolName -Stage 'fresh-setup' -PhpCgiPath $script:phpCgiPath -IisState $state
    foreach ($created in @('none', 'pool', 'pool-stopped', 'site-and-pool', 'site-and-pool-stopped')) {
        $script:poolExists = $created -ne 'none'
        $script:siteExists = $created -like 'site-and-pool*'
        $script:siteLocationExists = $script:siteExists
        $script:poolRunning = $created -in @('pool', 'site-and-pool')
        $script:siteRunning = $created -eq 'site-and-pool'
        $script:rollbackOperations = @()
        $script:fastCgiExists = $true
        $script:fastCgiActivityTimeout = 300
        $script:fastCgiRequestTimeout = 300
        $script:fastCgiInstanceMaxRequests = 1000
        $script:fastCgiEnvironmentVariables = @()
        New-Item -ItemType Directory -Path (Join-Path $install 'config') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $install 'public') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $install 'public/web.config'), '<configuration/>')
        [IO.File]::WriteAllText((Join-Path $install 'config/app.php'), '<?php')
        Restore-NetariumSnapshot -SnapshotPath $snapshot -InstallRoot $install -StorageDir $storage | Out-Null
        $expectedOperations = switch ($created) {
            'none' { '' }
            'pool' { 'stop-pool|remove-pool' }
            'pool-stopped' { 'remove-pool' }
            'site-and-pool' { 'stop-site|remove-location|remove-site|stop-pool|remove-pool' }
            'site-and-pool-stopped' { 'remove-location|remove-site|remove-pool' }
        }
        $actualOperations = $script:rollbackOperations -join '|'
        if ($actualOperations -cne $expectedOperations) {
            throw "Fresh rollback used the wrong IIS removal order after $created`: $actualOperations"
        }
        if ($script:siteExists -or $script:poolExists -or $script:siteLocationExists -or $script:fastCgiExists -or (Microsoft.PowerShell.Management\Test-Path -LiteralPath $install)) {
            throw "Fresh rollback left resources behind after $created"
        }
        Write-Host "  [PASS] fresh rollback after $created" -ForegroundColor Green
    }

    # A site absent at snapshot time can still have a pre-existing location block.
    $state.SiteLocationExists = $true
    $script:siteLocationExists = $true
    $script:rollbackOperations = @()
    Restore-NetariumIisState -State ([pscustomobject]@{
        SiteExists = $false
        AppPoolExists = $false
        SiteName = $script:siteName
        ApplicationPoolName = $script:poolName
        Iis = $state
    })
    if (-not $script:siteLocationExists -or @($script:rollbackOperations | Where-Object { $_ -eq 'remove-location' }).Count -gt 0) {
        throw 'Rollback removed a pre-existing IIS location without a site.'
    }
    $state.SiteLocationExists = $false
    $script:siteLocationExists = $false
    Write-Host '  [PASS] pre-existing location without a site preserved' -ForegroundColor Green

    # Older snapshots without the location baseline must not delete a pre-existing location.
    $state.PSObject.Properties.Remove('SiteLocationExists')
    $script:siteLocationExists = $true
    try {
        Restore-NetariumIisState -State ([pscustomobject]@{
            SiteExists = $false
            AppPoolExists = $false
            SiteName = $script:siteName
            ApplicationPoolName = $script:poolName
            Iis = $state
        })
        throw 'Legacy snapshot unexpectedly restored without a site-location baseline.'
    } catch {
        if ($_.Exception.Message -notlike '*no record of the original IIS site location*' -or -not $script:siteLocationExists) {
            throw
        }
    } finally {
        $state | Add-Member -NotePropertyName SiteLocationExists -NotePropertyValue $false
        $script:siteLocationExists = $false
    }
    Write-Host '  [PASS] unknown original location is preserved for manual recovery' -ForegroundColor Green

    # A data-only installation root must keep its original files and logs on rollback.
    New-Item -ItemType Directory -Path (Join-Path $storage 'logs') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $storage 'logs/original.log'), 'before setup')
    [IO.File]::WriteAllText((Join-Path $install 'keep.txt'), 'pre-existing')
    $existingSnapshot = New-NetariumSnapshot -RollbackRoot $rollbackRoot -InstallRoot $install -StorageDir $storage -SiteName $script:siteName -ApplicationPoolName $script:poolName -Stage 'fresh-setup' -PhpCgiPath $script:phpCgiPath -IisState $state
    New-Item -ItemType Directory -Path (Join-Path $install 'public') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $install 'public/web.config'), '<configuration/>')
    New-Item -ItemType Directory -Path (Join-Path $install 'config') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $install 'config/app.php'), '<?php')
    Restore-NetariumSnapshot -SnapshotPath $existingSnapshot -InstallRoot $install -StorageDir $storage | Out-Null
    if (-not (Microsoft.PowerShell.Management\Test-Path -LiteralPath $install) -or
        (Microsoft.PowerShell.Management\Test-Path -LiteralPath (Join-Path $install 'public')) -or
        (Microsoft.PowerShell.Management\Test-Path -LiteralPath (Join-Path $install 'config')) -or
        (@(Get-ChildItem -LiteralPath $storage -Force).Count -ne 1) -or
        [IO.File]::ReadAllText((Join-Path $install 'keep.txt')) -ne 'pre-existing' -or
        [IO.File]::ReadAllText((Join-Path $storage 'logs/original.log')) -ne 'before setup') {
        throw 'Rollback did not restore the pre-existing data-only installation.'
    }
    Write-Host '  [PASS] data-only installation root and logs preserved' -ForegroundColor Green

    # Phase 7前のルートファイルは更新で撤去し、失敗時には内容ごと復元する。
    $blocklistPaths = @(
        'resources/password-blocklist/ncsc-100k.txt',
        'resources/password-blocklist/metadata.json',
        'resources/password-blocklist/pwdb-policy-top-3000.txt',
        'resources/password-blocklist/pwdb-metadata.json'
    )
    # 廃止済みNCSC同梱版を合成データで再現し、現行資材への依存を避ける。
    $oldResources = Join-Path $install 'resources/password-blocklist'
    New-Item -ItemType Directory -Path $oldResources -Force | Out-Null
    foreach ($relativePath in $blocklistPaths[0..1]) {
        [IO.File]::WriteAllText((Join-Path $install $relativePath), "synthetic-legacy-$relativePath")
    }
    $oldResourceInventory = @(Get-FileInventory -Root (Join-Path $install 'resources')) | ConvertTo-Json -Compress
    foreach ($name in @('auth.php', 'database.php')) {
        [IO.File]::WriteAllText((Join-Path $install $name), "old-$name")
    }
    $optional = Join-Path $storage 'password-blocklist'
    New-Item -ItemType Directory -Path $optional -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $storage 'password-blocklist.json'), '{"format_version":1,"enabled":false}')
    [IO.File]::WriteAllText((Join-Path $optional 'dictionary-preserved.txt'), "preserved`n")
    $optionalBefore = @(Get-FileInventory -Root $optional) | ConvertTo-Json -Compress
    $legacySnapshot = New-NetariumSnapshot -RollbackRoot $rollbackRoot -InstallRoot $install -StorageDir $storage -SiteName $script:siteName -ApplicationPoolName $script:poolName -Stage 'update' -PhpCgiPath $script:phpCgiPath -IisState $state
    if (Test-Path -LiteralPath (Join-Path $legacySnapshot 'data/password-blocklist')) { throw '追加辞書がsnapshotに混入しました。' }
    if (Test-Path -LiteralPath (Join-Path $legacySnapshot 'data/password-blocklist.json')) { throw '追加manifestがsnapshotに混入しました。' }
    $staged = Join-Path $root 'phase7-staged'
    Copy-NetariumUpdateManifest -SourceRoot (Split-Path -Parent $PSScriptRoot) -DestinationRoot $staged
    Replace-NetariumProgramManifest -StagedRoot $staged -InstallRoot $install
    foreach ($name in @('auth.php', 'database.php')) {
        if (Test-Path -LiteralPath (Join-Path $install $name)) {
            throw "Update left retired file: $name"
        }
    }
    if ([IO.File]::ReadAllText((Join-Path $install 'keep.txt')) -ne 'pre-existing') {
        throw 'Update changed an unmanaged file.'
    }
    Restore-NetariumSnapshot -SnapshotPath $legacySnapshot -InstallRoot $install -StorageDir $storage | Out-Null
    if ((@(Get-FileInventory -Root $optional) | ConvertTo-Json -Compress) -cne $optionalBefore) { throw '更新またはrollbackが追加辞書を変更しました。' }
    if ([IO.File]::ReadAllText((Join-Path $storage 'password-blocklist.json')) -cne '{"format_version":1,"enabled":false}') { throw '更新またはrollbackが追加manifestを変更しました。' }
    if ((@(Get-FileInventory -Root (Join-Path $install 'resources')) | ConvertTo-Json -Compress) -cne $oldResourceInventory) {
        throw 'Older-release rollback did not restore NCSC bytes or left PWDB resources behind.'
    }
    Write-Host '  [PASS] older-release rollback restores NCSC-only resources without leaving PWDB files' -ForegroundColor Green
    foreach ($name in @('auth.php', 'database.php')) {
        if ([IO.File]::ReadAllText((Join-Path $install $name)) -ne "old-$name") {
            throw "Rollback failed to restore retired file: $name"
        }
    }
    Write-Host '  [PASS] retired root files removed on update and restored on rollback' -ForegroundColor Green

    Replace-NetariumProgramManifest -StagedRoot $staged -InstallRoot $install
    $currentResourceInventory = @(Get-FileInventory -Root (Join-Path $install 'resources')) | ConvertTo-Json -Compress
    $currentSnapshot = New-NetariumSnapshot -RollbackRoot $rollbackRoot -InstallRoot $install -StorageDir $storage -SiteName $script:siteName -ApplicationPoolName $script:poolName -Stage 'update' -PhpCgiPath $script:phpCgiPath -IisState $state
    foreach ($relativePath in $blocklistPaths[2..3]) {
        [IO.File]::WriteAllText((Join-Path $install $relativePath), 'corrupt replacement')
    }
    Remove-Item -LiteralPath (Join-Path $install $blocklistPaths[2]) -Force
    Restore-NetariumSnapshot -SnapshotPath $currentSnapshot -InstallRoot $install -StorageDir $storage | Out-Null
    if ((@(Get-FileInventory -Root (Join-Path $install 'resources')) | ConvertTo-Json -Compress) -cne $currentResourceInventory) {
        throw '同一版rollbackがPWDB資材をバイト単位で復元できませんでした。'
    }
    Write-Host '  [PASS] 同一版rollbackで欠損・改変したPWDB資材を復元' -ForegroundColor Green

    # 既存サイトとプールは削除せず、保存した設定を復元する。
    $state.SiteExists = $true
    $state.AppPoolExists = $true
    $script:siteExists = $true
    $script:poolExists = $true
    Restore-NetariumIisState -State ([pscustomobject]@{ SiteExists = $true; AppPoolExists = $true; SiteName = $script:siteName; ApplicationPoolName = $script:poolName; PhpCgiPath = $script:phpCgiPath; Iis = $state })
    if (-not $script:siteExists -or -not $script:poolExists -or $script:siteSettingsRestored -eq 0 -or $script:poolSettingsRestored -eq 0) {
        throw 'Existing site or pool configuration was not restored.'
    }
    Write-Host '  [PASS] existing site and pool restore' -ForegroundColor Green

    foreach ($locationBaseline in @('absent', 'present', 'unknown')) {
        $state.PSObject.Properties.Remove('SiteLocationExists')
        if ($locationBaseline -ne 'unknown') {
            $state | Add-Member -NotePropertyName SiteLocationExists -NotePropertyValue ($locationBaseline -eq 'present')
        }
        # A failed setup created a target-site location; unrelated sites are not touched.
        $script:siteLocationExists = $true
        Restore-NetariumIisState -State ([pscustomobject]@{
            SiteExists = $true; AppPoolExists = $true
            SiteName = $script:siteName; ApplicationPoolName = $script:poolName; Iis = $state
        })
        if ($script:siteLocationExists -ne ($locationBaseline -ne 'absent') -or
            -not $script:siteExists -or -not $script:poolExists) {
            throw "Existing-site rollback did not preserve the $locationBaseline location baseline."
        }
        Write-Host "  [PASS] existing-site rollback preserves $locationBaseline location baseline" -ForegroundColor Green
    }
    $state | Add-Member -NotePropertyName SiteLocationExists -NotePropertyValue $false
    $script:siteLocationExists = $false

    # Restore both HTTP and HTTPS/SNI bindings, including certificate identity, after a failed setup.
    $state.Site.Bindings = @(
        [pscustomobject]@{ Protocol = 'http'; BindingInformation = '*:80:plain.example.test'; SslFlags = 0; CertificateHash = ''; CertificateStoreName = '' },
        [pscustomobject]@{ Protocol = 'https'; BindingInformation = '*:443:secure.example.test'; SslFlags = 1; CertificateHash = 'AABBCCDD'; CertificateStoreName = 'My' }
    )
    $script:bindings = @(
        [pscustomobject]@{ protocol = 'https'; bindingInformation = '*:443:wrong.example.test'; sslFlags = 1; certificateHash = 'WRONG'; certificateStoreName = 'My' }
    )
    Restore-NetariumIisState -State ([pscustomobject]@{
        SiteExists = $true
        AppPoolExists = $true
        SiteName = $script:siteName
        ApplicationPoolName = $script:poolName
        PhpCgiPath = $script:phpCgiPath
        Iis = $state
    })
    $restoredHttp = @($script:bindings | Where-Object {
        $_.protocol -eq 'http' -and $_.bindingInformation -eq '*:80:plain.example.test' -and $_.sslFlags -eq 0
    })
    $restoredHttps = @($script:bindings | Where-Object {
        $_.protocol -eq 'https' -and $_.bindingInformation -eq '*:443:secure.example.test' -and
        $_.sslFlags -eq 1 -and $_.certificateHash -eq 'AABBCCDD' -and $_.certificateStoreName -eq 'My'
    })
    if ($script:bindings.Count -ne 2 -or $restoredHttp.Count -ne 1 -or $restoredHttps.Count -ne 1) {
        throw 'Rollback did not restore the original HTTP/HTTPS/SNI bindings and certificate.'
    }
    Write-Host '  [PASS] HTTP/HTTPS/SNI bindings and certificate restored on rollback' -ForegroundColor Green
    $script:siteExists = $false
    Restore-NetariumIisState -State ([pscustomobject]@{ SiteExists = $true; AppPoolExists = $true; SiteName = $script:siteName; ApplicationPoolName = $script:poolName; Iis = $state })
    if ($script:createdBinding -cne '*:80:plain.example.test') {
        throw 'Site recreation used an unintended temporary binding.'
    }
    Write-Host '  [PASS] recreated site uses saved endpoint without temporary wildcard binding' -ForegroundColor Green

    # Restore a snapshot containing only one of the two IIS resources.
    foreach ($saved in @('site', 'pool')) {
        $siteSaved = $saved -eq 'site'
        $script:siteExists = $siteSaved
        $script:poolExists = -not $siteSaved
        Restore-NetariumIisState -State ([pscustomobject]@{
            SiteExists = $siteSaved
            AppPoolExists = -not $siteSaved
            SiteName = $script:siteName
            ApplicationPoolName = $script:poolName
            Iis = $state
        })
        if ($script:siteExists -ne $siteSaved -or $script:poolExists -eq $siteSaved) {
            throw "Partial IIS state was not preserved: $saved"
        }
        Write-Host "  [PASS] partial IIS state: $saved" -ForegroundColor Green
    }


    $script:defaultDocuments = @('custom.htm', 'INDEX.PHP')
    $script:defaultDocumentEnabled = $false
    Ensure-NetariumDefaultDocument -SiteName $script:siteName
    Ensure-NetariumDefaultDocument -SiteName $script:siteName
    if (-not $script:defaultDocumentEnabled -or
        [string]::Join('|', $script:defaultDocuments) -cne 'custom.htm|INDEX.PHP') {
        throw 'Default document repair duplicated or replaced an existing case-insensitive index.php entry.'
    }
    Write-Host '  [PASS] default document repair enables lookup without duplicating or replacing existing entries' -ForegroundColor Green

    # No default-document write preserves inherited/explicit values and collection order.
    $documentsBefore = $script:defaultDocuments -join '|'
    $enabledBefore = $script:defaultDocumentEnabled
    $script:configurationMutations = @()
    Restore-NetariumIisState -State ([pscustomobject]@{
        SiteExists = $true; AppPoolExists = $true
        SiteName = $script:siteName; ApplicationPoolName = $script:poolName; Iis = $state
    }) -KeepStopped -KeepRequestFiltering -KeepDefaultDocument
    if (($script:defaultDocuments -join '|') -cne $documentsBefore -or $script:defaultDocumentEnabled -ne $enabledBefore -or
        @($script:configurationMutations | Where-Object { $_.Filter -like 'system.webServer/defaultDocument*' }).Count) {
        throw 'Update rollback changed explicit/inherited default-document state or collection order.'
    }
    Write-Host '  [PASS] update rollback leaves default-document configuration untouched' -ForegroundColor Green


    $state.FastCgi = @([pscustomobject]@{
        FullPath = $script:phpCgiPath
        ActivityTimeout = 180
        RequestTimeout = 200
        InstanceMaxRequests = 2500
        EnvironmentVariables = @([pscustomobject]@{ Name = 'PHP_FCGI_MAX_REQUESTS'; Value = '7' })
    })
    $script:siteExists = $false
    $script:poolExists = $false
    $script:siteRunning = $false
    $script:poolRunning = $false
    $script:fastCgiExists = $true
    $script:fastCgiActivityTimeout = 300
    $script:fastCgiRequestTimeout = 300
    $script:fastCgiInstanceMaxRequests = 1000
    $script:fastCgiEnvironmentVariables = @([pscustomobject]@{ name = 'TEMP_SETTING'; value = 'temporary' })
    Restore-NetariumIisState -State ([pscustomobject]@{
        SiteExists = $false
        AppPoolExists = $false
        SiteName = $script:siteName
        ApplicationPoolName = $script:poolName
        Iis = $state
    })
    if (-not $script:fastCgiExists -or $script:fastCgiActivityTimeout -ne 180 -or
        $script:fastCgiRequestTimeout -ne 200 -or $script:fastCgiInstanceMaxRequests -ne 2500 -or
        $script:fastCgiEnvironmentVariables.Count -ne 1 -or
        $script:fastCgiEnvironmentVariables[0].name -ne 'PHP_FCGI_MAX_REQUESTS' -or
        $script:fastCgiEnvironmentVariables[0].value -ne '7') {
        throw 'Pre-existing FastCGI settings were not restored.'
    }
    Write-Host '  [PASS] pre-existing FastCGI timeouts, instance limits and environment variables restored' -ForegroundColor Green
    $capturedFastCgi = Get-IisState -SiteName $script:siteName -ApplicationPoolName $script:poolName -PhpCgiPath $script:phpCgiPath
    $script:fastCgiExists = $false
    $script:fastCgiEnvironmentVariables = @()
    Restore-NetariumIisState -State ([pscustomobject]@{
        SiteExists = $false
        AppPoolExists = $false
        SiteName = $script:siteName
        ApplicationPoolName = $script:poolName
        Iis = $capturedFastCgi
    })
    if (-not $script:fastCgiExists -or $script:fastCgiActivityTimeout -ne 180 -or
        $script:fastCgiRequestTimeout -ne 200 -or $script:fastCgiInstanceMaxRequests -ne 2500 -or
        $script:fastCgiEnvironmentVariables.Count -ne 1 -or
        $script:fastCgiEnvironmentVariables[0].name -ne 'PHP_FCGI_MAX_REQUESTS' -or
        $script:fastCgiEnvironmentVariables[0].value -ne '7') {
        throw 'Missing FastCGI registration did not recover its captured settings and environment.'
    }
    Write-Host '  [PASS] missing FastCGI application recovers captured timeouts, instance limits and environment' -ForegroundColor Green
    $script:fastCgiExists = $true
    $script:configurationMutations = @()
    Restore-NetariumIisState -State ([pscustomobject]@{
        SiteExists = $false
        AppPoolExists = $false
        SiteName = $script:siteName
        ApplicationPoolName = $script:poolName
        Iis = [pscustomobject]@{
            FastCgi = @()
            PhpCgiPath = $script:phpCgiPath
            SiteExists = $false
            AppPoolExists = $false
        }
    })
    if ($script:fastCgiExists) {
        throw 'Fresh rollback left its FastCGI application registered.'
    }
    Write-Host '  [PASS] unshared FastCGI created during fresh setup is removed on rollback' -ForegroundColor Green

    function Get-Item { param($Path, $ErrorAction) return $null }
    $script:siteExists = $false
    $script:poolExists = $false
    $captured = Get-IisState -SiteName $script:siteName -ApplicationPoolName $script:poolName -PhpCgiPath $script:phpCgiPath
    $aclPublic = Join-Path $install 'public'
    New-Item -ItemType Directory -Path $aclPublic -Force | Out-Null
    $originalAcl = Get-Acl -LiteralPath $aclPublic
    $originalAcl.SetAccessRuleProtection($true, $true)
    $customSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-123-456-789-1001')
    $originalAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($customSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $aclPublic -AclObject $originalAcl
    $savedSddl = (Get-Acl -LiteralPath $aclPublic).GetSecurityDescriptorSddlForm('Access')
    $limitSnapshot = New-NetariumSnapshot -RollbackRoot $rollbackRoot -InstallRoot $install -StorageDir $storage -SiteName $script:siteName -ApplicationPoolName $script:poolName -Stage 'update' -IisState $captured
    $savedLimit = (Get-Content (Join-Path $limitSnapshot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).Iis.RequestLimit
    if ($savedLimit -isnot [ValueType] -or [int64]$savedLimit -ne 115343360) {
        throw 'Request limit did not survive the snapshot as a numeric value.'
    }
    Write-Host '  [PASS] IIS request limit attribute survives snapshot as a numeric value' -ForegroundColor Green
    $changedAcl = Get-Acl -LiteralPath $aclPublic
    $changedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($customSid, [Security.AccessControl.FileSystemRights]::Modify, 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $aclPublic -AclObject $changedAcl
    Restore-NetariumSnapshot -SnapshotPath $limitSnapshot -InstallRoot $install -StorageDir $storage | Out-Null
    if ((Get-Acl -LiteralPath $aclPublic).GetSecurityDescriptorSddlForm('Access') -cne $savedSddl) {
        throw 'Rollback did not restore protected ACLs and custom read-only permissions.'
    }
    Write-Host '  [PASS] rollback restores protected ACL and custom read-only permissions' -ForegroundColor Green

    function Get-Item {
        param($Path, $LiteralPath, $ErrorAction)
        $target = if ($PSBoundParameters.ContainsKey('LiteralPath')) { $LiteralPath } else { $Path }
        if ($target -like 'IIS:\AppPools\*') {
            if ($script:poolExists) {
                return [pscustomobject]@{ name = $script:poolName; startMode = 'OnDemand'; processModel = [pscustomobject]@{ identityType = 'ApplicationPoolIdentity'; userName = $null; password = $null } }
            }
            return $null
        }
        if ($PSBoundParameters.ContainsKey('LiteralPath')) {
            return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -ErrorAction $ErrorAction
        }
        Microsoft.PowerShell.Management\Get-Item -Path $Path -ErrorAction $ErrorAction
    }

    $script:poolExists = $true
    $script:siteExists = $true
    $divergedState = [pscustomobject]@{
        SiteExists = $true
        AppPoolExists = $true
        SiteName = $script:siteName
        ApplicationPoolName = $script:poolName
        PhpCgiPath = $script:phpCgiPath
        Site = [pscustomobject]@{ PhysicalPath = (Join-Path $install 'public'); State = 'Stopped'; ApplicationPool = 'NetariumSiteAssignedPool'; Bindings = @([pscustomobject]@{ Protocol = 'http'; BindingInformation = '*:80:plain.example.test'; SslFlags = 0; CertificateHash = ''; CertificateStoreName = '' }); EnvironmentVariables = @() }
        AppPool = [pscustomobject]@{ State = 'Stopped'; StartMode = 'OnDemand'; IdentityType = 'ApplicationPoolIdentity'; UserName = $null; Password = $null; EnvironmentVariables = @() }
        FastCgi = @(); Handler = @(); RequestLimit = $null; DefaultDocuments = @(); PhpFilters = @()
    }
    $divergedSnapshot = New-NetariumSnapshot -RollbackRoot $rollbackRoot -InstallRoot $install -StorageDir $storage -SiteName $script:siteName -ApplicationPoolName $script:poolName -Stage 'update' -IisState $divergedState
    Restore-NetariumSnapshot -SnapshotPath $divergedSnapshot -InstallRoot $install -StorageDir $storage -KeepIisStopped | Out-Null
    $storageRules = @((Get-Acl -LiteralPath $storage).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $hasSitePool = @($storageRules | Where-Object { $_.IdentityReference.Value -eq $sitePoolSid.Value -and $_.AccessControlType -eq 'Allow' }).Count -gt 0
    if (-not $hasSitePool) {
        throw 'Rollback did not grant ACL permissions to the site assigned application pool.'
    }
    Write-Host '  [PASS] rollback derives confidential storage ACL from restored site application pool' -ForegroundColor Green
} finally {
    if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
