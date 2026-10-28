[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$SiteName,
    [string]$ApplicationPoolName,
    [string]$PhpCgiPath,
    [Alias('BaseUrl')][string]$VerificationUrl,
    [int]$MinimumPhpMemoryLimitMiB,
    [int]$MinimumPhpMaxExecutionTimeSeconds,
    [int]$FastCgiActivityTimeoutSeconds,
    [int]$FastCgiRequestTimeoutSeconds,
    [string]$SourcePath,
    [ValidateSet('http', 'https', 'existing')][string]$Protocol,
    [ValidateRange(1, 65535)][int]$Port,
    [Alias('HostHeader')][string]$HostName = '',
    [string]$CertificateThumbprint,
    [string]$RollbackRoot,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'deployment-common.ps1')


function Get-NetariumPhpCliPath {
    param([Parameter(Mandatory = $true)][string]$CgiPath)

    $candidate = Join-Path (Split-Path -Parent $CgiPath) 'php.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
    }

    $command = Get-Command php -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw 'PHP CLI executable is required for Netarium preflight checks.'
}

function ConvertFrom-NetariumPhpSize {
    param([Parameter(Mandatory = $true)][string]$Value)

    $normalized = $Value.Trim().ToUpperInvariant()
    if ($normalized -eq '-1' -or $normalized -eq 'UNLIMITED') {
        return -1.0
    }

    if ($normalized -notmatch '\A([0-9]+(?:\.[0-9]+)?)([KMG]?)\z') {
        throw "Unsupported PHP size value: $Value"
    }

    $number = [double]$Matches[1]
    switch ($Matches[2]) {
        'K' { $number *= 1KB }
        'M' { $number *= 1MB }
        'G' { $number *= 1GB }
    }
    return $number
}

function Get-NetariumPhpIniValue {
    param(
        [Parameter(Mandatory = $true)][string]$Info,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $value = $null
    foreach ($line in ($Info -split "`r?`n")) {
        if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=>\s*([^\s]+)\s*=>')) {
            $value = $Matches[1]
        }
    }
    if ($null -eq $value) {
        foreach ($line in ($Info -split "`r?`n")) {
            if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=>\s*([^\s]+)')) {
                $value = $Matches[1]
            }
        }
    }
    if ($null -eq $value) {
        $htmlPattern = '<tr[^>]*>\s*<td[^>]*>\s*' + [regex]::Escape($Name) + '\s*</td>\s*<td[^>]*>(.*?)</td>'
        foreach ($line in ($Info -split "`r?`n")) {
            if ($line -match $htmlPattern) {
                # Strip markup before decoding so encoded angle brackets remain part of the value.
                $value = [System.Net.WebUtility]::HtmlDecode([regex]::Replace($Matches[1], '<[^>]+>', '')).Trim()
                break
            }
        }
    }
    if ($null -eq $value) {
        throw "Active PHP INI value is unavailable: $Name"
    }
    return $value
}

function Get-NetariumSQLiteVersion {
    param(
        [Parameter(Mandatory = $true)][string]$CgiPath
    )

    $probePath = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText(
            $probePath,
            '<?php echo SQLite3::version()["versionString"];',
            (New-Object System.Text.UTF8Encoding($false))
        )
        $versionText = (& $CgiPath -q -f $probePath 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '\A[0-9]+\.[0-9]+\.[0-9]+\z') {
            throw "SQLite library version could not be determined from PHP CGI: $versionText"
        }
        return [version]$versionText
    } finally {
        Remove-Item -LiteralPath $probePath -Force
    }
}

function Assert-NetariumPhpRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$CgiPath,
        [Parameter(Mandatory = $true)][int]$MinimumMemoryMiB,
        [Parameter(Mandatory = $true)][int]$MinimumExecutionSeconds
    )

    if (-not (Test-Path -LiteralPath $CgiPath -PathType Leaf)) {
        throw "PHP CGI executable does not exist: $CgiPath"
    }

    $versionText = (& $CgiPath -v 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "PHP CGI version check failed: $versionText"
    }
    if ($versionText -notmatch 'PHP\s+([0-9]+\.[0-9]+\.[0-9]+)') {
        throw 'PHP CGI version could not be parsed.'
    }
    $phpVersion = [version]$Matches[1]
    if ($phpVersion -lt [version]'8.5.5') {
        throw "PHP 8.5.5 or newer is required; found $phpVersion."
    }

    $modules = @(& $CgiPath -m 2>&1 | ForEach-Object { $_.ToString().Trim().ToLowerInvariant() })
    if ($LASTEXITCODE -ne 0) {
        throw 'PHP extension check failed.'
    }
    foreach ($extension in @('pdo', 'pdo_sqlite', 'sqlite3', 'fileinfo', 'zip', 'session', 'json', 'gd', 'exif', 'mbstring')) {
        if (-not ($modules -contains $extension)) {
            throw "Required PHP extension is missing: $extension"
        }
    }

    $sqliteVersion = Get-NetariumSQLiteVersion -CgiPath $CgiPath
    if ($sqliteVersion -lt [version]'3.51.3') {
        throw "SQLite 3.51.3 or newer is required; found $sqliteVersion."
    }
    $passwordRuntime = Assert-NetariumArgon2Runtime -PhpPath $CgiPath -Cgi

    $info = (& $CgiPath -i 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "PHP CGI information check failed: $info"
    }

    $uploadBytes = ConvertFrom-NetariumPhpSize (Get-NetariumPhpIniValue -Info $info -Name 'upload_max_filesize')
    $postBytes = ConvertFrom-NetariumPhpSize (Get-NetariumPhpIniValue -Info $info -Name 'post_max_size')
    $maxFiles = [int](Get-NetariumPhpIniValue -Info $info -Name 'max_file_uploads')
    $memoryValue = Get-NetariumPhpIniValue -Info $info -Name 'memory_limit'
    $executionSeconds = [int](Get-NetariumPhpIniValue -Info $info -Name 'max_execution_time')
    $memoryBytes = ConvertFrom-NetariumPhpSize $memoryValue

    if ($uploadBytes -lt (32MB)) {
        throw "upload_max_filesize must be at least 32M; found $uploadBytes bytes."
    }
    if ($postBytes -lt (34MB)) {
        throw "post_max_size must be at least 34M; found $postBytes bytes."
    }
    if ($maxFiles -lt 20) {
        throw "max_file_uploads must be at least 20; found $maxFiles."
    }
    if ($memoryBytes -ge 0 -and $memoryBytes -lt ($MinimumMemoryMiB * 1MB)) {
        throw "memory_limit is below the requested minimum: $memoryValue"
    }
    if ($executionSeconds -ne 0 -and $executionSeconds -lt $MinimumExecutionSeconds) {
        throw "max_execution_time is below the requested minimum: $executionSeconds"
    }
    $errorLogValue = Get-NetariumPhpIniValue -Info $info -Name 'error_log'
    if ([string]::IsNullOrWhiteSpace($errorLogValue) -or $errorLogValue -eq 'no value') {
        throw "PHP error_log is not configured in php.ini. Under IIS FastCGI (stderrMode=ReturnStdErrIn500), an unconfigured error_log outputs error messages to STDERR, causing IIS to convert application 503 responses (such as SQLite busy) into HTTP 500. Configure a dedicated log file path for error_log in php.ini."
    }
    if ($errorLogValue -notmatch '\A(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])' -or
        $errorLogValue -match '://') {
        throw 'PHP error_log must be an absolute file path, not a relative path or URI.'
    }
    $errorLogParent = Split-Path -Path $errorLogValue -Parent
    if (-not (Test-Path -LiteralPath $errorLogParent -PathType Container) -or
        (Test-Path -LiteralPath $errorLogValue -PathType Container)) {
        throw 'PHP error_log must name a file in an existing directory. Prepare the log directory and application-pool write permissions before setup.'
    }

    return [pscustomobject]@{
        PhpVersion = $phpVersion.ToString()
        SQLiteVersion = $sqliteVersion.ToString()
        PasswordAlgorithm = $passwordRuntime.algorithm
        PasswordOptions = $passwordRuntime.options
        UploadMaxFilesize = $uploadBytes
        PostMaxSize = $postBytes
        MaxFileUploads = $maxFiles
        MemoryLimit = $memoryValue
        MaxExecutionTime = $executionSeconds
        ErrorLog = $errorLogValue
    }
}

