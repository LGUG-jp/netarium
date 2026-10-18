Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'deployment-common.ps1')

function Assert-FullPath {
    param([string]$Path)
    $p = [IO.Path]::GetFullPath($Path)
    if ($p.StartsWith('\\')) { throw 'Full backup requires local fixed disks, not UNC paths.' }
    $current = $p
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point rejected: $current" }
        }
        $parent = Split-Path -Parent $current
        if ($parent -eq $current) { break }
        $current = $parent
    }
    if (Test-Path -LiteralPath $p -PathType Container) {
        foreach ($item in @(Get-ChildItem -LiteralPath $p -Force -Recurse)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point rejected: $($item.FullName)" }
        }
    }
    return $p
}

function Start-FullWorker {
    param([string]$PhpPath, [string]$InstallRoot)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $PhpPath
    $helper = Join-Path $PSScriptRoot 'full-backup-helper.php'
    if ($helper.Contains('"') -or $InstallRoot.Contains('"')) { throw 'Invalid worker argument' }
    $info.Arguments = '"' + $helper + '" "' + $InstallRoot.TrimEnd('\') + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'Cannot start PHP helper' }
    return $process
}

function Invoke-FullWorker {
    param($Worker, [hashtable]$Request)
    $Worker.StandardInput.WriteLine(($Request | ConvertTo-Json -Compress -Depth 20))
    $Worker.StandardInput.Flush()
    $line = $Worker.StandardOutput.ReadLine()
    if ($null -eq $line) { throw 'PHP helper terminated unexpectedly' }
    $response = $line | ConvertFrom-Json
    if (-not $response.ok) { throw $response.error }
    return $response.result
}

function Close-FullWorker {
    param($Worker)
    if ($null -ne $Worker) {
        $Worker.StandardInput.Close()
        if (-not $Worker.WaitForExit(10000)) { $Worker.Kill(); $Worker.WaitForExit() }
        $Worker.Dispose()
    }
}

function Get-FullContext {
    param($Worker, [string]$InstallRoot, [string]$SiteName, [string]$ApplicationPoolName, [string]$WorkRoot)
    Assert-Administrator
    Assert-WebAdministration
    Assert-NetariumAppPoolIdentityIsolation -ApplicationPoolName $ApplicationPoolName
    $root = Assert-FullPath $InstallRoot
    $work = Assert-FullPath $WorkRoot
    $config = Invoke-FullWorker $Worker @{ command = 'config' }
    $targets = @([string]$config.db_file, [string]$config.floor_plan_directory, [string]$config.device_image_directory)
    foreach ($path in @($targets + @([string]$config.operation_lock_file, (Join-Path $config.storage_dir 'sessions')))) { Assert-FullPath $path | Out-Null }
    for ($i = 0; $i -lt $targets.Count; $i++) {
        for ($j = $i + 1; $j -lt $targets.Count; $j++) {
            if (Test-NetariumPathOverlap $targets[$i] $targets[$j]) { throw 'Data targets overlap' }
        }
        if (Test-NetariumPathOverlap $work $targets[$i]) { throw 'Workspace overlaps live data' }
    }
    if (Test-NetariumPathOverlap $work (Join-Path $root 'public')) { throw 'Workspace must be outside public root' }
    foreach ($site in @(Get-Website)) {
        $public = [Environment]::ExpandEnvironmentVariables([string]$site.PhysicalPath)
        if ($public -and (Test-NetariumPathOverlap $work $public)) { throw 'Workspace overlaps an IIS public root' }
        if ([string]$site.Name -ne $SiteName -and [string]$site.ApplicationPool -eq $ApplicationPoolName) { throw 'Application pool is shared by another site' }
    }
    $state = Get-IisState -SiteName $SiteName -ApplicationPoolName $ApplicationPoolName
    $siteMatches = $state.SiteExists -and $state.AppPoolExists -and
        ($state.Site.ApplicationPool -eq $ApplicationPoolName) -and
        ([IO.Path]::GetFullPath($state.Site.PhysicalPath).TrimEnd('\') -ieq (Join-Path $root 'public').TrimEnd('\'))
    if (-not $siteMatches) { throw 'Site/pool/install root mismatch' }
    if ($state.Site.State -notin @('Started', 'Stopped') -or $state.AppPool.State -notin @('Started', 'Stopped')) { throw 'IIS is transitioning' }
    New-NetariumPrivateDirectory $work
    return [pscustomobject]@{ Config = $config; State = $state; WorkRoot = $work; Targets = $targets; Maintenance = $null }
}

function Stop-FullSite {
    param($Context, $Worker, $Lock, [string[]]$VerificationUrl, [int]$DrainTimeoutSeconds = 120)
    $Context.Maintenance = Set-NetariumMaintenance -SiteName $Context.State.SiteName -PublicRoot $Context.State.Site.PhysicalPath -ApplicationPoolName $Context.State.ApplicationPoolName -Lock $Lock
    Wait-NetariumMaintenanceReady $Context.Maintenance $VerificationUrl
    # Zero active IIS requests is server-side drainage, not client receipt evidence.
    if ($Context.Maintenance.PoolState -eq 'Started') { Wait-NetariumRequestDrain $Context.State.ApplicationPoolName -TimeoutSeconds $DrainTimeoutSeconds }
    Invoke-FullWorker $Worker @{ command = 'lock' } | Out-Null
    Stop-NetariumSiteIfRunning $Context.State.SiteName
    Stop-NetariumAppPoolIfRunning $Context.State.ApplicationPoolName
    $Context.Maintenance.Phase = 'mutating'
    Save-NetariumMaintenanceJournal $Context.Maintenance
}

function Resume-FullSite {
    param($Context)
    if ($null -ne $Context.Maintenance) {
        Complete-NetariumMaintenance $Context.Maintenance
        $Context.Maintenance = $null
    }
}

function Assert-FullSpace {
    param([string]$Path, [long]$Bytes)
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path)))
    if ($drive.AvailableFreeSpace -lt ($Bytes + 64MB)) { throw "Insufficient disk space: $Path (required $($Bytes + 64MB) bytes)" }
}

function Copy-FullImages {
    param([string]$Source, [string]$Destination)
    New-NetariumPrivateDirectory $Destination
    if (Test-Path -LiteralPath $Source) {
        Assert-FullPath $Source | Out-Null
        foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force)) {
            if ($item.PSIsContainer) { throw 'Unexpected image subdirectory' }
            Copy-Item -LiteralPath $item.FullName -Destination $Destination -ErrorAction Stop
        }
    }
}

function Assert-FullSidecars {
    param([string]$DbPath)
    foreach ($suffix in @('-wal', '-shm', '-journal')) {
        if (Test-Path -LiteralPath ($DbPath + $suffix)) { throw "SQLite sidecar remains; inspect/checkpoint under maintenance before restore: $DbPath$suffix" }
    }
}
