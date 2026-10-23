[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $repoRoot 'scripts/full-backup-common.ps1')

$testCount = 0
$passCount = 0

function Assert-ScriptTest {
    param([string]$Name, [scriptblock]$Condition)
    $script:testCount++
    try {
        $result = & $Condition
        if ($result) {
            $script:passCount++
            Write-Host "  [PASS] $Name"
        } else {
            Write-Error "  [FAIL] ${Name}: condition returned false"
        }
    } catch {
        Write-Error "  [FAIL] ${Name}: $($_.Exception.Message)"
    }
}

Write-Host "=== Testing full-backup PowerShell Common Functions ==="

# Missing PHP must fail with actionable guidance before IIS maintenance begins.
Assert-ScriptTest -Name 'Missing php.exe reports -PhpPath guidance' -Condition {
    $missing = Join-Path ([IO.Path]::GetTempPath()) ('netarium-no-php-' + [guid]::NewGuid().ToString('N') + '.exe')
    try {
        Start-FullWorker $missing $repoRoot | Out-Null
        return $false
    } catch {
        return $_.Exception.Message.Contains('PHP CLI executable not found') -and
            $_.Exception.Message.Contains('-PhpPath')
    }
}

# 1. Assert-FullPath rejects UNC paths
Assert-ScriptTest -Name 'Assert-FullPath rejects UNC path' -Condition {
    try {
        Assert-FullPath '\\server\share\file.txt' | Out-Null
        return $false
    } catch {
        return $_.Exception.Message -like '*UNC paths*'
    }
}

# 2. Assert-FullPath normalizes and validates local path
Assert-ScriptTest -Name 'Assert-FullPath accepts valid local path' -Condition {
    $p = Assert-FullPath (Join-Path $repoRoot 'public/index.php')
    return (Test-Path -LiteralPath $p) -and ($p -notlike '*..*')
}

# 3. Assert-FullSidecars detects WAL / shm / journal files
Assert-ScriptTest -Name 'Assert-FullSidecars detects leftover sidecars' -Condition {
    $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('netarium-sidecar-test-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $dbPath = Join-Path $tempDir 'data.sqlite'
    try {
        Set-Content -LiteralPath $dbPath -Value 'dummy'
        Assert-FullSidecars $dbPath # should pass when no sidecars exist

        # Create -wal file
        Set-Content -LiteralPath ($dbPath + '-wal') -Value 'wal'
        try {
            Assert-FullSidecars $dbPath
            return $false
        } catch {
            return $_.Exception.Message -like '*SQLite sidecar remains*'
        }
    } finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force
    }
}

# 4. Assert-FullSpace verifies free disk space
Assert-ScriptTest -Name 'Assert-FullSpace rejects when requested bytes exceed drive capacity' -Condition {
    try {
        # Request an impossibly large size (1000 TB)
        Assert-FullSpace $repoRoot ([long]1000 * 1024 * 1024 * 1024 * 1024)
        return $false
    } catch {
        return $_.Exception.Message -like '*Insufficient disk space*'
    }
}

