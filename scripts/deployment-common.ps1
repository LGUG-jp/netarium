Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:NetariumPasswordRuntimeProbe = Join-Path $PSScriptRoot 'check-password-runtime.php'

# Legacy files tracked only for snapshot/rollback; excluded from new releases.
$script:NetariumReleaseManifest = [ordered]@{
    Directories = @(
        'public',
        'src',
        'templates',
        'resources',
        'scripts'
    )
    Files = @(
        'bootstrap.php',
        'version.php',
        'config/app.example.php'
    )
    RetiredFiles = @('auth.php', 'database.php')
}

$script:NetariumManagedInstallDirectories = @(
    'config', 'data/db', 'data/uploads', 'data/backups', 'data/temp', 'data/logs', 'data/sessions', 'data'
)

$script:NetariumIisDefaults = @{
    InstallRoot = 'C:\Netarium\app'
    SiteName = 'Netarium'
}

function Assert-NetariumArgon2Runtime {
    param(
        [Parameter(Mandatory = $true)][string]$PhpPath,
        [string]$ProbePath = $script:NetariumPasswordRuntimeProbe,
        [switch]$Cgi
    )

    $output = if ($Cgi) {
        @(& $PhpPath -q -f $ProbePath 2>&1)
    } else {
        @(& $PhpPath $ProbePath 2>&1)
    }
    if ($LASTEXITCODE -ne 0) {
        throw 'Argon2id generation/verification failed; bcrypt fallback is not permitted.'
    }
    try {
        $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
        if (-not $result.ok -or $result.algorithm -ne 'argon2id' -or
            $result.options.memory_cost -ne 19456 -or $result.options.time_cost -ne 2 -or
            $result.options.threads -ne 1) {
            throw 'Unexpected password runtime result.'
        }
    } catch {
        throw 'Argon2id generation/verification failed; bcrypt fallback is not permitted.'
    }
    return $result
}

function Read-NetariumDeploymentParameter {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Description,
        [string]$Default,
        [switch]$NonInteractive,
        [switch]$CompactPrompt
    )

    if ($NonInteractive) {
        throw "Missing required deployment parameter: -$Name"
    }
    $label = if ($CompactPrompt) {
        "$Name [$Default]"
    } elseif ($Default) {
        "$Description (-$Name; Enter: $Default)"
    } else {
        "$Description (-$Name)"
    }
    $answer = Read-Host -Prompt $label
    if ([string]::IsNullOrWhiteSpace($answer)) {
        if ($Default) {
            return $Default
        }
        throw "Missing required deployment parameter: -$Name"
    }
    return $answer.Trim()
}

function ConvertTo-NetariumAbsolutePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'Deployment path must not be empty.'
    }

    try {
        return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    } catch {
        throw "Deployment path is invalid: $Path"
    }
}

function Test-NetariumPathOverlap {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Left,
        [Parameter(Mandatory = $true)]
        [string]$Right
    )

    $leftPath = (ConvertTo-NetariumAbsolutePath -Path $Left).TrimEnd('\', '/')
    $rightPath = (ConvertTo-NetariumAbsolutePath -Path $Right).TrimEnd('\', '/')
    $comparison = [System.StringComparison]::OrdinalIgnoreCase

    return (
        $leftPath.Equals($rightPath, $comparison) -or
        $leftPath.StartsWith($rightPath + '\', $comparison) -or
        $rightPath.StartsWith($leftPath + '\', $comparison)
    )
}

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)

    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This deployment operation requires an elevated PowerShell session.'
    }
}

function Assert-WebAdministration {
    Import-Module WebAdministration -ErrorAction Stop

    foreach ($commandName in @(
        'Get-Website',
        'Get-WebRequest',
        'Get-WebConfiguration',
        'Get-WebConfigurationLocation',
        'Remove-WebConfigurationLocation',
        'Get-WebConfigurationProperty',
        'Add-WebConfigurationProperty',
        'Remove-WebConfigurationProperty'
    )) {
        if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
            throw "WebAdministration command is unavailable: $commandName"
        }
    }
}
function Get-NetariumAccountSid {
    param([string]$AccountName)

    if ([string]::IsNullOrWhiteSpace($AccountName)) {
        throw 'Cannot resolve account SID: the account name is empty.'
    }
    $normalized = if ($AccountName -match '\A\.\\(.+)\z') {
        "$env:COMPUTERNAME\$($Matches[1])"
    } else {
        $AccountName
    }
    try {
        $account = New-Object System.Security.Principal.NTAccount($normalized)
        return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        throw "Cannot resolve SID for account '$AccountName': $($_.Exception.Message)"
    }
}

function Assert-NetariumAppPoolIdentityIsolation {
    param(
        [Parameter(Mandatory = $true)][string]$ApplicationPoolName
    )

    $poolPath = "IIS:\AppPools\$ApplicationPoolName"
    if (-not (Test-Path -LiteralPath $poolPath -ErrorAction Stop)) {
        return
    }

    $processModel = Get-ItemProperty -LiteralPath $poolPath -Name processModel -ErrorAction Stop
    if (-not $processModel -or -not $processModel.PSObject.Properties['identityType']) {
        throw "Cannot read processModel identity type for application pool '$ApplicationPoolName'; identity isolation cannot be verified."
    }
    $identityType = [string]$processModel.identityType
    if ($identityType -eq 'ApplicationPoolIdentity') {
        return
    }
    if ($identityType -in @('LocalSystem', 'NetworkService', 'LocalService')) {
        throw "Application pool '$ApplicationPoolName' must not use built-in shared identity '$identityType'; use ApplicationPoolIdentity or a dedicated user account."
    }
    if ($identityType -ne 'SpecificUser') {
        throw "Application pool '$ApplicationPoolName' has unsupported identity type '$identityType'; identity isolation cannot be verified."
    }

    $userName = if ($processModel.PSObject.Properties['userName']) { [string]$processModel.userName } else { '' }
    if ([string]::IsNullOrWhiteSpace($userName)) {
        throw "Application pool '$ApplicationPoolName' has an empty SpecificUser account; identity isolation cannot be verified."
    }
    $userSid = Get-NetariumAccountSid -AccountName $userName
    if ([string]::IsNullOrWhiteSpace($userSid)) {
        throw "Cannot resolve SID for account '$userName'; identity isolation cannot be verified."
    }
    $otherPools = @(Get-ChildItem -LiteralPath 'IIS:\AppPools' -ErrorAction Stop)
    foreach ($otherPool in $otherPools) {
        if ($otherPool.Name -ieq $ApplicationPoolName) {
            continue
        }
        $otherProcessModel = Get-ItemProperty -LiteralPath "IIS:\AppPools\$($otherPool.Name)" -Name processModel -ErrorAction Stop
        if (-not $otherProcessModel -or -not $otherProcessModel.PSObject.Properties['identityType']) {
            throw "Cannot read processModel identity type for application pool '$($otherPool.Name)'; identity isolation cannot be verified."
        }
        $otherIdentity = [string]$otherProcessModel.identityType
        if ($otherIdentity -in @('ApplicationPoolIdentity', 'LocalSystem', 'NetworkService', 'LocalService')) {
            continue
        }
        if ($otherIdentity -ne 'SpecificUser') {
            throw "Application pool '$($otherPool.Name)' has unsupported identity type '$otherIdentity'; identity isolation cannot be verified."
        }
        $otherUser = if ($otherProcessModel.PSObject.Properties['userName']) { [string]$otherProcessModel.userName } else { '' }
        if ([string]::IsNullOrWhiteSpace($otherUser)) {
            throw "Application pool '$($otherPool.Name)' has an empty SpecificUser account; identity isolation cannot be verified."
        }
        $otherUserSid = Get-NetariumAccountSid -AccountName $otherUser
        if ([string]::IsNullOrWhiteSpace($otherUserSid)) {
            throw "Cannot resolve SID for account '$otherUser'; identity isolation cannot be verified."
        }
        if ($userSid -eq $otherUserSid) {
            throw "Application pool '$ApplicationPoolName' shares custom user identity '$userName' with application pool '$($otherPool.Name)'. Sharing user identities across application pools violates process and session isolation boundaries; use ApplicationPoolIdentity or a dedicated user account."
        }
    }
}

function Assert-SafeDeploymentPaths {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourcePath,
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,
        [Parameter(Mandatory = $true)]
        [string]$RollbackRoot
    )

    $paths = [ordered]@{
        SourcePath = ConvertTo-NetariumAbsolutePath -Path $SourcePath
        InstallRoot = ConvertTo-NetariumAbsolutePath -Path $InstallRoot
        RollbackRoot = ConvertTo-NetariumAbsolutePath -Path $RollbackRoot
    }


    $pathNames = @($paths.Keys)
    for ($i = 0; $i -lt $pathNames.Count; $i++) {
        for ($j = $i + 1; $j -lt $pathNames.Count; $j++) {
            $leftName = $pathNames[$i]
            $rightName = $pathNames[$j]
            if (Test-NetariumPathOverlap -Left $paths[$leftName] -Right $paths[$rightName]) {
                throw "Deployment paths overlap: $leftName and $rightName"
            }
        }
    }

    return [pscustomobject]$paths
}

function Assert-ReleaseLayout {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourcePath
    )

    $root = ConvertTo-NetariumAbsolutePath -Path $SourcePath
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "Release source directory does not exist: $root"
    }

    foreach ($relativePath in $script:NetariumReleaseManifest.Directories) {
        $path = Join-Path $root $relativePath
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            throw "Release directory is missing: $relativePath"
        }
    }

    foreach ($relativePath in $script:NetariumReleaseManifest.Files) {
        $path = Join-Path $root ($relativePath -replace '/', '\')
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Release file is missing: $relativePath"
        }
    }

    return [pscustomobject]@{
        Root = $root
        Directories = @($script:NetariumReleaseManifest.Directories)
        Files = @($script:NetariumReleaseManifest.Files)
    }
}

function Get-FileInventory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $absoluteRoot = ConvertTo-NetariumAbsolutePath -Path $Root
    if (-not (Test-Path -LiteralPath $absoluteRoot -PathType Container)) {
        throw "Inventory root does not exist: $absoluteRoot"
    }

    $prefixLength = $absoluteRoot.Length + 1
    $items = @(
        Get-ChildItem -LiteralPath $absoluteRoot -Recurse -File -Force |
            ForEach-Object {
                $relativePath = $_.FullName.Substring($prefixLength).Replace('\', '/')
                $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
                [pscustomobject]@{
                    RelativePath = $relativePath
                    Length = [int64]$_.Length
                    Sha256 = $hash
                }
            }
    )

    return @($items | Sort-Object RelativePath)
}


function Get-NetariumWebCollection {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PSPath,
        [Parameter(Mandatory = $true)]
        [string]$Filter,
        [string]$Location
    )

    $parameters = @{
        PSPath = $PSPath
        Filter = $Filter
        Name = '.'
        ErrorAction = 'Stop'
    }
    if (-not [string]::IsNullOrWhiteSpace($Location)) {
        $parameters.Location = $Location
    }

    try {
        foreach ($entry in @(Get-WebConfigurationProperty @parameters)) {
            if ($entry.PSObject.Properties.Name -contains 'Collection') {
                $entry.Collection
            } else {
                $entry
            }
        }
    } catch {
        return @()
    }
}

