[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateNotNullOrEmpty()][string]$InstallRoot,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_. -]*$')][string]$SiteName,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_. -]*$')][string]$ApplicationPoolName,
    [string]$PhpCgiPath,
    [string]$RollbackRoot,
    [switch]$RemoveData,
    [switch]$Force,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'deployment-common.ps1')

function Assert-NetariumRemovalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $absolute = ConvertTo-NetariumAbsolutePath -Path $Path
    if ($absolute -ieq [System.IO.Path]::GetPathRoot($absolute).TrimEnd('\', '/')) {
        throw "A filesystem root cannot be removed: $absolute"
    }
    $current = $absolute
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "A removal path contains a reparse point: $current"
            }
        }
        $parent = Split-Path -Parent $current
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
    return $absolute
}

function Assert-NetariumRemovalTree {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-NetariumRemovalPath -Path $Path | Out-Null
    if (Test-Path -LiteralPath $Path -PathType Container) {
        foreach ($entry in @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)) {
            if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "A removal tree contains a reparse point: $($entry.FullName)"
            }
        }
    }
}

function Assert-NetariumRollbackOwnership {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$SiteName,
        [Parameter(Mandatory = $true)][string]$PoolName
    )

    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "RollbackRoot is not a directory: $Path"
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)) {
        if ($item.Name -eq 'update.lock' -and -not $item.PSIsContainer) { continue }
        $manifestPath = Join-Path $item.FullName 'manifest.json'
        if (-not $item.PSIsContainer -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            throw "RollbackRoot contains an unrecognized item: $($item.FullName)"
        }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ([string]$manifest.TargetPath -ine $Root -or
            [string]$manifest.SnapshotPath -ine $item.FullName -or
            [string]$manifest.SiteName -ine $SiteName -or
            [string]$manifest.ApplicationPoolName -ine $PoolName) {
            throw "Rollback snapshot does not belong to this installation: $($item.FullName)"
        }
    }
}

function Get-NetariumSiteApplications {
    param([Parameter(Mandatory = $true)][string]$Name)
    return @(Get-WebApplication -Site $Name -ErrorAction Stop)
}

function Get-NetariumSiteHandlers {
    param([Parameter(Mandatory = $true)][string]$Path)
    return @(Get-WebConfigurationProperty -PSPath $Path -Filter 'system.webServer/handlers/add' -Name '.' -ErrorAction Stop)
}

function Get-NetariumPoolProfile {
    param([Parameter(Mandatory = $true)][string]$Pool)

    # IIS derives virtual account SIDs from the lowercase UTF-16 pool name.
    # Derive it here because account lookup fails after normal pool removal.
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::Unicode.GetBytes($Pool.ToLowerInvariant()))
    } finally {
        $sha.Dispose()
    }
    $sid = 'S-1-5-82-' + ((0..4 | ForEach-Object {
        [System.BitConverter]::ToUInt32($hash, ($_ * 4))
    }) -join '-')
    return Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$sid'" -ErrorAction Stop
}

