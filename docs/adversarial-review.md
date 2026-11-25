# 敵対的レビュー（Adversarial Security, Protocol, UX & Accessibility Review）報告書

本プロジェクト（Neon Gmail）では、フロントエンド・Cloudflare Workers プロキシ・`proxy.php`・`proxy-node.mjs`・PWA・SEO/AEO/GEO/AIO/LLMO 全領域に対して独立した敵対的レビューを実施し、検出されたすべての Critical / High / Medium / Low 課題を修正・回帰テストで検証しました。

## 1. Critical 指摘事項と修正内容

| ID | 領域 | 指摘内容 | 実施した修正 | 検証 |
|---|---|---|---|---|
| **C1** | Cloudflare Worker (`workers/mail-proxy/src/security.ts`) | コロン含有ホスト（`127.0.0.1:6379`, `[[::1]]`, `::1%lo`）の未検証通過、および IPv6 特殊範囲（`0::1`, `::127.0.0.1`, `64:ff9b::/96`, `2002::/16`, `2001::/32`, `100::/64`）のすり抜け | 厳格な 128-bit IPv6 パーサーと完全 CIDR ブロックリスト、IPv4 TEST-NET 遮断、任意 `ALLOWED_MAIL_HOSTS` 許可リストを実装 | `tests/worker-security.test.ts` で 40+ パターン検証済 |
| **C2** | PHP Proxy (`public/proxies/proxy.php`) | PHP `filter_var` が `::ffff:127.0.0.1`・`100.64.0.0/10`・NAT64 等を許可してしまう欠陥、および DNS 解決後のホスト再解決による DNS Rebinding TOCTOU | `inet_pton()` ベースの厳密な IPv4/IPv6 バイナリ CIDR 検査へ置換し、解決済み IP へ直接接続（TLS SNI は元ホスト維持）する IP ピンニングを実装 | `tests/php-proxy.test.ts` で実 PHP サーバー検証済 |
| **C3** | Node Proxy (`public/proxies/proxy-node.mjs`) | 9 エンドポイント中 6 エンドポイント未実装、DNS TOCTOU、IPv6 不完全チェック、IMAP リテラル無制限 OOM、`0.0.0.0` デフォルト公開 | 全 9 エンドポイント＋`?action=` 完全パリティ、128-bit CIDR 検査、IP ピンニング、25MB リテラル上限、HTTP 413、デフォルト `127.0.0.1` バインドへ修正 | コード検証済 |
| **C4** | Frontend (`src/ui/Sidebar.ts`, `src/core/sanitizer.ts`, `src/core/storage.ts`) | ラベル削除ボタンの `aria-label` に `lbl.name` が未エスケープ展開され Stored XSS 可能、`lbl.color` / `avatarColor` による CSS インジェクション | `escapeHtml()` を徹底し、全インライン色指定・ラベル作成・バックアップ読込に `safeHexColor()` (`/^#[0-9a-fA-F]{6}$/`) を適用 | `tests/sanitizer.test.ts` & 静的検証済 |

## 2. High 指摘事項と修正内容

