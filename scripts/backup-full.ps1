[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$SiteName,
    [Parameter(Mandatory = $true)][string]$ApplicationPoolName,
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [string]$PhpPath = 'php.exe',
    # One safe site-root URL for each binding; only required when site and pool started.
    [string[]]$VerificationUrl = @(),
    [int]$DrainTimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'full-backup-common.ps1')
$worker = $null; $context = $null; $stopped = $false; $stage = $null; $partial = $null
$maintenanceLock = $null
try {
    Assert-Administrator
    $maintenanceLock = Enter-NetariumMaintenanceLock $InstallRoot
    $PhpPath = Resolve-FullPhpPath $PhpPath
    $worker = Start-FullWorker $PhpPath (Assert-FullPath $InstallRoot)
    $context = Get-FullContext $worker $InstallRoot $SiteName $ApplicationPoolName $BackupDirectory
    $stage = Join-Path $context.WorkRoot ([Guid]::NewGuid().ToString('N'))
    New-NetariumPrivateDirectory $stage
    $total = 0L
    foreach ($path in $context.Targets) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { $total += (Get-Item -LiteralPath $path).Length }
        elseif (Test-Path -LiteralPath $path) { foreach ($f in @(Get-ChildItem -LiteralPath $path -File -Force -Recurse)) { $total += $f.Length } }
    }
    Assert-FullSpace $stage ($total * 3)
    $stopped = $true
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Stop-FullSite $context $worker $maintenanceLock $VerificationUrl $DrainTimeoutSeconds
    New-NetariumPrivateDirectory (Join-Path $stage 'db')
    Invoke-FullWorker $worker @{ command = 'snapshot'; destination = (Join-Path $stage 'db/data.sqlite') } | Out-Null
    Copy-FullImages $context.Config.floor_plan_directory (Join-Path $stage 'floorplans')
    Copy-FullImages $context.Config.device_image_directory (Join-Path $stage 'device_images')
    Invoke-FullWorker $worker @{ command = 'prepare'; root = $stage } | Out-Null
    Invoke-FullWorker $worker @{ command = 'unlock' } | Out-Null
    Resume-FullSite $context
    $stopped = $false
    $timer.Stop()
    $name = 'netarium-full-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.zip'
    $destination = Join-Path $context.WorkRoot $name
    $partial = $destination + '.partial'
    $manifest = Invoke-FullWorker $worker @{ command = 'pack'; root = $stage; destination = $partial }
    Set-NetariumPrivateAcl $partial
    Move-Item -LiteralPath $partial -Destination $destination
    $partial = $null
    [pscustomobject]@{ Archive = $destination; SHA256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash; StopSeconds = $timer.Elapsed.TotalSeconds; Files = $manifest.file_count; Bytes = $manifest.total_bytes }
} finally {
    try {
        if ($context -and $context.Maintenance) {
            # A backup never places live data; release the worker gate before recovery.
            Close-FullWorker $worker; $worker = $null
            Resume-FullSite $context
        }
    }
    finally {
        Close-FullWorker $worker
        if ($partial -and (Test-Path -LiteralPath $partial)) { Remove-Item -LiteralPath $partial -Force }
        if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
        if ($maintenanceLock) { $maintenanceLock.Stream.Dispose() }
    }
}