function Ensure-NetariumDefaultDocument {
    param([Parameter(Mandatory = $true)][string]$SiteName)

    $machinePath = 'MACHINE/WEBROOT/APPHOST'
    $filter = 'system.webServer/defaultDocument/files'
    Set-WebConfigurationProperty -PSPath $machinePath -Location $SiteName -Filter 'system.webServer/defaultDocument' -Name enabled -Value $true -ErrorAction Stop
    $documents = @(Get-NetariumWebCollection -PSPath $machinePath -Location $SiteName -Filter $filter)
    if (@($documents | Where-Object { [string]$_.value -ieq 'index.php' }).Count -eq 0) {
        # Keep the existing default-document order when adding the PHP entry point.
        Add-WebConfigurationProperty -PSPath $machinePath -Location $SiteName -Filter $filter -Name '.' -AtIndex $documents.Count -Value @{ value = 'index.php' } -ErrorAction Stop
    }
}

function Get-NetariumIisEnvironmentVariables {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PSPath,
        [Parameter(Mandatory = $true)]
        [string]$Filter
    )

    $result = @()
    foreach ($entry in Get-NetariumWebCollection -PSPath $PSPath -Filter $Filter) {
        $result += [pscustomobject]@{
            Name = [string]$entry.name
            Value = [string]$entry.value
        }
    }
    return @($result | Sort-Object Name)
}

function Get-IisState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SiteName,
        [Parameter(Mandatory = $true)]
        [string]$ApplicationPoolName,
        [string]$PhpCgiPath
    )

    Assert-WebAdministration
    $sitePath = "IIS:\Sites\$SiteName"
    $poolPath = "IIS:\AppPools\$ApplicationPoolName"
    $machinePath = 'MACHINE/WEBROOT/APPHOST'
    $site = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
    $siteLocationExists = @(Get-WebConfigurationLocation -Name $SiteName -PSPath $machinePath -ErrorAction Stop).Count -gt 0
    $pool = Get-Item $poolPath -ErrorAction SilentlyContinue

    $siteState = $null
    $siteBindings = @()
    $sitePhysicalPath = $null
    $siteApplicationPool = $null
    if ($site) {
        $siteState = [string](Get-WebSiteState -Name $SiteName).Value
        $sitePhysicalPath = [string]$site.PhysicalPath
        $siteApplicationPool = [string]$site.ApplicationPool
        $siteBindings = @(
            $site.Bindings.Collection |
                ForEach-Object {
                    [pscustomobject]@{
                        Protocol = [string]$_.protocol
                        BindingInformation = [string]$_.bindingInformation
                        SslFlags = [int]$_.sslFlags
                        CertificateHash = if ($_.certificateHash -is [byte[]]) {
                            [BitConverter]::ToString($_.certificateHash).Replace('-', '')
                        } else {
                            [string]$_.certificateHash
                        }
                        CertificateStoreName = [string]$_.certificateStoreName
                    }
                }
        )
    }
    $siteEnvironment = @(
        Get-NetariumWebCollection -PSPath $sitePath -Filter 'system.webServer/asp/environmentVariables/add' |
            ForEach-Object {
                [pscustomobject]@{
                    Name = [string]$_.name
                    Value = [string]$_.value
                }
            }
    )

    $poolState = $null
    $poolStartMode = $null
    $poolIdentity = $null
    $poolUserName = $null
    $poolPassword = $null
    if ($pool) {
        $poolState = [string](Get-WebAppPoolState -Name $ApplicationPoolName).Value
        $poolStartMode = [string]$pool.startMode
        $poolIdentity = [string]$pool.processModel.identityType
        $poolUserName = [string]$pool.processModel.userName
        $poolPassword = [string]$pool.processModel.password
    }

    $handler = @(
        Get-NetariumWebCollection -PSPath $machinePath -Location $SiteName -Filter 'system.webServer/handlers/add' |
            Where-Object {
                ([string]$_.path -eq '*.php') -or
                ([string]$_.name -like '*PHP*')
            } |
            ForEach-Object {
                [pscustomobject]@{
                    Name = [string]$_.name
                    Path = [string]$_.path
                    Verb = [string]$_.verb
                    Modules = [string]$_.modules
                    ScriptProcessor = [string]$_.scriptProcessor
                    ResourceType = [string]$_.resourceType
                    RequireAccess = [string]$_.requireAccess
                }
            }
    )

    $requestLimit = $null
    try {
        $requestLimit = Get-WebConfigurationProperty -PSPath $machinePath -Location $SiteName -Filter 'system.webServer/security/requestFiltering/requestLimits' -Name 'maxAllowedContentLength' -ErrorAction Stop
        if ($requestLimit.PSObject.Properties.Name -contains 'Value') {
            $requestLimit = [int64]$requestLimit.Value
        } else {
            $requestLimit = [int64]$requestLimit
        }
    } catch {
        $requestLimit = $null
    }

    $fastCgi = @(
        Get-NetariumWebCollection -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/fastCgi/application' |
            Where-Object {
                if ([string]::IsNullOrWhiteSpace($PhpCgiPath)) {
                    $true
                } else {
                    [string]$_.fullPath -ieq $PhpCgiPath
                }
            } |
            ForEach-Object {
                $application = $_
                $fastCgiEnvironment = @(Get-NetariumIisEnvironmentVariables -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter "system.webServer/fastCgi/application[@fullPath='$($application.fullPath)']/environmentVariables")
                [pscustomobject]@{
                    FullPath = [string]$application.fullPath
                    ActivityTimeout = [int]$application.activityTimeout
                    RequestTimeout = [int]$application.requestTimeout
                    InstanceMaxRequests = [int]$application.instanceMaxRequests
                    EnvironmentVariables = @($fastCgiEnvironment)
                }
            }
    )

    $poolEnvironment = Get-NetariumIisEnvironmentVariables -PSPath $machinePath -Filter "system.applicationHost/applicationPools/add[@name='$ApplicationPoolName']/environmentVariables/add"

    $defaultDocuments = @(
        Get-NetariumWebCollection -PSPath $machinePath -Location $SiteName -Filter 'system.webServer/defaultDocument/files' |
            ForEach-Object { [string]$_.value }
    )
    $phpFilters = @(
        Get-NetariumWebCollection -PSPath $machinePath -Location $SiteName -Filter 'system.webServer/security/requestFiltering/fileExtensions' |
            Where-Object { [string]$_.fileExtension -ieq '.php' } |
            ForEach-Object {
                [pscustomobject]@{
                    FileExtension = [string]$_.fileExtension
                    Allowed = [bool]$_.allowed
                }
            }
    )

    return [pscustomobject]@{
        SiteExists = [bool]$site
        SiteLocationExists = $siteLocationExists
        AppPoolExists = [bool]$pool
        SiteName = $SiteName
        ApplicationPoolName = $ApplicationPoolName
        PhpCgiPath = $PhpCgiPath
        Site = [pscustomobject]@{
            PhysicalPath = $sitePhysicalPath
            State = $siteState
            Bindings = @($siteBindings)
            ApplicationPool = $siteApplicationPool
            EnvironmentVariables = @($siteEnvironment)
        }
        AppPool = [pscustomobject]@{
            State = $poolState
            StartMode = $poolStartMode
            IdentityType = $poolIdentity
            UserName = $poolUserName
            Password = $poolPassword
            EnvironmentVariables = @($poolEnvironment)
        }
        Handler = @($handler)
        RequestLimit = $requestLimit
        FastCgi = @($fastCgi)
        DefaultDocuments = @($defaultDocuments)
        PhpFilters = @($phpFilters)
    }
}

function Get-NetariumMaintenancePaths {
    param([string]$InstallRoot)
    $root = (ConvertTo-NetariumAbsolutePath $InstallRoot).TrimEnd('\').ToUpperInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $id = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-', '') }
    finally { $sha.Dispose() }
    $directory = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('Netarium\maintenance\' + $id)
    return [pscustomobject]@{ Directory = $directory; Lock = (Join-Path $directory 'owner.lock'); Journal = (Join-Path $directory 'journal.json') }
}

function Enter-NetariumMaintenanceLock {
    param([string]$InstallRoot, [switch]$Recovery)
    Assert-Administrator
    $paths = Get-NetariumMaintenancePaths $InstallRoot
    New-NetariumPrivateDirectory $paths.Directory
    try { $stream = [IO.File]::Open($paths.Lock, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw "Another maintenance CLI owns this installation: $($paths.Lock)" }
    if (-not $Recovery -and (Test-Path -LiteralPath $paths.Journal)) {
        $stream.Dispose()
        throw "Unfinished maintenance journal. Run Repair-NetariumMaintenance -InstallRoot '$InstallRoot' after inspecting the failure; do not delete the journal."
    }
    return [pscustomobject]@{ Stream = $stream; Paths = $paths }
}

function Save-NetariumMaintenanceJournal {
    param($Maintenance)
    $path = $Maintenance.JournalPath
    $temporary = $path + '.new'
    Add-Type -AssemblyName System.Security
    $plain = [Text.Encoding]::UTF8.GetBytes(($Maintenance | ConvertTo-Json -Depth 16))
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
        $envelope = @{ Version = 1; Protected = [Convert]::ToBase64String($protected) } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($temporary, $envelope, (New-Object Text.UTF8Encoding($false)))
    } finally { [Array]::Clear($plain, 0, $plain.Length) }
    if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary, $path, [Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $path) }
}

