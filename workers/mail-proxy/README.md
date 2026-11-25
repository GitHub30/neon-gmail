# Neon Gmail — Cloudflare Workers IMAP/SMTP Proxy

Real TCP/TLS (`cloudflare:sockets`) IMAP4rev1 & ESMTP proxy with full CORS (`Access-Control-Allow-Origin: *`), SSRF protection, and MIME parsing/building.

## Quick Deploy

```bash
cd workers/mail-proxy
npm install
npx wrangler login
npx wrangler deploy
```

(Optional) Require a shared secret header (`X-Proxy-Token`) from your browser client:

```bash
npx wrangler secret put PROXY_AUTH_TOKEN
```

## Endpoints

| Method | Path | Query Fallback | Purpose |
|---|---|---|---|
| `GET` | `/health` | `?action=health` | Proxy health & CORS check |
| `POST` | `/api/test` | `?action=test` | Test IMAP login + list folders + measure latency |
| `POST` | `/api/imap/mailboxes` | `?action=imap_mailboxes` | List IMAP mailboxes |
| `POST` | `/api/imap/messages` | `?action=imap_messages` | Fetch paginated messages with parsed MIME |
| `POST` | `/api/imap/message` | `?action=imap_message` | Fetch single message + raw RFC822 source |
| `POST` | `/api/imap/flags` | `?action=imap_flags` | Update `\Seen`, `\Flagged`, `\Deleted` flags |
| `POST` | `/api/imap/move` | `?action=imap_move` | Move UIDs to another mailbox |
| `POST` | `/api/imap/delete` | `?action=imap_delete` | Delete & expunge UIDs |
| `POST` | `/api/smtp/send` | `?action=smtp_send` | Send RFC5322 email via SMTP (TLS 465 / STARTTLS 587) |
