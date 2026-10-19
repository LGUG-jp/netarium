[CmdletBinding(DefaultParameterSetName = 'Register')]
param(
    [Parameter(Mandatory = $true)][string]$StorageDir,
    [Parameter(Mandatory = $true)][string]$ApplicationPoolName,
    [Parameter(Mandatory = $true, ParameterSetName = 'Register')][string]$DictionaryFile,
    [Parameter(Mandatory = $true, ParameterSetName = 'Disable')][switch]$Disable,
    [string]$PhpPath = 'php'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path $PSScriptRoot 'deployment-common.ps1')

function Assert-LocalDictionaryPath {
    param([string]$Path)
    if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':')) {
        throw 'Specify an absolute path on a local drive. UNC paths and alternate data streams are not allowed.'
    }
    $full = ConvertTo-NetariumAbsolutePath -Path $Path
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not allowed.' }
        }
        $cursor = Split-Path -Parent $cursor
    }
    return $full
}

function Assert-DictionaryParentAcl {
    param([string]$Path, [string]$PoolSid, [switch]$Storage)
    $danger = [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    if ($Storage) { $danger = $danger -bor [Security.AccessControl.FileSystemRights]::Write }
    $acl = Get-Acl -LiteralPath $Path
    $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $poolDenied = 0
    foreach ($rule in $rules) {
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($rule.IdentityReference.Value -eq $PoolSid -and $rule.AccessControlType -eq 'Deny') { $poolDenied = $poolDenied -bor [int]$rule.FileSystemRights }
    }
    foreach ($rule in $rules) {
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0 -or $rule.AccessControlType -ne 'Allow') { continue }
        $sid = $rule.IdentityReference.Value
        if ($sid -in $trusted) { continue }
        $rights = [int]$rule.FileSystemRights -band [int]$danger
        if ($Storage -and $sid -eq $PoolSid) {
            $rights = $rights -band ([int][Security.AccessControl.FileSystemRights]::Delete -bor [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [int][Security.AccessControl.FileSystemRights]::ChangePermissions -bor [int][Security.AccessControl.FileSystemRights]::TakeOwnership)
            $rights = $rights -band (-bnot $poolDenied)
        }
        if ($rights -ne 0) { throw "Parent path has non-administrator modification rights: $Path" }
    }
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $trusted) { throw "Parent path owner is not an administrative principal: $Path" }
}

function Assert-DictionaryAreaAcl {
    param([string]$Path, [string]$PoolSid)
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw "Additional password dictionary owner or inheritance protection is invalid: $Path" }
    $read = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
    foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        if ($rule.IdentityReference.Value -in @('S-1-5-18', 'S-1-5-32-544')) { continue }
        if ($rule.IdentityReference.Value -ne $PoolSid -or (([int]$rule.FileSystemRights -band (-bnot $read)) -ne 0)) { throw "Additional password dictionary has disallowed access rights: $Path" }
    }
}

function Write-DurableDictionaryFile {
    param([string]$Path, [byte[]]$Bytes)
    # Assign DACL at creation so inherited Modify is not applied to temporary manifest under storage.
    $security = New-Object Security.AccessControl.FileSecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow'))
    }
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $security)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

