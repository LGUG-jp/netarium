<?php
declare(strict_types=1);

namespace Netarium\Tests\Suites;

use Netarium\Services\Auth\AdditionalPasswordBlocklist;
use Netarium\Services\Auth\PasswordBlocklist;
use Netarium\Services\Auth\PasswordHashing;
use Netarium\Tests\TestCase;
use Netarium\Tests\TestHttpClient;

class PasswordBlocklistTest extends TestCase
{
    public function __construct(TestHttpClient $client)
    {
        require_once dirname(__DIR__, 2) . '/bootstrap.php';
    }

    public function testRealCorpusRejectsLongCommonAndLeakedValues(): void
    {
        // 固定したPWDB本文に含まれる12コードポイント以上の値。
        foreach (['q1w2e3r4t5y6', '1q2w3e4r5t6y', 'Telechargement', '123456qwerty', 'Q1W2E3R4T5Y6'] as $password) {
            $this->assertNotNull(\validatePassword($password));
        }
    }

    public function testEveryPwdbValueAndAsciiCaseVariantIsRejected(): void
    {
        $data = file_get_contents(dirname(__DIR__, 2) . '/resources/password-blocklist/pwdb-policy-top-3000.txt');
        $this->assertNotSame(false, $data);
        $lines = explode("\n", str_replace("\r\n", "\n", $data));
        $this->assertSame('', array_pop($lines));
        $this->assertCount(3000, $lines);
        foreach ($lines as $index => $password) {
            $this->assertNotNull(\validatePassword($password), 'PWDB source value ' . ($index + 1));
            $this->assertNotNull(
                \validatePassword(strtr($password, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')),
                'PWDB ASCII case variant ' . ($index + 1)
            );
        }
    }

    public function testStrongUnicodeSpacesAndSubstringsRemainAccepted(): void
    {
        foreach ([
            'cedar-lantern-orbit-74!',
            '青い空と静かな森を歩いて帰る',
            '🌲🚀🦊🎻🌙⭐🍋🧭🎨🐳🔑🪐',
            '    cedar orbit lantern    ',
            'custom-password123-river-91',
            'custom-Telechargement-river-91',
            'custom-startfinding-river-91',
            ' startfinding ',
            'operator-longname-is-one-word-of-this-phrase',
            'Netarium-is-one-word-of-this-long-phrase',
        ] as $password) {
            $this->assertNull(\validatePassword($password, 'operator-longname'));
        }
    }

    public function testWholeUnicodeAndShortUnitRepetitionIsRejected(): void
    {
        foreach ([
            str_repeat('a', 12), str_repeat('あ', 12), str_repeat('😀', 12),
            str_repeat(' ', 12), str_repeat("\t", 12), str_repeat("\n", 12),
            str_repeat('あい', 6), str_repeat('😀🌲', 6), str_repeat('abcd', 3),
            str_repeat("e\u{0301}", 6), str_repeat('Ab', 6),
            str_repeat('abcde', 3), str_repeat('こんにちは', 3),
            str_repeat('river-lantern', 2),
        ] as $password) {
            $this->assertNotNull(\validatePassword($password));
        }
    }

    public function testUsernameProductAndTypicalSuffixesAreWholeValueChecks(): void
    {
        foreach (['operator-longname', 'OPERATOR-LONGNAME', 'operator-longname123!', 'operator-longname2026', 'operator-longnameoperator-longname'] as $password) {
            $this->assertNotNull(\validatePassword($password, 'Operator-LongName'));
        }
        foreach (['Netarium2026!', 'NETARIUM12345', 'Netarium@12345', 'NetariumNetarium'] as $password) {
            $this->assertNotNull(\validatePassword($password));
        }
        $this->assertNull(\validatePassword('operator-longname-river-lantern-42', 'operator-longname'));
        $this->assertNull(\validatePassword('Netarium-cedar-lantern-42'));
    }

    public function testOriginalInputIsNotTrimmedFoldedOrNormalizedForHashing(): void
    {
        $password = "  Cedar-青い森-😀-e\u{0301}-74!  ";
        $original = $password;
        $this->assertNull(\validatePassword($password, 'cedar'));
        $hash = PasswordHashing::hash($password);
        $this->assertTrue(PasswordHashing::verify($original, $hash, false));
        $this->assertFalse(PasswordHashing::verify(trim($original), $hash, false));
        $this->assertFalse(PasswordHashing::verify(str_replace('Cedar', 'cedar', $original), $hash, false));
        $this->assertFalse(PasswordHashing::verify(str_replace("e\u{0301}", 'é', $original), $hash, false));
    }

    public function testExistingHashesAreNotSubjectToNewSettingPolicy(): void
    {
        foreach (['Telechargement', 'startfinding', 'q1w2e3r4t5y6'] as $password) {
            $this->assertNotNull(\validatePassword($password));
            $hash = PasswordHashing::hash($password);
            $this->assertTrue(PasswordHashing::verify($password, $hash, false));
            $legacy = password_hash($password, PASSWORD_BCRYPT, ['cost' => 4]);
            $this->assertTrue(PasswordHashing::verify($password, $legacy, true));
        }
    }


    public function testMissingCorruptOrInsufficientDataFailsClosed(): void
    {
        $directory = sys_get_temp_dir() . '/netarium-blocklist-' . bin2hex(random_bytes(8));
        mkdir($directory, 0700);
        $source = dirname(__DIR__, 2) . '/resources/password-blocklist';
        $strong = 'cedar-lantern-orbit-74!';
        try {
            $files = ['pwdb-metadata.json', 'pwdb-policy-top-3000.txt'];
            $this->assertFalse((new PasswordBlocklist($directory))->isAvailable());
            $this->assertNotNull((new PasswordBlocklist($directory))->check($strong));
            foreach ($files as $file) {
                copy($source . '/' . $file, $directory . '/' . $file);
            }
            $this->assertTrue((new PasswordBlocklist($directory))->isAvailable());
            $this->assertNull((new PasswordBlocklist($directory))->check($strong));
            $this->assertNotNull((new PasswordBlocklist($directory))->check('Telechargement'));
            $this->assertNotNull((new PasswordBlocklist($directory))->check('startfinding'));
            $hash = PasswordHashing::hash('startfinding');
            foreach ($files as $file) {
                unlink($directory . '/' . $file);
                $blocklist = new PasswordBlocklist($directory);
                $this->assertFalse($blocklist->isAvailable(), 'Missing ' . $file);
                $this->assertNotNull($blocklist->check($strong));
                $this->assertTrue(PasswordHashing::verify('startfinding', $hash, false));
                copy($source . '/' . $file, $directory . '/' . $file);
                $this->assertNull((new PasswordBlocklist($directory))->check($strong));
            }
            foreach (['pwdb-policy-top-3000.txt'] as $file) {
                $data = str_replace("\r\n", "\n", file_get_contents($source . '/' . $file));
                foreach ([
                    'x' . substr($data, 1),
                    "password12345\n",
                    rtrim($data, "\n"),
                    $data . "another-value-123\n",
                    str_replace("\n", "\r", $data),
                    "\xFF" . substr($data, 1),
                    "\0" . substr($data, 1),
                ] as $corrupt) {
                    file_put_contents($directory . '/' . $file, $corrupt);
                    $blocklist = new PasswordBlocklist($directory);
                    $this->assertFalse($blocklist->isAvailable(), 'Corrupt ' . $file);
                    $this->assertNotNull($blocklist->check($strong));
                }
                file_put_contents($directory . '/' . $file, str_replace("\n", "\r\n", $data));
                $this->assertNull((new PasswordBlocklist($directory))->check($strong));
                $this->assertNotNull((new PasswordBlocklist($directory))->check('STARTFINDING'));
                copy($source . '/' . $file, $directory . '/' . $file);
            }
            foreach (['pwdb-metadata.json'] as $file) {
                $metadata = json_decode(file_get_contents($source . '/' . $file), true);
                foreach (['{invalid json', 'null', '[]', '"metadata"'] as $invalid) {
                    file_put_contents($directory . '/' . $file, $invalid);
                    $this->assertNotNull((new PasswordBlocklist($directory))->check($strong));
                }
                $fields = [
                    'format_version', 'canonical_sha256', 'ascii_casefold_unique_entries',
                    'source_lines', 'license_spdx', 'license_text',
                    'source_bytes', 'bundled_bytes', 'bundled_lines', 'source_rank_cutoff',
                    'original_license_spdx', 'original_license_text', 'extraction',
                ];
                foreach ($fields as $field) {
                    $invalid = $metadata;
                    unset($invalid[$field]);
                    file_put_contents($directory . '/' . $file, json_encode($invalid));
                    $this->assertNotNull((new PasswordBlocklist($directory))->check($strong), 'Missing ' . $field);
                    foreach ([false, [], '', 'incorrect', 0, -1, 1] as $value) {
                        if ($value === $metadata[$field]) {
                            continue;
                        }
                        // The source byte count is descriptive, not the bundled size.
                        if ($field === 'source_bytes' && $value === 1) {
                            continue;
                        }
                        $invalid = $metadata;
                        $invalid[$field] = $value;
                        file_put_contents($directory . '/' . $file, json_encode($invalid));
                        $this->assertNotNull((new PasswordBlocklist($directory))->check($strong), 'Invalid ' . $field);
                    }
                }
                foreach ($metadata['extraction'] as $field => $value) {
                    $invalid = $metadata;
                    unset($invalid['extraction'][$field]);
                    file_put_contents($directory . '/' . $file, json_encode($invalid));
                    $this->assertNotNull((new PasswordBlocklist($directory))->check($strong));
                    $invalid['extraction'][$field] = is_bool($value) ? !$value : (string)$value;
                    if ($field === 'selection') {
                        $invalid['extraction'][$field] = 'last eligible values';
                    }
                    file_put_contents($directory . '/' . $file, json_encode($invalid));
                    $this->assertNotNull((new PasswordBlocklist($directory))->check($strong));
                }
                copy($source . '/' . $file, $directory . '/' . $file);
                // Test deliberate tampering or omission of copyright notice and permission terms.
                $tampered = $metadata;
                $tampered['license_text'] = "MIT License\n\nPermission is hereby granted...\n";
                file_put_contents($directory . '/' . $file, json_encode($tampered));
                $this->assertNotNull((new PasswordBlocklist($directory))->check($strong), 'Tampered license_text');
                $tampered = $metadata;
                $tampered['original_license_text'] = "MIT License\n\nCopyright (c) 2020 Other Person\n";
                file_put_contents($directory . '/' . $file, json_encode($tampered));
                $this->assertNotNull((new PasswordBlocklist($directory))->check($strong), 'Tampered original_license_text');
                copy($source . '/' . $file, $directory . '/' . $file);
                $this->assertNull((new PasswordBlocklist($directory))->check($strong));
            }
        } finally {
            foreach (['pwdb-metadata.json', 'pwdb-policy-top-3000.txt'] as $file) {
                if (is_file($directory . '/' . $file)) {
                    unlink($directory . '/' . $file);
                }
            }
            rmdir($directory);
        }
    }

    public function testDefaultLoaderUsesConfiguredStorageAndExplicitCorpusIsIsolated(): void
    {
        $storage = sys_get_temp_dir() . '/netarium-blocklist-config-' . bin2hex(random_bytes(8));
        $previous = getenv('NETARIUM_STORAGE_DIR');
        mkdir($storage . '/password-blocklist', 0700, true);
        try {
            putenv('NETARIUM_STORAGE_DIR=' . $storage);
            $this->assertTrue((new PasswordBlocklist())->isAvailable());
            file_put_contents($storage . '/password-blocklist.json', '{invalid');
            $this->assertFalse((new PasswordBlocklist())->isAvailable());
            $this->assertTrue((new PasswordBlocklist(dirname(__DIR__, 2) . '/resources/password-blocklist'))->isAvailable());
            file_put_contents($storage . '/password-blocklist.json', '{"format_version":1,"enabled":false}');
            $this->assertTrue((new PasswordBlocklist())->isAvailable());
        } finally {
            putenv($previous === false ? 'NETARIUM_STORAGE_DIR' : 'NETARIUM_STORAGE_DIR=' . $previous);
            if (is_file($storage . '/password-blocklist.json')) {
                unlink($storage . '/password-blocklist.json');
            }
            rmdir($storage . '/password-blocklist');
            rmdir($storage);
        }
    }

    public function testAdditionalDictionaryPreservesValuesAndRejectsInvalidInput(): void
    {
        $data = " Cedar-青い森-e\u{0301}-74! \nÉlan-unique-phrase\nélan-unique-phrase\n \n0\n";
        $expected = [
            " cedar-青い森-e\u{0301}-74! " => true,
            'Élan-unique-phrase' => true, 'élan-unique-phrase' => true,
            ' ' => true, 0 => true,
        ];
        $this->assertSame($expected, AdditionalPasswordBlocklist::parse($data));
        $this->assertSame($expected, AdditionalPasswordBlocklist::parse(str_replace("\n", "\r\n", $data)));
        $this->assertSame([str_repeat('😀', 128) => true], AdditionalPasswordBlocklist::parse(str_repeat('😀', 128) . "\n"));
        foreach ([
            '', "\n", "value", "value\n\n", "\xEF\xBB\xBFvalue\n", "\xFF\n",
            "value\rnext\n", "value\0next\n", "value\tnext\n", "value\x7Fnext\n",
            "value\u{0085}next\n", "Same-value\nSAME-VALUE\n",
            str_repeat('a', 129) . "\n", str_repeat('😀', 129) . "\n",
            str_repeat('x', AdditionalPasswordBlocklist::MAX_BYTES) . "\n",
        ] as $invalid) {
            $rejected = false;
            try {
                AdditionalPasswordBlocklist::parse($invalid);
            } catch (\RuntimeException) {
                $rejected = true;
            }
            $this->assertTrue($rejected, '不正な追加辞書を拒否する');
        }
        $lines = [];
        for ($i = 0; $i < AdditionalPasswordBlocklist::MAX_ENTRIES; $i++) {
            $lines[] = 'synthetic-entry-' . $i;
        }
        $maximum = implode("\n", $lines) . "\n";
        $this->assertCount(AdditionalPasswordBlocklist::MAX_ENTRIES, AdditionalPasswordBlocklist::parse($maximum));
        $rejected = false;
        try {
            AdditionalPasswordBlocklist::parse($maximum . "one-more-entry\n");
        } catch (\RuntimeException) {
            $rejected = true;
        }
        $this->assertTrue($rejected, '最大行数を超える入力を拒否する');
        // 501バイトの行と229バイトの最終行で容量上限ちょうどを作る。
        $lines = [];
        for ($i = 0; $i < 33487; $i++) {
            $lines[] = sprintf('%04x', $i) . str_repeat('😀', 124);
        }
        $lines[] = 'last' . str_repeat('😀', 56);
        $nearLimit = implode("\n", $lines) . "\n";
        $this->assertSame(AdditionalPasswordBlocklist::MAX_BYTES, strlen($nearLimit));
        $this->assertCount(count($lines), AdditionalPasswordBlocklist::parse($nearLimit));
        $rejected = false;
        try {
            AdditionalPasswordBlocklist::parse($nearLimit . "x\n");
        } catch (\RuntimeException) {
            $rejected = true;
        }
        $this->assertTrue($rejected, '本文容量の超過を拒否する');
    }

    public function testAdditionalDictionaryStatesAndIntegrityFailClosed(): void
    {
        $directory = sys_get_temp_dir() . '/netarium-additional-' . bin2hex(random_bytes(8));
        $source = dirname(__DIR__, 2) . '/resources/password-blocklist';
        $candidate = " Cedar-青い森-e\u{0301}-74! ";
        $data = $candidate . "\nSynthetic-extra-secret-74!\n";
        $hash = hash('sha256', $data);
        $body = $directory . '/dictionary-' . $hash . '.txt';
        $manifest = ['format_version' => 1, 'enabled' => true, 'sha256' => $hash, 'bytes' => strlen($data), 'entries' => 2];
        $this->assertTrue((new PasswordBlocklist($source, $directory))->isAvailable());
        mkdir($directory, 0700);
        try {
            $this->assertNull((new PasswordBlocklist($source, $directory))->check($candidate));
            file_put_contents($body, $data);
            $this->assertFalse((new PasswordBlocklist($source, $directory))->isAvailable());
            file_put_contents($directory . '.json', json_encode($manifest));
            $blocklist = new PasswordBlocklist($source, $directory);
            $this->assertTrue($blocklist->isAvailable());
            $this->assertNotNull($blocklist->check($candidate));
            $this->assertNotNull($blocklist->check(str_replace('Cedar', 'CEDAR', $candidate)));
            $this->assertNull($blocklist->check(trim($candidate)));
            $this->assertNull($blocklist->check(str_replace("e\u{0301}", 'é', $candidate)));
            $this->assertNull($blocklist->check('prefix-Synthetic-extra-secret-74!-suffix'));
            $this->assertNotNull($blocklist->check('Telechargement'));
            foreach (['{', 'null', '[]', '{"format_version":1,"enabled":"true"}'] as $invalid) {
                file_put_contents($directory . '.json', $invalid);
                $this->assertFalse((new PasswordBlocklist($source, $directory))->isAvailable());
            }
            foreach ([
                ['format_version', 2], ['enabled', 1], ['sha256', strtoupper($hash)],
                ['sha256', '../dictionary'], ['bytes', strlen($data) + 1], ['bytes', (string)strlen($data)],
                ['entries', 1], ['entries', 0], ['entries', 100001], ['bytes', 16777217],
            ] as [$key, $value]) {
                $invalid = $manifest;
                $invalid[$key] = $value;
                file_put_contents($directory . '.json', json_encode($invalid));
                $blocklist = new PasswordBlocklist($source, $directory);
                $this->assertFalse($blocklist->isAvailable());
                $this->assertNotNull($blocklist->check('cedar-lantern-orbit-74!'));
            }
            foreach (array_keys($manifest) as $key) {
                $invalid = $manifest;
                unset($invalid[$key]);
                file_put_contents($directory . '.json', json_encode($invalid));
                $this->assertFalse((new PasswordBlocklist($source, $directory))->isAvailable());
            }
            file_put_contents($directory . '.json', json_encode($manifest));
            unlink($body);
            $this->assertFalse((new PasswordBlocklist($source, $directory))->isAvailable());
            rmdir($directory);
            $this->assertFalse((new PasswordBlocklist($source, $directory))->isAvailable(), '本文領域全体の欠損を拒否する');
            mkdir($directory, 0700);
            foreach ([$data . "extra\n", str_replace('Cedar', 'cedar', $data), str_replace("\n", "\r\n", $data)] as $invalid) {
                file_put_contents($body, $invalid);
                $this->assertFalse((new PasswordBlocklist($source, $directory))->isAvailable());
            }
            // hashが一致していても、不適合本文を実行時に受理しない。
            $invalidData = "synthetic\tsecret\n";
            $invalidHash = hash('sha256', $invalidData);
            $invalidBody = $directory . '/dictionary-' . $invalidHash . '.txt';
            file_put_contents($invalidBody, $invalidData);
            file_put_contents($directory . '.json', json_encode([
                'format_version' => 1, 'enabled' => true, 'sha256' => $invalidHash,
                'bytes' => strlen($invalidData), 'entries' => 1,
            ]));
            $this->assertFalse((new PasswordBlocklist($source, $directory))->isAvailable());
            unlink($invalidBody);
            // 解除時は欠損・破損した世代本文を一切参照しない。
            unlink($body);
            file_put_contents($directory . '.json', '{"format_version":1,"enabled":false}');
            $blocklist = new PasswordBlocklist($source, $directory);
            $this->assertTrue($blocklist->isAvailable());
            $this->assertNull($blocklist->check($candidate));
            $this->assertNotNull($blocklist->check('Telechargement'));
        } finally {
            if (is_file($directory . '.json')) {
                unlink($directory . '.json');
            }
            foreach (scandir($directory) as $file) {
                if ($file !== '.' && $file !== '..') {
                    unlink($directory . '/' . $file);
                }
            }
            rmdir($directory);
        }
    }

    public function testValidationHelperReturnsOnlyCanonicalMetadata(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'netarium-dictionary-');
        $data = " Synthetic-追加-phrase-74! \nsecond-unique-phrase\n";
        try {
            foreach ([str_replace("\n", "\r\n", $data), "Synthetic\tinvalid\n"] as $index => $input) {
                file_put_contents($path, $input);
                $process = proc_open([
                    PHP_BINARY, dirname(__DIR__, 2) . '/scripts/password-blocklist.php', '--validate-file=' . $path,
                ], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
                $this->assertTrue(is_resource($process));
                fclose($pipes[0]);
                $output = stream_get_contents($pipes[1]);
                $error = stream_get_contents($pipes[2]);
                fclose($pipes[1]);
                fclose($pipes[2]);
                $this->assertSame($index, proc_close($process));
                if ($index === 0) {
                    $this->assertSame('', $error);
                    $this->assertSame([
                        'sha256' => hash('sha256', $data), 'bytes' => strlen($data), 'entries' => 2,
                    ], json_decode($output, true, 512, JSON_THROW_ON_ERROR));
                } else {
                    $this->assertSame('', $output);
                    $this->assertTrue($error !== '');
                    $this->assertFalse(str_contains($error, $input));
                }
                $this->assertSame($input, file_get_contents($path));
            }
        } finally {
            unlink($path);
        }
    }
}
