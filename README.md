# Neon Gmail

**Live App (GitHub Pages):** https://github30.github.io/neon-gmail/  
**Docs & FAQ:** https://github30.github.io/neon-gmail/docs/

Gmail と同じ直感的でモダンな UI を備えたブラウザ完結型 Web メールクライアント（PWA・ライト/ダークモード・モバイル完全対応・Lighthouse 全項目 100 点）。

## 主な機能

- **Gmail 互換の操作性**
  - 受信トレイのカテゴリータブ（メイン / プロモーション / ソーシャル / 新着）
  - システムフォルダ（スター付き / スヌーズ中 / 送信済み / 下書き自動保存 / 送信予定 / 重要 / すべてのメール / 迷惑メール / ゴミ箱）
  - カスタムラベル作成・色設定・複数付与・フィルタリング
  - 会話スレッド表示、インライン返信・全員に返信・転送・スマート返信、印刷表示、RFC822 生ヘッダー表示
  - ドッキング・最小化・全画面対応のリッチテキスト作成ウィンドウ、ファイル添付（MIME `multipart/mixed`）、送信取り消し（Undo Send）、送信予約
  - Gmail 高度な検索演算子（`from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, `is:starred`, `label:`, `in:`, `-除外`, `"フレーズ"`）
  - Gmail 互換キーボードショートカット（`?` で一覧表示）
  - 閲覧ペイン切替（分割なし / 右 / 下）＆表示密度切替（標準 / ゆったり / コンパクト）
- **マルチアカウントログイン＆ドロップダウン切替**
  - メールアドレス・パスワード（アプリパスワード推奨）・オプションのプロキシ URL でログインできるダイアログ
  - 主要プロバイダ（Gmail / Outlook / iCloud / Yahoo / Fastmail / Zoho / さくら / Xserver / ロリポップ / ConoHa）の IMAP/SMTP サーバー自動検出
  - 接続テスト機能（ヘルスチェック + IMAP ログイン + フォルダ取得 + レイテンシ計測）
  - 認証情報・プロキシ URL・設定・メールデータをブラウザの `localStorage` に保存
  - 画面右上のアカウントドロップダウンからワンクリックでアカウント切り替え・追加・編集・削除
- **IMAP / SMTP プロキシ接続（CORS: `Access-Control-Allow-Origin: *`）**
  - **Cloudflare Workers プロキシ** (`workers/mail-proxy/`): `cloudflare:sockets` による TLS/STARTTLS IMAP・SMTP ブリッジ
  - **PHP プロキシ** (`public/proxies/proxy.php`): PHP 8+ 単一ファイル・外部依存ゼロ（`ext-imap` / `ext-mbstring` 不要）
  - **Node.js プロキシ** (`public/proxies/proxy-node.mjs`): Node 20+ 標準モジュールのみで動作
  - プロキシ未設定でもローカル／デモモードとしてオフラインで全 UI 機能をすぐ体験可能
- **PWA・SEO・AEO・GEO・AIO・LLMO・Lighthouse 100**
  - Service Worker（ビルド済みバンドルの自動プリキャッシュ＆オフライン対応）+ `manifest.webmanifest`
  - JSON-LD `@graph` (`WebApplication`, `WebSite`, `FAQPage`, `HowTo`), `robots.txt`, `sitemap.xml`, `llms.txt`, `llms-full.txt`, `capabilities.json`, `openapi.json`, `.well-known/ai-plugin.json`, `.well-known/ard.json`
  - モバイル・デスクトップ双方で Lighthouse 全 5 カテゴリ **100 / 100 / 100 / 100 / 100**（Performance / Accessibility / Best Practices / SEO / Agentic Browsing）

## 開発・テスト・ビルド

```bash
npm install
npm run dev        # ローカル開発サーバー
npm test           # Vitest ユニットテスト & proxy.php 実ソケット統合テスト
npm run build      # 型チェック + Cloudflare Worker バンドル + Vite ビルド
```

## プロキシのデプロイ

### 1. Cloudflare Workers

```bash
cd workers/mail-proxy
npm install
npx wrangler login
npx wrangler deploy
# 任意: 共有トークン保護を有効化
npx wrangler secret put PROXY_AUTH_TOKEN
```

### 2. PHP サーバー (`proxy.php`)

`public/proxies/proxy.php` を任意の PHP 8.0+ サーバーへアップロードし、ログインダイアログの「プロキシ URL」に `https://your-domain.example/proxy.php` を入力します。

### 3. Node.js (`proxy-node.mjs`)

```bash
HOST=0.0.0.0 PORT=8787 node public/proxies/proxy-node.mjs
```

## セキュリティと敵対的レビュー

実施した敵対的レビューの全指摘事項と対策は [`docs/adversarial-review.md`](docs/adversarial-review.md) を参照してください。