function Read-NetariumMaintenanceJournal {
    param([string]$Path)
    Add-Type -AssemblyName System.Security
    $envelope = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    if ($envelope.Version -ne 1) { throw 'Unknown maintenance journal envelope.' }
    $plain = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($envelope.Protected), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    try { return ([Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json) }
    finally { [Array]::Clear($plain, 0, $plain.Length) }
}

function Get-NetariumMaintenanceConfiguration {
    $path = Join-Path $env:windir 'System32\inetsrv\config\applicationHost.config'
    $redirection = New-Object Xml.XmlDocument
    $redirection.Load((Join-Path $env:windir 'System32\inetsrv\config\redirection.config'))
    $redirect = $redirection.SelectSingleNode('/configuration/configurationRedirection')
    if ($redirect -and $redirect.GetAttribute('enabled') -eq 'true') { throw 'Shared IIS configuration is not supported for maintenance ownership.' }
    $xml = New-Object Xml.XmlDocument
    $xml.PreserveWhitespace = $false
    $xml.Load($path)
    return [pscustomobject]@{ Xml = $xml; SiteName = $null; Records = @() }
}

function Set-NetariumMaintenanceElement {
    param($Element, $Xml)
    foreach ($attribute in $Xml.Attributes) {
        $value = $attribute.Value
        switch ([string]$Element.GetAttribute($attribute.Name).Schema.Type) {
            'bool' { $value = [bool]::Parse($value) }
            'uint' { $value = [uint32]::Parse($value) }
            'int' { $value = [int32]::Parse($value) }
        }
        [void]$Element.SetAttributeValue($attribute.Name, $value)
    }
    foreach ($child in $Xml.ChildNodes) {
        if ($child -isnot [Xml.XmlElement]) { continue }
        if ($child.LocalName -in @('clear','remove','add','error')) {
            $collection = $Element.GetCollection()
            # MWA collections model clear, remove and add as directive elements.
            $entry = $collection.CreateElement($child.LocalName)
            [void](Set-NetariumMaintenanceElement $entry $child)
            [void]$collection.Add($entry)
        } else { [void](Set-NetariumMaintenanceElement ($Element.GetChildElement($child.LocalName)) $child) }
    }
}

function Write-NetariumMaintenanceConfiguration {
    param($Configuration)
    Add-Type -Path (Join-Path $env:windir 'System32\inetsrv\Microsoft.Web.Administration.dll')
    $current = Get-NetariumMaintenanceConfiguration
    $currentLocation = Get-NetariumMaintenanceLocation $current.Xml $Configuration.SiteName
    foreach ($record in $Configuration.Records) {
        $currentNode = if ($currentLocation) { Get-NetariumMaintenanceNode $currentLocation $record.Path } else { $null }
        $currentXml = if ($currentNode) { $currentNode.OuterXml } else { $null }
        if ($currentXml -cne $record.Expected) { throw "Concurrent IIS section change: $($record.Path)" }
    }
    # Phase 1: Revert all target sections to parent to clear local overrides cleanly.
    $manager = New-Object Microsoft.Web.Administration.ServerManager
    try {
        $config = $manager.GetApplicationHostConfiguration()
        foreach ($record in $Configuration.Records) {
            $section = $config.GetSection($record.Path, $Configuration.SiteName)
            [void]$section.RevertToParent()
        }
        [void]$manager.CommitChanges()
    } finally { [void]$manager.Dispose() }

    # Phase 2: If there are target nodes to install/restore, replay them on fresh section handles.
    $targetLocation = Get-NetariumMaintenanceLocation $Configuration.Xml $Configuration.SiteName
    $nodesToApply = @()
    foreach ($record in $Configuration.Records) {
        $node = if ($targetLocation) { Get-NetariumMaintenanceNode $targetLocation $record.Path } else { $null }
        if ($node) { $nodesToApply += @{ Record = $record; Node = $node } }
    }
    if ($nodesToApply.Count -gt 0) {
        $manager = New-Object Microsoft.Web.Administration.ServerManager
        try {
            $config = $manager.GetApplicationHostConfiguration()
            foreach ($item in $nodesToApply) {
                $section = $config.GetSection($item.Record.Path, $Configuration.SiteName)
                $materializer = switch ($item.Record.Path) {
                    'system.webServer/security/requestFiltering' { 'allowDoubleEscaping' }
                    'system.webServer/httpErrors' { 'errorMode' }
                    'system.webServer/httpProtocol' { 'allowKeepAlive' }
                }
                $value = $section.GetAttributeValue($materializer)
                [void]$section.SetAttributeValue($materializer, $value)
                [void](Set-NetariumMaintenanceElement $section $item.Node)
                if (-not $item.Node.HasAttribute($materializer)) { [void]$section.GetAttribute($materializer).Delete() }
            }
            [void]$manager.CommitChanges()
        } finally { [void]$manager.Dispose() }
    }
}

function Get-NetariumMaintenanceLocation {
    param($Xml, [string]$SiteName, [switch]$Create)
    $matches = @($Xml.DocumentElement.SelectNodes('location') | Where-Object { $_.GetAttribute('path') -ceq $SiteName })
    if ($matches.Count -gt 1) { throw 'Ambiguous IIS site location.' }
    if ($matches.Count) { return $matches[0] }
    if ($Create) {
        $node = $Xml.CreateElement('location'); $node.SetAttribute('path', $SiteName)
        [void]$Xml.DocumentElement.AppendChild($node)
        return $node
    }
    return $null
}

function Get-NetariumMaintenanceNode {
    param($Location, [string]$Path, [switch]$Create)
    $node = $Location
    foreach ($part in $Path.Split('/')) {
        $child = $node.SelectSingleNode($part)
        if (-not $child) {
            if (-not $Create) { return $null }
            $child = $node.OwnerDocument.CreateElement($part); [void]$node.AppendChild($child)
        }
        $node = $child
    }
    return $node
}

function Set-NetariumMaintenance {
    param([string]$SiteName, [string]$PublicRoot, [string]$ApplicationPoolName, $Lock)
    if (-not $Lock -or -not $Lock.Stream.CanWrite) { throw 'Maintenance ownership lock is required.' }
    Assert-NetariumMaintenanceRecoveryTarget -Maintenance ([pscustomobject]@{ SiteName = $SiteName; ApplicationPoolName = $ApplicationPoolName }) -PublicRoot $PublicRoot
    $siteState = [string](Get-WebSiteState -Name $SiteName).Value
    $poolState = [string](Get-WebAppPoolState -Name $ApplicationPoolName).Value
    if ($siteState -notin @('Started', 'Stopped') -or $poolState -notin @('Started', 'Stopped')) { throw 'IIS is transitioning.' }
    $operation = [Guid]::NewGuid().ToString('N')
    $token = [Guid]::NewGuid().ToString('N')
    $file = Join-Path $PublicRoot ("netarium-maintenance-$operation.json")
    $body = '{"ok":false,"error_code":"NETARIUM_MAINTENANCE_REJECTED","contract_version":1,"request_execution":"not_started","operation_id":"' + $operation + '"}'
    $configuration = Get-NetariumMaintenanceConfiguration
    $location = Get-NetariumMaintenanceLocation $configuration.Xml $SiteName -Create
    $original = @()
    foreach ($path in @('system.webServer/security/requestFiltering', 'system.webServer/httpErrors', 'system.webServer/httpProtocol')) {
        $node = Get-NetariumMaintenanceNode $location $path
        $original += [pscustomobject]@{ Path = $path; Original = $(if ($node) { $node.OuterXml } else { $null }); Expected = $(if ($node) { $node.OuterXml } else { $null }); Installed = $null }
    }
    $filters = Get-NetariumMaintenanceNode $location ($original[0].Path + '/fileExtensions') -Create
    # A local clear/remove overrides inherited entries without modifying the parent.
    foreach ($entry in @($filters.SelectNodes('*'))) {
        if ($entry.GetAttribute('fileExtension') -ieq '.php') { [void]$filters.RemoveChild($entry) }
    }
    $remove = $configuration.Xml.CreateElement('remove'); $remove.SetAttribute('fileExtension', '.php'); [void]$filters.AppendChild($remove)
    $add = $configuration.Xml.CreateElement('add'); $add.SetAttribute('fileExtension', '.php'); $add.SetAttribute('allowed', 'false'); [void]$filters.AppendChild($add)
    $errors = Get-NetariumMaintenanceNode $location $original[1].Path -Create
    $errors.SetAttribute('errorMode', 'Custom'); $errors.SetAttribute('existingResponse', 'Auto')
    foreach ($entry in @($errors.SelectNodes('*'))) {
        if ($entry.GetAttribute('statusCode') -eq '404' -and $entry.GetAttribute('subStatusCode') -eq '7') { [void]$errors.RemoveChild($entry) }
    }
    $remove = $configuration.Xml.CreateElement('remove'); $remove.SetAttribute('statusCode', '404'); $remove.SetAttribute('subStatusCode', '7'); [void]$errors.AppendChild($remove)
    $errorNode = $configuration.Xml.CreateElement('error')
    foreach ($pair in @(@('statusCode','404'), @('subStatusCode','7'), @('path',$file), @('responseMode','File'))) { $errorNode.SetAttribute($pair[0], $pair[1]) }
    [void]$errors.AppendChild($errorNode)
    $headers = Get-NetariumMaintenanceNode $location ($original[2].Path + '/customHeaders') -Create
    foreach ($entry in @($headers.SelectNodes('*'))) { if ($entry.GetAttribute('name') -ieq 'Cache-Control') { [void]$headers.RemoveChild($entry) } }
    $remove = $configuration.Xml.CreateElement('remove'); $remove.SetAttribute('name', 'Cache-Control'); [void]$headers.AppendChild($remove)
    $add = $configuration.Xml.CreateElement('add'); $add.SetAttribute('name', 'Cache-Control'); $add.SetAttribute('value', 'no-store'); [void]$headers.AppendChild($add)
    foreach ($record in $original) {
        $node = Get-NetariumMaintenanceNode $location $record.Path
        $record.Installed = $node.OuterXml
    }
    $maintenance = [pscustomobject]@{
        Version = 1; SiteName = $SiteName; ApplicationPoolName = $ApplicationPoolName
        SiteState = $siteState; PoolState = $poolState; OperationId = $operation; Token = $token
        OwnerPath = (Join-Path $Lock.Paths.Directory 'owner.token')
        File = $file; Body = $body; Sections = $original; JournalPath = $Lock.Paths.Journal; Phase = 'installing'
    }
    $configuration.SiteName = $SiteName; $configuration.Records = $original
    [IO.File]::WriteAllText($maintenance.OwnerPath, $token)
    Save-NetariumMaintenanceJournal $maintenance
    try {
        $stream = [IO.File]::Open($file, 'CreateNew', 'Write', 'Read')
        try { $bytes = [Text.Encoding]::UTF8.GetBytes($body); $stream.Write($bytes, 0, $bytes.Length) }
        finally { $stream.Dispose() }
        Write-NetariumMaintenanceConfiguration $configuration
        $committed = Get-NetariumMaintenanceConfiguration
        $committedLocation = Get-NetariumMaintenanceLocation $committed.Xml $SiteName
        foreach ($record in $original) { $record.Installed = (Get-NetariumMaintenanceNode $committedLocation $record.Path).OuterXml }
        $maintenance.Phase = 'blocked'; Save-NetariumMaintenanceJournal $maintenance
    } catch {
        Stop-NetariumSiteIfRunning $SiteName
        Stop-NetariumAppPoolIfRunning $ApplicationPoolName
        throw
    }
    return $maintenance
}

function Get-NetariumMaintenanceXmlSignature {
    param([AllowNull()][string]$Text)
    if (-not $Text) { return '' }
    $xml = New-Object Xml.XmlDocument; $xml.PreserveWhitespace = $false; $xml.LoadXml($Text)
    foreach ($remove in @($xml.SelectNodes('//remove'))) {
        foreach ($sibling in @($remove.ParentNode.ChildNodes)) {
            if ($sibling.LocalName -notin @('add','error')) { continue }
            $same = $true
            foreach ($attribute in $remove.Attributes) { if ($sibling.GetAttribute($attribute.Name) -ine $attribute.Value) { $same = $false } }
            # MWA omits a redundant remove when there is no inherited matching entry.
            if ($same) { [void]$remove.ParentNode.RemoveChild($remove); break }
        }
    }
    foreach ($node in @($xml.SelectNodes('//*'))) {
        $attributes = @($node.Attributes | Sort-Object Name | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Value = $_.Value } })
        $node.Attributes.RemoveAll()
        foreach ($attribute in $attributes) { $node.SetAttribute($attribute.Name, $attribute.Value) }
    }
    return $xml.OuterXml
}
function Remove-NetariumMaintenance {
    param($Maintenance)
    if ([IO.File]::ReadAllText($Maintenance.OwnerPath) -cne $Maintenance.Token) { throw 'Private ownership token mismatch.' }
    $configuration = Get-NetariumMaintenanceConfiguration
    $configuration.SiteName = $Maintenance.SiteName; $configuration.Records = $Maintenance.Sections
    $location = Get-NetariumMaintenanceLocation $configuration.Xml $Maintenance.SiteName
    if (-not $location) { $location = Get-NetariumMaintenanceLocation $configuration.Xml $Maintenance.SiteName -Create }
    # Validate all owned sections and the public payload before changing anything.
    foreach ($record in $Maintenance.Sections) {
        $node = Get-NetariumMaintenanceNode $location $record.Path
        $current = if ($node) { $node.OuterXml } else { $null }
        $record.Expected = $current
        if ((Get-NetariumMaintenanceXmlSignature $current) -cne (Get-NetariumMaintenanceXmlSignature $record.Installed) -and $current -cne $record.Original) { throw "IIS ownership conflict: $($record.Path). Leave stopped and resolve manually." }
    }
    if ((Test-Path -LiteralPath $Maintenance.File) -and [IO.File]::ReadAllText($Maintenance.File) -cne $Maintenance.Body) { throw 'Maintenance payload ownership conflict.' }
    foreach ($record in $Maintenance.Sections) {
        $node = Get-NetariumMaintenanceNode $location $record.Path
        if ($node -and (Get-NetariumMaintenanceXmlSignature $node.OuterXml) -ceq (Get-NetariumMaintenanceXmlSignature $record.Installed)) {
            if ($null -ne $record.Original) {
                $replacement = $configuration.Xml.CreateDocumentFragment(); $replacement.InnerXml = $record.Original
                [void]$node.ParentNode.ReplaceChild($replacement, $node)
            } else {
                $parent = $node.ParentNode; [void]$parent.RemoveChild($node)
                while ($parent -ne $location -and -not $parent.HasAttributes -and -not $parent.HasChildNodes) {
                    $empty = $parent; $parent = $parent.ParentNode; [void]$parent.RemoveChild($empty)
                }
            }
        }
    }
    Write-NetariumMaintenanceConfiguration $configuration
    if (Test-Path -LiteralPath $Maintenance.File) { Remove-Item -LiteralPath $Maintenance.File -Force }
    Save-NetariumMaintenanceJournal $Maintenance
}

