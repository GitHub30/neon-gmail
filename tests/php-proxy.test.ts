// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('proxy.php Live Integration Test (CORS + Mock IMAP + Mock SMTP + SSRF)', () => {
  let imapServer: net.Server;
  let smtpServer: net.Server;
  let imapPort = 0;
  let smtpPort = 0;
  let phpProc: ChildProcess;
  let phpProdProc: ChildProcess;
  let phpPort = 18791;
  let phpProdPort = 18792;
  let receivedSmtpData = '';
  let lastImapStoreCmd = '';

  const sampleRawEmail = [
    'From: =?UTF-8?B?6auY5qmL?= <minami@example.com>',
    'To: user@example.com',
    'Subject: =?UTF-8?B?44OG44K544OI5Lu25ZCN?=',
    'Date: Tue, 24 Nov 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('こんにちは、proxy.phpからの実IMAP受信テストです！').toString('base64'),
  ].join('\r\n');

  beforeAll(async () => {
    // Start Mock IMAP4rev1 Server
    imapServer = net.createServer((socket) => {
      socket.write('* OK Mock IMAP4rev1 Server Ready\r\n');
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        let idx: number;
        while ((idx = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const space = line.indexOf(' ');
          const tag = line.slice(0, space);
          const rest = line.slice(space + 1);
          const upper = rest.toUpperCase();

          if (upper.startsWith('LOGIN ')) {
            socket.write(`${tag} OK LOGIN completed\r\n`);
          } else if (upper.startsWith('LIST ')) {
            socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
            socket.write('* LIST (\\Sent) "/" "Sent"\r\n');
            socket.write(`${tag} OK LIST completed\r\n`);
          } else if (upper.startsWith('SELECT ')) {
            socket.write('* 1 EXISTS\r\n');
            socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
          } else if (upper.startsWith('UID SEARCH')) {
            socket.write('* SEARCH 101\r\n');
            socket.write(`${tag} OK UID SEARCH completed\r\n`);
          } else if (upper.startsWith('UID FETCH')) {
            const len = Buffer.byteLength(sampleRawEmail, 'latin1');
            socket.write(`* 1 FETCH (UID 101 FLAGS (\\Flagged) RFC822.SIZE ${len} INTERNALDATE "24-Nov-2026 10:00:00 +0000" BODY[] {${len}}\r\n${sampleRawEmail})\r\n`);
            socket.write(`${tag} OK UID FETCH completed\r\n`);
          } else if (upper.startsWith('UID STORE')) {
            lastImapStoreCmd = rest;
            socket.write(`${tag} OK UID STORE completed\r\n`);
          } else if (upper.startsWith('LOGOUT')) {
            socket.write('* BYE Logging out\r\n');
            socket.write(`${tag} OK LOGOUT completed\r\n`);
            socket.end();
          } else {
            socket.write(`${tag} OK\r\n`);
          }
        }
      });
    });

    await new Promise<void>((r) => imapServer.listen(0, '127.0.0.1', () => r()));
    imapPort = (imapServer.address() as net.AddressInfo).port;

    // Start Mock ESMTP Server
    smtpServer = net.createServer((socket) => {
      socket.write('220 mock-smtp.local ESMTP Ready\r\n');
      let buf = '';
      let inData = false;
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (inData) {
          const endIdx = buf.indexOf('\r\n.\r\n');
          if (endIdx !== -1) {
            receivedSmtpData = buf.slice(0, endIdx);
            buf = buf.slice(endIdx + 5);
            inData = false;
            socket.write('250 2.0.0 OK queued as 12345\r\n');
          }
          return;
        }
        let idx: number;
        while ((idx = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const up = line.toUpperCase();
          if (up.startsWith('EHLO')) {
            socket.write('250-mock-smtp.local\r\n250 AUTH PLAIN LOGIN\r\n');
          } else if (up.startsWith('AUTH PLAIN')) {
            socket.write('235 2.7.0 Authentication successful\r\n');
          } else if (up.startsWith('MAIL FROM:')) {
            socket.write('250 2.1.0 OK\r\n');
          } else if (up.startsWith('RCPT TO:')) {
            socket.write('250 2.1.5 OK\r\n');
          } else if (up === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            break;
          } else if (up === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        }
      });
    });

    await new Promise<void>((r) => smtpServer.listen(0, '127.0.0.1', () => r()));
    smtpPort = (smtpServer.address() as net.AddressInfo).port;

    const proxiesDir = resolve(process.cwd(), 'public/proxies');
    // Test-mode PHP server (allows local mock sockets)
    phpProc = spawn('php', ['-S', `127.0.0.1:${phpPort}`, '-t', proxiesDir], {
      env: { ...process.env, NEON_ALLOW_LOCAL_TEST: '1', NEON_ALLOW_CUSTOM_PORT: '1' },
      stdio: 'ignore',
    });
    // Production-default PHP server (verifies SSRF blocking!)
    phpProdProc = spawn('php', ['-S', `127.0.0.1:${phpProdPort}`, '-t', proxiesDir], {
      env: { ...process.env },
      stdio: 'ignore',
    });

    for (let i = 0; i < 30; i++) {
      try {
        const [r1, r2] = await Promise.all([
          fetch(`http://127.0.0.1:${phpPort}/proxy.php?action=health`),
          fetch(`http://127.0.0.1:${phpProdPort}/proxy.php?action=health`),
        ]);
        if (r1.ok && r2.ok) break;
      } catch {
        await wait(150);
      }
    }
  });

  afterAll(() => {
    phpProc?.kill();
    phpProdProc?.kill();
    imapServer?.close();
    smtpServer?.close();
  });

  it('responds to OPTIONS preflight and GET /health with Access-Control-Allow-Origin: *', async () => {
    const optRes = await fetch(`http://127.0.0.1:${phpPort}/proxy.php?action=health`, { method: 'OPTIONS' });
    expect(optRes.status).toBe(204);
    expect(optRes.headers.get('access-control-allow-origin')).toBe('*');

    const healthRes = await fetch(`http://127.0.0.1:${phpPort}/proxy.php?action=health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get('access-control-allow-origin')).toBe('*');
    const json = (await healthRes.json()) as { ok: boolean; engine: string; cors: string };
    expect(json.ok).toBe(true);
    expect(json.engine).toBe('php');
    expect(json.cors).toBe('*');
  });

  it('fetches and parses UTF-8 IMAP messages and updates flags via proxy.php', async () => {
    const res = await fetch(`http://127.0.0.1:${phpPort}/proxy.php?action=imap_messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imap: { host: '127.0.0.1', port: imapPort, tls: 'none', username: 'user@example.com', password: 'pw' },
        folder: 'INBOX',
        limit: 10,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const json = (await res.json()) as { ok: boolean; total: number; messages: Array<{ uid: number; subject: string; textBody: string; flags: string[] }> };
    expect(json.ok).toBe(true);
    expect(json.total).toBe(1);
    expect(json.messages[0]!.uid).toBe(101);
    expect(json.messages[0]!.subject).toBe('テスト件名');
    expect(json.messages[0]!.textBody).toContain('proxy.phpからの実IMAP受信テスト');
    expect(json.messages[0]!.flags).toContain('\\Flagged');

    // Update flags
    const flagRes = await fetch(`http://127.0.0.1:${phpPort}/proxy.php?action=imap_flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imap: { host: '127.0.0.1', port: imapPort, tls: 'none', username: 'user@example.com', password: 'pw' },
        folder: 'INBOX',
        uids: [101],
        op: 'add',
        flags: ['\\Seen'],
      }),
    });
    expect(flagRes.status).toBe(200);
    expect(lastImapStoreCmd).toContain('101');
    expect(lastImapStoreCmd).toContain('\\Seen');
  });

  it('sends UTF-8 email via SMTP through proxy.php', async () => {
    const res = await fetch(`http://127.0.0.1:${phpPort}/proxy.php?action=smtp_send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        smtp: { host: '127.0.0.1', port: smtpPort, tls: 'none', username: 'user@example.com', password: 'pw' },
        message: {
          fromName: 'Alex',
          fromEmail: 'user@example.com',
          to: ['dest@example.com'],
          subject: 'SMTP送信テスト',
          textBody: '本文テスト',
        },
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(receivedSmtpData).toContain('To: dest@example.com');
    expect(receivedSmtpData).toContain('Subject: =?UTF-8?B?');
  });

  it('blocks SSRF attempts including IPv4-mapped IPv6, CGNAT, and metadata in production defaults', async () => {
    for (const target of ['127.0.0.1', '169.254.169.254', 'localhost', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '100.64.0.1', '0177.0.0.1']) {
      const res = await fetch(`http://127.0.0.1:${phpProdPort}/proxy.php?action=test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imap: { host: target, port: 993, tls: 'tls', username: 'a', password: 'b' },
        }),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error.toLowerCase()).toContain('blocked');
    }
  });
});