$lock = $null
$temporary = $null
$manifestTemporary = $null
$manifestExisted = $false
$directoryCreatedByThisRun = $false
$bodyCreatedByThisRun = $null
$lockCreatedByThisRun = $false
$committed = $false
try {
    Assert-Administrator
    Assert-WebAdministration
    if (-not (Test-Path -LiteralPath "IIS:\AppPools\$ApplicationPoolName")) { throw 'Specify an existing application pool.' }
    Assert-NetariumAppPoolIdentityIsolation -ApplicationPoolName $ApplicationPoolName
    $storage = Assert-LocalDictionaryPath $StorageDir
    if (-not (Test-Path -LiteralPath $storage -PathType Container)) { throw 'Specify an existing storage directory.' }
    $directory = Assert-LocalDictionaryPath (Join-Path $storage 'password-blocklist')
    $active = Assert-LocalDictionaryPath (Join-Path $storage 'password-blocklist.json')
    $manifestExisted = Test-Path -LiteralPath $active
    $webRoots = @((Get-Website | ForEach-Object { $_.physicalPath })) + @((Get-WebApplication | ForEach-Object { $_.physicalPath })) + @((Get-WebVirtualDirectory | ForEach-Object { $_.physicalPath }))
    foreach ($webRoot in $webRoots) {
        if ($webRoot -and (Test-NetariumPathOverlap -Left $directory -Right ([Environment]::ExpandEnvironmentVariables($webRoot)))) { throw 'Additional password dictionary cannot be placed within the web root.' }
    }
    if (-not $Disable) {
        $source = Assert-LocalDictionaryPath $DictionaryFile
        foreach ($webRoot in $webRoots) {
            if ($webRoot -and (Test-NetariumPathOverlap -Left $source -Right ([Environment]::ExpandEnvironmentVariables($webRoot)))) { throw 'Input dictionary located within the web root cannot be used.' }
        }
    }
    $poolSid = Get-NetariumAccountSid -AccountName "IIS AppPool\$ApplicationPoolName"
    if (-not $poolSid) { throw 'Failed to resolve the target pool SID.' }
    Assert-DictionaryParentAcl -Path $storage -PoolSid $poolSid -Storage
    $cursor = Split-Path -Parent $storage
    while ($cursor) {
        Assert-DictionaryParentAcl -Path $cursor -PoolSid $poolSid
        $cursor = Split-Path -Parent $cursor
    }
    if ($manifestExisted) { Assert-DictionaryAreaAcl -Path $active -PoolSid $poolSid }
    # Do not create body directory or registered state on invalid initial input.
    if (-not $Disable) {
        $inputStream = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            if ($inputStream.Length -gt (16777216 + 100000)) { throw 'Exceeded maximum allowed dictionary size.' }
            $reader = New-Object IO.BinaryReader($inputStream)
            try { $raw = $reader.ReadBytes([int]$inputStream.Length) } finally { $reader.Dispose() }
            $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($raw)
        } finally { $inputStream.Dispose() }
        $bytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes($text.Replace("`r`n", "`n"))
        $temporary = Join-Path $storage ('.password-blocklist-validate-' + [guid]::NewGuid().ToString('N') + '.tmp')
        Write-DurableDictionaryFile -Path $temporary -Bytes $bytes
        $output = @(& $PhpPath (Join-Path $PSScriptRoot 'password-blocklist.php') "--validate-file=$temporary" 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'Failed to validate the additional dictionary contents.' }
        $metadata = ($output -join "`n") | ConvertFrom-Json
        $sha = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($metadata.sha256 -cne $sha -or $metadata.bytes -ne $bytes.Length -or $bytes.Length -gt 16777216 -or $metadata.entries -lt 1 -or $metadata.entries -gt 100000) { throw 'Dictionary validation results do not match.' }
    }
    if (Test-Path -LiteralPath $directory) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'Additional dictionary path is not a directory.' }
        Assert-DictionaryAreaAcl -Path $directory -PoolSid $poolSid
        # Reject reparse points across all generations prior to recursive ACL modifications.
        $pending = New-Object 'System.Collections.Generic.Queue[string]'
        $pending.Enqueue($directory)
        while ($pending.Count -gt 0) {
            foreach ($child in @(Get-ChildItem -LiteralPath $pending.Dequeue() -Force)) {
                if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point detected in additional dictionary directory.' }
                Assert-DictionaryAreaAcl -Path $child.FullName -PoolSid $poolSid
                if ($child.PSIsContainer) { $pending.Enqueue($child.FullName) }
            }
        }
    } else {
        New-NetariumPrivateDirectory -Path $directory
        $directoryCreatedByThisRun = $true
    }
    Set-NetariumPrivateAcl -Path $directory -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    # Keep lock file to avoid delete/recreate races; concurrent runs fail immediately.
    $lockFile = Join-Path $directory '.management.lock'
    $lockExisted = Test-Path -LiteralPath $lockFile
    $lock = [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if (-not $lockExisted) { $lockCreatedByThisRun = $true }
    Set-NetariumPrivateAcl -Path $lockFile -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    $manifest = [ordered]@{ format_version = 1; enabled = $false }
    if (-not $Disable) {
        $body = Join-Path $directory ("dictionary-$sha.txt")
        if (Test-Path -LiteralPath $body) {
            if ((Get-FileHash -LiteralPath $body -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha) { throw 'Existing dictionary generation content has been modified.' }
        } else {
            [IO.File]::Move($temporary, $body)
            $temporary = $null
            $bodyCreatedByThisRun = $body
        }
        $manifest = [ordered]@{ format_version = 1; enabled = $true; sha256 = $sha; bytes = $bytes.Length; entries = [int]$metadata.entries }
    }
    $manifestTemporary = Join-Path $storage ('.password-blocklist-' + [guid]::NewGuid().ToString('N') + '.tmp')
    Write-DurableDictionaryFile -Path $manifestTemporary -Bytes ([Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Compress) + "`n"))
    # Lock down body and manifest to read-only ACL prior to publication.
    Set-NetariumPrivateAcl -Path $directory -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    Set-NetariumPrivateAcl -Path $manifestTemporary -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    if (Test-Path -LiteralPath $active) { [IO.File]::Replace($manifestTemporary, $active, [NullString]::Value) }
    else { [IO.File]::Move($manifestTemporary, $active) }
    $manifestTemporary = $null
    $committed = $true
    Write-Host 'Additional password dictionary configuration updated. Historical generations are retained until manual maintenance while offline.'
} catch {
    Write-Error $_
    exit 1
} finally {
    if ($lock) {
        $lock.Dispose()
        $lock = $null
    }
    if (-not $committed -and -not $manifestExisted) {
        if ($bodyCreatedByThisRun -and (Test-Path -LiteralPath $bodyCreatedByThisRun)) {
            Remove-Item -LiteralPath $bodyCreatedByThisRun -Force -ErrorAction SilentlyContinue
        }
        if ($lockCreatedByThisRun -and (Test-Path -LiteralPath (Join-Path $directory '.management.lock'))) {
            Remove-Item -LiteralPath (Join-Path $directory '.management.lock') -Force -ErrorAction SilentlyContinue
        }
        if ($directoryCreatedByThisRun -and (Test-Path -LiteralPath $directory)) {
            $children = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction SilentlyContinue)
            if ($children.Count -eq 0) {
                Remove-Item -LiteralPath $directory -Force -ErrorAction SilentlyContinue
            }
        }
    }
    foreach ($path in @($temporary, $manifestTemporary)) {
        if ($path -and (Test-Path -LiteralPath $path)) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
}
