[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,
    [Parameter(Mandatory = $true)]
    [string]$SiteName,
    [Parameter(Mandatory = $true)]
    [string]$ApplicationPoolName,
    [Parameter(Mandatory = $true)]
    [string]$PhpCgiPath,
    [Parameter(Mandatory = $true)]
    [Alias('BaseUrl')]
    [string]$VerificationUrl,
    [int]$DrainTimeoutSeconds = 120,
    [string]$RollbackRoot,
    # Optional per-binding maintenance URLs; normal post-update verification keeps VerificationUrl.
    [string[]]$MaintenanceVerificationUrl = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'full-backup-common.ps1')

function Get-NetariumUpdatePhpCli {
    param([Parameter(Mandatory = $true)][string]$CgiPath)

    $command = Get-Command php -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    $candidate = Join-Path (Split-Path -Parent $CgiPath) 'php.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
    }
    throw 'PHP CLI executable is required for update preflight and health checks.'
}

function Assert-NetariumPowerShellSyntax {
    param([Parameter(Mandatory = $true)][string]$Root)

    $parseErrors = @()
    foreach ($scriptFile in @(Get-ChildItem -LiteralPath $Root -Recurse -Filter '*.ps1' -File -Force)) {
        $tokens = $null
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseFile(
            $scriptFile.FullName,
            [ref]$tokens,
            [ref]$errors
        ) | Out-Null
        if ($errors.Count -gt 0) {
            $parseErrors += @($errors | ForEach-Object { "$($scriptFile.FullName): $($_.Message)" })
        }
    }
    if ($parseErrors.Count -gt 0) {
        throw "PowerShell syntax preflight failed:`n$($parseErrors -join [Environment]::NewLine)"
    }
}

function Assert-NetariumPhpSyntax {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$PhpPath
    )

    foreach ($phpFile in @(Get-ChildItem -LiteralPath $Root -Recurse -Filter '*.php' -File -Force)) {
        & $PhpPath -l $phpFile.FullName 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "PHP syntax preflight failed: $($phpFile.FullName)"
        }
    }
}

function Copy-NetariumUpdateManifest {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $source = ConvertTo-NetariumAbsolutePath -Path $SourceRoot
    $destination = ConvertTo-NetariumAbsolutePath -Path $DestinationRoot
    New-Item -ItemType Directory -Path $destination -Force | Out-Null

    foreach ($relativePath in $script:NetariumReleaseManifest.Directories) {
        $sourcePath = Join-Path $source $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
            throw "Staged release directory is missing: $relativePath"
        }
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $destination $relativePath) -Recurse -Force -ErrorAction Stop
    }
    foreach ($relativePath in $script:NetariumReleaseManifest.Files) {
        $windowsPath = $relativePath -replace '/', '\'
        $sourcePath = Join-Path $source $windowsPath
        $destinationPath = Join-Path $destination $windowsPath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Staged release file is missing: $relativePath"
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force -ErrorAction Stop
    }
}

function Replace-NetariumProgramManifest {
    param(
        [Parameter(Mandatory = $true)][string]$StagedRoot,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )

    $offlinePath = Join-Path $InstallRoot 'public\app_offline.htm'
    $offlineContent = $null
    if (Test-Path -LiteralPath $offlinePath -PathType Leaf) {
        $offlineContent = [System.IO.File]::ReadAllBytes($offlinePath)
    }

    foreach ($relativePath in $script:NetariumReleaseManifest.Directories) {
        $target = Join-Path $InstallRoot $relativePath
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
        }
        Copy-Item -LiteralPath (Join-Path $StagedRoot $relativePath) -Destination $target -Recurse -Force -ErrorAction Stop
    }

    foreach ($relativePath in $script:NetariumReleaseManifest.Files) {
        $windowsPath = $relativePath -replace '/', '\'
        $target = Join-Path $InstallRoot $windowsPath
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Force -ErrorAction Stop
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $StagedRoot $windowsPath) -Destination $target -Force -ErrorAction Stop
    }

    foreach ($relativePath in $script:NetariumReleaseManifest.RetiredFiles) {
        $target = Join-Path $InstallRoot $relativePath
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            Remove-Item -LiteralPath $target -Force -ErrorAction Stop
        }
    }

    if ($null -ne $offlineContent) {
        [System.IO.File]::WriteAllBytes($offlinePath, $offlineContent)
    }
}

