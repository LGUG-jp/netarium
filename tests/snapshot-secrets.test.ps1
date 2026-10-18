[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/deployment-common.ps1')

# No real IIS credential or certificate is used.
foreach ($password in @('', 'synthetic-198-only', ('synthetic-' + [char]0x79d8 + [char]0x5bc6 + [char]0xd840 + [char]0xdc00))) {
    $cipher = Protect-NetariumPoolPassword -Password $password
    if ((Unprotect-NetariumPoolPassword -Ciphertext $cipher) -cne $password) {
        throw 'DPAPI did not preserve the credential exactly.'
    }
    if ($password -and [Text.Encoding]::UTF8.GetString($cipher).Contains($password)) {
        throw 'DPAPI output contains the plaintext credential.'
    }
}
Write-Host '[PASS] empty/ASCII/Unicode credentials survive real machine-DPAPI round trip'
$cipher[0] = $cipher[0] -bxor 255
$rejected = $false
try {
    Unprotect-NetariumPoolPassword -Ciphertext $cipher | Out-Null
} catch [System.Security.Cryptography.CryptographicException] {
    $rejected = $true
    if ($_.Exception.Message.Contains($password)) { throw 'Credential leaked through a decryption error.' }
}
if (-not $rejected) { throw 'Corrupted DPAPI credential was accepted.' }
Write-Host '[PASS] corrupted credential is rejected without exposing its value'

$root = Join-Path ([IO.Path]::GetTempPath()) ('netarium-snapshot-secrets-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$install = Join-Path $root 'app'
$storage = Join-Path $install 'data'
$rollback = Join-Path $root 'rollback'
$state = [pscustomobject]@{
    SiteExists = $false; AppPoolExists = $false
    AppPool = [pscustomobject]@{ Password = 'synthetic-198-only' }
}
try {
    $acl = [IO.Directory]::GetAccessControl($root)
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    [IO.Directory]::SetAccessControl($root, $acl)
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        try {
            New-NetariumSnapshot -RollbackRoot $rollback -InstallRoot $install -StorageDir $storage -SiteName 'Synthetic198' -ApplicationPoolName 'Synthetic198' -Stage 'update' -IisState $state | Out-Null
            throw 'Non-administrator created an administrator-owned snapshot.'
        } catch {
            $inner = $_.Exception.InnerException
            if ($_.Exception -isnot [UnauthorizedAccessException] -and $inner -isnot [UnauthorizedAccessException] -and
                -not ($inner -is [IO.IOException] -and $inner.HResult -eq -2147023589)) { throw }
        }
        if (@(Get-ChildItem -LiteralPath $root -Filter manifest.json -Recurse).Count -ne 0 -or
            @(Get-ChildItem -LiteralPath $root -Filter iis-secrets.bin -Recurse).Count -ne 0) {
            throw 'Credential was written before private snapshot creation succeeded.'
        }
        Write-Host '[PASS] insufficient ownership rights fail before confidential snapshot writes'
        Write-Host '[SKIP] successful snapshot ACL/restore scenarios require an elevated administrator'
        return
    }
    foreach ($directory in @('config', 'data/db', 'data/sessions')) {
        New-Item -ItemType Directory -Path (Join-Path $install $directory) -Force | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $install 'config/app.php'), 'synthetic-config')
    [IO.File]::WriteAllText((Join-Path $storage 'db/data.sqlite'), 'synthetic-db')
    [IO.File]::WriteAllText((Join-Path $storage 'sessions/sess_fixture'), 'synthetic-session')
    $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($srcFile in @((Join-Path $install 'config/app.php'), (Join-Path $storage 'db/data.sqlite'))) {
        $srcAcl = [IO.File]::GetAccessControl($srcFile)
        $srcAcl.SetOwner($currentUserSid)
        [IO.File]::SetAccessControl($srcFile, $srcAcl)
    }
    $snapshot = New-NetariumSnapshot -RollbackRoot $rollback -InstallRoot $install -StorageDir $storage -SiteName 'Synthetic198' -ApplicationPoolName 'Synthetic198' -Stage 'update' -IisState $state
    $manifestPath = Join-Path $snapshot 'manifest.json'
    $manifestText = [IO.File]::ReadAllText($manifestPath)
    $manifest = $manifestText | ConvertFrom-Json
    if ($manifest.Version -ne 2 -or $null -ne $manifest.Iis.AppPool.Password -or
        $manifestText.Contains($state.AppPool.Password) -or $manifest.PoolPasswordProtection -ne 'DPAPI-LocalMachine') {
        throw 'Snapshot manifest exposed the pool credential.'
    }
    if ($state.AppPool.Password -cne 'synthetic-198-only') { throw 'Snapshot changed the captured caller state.' }
    $secretPath = Join-Path $snapshot 'iis-secrets.bin'
    if ((Unprotect-NetariumPoolPassword -Ciphertext ([IO.File]::ReadAllBytes($secretPath))) -cne $state.AppPool.Password) { throw 'Saved credential cannot be recovered.' }
    foreach ($item in @((Get-Item $rollback)) + @(Get-ChildItem $rollback -Recurse -Force)) {
        $acl = if ($item.PSIsContainer) { [IO.Directory]::GetAccessControl($item.FullName) } else { [IO.File]::GetAccessControl($item.FullName) }
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne 2 -or @($rules | Where-Object {
            $_.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544') -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl'
        }).Count) { throw 'Snapshot is accessible to an unapproved principal.' }
        $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
        if ($null -eq $owner -or $owner.Value -ne 'S-1-5-32-544') {
            throw "Snapshot item owner is not Administrators: $($item.FullName) ($($owner.Value))"
        }
    }
    if (Test-Path (Join-Path $snapshot 'data/sessions')) { throw 'Snapshot preserved login sessions.' }
    Write-Host '[PASS] readable parent does not expose snapshot DB/config/credential; sessions excluded'
    $cipher = [IO.File]::ReadAllBytes($secretPath)
    $cipher[0] = $cipher[0] -bxor 255
    [IO.File]::WriteAllBytes($secretPath, $cipher)
    [IO.File]::WriteAllText((Join-Path $storage 'db/data.sqlite'), 'current-db')
    $rejected = $false
    try {
        Restore-NetariumSnapshot -SnapshotPath $snapshot -InstallRoot $install -StorageDir $storage | Out-Null
    } catch [System.Security.Cryptography.CryptographicException] {
        $rejected = $true
        if ($_.Exception.Message.Contains($state.AppPool.Password)) { throw 'Restore error leaked the pool credential.' }
    }
    if (-not $rejected) { throw 'Restore accepted a corrupt protected credential.' }
    if ([IO.File]::ReadAllText((Join-Path $storage 'db/data.sqlite')) -cne 'current-db' -or
        [IO.File]::ReadAllText((Join-Path $storage 'sessions/sess_fixture')) -cne 'synthetic-session') { throw 'Failed preflight changed live data or sessions.' }
    Write-Host '[PASS] credential corruption rejects restore before current DB/session mutation'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
