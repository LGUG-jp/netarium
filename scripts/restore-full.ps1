[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$SiteName,
    [Parameter(Mandatory = $true)][string]$ApplicationPoolName,
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$WorkRoot,
    [string]$PhpPath = 'php.exe',
    [long]$MaxExpandedBytes = 107374182400,
    [int]$MaxFiles = 100000,
    # One safe site-root URL for each binding; only required when site and pool started.
    [string[]]$VerificationUrl = @(),
    [int]$DrainTimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'full-backup-common.ps1')
$worker = $null; $context = $null; $stopped = $false; $safeToResume = $true; $stage = $null
$placements = @(); $succeeded = $false
$maintenanceLock = $null
try {
    Assert-Administrator
    $maintenanceLock = Enter-NetariumMaintenanceLock $InstallRoot
    if ($MaxExpandedBytes -le 0 -or $MaxFiles -le 0) { throw 'Invalid archive limits' }
    $archivePath = Assert-FullPath $Archive
    $worker = Start-FullWorker $PhpPath (Assert-FullPath $InstallRoot)
    $context = Get-FullContext $worker $InstallRoot $SiteName $ApplicationPoolName $WorkRoot
    foreach ($target in $context.Targets) { if (Test-NetariumPathOverlap $archivePath $target) { throw 'Archive overlaps live data' } }
    $stage = Join-Path $context.WorkRoot ([Guid]::NewGuid().ToString('N'))
    New-NetariumPrivateDirectory $stage
    # Protect a private copy; archive cannot change between preflight and extraction.
    Copy-Item -LiteralPath $archivePath -Destination (Join-Path $stage 'input.zip')
    Set-NetariumPrivateAcl (Join-Path $stage 'input.zip')
    $payload = Join-Path $stage 'payload'
    New-NetariumPrivateDirectory $payload
    $manifest = Invoke-FullWorker $worker @{ command = 'extract'; archive = (Join-Path $stage 'input.zip'); root = $payload; max_bytes = $MaxExpandedBytes; max_files = $MaxFiles }
    $logical = @('db/data.sqlite', 'floorplans', 'device_images')
    # Same-volume sibling staging makes placement/rollback renames independent of copying.
    for ($i = 0; $i -lt $context.Targets.Count; $i++) {
        $target = [IO.Path]::GetFullPath($context.Targets[$i])
        $parent = Split-Path -Parent $target
        Assert-FullSpace $parent ([long]$manifest.total_bytes * 2)
        if (-not (Test-Path -LiteralPath $parent)) { New-NetariumPrivateDirectory $parent }
        $token = [Guid]::NewGuid().ToString('N')
        $container = Join-Path $parent ('.netarium-stage-' + $token)
        New-NetariumPrivateDirectory $container
        $new = Join-Path $container 'new'
        $old = Join-Path $container 'old'
        $p = [pscustomobject]@{ Target = $target; Container = $container; New = $new; Old = $old; Saved = $false; Installed = $false }
        $placements += $p
        Copy-Item -LiteralPath (Join-Path $payload $logical[$i]) -Destination $new -Recurse
        Assert-FullPath $new | Out-Null
    }
    $stopped = $true
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Stop-FullSite $context $worker $maintenanceLock $VerificationUrl $DrainTimeoutSeconds
    Invoke-FullWorker $worker @{ command = 'checkpoint' } | Out-Null
    Assert-FullSidecars $context.Config.db_file
    $safeToResume = $false
    try {
        foreach ($p in $placements) {
            Assert-FullPath $p.Target | Out-Null
            if (Test-Path -LiteralPath $p.Target) { Move-Item -LiteralPath $p.Target -Destination $p.Old; $p.Saved = $true }
            Move-Item -LiteralPath $p.New -Destination $p.Target; $p.Installed = $true
            Set-NetariumPrivateAcl $p.Target -ApplicationPoolName $ApplicationPoolName
            if (Test-Path -LiteralPath $p.Target -PathType Container) {
                foreach ($file in @(Get-ChildItem -LiteralPath $p.Target -File -Force)) { Set-NetariumPrivateAcl $file.FullName -ApplicationPoolName $ApplicationPoolName }
            }
        }
        # This is the app-specific directory, never PHP's shared session.save_path.
        $sessions = Join-Path $context.Config.storage_dir 'sessions'
        Assert-FullPath $sessions | Out-Null
        if (Test-Path -LiteralPath $sessions) {
            foreach ($file in @(Get-ChildItem -LiteralPath $sessions -Force)) {
                if ($file.PSIsContainer -or $file.Name -notmatch '^sess_[A-Za-z0-9,-]+$') { throw 'Unexpected app session entry; keep site stopped and inspect' }
                Remove-Item -LiteralPath $file.FullName -Force
            }
        }
        $oldStorage = $env:NETARIUM_STORAGE_DIR; $oldDb = $env:NETARIUM_DB_FILE
        try {
            $env:NETARIUM_STORAGE_DIR = [string]$context.Config.storage_dir
            $env:NETARIUM_DB_FILE = [string]$context.Config.db_file
            $checkOutput = & $PhpPath (Join-Path $InstallRoot 'scripts/check-install.php') --app-root $InstallRoot --storage-dir ([string]$context.Config.storage_dir) --db-file ([string]$context.Config.db_file) --allow-orphan-images
            if ($LASTEXITCODE -ne 0) { throw "Post-placement installation check failed: $checkOutput" }
        } finally { $env:NETARIUM_STORAGE_DIR = $oldStorage; $env:NETARIUM_DB_FILE = $oldDb }
        $safeToResume = $true
        $succeeded = $true
    } catch {
        $failure = $_
        try {
            # First remove any WAL generated by post-install checks, only for the new DB.
            if ($placements[0].Installed) {
                foreach ($suffix in @('-wal', '-shm', '-journal')) {
                    $sidecar = $context.Config.db_file + $suffix
                    Assert-FullPath $sidecar | Out-Null
                    if (Test-Path -LiteralPath $sidecar) { Remove-Item -LiteralPath $sidecar -Force }
                }
            }
            foreach ($p in $placements) {
                if ($p.Installed -and (Test-Path -LiteralPath $p.Target)) { Remove-Item -LiteralPath $p.Target -Recurse -Force }
                if ($p.Saved) { Move-Item -LiteralPath $p.Old -Destination $p.Target }
            }
            $safeToResume = $true
        } catch { throw "Restore failed: $($failure.Exception.Message). Rollback failed: $($_.Exception.Message). Site/pool remain stopped; protected rollback files: $($placements.Container -join ', ')" }
        throw $failure
    }
    Invoke-FullWorker $worker @{ command = 'unlock' } | Out-Null
    Resume-FullSite $context
    $stopped = $false; $timer.Stop()
    [pscustomobject]@{ Restored = $true; Files = $manifest.file_count; Bytes = $manifest.total_bytes; StopSeconds = $timer.Elapsed.TotalSeconds }
} finally {
    try {
        Close-FullWorker $worker; $worker = $null
        if ($context -and $context.Maintenance) {
            if ($safeToResume) { Resume-FullSite $context }
            else {
                Stop-NetariumSiteIfRunning $SiteName
                Stop-NetariumAppPoolIfRunning $ApplicationPoolName
            }
        }
    }
    finally {
        Close-FullWorker $worker
        if ($safeToResume) {
            foreach ($p in $placements) { if (Test-Path -LiteralPath $p.Container) { Remove-Item -LiteralPath $p.Container -Recurse -Force } }
            if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
        }
        if ($maintenanceLock) { $maintenanceLock.Stream.Dispose() }
    }
}