function Invoke-NetariumUpdateCheck {
    param(
        [Parameter(Mandatory = $true)][string]$AppRoot,
        [Parameter(Mandatory = $true)][string]$StorageDir,
        [Parameter(Mandatory = $true)][string]$PhpPath
    )

    $checkScript = Join-Path $AppRoot 'scripts/check-install.php'
    if (-not (Test-Path -LiteralPath $checkScript -PathType Leaf)) {
        throw "CLI installation check is missing: $checkScript"
    }
    $output = @(& $PhpPath $checkScript --app-root (ConvertTo-NetariumAbsolutePath -Path $AppRoot) --storage-dir (ConvertTo-NetariumAbsolutePath -Path $StorageDir) 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "CLI installation check failed: $($output -join [Environment]::NewLine)"
    }
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $result.ok) {
        throw "CLI installation check returned failure: $($result.error)"
    }
    return $result
}

function Join-NetariumUpdateUrl {
    param([Parameter(Mandatory = $true)][string]$VerificationUrl, [Parameter(Mandatory = $true)][string]$Path)
    return $VerificationUrl.TrimEnd('/') + '/' + $Path.TrimStart('/')
}

function Assert-NetariumUpdateHttpState {
    param([Parameter(Mandatory = $true)][string]$VerificationUrl)

    $login = Invoke-NetariumProbe -Url (Join-NetariumUpdateUrl -VerificationUrl $VerificationUrl -Path 'login.php')
    if ($login.StatusCode -ne 200) {
        throw "login.php did not return 200 after update: $($login.StatusCode)"
    }

    $api = Invoke-NetariumProbe -Url (Join-NetariumUpdateUrl -VerificationUrl $VerificationUrl -Path 'api.php?action=load')
    if ($api.StatusCode -ne 401) {
        throw "Unauthenticated API did not return 401 after update: $($api.StatusCode)"
    }

    $imageUpload = Invoke-NetariumProbe -Url (Join-NetariumUpdateUrl -VerificationUrl $VerificationUrl -Path 'image_upload.php?action=upload_device_image')
    if ($imageUpload.StatusCode -ne 401) {
        throw "Unauthenticated image upload did not return 401 after update: $($imageUpload.StatusCode)"
    }

    $setup = Invoke-NetariumProbe -Url (Join-NetariumUpdateUrl -VerificationUrl $VerificationUrl -Path 'setup.php')
    if ($setup.StatusCode -eq 302) {
        if ($setup.Location -notmatch 'login\.php') {
            throw "setup.php redirected to an unexpected location: $($setup.Location)"
        }
    } elseif ($setup.StatusCode -ne 404) {
        throw "setup.php is not closed after update: $($setup.StatusCode)"
    }

    foreach ($path in @(
        'auth.php',
        'database.php',
        'src/Services/Auth/Authentication.php',
        'src/Core/DatabaseSchema.php',
        'src/Autoloader.php',
        'templates/components/toolbar.php',
        'config/app.php',
        'scripts/recover-admin.php',
        'data/db/data.sqlite',
        'db/data.sqlite'
    )) {
        $probe = Invoke-NetariumProbe -Url (Join-NetariumUpdateUrl -VerificationUrl $VerificationUrl -Path $path)
        if ($probe.StatusCode -notin @(403, 404)) {
            throw "Private path is reachable after update: $path status=$($probe.StatusCode)"
        }
    }
}


