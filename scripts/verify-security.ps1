[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [Alias('BaseUrl')]
    [uri]$VerificationUrl
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'deployment-common.ps1')

function Join-NetariumSecurityUrl {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $VerificationUrl.AbsoluteUri.TrimEnd('/') + '/' + $Path.TrimStart('/')
}

$sentinels = @(
    '<?php',
    'NETARIUM_DB_FILE',
    'NETARIUM_STORAGE_DIR',
    'SQLite format 3',
    'storage_dir',
    'CREATE TABLE',
    'PDOException'
)

$checks = @(
    [pscustomobject]@{
        Path = '/'
        AllowedStatus = @(302)
        Kind = 'loginRedirect'
    },
    [pscustomobject]@{
        Path = 'login.php'
        AllowedStatus = @(200)
        Kind = 'login'
    },
    [pscustomobject]@{
        Path = 'api.php?action=load'
        AllowedStatus = @(401)
        Kind = 'api'
    },
    [pscustomobject]@{
        Path = 'image_upload.php?action=upload_device_image'
        AllowedStatus = @(401)
        Kind = 'api'
    },
    [pscustomobject]@{
        Path = 'setup.php'
        AllowedStatus = @(302, 404)
        Kind = 'setup'
    },
    [pscustomobject]@{ Path = 'data/db/data.sqlite'; AllowedStatus = @(403, 404); Kind = 'private' },
    [pscustomobject]@{ Path = 'db/data.sqlite'; AllowedStatus = @(403, 404); Kind = 'private' },
    [pscustomobject]@{ Path = 'src/Autoloader.php'; AllowedStatus = @(403, 404); Kind = 'private' },
    [pscustomobject]@{ Path = 'templates/components/toolbar.php'; AllowedStatus = @(403, 404); Kind = 'private' },
    [pscustomobject]@{ Path = 'config/app.php'; AllowedStatus = @(403, 404); Kind = 'private' },
    [pscustomobject]@{ Path = 'scripts/recover-admin.php'; AllowedStatus = @(403, 404); Kind = 'private' },
    [pscustomobject]@{ Path = 'resources/password-blocklist/pwdb-policy-top-3000.txt'; AllowedStatus = @(403, 404); Kind = 'private' },
    [pscustomobject]@{ Path = 'resources/password-blocklist/pwdb-metadata.json'; AllowedStatus = @(403, 404); Kind = 'private' },
    [pscustomobject]@{ Path = 'data/password-blocklist.json'; AllowedStatus = @(403, 404); Kind = 'private' },
    [pscustomobject]@{ Path = 'password-blocklist.json'; AllowedStatus = @(403, 404); Kind = 'private' },
    [pscustomobject]@{ Path = 'data/logs/audit/.lock'; AllowedStatus = @(403, 404); Kind = 'private' }
)

$failures = @()
foreach ($check in $checks) {
    $url = Join-NetariumSecurityUrl -Path $check.Path
    $result = $null
    $failure = $null
    try {
        $result = Invoke-NetariumProbe -Url $url -IncludeBody
        if ($check.AllowedStatus -notcontains $result.StatusCode) {
            $failure = "unexpected status $($result.StatusCode); expected $($check.AllowedStatus -join ',')"
        }

        if (-not $failure -and $check.Kind -in @('setup', 'loginRedirect') -and $result.StatusCode -eq 302) {
            if ($result.Location -notmatch '(?i)(^|/)login\.php(?:\?|$)') {
                $failure = "unexpected Location header: $($result.Location)"
            }
        }

        if (-not $failure -and $check.Kind -eq 'private') {
            foreach ($sentinel in $sentinels) {
                if ($result.Body.IndexOf($sentinel, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    $failure = "response contains private sentinel: $sentinel"
                    break
                }
            }
        }
    } catch {
        $failure = $_.Exception.Message
    }

    $output = [ordered]@{
        url = $url
        status = if ($result) { $result.StatusCode } else { 0 }
        ok = [string]::IsNullOrEmpty($failure)
    }
    if ($failure) {
        $output.error = $failure
        $failures += [pscustomobject]@{ Path = $check.Path; Error = $failure }
    }
    $output | ConvertTo-Json -Compress
}

if ($failures.Count -gt 0) {
    Write-Error ("Security verification failed: " + (($failures | ForEach-Object { "$($_.Path): $($_.Error)" }) -join '; '))
    exit 1
}

exit 0
