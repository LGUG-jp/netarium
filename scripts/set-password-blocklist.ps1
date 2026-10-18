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
        throw 'ローカルドライブの絶対パスを指定してください。UNCと代替データストリームは禁止です。'
    }
    $full = ConvertTo-NetariumAbsolutePath -Path $Path
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '再解析ポイントは使用できません。' }
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
        if ($rights -ne 0) { throw "親領域に非管理者の差替え権限があります: $Path" }
    }
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $trusted) { throw "親領域の所有者が管理主体ではありません: $Path" }
}

function Assert-DictionaryAreaAcl {
    param([string]$Path, [string]$PoolSid)
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw "追加辞書の所有者または継承遮断が不正です: $Path" }
    $read = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
    foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
        if ($rule.AccessControlType -ne 'Allow') { continue }
        if ($rule.IdentityReference.Value -in @('S-1-5-18', 'S-1-5-32-544')) { continue }
        if ($rule.IdentityReference.Value -ne $PoolSid -or (([int]$rule.FileSystemRights -band (-bnot $read)) -ne 0)) { throw "追加辞書に不要なアクセス権があります: $Path" }
    }
}

function Write-DurableDictionaryFile {
    param([string]$Path, [byte[]]$Bytes)
    # storage直下の一時manifestにも継承Modifyが適用されないよう作成時にDACLを指定する。
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
    if (-not (Test-Path -LiteralPath "IIS:\AppPools\$ApplicationPoolName")) { throw '既存のアプリケーションプールを指定してください。' }
    Assert-NetariumAppPoolIdentityIsolation -ApplicationPoolName $ApplicationPoolName
    $storage = Assert-LocalDictionaryPath $StorageDir
    if (-not (Test-Path -LiteralPath $storage -PathType Container)) { throw '既存のstorageディレクトリを指定してください。' }
    $directory = Assert-LocalDictionaryPath (Join-Path $storage 'password-blocklist')
    $active = Assert-LocalDictionaryPath (Join-Path $storage 'password-blocklist.json')
    $manifestExisted = Test-Path -LiteralPath $active
    $webRoots = @((Get-Website | ForEach-Object { $_.physicalPath })) + @((Get-WebApplication | ForEach-Object { $_.physicalPath })) + @((Get-WebVirtualDirectory | ForEach-Object { $_.physicalPath }))
    foreach ($webRoot in $webRoots) {
        if ($webRoot -and (Test-NetariumPathOverlap -Left $directory -Right ([Environment]::ExpandEnvironmentVariables($webRoot)))) { throw 'Web公開領域には追加辞書を配置できません。' }
    }
    if (-not $Disable) {
        $source = Assert-LocalDictionaryPath $DictionaryFile
        foreach ($webRoot in $webRoots) {
            if ($webRoot -and (Test-NetariumPathOverlap -Left $source -Right ([Environment]::ExpandEnvironmentVariables($webRoot)))) { throw 'Web公開領域の入力辞書は使用できません。' }
        }
    }
    $poolSid = Get-NetariumAccountSid -AccountName "IIS AppPool\$ApplicationPoolName"
    if (-not $poolSid) { throw '対象プールのSIDを解決できません。' }
    Assert-DictionaryParentAcl -Path $storage -PoolSid $poolSid -Storage
    $cursor = Split-Path -Parent $storage
    while ($cursor) {
        Assert-DictionaryParentAcl -Path $cursor -PoolSid $poolSid
        $cursor = Split-Path -Parent $cursor
    }
    if ($manifestExisted) { Assert-DictionaryAreaAcl -Path $active -PoolSid $poolSid }
    # 不正な初回入力では本文領域・登録状態を作らない。
    if (-not $Disable) {
        $inputStream = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            if ($inputStream.Length -gt (16777216 + 100000)) { throw '追加辞書の容量上限を超えています。' }
            $reader = New-Object IO.BinaryReader($inputStream)
            try { $raw = $reader.ReadBytes([int]$inputStream.Length) } finally { $reader.Dispose() }
            $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($raw)
        } finally { $inputStream.Dispose() }
        $bytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes($text.Replace("`r`n", "`n"))
        $temporary = Join-Path $storage ('.password-blocklist-validate-' + [guid]::NewGuid().ToString('N') + '.tmp')
        Write-DurableDictionaryFile -Path $temporary -Bytes $bytes
        $output = @(& $PhpPath (Join-Path $PSScriptRoot 'password-blocklist.php') "--validate-file=$temporary" 2>&1)
        if ($LASTEXITCODE -ne 0) { throw '追加辞書の本文検証に失敗しました。' }
        $metadata = ($output -join "`n") | ConvertFrom-Json
        $sha = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($metadata.sha256 -cne $sha -or $metadata.bytes -ne $bytes.Length -or $bytes.Length -gt 16777216 -or $metadata.entries -lt 1 -or $metadata.entries -gt 100000) { throw '本文検証結果が一致しません。' }
    }
    if (Test-Path -LiteralPath $directory) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw '追加辞書領域がディレクトリではありません。' }
        Assert-DictionaryAreaAcl -Path $directory -PoolSid $poolSid
        # 再帰的ACL変更前に、全世代について再解析ポイントを拒否する。
        $pending = New-Object 'System.Collections.Generic.Queue[string]'
        $pending.Enqueue($directory)
        while ($pending.Count -gt 0) {
            foreach ($child in @(Get-ChildItem -LiteralPath $pending.Dequeue() -Force)) {
                if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '追加辞書領域に再解析ポイントがあります。' }
                Assert-DictionaryAreaAcl -Path $child.FullName -PoolSid $poolSid
                if ($child.PSIsContainer) { $pending.Enqueue($child.FullName) }
            }
        }
    } else {
        New-NetariumPrivateDirectory -Path $directory
        $directoryCreatedByThisRun = $true
    }
    Set-NetariumPrivateAcl -Path $directory -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    # ファイルを残すことでロックの削除・再作成競合を避ける。二重管理は即座に失敗する。
    $lockFile = Join-Path $directory '.management.lock'
    $lockExisted = Test-Path -LiteralPath $lockFile
    $lock = [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if (-not $lockExisted) { $lockCreatedByThisRun = $true }
    Set-NetariumPrivateAcl -Path $lockFile -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    $manifest = [ordered]@{ format_version = 1; enabled = $false }
    if (-not $Disable) {
        $body = Join-Path $directory ("dictionary-$sha.txt")
        if (Test-Path -LiteralPath $body) {
            if ((Get-FileHash -LiteralPath $body -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha) { throw '既存の世代本文が改変されています。' }
        } else {
            [IO.File]::Move($temporary, $body)
            $temporary = $null
            $bodyCreatedByThisRun = $body
        }
        $manifest = [ordered]@{ format_version = 1; enabled = $true; sha256 = $sha; bytes = $bytes.Length; entries = [int]$metadata.entries }
    }
    $manifestTemporary = Join-Path $storage ('.password-blocklist-' + [guid]::NewGuid().ToString('N') + '.tmp')
    Write-DurableDictionaryFile -Path $manifestTemporary -Bytes ([Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Compress) + "`n"))
    # 公開前に本文とマニフェストを読み取り専用ACLへ固定する。
    Set-NetariumPrivateAcl -Path $directory -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    Set-NetariumPrivateAcl -Path $manifestTemporary -ApplicationPoolName $ApplicationPoolName -PoolRights ReadAndExecute
    if (Test-Path -LiteralPath $active) { [IO.File]::Replace($manifestTemporary, $active, [NullString]::Value) }
    else { [IO.File]::Move($manifestTemporary, $active) }
    $manifestTemporary = $null
    $committed = $true
    Write-Host '追加辞書の設定を更新しました。旧世代本文は停止中の運用整理まで保持します。'
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