# 8. Check-install accepts --allow-orphan-images flag and ignores unreferenced images
Assert-ScriptTest -Name 'check-install accepts --allow-orphan-images flag' -Condition {
    $tempApp = Join-Path ([IO.Path]::GetTempPath()) ('netarium-chk-app-' + [guid]::NewGuid().ToString('N'))
    $tempStorage = Join-Path ([IO.Path]::GetTempPath()) ('netarium-chk-str-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempApp -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $tempApp 'config') -Force | Out-Null
    New-Item -ItemType Directory -Path $tempStorage -Force | Out-Null
    foreach ($d in @('db', 'db/csv-import', 'uploads/floorplans', 'uploads/device_images', 'temp/backup-export', 'backups/auto', 'temp/backup-restore', 'logs', 'temp')) {
        New-Item -ItemType Directory -Path (Join-Path $tempStorage $d) -Force | Out-Null
    }
    try {
        $dbFile = Join-Path $tempStorage 'db/data.sqlite'
        $php = (Get-Command php.exe -ErrorAction Stop).Source
        $schemaScript = Join-Path $repoRoot 'src/Core/DatabaseSchema.php'
        # Initialize schema and seed view
        & $php -r 'require $argv[2]; $db = new PDO("sqlite:" . $argv[1]); migrateDatabase($db);' ([string]$dbFile -replace '\\', '/') ([string]$schemaScript -replace '\\', '/')
        # Put an orphan image file in uploads/device_images
        $orphan = Join-Path $tempStorage 'uploads/device_images/0123456789abcdef0123456789abcdef.png'
        Set-Content -LiteralPath $orphan -Value 'fake image'

        # check-install without flag should fail due to orphan
        $chkScript = Join-Path $repoRoot 'scripts/check-install.php'
        $p1 = Start-Process -FilePath $php -ArgumentList @($chkScript, '--app-root', $repoRoot, '--storage-dir', $tempStorage, '--db-file', $dbFile) -NoNewWindow -Wait -PassThru -RedirectStandardError (Join-Path $tempApp 'err1.txt')
        $failWithout = ($p1.ExitCode -ne 0)

        # check-install with flag should succeed
        $p2 = Start-Process -FilePath $php -ArgumentList @($chkScript, '--app-root', $repoRoot, '--storage-dir', $tempStorage, '--db-file', $dbFile, '--allow-orphan-images') -NoNewWindow -Wait -PassThru -RedirectStandardError (Join-Path $tempApp 'err2.txt')
        $passWith = ($p2.ExitCode -eq 0)

        return $failWithout -and $passWith
    } finally {
        Remove-Item -LiteralPath $tempApp -Recurse -Force
        Remove-Item -LiteralPath $tempStorage -Recurse -Force
    }
}
# Schema 10 uploads migrated to schema 11 must work through the production entry points.
& {
    $sourceStorage = Join-Path ([IO.Path]::GetTempPath()) ('netarium-prod-src-' + [guid]::NewGuid().ToString('N'))
    $targetStorage = Join-Path ([IO.Path]::GetTempPath()) ('netarium-prod-dst-' + [guid]::NewGuid().ToString('N'))
    $workRoot = Join-Path ([IO.Path]::GetTempPath()) ('netarium-prod-work-' + [guid]::NewGuid().ToString('N'))
    $backupDir = Join-Path ([IO.Path]::GetTempPath()) ('netarium-prod-bak-' + [guid]::NewGuid().ToString('N'))
    $poolName = 'DefaultAppPool'
    $siteName = 'NetariumAcceptanceSite'

    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    foreach ($str in @($sourceStorage, $targetStorage)) {
        New-Item -ItemType Directory -Path $str -Force | Out-Null
        foreach ($d in @('db', 'db/csv-import', 'uploads/floorplans', 'uploads/device_images', 'temp/backup-export', 'backups/auto', 'temp/backup-restore', 'logs', 'temp', 'sessions')) {
            New-Item -ItemType Directory -Path (Join-Path $str $d) -Force | Out-Null
        }
    }

    $oldStorage = $env:NETARIUM_STORAGE_DIR
    $oldDb = $env:NETARIUM_DB_FILE
    try {
        $php = (Get-Command php.exe -ErrorAction Stop).Source
        $srcDb = Join-Path $sourceStorage 'db/data.sqlite'
        $schema = Join-Path $repoRoot 'src/Core/DatabaseSchema.php'
        $initScript = Join-Path $workRoot 'init.php'
        $code = @'
<?php
require $argv[2];
$action = $argv[3];
$root = $argv[4];
$db = new PDO('sqlite:' . $argv[1], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
if ($action === 'init') {
    for ($version = 1; $version <= 10; $version++) {
        ('migrateDatabaseToVersion' . $version)($db);
    }
    if ((int)$db->query('PRAGMA user_version')->fetchColumn() !== 10) { throw new RuntimeException('Expected schema 10'); }
    $db->exec('PRAGMA foreign_keys=ON');
    $db->exec("INSERT INTO devices (id, name) VALUES (1, 'Migration regression device')");
    $db->exec("INSERT INTO views (id, name, view_type) VALUES (1, 'Migration regression floor', 'floor')");
    $user = $db->prepare("INSERT INTO users (username,password_hash,role,created_at,updated_at,auth_revision,password_revision,must_change_password)
        VALUES (?,?,'admin','2026-01-01','2026-01-01',7,3,1)");
    $user->execute(['backup-admin', password_hash('FullBackup-239-test!', PASSWORD_DEFAULT)]);
    $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=');
    $info = getimagesizefromstring($png);
    foreach ([1, 2] as $id) {
        $name = str_repeat((string)$id, 32) . '.png';
        file_put_contents($root . '/uploads/device_images/' . $name, $png);
        $q = $db->prepare("INSERT INTO device_images (device_id,stored_name,mime_type,file_size,image_width,image_height,sort_order,created_at,updated_at)
            VALUES (1,?,'image/png',?,?,?,?,'2026-01-01','2026-01-01')");
        $q->execute([$name, strlen($png), $info[0], $info[1], $id]);
    }
    $name = str_repeat('3', 32) . '.png';
    file_put_contents($root . '/uploads/floorplans/' . $name, $png);
    $q = $db->prepare("INSERT INTO view_floor_plans (view_id,stored_name,original_name,mime_type,file_size,image_width,image_height,created_at,updated_at)
        VALUES (1,?,'floor.png','image/png',?,?,?,'2026-01-01','2026-01-01')");
    $q->execute([$name, strlen($png), $info[0], $info[1]]);
    file_put_contents($root . '/uploads/device_images/' . str_repeat('4', 32) . '.png', $png);
    migrateDatabaseToVersion11($db);
    if ((int)$db->query('PRAGMA user_version')->fetchColumn() !== 11
        || (int)$db->query("SELECT COUNT(*) FROM device_images WHERE sha256 = ''")->fetchColumn() !== 2
        || (int)$db->query("SELECT COUNT(*) FROM view_floor_plans WHERE sha256 = ''")->fetchColumn() !== 1) {
        throw new RuntimeException('Migration did not preserve empty legacy digests');
    }
} elseif ($action === 'state') {
    echo json_encode($db->query('SELECT * FROM users ORDER BY id')->fetchAll(PDO::FETCH_ASSOC), JSON_THROW_ON_ERROR);
} elseif ($action === 'verify') {
    $source = new PDO('sqlite:' . $argv[5]);
    if ($db->query('SELECT * FROM users ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)
        !== $source->query('SELECT * FROM users ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)
        || !password_verify('FullBackup-239-test!', $db->query("SELECT password_hash FROM users WHERE username='backup-admin'")->fetchColumn())
        || $db->query('PRAGMA foreign_key_check')->fetch() !== false) {
        throw new RuntimeException('Restored credentials/password/foreign keys differ');
    }
    $zip = new ZipArchive();
    if ($zip->open($argv[6]) !== true) { throw new RuntimeException('Cannot open full backup'); }
    try {
        $manifest = json_decode($zip->getFromName('manifest.json'), true, 512, JSON_THROW_ON_ERROR);
        foreach ($manifest['files'] as $name => $metadata) {
            $bytes = $zip->getFromName($name);
            if (!is_string($bytes) || hash('sha256', $bytes) !== $metadata['sha256']
                || strlen($bytes) !== $metadata['bytes']) { throw new RuntimeException('Manifest mismatch: ' . $name); }
        }
        foreach (['device_images' => 'device_images', 'view_floor_plans' => 'floorplans'] as $table => $directory) {
            $rows = $db->query("SELECT * FROM $table ORDER BY rowid")->fetchAll(PDO::FETCH_ASSOC);
            $original = $source->query("SELECT * FROM $table ORDER BY rowid")->fetchAll(PDO::FETCH_ASSOC);
            if (count($rows) !== ($table === 'device_images' ? 2 : 1)) { throw new RuntimeException('Lost image references'); }
            foreach ($rows as $index => $row) {
                $name = $directory . '/' . $row['stored_name'];
                $path = $root . '/uploads/' . $name;
                if ($row['sha256'] === '' || $row['sha256'] !== hash_file('sha256', $path)
                    || $row['sha256'] !== $manifest['files'][$name]['sha256']
                    || hash_file('sha256', $path) !== hash_file('sha256', $argv[7] . '/uploads/' . $name)) {
                    throw new RuntimeException('Restored image digest mismatch: ' . $name);
                }
                $row['sha256'] = '';
                if ($row !== $original[$index]) { throw new RuntimeException('Restored reference metadata differs'); }
            }
        }
        $orphan = 'device_images/' . str_repeat('4', 32) . '.png';
        if (!isset($manifest['files'][$orphan])
            || hash_file('sha256', $root . '/uploads/' . $orphan) !== hash_file('sha256', $argv[7] . '/uploads/' . $orphan)) {
            throw new RuntimeException('Unreferenced image lost');
        }
    } finally { $zip->close(); }
} elseif ($action === 'digest') {
    $db->exec("UPDATE device_images SET sha256 = '" . str_repeat('0', 64) . "' WHERE id = 1");
} elseif ($action === 'missing') {
    unlink($root . '/uploads/device_images/' . str_repeat('1', 32) . '.png');
} elseif ($action === 'size') {
    $db->exec('UPDATE device_images SET file_size = file_size + 1 WHERE id = 1');
} elseif ($action === 'path') {
    $db->exec("UPDATE device_images SET stored_name = '../outside.png' WHERE id = 1");
} elseif ($action === 'foreign-key') {
    $db->exec('PRAGMA foreign_keys=OFF');
    $db->exec('UPDATE device_images SET device_id = 99999 WHERE id = 1');
} else {
    throw new RuntimeException('Unknown fixture action');
}
'@
        Set-Content -LiteralPath $initScript -Value $code -Encoding UTF8
        function Invoke-BackupFixture {
            param([string]$Database, [string]$Action, [string]$Storage, [string[]]$Extra = @())
            $result = & $php $initScript $Database $schema $Action $Storage @Extra
            if ($LASTEXITCODE -ne 0) { throw "Fixture action failed: $Action" }
            return $result
        }
        function Get-BackupSourceState {
            param([string]$Storage)
            $database = Join-Path $Storage 'db/data.sqlite'
            $credentials = Invoke-BackupFixture $database 'state' $Storage
            $hashes = foreach ($file in @(
                Microsoft.PowerShell.Management\Get-Item -LiteralPath $database
                # Recovery staging is intentionally retained beside, not inside, live image targets.
                Get-ChildItem -LiteralPath (Join-Path $Storage 'uploads/floorplans'), (Join-Path $Storage 'uploads/device_images') -File -Recurse | Sort-Object FullName
            )) {
                $file.FullName.Substring($Storage.Length) + ':' + (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            }
            return ($credentials + "`n" + ($hashes -join "`n"))
        }
        Invoke-BackupFixture $srcDb 'init' $sourceStorage | Out-Null


        # Isolated IIS mocks
        . (Join-Path $PSScriptRoot 'maintenance-fixture.ps1')
        $global:mockSiteState = 'Started'
        $global:mockPoolState = 'Started'

        function Get-Website { param($Name, [string]$ErrorAction) return [pscustomobject]@{ Name = $siteName; PhysicalPath = (Join-Path $repoRoot 'public'); ApplicationPool = $poolName; Bindings = [pscustomobject]@{ Collection = @([pscustomobject]@{ protocol = 'http'; bindingInformation = '127.0.0.1:49249:'; sslFlags = 0; certificateHash = ''; certificateStoreName = '' }) } } }
        function Get-WebSiteState { param($Name, [string]$ErrorAction) return [pscustomobject]@{ Value = $global:mockSiteState } }
        function Stop-Website { param($Name, [string]$ErrorAction) $global:mockSiteState = 'Stopped'; $global:mockSiteStops++ }
        function Start-Website { param($Name, [string]$ErrorAction) $global:mockSiteState = 'Started' }
        function Get-WebAppPoolState { param($Name, [string]$ErrorAction) return [pscustomobject]@{ Value = $global:mockPoolState } }
        function Stop-WebAppPool { param($Name, [string]$ErrorAction) $global:mockPoolState = 'Stopped'; $global:mockPoolStops++ }
        function Start-WebAppPool { param($Name, [string]$ErrorAction) $global:mockPoolState = 'Started' }
        function Get-WebRequest { param($AppPool, [string]$ErrorAction) return @() }

        function Get-Item {
            param([string]$Path, [string]$LiteralPath, [switch]$Force, $ErrorAction)
            $target = if ($LiteralPath) { $LiteralPath } else { $Path }
            if ($target -like 'IIS:\AppPools\*') {
                return [pscustomobject]@{ Name = $poolName; State = $global:mockPoolState; startMode = 'AlwaysRunning'; processModel = [pscustomobject]@{ identityType = 'ApplicationPoolIdentity'; userName = ''; password = '' } }
            }
            if ($target -like 'IIS:\Sites\*') {
                return [pscustomobject]@{ Name = $siteName; State = $global:mockSiteState }
            }
            if ($LiteralPath) {
                return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force:$Force
            } else {
                return Microsoft.PowerShell.Management\Get-Item -Path $Path -Force:$Force
            }
        }

        function Get-ItemProperty {
            param([string]$Path, [string]$LiteralPath, [string]$Name, $ErrorAction)
            $p = if ($LiteralPath) { $LiteralPath } else { $Path }
            if ($p -like 'IIS:\AppPools\*') {
                return [pscustomobject]@{ identityType = 'ApplicationPoolIdentity'; userName = ''; password = '' }
            }
            return Microsoft.PowerShell.Management\Get-ItemProperty -Path $Path -Name $Name
        }

        function Test-Path {
            param([string]$Path, [string]$LiteralPath, $PathType, $ErrorAction)
            $target = if ($LiteralPath) { $LiteralPath } else { $Path }
            if ($target -like 'IIS:*') { return $true }
            if ($LiteralPath) {
                if ($PathType) {
                    return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType $PathType
                }
                return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
            }
            if ($PathType) {
                return Microsoft.PowerShell.Management\Test-Path -Path $Path -PathType $PathType
            }
            return Microsoft.PowerShell.Management\Test-Path -Path $Path
        }

        function Get-WebConfigurationLocation { param($Name, $PSPath, [string]$ErrorAction) return @() }
        function Get-NetariumWebCollection { param($PSPath, $Filter, $Location, [string]$ErrorAction) return @() }
        function Get-WebConfigurationProperty { param($PSPath, $Location, $Filter, $Name, [string]$ErrorAction) return $null }

        $backupScript = Join-Path $repoRoot 'scripts/backup-full.ps1'
        Assert-ScriptTest -Name 'Schema 10 to 11: production backup/restore preserves live data, references, credentials, orphan images, sessions and ACLs' -Condition {
            $env:NETARIUM_STORAGE_DIR = $sourceStorage
            $env:NETARIUM_DB_FILE = $srcDb
            $before = Get-BackupSourceState $sourceStorage
            $global:mockSiteStops = 0
            $global:mockPoolStops = 0
            $bakRes = Invoke-MaintenanceTestCli $backupScript @{ InstallRoot = $repoRoot; SiteName = $siteName; ApplicationPoolName = $poolName; BackupDirectory = $backupDir; PhpPath = $php; VerificationUrl = @('http://127.0.0.1:49249/') }
            if (-not $bakRes -or -not (Test-Path -LiteralPath $bakRes.Archive)) { throw 'backup-full.ps1 failed to generate archive' }
            $script:productionBackupArchive = [string]$bakRes.Archive
            if ((Get-BackupSourceState $sourceStorage) -cne $before) { throw 'Backup changed live DB, images or user credentials' }
            Set-Content -LiteralPath (Join-Path $targetStorage 'sessions/sess_9999999999abcdef9999999999abcdef') -Value 'active_session_before_restore'
            Set-Content -LiteralPath (Join-Path $targetStorage 'sessions/sess_8888888888abcdef8888888888abcdef') -Value 'another_active_session'
            $env:NETARIUM_STORAGE_DIR = $targetStorage
            $env:NETARIUM_DB_FILE = Join-Path $targetStorage 'db/data.sqlite'
            $restRes = Invoke-MaintenanceTestCli (Join-Path $repoRoot 'scripts/restore-full.ps1') @{ InstallRoot = $repoRoot; SiteName = $siteName; ApplicationPoolName = $poolName; Archive = $bakRes.Archive; WorkRoot = $workRoot; PhpPath = $php; VerificationUrl = @('http://127.0.0.1:49249/') }
            if (-not $restRes -or -not $restRes.Restored) { throw 'restore-full.ps1 reported failure' }
            Invoke-BackupFixture $env:NETARIUM_DB_FILE 'verify' $targetStorage @($srcDb, $bakRes.Archive, $sourceStorage) | Out-Null
            if ((Get-BackupSourceState $sourceStorage) -cne $before) { throw 'Restore changed source live DB, images or user credentials' }
            if (@(Get-ChildItem -LiteralPath (Join-Path $targetStorage 'sessions') -Force).Count -ne 0) { throw 'Restore did not invalidate sessions' }
            $poolSid = (New-Object Security.Principal.NTAccount("IIS AppPool\$poolName")).Translate([Security.Principal.SecurityIdentifier]).Value
            $restoredPaths = @($env:NETARIUM_DB_FILE, (Join-Path $targetStorage 'uploads/device_images'), (Join-Path $targetStorage 'uploads/floorplans'))
            $restoredPaths += @(Get-ChildItem -LiteralPath (Join-Path $targetStorage 'uploads') -File -Recurse | ForEach-Object { $_.FullName })
            foreach ($path in @($bakRes.Archive) + $restoredPaths) {
                $acl = Get-Acl -LiteralPath $path
                $allowed = @('S-1-5-18', 'S-1-5-32-544')
                if ($path -ne $bakRes.Archive) { $allowed += $poolSid }
                $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
                if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or
                    $rules.Count -ne $allowed.Count) { throw "Unexpected private ACL: $path" }
                foreach ($sid in $allowed) {
                    $rule = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid })
                    $rights = if ($sid -eq $poolSid) { [Security.AccessControl.FileSystemRights]::Modify } else { [Security.AccessControl.FileSystemRights]::FullControl }
                    if ($rule.Count -ne 1 -or $rule[0].AccessControlType -ne 'Allow' -or
                        ($rule[0].FileSystemRights -band $rights) -ne $rights) { throw "Unexpected rights for ${sid}: $path" }
                }
            }
            return $global:mockSiteState -eq 'Started' -and $global:mockPoolState -eq 'Started' -and $global:mockSiteStops -eq 2 -and $global:mockPoolStops -eq 2
        }

        Assert-ScriptTest -Name 'Production backup drain timeout preserves active requests and performs no data snapshot' -Condition {
            $env:NETARIUM_STORAGE_DIR = $sourceStorage
            $env:NETARIUM_DB_FILE = $srcDb
            $before = Get-BackupSourceState $sourceStorage
            $timeoutBackup = Join-Path $workRoot 'drain-timeout'
            New-Item -ItemType Directory -Path $timeoutBackup | Out-Null
            $global:mockSiteStops = 0; $global:mockPoolStops = 0
            $workerBoundary = (Get-Command Invoke-FullWorker).ScriptBlock
            $script:unexpectedDataCommands = 0
            function Invoke-FullWorker {
                param($Worker, [hashtable]$Request)
                if ($Request.command -in @('snapshot','prepare','pack','checkpoint')) { $script:unexpectedDataCommands++; throw 'Drain failure reached a data-processing command' }
                & $workerBoundary $Worker $Request
            }
            function Get-WebRequest { param($AppPool, $ErrorAction) return @([pscustomobject]@{ RequestId = 'still-running' }) }
            $failure = $null
            try {
                Invoke-MaintenanceTestCli $backupScript @{ InstallRoot = $repoRoot; SiteName = $siteName; ApplicationPoolName = $poolName; BackupDirectory = $timeoutBackup; PhpPath = $php; VerificationUrl = @('http://127.0.0.1:49249/'); DrainTimeoutSeconds = 0 } | Out-Null
            } catch { $failure = $_.Exception.Message }
            if ($failure -notlike '*request drain timed out*') { throw "Unexpected drain outcome: $failure" }
            if ($global:mockSiteStops -ne 0 -or $global:mockPoolStops -ne 0) { throw 'Timeout cleanup terminated in-flight requests' }
            if ((Get-BackupSourceState $sourceStorage) -cne $before -or @(Get-ChildItem -LiteralPath $timeoutBackup -Force).Count) { throw 'Drain failure processed data or left a snapshot/archive' }
            if ($script:unexpectedDataCommands -ne 0) { throw 'Drain timeout reached data snapshot/processing' }
            if (Test-Path -LiteralPath (Join-Path $script:maintenanceFixtureRoot 'journal.json')) { throw 'Timeout cleanup left owned maintenance installed' }
            return $global:mockSiteState -eq 'Started' -and $global:mockPoolState -eq 'Started' -and @(Get-WebRequest $poolName).Count -eq 1
        }

        Assert-ScriptTest -Name 'Production restore placement failure rolls back data and restores owned maintenance state' -Condition {
            $env:NETARIUM_STORAGE_DIR = $targetStorage
            $env:NETARIUM_DB_FILE = Join-Path $targetStorage 'db/data.sqlite'
            $before = Get-BackupSourceState $targetStorage
            function Set-Acl {
                param([string]$LiteralPath, $AclObject, $ErrorAction)
                if ($LiteralPath -eq $env:NETARIUM_DB_FILE) { throw 'Injected restore placement ACL failure' }
                Microsoft.PowerShell.Security\Set-Acl -LiteralPath $LiteralPath -AclObject $AclObject -ErrorAction Stop
            }
            $failure = $null
            try {
                Invoke-MaintenanceTestCli (Join-Path $repoRoot 'scripts/restore-full.ps1') @{ InstallRoot = $repoRoot; SiteName = $siteName; ApplicationPoolName = $poolName; Archive = $script:productionBackupArchive; WorkRoot = $workRoot; PhpPath = $php; VerificationUrl = @('http://127.0.0.1:49249/') } | Out-Null
            } catch { $failure = $_.Exception.Message }
            if ($failure -ne 'Injected restore placement ACL failure') { throw "Unexpected restore failure: $failure" }
            if ((Get-BackupSourceState $targetStorage) -cne $before) { throw 'Placement failure did not restore the original DB/images/users' }
            if (Test-Path -LiteralPath (Join-Path $script:maintenanceFixtureRoot 'journal.json')) { throw 'Safe restore rollback left owned maintenance active' }
            return $global:mockSiteState -eq 'Started' -and $global:mockPoolState -eq 'Started'
        }

        Assert-ScriptTest -Name 'Production restore rollback failure retains stopped resources and protected recovery data' -Condition {
            $env:NETARIUM_STORAGE_DIR = $targetStorage
            $env:NETARIUM_DB_FILE = Join-Path $targetStorage 'db/data.sqlite'
            $before = Get-BackupSourceState $targetStorage
            function Set-Acl {
                param([string]$LiteralPath, $AclObject, $ErrorAction)
                if ($LiteralPath -eq $env:NETARIUM_DB_FILE) { throw 'Injected restore placement ACL failure' }
                Microsoft.PowerShell.Security\Set-Acl -LiteralPath $LiteralPath -AclObject $AclObject -ErrorAction Stop
            }
            function Move-Item {
                param([string]$LiteralPath, [string]$Destination, [switch]$Force, $ErrorAction)
                if ((Split-Path -Leaf $LiteralPath) -eq 'old') { throw 'Injected rollback rename failure' }
                Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force -ErrorAction Stop
            }
            $failure = $null
            try {
                Invoke-MaintenanceTestCli (Join-Path $repoRoot 'scripts/restore-full.ps1') @{ InstallRoot = $repoRoot; SiteName = $siteName; ApplicationPoolName = $poolName; Archive = $script:productionBackupArchive; WorkRoot = $workRoot; PhpPath = $php; VerificationUrl = @('http://127.0.0.1:49249/') } | Out-Null
            } catch { $failure = $_.Exception.Message }
            if ($failure -notlike '*Rollback failed*Injected rollback rename failure*') { throw "Unexpected unsafe rollback outcome: $failure" }
            if ($global:mockSiteState -ne 'Stopped' -or $global:mockPoolState -ne 'Stopped') { throw 'Unsafe rollback restarted IIS' }
            $journal = Join-Path $script:maintenanceFixtureRoot 'journal.json'
            if (-not (Test-Path -LiteralPath $journal)) { throw 'Unsafe rollback discarded its recovery journal' }
            $old = @(Get-ChildItem -LiteralPath (Join-Path $targetStorage 'db') -Directory -Force | Where-Object { $_.Name -like '.netarium-stage-*' } | ForEach-Object { Join-Path $_.FullName 'old' } | Where-Object { Test-Path -LiteralPath $_ })
            if ($old.Count -ne 1) { throw 'Original DB was not preserved for administrator recovery' }
            # Exercise the documented administrator path after repairing data, bypassing only injected rename failure.
            Microsoft.PowerShell.Management\Move-Item -LiteralPath $old[0] -Destination $env:NETARIUM_DB_FILE
            $after = Get-BackupSourceState $targetStorage
            if ($after -cne $before) {
                $changed = @(Compare-Object @($before -split "`n" | Select-Object -Skip 1) @($after -split "`n" | Select-Object -Skip 1) | ForEach-Object { $_.InputObject -replace ':[A-Fa-f0-9]{64}$', '' })
                throw "Protected rollback data did not restore the original installation. Changed paths: $($changed -join ', ')"
            }
            Repair-NetariumMaintenance $repoRoot -DataSafetyConfirmed
            foreach ($directory in @(Get-ChildItem -LiteralPath $targetStorage -Directory -Force -Recurse | Where-Object { $_.Name -like '.netarium-stage-*' })) { Remove-Item -LiteralPath $directory.FullName -Recurse -Force }
            foreach ($directory in @(Get-ChildItem -LiteralPath $workRoot -Directory -Force | Where-Object { $_.Name -match '^[a-f0-9]{32}$' })) { Remove-Item -LiteralPath $directory.FullName -Recurse -Force }
            return $global:mockSiteState -eq 'Started' -and $global:mockPoolState -eq 'Started'
        }

        Assert-ScriptTest -Name 'Production backup removes completed partial ZIP on final ACL failure without touching source' -Condition {
            $env:NETARIUM_STORAGE_DIR = $sourceStorage
            $env:NETARIUM_DB_FILE = $srcDb
            $failedBackup = Join-Path $workRoot 'failed-final-acl'
            New-Item -ItemType Directory -Path $failedBackup | Out-Null
            $before = Get-BackupSourceState $sourceStorage
            $global:partialZipObserved = $false
            function Set-Acl {
                param([string]$LiteralPath, $AclObject, $ErrorAction)
                if ($LiteralPath.EndsWith('.partial')) {
                    $global:partialZipObserved = Test-Path -LiteralPath $LiteralPath -PathType Leaf
                    throw 'Injected final backup ACL failure'
                }
                Microsoft.PowerShell.Security\Set-Acl -LiteralPath $LiteralPath -AclObject $AclObject -ErrorAction Stop
            }
            $failure = $null
            try {
                Invoke-MaintenanceTestCli $backupScript @{ InstallRoot = $repoRoot; SiteName = $siteName; ApplicationPoolName = $poolName; BackupDirectory = $failedBackup; PhpPath = $php; VerificationUrl = @('http://127.0.0.1:49249/') } | Out-Null
            } catch { $failure = $_.Exception.Message }
            if ($failure -ne 'Injected final backup ACL failure' -or -not $global:partialZipObserved) { throw "Expected failure after ZIP creation, got: $failure" }
            if ((Get-BackupSourceState $sourceStorage) -cne $before) { throw 'Failed publication changed source data' }
            if (@(Get-ChildItem -LiteralPath $failedBackup -Force).Count -ne 0) { throw 'Failed publication left a final ZIP, partial ZIP or staging directory' }
            return $global:mockSiteState -eq 'Started' -and $global:mockPoolState -eq 'Started'
        }

        foreach ($case in @(
            @{ Action = 'digest'; Error = '*hash mismatch*'; Name = 'nonempty digest mismatch' }
            @{ Action = 'missing'; Error = '*reference/size mismatch*'; Name = 'missing referenced image' }
            @{ Action = 'size'; Error = '*reference/size mismatch*'; Name = 'image size mismatch' }
            @{ Action = 'path'; Error = '*Unsafe archive path*'; Name = 'unsafe image reference path' }
            @{ Action = 'foreign-key'; Error = '*foreign key check failed*'; Name = 'database foreign-key violation' }
        )) {
            Assert-ScriptTest -Name ("Production backup rejects " + $case.Name + '; cleans artifacts, preserves source and resumes IIS') -Condition {
                $caseStorage = Join-Path $workRoot ('source-' + $case.Action)
                $caseBackup = Join-Path $workRoot ('backup-' + $case.Action)
                New-Item -ItemType Directory -Path $caseStorage, $caseBackup -Force | Out-Null
                Copy-Item -Path (Join-Path $sourceStorage '*') -Destination $caseStorage -Recurse -Force
                $caseDb = Join-Path $caseStorage 'db/data.sqlite'
                Invoke-BackupFixture $caseDb $case.Action $caseStorage | Out-Null
                $before = Get-BackupSourceState $caseStorage
                $env:NETARIUM_STORAGE_DIR = $caseStorage
                $env:NETARIUM_DB_FILE = $caseDb
                $global:mockSiteState = 'Started'; $global:mockPoolState = 'Started'
                $global:mockSiteStops = 0; $global:mockPoolStops = 0
                $failure = $null
                try {
                    Invoke-MaintenanceTestCli $backupScript @{ InstallRoot = $repoRoot; SiteName = $siteName; ApplicationPoolName = $poolName; BackupDirectory = $caseBackup; PhpPath = $php; VerificationUrl = @('http://127.0.0.1:49249/') } | Out-Null
                } catch { $failure = $_.Exception.Message }
                if (-not $failure -or $failure -notlike $case.Error) { throw "Expected $($case.Error), got: $failure" }
                if ((Get-BackupSourceState $caseStorage) -cne $before) { throw 'Rejected backup changed source data or credentials' }
                if (@(Get-ChildItem -LiteralPath $caseBackup -Force).Count -ne 0) { throw 'Rejected backup left ZIP, partial or staging artifacts' }
                return $global:mockSiteState -eq 'Started' -and $global:mockPoolState -eq 'Started' -and $global:mockSiteStops -eq 1 -and $global:mockPoolStops -eq 1
            }
        }

        Assert-ScriptTest -Name 'Production restore accepts v1.0.1 archive on candidate and rejects candidate archive on v1.0.1 before IIS stop' -Condition {
            $legacyRoot = Join-Path ([IO.Path]::GetTempPath()) ('netarium-prod-v101-' + [guid]::NewGuid().ToString('N'))
            $legacyWork = Join-Path $workRoot 'work-v101'
            $legacyBackup = Join-Path $workRoot 'backup-v101'
            New-Item -ItemType Directory -Path $legacyRoot, $legacyWork, $legacyBackup -Force | Out-Null
            try {
                $legacySource = $repoRoot
                if ($env:NETARIUM_BACKUP_V101_ROOT) { $legacySource = $env:NETARIUM_BACKUP_V101_ROOT }
                foreach ($d in @('public', 'src', 'templates', 'resources', 'scripts', 'config')) {
                    Copy-Item -LiteralPath (Join-Path $legacySource $d) -Destination (Join-Path $legacyRoot $d) -Recurse -Force
                }
                Copy-Item -LiteralPath (Join-Path $legacySource 'bootstrap.php') -Destination (Join-Path $legacyRoot 'bootstrap.php') -Force
                [IO.File]::WriteAllText((Join-Path $legacyRoot 'version.php'), "<?php`n`ndeclare(strict_types=1);`n`nconst NETARIUM_VERSION = '1.0.1';`n", (New-Object System.Text.UTF8Encoding($false)))
                if ($legacySource -ne $repoRoot) { Copy-Item -LiteralPath (Join-Path $legacySource 'version.php') -Destination (Join-Path $legacyRoot 'version.php') -Force }
                $script:compatInstallRoot = $legacyRoot
                function Get-Website {
                    param($Name, [string]$ErrorAction)
                    return [pscustomobject]@{
                        Name = $siteName
                        PhysicalPath = (Join-Path $script:compatInstallRoot 'public')
                        ApplicationPool = $poolName
                        Bindings = [pscustomobject]@{ Collection = @([pscustomobject]@{ protocol = 'http'; bindingInformation = '127.0.0.1:49249:'; sslFlags = 0; certificateHash = ''; certificateStoreName = '' }) }
                    }
                }
                $env:NETARIUM_STORAGE_DIR = $sourceStorage
                $env:NETARIUM_DB_FILE = $srcDb
                $legacyArchive = Invoke-MaintenanceTestCli (Join-Path $legacyRoot 'scripts/backup-full.ps1') @{ InstallRoot = $legacyRoot; SiteName = $siteName; ApplicationPoolName = $poolName; BackupDirectory = $legacyBackup; PhpPath = $php; VerificationUrl = @('http://127.0.0.1:49249/') }
                if (-not $legacyArchive -or -not (Test-Path -LiteralPath $legacyArchive.Archive)) { throw 'v1.0.1 archive generation failed' }

                $script:compatInstallRoot = $repoRoot
                $env:NETARIUM_STORAGE_DIR = $targetStorage
                $env:NETARIUM_DB_FILE = Join-Path $targetStorage 'db/data.sqlite'
                Set-Content -LiteralPath (Join-Path $targetStorage 'sessions/sess_101102abcdef101102abcdef101102ab') -Value 'session_before_restore'
                $restored = Invoke-MaintenanceTestCli (Join-Path $repoRoot 'scripts/restore-full.ps1') @{ InstallRoot = $repoRoot; SiteName = $siteName; ApplicationPoolName = $poolName; Archive = $legacyArchive.Archive; WorkRoot = $workRoot; PhpPath = $php; VerificationUrl = @('http://127.0.0.1:49249/') }
                if (-not $restored -or -not $restored.Restored) { throw 'v1.0.1 -> candidate restore failed' }
                Invoke-BackupFixture $env:NETARIUM_DB_FILE 'verify' $targetStorage @($srcDb, $legacyArchive.Archive, $sourceStorage) | Out-Null
                if (@(Get-ChildItem -LiteralPath (Join-Path $targetStorage 'sessions') -Force).Count -ne 0) { throw 'Restore did not clear sessions' }

                $script:compatInstallRoot = $legacyRoot
                $beforeTarget = Get-BackupSourceState $targetStorage
                Set-Content -LiteralPath (Join-Path $targetStorage 'sessions/sess_102101abcdef102101abcdef102101ab') -Value 'active_session_preserved'
                $global:mockSiteState = 'Started'; $global:mockPoolState = 'Started'
                $global:mockSiteStops = 0; $global:mockPoolStops = 0
                $failure = $null
                try {
                    Invoke-MaintenanceTestCli (Join-Path $legacyRoot 'scripts/restore-full.ps1') @{ InstallRoot = $legacyRoot; SiteName = $siteName; ApplicationPoolName = $poolName; Archive = $script:productionBackupArchive; WorkRoot = $legacyWork; PhpPath = $php; VerificationUrl = @('http://127.0.0.1:49249/') } | Out-Null
                } catch { $failure = $_.Exception.Message }
                if (-not $failure -or $failure -notlike '*Incompatible full backup manifest*') { throw "Expected incompatible manifest error, got: $failure" }
                if ($global:mockSiteStops -ne 0 -or $global:mockPoolStops -ne 0) { throw 'Preflight rejection stopped IIS' }
                if ((Get-BackupSourceState $targetStorage) -cne $beforeTarget) { throw 'Preflight rejection modified live data' }
                if (-not (Test-Path -LiteralPath (Join-Path $targetStorage 'sessions/sess_102101abcdef102101abcdef102101ab'))) { throw 'Preflight rejection deleted active session' }
                return $global:mockSiteState -eq 'Started' -and $global:mockPoolState -eq 'Started'
            } finally {
                Remove-Item -LiteralPath $legacyRoot -Recurse -Force
            }
        }
    } finally {
        $env:NETARIUM_STORAGE_DIR = $oldStorage
        $env:NETARIUM_DB_FILE = $oldDb
        Remove-Item -LiteralPath $sourceStorage -Recurse -Force
        Remove-Item -LiteralPath $targetStorage -Recurse -Force
        Remove-Item -LiteralPath $workRoot -Recurse -Force
        Remove-Item -LiteralPath $backupDir -Recurse -Force
        if (Test-Path -LiteralPath $script:maintenanceFixtureRoot) { Remove-Item -LiteralPath $script:maintenanceFixtureRoot -Recurse -Force }
    }
}

Write-Host "`nTest results: $passCount / $testCount passed."
if ($passCount -ne $testCount) {
    exit 1
}
exit 0
