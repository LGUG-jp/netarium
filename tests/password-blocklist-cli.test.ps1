[CmdletBinding()]
param([string]$PhpPath = 'php')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'scripts/deployment-common.ps1')
Assert-Administrator
Assert-WebAdministration
$pool = 'NetariumDictionaryTest-' + [guid]::NewGuid().ToString('N')
# Create a dedicated protected directory directly under drive root, as TEMP might be cleared by other sandbox users.
$root = Join-Path ([IO.Path]::GetPathRoot($repo)) $pool
$data = Join-Path $root 'storage'
$dictionaryInput = Join-Path $root 'input.txt'
$directory = Join-Path $data 'password-blocklist'
$active = Join-Path $data 'password-blocklist.json'
$cli = Join-Path $repo 'scripts/set-password-blocklist.ps1'
$utf8 = New-Object Text.UTF8Encoding($false)
function Invoke-DictionaryCli {
    param([switch]$Disable, [switch]$Fail, [string]$Storage = $data, [string]$Source = $dictionaryInput, [string]$PoolName = $pool)
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $cli, '-StorageDir', $Storage, '-ApplicationPoolName', $PoolName, '-PhpPath', $PhpPath)
    if ($Disable) { $arguments += '-Disable' } else { $arguments += @('-DictionaryFile', $Source) }
    $saved = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = @(& powershell.exe @arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $saved }
    if (($Fail -and $code -eq 0) -or (-not $Fail -and $code -ne 0)) { throw "CLI終了コード不一致: $code / $($result -join ' ')" }
}
function Assert-ManifestPreserved {
    param([string]$Before)
    if ([IO.File]::ReadAllText($active) -cne $Before) { throw '失敗した操作が有効manifestを変更しました。' }
}
try {
    New-WebAppPool -Name $pool | Out-Null
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    Set-NetariumPrivateAcl -Path $root -ApplicationPoolName $pool -PoolRights ReadAndExecute
    Set-NetariumPrivateAcl -Path $data -ApplicationPoolName $pool
    Set-NetariumPasswordBlocklistAcl -StorageDir $data -ApplicationPoolName $pool
    if (Test-Path -LiteralPath $directory) { throw '初期追加辞書が自動作成されました。' }
    [IO.File]::WriteAllText($dictionaryInput, 'invalid-first-input-without-newline', $utf8)
    Invoke-DictionaryCli -Fail
    if ((Test-Path -LiteralPath $directory) -or (Test-Path -LiteralPath $active)) { throw '不正な初回入力が登録状態を作成しました。' }
    # If initial registration fails midway (e.g., manifest creation/swap failure), roll back leftovers without breaking the unconfigured state.
    $activeDirectory = Join-Path $data 'password-blocklist.json'
    New-Item -ItemType Directory -Path $activeDirectory -Force | Out-Null
    [IO.File]::WriteAllText($dictionaryInput, "First-local-secret`n", $utf8)
    try {
        Invoke-DictionaryCli -Fail
    } finally {
        Remove-Item -LiteralPath $activeDirectory -Force -Recurse -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $directory) {
        $residual = @(Get-ChildItem -LiteralPath $directory -Force)
        if ($residual.Count -gt 0) { throw "初回登録失敗後に残置物があります: $($residual -join ', ')" }
    }
    if (Test-Path -LiteralPath $active) { throw '失敗した初回登録がmanifestを作成しました。' }
    $checkProbe = @'
require $argv[1] . '/bootstrap.php';
putenv('NETARIUM_STORAGE_DIR=' . $argv[2]);
$b = new \Netarium\Services\Auth\PasswordBlocklist();
exit($b->isAvailable() ? 0 : 1);
'@
    & $PhpPath -d opcache.enable_cli=0 -r $checkProbe $repo $data
    if ($LASTEXITCODE -ne 0) { throw '初回登録失敗後に未設定環境がfail-closedになりました。' }
    [IO.File]::WriteAllText($dictionaryInput, "First-local-secret`r`n日本語の追加候補`r`n", $utf8)
    Invoke-DictionaryCli
    $first = Get-Content -LiteralPath $active -Raw | ConvertFrom-Json
    $firstBody = Join-Path $directory ("dictionary-$($first.sha256).txt")
    if (-not $first.enabled -or $first.entries -ne 2 -or [IO.File]::ReadAllText($firstBody) -cne "First-local-secret`n日本語の追加候補`n") { throw '初回登録またはCRLF正規化不一致' }
    $firstManifest = [IO.File]::ReadAllText($active)
    foreach ($bad in @("", "no-final-newline", "same`nSAME`n", "empty`n`n", "tab`tvalue`n", "standalone`rvalue`n", "nul`0value`n", ([string][char]0xfeff + "bom`n"), (('x' * 129) + "`n"))) {
        [IO.File]::WriteAllText($dictionaryInput, $bad, $utf8)
        Invoke-DictionaryCli -Fail
        Assert-ManifestPreserved $firstManifest
    }
    [IO.File]::WriteAllBytes($dictionaryInput, [byte[]]@(0xff, 0x0a))
    Invoke-DictionaryCli -Fail
    Assert-ManifestPreserved $firstManifest
    [IO.File]::WriteAllBytes($dictionaryInput, (New-Object byte[] (16777216 + 100001)))
    Invoke-DictionaryCli -Fail
    Assert-ManifestPreserved $firstManifest
    $sb = New-Object Text.StringBuilder
    for ($i = 0; $i -le 100000; $i++) { [void]$sb.AppendLine("unique-$i") }
    $tooMany = $sb.ToString()
    [IO.File]::WriteAllText($dictionaryInput, $tooMany + "`n", $utf8)
    Invoke-DictionaryCli -Fail
    Assert-ManifestPreserved $firstManifest
    [IO.File]::WriteAllText($dictionaryInput, "Second-local-secret`n", $utf8)
    Invoke-DictionaryCli -Fail -Storage '\\localhost\unsafe'
    Invoke-DictionaryCli -Fail -Storage 'relative-storage'
    Invoke-DictionaryCli -Fail -PoolName ($pool + '-missing')
    Assert-ManifestPreserved $firstManifest
    $public = Join-Path $root 'public'
    New-Item -ItemType Directory -Path $public | Out-Null
    New-Website -Name $pool -PhysicalPath $public -ApplicationPool $pool -IPAddress '127.0.0.1' -Port 59463 -HostHeader ($pool + '.invalid') | Out-Null
    Stop-Website -Name $pool
    $webInput = Join-Path $public 'input.txt'
    [IO.File]::WriteAllText($webInput, "web-secret`n", $utf8)
    Invoke-DictionaryCli -Fail -Source $webInput
    New-Item -ItemType Directory -Path (Join-Path $public 'storage') | Out-Null
    Invoke-DictionaryCli -Fail -Storage (Join-Path $public 'storage')
    $junction = Join-Path $directory 'junction'
    New-Item -ItemType Junction -Path $junction -Target $public | Out-Null
    try { Invoke-DictionaryCli -Fail; Assert-ManifestPreserved $firstManifest } finally { [IO.Directory]::Delete($junction) }
    # Reject parent DELETE_CHILD and broad Read permissions on body to fail safe.
    $savedDataAcl = Get-Acl -LiteralPath $data
    $leaky = Get-Acl -LiteralPath $data
    $leaky.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'DeleteSubdirectoriesAndFiles', 'Allow'))
    Set-Acl -LiteralPath $data -AclObject $leaky
    Invoke-DictionaryCli -Fail
    Assert-ManifestPreserved $firstManifest
    Set-Acl -LiteralPath $data -AclObject $savedDataAcl
    $savedBodyAcl = Get-Acl -LiteralPath $firstBody
    $leaky = Get-Acl -LiteralPath $firstBody
    $leaky.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'Read', 'Allow'))
    Set-Acl -LiteralPath $firstBody -AclObject $leaky
    Invoke-DictionaryCli -Fail
    Assert-ManifestPreserved $firstManifest
    Set-Acl -LiteralPath $firstBody -AclObject $savedBodyAcl
    $held = [IO.File]::Open((Join-Path $directory '.management.lock'), 'Open', 'ReadWrite', 'None')
    try { Invoke-DictionaryCli -Fail; Assert-ManifestPreserved $firstManifest } finally { $held.Dispose() }
    # Preserve preceding valid manifest if Replace fails after persisting body content.
    $held = [IO.File]::Open($active, 'Open', 'Read', 'Read')
    try { Invoke-DictionaryCli -Fail; Assert-ManifestPreserved $firstManifest } finally { $held.Dispose() }
    Invoke-DictionaryCli
    $second = Get-Content -LiteralPath $active -Raw | ConvertFrom-Json
    if ($second.sha256 -ceq $first.sha256 -or $second.entries -ne 1 -or -not (Test-Path -LiteralPath $firstBody)) { throw '更新または旧世代保持が失敗しました。' }
    $secondManifest = [IO.File]::ReadAllText($active)
    $secondBody = Join-Path $directory ("dictionary-$($second.sha256).txt")
    $secondBytes = [IO.File]::ReadAllBytes($secondBody)
    [IO.File]::WriteAllText($secondBody, "modified`n", $utf8)
    Invoke-DictionaryCli -Fail
    Assert-ManifestPreserved $secondManifest
    [IO.File]::WriteAllBytes($secondBody, $secondBytes)
    Invoke-DictionaryCli -Disable
    $disabled = Get-Content -LiteralPath $active -Raw | ConvertFrom-Json
    if ($disabled.enabled -ne $false -or @($disabled.PSObject.Properties).Count -ne 2 -or -not (Test-Path -LiteralPath $firstBody) -or -not (Test-Path -LiteralPath $secondBody)) { throw '解除または世代保持が失敗しました。' }
    $poolSid = Get-NetariumAccountSid -AccountName "IIS AppPool\$pool"
    foreach ($path in @($directory, $active) + @(Get-ChildItem -LiteralPath $directory -Force | ForEach-Object { $_.FullName })) {
        $acl = Get-Acl -LiteralPath $path
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or $rules.Count -ne 3) { throw '追加領域ACL不一致' }
        foreach ($rule in $rules) {
            if ($rule.IdentityReference.Value -eq $poolSid) {
                $allowed = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
                if ($rule.AccessControlType -ne 'Allow' -or (([int]$rule.FileSystemRights -band (-bnot $allowed)) -ne 0)) { throw 'Poolに書込み可能な追加領域があります。' }
            } elseif ($rule.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544') -or $rule.FileSystemRights -ne 'FullControl') { throw '他の非管理者への付与があります。' }
        }
    }
    Write-Host 'PASS: 初回登録・更新・解除、原文保持、容量/行数/本文/ACL負例、失敗時manifest保持、排他と旧世代保持'
} finally {
    if (Test-Path -LiteralPath "IIS:\Sites\$pool") { Remove-Website -Name $pool }
    if (Test-Path -LiteralPath "IIS:\AppPools\$pool") { Remove-WebAppPool -Name $pool }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