function Assert-NetariumFreshDestination {
    param([Parameter(Mandatory = $true)][string]$DestinationRoot)

    $destination = ConvertTo-NetariumAbsolutePath -Path $DestinationRoot
    # Inspect ancestors too: a junction above an absent InstallRoot is not isolated.
    for ($path = $destination; $path; $path = Split-Path -Parent $path) {
        if (Test-Path -LiteralPath $path) {
            $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
            if (-not $item.PSIsContainer -or
                ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Fresh setup destination must be a directory without reparse points: $path"
            }
        }
    }
    if (-not (Test-Path -LiteralPath $destination)) { return }

    $allowedDirectories = @($script:NetariumReleaseManifest.Directories) + @('config')
    foreach ($item in Get-ChildItem -LiteralPath $destination -Force -ErrorAction Stop) {
        if (-not $item.PSIsContainer -or $item.Name -notin $allowedDirectories -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop).Count -ne 0) {
            throw "Fresh setup requires an empty destination or known empty release directories; existing item is not supported: $($item.FullName)"
        }
    }
}

function Copy-NetariumReleaseManifest {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $source = ConvertTo-NetariumAbsolutePath -Path $SourceRoot
    $destination = ConvertTo-NetariumAbsolutePath -Path $DestinationRoot
    Assert-NetariumFreshDestination -DestinationRoot $destination
    New-Item -ItemType Directory -Path $destination -Force | Out-Null

    foreach ($relativePath in $script:NetariumReleaseManifest.Directories) {
        $sourcePath = Join-Path $source $relativePath
        $destinationPath = Join-Path $destination $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
            throw "Release directory disappeared during staging: $relativePath"
        }
        Copy-NetariumDirectoryContents -Source $sourcePath -Destination $destinationPath
    }

    foreach ($relativePath in $script:NetariumReleaseManifest.Files) {
        $windowsPath = $relativePath -replace '/', '\'
        $sourcePath = Join-Path $source $windowsPath
        $destinationPath = Join-Path $destination $windowsPath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Release file disappeared during staging: $relativePath"
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force -ErrorAction Stop
    }
}

function New-NetariumRuntimeTree {
    param([Parameter(Mandatory = $true)][string]$StorageDir)

    foreach ($relativePath in @(
        '',
        'db',
        'db/csv-import',
        'uploads',
        'uploads/floorplans',
        'uploads/device_images',
        'backups',
        'backups/auto',
        'logs',
        'temp',
        'sessions',
        'temp/backup-export',
        'temp/backup-restore'
    )) {
        New-Item -ItemType Directory -Path (Join-Path $StorageDir $relativePath) -Force | Out-Null
    }
}