function Invoke-NetariumUninstall {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Rollback,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Pool,
        [string]$Cgi,
        [switch]$DeleteData,
        [switch]$Unattended,
        [switch]$SkipPrompt
    )

    Assert-Administrator
    Assert-WebAdministration
    foreach ($commandName in @('Get-WebApplication', 'Remove-Website', 'Remove-WebAppPool', 'Stop-Website', 'Stop-WebAppPool')) {
        if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
            throw "WebAdministration command is unavailable: $commandName"
        }
    }

    $root = Assert-NetariumRemovalPath -Path $Root
    $rollback = Assert-NetariumRemovalPath -Path $Rollback
    if (Test-NetariumPathOverlap -Left $root -Right $rollback) {
        throw 'InstallRoot and RollbackRoot must not overlap.'
    }
    if (Test-NetariumPathOverlap -Left $root -Right $PSScriptRoot) {
        throw 'Run the uninstall script from a release outside InstallRoot.'
    }
    if ($Cgi) { $Cgi = ConvertTo-NetariumAbsolutePath -Path $Cgi }
    $public = Join-Path $root 'public'
    $config = Join-Path $root 'config/app.php'
    $site = Get-Website -Name $Name -ErrorAction SilentlyContinue
    $sites = @(Get-Website -ErrorAction Stop)
    $poolExists = Test-Path -LiteralPath "IIS:\AppPools\$Pool"
    $locations = @(Get-WebConfigurationLocation -Name $Name -PSPath 'MACHINE/WEBROOT/APPHOST' -ErrorAction Stop)
    $rootExists = Test-Path -LiteralPath $root -PathType Container
    if ($rootExists -and -not (Test-Path -LiteralPath $config -PathType Leaf) -and
        -not $site -and -not $poolExists -and $locations.Count -eq 0 -and
        -not (Test-Path -LiteralPath $rollback)) {
        $remainingManaged = @($script:NetariumReleaseManifest.Directories) +
            @($script:NetariumReleaseManifest.Files) + @($script:NetariumReleaseManifest.RetiredFiles) + @('data', 'config/app.php')
        if (@($remainingManaged | Where-Object {
            Test-Path -LiteralPath (Join-Path $root ($_ -replace '/', '\'))
        }).Count -eq 0) {
            Write-Host 'No Netarium-managed resources remain; unrelated files were retained.'
            return
        }
    }

    if ($site) {
        $actual = [Environment]::ExpandEnvironmentVariables([string]$site.PhysicalPath)
        if ([System.IO.Path]::GetFullPath($actual).TrimEnd('\', '/') -ine $public.TrimEnd('\', '/') -or
            [string]$site.ApplicationPool -ine $Pool) {
            throw 'IIS site physical path or application pool does not match the requested Netarium installation.'
        }
        if (@(Get-NetariumSiteApplications -Name $Name).Count -gt 0) {
            throw 'The site contains additional IIS applications; review them before removal.'
        }
    }
    if ($rootExists) {
        if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
            throw "Cannot prove ownership of InstallRoot without config/app.php: $root"
        }
        $configText = Get-Content -LiteralPath $config -Raw -Encoding UTF8 -ErrorAction Stop
        $expectedStorage = (Join-Path $root 'data').Replace('\', '\\')
        if ($configText -notmatch ("'storage_dir'\s*=>\s*'" + [regex]::Escape($expectedStorage) + "'\s*,")) {
            throw 'config/app.php does not point to InstallRoot/data.'
        }
    } elseif (-not $site -and ($poolExists -or $locations.Count -gt 0)) {
        throw 'No site or installation files remain to verify ownership of the IIS settings.'
    }
    if ($locations.Count -gt 0 -and -not $site) {
        $locationHandlers = Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $Name -Filter 'system.webServer/handlers/add' -Name '.' -ErrorAction Stop
        if (@($locationHandlers | Where-Object { [string]$_.name -eq 'Netarium-PHP' }).Count -eq 0) {
            throw 'Cannot prove ownership of the remaining IIS location configuration.'
        }
    }

    $candidateCgi = $null
    $ownedCgi = $false
    if ($site) {
        $handlers = Get-NetariumSiteHandlers -Path "IIS:\Sites\$Name"
        $phpHandlers = @($handlers | Where-Object { [string]$_.path -eq '*.php' })
        foreach ($handler in $phpHandlers) {
            if ([string]$handler.modules -ne 'FastCgiModule' -or
                [string]::IsNullOrWhiteSpace([string]$handler.scriptProcessor)) {
                throw 'The site PHP handler is not a FastCGI handler; review it manually.'
            }
            if ($candidateCgi -and $candidateCgi -ine [string]$handler.scriptProcessor) {
                throw 'The site has conflicting PHP CGI paths.'
            }
            $candidateCgi = [string]$handler.scriptProcessor
            if ([string]$handler.name -eq 'Netarium-PHP') { $ownedCgi = $true }
        }
        if ($Cgi -and $candidateCgi -and $candidateCgi -ine $Cgi) {
            throw 'The site PHP handler does not match PhpCgiPath.'
        }
    }

    foreach ($other in $sites) {
        if ([string]$other.Name -ieq $Name) { continue }
        if (($poolExists -or $DeleteData) -and [string]$other.ApplicationPool -ieq $Pool) {
            throw "Another IIS site uses application pool '$Pool': $($other.Name)"
        }
        foreach ($app in @(Get-NetariumSiteApplications -Name ([string]$other.Name))) {
            if (($poolExists -or $DeleteData) -and [string]$app.ApplicationPool -ieq $Pool) {
                throw "Another IIS application uses application pool '$Pool': $($other.Name)"
            }
        }
    }
    $unverifiedPool = $poolExists -and -not $site
    if ($unverifiedPool) {
        Write-Warning "IIS site '$Name' is absent; application pool '$Pool' cannot be tied to this installation and will be retained. Verify ownership before removing it manually."
    }

    $removeCgi = $false
    if ($candidateCgi -and $ownedCgi) {
        $cgiApps = @(Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/fastCgi/application' -Name '.' -ErrorAction Stop |
            Where-Object { [string]$_.fullPath -ieq $candidateCgi })
        if ($cgiApps.Count -eq 1) {
            $shared = @(Get-NetariumSiteHandlers -Path 'MACHINE/WEBROOT/APPHOST' |
                Where-Object { [string]$_.scriptProcessor -ieq $candidateCgi }).Count -gt 0
            foreach ($other in $sites) {
                if ([string]$other.Name -ieq $Name) { continue }
                $otherPath = "IIS:\Sites\$($other.Name)"
                if (@(Get-NetariumSiteHandlers -Path $otherPath | Where-Object { [string]$_.scriptProcessor -ieq $candidateCgi }).Count -gt 0) {
                    $shared = $true
                }
                foreach ($app in @(Get-NetariumSiteApplications -Name ([string]$other.Name))) {
                    $appPath = $otherPath + '\' + ([string]$app.Path).TrimStart('/')
                    if (@(Get-NetariumSiteHandlers -Path $appPath | Where-Object { [string]$_.scriptProcessor -ieq $candidateCgi }).Count -gt 0) {
                        $shared = $true
                    }
                }
            }
            $removeCgi = -not $shared
        }
    }

    $program = @($script:NetariumReleaseManifest.Directories | ForEach-Object { Join-Path $root $_ })
    $program += @($script:NetariumReleaseManifest.Files | ForEach-Object { Join-Path $root ($_ -replace '/', '\') })
    $program += @($script:NetariumReleaseManifest.RetiredFiles | ForEach-Object { Join-Path $root $_ })
    $targets = @($program)
    if ($DeleteData) {
        Assert-NetariumRollbackOwnership -Path $rollback -Root $root -SiteName $Name -PoolName $Pool
    }
    $profile = $null
    if ($DeleteData -and -not $unverifiedPool) {
        $profile = Get-NetariumPoolProfile -Pool $Pool
        if ($profile -and (-not $rootExists -and -not $site)) {
            throw 'Cannot prove installation ownership for the remaining application pool profile.'
        }
        if ($profile -and $profile.Special) {
            throw "A special user profile cannot be removed: $($profile.LocalPath)"
        }
    }
    if ($DeleteData) { $targets += (Join-Path $root 'data'); $targets += $rollback; $targets += (Join-Path $root 'config') }
    foreach ($target in $targets) {
        if (Test-Path -LiteralPath $target) {
            Assert-NetariumRemovalTree -Path $target
        }
    }
    Write-Host "Site: $Name; pool: $Pool; program: $root"
    Write-Host "Data: $(Join-Path $root 'data'); config: $config; rollback: $rollback"
    if ($DeleteData) {
        Write-Host 'RemoveData requested: data (DB, uploads, backups, logs), config, rollback snapshots, and the dedicated virtual application pool profile will be removed.'
        if ($profile) { Write-Host "Application pool profile: $($profile.LocalPath); SID: $($profile.SID)" }
        if (-not $WhatIfPreference) {
            if ($Unattended -and -not $SkipPrompt) { throw 'NonInteractive -RemoveData requires -Force.' }
            if (-not $Unattended) {
                $answer = Read-Host -Prompt "Type REMOVE to delete all Netarium data at $root"
                if ($answer -cne 'REMOVE') { throw 'Data removal was not confirmed.' }
            }
        }
    } else {
        Write-Host 'Data, config/app.php and rollback snapshots will be retained.'
    }

    if ($site -and $PSCmdlet.ShouldProcess($Name, 'Stop IIS site')) {
        if ((Get-WebSiteState -Name $Name).Value -eq 'Started') {
            Stop-Website -Name $Name -ErrorAction Stop
        }
    }
    if ($removeCgi -and $PSCmdlet.ShouldProcess($candidateCgi, 'Remove unshared PHP FastCGI mapping')) {
        Remove-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/fastCgi' -Name '.' -AtElement @{ fullPath = $candidateCgi } -ErrorAction Stop
    } elseif ($candidateCgi -and -not $removeCgi) {
        Write-Host "Shared or ambiguous FastCGI mapping retained: $candidateCgi"
    }
    if ($locations.Count -gt 0 -and $PSCmdlet.ShouldProcess($Name, 'Remove site-specific IIS location configuration')) {
        Remove-WebConfigurationLocation -Name $Name -PSPath 'MACHINE/WEBROOT/APPHOST' -ErrorAction Stop
    }
    if ($site -and $PSCmdlet.ShouldProcess($Name, 'Remove IIS site and its bindings')) {
        Remove-Website -Name $Name -ErrorAction Stop
    }
    if ($poolExists -and -not $unverifiedPool -and $PSCmdlet.ShouldProcess($Pool, 'Stop and remove application pool')) {
        if ((Get-WebAppPoolState -Name $Pool).Value -eq 'Started') {
            Stop-WebAppPool -Name $Pool -ErrorAction Stop
        }
        Remove-WebAppPool -Name $Pool -ErrorAction Stop
    }
    if ($profile -and $PSCmdlet.ShouldProcess($profile.LocalPath, 'Remove virtual application pool user profile')) {
        if (Test-Path -LiteralPath "IIS:\AppPools\$Pool") {
            throw "Application pool must be removed before its profile: $Pool"
        }
        $profile = Get-NetariumPoolProfile -Pool $Pool
        if ($profile) {
            if ($profile.Loaded -or $profile.Special) {
                throw "Application pool profile is still loaded or special; retained data allows a later retry: $($profile.LocalPath)"
            }
            Remove-CimInstance -InputObject $profile -ErrorAction Stop
        }
    }
    foreach ($target in $targets) {
        if ((Test-Path -LiteralPath $target) -and $PSCmdlet.ShouldProcess($target, 'Remove Netarium files')) {
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
        }
    }
    if (Test-Path -LiteralPath $root -PathType Container) {
        foreach ($directory in @((Join-Path $root 'config'), $root)) {
            if ((Test-Path -LiteralPath $directory -PathType Container) -and
                @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop).Count -eq 0 -and
                $PSCmdlet.ShouldProcess($directory, 'Remove empty directory')) {
                Remove-Item -LiteralPath $directory -Force -ErrorAction Stop
            }
        }
    }
    if ($unverifiedPool) {
        Write-Warning "Netarium uninstall finished with application pool '$Pool' retained; verify ownership and remove it manually if appropriate."
    } else {
        Write-Host 'Netarium uninstall completed (or planned with WhatIf).'
    }
}

if (-not $PSBoundParameters.ContainsKey('InstallRoot') -or [string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Read-NetariumDeploymentParameter -Name InstallRoot -Description InstallRoot -Default $script:NetariumIisDefaults.InstallRoot -CompactPrompt -NonInteractive:$NonInteractive
}
if (-not $PSBoundParameters.ContainsKey('SiteName') -or [string]::IsNullOrWhiteSpace($SiteName)) {
    $SiteName = Read-NetariumDeploymentParameter -Name SiteName -Description SiteName -Default $script:NetariumIisDefaults.SiteName -CompactPrompt -NonInteractive:$NonInteractive
}
if (-not $PSBoundParameters.ContainsKey('ApplicationPoolName') -or [string]::IsNullOrWhiteSpace($ApplicationPoolName)) {
    $ApplicationPoolName = Read-NetariumDeploymentParameter -Name ApplicationPoolName -Description ApplicationPoolName -Default $SiteName -CompactPrompt -NonInteractive:$NonInteractive
}

if (-not $RollbackRoot) {
    $RollbackRoot = (ConvertTo-NetariumAbsolutePath -Path $InstallRoot) + '-rollback'
}
Invoke-NetariumUninstall -Root $InstallRoot -Rollback $RollbackRoot -Name $SiteName -Pool $ApplicationPoolName -Cgi $PhpCgiPath -DeleteData:$RemoveData -Unattended:$NonInteractive -SkipPrompt:$Force
