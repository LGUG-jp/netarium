[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/deployment-common.ps1')

# IISアカウント解決だけを置き換え、隔離ディレクトリでWindows ACLを検証する。
$poolSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-82-123')
function New-Object {
    param([string]$TypeName, [object[]]$ArgumentList)
    if ($TypeName -eq 'System.Security.AccessControl.FileSystemAccessRule' -and $ArgumentList[0] -eq 'IIS AppPool\AclTest') {
        $ArgumentList[0] = $poolSid
    }
    Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList
}
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('netarium-acl-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox | Out-Null
$root = Join-Path $sandbox 'app'
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$data = Join-Path $root 'data'
$paths = @($root) + @('public', 'src', 'templates', 'resources', 'scripts', 'config', 'data' | ForEach-Object { Join-Path $root $_ })
$write = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
try {
foreach ($sid in @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-568')) {
    foreach ($rights in @('Write', 'Delete', 'DeleteSubdirectoriesAndFiles', 'ChangePermissions', 'TakeOwnership', 'Modify')) {
        foreach ($path in $paths) {
            New-Item -ItemType Directory -Path $path -Force | Out-Null
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $acl.SetSecurityDescriptorSddlForm("D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;$ownerSid)(A;OICIID;0x1301bf;;;$sid)(A;OICIIOID;0xe0010000;;;$sid)")
            $broad = [Security.Principal.SecurityIdentifier]::new($sid)
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($broad, [Security.AccessControl.FileSystemRights]::ReadAndExecute, 'None', 'None', 'Allow'))
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($broad, [Security.AccessControl.FileSystemRights]$rights, 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($broad, [Security.AccessControl.FileSystemRights]::TakeOwnership, 'None', 'None', 'Deny'))
            Set-Acl -LiteralPath $path -AclObject $acl
        }
        $confidentialFiles = @(
            (Join-Path $data 'db/fixture.sqlite'),
            (Join-Path $data 'sessions/sess_fixture'),
            (Join-Path $data 'password-blocklist.json'),
            (Join-Path $data 'password-blocklist/dictionary-fixture.txt'),
            (Join-Path $root 'config/app.php')
        )
        foreach ($file in $confidentialFiles) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
            [IO.File]::WriteAllText($file, 'synthetic-only')
            $fileAcl = [IO.File]::GetAccessControl($file)
            $fileAcl.SetAccessRuleProtection($true, $true)
            $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($broad, 'Read', 'Allow'))
            $fileAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier($ownerSid)))
            [IO.File]::SetAccessControl($file, $fileAcl)
        }
        $dataAcl = Get-Acl -LiteralPath $data
        $dataAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier($ownerSid)))
        Set-Acl -LiteralPath $data -AclObject $dataAcl
        $configDir = Join-Path $root 'config'
        $configAcl = Get-Acl -LiteralPath $configDir
        $configAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier($ownerSid)))
        Set-Acl -LiteralPath $configDir -AclObject $configAcl
        Set-NetariumAcl -InstallRoot $root -StorageDir $data -ApplicationPoolName 'AclTest'
        $before = @()
        foreach ($path in $paths) {
            $acl = Get-Acl -LiteralPath $path
            if (-not $acl.AreAccessRulesProtected) { throw "継承遮断なし: $path" }
            $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
            foreach ($rule in $rules) {
                if ($rule.IdentityReference.Value -eq $sid -and $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -ne 0) { throw "広範な書込みが残存: $sid / $rights / $path" }
            }
            foreach ($admin in @('S-1-5-18', 'S-1-5-32-544')) {
                if (-not @($rules | Where-Object { $_.IdentityReference.Value -eq $admin -and $_.FileSystemRights -eq 'FullControl' -and $_.AccessControlType -eq 'Allow' }).Count) { throw "管理権限消失: $admin" }
            }
            if ($path -in @($data, (Join-Path $root 'config'))) {
                $expectedCount = if ($path -eq $data) { 4 } else { 3 }
                if ($rules.Count -ne $expectedCount -or @($rules | Where-Object {
                    $_.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544', $poolSid.Value)
                }).Count) { throw '機密領域に不要な主体が残存' }
                $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
                if ($null -eq $owner -or $owner.Value -ne 'S-1-5-32-544') { throw "機密ディレクトリの所有者がAdministratorsではない: $path" }
            } else {
                if (-not @($rules | Where-Object { $_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Deny' }).Count) { throw 'Deny ACE消失' }
                if (-not @($rules | Where-Object { $_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadAndExecute) -eq [Security.AccessControl.FileSystemRights]::ReadAndExecute }).Count) { throw 'プログラム領域の読取りACE消失' }
            }
            $expected = if ($path -eq $data) { [Security.AccessControl.FileSystemRights]::Modify } else { [Security.AccessControl.FileSystemRights]::ReadAndExecute }
            if (-not @($rules | Where-Object { $_.IdentityReference.Value -eq $poolSid.Value -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $expected) -eq $expected -and ($path -eq $data -or ($_.FileSystemRights -band $write) -eq 0) }).Count) { throw 'AppPool権限不一致' }
            $before += $acl.GetSecurityDescriptorSddlForm('Access')
        }
        foreach ($file in $confidentialFiles) {
            $fileAcl = [IO.File]::GetAccessControl($file)
            $rules = @($fileAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
            if (-not $fileAcl.AreAccessRulesProtected -or $rules.Count -ne 3 -or @($rules | Where-Object {
                $_.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544', $poolSid.Value)
            }).Count) { throw 'DB/config/sessionの既存明示Readが残存' }
            $fileOwner = $fileAcl.GetOwner([Security.Principal.SecurityIdentifier])
            if ($null -eq $fileOwner -or $fileOwner.Value -ne 'S-1-5-32-544') { throw "機密ファイルの所有者がAdministratorsではない: $file" }
            if ([IO.File]::ReadAllText($file) -cne 'synthetic-only') { throw 'ACL設定で内容が変更された' }
        }
        foreach ($dictionaryPath in @((Join-Path $data 'password-blocklist'), (Join-Path $data 'password-blocklist.json'), (Join-Path $data 'password-blocklist/dictionary-fixture.txt'))) {
            $dictionaryAcl = Get-Acl -LiteralPath $dictionaryPath
            $dictionaryRules = @($dictionaryAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
            if (-not $dictionaryAcl.AreAccessRulesProtected -or $dictionaryRules.Count -ne 3) { throw '追加辞書のACL分離なし' }
            if (@($dictionaryRules | Where-Object { $_.IdentityReference.Value -eq $poolSid.Value -and ($_.FileSystemRights -band $write) -ne 0 }).Count) { throw '追加辞書にPool書込み権限あり' }
        }
        $bootstrap = Join-Path $data 'bootstrap'
        $secretFile = Join-Path $bootstrap 'preserved.secret'
        [IO.File]::WriteAllText($secretFile, 'preserve-this-copy')
        $leakyAcl = Get-Acl -LiteralPath $secretFile
        $leakyAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($poolSid, 'Read', 'Allow'))
        Set-Acl -LiteralPath $secretFile -AclObject $leakyAcl
        Set-NetariumAcl -InstallRoot $root -StorageDir $data -ApplicationPoolName 'AclTest'
        $after = @($paths | ForEach-Object { (Get-Acl -LiteralPath $_).GetSecurityDescriptorSddlForm('Access') })
        if (($before -join '|') -cne ($after -join '|')) { throw '再適用によるACL変化' }
        foreach ($secretPath in @($bootstrap, $secretFile)) {
            $secretAcl = Get-Acl -LiteralPath $secretPath
            if (-not $secretAcl.AreAccessRulesProtected) { throw '秘密領域の継承遮断なし' }
            $secretRules = @($secretAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
            if ($secretRules.Count -ne 2 -or @($secretRules | Where-Object {
                $_.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544') -or
                $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl'
            }).Count) { throw '秘密領域が管理者/SYSTEM専用ではない' }
            $secretOwner = $secretAcl.GetOwner([Security.Principal.SecurityIdentifier])
            if ($null -eq $secretOwner -or $secretOwner.Value -ne 'S-1-5-32-544') { throw "秘密領域の所有者がAdministratorsではない: $secretPath" }
        }
        if ([IO.File]::ReadAllText($secretFile) -cne 'preserve-this-copy') { throw 'ACL更新で秘密コピーが変更された' }
    }
    Write-Host "PASS ${sid}: 書込み6種の除去、プログラム読取り・Deny維持、DB/config/session読取り限定、AppPool権限、再適用"
}

# 既存非管理者所有者からのAdministrators所有者強制と、暗黙WRITE_DACによるDACL再付与拒否を検証する。
$probeCode = @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class SecurityProbe
{
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool CreateRestrictedToken(
        IntPtr ExistingTokenHandle,
        uint Flags,
        uint DisableSidCount,
        IntPtr SidsToDisable,
        uint DeletePrivilegeCount,
        IntPtr PrivilegesToDelete,
        uint RestrictedSidCount,
        IntPtr SidsToRestrict,
        out IntPtr NewTokenHandle
    );

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool DuplicateToken(IntPtr ExistingTokenHandle, int SECURITY_IMPERSONATION_LEVEL, out IntPtr DuplicateTokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool ImpersonateLoggedOnUser(IntPtr hToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool RevertToSelf();

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern uint SetNamedSecurityInfo(
        string pObjectName,
        int ObjectType,
        int SecurityInfo,
        IntPtr psidOwner,
        IntPtr psidGroup,
        IntPtr pDacl,
        IntPtr pSacl
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    public static uint ProbeWriteDac(string path)
    {
        IntPtr processToken;
        if (!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle, 0x000F01FF, out processToken)) {
            throw new InvalidOperationException("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
        }

        IntPtr adminSidPtr;
        SecurityIdentifier adminSid = new SecurityIdentifier("S-1-5-32-544");
        byte[] adminSidBytes = new byte[adminSid.BinaryLength];
        adminSid.GetBinaryForm(adminSidBytes, 0);
        adminSidPtr = Marshal.AllocHGlobal(adminSidBytes.Length);
        Marshal.Copy(adminSidBytes, 0, adminSidPtr, adminSidBytes.Length);

        int structSize = IntPtr.Size * 2;
        IntPtr sidsToDisable = Marshal.AllocHGlobal(structSize);
        Marshal.WriteIntPtr(sidsToDisable, 0, adminSidPtr);
        Marshal.WriteIntPtr(sidsToDisable, IntPtr.Size, IntPtr.Zero);

        IntPtr restrictedToken = IntPtr.Zero;
        IntPtr impersonationToken = IntPtr.Zero;
        try {
            if (!CreateRestrictedToken(processToken, 0x1, 1, sidsToDisable, 0, IntPtr.Zero, 0, IntPtr.Zero, out restrictedToken)) {
                throw new InvalidOperationException("CreateRestrictedToken failed: " + Marshal.GetLastWin32Error());
            }
            if (!DuplicateToken(restrictedToken, 2, out impersonationToken)) {
                throw new InvalidOperationException("DuplicateToken failed: " + Marshal.GetLastWin32Error());
            }
            if (!ImpersonateLoggedOnUser(impersonationToken)) {
                throw new InvalidOperationException("ImpersonateLoggedOnUser failed: " + Marshal.GetLastWin32Error());
            }
            try {
                return SetNamedSecurityInfo(path, 1, 4, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            } finally {
                RevertToSelf();
            }
        } finally {
            if (impersonationToken != IntPtr.Zero) CloseHandle(impersonationToken);
            if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
            CloseHandle(processToken);
            Marshal.FreeHGlobal(sidsToDisable);
            Marshal.FreeHGlobal(adminSidPtr);
        }
    }
}
'@
Add-Type -TypeDefinition $probeCode -Language CSharp

$probeFile = Join-Path $sandbox 'owner-probe.txt'
[IO.File]::WriteAllText($probeFile, 'owner-probe-content')
$probeAcl = [IO.File]::GetAccessControl($probeFile)
$probeAcl.SetAccessRuleProtection($true, $false)
$probeAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')), 'FullControl', 'Allow'
))
$probeAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier($ownerSid)))
[IO.File]::SetAccessControl($probeFile, $probeAcl)

$writeDacBefore = [SecurityProbe]::ProbeWriteDac($probeFile)
if ($writeDacBefore -ne 0) { throw "所有者WRITE_DACプローブの事前確認失敗: $writeDacBefore" }

Set-NetariumPrivateAcl -Path $probeFile

$probeAclAfter = (Get-Acl -LiteralPath $probeFile)
$probeOwnerAfter = $probeAclAfter.GetOwner([Security.Principal.SecurityIdentifier])
if ($null -eq $probeOwnerAfter -or $probeOwnerAfter.Value -ne 'S-1-5-32-544') {
    throw "Set-NetariumPrivateAcl後の所有者がAdministratorsではない: $($probeOwnerAfter.Value)"
}
$writeDacAfter = [SecurityProbe]::ProbeWriteDac($probeFile)
if ($writeDacAfter -ne 5) {
    throw "Administrators所有者への変更後に旧所有者によるDACL再付与が拒否されなかった (Win32=$writeDacAfter)"
}
Write-Host "PASS: 旧所有者ファイルのAdministrators所有者変更およびDACL再付与拒否 (Win32 0 -> 5)"
} finally {
    Remove-Item -LiteralPath $sandbox -Recurse -Force
}