function New-NetariumAppConfig {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$StorageDir
    )

    $configPath = Join-Path $InstallRoot 'config/app.php'
    $storageValue = (ConvertTo-NetariumAbsolutePath -Path $StorageDir).Replace('\', '\\').Replace("'", "\'")
    $content = @"
<?php
declare(strict_types=1);

return [
    'storage_dir' => '$storageValue',
];
"@

    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $existing = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
        if ($existing -ne $content) {
            throw "Environment-specific config already exists with different content: $configPath"
        }
        return
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $configPath) -Force | Out-Null
    [System.IO.File]::WriteAllText($configPath, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-NetariumEnvironmentMap {
    param([Parameter(Mandatory = $true)][psobject]$IisState)

    $map = @{}
    foreach ($collection in @(
        @($IisState.Site.EnvironmentVariables),
        @($IisState.AppPool.EnvironmentVariables),
        @($IisState.FastCgi | ForEach-Object { @($_.EnvironmentVariables) })
    )) {
        foreach ($entry in @($collection)) {
            if ($entry -and $entry.Name) {
                $map[[string]$entry.Name] = [string]$entry.Value
            }
        }
    }
    return $map
}


function Merge-NetariumTree {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        return
    }
    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null

    foreach ($sourceItem in Get-ChildItem -LiteralPath $SourceRoot -Recurse -File -Force) {
        $relative = $sourceItem.FullName.Substring($SourceRoot.TrimEnd('\').Length + 1)
        $destination = Join-Path $DestinationRoot $relative
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            $sourceHash = (Get-FileHash -LiteralPath $sourceItem.FullName -Algorithm SHA256).Hash
            $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
            if ($sourceHash -ne $destinationHash) {
                throw "Conflicting runtime file hashes: $relative"
            }
            continue
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $sourceItem.FullName -Destination $destination -Force -ErrorAction Stop
    }
}


function Invoke-NetariumInstallCheck {
    param(
        [Parameter(Mandatory = $true)][string]$AppRoot,
        [Parameter(Mandatory = $true)][string]$StorageDir,
        [Parameter(Mandatory = $true)][string]$PhpCgiPath
    )

    $php = Get-NetariumPhpCliPath -CgiPath $PhpCgiPath
    $checkScript = Join-Path $AppRoot 'scripts/check-install.php'
    if (-not (Test-Path -LiteralPath $checkScript -PathType Leaf)) {
        throw "CLI installation check is missing: $checkScript"
    }

    $output = @(& $php $checkScript --app-root (ConvertTo-NetariumAbsolutePath -Path $AppRoot) --storage-dir (ConvertTo-NetariumAbsolutePath -Path $StorageDir) 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "CLI installation check failed: $($output -join [Environment]::NewLine)"
    }
    $json = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $json.ok) {
        throw "CLI installation check returned failure: $($json.error)"
    }
    return $json
}

function Invoke-NetariumBootstrapSecret {
    param(
        [Parameter(Mandatory = $true)][string]$AppRoot,
        [Parameter(Mandatory = $true)][string]$StorageDir,
        [Parameter(Mandatory = $true)][string]$PhpCgiPath
    )

    Set-NetariumBootstrapAcl -StorageDir $StorageDir
    $php = Get-NetariumPhpCliPath -CgiPath $PhpCgiPath
    $issuer = Join-Path $AppRoot 'scripts/issue-bootstrap-secret.php'
    if (-not (Test-Path -LiteralPath $issuer -PathType Leaf)) {
        throw "Bootstrap secret CLI is missing: $issuer"
    }
    $file = Join-Path (Join-Path (ConvertTo-NetariumAbsolutePath -Path $StorageDir) 'bootstrap') (
        'setup-' + [Guid]::NewGuid().ToString('N') + '.secret'
    )
    $db = Join-Path (ConvertTo-NetariumAbsolutePath -Path $StorageDir) 'db/data.sqlite'
    # Only a file path crosses stdout; never read the secret into PowerShell.
    $output = @(& $php $issuer --secret-file $file --db $db 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw 'Bootstrap secret issuance failed. Keep the site stopped and review the protected storage and initial-registration state.'
    }
    Write-Host "Bootstrap secret file (local administrators only): $file"
    return $file
}

function Get-NetariumSitePath {
    param([Parameter(Mandatory = $true)][string]$SiteName)
    return "IIS:\Sites\$SiteName"
}

function Ensure-NetariumAppPool {
    param(
        [Parameter(Mandatory = $true)][string]$ApplicationPoolName,
        [Parameter(Mandatory = $true)][string]$SiteName
    )

    $poolPath = "IIS:\AppPools\$ApplicationPoolName"
    $created = $false
    if (-not (Test-Path -LiteralPath $poolPath)) {
        New-WebAppPool -Name $ApplicationPoolName -ErrorAction Stop | Out-Null
        Set-ItemProperty -LiteralPath $poolPath -Name managedRuntimeVersion -Value '' -ErrorAction Stop
        Set-ItemProperty -LiteralPath $poolPath -Name processModel.identityType -Value ApplicationPoolIdentity -ErrorAction Stop
        $created = $true
    } else {
        Assert-NetariumAppPoolIdentityIsolation -ApplicationPoolName $ApplicationPoolName
    }

    foreach ($site in @(Get-Website)) {
        if (
            ([string]$site.ApplicationPool -ieq $ApplicationPoolName) -and
            ([string]$site.Name -ine $SiteName)
        ) {
            throw "Application pool is assigned to another IIS site: $($site.Name)"
        }
    }
    return $created
}

function Assert-NetariumCertificate {
    param(
        [Parameter(Mandatory = $true)][string]$Thumbprint,
        [Parameter(Mandatory = $true)][string]$HostName
    )

    $hash = ($Thumbprint -replace '\s', '').ToUpperInvariant()
    if ($hash -notmatch '\A[0-9A-F]{40}\z') {
        throw 'CertificateThumbprint must be a SHA-1 certificate thumbprint (40 hexadecimal characters).'
    }
    $certificate = Get-Item -LiteralPath "Cert:\LocalMachine\My\$hash" -ErrorAction SilentlyContinue
    if (-not $certificate -or -not $certificate.HasPrivateKey -or $certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date)) {
        throw 'The HTTPS certificate must be valid and have a private key in LocalMachine/My.'
    }
    if (@($certificate.DnsNameList | Where-Object { [string]$_.Unicode -ieq $HostName }).Count -eq 0) {
        throw "The HTTPS certificate SAN must include the service FQDN: $HostName"
    }
    if (@($certificate.EnhancedKeyUsageList | Where-Object { [string]$_.ObjectId -eq '1.3.6.1.5.5.7.3.1' }).Count -eq 0) {
        throw 'The HTTPS certificate must allow Server Authentication.'
    }
    return $hash
}

function Get-NetariumVerificationUrl {
    param([string]$Protocol, [int]$Port, [string]$HostName)

    $hostPart = if ($HostName) { $HostName } else { 'localhost' }
    $portPart = if (($Protocol -eq 'http' -and $Port -eq 80) -or ($Protocol -eq 'https' -and $Port -eq 443)) { '' } else { ":$Port" }
    return "${Protocol}://${hostPart}${portPart}/"
}

function Get-NetariumExistingVerificationUrl {
    param([Parameter(Mandatory = $true)][string]$SiteName)

    $bindings = @(Get-WebBinding -Name $SiteName -ErrorAction Stop)
    foreach ($binding in $bindings) {
        if ([string]$binding.protocol -notin @('http', 'https')) { continue }
        $parts = ([string]$binding.bindingInformation).Split(':')
        if ($parts.Count -ne 3) { continue }
        if (-not $parts[2]) {
            throw "Existing IIS binding has no host name; specify -VerificationUrl for the service URL: $($binding.bindingInformation)"
        }
        return Get-NetariumVerificationUrl -Protocol ([string]$binding.protocol) -Port ([int]$parts[1]) -HostName $parts[2]
    }
    throw "Existing IIS site has no HTTP or HTTPS binding: $SiteName"
}

function Resolve-NetariumVerificationUrl {
    param([string]$VerificationUrl, [string]$Protocol, [int]$Port, [string]$HostName, [string]$SiteName)

    if ($VerificationUrl) { return $VerificationUrl }
    if ($Protocol -eq 'existing') { return Get-NetariumExistingVerificationUrl -SiteName $SiteName }
    return Get-NetariumVerificationUrl -Protocol $Protocol -Port $Port -HostName $HostName
}