function Resume-NetariumMaintenanceState {
    param($Maintenance)
    if ($Maintenance.PoolState -eq 'Started' -and [string](Get-WebAppPoolState -Name $Maintenance.ApplicationPoolName).Value -eq 'Stopped') { Start-WebAppPool -Name $Maintenance.ApplicationPoolName -ErrorAction Stop }
    if ($Maintenance.SiteState -eq 'Started' -and [string](Get-WebSiteState -Name $Maintenance.SiteName).Value -eq 'Stopped') { Start-Website -Name $Maintenance.SiteName -ErrorAction Stop }
}

function Complete-NetariumMaintenance {
    param($Maintenance)
    try {
        if ($Maintenance.Phase -notin @('blocked', 'effective')) {
            Stop-NetariumSiteIfRunning $Maintenance.SiteName
            Stop-NetariumAppPoolIfRunning $Maintenance.ApplicationPoolName
        }
        Remove-NetariumMaintenance $Maintenance
        Resume-NetariumMaintenanceState $Maintenance
        Remove-Item -LiteralPath $Maintenance.JournalPath -Force
        if (Test-Path -LiteralPath $Maintenance.OwnerPath) { Remove-Item -LiteralPath $Maintenance.OwnerPath -Force }
    } catch {
        Stop-NetariumSiteIfRunning $Maintenance.SiteName
        Stop-NetariumAppPoolIfRunning $Maintenance.ApplicationPoolName
        throw
    }
}

function Assert-NetariumMaintenanceRecoveryTarget {
    param([string]$InstallRoot, $Maintenance, [string]$PublicRoot)
    $site = Get-Website -Name $Maintenance.SiteName -ErrorAction Stop
    $targetPublic = if ($PublicRoot) { $PublicRoot } else { Join-Path $InstallRoot 'public' }
    $expected = [IO.Path]::GetFullPath($targetPublic).TrimEnd('\')
    if (-not $site -or [string]$site.Name -ine $Maintenance.SiteName -or
        [string]$site.ApplicationPool -ine $Maintenance.ApplicationPoolName -or
        [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$site.PhysicalPath)).TrimEnd('\') -ine $expected) {
        throw 'Maintenance recovery target was reassigned; no IIS resource was stopped or changed.'
    }
    if ([string](Get-WebSiteState -Name $Maintenance.SiteName).Value -notin @('Started','Stopped') -or
        [string](Get-WebAppPoolState -Name $Maintenance.ApplicationPoolName).Value -notin @('Started','Stopped')) { throw 'Recovery target is missing or transitioning.' }
    foreach ($candidate in @(Get-Website -ErrorAction Stop)) {
        if ([string]$candidate.Name -ine $Maintenance.SiteName -and [string]$candidate.ApplicationPool -ieq $Maintenance.ApplicationPoolName) {
            throw 'Recovery pool is shared by another site; no IIS resource was stopped or changed.'
        }
        foreach ($application in @(Get-WebApplication -Site $candidate.Name -ErrorAction Stop)) {
            if ([string]$application.ApplicationPool -ieq $Maintenance.ApplicationPoolName -or [string]$candidate.Name -ieq $Maintenance.SiteName) {
                throw 'Recovery target has an additional application boundary; no IIS resource was stopped or changed.'
            }
        }
    }
}

function Repair-NetariumMaintenance {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$InstallRoot, [switch]$DataSafetyConfirmed)
    $lock = Enter-NetariumMaintenanceLock $InstallRoot -Recovery
    try {
        Assert-WebAdministration
        $maintenance = Read-NetariumMaintenanceJournal $lock.Paths.Journal
        if ($maintenance.Version -ne 1 -or $maintenance.JournalPath -cne $lock.Paths.Journal -or
            $maintenance.Token -notmatch '^[a-f0-9]{32}$' -or $maintenance.Sections.Count -ne 3) { throw 'Invalid maintenance journal.' }
        if ($maintenance.OwnerPath -cne (Join-Path $lock.Paths.Directory 'owner.token') -or
            $maintenance.SiteState -notin @('Started','Stopped') -or $maintenance.PoolState -notin @('Started','Stopped') -or
            ($maintenance.Sections.Path -join '|') -cne 'system.webServer/security/requestFiltering|system.webServer/httpErrors|system.webServer/httpProtocol') { throw 'Invalid maintenance ownership/state journal.' }
        Assert-NetariumMaintenanceRecoveryTarget $InstallRoot $maintenance
        if ($maintenance.Phase -eq 'mutating' -and -not $DataSafetyConfirmed) {
            Stop-NetariumSiteIfRunning $maintenance.SiteName
            Stop-NetariumAppPoolIfRunning $maintenance.ApplicationPoolName
            throw 'Data mutation was interrupted. Restore/check data while stopped, then explicitly pass -DataSafetyConfirmed; journal alone cannot certify data safety.'
        }
        Complete-NetariumMaintenance $maintenance
    } finally { $lock.Stream.Dispose() }
}

function Wait-NetariumMaintenanceReady {
    param($Maintenance, [string[]]$VerificationUrl, [int]$TimeoutSeconds = 30)
    if ($Maintenance.SiteState -ne 'Started' -or $Maintenance.PoolState -ne 'Started') { return }
    if (-not $VerificationUrl.Count) { throw 'Started site/pool requires -VerificationUrl for every HTTP(S) binding.' }
    if (@(Get-WebApplication -Site $Maintenance.SiteName -ErrorAction Stop).Count) { throw 'Nested IIS applications require separate maintenance boundaries; refusing site-wide operation.' }
    $site = Get-Website -Name $Maintenance.SiteName -ErrorAction Stop
    $bindings = @($site.Bindings.Collection)
    $covered = @{}
    foreach ($url in $VerificationUrl) {
        $uri = $null
        if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http','https') -or
            $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'VerificationUrl must be an absolute HTTP(S) site-root URL without credentials/query/fragment.' }
        $matched = $false
        for ($i = 0; $i -lt $bindings.Count; $i++) {
            $binding = $bindings[$i]
            if ([string]$binding.bindingInformation -notmatch '^(.*):([0-9]+):(.*)$') { throw 'Unsupported IIS binding.' }
            $address = $Matches[1]; $port = [int]$Matches[2]; $hostName = $Matches[3]
            if ([string]$binding.protocol -eq $uri.Scheme -and $port -eq $uri.Port -and
                (($hostName -and $hostName -ieq $uri.DnsSafeHost) -or
                 (-not $hostName -and (($address -in @('*','0.0.0.0','[::]') -and $uri.IsLoopback) -or $address.Trim('[',']') -eq $uri.DnsSafeHost)))) {
                $covered[$i] = $true; $matched = $true
            }
        }
        if (-not $matched) { throw "VerificationUrl is not a safely matched site binding: $url" }
    }
    if ($covered.Count -ne $bindings.Count) { throw 'Supply VerificationUrl for every site binding; unsupported bindings cannot be silently skipped.' }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            foreach ($url in $VerificationUrl) { Assert-NetariumMaintenanceProbe -BaseUrl $url -Maintenance $Maintenance }
            $Maintenance.Phase = 'effective'; Save-NetariumMaintenanceJournal $Maintenance
            return
        } catch { $failure = $_ }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Maintenance did not become effective: $($failure.Exception.Message)"
}

function Wait-NetariumRequestDrain {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ApplicationPoolName,
        [int]$TimeoutSeconds = 120,
        [int]$PollMilliseconds = 500
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $requests = @(
            Get-WebRequest -AppPool $ApplicationPoolName -ErrorAction Stop
        )
        if ($requests.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "IIS request drain timed out for app pool: $ApplicationPoolName"
}

function New-NetariumPrivateDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    New-Item -ItemType Directory -Path $Path -Force -ErrorAction Stop | Out-Null
    Set-NetariumPrivateAcl -Path $Path
}

function Set-NetariumPrivateAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ApplicationPoolName,
        [System.Security.AccessControl.FileSystemRights]$PoolRights = [System.Security.AccessControl.FileSystemRights]::Modify
    )

    $item = Microsoft.PowerShell.Management\Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Confidential storage must not contain reparse points.'
    }
    $acl = if ($item.PSIsContainer) {
        New-Object System.Security.AccessControl.DirectorySecurity
    } else {
        New-Object System.Security.AccessControl.FileSecurity
    }
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = if ($item.PSIsContainer) {
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [System.Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            (New-Object System.Security.Principal.SecurityIdentifier($sid)),
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inherit,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )))
    }
    if ($ApplicationPoolName) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            "IIS AppPool\$ApplicationPoolName",
            $PoolRights,
            $inherit,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )))
    }
    $acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    Set-Acl -LiteralPath $item.FullName -AclObject $acl -ErrorAction Stop
    $verifiedOwner = (Get-Acl -LiteralPath $item.FullName).GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($null -eq $verifiedOwner -or $verifiedOwner.Value -ne 'S-1-5-32-544') {
        throw "Failed to enforce Administrators ownership on confidential path: $($item.FullName)"
    }
    if ($item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop)) {
            $childPool = if ($child.Name -eq 'bootstrap') { '' } else { $ApplicationPoolName }
            Set-NetariumPrivateAcl -Path $child.FullName -ApplicationPoolName $childPool -PoolRights $PoolRights
        }
    }
}