| ID | 領域 | 指摘内容 | 実施した修正 |
|---|---|---|---|
| **H1** | UX / IME (`src/ui/App.ts`, `src/ui/LoginModal.ts`) | 全体 `innerHTML` 再描画により日本語 IME 変換が中断、LoginModal メール欄 blur でクリック消失、トースト自動消去で入力中フォーム・スクロールが消失 | 永続 DOM スロット（Header/Sidebar/Main/Compose/Modal/Toast）へ分離、`compositionstart/end` 対応、LoginModal プロバイダ検出のインプレース更新化 |
| **H2** | Multi-Account (`src/core/store.ts`, `src/ui/ComposeModal.ts`) | 送信猶予中や IMAP 同期中にアカウント切替すると別アカウントのメールボックスへデータが混入 | `commitSend`・`syncActiveAccount` で `activeAccountId` を厳密照合し対象アカウント専用バケットへ保存。作成ウィンドウも `draft.accountId` 単位で分離 |
| **H3** | Tracking / Forward (`src/ui/ComposeModal.ts`, `src/ui/App.ts`, `src/core/store.ts`) | 転送時に外部画像ブロック設定を無視して画像読込、プレーンテキスト下書きの改行・`<email>` 破損 | `alwaysDisplayImages` を厳守、転送時 HTML サニタイズ、下書き表示に `plainTextToSafeHtml()` を使用 |
| **H4** | IMAP Protocol (`src/core/proxyClient.ts`, `imap.ts`, `proxy.php`) | Gmail `[Gmail]/*` フォルダ名非対応、IMAP リテラル添字ずれ、複数行 `* SEARCH` 欠落、Archive/Delete のリモート未同期、`mb_substr` 未ガード、タイムアウト後 `LOGOUT` ハング | `/api/imap/mailboxes` による `\Sent`/`\Drafts`/`\Junk`/`\Trash` 自動検出、エントリ単位リテラル紐付け、全 `* SEARCH` 収集、`UID EXPUNGE` 優先、`moveRemoteMessages`/`deleteRemoteMessages` 接続、`function_exists('mb_substr')` ガード、ソケット破損時即時クローズ |
| **H5** | SMTP & MIME (`smtp.ts`, `mime.ts`, `proxy.php`) | `535` 認証失敗時も `AUTH LOGIN` を再試行、RFC5322 特殊文字含む `From` 未クォート、Bcc のみ送信時 `To:` 空欄、75 文字超 RFC2047、RFC2231 `filename*=` 非対応 | `EHLO` 応答に応じた AUTH 分岐（`535` 再試行禁止）、RFC5322 `formatDisplayName()`、`To: undisclosed-recipients:;`、75 文字以内 RFC2047 分割、RFC2231 デコード、`EHLO [127.0.0.1]` |
| **H6** | PWA (`public/sw.js`, `vite.config.ts`) | ハッシュ付き JS バンドルがプリキャッシュされず初回オフライン復帰不可 | ビルド時に `dist/sw.js` へ生成 JS バンドルとビルドバージョンを自動注入し、オフライン 503 フォールバックを追加 |
| **H7** | Accessibility (`App.ts`, `Header.ts`, `MessageList.ts`, `ThreadView.ts`, `ShortcutsModal.ts`, `ComposeModal.ts`) | `Enter` がフォーカス中ボタンを乗っ取り、`role="menu"` 子要素違反、`<li>` 内ネストインタラクティブ要素、未ラベルラジオボタン、モーダルフォーカストラップ欠如 | `Enter` ガード、メニュー構造分離と `role="separator"`、行オープン専用 `<button class="row-open-btn">` 化、`<fieldset><legend>` + 色名 `aria-label`、モーダルフォーカストラップ＆フォーカス復帰、`.sr-only` ファイル入力化 |

## 3. Medium / Low 修正ハイライト

- **M1 添付ダウンロード安全性**: Blob MIME を `application/octet-stream` に固定し、Bidi 制御文字・パス区切りを除去する `sanitizeFilename()` と `atob()` 例外処理を追加。
- **M2 モバイルレスポンシブ**: `<=900px` での強制シングルペイン切替、`<=560px` ヘッダー最適化、最小化 Compose 高さ修正、`modal-footer` 折り返し、非表示ドロワー `inert` 付与、FAB とトーストの重なり回避。
- **M3 WCAG コントラスト**: 選択行テキスト（`#3c4043`）、ライトモードスター色（`#b86b00`）、アバター色（`#b05a00`）、ダークモード `.btn-danger`（`#2b0706`）をすべて WCAG AA 以上へ修正。
- **M4–M6 堅牢性・SEO/LLMO**: バックアップ JSON スキーマ検証＆パスワード除外エクスポート、`proxyUrl` プロトコル検証、否定検索演算子対応、`manifest.webmanifest`/`openapi.json`/`llms.txt`/`ard.json`/`docs/index.html` の整合性修正。

## 4. 最終検証スコア

- **Vitest テスト（XSS / SSRF / MIME / Search / Store / 実 PHP サーバー統合）**: 全テスト合格
- **`npm audit`**: 脆弱性 0 件
- **Lighthouse（Mobile & Desktop）**: Performance 100 / Accessibility 100 / Best Practices 100 / SEO 100 / Agentic Browsing 100
