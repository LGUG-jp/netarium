# Third-Party Notices

本ソフトウェアには、第三者により作成または再配布されたデータセットが含まれています。
該当するデータセットの著作権表示、ライセンス条件、出典および留保事項は以下のとおりです。

---

## 1. PWDB Most-Common 1M Passwords, Policy-Compatible Top 3,000（SecLists 再配布）

### 対象ファイル

- `resources/password-blocklist/pwdb-policy-top-3000.txt`
- `resources/password-blocklist/pwdb-metadata.json`

### 出典

- 原配布元：Ata Hakçıl / ignis-sec（Pwdb-Public）
  - リポジトリ：[Pwdb-Public](https://github.com/ignis-sec/Pwdb-Public)
  - 参照コミット：[対象変更](https://github.com/ignis-sec/Pwdb-Public/commit/9b53917431ed5cd57cd6cbec8c3a19cf9a5cd8dd)
  - ライセンス：[MIT License](https://github.com/ignis-sec/Pwdb-Public/blob/9b53917431ed5cd57cd6cbec8c3a19cf9a5cd8dd/LICENSE)（Copyright (c) 2020 Ata Hakçıl）
- 再配布元：Daniel Miessler（SecLists）
  - リポジトリ：[SecLists](https://github.com/danielmiessler/SecLists)
  - 参照コミット：[対象変更](https://github.com/danielmiessler/SecLists/commit/3a5f62f0e18a1b8a36b25399aff0077f3706e5af)
  - ライセンス：[MIT License](https://github.com/danielmiessler/SecLists/blob/3a5f62f0e18a1b8a36b25399aff0077f3706e5af/LICENSE)（Copyright (c) 2018 Daniel Miessler）

### 留保事項および権利範囲

- 原配布元（Ata Hakçıl）および再配布元（Daniel Miessler）の双方の MIT License 本文と著作権表示を保持しています。
- 本データセットは、過去の漏えい資格情報ダンプ（10 億件超）から出現頻度を集計した統計的コーパスに由来します。
  本ソフトウェアでは、新規パスワード設定ポリシーに適合する頻度上位 3,000 件の照合キーを抽出し、推測されやすいパスワードの登録を遮断する目的で使用しています。
  アカウントとの紐付け情報は含んでおらず、元となった過去の漏えい資格情報全体の権利や正確性を保証するものではありません。
- 変更内容：元の公開行順から、12〜128 コードポイント・512 バイト以内・NUL なしの値を走査し、ASCII 大小文字だけを同一視して重複を除去、先頭の適合 3,000 件を抽出しました。
  改行は LF に統一し、個々の採用値の編集・trim・Unicode 正規化は行っていません。
  順位・固定ハッシュ・抽出条件は `pwdb-metadata.json` に記録しています。
- 辞書は単独のパスワード値ですが、メールアドレス形式に見える値も含みます。
  アカウントとの対応情報は同梱せず、個々の値の実在性・元の意味・再識別可能性は未確認です。
  認証試行やアカウント照合には使用しません。

---

## 2. ライセンス本文

### Daniel Miessler (SecLists) - MIT License

```text
MIT License

Copyright (c) 2018 Daniel Miessler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Ata Hakçıl (Pwdb-Public) - MIT License

```text
MIT License

Copyright (c) 2020 Ata Hakçıl

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