$installRootPath = ConvertTo-NetariumAbsolutePath -Path $InstallRoot
if (-not $RollbackRoot) {
    $RollbackRoot = $installRootPath + '-rollback'
}
$rollbackRootPath = ConvertTo-NetariumAbsolutePath -Path $RollbackRoot
$storagePath = Join-Path $installRootPath 'data'
$publicPath = Join-Path $installRootPath 'public'
$stagingPath = $installRootPath + '.staging-' + [Guid]::NewGuid().ToString('N')
$lock = $null
$worker = $null
$maintenance = $null
$snapshotPath = $null
$checkStarted = $false
$drainCompleted = $false
$restored = $false

try {
    Assert-Administrator
    Assert-WebAdministration
    Assert-SafeDeploymentPaths -SourcePath $SourcePath -InstallRoot $installRootPath -RollbackRoot $rollbackRootPath | Out-Null
    $release = Assert-ReleaseLayout -SourcePath $SourcePath
    $phpPath = Get-NetariumUpdatePhpCli -CgiPath $PhpCgiPath
    Assert-NetariumPowerShellSyntax -Root $release.Root
    Assert-NetariumPhpSyntax -Root $release.Root -PhpPath $phpPath
    $passwordProbe = Join-Path $release.Root 'scripts/check-password-runtime.php'
    Assert-NetariumArgon2Runtime -PhpPath $phpPath -ProbePath $passwordProbe | Out-Null
    Assert-NetariumArgon2Runtime -PhpPath $PhpCgiPath -ProbePath $passwordProbe -Cgi | Out-Null

    $lock = Enter-NetariumMaintenanceLock $installRootPath
    $state = Get-IisState -SiteName $SiteName -ApplicationPoolName $ApplicationPoolName -PhpCgiPath $PhpCgiPath
    if (-not $state.SiteExists -or -not $state.AppPoolExists) {
        throw 'The live IIS site and application pool are required for an update.'
    }
    if ([string]$state.Site.ApplicationPool -ine $ApplicationPoolName) {
        throw "The live IIS site '$SiteName' is assigned to application pool '$($state.Site.ApplicationPool)', which does not match '-ApplicationPoolName $ApplicationPoolName'."
    }
    Assert-NetariumAppPoolIdentityIsolation -ApplicationPoolName $ApplicationPoolName
    $expectedPublic = [System.IO.Path]::GetFullPath($publicPath).TrimEnd('\')
    $actualPublic = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$state.Site.PhysicalPath)).TrimEnd('\')
    if ($actualPublic -ine $expectedPublic) {
        throw 'The live IIS site root is not InstallRoot/public.'
    }

    Copy-NetariumUpdateManifest -SourceRoot $release.Root -DestinationRoot $stagingPath
    $maintenance = Set-NetariumMaintenance -SiteName $SiteName -PublicRoot $publicPath -ApplicationPoolName $ApplicationPoolName -Lock $lock
    $maintenanceUrls = if ($MaintenanceVerificationUrl.Count) { $MaintenanceVerificationUrl } else { @($VerificationUrl) }
    Wait-NetariumMaintenanceReady $maintenance $maintenanceUrls
    if ($maintenance.PoolState -eq 'Started') { Wait-NetariumRequestDrain -ApplicationPoolName $ApplicationPoolName -TimeoutSeconds $DrainTimeoutSeconds }
    $drainCompleted = $true
    $worker = Start-FullWorker $phpPath $installRootPath
    Invoke-FullWorker $worker @{ command = 'lock' } | Out-Null
    Stop-NetariumSiteIfRunning $SiteName
    Stop-NetariumAppPoolIfRunning $ApplicationPoolName
    $maintenance.Phase = 'mutating'; Save-NetariumMaintenanceJournal $maintenance
    $snapshotPath = New-NetariumSnapshot -RollbackRoot $rollbackRootPath -InstallRoot $installRootPath -StorageDir $storagePath -SiteName $SiteName -ApplicationPoolName $ApplicationPoolName -Stage 'update' -PhpCgiPath $PhpCgiPath -DatabaseSchemaVersion 0 -IisState $state

    Replace-NetariumProgramManifest -StagedRoot $stagingPath -InstallRoot $installRootPath
    Set-NetariumAcl -InstallRoot $installRootPath -StorageDir $storagePath -ApplicationPoolName $ApplicationPoolName
    $checkStarted = $true
    Invoke-NetariumUpdateCheck -AppRoot $installRootPath -StorageDir $storagePath -PhpPath $phpPath | Out-Null

    $maintenance.Phase = 'checked'; Save-NetariumMaintenanceJournal $maintenance
    Invoke-FullWorker $worker @{ command = 'unlock' } | Out-Null
    Complete-NetariumMaintenance $maintenance
    $maintenance = $null
    if ($state.Site.State -eq 'Started' -and $state.AppPool.State -eq 'Started') {
        Assert-NetariumUpdateHttpState -VerificationUrl $VerificationUrl
        & (Join-Path $PSScriptRoot 'verify-security.ps1') -VerificationUrl $VerificationUrl
    }
    Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction Stop
    Write-Host "Netarium update completed. Rollback snapshot: $snapshotPath" -ForegroundColor Green
    exit 0
} catch {
    $failure = $_
    $rollbackFailure = $null

    if ($snapshotPath) {
        try {
            Stop-NetariumSiteIfRunning $SiteName
            Stop-NetariumAppPoolIfRunning $ApplicationPoolName
            if ($maintenance) { $maintenance.Phase = 'mutating'; Save-NetariumMaintenanceJournal $maintenance }
            # Snapshot restoration may write IIS settings; remove our owned overrides first.
            if ($maintenance) { Remove-NetariumMaintenance $maintenance }
            Restore-NetariumSnapshot -SnapshotPath $snapshotPath -InstallRoot $installRootPath -StorageDir $storagePath -KeepIisStopped -KeepRequestFiltering -KeepDefaultDocument | Out-Null
            Invoke-NetariumUpdateCheck -AppRoot $installRootPath -StorageDir $storagePath -PhpPath $phpPath | Out-Null
            Close-FullWorker $worker; $worker = $null
            if ($maintenance) {
                $maintenance.Phase = 'checked'; Save-NetariumMaintenanceJournal $maintenance
                if (Test-Path -LiteralPath $maintenance.File) {
                    if ([IO.File]::ReadAllText($maintenance.File) -cne $maintenance.Body) { throw 'Restored maintenance payload ownership conflict.' }
                    Remove-Item -LiteralPath $maintenance.File -Force
                }
                Resume-NetariumMaintenanceState $maintenance
                Remove-Item -LiteralPath $maintenance.JournalPath -Force
                Remove-Item -LiteralPath $maintenance.OwnerPath -Force
                $maintenance = $null
            } else {
                if ($state.AppPool.State -eq 'Started') { Start-WebAppPool -Name $ApplicationPoolName }
                if ($state.Site.State -eq 'Started') { Start-Website -Name $SiteName }
            }
            $restored = $true
        } catch {
            $rollbackFailure = $_
            Stop-NetariumSiteIfRunning $SiteName
            Stop-NetariumAppPoolIfRunning $ApplicationPoolName
        }
    } elseif ($maintenance) {
        try {
            Close-FullWorker $worker; $worker = $null
            Complete-NetariumMaintenance $maintenance
            $maintenance = $null
        } catch { $rollbackFailure = $_ }
    }

    if (Test-Path -LiteralPath $stagingPath) {
        Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($rollbackFailure) {
        Write-Error "Update failed at stage with snapshot ${snapshotPath}; rollback failed: $($rollbackFailure.Exception.Message). PHP remains blocked and the snapshot must be restored manually."
    } elseif (-not $restored -and $maintenance) {
        Write-Error "Update failed with maintenance active. Snapshot: ${snapshotPath}. Stage: $($failure.Exception.Message)"
    } elseif (-not $restored) {
        Write-Error "Update failed: $($failure.Exception.Message)"
    }
    exit 1
} finally {
    Close-FullWorker $worker
    if ($lock) { $lock.Stream.Dispose() }
}