function Protect-NetariumPoolPassword {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Password)

    Add-Type -AssemblyName System.Security
    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @{ Password = $Password } -Compress))
    try {
        return ,([System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        ))
    } catch {
        throw [System.Security.Cryptography.CryptographicException]::new('Cannot protect the rollback pool credential with machine DPAPI.')
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Unprotect-NetariumPoolPassword {
    param([Parameter(Mandatory = $true)][byte[]]$Ciphertext)

    Add-Type -AssemblyName System.Security
    $bytes = $null
    try {
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $Ciphertext, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        )
        return ([System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json).Password
    } catch {
        throw [System.Security.Cryptography.CryptographicException]::new('Cannot decrypt the rollback pool credential on this host; restore was not started.')
    } finally {
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

function Set-NetariumBootstrapAcl {
    param([Parameter(Mandatory = $true)][string]$StorageDir)

    $directory = Join-Path (ConvertTo-NetariumAbsolutePath -Path $StorageDir) 'bootstrap'
    New-NetariumPrivateDirectory -Path $directory
}

function Set-NetariumPasswordBlocklistAcl {
    param([Parameter(Mandatory = $true)][string]$StorageDir, [Parameter(Mandatory = $true)][string]$ApplicationPoolName)

    # 親のDELETE_CHILDとstorage自体のDELETEからも辞書の差替えを防ぐ。
    $acl = Get-Acl -LiteralPath $StorageDir
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        "IIS AppPool\$ApplicationPoolName",
        ([System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles),
        [System.Security.AccessControl.InheritanceFlags]::None,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Deny
    )))
    Set-Acl -LiteralPath $StorageDir -AclObject $acl -ErrorAction Stop
    $directory = Join-Path $StorageDir 'password-blocklist'
    if (Test-Path -LiteralPath $directory) {
        Set-NetariumPrivateAcl -Path $directory -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    }
    $manifestPath = Join-Path $StorageDir 'password-blocklist.json'
    if (Test-Path -LiteralPath $manifestPath) {
        Set-NetariumPrivateAcl -Path $manifestPath -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    }
}

function Set-NetariumAcl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,
        [Parameter(Mandatory = $true)]
        [string]$StorageDir,
        [Parameter(Mandatory = $true)]
        [string]$ApplicationPoolName
    )

    $root = ConvertTo-NetariumAbsolutePath -Path $InstallRoot
    $data = ConvertTo-NetariumAbsolutePath -Path $StorageDir
    $identity = "IIS AppPool\$ApplicationPoolName"
    $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $readExecute = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    $writeRights = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    $broadSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-568')

    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "Install root does not exist for ACL setup: $root"
    }
    if (-not (Test-Path -LiteralPath $data -PathType Container)) {
        throw "Storage directory does not exist for ACL setup: $data"
    }

    $protectedPaths = @(
        $root,
        (Join-Path $root 'public'),
        (Join-Path $root 'src'),
        (Join-Path $root 'templates'),
        (Join-Path $root 'resources'),
        (Join-Path $root 'scripts')
    )

    foreach ($path in @($protectedPaths | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            continue
        }

        $acl = Get-Acl -LiteralPath $path
        if (-not $acl.AreAccessRulesProtected) {
            $acl.SetAccessRuleProtection($true, $true)
            # Persist explicit inherited ACEs to the filesystem before removing broad write access.
            Set-Acl -LiteralPath $path -AclObject $acl
            $acl = Get-Acl -LiteralPath $path
        }

        foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.NTAccount]))) {
            $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
            if (
                $rule.AccessControlType -eq $allow -and
                (([string]$rule.IdentityReference -ieq $identity) -or $sid -in $broadSids) -and
                (($rule.FileSystemRights -band $writeRights) -ne 0)
            ) {
                $acl.RemoveAccessRuleSpecific($rule)
            }
        }

        $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $readExecute, $inherit, $propagation, $allow)))
        Set-Acl -LiteralPath $path -AclObject $acl
    }
    Set-NetariumPrivateAcl -Path $data -ApplicationPoolName $ApplicationPoolName
    $config = Join-Path $root 'config'
    if (Test-Path -LiteralPath $config -PathType Container) {
        Set-NetariumPrivateAcl -Path $config -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    }
    # Apply last: storage Modify inheritance must never expose bootstrap copies.
    Set-NetariumBootstrapAcl -StorageDir $data
    # 追加辞書は任意配置。storageのModifyを最後に必ず遮断する。
    Set-NetariumPasswordBlocklistAcl -StorageDir $data -ApplicationPoolName $ApplicationPoolName
}

function Copy-NetariumDirectoryContents {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Snapshot source directory does not exist: $Source"
    }

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $children = @(Get-ChildItem -LiteralPath $Source -Force)
    foreach ($child in $children) {
        Copy-Item -LiteralPath $child.FullName -Destination (Join-Path $Destination $child.Name) -Recurse -Force -ErrorAction Stop
    }
}

function New-NetariumSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RollbackRoot,
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,
        [Parameter(Mandatory = $true)]
        [string]$StorageDir,
        [Parameter(Mandatory = $true)]
        [string]$SiteName,
        [Parameter(Mandatory = $true)]
        [string]$ApplicationPoolName,
        [Parameter(Mandatory = $true)]
        [string]$Stage,
        [string]$PhpCgiPath,
        [int]$DatabaseSchemaVersion = 0,
        [psobject]$IisState = $null
    )

    $rollbackRootPath = ConvertTo-NetariumAbsolutePath -Path $RollbackRoot
    $installRootPath = ConvertTo-NetariumAbsolutePath -Path $InstallRoot
    $storagePath = ConvertTo-NetariumAbsolutePath -Path $StorageDir
    $installRootExisted = Test-Path -LiteralPath $installRootPath -PathType Container
    $existingInstallDirectories = @(
        $script:NetariumManagedInstallDirectories | Where-Object {
            Test-Path -LiteralPath (Join-Path $installRootPath $_) -PathType Container
        }
    )
    New-NetariumPrivateDirectory -Path $rollbackRootPath

    $snapshotName = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff')
    $snapshotPath = Join-Path $rollbackRootPath $snapshotName
    $suffix = 0
    while (Test-Path -LiteralPath $snapshotPath) {
        $suffix++
        $snapshotPath = Join-Path $rollbackRootPath ($snapshotName + '-' + $suffix)
    }

    New-NetariumPrivateDirectory -Path $snapshotPath
    $programPath = Join-Path $snapshotPath 'program'
    $dbSnapshotPath = Join-Path $snapshotPath 'data/db'
    $uploadsSnapshotPath = Join-Path $snapshotPath 'data/uploads'
    $backupsSnapshotPath = Join-Path $snapshotPath 'data/backups'
    $logsSnapshotPath = Join-Path $snapshotPath 'data/logs'
    $tempSnapshotPath = Join-Path $snapshotPath 'data/temp'
    $configSnapshotPath = Join-Path $snapshotPath 'config'
    New-Item -ItemType Directory -Path $programPath -Force | Out-Null
    New-Item -ItemType Directory -Path $dbSnapshotPath -Force | Out-Null
    New-Item -ItemType Directory -Path $uploadsSnapshotPath -Force | Out-Null
    New-Item -ItemType Directory -Path $backupsSnapshotPath -Force | Out-Null
    New-Item -ItemType Directory -Path $logsSnapshotPath -Force | Out-Null
    New-Item -ItemType Directory -Path $tempSnapshotPath -Force | Out-Null
    New-Item -ItemType Directory -Path $configSnapshotPath -Force | Out-Null

    $sourceRoot = $installRootPath
    $programItems = @()
    foreach ($relativePath in $script:NetariumReleaseManifest.Directories) {
        $source = Join-Path $sourceRoot $relativePath
        if (Test-Path -LiteralPath $source -PathType Container) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $programPath $relativePath) -Recurse -Force -ErrorAction Stop
        }
        $programItems += $relativePath
    }
    foreach ($relativePath in @($script:NetariumReleaseManifest.Files) + @($script:NetariumReleaseManifest.RetiredFiles)) {
        $relativeWindowsPath = $relativePath -replace '/', '\'
        $source = Join-Path $sourceRoot $relativeWindowsPath
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            $destination = Join-Path $programPath $relativeWindowsPath
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop
        }
        $programItems += $relativePath
    }
    $snapshotOfflinePath = Join-Path $programPath 'public/app_offline.htm'
    if (Test-Path -LiteralPath $snapshotOfflinePath -PathType Leaf) {
        Remove-Item -LiteralPath $snapshotOfflinePath -Force -ErrorAction Stop
    }

    $runtimeSource = $storagePath

    foreach ($relativePath in @('db', 'uploads', 'backups', 'logs', 'temp')) {
        $source = Join-Path $runtimeSource $relativePath
        $destination = Join-Path $snapshotPath ('data/' + $relativePath)
        if (Test-Path -LiteralPath $source -PathType Container) {
            Copy-NetariumDirectoryContents -Source $source -Destination $destination
        }
    }

    $appConfig = Join-Path $sourceRoot 'config/app.php'
    $configExists = Test-Path -LiteralPath $appConfig -PathType Leaf
    if ($configExists) {
        Copy-Item -LiteralPath $appConfig -Destination (Join-Path $configSnapshotPath 'app.php') -Force -ErrorAction Stop
    }

    $iisState = $IisState
    if ($null -eq $iisState) {
        $iisState = Get-IisState -SiteName $SiteName -ApplicationPoolName $ApplicationPoolName -PhpCgiPath $PhpCgiPath
    }
    # Clone before redacting: callers still need the captured state for failure recovery.
    $savedIis = $iisState | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    $poolPasswordProtection = $null
    $hasAppPoolPassword = $savedIis -and
        $savedIis.PSObject.Properties['AppPool'] -and
        $savedIis.AppPool -and
        $savedIis.AppPool.PSObject.Properties['Password'] -and
        $null -ne $savedIis.AppPool.Password
    if ($hasAppPoolPassword) {
        [System.IO.File]::WriteAllBytes(
            (Join-Path $snapshotPath 'iis-secrets.bin'),
            (Protect-NetariumPoolPassword -Password ([string]$savedIis.AppPool.Password))
        )
        $savedIis.AppPool.Password = $null
        $poolPasswordProtection = 'DPAPI-LocalMachine'
    }
    $programInventory = Get-FileInventory -Root $programPath
    $dbInventory = Get-FileInventory -Root $dbSnapshotPath
    $uploadsInventory = Get-FileInventory -Root $uploadsSnapshotPath
    $runtimeInventory = [ordered]@{}
    foreach ($relativePath in @('db', 'uploads', 'backups', 'logs', 'temp')) {
        $runtimeInventory[$relativePath] = @(Get-FileInventory -Root (Join-Path $snapshotPath ('data/' + $relativePath)))
    }
    $configInventory = @()
    if ($configExists) {
        $configInventory = Get-FileInventory -Root $configSnapshotPath
    }
    $aclInventory = @(
        foreach ($name in @('', 'public', 'src', 'templates', 'resources', 'scripts', 'config', 'StorageDir')) {
            $path = if ($name -eq 'StorageDir') { $storagePath } elseif ($name) { Join-Path $installRootPath $name } else { $installRootPath }
            if (Test-Path -LiteralPath $path -PathType Container) {
                [pscustomobject]@{
                    Name = $name
                    Sddl = (Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
                }
            }
        }
    )

    $manifest = [ordered]@{
        Version = 2
        CreatedUtc = [DateTime]::UtcNow.ToString('o')
        Stage = $Stage
        SourcePath = $sourceRoot
        TargetPath = $installRootPath
        StoragePath = $storagePath
        SnapshotPath = $snapshotPath
        InstallRootExisted = [bool]$installRootExisted
        ExistingInstallDirectories = @($existingInstallDirectories)
        Acl = @($aclInventory)
        SiteName = $SiteName
        ApplicationPoolName = $ApplicationPoolName
        ProgramItems = @($programItems)
        ProgramInventory = @($programInventory)
        DatabaseInventory = @($dbInventory)
        ImageInventory = @($uploadsInventory)
        ConfigInventory = @($configInventory)
        RuntimeInventory = $runtimeInventory
        DatabaseSchemaVersion = $DatabaseSchemaVersion
        ConfigAppExists = [bool]$configExists
        SiteExists = [bool]$iisState.SiteExists
        AppPoolExists = [bool]$iisState.AppPoolExists
        PoolPasswordProtection = $poolPasswordProtection
        Iis = $savedIis
    }

    $manifestPath = Join-Path $snapshotPath 'manifest.json'
    $manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestPath -Encoding UTF8 -ErrorAction Stop
    Set-NetariumPrivateAcl -Path $snapshotPath
    return $snapshotPath
}