function Assert-NetariumBindingMatches {
    param([string]$SiteName, [string]$Protocol, [int]$Port, [string]$HostName, [string]$CertificateThumbprint)

    $bindings = @(Get-WebBinding -Name $SiteName -ErrorAction Stop)
    if ($Protocol -eq 'existing') {
        if ($bindings.Count -eq 0) { throw "Existing IIS site has no binding: $SiteName" }
        return
    }
    $matches = @($bindings | Where-Object {
        [string]$_.protocol -ieq $Protocol -and
        ([string]$_.bindingInformation -split ':', 3)[1] -eq [string]$Port -and
        ([string]$_.bindingInformation -split ':', 3)[2] -ieq $HostName
    })
    if ($matches.Count -ne 1) { throw 'Existing installation does not have the requested IIS binding.' }
    if ($Protocol -eq 'https') {
        $hash = $matches[0].certificateHash
        if ($hash -is [byte[]]) { $hash = [BitConverter]::ToString($hash).Replace('-', '') }
        if (([int]$matches[0].sslFlags -band 1) -eq 0 -or [string]$hash -ine $CertificateThumbprint) {
            throw 'Existing HTTPS binding does not match its SNI certificate.'
        }
    }
}

function Ensure-NetariumBinding {
    param(
        [Parameter(Mandatory = $true)][string]$SiteName,
        [Parameter(Mandatory = $true)][string]$Protocol,
        [Parameter(Mandatory = $true)][int]$Port,
        [string]$HostName,
        [string]$CertificateThumbprint
    )

    $bindings = @(Get-WebBinding -Name $SiteName -ErrorAction Stop)
    if ($Protocol -eq 'existing') {
        if ($bindings.Count -eq 0) { throw "Existing IIS site has no binding: $SiteName" }
        return
    }
    $desired = @($bindings | Where-Object {
        [string]$_.protocol -ieq $Protocol -and
        ([string]$_.bindingInformation -split ':', 3)[1] -eq [string]$Port -and
        ([string]$_.bindingInformation -split ':', 3)[2] -ieq $HostName
    })
    if ($desired.Count -gt 1) { throw 'Duplicate IIS bindings match the requested protocol, port and host.' }
    if ($desired.Count -eq 0) {
        $options = @{ Name = $SiteName; Protocol = $Protocol; Port = $Port; HostHeader = $HostName; ErrorAction = 'Stop' }
        if ($Protocol -eq 'https') { $options.SslFlags = 1 }
        New-WebBinding @options | Out-Null
        $desired = @(Get-WebBinding -Name $SiteName -Protocol $Protocol -Port $Port -HostHeader $HostName -ErrorAction Stop)
    }
    if ($Protocol -eq 'https') {
        if ($desired.Count -ne 1) { throw 'HTTPS binding could not be selected for certificate assignment.' }
        if (([int]$desired[0].sslFlags -band 1) -eq 0) {
            throw 'Existing HTTPS binding does not enable SNI; refusing to modify it.'
        }
        $hash = $desired[0].certificateHash
        if ($hash -is [byte[]]) { $hash = [BitConverter]::ToString($hash).Replace('-', '') }
        if ($hash -and [string]$hash -ine $CertificateThumbprint) {
            throw 'Existing HTTPS binding uses a different certificate; refusing to replace it.'
        }
        if (-not $hash) { $desired[0].AddSslCertificate($CertificateThumbprint, 'My') }
    }
}

function Ensure-NetariumSite {
    param(
        [Parameter(Mandatory = $true)][string]$SiteName,
        [Parameter(Mandatory = $true)][string]$PhysicalPath,
        [Parameter(Mandatory = $true)][string]$ApplicationPoolName,
        [Parameter(Mandatory = $true)][string]$Protocol,
        [Parameter(Mandatory = $true)][int]$Port,
        [string]$HostName,
        [string]$CertificateThumbprint
    )

    $site = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
    if ($site) {
        if ([string]$site.ApplicationPool -ine $ApplicationPoolName) {
            throw "Existing site uses another application pool: $($site.ApplicationPool)"
        }
        $expectedPath = [System.IO.Path]::GetFullPath($PhysicalPath).TrimEnd('\')
        $actualPath = [System.IO.Path]::GetFullPath(
            [Environment]::ExpandEnvironmentVariables([string]$site.PhysicalPath)
        ).TrimEnd('\')
        if ($actualPath -ine $expectedPath) {
            throw 'Existing site physical path must match InstallRoot/public.'
        }
        Ensure-NetariumBinding -SiteName $SiteName -Protocol $Protocol -Port $Port -HostName $HostName -CertificateThumbprint $CertificateThumbprint
        return $false
    }

    if ($Protocol -eq 'existing') {
        throw "Protocol existing requires an existing IIS site: $SiteName"
    }
    $options = @{ Name = $SiteName; PhysicalPath = $PhysicalPath; ApplicationPool = $ApplicationPoolName; Port = $Port; HostHeader = $HostName; Force = $true; ErrorAction = 'Stop' }
    New-Website @options | Out-Null
    Stop-Website -Name $SiteName -ErrorAction Stop
    # Match the pool-only NTFS ACL instead of inheriting the shared IUSR identity.
    Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter 'system.webServer/security/authentication/anonymousAuthentication' -Name userName -Value '' -ErrorAction Stop
    Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter 'system.webServer/security/authentication/anonymousAuthentication' -Name enabled -Value $true -ErrorAction Stop
    if ($Protocol -eq 'https') {
        Remove-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter "system.applicationHost/sites/site[@name='$SiteName']/bindings" -Name '.' -AtElement @{ protocol = 'http'; bindingInformation = "*:${Port}:$HostName" } -ErrorAction Stop
    }
    Ensure-NetariumBinding -SiteName $SiteName -Protocol $Protocol -Port $Port -HostName $HostName -CertificateThumbprint $CertificateThumbprint
    return $true
}

function Ensure-NetariumPhpFastCgi {
    param(
        [Parameter(Mandatory = $true)][string]$PhpCgiPath,
        [Parameter(Mandatory = $true)][int]$ActivityTimeout,
        [Parameter(Mandatory = $true)][int]$RequestTimeout,
        [Parameter(Mandatory = $true)][string]$SiteName
    )

    $machinePath = 'MACHINE/WEBROOT/APPHOST'
    $apps = @(
        Get-WebConfiguration -PSPath $machinePath -Filter 'system.webServer/fastCgi/application' -ErrorAction Stop |
            Where-Object { [string]$_.fullPath -ieq $PhpCgiPath }
    )
    $created = $false
    if ($apps.Count -eq 0) {
        Add-WebConfigurationProperty -PSPath $machinePath -Filter 'system.webServer/fastCgi' -Name '.' -Value @{
            fullPath = $PhpCgiPath
            activityTimeout = $ActivityTimeout
            requestTimeout = $RequestTimeout
        } -ErrorAction Stop
        $created = $true
    } else {
        $usedByOtherSite = $false
        foreach ($site in @(Get-Website)) {
            if ([string]$site.Name -ieq $SiteName) {
                continue
            }
            $sitePath = Get-NetariumSitePath -SiteName $site.Name
            $handlers = @(Get-NetariumWebCollection -PSPath $sitePath -Filter 'system.webServer/handlers/add')
            if (@($handlers | Where-Object { [string]$_.scriptProcessor -ieq $PhpCgiPath }).Count -gt 0) {
                $usedByOtherSite = $true
                break
            }
        }

        foreach ($app in $apps) {
            $currentActivity = [int]$app.activityTimeout
            $currentRequest = [int]$app.requestTimeout
            if ($usedByOtherSite -and ($currentActivity -ne $ActivityTimeout -or $currentRequest -ne $RequestTimeout)) {
                throw 'The PHP FastCGI mapping is shared with another site and has conflicting timeout values.'
            }
            if (-not $usedByOtherSite) {
                $filter = "system.webServer/fastCgi/application[@fullPath='$PhpCgiPath']"
                Set-WebConfigurationProperty -PSPath $machinePath -Filter $filter -Name activityTimeout -Value $ActivityTimeout -ErrorAction Stop
                Set-WebConfigurationProperty -PSPath $machinePath -Filter $filter -Name requestTimeout -Value $RequestTimeout -ErrorAction Stop
            }
        }
    }
    $registeredApps = @(
        Get-WebConfiguration -PSPath $machinePath -Filter 'system.webServer/fastCgi/application' -ErrorAction Stop |
            Where-Object { [string]$_.fullPath -ieq $PhpCgiPath }
    )
    if ($registeredApps.Count -ne 1 -or
        [int]$registeredApps[0].activityTimeout -ne $ActivityTimeout -or
        [int]$registeredApps[0].requestTimeout -ne $RequestTimeout) {
        throw "PHP FastCGI registration failed or has unexpected timeouts: $PhpCgiPath"
    }
    return $created
}

function Ensure-NetariumPhpHandler {
    param(
        [Parameter(Mandatory = $true)][string]$SiteName,
        [Parameter(Mandatory = $true)][string]$PhpCgiPath
    )

    $machinePath = 'MACHINE/WEBROOT/APPHOST'
    $handlers = @(Get-NetariumWebCollection -PSPath $machinePath -Location $SiteName -Filter 'system.webServer/handlers/add')
    $phpHandlers = @($handlers | Where-Object { [string]$_.path -eq '*.php' })
    if ($phpHandlers.Count -gt 0) {
        foreach ($handler in $phpHandlers) {
            if ([string]$handler.scriptProcessor -ine $PhpCgiPath) {
                throw 'Existing site-level PHP handler uses a different PHP CGI executable.'
            }
        }
        return $false
    }

    Add-WebConfigurationProperty -PSPath $machinePath -Location $SiteName -Filter 'system.webServer/handlers' -Name '.' -Value @{
        name = 'Netarium-PHP'
        path = '*.php'
        verb = '*'
        modules = 'FastCgiModule'
        scriptProcessor = $PhpCgiPath
        resourceType = 'Either'
        requireAccess = 'Script'
    } -ErrorAction Stop
    $registeredHandlers = @(
        Get-NetariumWebCollection -PSPath $machinePath -Location $SiteName -Filter 'system.webServer/handlers/add' |
            Where-Object { [string]$_.path -eq '*.php' }
    )
    if ($registeredHandlers.Count -ne 1 -or [string]$registeredHandlers[0].scriptProcessor -ine $PhpCgiPath) {
        throw "PHP handler registration does not match FastCGI application: $PhpCgiPath"
    }
    return $true
}

function Ensure-NetariumRequestLimit {
    param([Parameter(Mandatory = $true)][string]$SiteName)

    Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter 'system.webServer/security/requestFiltering/requestLimits' -Name maxAllowedContentLength -Value 33554432 -ErrorAction Stop
}

function Assert-NetariumIisConfigurationPreflight {
    param(
        [Parameter(Mandatory = $true)][string]$SiteName,
        [Parameter(Mandatory = $true)][bool]$SiteExists,
        [Parameter(Mandatory = $true)][bool]$SiteLocationExists
    )

    $machinePath = 'MACHINE/WEBROOT/APPHOST'
    $filters = @(
        'system.webServer/handlers',
        'system.webServer/security/requestFiltering/requestLimits',
        'system.webServer/security/requestFiltering/fileExtensions',
        'system.webServer/defaultDocument/files'
    )
    foreach ($filter in $filters) {
        try {
            Get-WebConfiguration -PSPath $machinePath -Filter $filter -ErrorAction Stop | Out-Null
            if ($SiteExists) {
                Get-WebConfiguration -PSPath $machinePath -Location $SiteName -Filter $filter -ErrorAction Stop | Out-Null
            }
        } catch {
            $scope = if ($SiteExists) { "site '$SiteName'" } else { 'server configuration' }
            throw "IIS configuration preflight failed for $scope ($filter): $($_.Exception.Message). No installation files, site, or application pool have been changed."
        }
    }
    if (-not $SiteExists -and $SiteLocationExists) {
        throw "IIS configuration preflight failed: site '$SiteName' is absent but its location configuration already exists. The location must be reviewed before setup; no installation files, site, or application pool have been changed."
    }
}
function Assert-NetariumExistingConfiguration {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$SiteName,
        [Parameter(Mandatory = $true)][string]$ApplicationPoolName,
        [Parameter(Mandatory = $true)][string]$PhpCgiPath,
        [Parameter(Mandatory = $true)][string]$StorageDir,
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [Parameter(Mandatory = $true)][int]$ActivityTimeout,
        [Parameter(Mandatory = $true)][int]$RequestTimeout
    )

    $state = Get-IisState -SiteName $SiteName -ApplicationPoolName $ApplicationPoolName -PhpCgiPath $PhpCgiPath
    if (-not $state.SiteExists -or -not $state.AppPoolExists) {
        throw 'Existing installation is incomplete.'
    }
    $expectedPublic = (Join-Path (ConvertTo-NetariumAbsolutePath -Path $InstallRoot) 'public')
    $actualPublic = [Environment]::ExpandEnvironmentVariables([string]$state.Site.PhysicalPath)
    if ([System.IO.Path]::GetFullPath($actualPublic).TrimEnd('\') -ine [System.IO.Path]::GetFullPath($expectedPublic).TrimEnd('\')) {
        throw 'Existing site physical path does not match InstallRoot/public.'
    }
    if ([string]$state.Site.ApplicationPool -ine $ApplicationPoolName) {
        throw 'Existing site application-pool assignment conflicts with the requested pool.'
    }
    Assert-NetariumAppPoolIdentityIsolation -ApplicationPoolName $ApplicationPoolName
    if (@($state.Handler | Where-Object { [string]$_.Path -eq '*.php' -and [string]$_.ScriptProcessor -ine $PhpCgiPath }).Count -gt 0) {
        throw 'Existing PHP handler conflicts with the requested PHP CGI executable.'
    }
    $environment = Get-NetariumEnvironmentMap -IisState $state
    if ($environment.ContainsKey('NETARIUM_STORAGE_DIR') -or $environment.ContainsKey('NETARIUM_DB_FILE')) {
        throw 'Existing IIS storage overrides are not supported by setup-iis.ps1.'
    }
    $configPath = Join-Path $InstallRoot 'config/app.php'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw 'Existing installation is missing config/app.php.'
    }
    $configText = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    $escapedStorage = (ConvertTo-NetariumAbsolutePath -Path $StorageDir).Replace('\', '\\')
    if ($configText -notmatch [regex]::Escape($escapedStorage)) {
        throw 'Existing config/app.php does not point to InstallRoot/data.'
    }

    Invoke-NetariumInstallCheck -AppRoot $InstallRoot -StorageDir $StorageDir -PhpCgiPath $PhpCgiPath | Out-Null
    $siteWasStarted = [string]$state.Site.State -in @('Started', 'Starting')
    $poolWasStarted = [string]$state.AppPool.State -in @('Started', 'Starting')
    try {
        Stop-NetariumSiteIfRunning -SiteName $SiteName
        if ([string](Get-WebSiteState -Name $SiteName).Value -ne 'Stopped') {
            throw 'Existing site did not stop before ACL protection.'
        }
        if ($poolWasStarted) {
            Wait-NetariumRequestDrain -ApplicationPoolName $ApplicationPoolName
        }
        Stop-NetariumAppPoolIfRunning -ApplicationPoolName $ApplicationPoolName
        if ([string](Get-WebAppPoolState -Name $ApplicationPoolName).Value -ne 'Stopped') {
            throw 'Existing application pool did not stop before ACL protection.'
        }

        Set-NetariumAcl -InstallRoot $InstallRoot -StorageDir $StorageDir -ApplicationPoolName $ApplicationPoolName
        Ensure-NetariumPhpFastCgi -PhpCgiPath $PhpCgiPath -ActivityTimeout $ActivityTimeout -RequestTimeout $RequestTimeout -SiteName $SiteName | Out-Null
        Ensure-NetariumPhpHandler -SiteName $SiteName -PhpCgiPath $PhpCgiPath | Out-Null
        Ensure-NetariumRequestLimit -SiteName $SiteName
        Ensure-NetariumDefaultDocument -SiteName $SiteName

        if ($poolWasStarted) { Start-WebAppPool -Name $ApplicationPoolName -ErrorAction Stop }
        if ($siteWasStarted) { Start-Website -Name $SiteName -ErrorAction Stop }
    } catch {
        $failure = $_
        $stopFailures = @()
        # Attempt both shutdowns even if one fails, including a partially completed restart.
        try {
            Stop-NetariumSiteIfRunning -SiteName $SiteName
            if ([string](Get-WebSiteState -Name $SiteName).Value -ne 'Stopped') {
                throw 'Site remains running.'
            }
        } catch {
            $stopFailures += "Site: $($_.Exception.Message)"
        }
        try {
            Stop-NetariumAppPoolIfRunning -ApplicationPoolName $ApplicationPoolName
            if ([string](Get-WebAppPoolState -Name $ApplicationPoolName).Value -ne 'Stopped') {
                throw 'Application pool remains running.'
            }
        } catch {
            $stopFailures += "Application pool: $($_.Exception.Message)"
        }
        if ($stopFailures.Count -gt 0) {
            throw "Existing setup failed: $($failure.Exception.Message). Could not stop all target services: $($stopFailures -join '; '). Do not resume service before checking confidential ACLs."
        }
        throw "Existing setup failed: $($failure.Exception.Message). Site and application pool remain stopped; check confidential ACLs before retrying."
    }
}

function Join-NetariumUrl {
    param([Parameter(Mandatory = $true)][string]$BaseUrl, [Parameter(Mandatory = $true)][string]$Path)
    return $BaseUrl.TrimEnd('/') + '/' + $Path.TrimStart('/')
}

function Assert-NetariumFreshProbe {
    param([Parameter(Mandatory = $true)][string]$BaseUrl)

    $root = Invoke-NetariumProbe -Url (Join-NetariumUrl -BaseUrl $BaseUrl -Path '/')
    if ($root.StatusCode -ne 302 -or $root.Location -notmatch '(?i)(^|/)login\.php(?:\?|$)') {
        throw "Site root did not redirect to login.php: status=$($root.StatusCode), location=$($root.Location)"
    }

    $login = Invoke-NetariumProbe -Url (Join-NetariumUrl -BaseUrl $BaseUrl -Path 'login.php') -IncludeBody
    if ($login.StatusCode -ne 302 -or $login.Location -notmatch 'setup\.php') {
        throw "Fresh installation did not redirect login.php to setup.php: status=$($login.StatusCode), location=$($login.Location)"
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
        $probe = Invoke-NetariumProbe -Url (Join-NetariumUrl -BaseUrl $BaseUrl -Path $path)
        if ($probe.StatusCode -notin @(403, 404)) {
            throw "Private path is reachable after setup: $path status=$($probe.StatusCode)"
        }
    }
}



$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourcePath) {
    $SourcePath = $projectRoot
}
if (-not $PSBoundParameters.ContainsKey('InstallRoot') -or [string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Read-NetariumDeploymentParameter -Name InstallRoot -Description 'Installation directory' -Default $script:NetariumIisDefaults.InstallRoot -NonInteractive:$NonInteractive
}
if (-not $PSBoundParameters.ContainsKey('SiteName') -or [string]::IsNullOrWhiteSpace($SiteName)) {
    $SiteName = Read-NetariumDeploymentParameter -Name SiteName -Description 'IIS site name' -Default $script:NetariumIisDefaults.SiteName -NonInteractive:$NonInteractive
}
if (-not $PSBoundParameters.ContainsKey('ApplicationPoolName') -or [string]::IsNullOrWhiteSpace($ApplicationPoolName)) {
    $ApplicationPoolName = Read-NetariumDeploymentParameter -Name ApplicationPoolName -Description 'IIS application pool' -Default $SiteName -NonInteractive:$NonInteractive
}
if (-not $PSBoundParameters.ContainsKey('PhpCgiPath') -or [string]::IsNullOrWhiteSpace($PhpCgiPath)) {
    $PhpCgiPath = Read-NetariumDeploymentParameter -Name PhpCgiPath -Description 'Full path to php-cgi.exe' -Default 'C:\php\php-cgi.exe' -NonInteractive:$NonInteractive
}
if (-not $Protocol) {
    $choice = Read-NetariumDeploymentParameter -Name Protocol -Description 'IIS binding mode (http, https, existing)' -NonInteractive:$NonInteractive
    if ($choice -notin @('http', 'https', 'existing')) { throw 'Protocol must be http, https or existing.' }
    $Protocol = $choice
}
if ($Protocol -ne 'existing') {
    if (-not $PSBoundParameters.ContainsKey('Port')) {
        $Port = if ($Protocol -eq 'https') { 443 } else { 80 }
    }
    if (-not $HostName) {
        $HostName = Read-NetariumDeploymentParameter -Name HostName -Description 'Service FQDN for the IIS binding' -NonInteractive:$NonInteractive
    }
    if ($HostName -and ($HostName -notmatch '\A[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\z' -or $HostName.Contains('..'))) {
        throw 'HostName must be a DNS host name without scheme, port or path.'
    }
    if ($Protocol -eq 'https') {
        if (-not $HostName) { throw 'HTTPS requires a service FQDN in HostName.' }
        if (-not $CertificateThumbprint) {
            $CertificateThumbprint = Read-NetariumDeploymentParameter -Name CertificateThumbprint -Description 'LocalMachine/My certificate thumbprint for the service FQDN' -NonInteractive:$NonInteractive
        }
    } elseif ($CertificateThumbprint) {
        throw 'CertificateThumbprint is only valid with HTTPS.'
    }
} elseif ($CertificateThumbprint -or $PSBoundParameters.ContainsKey('Port') -or $HostName) {
    throw 'Existing binding mode does not accept Port, HostName or CertificateThumbprint.'
}
if ($VerificationUrl) {
    $parsedVerification = $null
    if (-not [uri]::TryCreate($VerificationUrl, [UriKind]::Absolute, [ref]$parsedVerification) -or
        $parsedVerification.Scheme -notin @('http', 'https') -or
        $parsedVerification.AbsolutePath -ne '/' -or $parsedVerification.Query -or $parsedVerification.Fragment -or $parsedVerification.UserInfo) {
        throw 'VerificationUrl must be an absolute HTTP(S) URL at the site root.'
    }
}
if (-not $PSBoundParameters.ContainsKey('MinimumPhpMemoryLimitMiB')) {
    $MinimumPhpMemoryLimitMiB = Read-NetariumDeploymentParameter -Name MinimumPhpMemoryLimitMiB -Description 'Minimum PHP memory in MiB' -Default '512' -NonInteractive:$NonInteractive
}
if (-not $PSBoundParameters.ContainsKey('MinimumPhpMaxExecutionTimeSeconds')) {
    $MinimumPhpMaxExecutionTimeSeconds = Read-NetariumDeploymentParameter -Name MinimumPhpMaxExecutionTimeSeconds -Description 'Minimum PHP execution time in seconds' -Default '300' -NonInteractive:$NonInteractive
}
if (-not $PSBoundParameters.ContainsKey('FastCgiActivityTimeoutSeconds')) {
    $FastCgiActivityTimeoutSeconds = Read-NetariumDeploymentParameter -Name FastCgiActivityTimeoutSeconds -Description 'FastCGI activity timeout in seconds' -Default '300' -NonInteractive:$NonInteractive
}
if (-not $PSBoundParameters.ContainsKey('FastCgiRequestTimeoutSeconds')) {
    $FastCgiRequestTimeoutSeconds = Read-NetariumDeploymentParameter -Name FastCgiRequestTimeoutSeconds -Description 'FastCGI request timeout in seconds' -Default '300' -NonInteractive:$NonInteractive
}
Write-Host "Release root: $SourcePath"
Write-Host "Target: $InstallRoot; site: $SiteName; pool: $ApplicationPoolName; PHP CGI: $PhpCgiPath; binding: $Protocol/$HostName/$Port"

if (-not $RollbackRoot) {
    $RollbackRoot = (ConvertTo-NetariumAbsolutePath -Path $InstallRoot) + '-rollback'
}

$installRootPath = ConvertTo-NetariumAbsolutePath -Path $InstallRoot
$storagePath = Join-Path $installRootPath 'data'
$publicPath = Join-Path $installRootPath 'public'
$stagingPath = $installRootPath + '.staging-' + [Guid]::NewGuid().ToString('N')
$release = $null
$snapshotPath = $null

try {
    Assert-Administrator
    Assert-WebAdministration
    Assert-SafeDeploymentPaths -SourcePath $SourcePath -InstallRoot $installRootPath -RollbackRoot $RollbackRoot | Out-Null
    $release = Assert-ReleaseLayout -SourcePath $SourcePath
    $phpInfo = Assert-NetariumPhpRuntime -CgiPath $PhpCgiPath -MinimumMemoryMiB $MinimumPhpMemoryLimitMiB -MinimumExecutionSeconds $MinimumPhpMaxExecutionTimeSeconds
    $iisBefore = Get-IisState -SiteName $SiteName -ApplicationPoolName $ApplicationPoolName -PhpCgiPath $PhpCgiPath
    Assert-NetariumIisConfigurationPreflight -SiteName $SiteName -SiteExists ([bool]$iisBefore.SiteExists) -SiteLocationExists ([bool]$iisBefore.SiteLocationExists)
    if ($Protocol -eq 'existing' -and -not $iisBefore.SiteExists) {
        throw "Existing binding mode requires an existing IIS site: $SiteName"
    }
    if ($Protocol -eq 'https') {
        $CertificateThumbprint = Assert-NetariumCertificate -Thumbprint $CertificateThumbprint -HostName $HostName
    }
    $VerificationUrl = Resolve-NetariumVerificationUrl -VerificationUrl $VerificationUrl -Protocol $Protocol -Port $Port -HostName $HostName -SiteName $SiteName
    Write-Host "Verification URL: $VerificationUrl"

    $existingEnvironment = Get-NetariumEnvironmentMap -IisState $iisBefore
    $existingTarget = Test-Path -LiteralPath $installRootPath -PathType Container
    $existingConfig = Test-Path -LiteralPath (Join-Path $installRootPath 'config/app.php') -PathType Leaf
    $targetSiteRoot = if ($iisBefore.SiteExists) { [Environment]::ExpandEnvironmentVariables([string]$iisBefore.Site.PhysicalPath) } else { '' }
    $expectedPublic = [System.IO.Path]::GetFullPath($publicPath).TrimEnd('\')

    if ($iisBefore.SiteExists -and [System.IO.Path]::GetFullPath($targetSiteRoot).TrimEnd('\') -ine $expectedPublic) {
        throw 'Existing site physical path must match InstallRoot/public.'
    }
    if ($existingEnvironment.ContainsKey('NETARIUM_STORAGE_DIR') -or $existingEnvironment.ContainsKey('NETARIUM_DB_FILE')) {
        throw 'Existing IIS storage overrides are not supported by setup-iis.ps1.'
    }

    if (
        $existingTarget -and
        $existingConfig -and
        $iisBefore.SiteExists -and
        [System.IO.Path]::GetFullPath($targetSiteRoot).TrimEnd('\') -ieq $expectedPublic
    ) {
        Assert-NetariumBindingMatches -SiteName $SiteName -Protocol $Protocol -Port $Port -HostName $HostName -CertificateThumbprint $CertificateThumbprint
        Assert-NetariumExistingConfiguration -InstallRoot $installRootPath -SiteName $SiteName -ApplicationPoolName $ApplicationPoolName -PhpCgiPath $PhpCgiPath -StorageDir $storagePath -BaseUrl $VerificationUrl -ActivityTimeout $FastCgiActivityTimeoutSeconds -RequestTimeout $FastCgiRequestTimeoutSeconds
        Write-Host 'Netarium setup is complete; existing data and config were preserved.' -ForegroundColor Green
        exit 0
    }
    Assert-NetariumFreshDestination -DestinationRoot $installRootPath



    $snapshotPath = New-NetariumSnapshot -RollbackRoot $RollbackRoot -InstallRoot $installRootPath -StorageDir $storagePath -SiteName $SiteName -ApplicationPoolName $ApplicationPoolName -Stage 'fresh-setup' -PhpCgiPath $PhpCgiPath -DatabaseSchemaVersion 0 -IisState $iisBefore
    New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
    Copy-NetariumReleaseManifest -SourceRoot $release.Root -DestinationRoot $stagingPath
    $stagingStorage = Join-Path $stagingPath 'data'
    New-NetariumRuntimeTree -StorageDir $stagingStorage
    New-NetariumAppConfig -InstallRoot $stagingPath -StorageDir $stagingStorage
    Invoke-NetariumInstallCheck -AppRoot $stagingPath -StorageDir $stagingStorage -PhpCgiPath $PhpCgiPath | Out-Null
    if ($iisBefore.SiteExists -and $iisBefore.Site.State -eq 'Started') {
        Stop-Website -Name $SiteName -ErrorAction Stop
    }

    Copy-NetariumReleaseManifest -SourceRoot $stagingPath -DestinationRoot $installRootPath
    if (-not (Test-Path -LiteralPath (Join-Path $publicPath 'web.config') -PathType Leaf)) {
        throw "Release web.config is missing from public root: $publicPath"
    }
    New-NetariumRuntimeTree -StorageDir $storagePath
    Merge-NetariumTree -SourceRoot $stagingStorage -DestinationRoot $storagePath
    New-NetariumAppConfig -InstallRoot $installRootPath -StorageDir $storagePath
    Invoke-NetariumInstallCheck -AppRoot $installRootPath -StorageDir $storagePath -PhpCgiPath $PhpCgiPath | Out-Null
    Ensure-NetariumAppPool -ApplicationPoolName $ApplicationPoolName -SiteName $SiteName | Out-Null
    if ((Get-WebAppPoolState -Name $ApplicationPoolName).Value -eq 'Started') {
        Stop-WebAppPool -Name $ApplicationPoolName -ErrorAction Stop
    }
    Ensure-NetariumSite -SiteName $SiteName -PhysicalPath $publicPath -ApplicationPoolName $ApplicationPoolName -Protocol $Protocol -Port $Port -HostName $HostName -CertificateThumbprint $CertificateThumbprint | Out-Null
    Ensure-NetariumPhpFastCgi -PhpCgiPath $PhpCgiPath -ActivityTimeout $FastCgiActivityTimeoutSeconds -RequestTimeout $FastCgiRequestTimeoutSeconds -SiteName $SiteName | Out-Null
    Ensure-NetariumPhpHandler -SiteName $SiteName -PhpCgiPath $PhpCgiPath | Out-Null
    Ensure-NetariumRequestLimit -SiteName $SiteName
    Ensure-NetariumDefaultDocument -SiteName $SiteName

    Set-NetariumAcl -InstallRoot $installRootPath -StorageDir $storagePath -ApplicationPoolName $ApplicationPoolName
    Invoke-NetariumBootstrapSecret -AppRoot $installRootPath -StorageDir $storagePath -PhpCgiPath $PhpCgiPath | Out-Null

    Start-WebAppPool -Name $ApplicationPoolName -ErrorAction Stop
    Start-Website -Name $SiteName -ErrorAction Stop
    Start-Sleep -Seconds 1
    Assert-NetariumFreshProbe -BaseUrl $VerificationUrl
    Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction Stop
    Write-Host "Fresh Netarium setup completed. Rollback snapshot: $snapshotPath" -ForegroundColor Green
    exit 0
} catch {
    $failure = $_
    $rollbackFailure = $null
    if ($snapshotPath) {
        try {
            Stop-NetariumSiteIfRunning -SiteName $SiteName
            Restore-NetariumSnapshot -SnapshotPath $snapshotPath -InstallRoot $installRootPath -StorageDir $storagePath | Out-Null
        } catch {
            $rollbackFailure = $_
        }
    }

    if (Test-Path -LiteralPath $stagingPath) {
        Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
    }

    if ($rollbackFailure) {
        Write-Error "Setup failed: $($failure.Exception.Message). Rollback also failed at snapshot ${snapshotPath}: $($rollbackFailure.Exception.Message)"
    } elseif ($snapshotPath) {
        Write-Error "Setup failed at snapshot ${snapshotPath}: $($failure.Exception.Message)"
    } else {
        Write-Error "Setup preflight failed: $($failure.Exception.Message)"
    }
    exit 1
}