function Stop-NetariumSiteIfRunning {
    param(
        [Parameter(Mandatory = $true)][string]$SiteName,
        [int]$TimeoutSeconds = 30
    )

    if (-not (Get-Website -Name $SiteName -ErrorAction SilentlyContinue)) {
        return
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $state = [string](Get-WebSiteState -Name $SiteName).Value
        if ($state -eq 'Stopped') {
            return
        }
        if ($state -eq 'Started') {
            Stop-Website -Name $SiteName -ErrorAction Stop
            $state = [string](Get-WebSiteState -Name $SiteName).Value
            if ($state -eq 'Stopped') {
                return
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)

    $finalState = [string](Get-WebSiteState -Name $SiteName).Value
    if ($finalState -ne 'Stopped') {
        throw "Failed to stop site '$SiteName' (current state: $finalState)."
    }
}

function Stop-NetariumAppPoolIfRunning {
    param(
        [Parameter(Mandatory = $true)][string]$ApplicationPoolName,
        [int]$TimeoutSeconds = 30
    )

    if (-not (Test-Path -LiteralPath "IIS:\AppPools\$ApplicationPoolName")) {
        return
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $state = [string](Get-WebAppPoolState -Name $ApplicationPoolName).Value
        if ($state -eq 'Stopped') {
            return
        }
        if ($state -eq 'Started') {
            Stop-WebAppPool -Name $ApplicationPoolName -ErrorAction Stop
            $state = [string](Get-WebAppPoolState -Name $ApplicationPoolName).Value
            if ($state -eq 'Stopped') {
                return
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)

    $finalState = [string](Get-WebAppPoolState -Name $ApplicationPoolName).Value
    if ($finalState -ne 'Stopped') {
        throw "Failed to stop application pool '$ApplicationPoolName' (current state: $finalState)."
    }
}
function Restore-NetariumIisState {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$State,
        [switch]$KeepStopped,
        [switch]$KeepRequestFiltering,
        [switch]$KeepDefaultDocument
    )

    Assert-WebAdministration
    $sitePath = "IIS:\Sites\$($State.SiteName)"
    $poolPath = "IIS:\AppPools\$($State.ApplicationPoolName)"
    $machinePath = 'MACHINE/WEBROOT/APPHOST'

    if (-not $State.SiteExists) {
        $site = Get-Website -Name $State.SiteName -ErrorAction SilentlyContinue
        if ($site) {
            Stop-NetariumSiteIfRunning -SiteName $State.SiteName
        }
        $siteLocations = @(Get-WebConfigurationLocation -Name $State.SiteName -PSPath $machinePath -ErrorAction Stop)
        if (-not $State.Iis.PSObject.Properties['SiteLocationExists'] -and $siteLocations.Count -gt 0) {
            throw 'Rollback snapshot has no record of the original IIS site location; existing configuration was preserved for manual recovery.'
        }
        if ($State.Iis.PSObject.Properties['SiteLocationExists'] -and -not $State.Iis.SiteLocationExists -and $siteLocations.Count -gt 0) {
            Remove-WebConfigurationLocation -Name $State.SiteName -PSPath $machinePath -ErrorAction Stop
        }
        if ($site) {
            Remove-Website -Name $State.SiteName -ErrorAction Stop
        }
    }
    if (-not $State.AppPoolExists) {
        if (Test-Path -LiteralPath $poolPath) {
            Stop-NetariumAppPoolIfRunning -ApplicationPoolName $State.ApplicationPoolName
            Remove-WebAppPool -Name $State.ApplicationPoolName -ErrorAction Stop
        }
    } else {
        if (-not (Test-Path -LiteralPath $poolPath)) {
            New-WebAppPool -Name $State.ApplicationPoolName -ErrorAction Stop | Out-Null
        }
        $hasAppPool = $State.Iis -and $State.Iis.PSObject.Properties['AppPool'] -and $State.Iis.AppPool
        if ($hasAppPool) {
            if ($State.Iis.AppPool.PSObject.Properties['StartMode'] -and $State.Iis.AppPool.StartMode) {
                Set-ItemProperty -LiteralPath $poolPath -Name startMode -Value $State.Iis.AppPool.StartMode -ErrorAction Stop
            }
            if ($State.Iis.AppPool.PSObject.Properties['IdentityType'] -and $State.Iis.AppPool.IdentityType) {
                Set-ItemProperty -LiteralPath $poolPath -Name processModel.identityType -Value $State.Iis.AppPool.IdentityType -ErrorAction Stop
            }
            if ($State.Iis.AppPool.PSObject.Properties['UserName'] -and $null -ne $State.Iis.AppPool.UserName) {
                Set-ItemProperty -LiteralPath $poolPath -Name processModel.userName -Value $State.Iis.AppPool.UserName -ErrorAction Stop
            }
            if ($State.Iis.AppPool.PSObject.Properties['Password'] -and $null -ne $State.Iis.AppPool.Password) {
                Set-ItemProperty -LiteralPath $poolPath -Name processModel.password -Value $State.Iis.AppPool.Password -ErrorAction Stop
            }
        }
    }

    if ($State.SiteExists) {
        if (-not (Get-Website -Name $State.SiteName -ErrorAction SilentlyContinue)) {
            $savedBindings = @($State.Iis.Site.Bindings)
            if ($savedBindings.Count -eq 0 -or [string]$savedBindings[0].BindingInformation -notmatch '^(.*):([0-9]+):(.*)$') {
                throw 'Cannot recreate an IIS site without a saved binding.'
            }
            New-Website -Name $State.SiteName -PhysicalPath $State.Iis.Site.PhysicalPath -ApplicationPool $State.ApplicationPoolName -IPAddress $Matches[1] -Port ([int]$Matches[2]) -HostHeader $Matches[3] -Force -ErrorAction Stop | Out-Null
        }
        Set-ItemProperty -LiteralPath $sitePath -Name physicalPath -Value $State.Iis.Site.PhysicalPath -ErrorAction Stop
        if ($State.Iis.Site.ApplicationPool) {
            Set-ItemProperty -LiteralPath $sitePath -Name applicationPool -Value $State.Iis.Site.ApplicationPool -ErrorAction Stop
        }

        foreach ($binding in @(Get-WebBinding -Name $State.SiteName -ErrorAction SilentlyContinue)) {
            Remove-WebConfigurationProperty -PSPath $machinePath -Filter "system.applicationHost/sites/site[@name='$($State.SiteName)']/bindings" -Name '.' -AtElement @{ protocol = [string]$binding.protocol; bindingInformation = [string]$binding.bindingInformation } -ErrorAction Stop
        }
        foreach ($binding in @($State.Iis.Site.Bindings)) {
            if (-not $binding) {
                continue
            }
            if ([string]$binding.BindingInformation -notmatch '^(.*):([0-9]+):(.*)$') {
                throw 'Snapshot contains invalid IIS binding information.'
            }
            $bindingOptions = @{
                Name = $State.SiteName
                Protocol = [string]$binding.Protocol
                IPAddress = $Matches[1]
                Port = [int]$Matches[2]
                HostHeader = $Matches[3]
                ErrorAction = 'Stop'
            }
            if ($binding.Protocol -eq 'https') {
                $bindingOptions.SslFlags = [int]$binding.SslFlags
            }
            New-WebBinding @bindingOptions | Out-Null
            if ($binding.Protocol -eq 'https' -and $binding.CertificateHash) {
                $restoredBinding = Get-WebBinding -Name $State.SiteName -Protocol https -BindingInformation ([string]$binding.BindingInformation) -ErrorAction Stop
                $storeName = if ($binding.CertificateStoreName) { [string]$binding.CertificateStoreName } else { 'My' }
                $restoredBinding.AddSslCertificate([string]$binding.CertificateHash, $storeName)
            }
        }
    }

    if ($State.SiteExists) {
        $siteEnvironmentFilter = 'system.webServer/asp/environmentVariables/add'
        $siteEnvironment = @(Get-NetariumWebCollection -PSPath $sitePath -Filter $siteEnvironmentFilter)
        foreach ($entry in $siteEnvironment) {
            if ($entry.name) {
                Remove-WebConfigurationProperty -PSPath $sitePath -Filter $siteEnvironmentFilter -Name '.' -AtElement @{ name = [string]$entry.name } -ErrorAction Stop
            }
        }
        foreach ($entry in @($State.Iis.Site.EnvironmentVariables)) {
            if ($entry -and $entry.Name) {
                Add-WebConfigurationProperty -PSPath $sitePath -Filter $siteEnvironmentFilter -Name '.' -Value @{ name = [string]$entry.Name; value = [string]$entry.Value } -ErrorAction Stop
            }
        }
    }

    if ($State.AppPoolExists) {
        $poolEnvironmentFilter = "system.applicationHost/applicationPools/add[@name='$($State.ApplicationPoolName)']/environmentVariables/add"
        $poolEnvironment = @(Get-NetariumWebCollection -PSPath $machinePath -Filter $poolEnvironmentFilter)
        foreach ($entry in $poolEnvironment) {
            if ($entry.name) {
                Remove-WebConfigurationProperty -PSPath $machinePath -Filter $poolEnvironmentFilter -Name '.' -AtElement @{ name = [string]$entry.name } -ErrorAction Stop
            }
        }
        $hasPoolEnv = $State.Iis -and $State.Iis.PSObject.Properties['AppPool'] -and
            $State.Iis.AppPool -and $State.Iis.AppPool.PSObject.Properties['EnvironmentVariables']
        if ($hasPoolEnv) {
            foreach ($entry in @($State.Iis.AppPool.EnvironmentVariables)) {
                if ($entry -and $entry.Name) {
                    Add-WebConfigurationProperty -PSPath $machinePath -Filter $poolEnvironmentFilter -Name '.' -Value @{ name = [string]$entry.Name; value = [string]$entry.Value } -ErrorAction Stop
                }
            }
        }
    }

    if ($State.SiteExists) {
        $handlerFilter = 'system.webServer/handlers/add'
        foreach ($handler in @(Get-NetariumWebCollection -PSPath $machinePath -Location $State.SiteName -Filter $handlerFilter | Where-Object { [string]$_.path -eq '*.php' })) {
            if ($handler.name) {
                Remove-WebConfigurationProperty -PSPath $machinePath -Location $State.SiteName -Filter 'system.webServer/handlers' -Name '.' -AtElement @{ name = [string]$handler.name } -ErrorAction Stop
            }
        }
        foreach ($handler in @($State.Iis.Handler)) {
            if ($handler -and $handler.Path) {
                Add-WebConfigurationProperty -PSPath $machinePath -Location $State.SiteName -Filter 'system.webServer/handlers' -Name '.' -Value @{
                    name = [string]$handler.Name
                    path = [string]$handler.Path
                    verb = [string]$handler.Verb
                    modules = [string]$handler.Modules
                    scriptProcessor = [string]$handler.ScriptProcessor
                    resourceType = [string]$handler.ResourceType
                    requireAccess = [string]$handler.RequireAccess
                } -ErrorAction Stop
            }
        }

        if (-not $KeepRequestFiltering -and $null -ne $State.Iis.RequestLimit) {
            Set-WebConfigurationProperty -PSPath $machinePath -Location $State.SiteName -Filter 'system.webServer/security/requestFiltering/requestLimits' -Name maxAllowedContentLength -Value ([int64]$State.Iis.RequestLimit) -ErrorAction Stop
        }
    }

    $fastCgiCollectionFilter = 'system.webServer/fastCgi'
    $fastCgiFilter = 'system.webServer/fastCgi/application'
    $savedFastCgi = @($State.Iis.FastCgi)
    $currentFastCgi = @(Get-NetariumWebCollection -PSPath $machinePath -Filter $fastCgiFilter)
    if ($savedFastCgi.Count -eq 0 -and $State.Iis.PhpCgiPath) {
        foreach ($application in @($currentFastCgi | Where-Object { [string]$_.fullPath -ieq [string]$State.Iis.PhpCgiPath })) {
            Remove-WebConfigurationProperty -PSPath $machinePath -Filter $fastCgiCollectionFilter -Name '.' -AtElement @{ fullPath = [string]$application.fullPath } -ErrorAction Stop
        }
    } else {
        foreach ($application in $savedFastCgi) {
            $filter = "system.webServer/fastCgi/application[@fullPath='$($application.FullPath)']"
            $current = @(Get-NetariumWebCollection -PSPath $machinePath -Filter $filter)
            if ($current.Count -eq 0) {
                Add-WebConfigurationProperty -PSPath $machinePath -Filter $fastCgiCollectionFilter -Name '.' -Value @{ fullPath = [string]$application.FullPath; activityTimeout = [int]$application.ActivityTimeout; requestTimeout = [int]$application.RequestTimeout; instanceMaxRequests = [int]$application.InstanceMaxRequests } -ErrorAction Stop
            } else {
                Set-WebConfigurationProperty -PSPath $machinePath -Filter $filter -Name activityTimeout -Value ([int]$application.ActivityTimeout) -ErrorAction Stop
                Set-WebConfigurationProperty -PSPath $machinePath -Filter $filter -Name instanceMaxRequests -Value ([int]$application.InstanceMaxRequests) -ErrorAction Stop
                Set-WebConfigurationProperty -PSPath $machinePath -Filter $filter -Name requestTimeout -Value ([int]$application.RequestTimeout) -ErrorAction Stop
            }
            $environmentFilter = "$filter/environmentVariables"
            foreach ($entry in @(Get-NetariumWebCollection -PSPath $machinePath -Filter $environmentFilter)) {
                if ($entry.name) {
                    Remove-WebConfigurationProperty -PSPath $machinePath -Filter $environmentFilter -Name '.' -AtElement @{ name = [string]$entry.name } -ErrorAction Stop
                }
            }
            foreach ($entry in @($application.EnvironmentVariables)) {
                if ($entry -and $entry.Name) {
                    Add-WebConfigurationProperty -PSPath $machinePath -Filter $environmentFilter -Name '.' -Value @{ name = [string]$entry.Name; value = [string]$entry.Value } -ErrorAction Stop
                }
            }
        }
    }

    if ($State.SiteExists) {
        if (-not $KeepDefaultDocument) {
        $defaultDocumentFilter = 'system.webServer/defaultDocument/files'
        foreach ($entry in @(Get-NetariumWebCollection -PSPath $machinePath -Location $State.SiteName -Filter $defaultDocumentFilter)) {
            if ($entry.value) {
                Remove-WebConfigurationProperty -PSPath $machinePath -Location $State.SiteName -Filter $defaultDocumentFilter -Name '.' -AtElement @{ value = [string]$entry.value } -ErrorAction Stop
            }
        }
        foreach ($entry in @($State.Iis.DefaultDocuments)) {
            if ($entry) {
                Add-WebConfigurationProperty -PSPath $machinePath -Location $State.SiteName -Filter $defaultDocumentFilter -Name '.' -Value @{ value = [string]$entry } -ErrorAction Stop
            }
        }
        }

        if (-not $KeepRequestFiltering) {
        $phpFilter = 'system.webServer/security/requestFiltering/fileExtensions'
        foreach ($entry in @(Get-NetariumWebCollection -PSPath $machinePath -Location $State.SiteName -Filter $phpFilter | Where-Object { [string]$_.fileExtension -ieq '.php' })) {
            Remove-WebConfigurationProperty -PSPath $machinePath -Location $State.SiteName -Filter $phpFilter -Name '.' -AtElement @{ fileExtension = '.php' } -ErrorAction Stop
        }
        foreach ($entry in @($State.Iis.PhpFilters)) {
            if ($entry -and $entry.FileExtension) {
                Add-WebConfigurationProperty -PSPath $machinePath -Location $State.SiteName -Filter $phpFilter -Name '.' -Value @{ fileExtension = [string]$entry.FileExtension; allowed = [bool]$entry.Allowed } -ErrorAction Stop
            }
        }
        }
        # Existing sites can also acquire a new location during failed fresh setup.
        if (-not $KeepDefaultDocument -and $State.Iis.PSObject.Properties['SiteLocationExists'] -and -not $State.Iis.SiteLocationExists -and
            @(Get-WebConfigurationLocation -Name $State.SiteName -PSPath $machinePath -ErrorAction Stop).Count -gt 0) {
            Remove-WebConfigurationLocation -Name $State.SiteName -PSPath $machinePath -ErrorAction Stop
        }
    }
    if ($KeepStopped) {
        Stop-NetariumSiteIfRunning -SiteName $State.SiteName
        Stop-NetariumAppPoolIfRunning -ApplicationPoolName $State.ApplicationPoolName
    } else {
        if ($State.SiteExists -and $State.Iis.Site.State -eq 'Started') {
            Start-Website -Name $State.SiteName -ErrorAction Stop
        } elseif (Get-Website -Name $State.SiteName -ErrorAction SilentlyContinue) {
            Stop-NetariumSiteIfRunning -SiteName $State.SiteName
        }
        $poolStateStarted = $State.AppPoolExists -and $State.Iis -and
            $State.Iis.PSObject.Properties['AppPool'] -and $State.Iis.AppPool -and
            $State.Iis.AppPool.PSObject.Properties['State'] -and $State.Iis.AppPool.State -eq 'Started'
        if ($poolStateStarted) {
            Start-WebAppPool -Name $State.ApplicationPoolName -ErrorAction Stop
        } else {
            Stop-NetariumAppPoolIfRunning -ApplicationPoolName $State.ApplicationPoolName
        }
    }

}

function Get-NetariumFastCgiSignature {
    param([object[]]$Applications)

    $normalized = @(
        $Applications |
            Sort-Object FullPath |
            ForEach-Object {
                $environment = @(
                    $_.EnvironmentVariables |
                        Sort-Object Name |
                        ForEach-Object {
                            [ordered]@{
                                Name = [string]$_.Name
                                Value = [string]$_.Value
                            }
                        }
                )
                [ordered]@{
                    FullPath = [string]$_.FullPath
                    ActivityTimeout = [int]$_.ActivityTimeout
                    RequestTimeout = [int]$_.RequestTimeout
                    InstanceMaxRequests = [int]$_.InstanceMaxRequests
                    EnvironmentVariables = @($environment)
                }
            }
    )
    return ConvertTo-Json -InputObject $normalized -Depth 8 -Compress
}
function Restore-NetariumSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SnapshotPath,
        [Parameter(Mandatory = $true)]
        [string]$InstallRoot,
        [Parameter(Mandatory = $true)]
        [string]$StorageDir,
        [switch]$KeepIisStopped,
        # Update already restores its exact owned local/inherited request-filter section.
        [switch]$KeepRequestFiltering,
        [switch]$KeepDefaultDocument
    )

    $snapshot = ConvertTo-NetariumAbsolutePath -Path $SnapshotPath
    Set-NetariumPrivateAcl -Path $snapshot
    $manifestPath = Join-Path $snapshot 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Rollback manifest does not exist: $manifestPath"
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $hasAppPool = $manifest.Iis -and $manifest.Iis.PSObject.Properties['AppPool'] -and $manifest.Iis.AppPool
    if ($manifest.PSObject.Properties['PoolPasswordProtection'] -and $manifest.PoolPasswordProtection) {
        if ($manifest.PoolPasswordProtection -ne 'DPAPI-LocalMachine') {
            throw 'Unsupported rollback credential protection; restore was not started.'
        }
        $decryptedPassword = Unprotect-NetariumPoolPassword -Ciphertext (
            [System.IO.File]::ReadAllBytes((Join-Path $snapshot 'iis-secrets.bin'))
        )
        if ($hasAppPool) {
            $manifest.Iis.AppPool.Password = $decryptedPassword
        }
    } elseif ([int]$manifest.Version -ge 2 -and $hasAppPool -and $manifest.Iis.AppPool.PSObject.Properties['Password'] -and $null -ne $manifest.Iis.AppPool.Password) {
        throw 'Plaintext credentials are not allowed in this rollback manifest.'
    }
    $install = ConvertTo-NetariumAbsolutePath -Path $InstallRoot
    $storage = ConvertTo-NetariumAbsolutePath -Path $StorageDir
    $restorePoolName = if ($manifest.Iis -and $manifest.Iis.PSObject.Properties['Site'] -and $manifest.Iis.Site -and $manifest.Iis.Site.PSObject.Properties['ApplicationPool'] -and $manifest.Iis.Site.ApplicationPool) {
        [string]$manifest.Iis.Site.ApplicationPool
    } elseif ($manifest.AppPoolExists) {
        [string]$manifest.ApplicationPoolName
    } else {
        ''
    }
    $targetLogs = Join-Path $storage 'logs'
    $programSnapshot = Join-Path $snapshot 'program'
    foreach ($directory in @($storage, (Join-Path $install 'config'))) {
        New-NetariumPrivateDirectory -Path $directory
    }

    if (Test-Path -LiteralPath $programSnapshot -PathType Container) {
        foreach ($relativePath in @($manifest.ProgramItems)) {
            $target = Join-Path $install ($relativePath -replace '/', '\')
            if (Test-Path -LiteralPath $target) {
                Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
            }
            $source = Join-Path $programSnapshot ($relativePath -replace '/', '\')
            if (Test-Path -LiteralPath $source) {
                New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                Copy-Item -LiteralPath $source -Destination $target -Recurse -Force -ErrorAction Stop
            }
        }
    }

    foreach ($relativePath in @('db', 'uploads', 'backups', 'temp')) {
        $target = Join-Path $storage $relativePath
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
        }
        $source = Join-Path $snapshot ('data/' + $relativePath)
        if (Test-Path -LiteralPath $source -PathType Container) {
            Copy-NetariumDirectoryContents -Source $source -Destination $target
        } else {
            New-Item -ItemType Directory -Path $target -Force | Out-Null
        }
    }

    # Retain existing logs to preserve audit history and restore logs.
    # Copy or create logs from snapshot only if the target logs directory does not exist.
    $sourceLogs = Join-Path $snapshot 'data/logs'
    if (-not (Test-Path -LiteralPath $targetLogs)) {
        if (Test-Path -LiteralPath $sourceLogs -PathType Container) {
            Copy-NetariumDirectoryContents -Source $sourceLogs -Destination $targetLogs
        } else {
            New-Item -ItemType Directory -Path $targetLogs -Force | Out-Null
        }
    }

    $targetConfig = Join-Path $install 'config/app.php'
    $sourceConfig = Join-Path $snapshot 'config/app.php'
    if (Test-Path -LiteralPath $sourceConfig -PathType Leaf) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetConfig) -Force | Out-Null
        Copy-Item -LiteralPath $sourceConfig -Destination $targetConfig -Force -ErrorAction Stop
    } elseif (Test-Path -LiteralPath $targetConfig) {
        Remove-Item -LiteralPath $targetConfig -Force -ErrorAction Stop
    }

    if ($manifest.PSObject.Properties.Name -contains 'Acl') {
        foreach ($entry in @($manifest.Acl)) {
            $name = [string]$entry.Name
            if ($name -notin @('', 'public', 'src', 'templates', 'resources', 'scripts', 'config', 'StorageDir')) {
                throw 'Snapshot contains an invalid ACL target.'
            }
            if ($name -in @('config', 'StorageDir')) { continue }
            $path = if ($name -eq 'StorageDir') { $storage } elseif ($name) { Join-Path $install $name } else { $install }
            if (Test-Path -LiteralPath $path -PathType Container) {
                $acl = Get-Acl -LiteralPath $path
                $acl.SetSecurityDescriptorSddlForm([string]$entry.Sddl, [System.Security.AccessControl.AccessControlSections]::Access)
                Set-Acl -LiteralPath $path -AclObject $acl
            }
        }
    }
    # Bootstrap copies are not snapshotted/restored; preserve and re-protect them.
    if (Test-Path -LiteralPath (Join-Path $storage 'bootstrap') -PathType Container) {
        Set-NetariumBootstrapAcl -StorageDir $storage
    }
    # Recreated pools can now resolve their virtual SID; grant access before restarting IIS.
    Set-NetariumPrivateAcl -Path $storage -ApplicationPoolName $restorePoolName
    # 追加辞書はsnapshot対象外。復元したstorageのModifyを再度遮断する。
    if ($restorePoolName) {
        Set-NetariumPasswordBlocklistAcl -StorageDir $storage -ApplicationPoolName $restorePoolName
    } else {
        foreach ($name in @('password-blocklist', 'password-blocklist.json')) {
            if (Test-Path -LiteralPath (Join-Path $storage $name)) { Set-NetariumPrivateAcl -Path (Join-Path $storage $name) }
        }
    }
    $restoredConfig = Join-Path $install 'config'
    if (Test-Path -LiteralPath $restoredConfig -PathType Container) {
        Set-NetariumPrivateAcl -Path $restoredConfig -ApplicationPoolName $restorePoolName -PoolRights ReadAndExecute
    }

    # A failed fresh setup must not retain newly issued bootstrap secrets or logs.
    # Historical snapshots with pre-existing data (or external storage) retain them.
    if ($manifest.Stage -eq 'fresh-setup' -and
        $manifest.PSObject.Properties['ExistingInstallDirectories'] -and
        @($manifest.ExistingInstallDirectories) -notcontains 'data' -and
        $storage -ieq (Join-Path $install 'data') -and
        -not (Test-Path -LiteralPath (Join-Path $storage 'password-blocklist')) -and
        -not (Test-Path -LiteralPath (Join-Path $storage 'password-blocklist.json')) -and
        (Test-Path -LiteralPath $storage -PathType Container)) {
        Remove-Item -LiteralPath $storage -Recurse -Force -ErrorAction Stop
    }

    if ($manifest.Iis) {
        try {
            Restore-NetariumIisState -State $manifest -KeepStopped:$KeepIisStopped -KeepRequestFiltering:$KeepRequestFiltering -KeepDefaultDocument:$KeepDefaultDocument
        } finally {
            if ($hasAppPool -and $manifest.Iis.AppPool.PSObject.Properties['Password']) {
                $manifest.Iis.AppPool.Password = $null
            }
        }
    }

    if ($manifest.Stage -eq 'fresh-setup' -and $manifest.PSObject.Properties['InstallRootExisted']) {
        if (-not $manifest.InstallRootExisted -and (Test-Path -LiteralPath $install -PathType Container) -and
            -not (Test-Path -LiteralPath (Join-Path $storage 'password-blocklist')) -and
            -not (Test-Path -LiteralPath (Join-Path $storage 'password-blocklist.json'))) {
            Remove-Item -LiteralPath $install -Recurse -Force -ErrorAction Stop
        } elseif ($manifest.PSObject.Properties['ExistingInstallDirectories']) {
            foreach ($relativePath in $script:NetariumManagedInstallDirectories) {
                if (@($manifest.ExistingInstallDirectories) -contains $relativePath) {
                    continue
                }
                $directory = Join-Path $install $relativePath
                if ((Test-Path -LiteralPath $directory -PathType Container) -and
                    @(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) {
                    Remove-Item -LiteralPath $directory -Force -ErrorAction Stop
                }
            }
        }
    }

    if ($manifest.Iis) {
        $restoredIis = Get-IisState -SiteName $manifest.SiteName -ApplicationPoolName $manifest.ApplicationPoolName -PhpCgiPath $manifest.Iis.PhpCgiPath
        if ([bool]$restoredIis.SiteExists -ne [bool]$manifest.SiteExists) {
            throw 'Rollback verification failed: IIS site existence does not match the snapshot.'
        }
        if ([bool]$restoredIis.AppPoolExists -ne [bool]$manifest.AppPoolExists) {
            throw 'Rollback verification failed: application-pool existence does not match the snapshot.'
        }
        if ($manifest.Iis.PSObject.Properties['SiteLocationExists'] -and
            [bool]$restoredIis.SiteLocationExists -ne [bool]$manifest.Iis.SiteLocationExists) {
            throw 'Rollback verification failed: IIS site location existence does not match the snapshot.'
        }
        if (
            (Get-NetariumFastCgiSignature -Applications @($restoredIis.FastCgi)) -cne
            (Get-NetariumFastCgiSignature -Applications @($manifest.Iis.FastCgi))
        ) {
            throw 'Rollback verification failed: FastCGI settings do not match the snapshot.'
        }
    }
    if (
        $manifest.PSObject.Properties['InstallRootExisted'] -and
        (Test-Path -LiteralPath $install -PathType Container) -ne [bool]$manifest.InstallRootExisted
    ) {
        throw 'Rollback verification failed: InstallRoot existence does not match the snapshot.'
    }
    return $manifest
}

function Invoke-NetariumProbe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [switch]$IncludeBody
    )

    $separator = if ($Url.Contains('?')) { '&' } else { '?' }
    $probeUrl = $Url + $separator + '_netarium_probe=' + [Guid]::NewGuid().ToString('N')
    $request = [System.Net.HttpWebRequest]::Create($probeUrl)
    $request.AllowAutoRedirect = $false
    $request.Method = 'GET'
    $request.Timeout = 3000
    $request.ReadWriteTimeout = 3000
    $request.CachePolicy = New-Object System.Net.Cache.RequestCachePolicy([System.Net.Cache.RequestCacheLevel]::NoCacheNoStore)
    $response = $null
    $body = ''

    try {
        $response = [System.Net.HttpWebResponse]$request.GetResponse()
    } catch [System.Net.WebException] {
        $response = $_.Exception.Response
        if (-not $response) {
            throw
        }
    }

    try {
        if ($IncludeBody -and $response) {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
            $body = $reader.ReadToEnd()
            $reader.Dispose()
        }

        $headers = @{}
        if ($response) {
            foreach ($key in $response.Headers.AllKeys) {
                $headers[$key] = $response.Headers[$key]
            }
        }

        return [pscustomobject]@{
            Url = $probeUrl
            StatusCode = if ($response) { [int]$response.StatusCode } else { 0 }
            Location = if ($response) { [string]$response.Headers['Location'] } else { '' }
            Headers = $headers
            Body = $body
        }
    } finally {
        if ($response) {
            $response.Dispose()
        }
    }
}

function Assert-NetariumMaintenanceProbe {
    param([Parameter(Mandatory = $true)][string]$BaseUrl, [Parameter(Mandatory = $true)]$Maintenance)
    foreach ($path in @('api.php?action=load', 'image_upload.php?action=upload_device_image')) {
        $api = Invoke-NetariumProbe -Url ($BaseUrl.TrimEnd('/') + '/' + $path) -IncludeBody
        if ($api.StatusCode -ne 404 -or $api.Location -or
            $api.Headers['Content-Type'] -notmatch '^application/json(?:\s*;.*)?$' -or
            $api.Headers['Cache-Control'] -notmatch '(?i)(?:^|,)\s*no-store\s*(?:,|$)' -or
            $api.Body -cne $Maintenance.Body) {
            throw "Strict maintenance contract is not effective: $path status=$($api.StatusCode)"
        }
    }
}
