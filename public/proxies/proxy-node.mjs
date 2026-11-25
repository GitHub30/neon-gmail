#!/usr/bin/env node
/**
 * Neon Gmail — Standalone Zero-Dependency Node.js IMAP/SMTP CORS Proxy
 * Full 9-endpoint API parity with Cloudflare Workers proxy and proxy.php.
 *
 * Run: HOST=127.0.0.1 PORT=8787 node proxy-node.mjs
 * Optional env: PROXY_AUTH_TOKEN, ALLOW_CUSTOM_PORTS=true
 */

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const ALLOW_CUSTOM_PORTS = process.env.ALLOW_CUSTOM_PORTS === 'true';
const PROXY_AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN || '';
const ALLOWED_PORTS = new Set([143, 993, 25, 465, 587, 2525, 1143, 1025]);
const MAX_BODY = 15 * 1024 * 1024;
const MAX_LITERAL = 25 * 1024 * 1024;
const MIME_TYPE_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Token',
  'Access-Control-Max-Age': '86400',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isPrivateIPv4Octets(a, b, c) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function parseStrictIPv6(raw) {
  let s = raw;
  if (s.startsWith('[') || s.endsWith(']')) {
    if (!(s.startsWith('[') && s.endsWith(']'))) return null;
    s = s.slice(1, -1);
  }
  if (!s || s.includes('[') || s.includes(']') || s.includes('%') || !s.includes(':')) return null;
  let embedded = [];
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!net.isIPv4(tail)) return null;
    const o = tail.split('.').map(Number);
    embedded = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, lastColon);
    if (s.endsWith(':')) s += ':';
    if (!s) s = '::';
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const parseSeg = (seg) => {
    if (!seg) return [];
    const out = [];
    for (const part of seg.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  if (dbl.length === 1) {
    const g = parseSeg(dbl[0]);
    if (!g) return null;
    const all = [...g, ...embedded];
    return all.length === 8 ? all : null;
  }
  const l = parseSeg(dbl[0]);
  const r = parseSeg(dbl[1]);
  if (!l || !r || l.length + r.length + embedded.length >= 8) return null;
  return [...l, ...new Array(8 - l.length - r.length - embedded.length).fill(0), ...r, ...embedded];
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return isPrivateIPv4Octets(a, b, c);
  }
  const g = parseStrictIPv6(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIPv4Octets(g6 >> 8, g6 & 0xff, g7 >> 8);
  }
  if (g0 === 0x0064 && g1 === 0xff9b && (g2 === 0 || g2 === 1)) return true;
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0db8 || (g1 === 0x0002 && g2 === 0))) return true;
  if (g0 === 0x2002) return true;
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00) return true;
  return false;
}

async function validateHost(rawHost) {
  const host = String(rawHost || '').trim().toLowerCase();
  if (!host || host.length > 253 || /[\r\n\t\s@\\/?#%]/.test(host)) throw new Error('Invalid mail server host.');
  if (['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata.goog'].includes(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new Error('Local/internal hosts are blocked.');
  }
  if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(host) && !net.isIPv4(host)) {
    throw new Error('Obfuscated IP hostnames are blocked.');
  }
  if (host.includes(':') || host.includes('[') || host.includes(']')) {
    const clean = host.replace(/^\[|\]$/g, '');
    if (!parseStrictIPv6(host) || isPrivateIp(clean)) throw new Error('Blocked or invalid IPv6 host.');
    return { host: clean, connectHost: clean };
  }
  if (net.isIPv4(host)) {
    if (isPrivateIp(host)) throw new Error('Private IP addresses are blocked.');
    return { host, connectHost: host };
  }
  const tld = host.split('.').pop() || '';
  if (!host.includes('.') || !/[a-z]/.test(tld)) throw new Error('Invalid mail server hostname.');
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error(`Could not resolve host ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('Resolved IP is private or reserved.');
  }
  return { host, connectHost: addrs[0].address };
}

function validatePort(rawPort) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  if (!ALLOW_CUSTOM_PORTS && !ALLOWED_PORTS.has(port)) throw new Error(`Port ${port} is not allowed.`);
  return port;
}

function assertNoCrlf(v, field) {
  const s = String(v ?? '');
  if (/[\r\n\0]/.test(s)) throw new Error(`${field} must not contain CR/LF/NUL.`);
  return s;
}

function validateEmail(raw, field = 'email') {
  const s = assertNoCrlf(raw, field).trim();
  const m = s.match(/<([^<>]+)>/);
  const addr = m ? m[1] : s;
  if (!addr || addr.length > 254 || !/^[^\s@<>()[\],;:\\"]+@[^\s@<>()[\],;:\\"]+\.[^\s@<>()[\],;:\\"]+$/.test(addr)) {
    throw new Error(`Invalid email address in ${field}.`);
  }
  return addr;
}

function validateUids(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.length > 500) throw new Error('Invalid UID list.');
  return list.map((x) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n <= 0 || n > 4294967295) throw new Error('Invalid IMAP UID.');
    return n;
  });
}

function quoteImap(s) {
  assertNoCrlf(s, 'IMAP arg');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function wrapB64(b64) {
  return b64.replace(/\s+/g, '').replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');
}

function encodeRfc2047(val) {
  assertNoCrlf(val, 'header');
  if (/^[\x20-\x7e]*$/.test(val)) return val;
  const words = [];
  let buf = [];
  for (const ch of val) {
    const b = Buffer.from(ch, 'utf8');
    if (buf.length + b.length > 45 && buf.length) {
      words.push(`=?UTF-8?B?${Buffer.from(buf).toString('base64')}?=`);
      buf = [];
    }
    for (const byte of b) buf.push(byte);
  }
  if (buf.length) words.push(`=?UTF-8?B?${Buffer.from(buf).toString('base64')}?=`);
  return words.join(' ');
}

function formatDisplayName(name) {
  const t = assertNoCrlf(String(name || '').trim(), 'fromName');
  if (!t) return '';
  if (!/^[\x20-\x7e]*$/.test(t)) return encodeRfc2047(t);
  return /[()<>@,;:\\".[\]]/.test(t) ? `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : t;
}

function decodeRfc2047(val) {
  if (!val || !val.includes('=?')) return val || '';
  return val.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs, enc, txt) => {
    const buf = enc.toUpperCase() === 'B'
      ? Buffer.from(txt, 'base64')
      : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    try { return new TextDecoder(cs.toLowerCase(), { fatal: false }).decode(buf); }
    catch { return buf.toString('utf8'); }
  });
}

function parseSimpleMime(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw;
  const body = sep >= 0 ? raw.slice(sep + 4) : '';
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  const cte = (headers['content-transfer-encoding'] || '').toLowerCase();
  const decodedBody = cte === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8') : body;
  const isHtml = (headers['content-type'] || '').toLowerCase().includes('text/html');
  return {
    subject: decodeRfc2047(headers['subject'] || '(No Subject)'),
    from: decodeRfc2047(headers['from'] || ''),
    to: decodeRfc2047(headers['to'] || ''),
    cc: decodeRfc2047(headers['cc'] || ''),
    date: headers['date'] || new Date().toUTCString().replace('GMT', '+0000'),
    messageId: headers['message-id'] || '',
    inReplyTo: headers['in-reply-to'] || '',
    references: headers['references'] || '',
    textBody: isHtml ? '' : decodedBody.trim(),
    htmlBody: isHtml ? decodedBody.trim() : '',
    snippet: decodedBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180),
    attachments: [],
  };
}

function openSocket(connectHost, sniHost, port, tlsMode) {
  return new Promise((resolve, reject) => {
    const sock = tlsMode === 'tls'
      ? tls.connect({ host: connectHost, port, servername: sniHost, rejectUnauthorized: true }, () => resolve(sock))
      : net.connect({ host: connectHost, port }, () => resolve(sock));
    sock.setTimeout(20000, () => sock.destroy(new Error('Socket timeout')));
    sock.once('error', reject);
  });
}

function upgradeStartTls(sock, sniHost) {
  return new Promise((resolve, reject) => {
    const upgraded = tls.connect({ socket: sock, servername: sniHost, rejectUnauthorized: true }, () => resolve(upgraded));
    upgraded.once('error', reject);
  });
}

function createLineReader(sock) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  let closed = false;
  let err = null;
  const flush = () => {
    while (waiters.length > 0) {
      const w = waiters[0];
      if (w.type === 'line') {
        const idx = buf.indexOf('\n');
        if (idx !== -1) {
          waiters.shift();
          const end = idx > 0 && buf[idx - 1] === 0x0d ? idx - 1 : idx;
          const line = buf.subarray(0, end).toString('latin1');
          buf = buf.subarray(idx + 1);
          w.resolve(line);
          continue;
        }
      } else if (w.type === 'exact' && buf.length >= w.len) {
        waiters.shift();
        const data = buf.subarray(0, w.len).toString('latin1');
        buf = buf.subarray(w.len);
        w.resolve(data);
        continue;
      }
      if (closed || err) {
        waiters.shift();
        w.reject(err || new Error('Socket closed unexpectedly'));
        continue;
      }
      break;
    }
  };
  sock.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); flush(); });
  sock.on('close', () => { closed = true; flush(); });
  sock.on('error', (e) => { err = e; flush(); });
  return {
    readLine: () => new Promise((resolve, reject) => { waiters.push({ type: 'line', resolve, reject }); flush(); }),
    readExact: (len) => new Promise((resolve, reject) => { waiters.push({ type: 'exact', len, resolve, reject }); flush(); }),
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY) throw new HttpError(413, 'Request payload exceeds 15 MB limit.');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON payload.'); }
}

async function runImapSession(cfg, fn) {
  const { host, connectHost } = await validateHost(cfg.host);
  const port = validatePort(cfg.port || 993);
  const tlsMode = cfg.tls || (port === 993 ? 'tls' : 'starttls');
  let sock = await openSocket(connectHost, host, port, tlsMode);
  let reader = createLineReader(sock);
  let tagNum = 0;

  const cmd = async (command) => {
    const tag = `N${String(++tagNum).padStart(4, '0')}`;
    sock.write(`${tag} ${command}\r\n`);
    const entries = [];
    while (true) {
      const line = await reader.readLine();
      if (line.startsWith(`${tag} `)) {
        const st = line.slice(tag.length + 1);
        if (!st.startsWith('OK')) throw new Error(`IMAP error: ${st.slice(0, 200)}`);
        return { entries, status: st };
      }
      let full = line;
      const literals = [];
      let m = full.match(/\{(\d+)\}$/);
      while (m) {
        const size = Number(m[1]);
        if (!Number.isInteger(size) || size < 0 || size > MAX_LITERAL) throw new Error('IMAP literal out of bounds.');
        literals.push(await reader.readExact(size));
        const tail = await reader.readLine();
        full += '\n' + tail;
        m = tail.match(/\{(\d+)\}$/);
      }
      entries.push({ line: full, literals });
    }
  };

  try {
    const greeting = await reader.readLine();
    if (!greeting.startsWith('* OK')) throw new Error('Unexpected IMAP greeting');
    if (tlsMode === 'starttls') {
      await cmd('STARTTLS');
      sock = await upgradeStartTls(sock, host);
      reader = createLineReader(sock);
    }
    await cmd(`LOGIN ${quoteImap(cfg.username)} ${quoteImap(cfg.password)}`);
    return await fn(cmd, greeting);
  } finally {
    try { await cmd('LOGOUT'); } catch {}
    sock.destroy();
  }
}

function parseMailboxList(entries) {
  const out = [];
  for (const entry of entries) {
    const first = entry.line.split('\n')[0] || '';
    const m = first.match(/^\* LIST \(([^)]*)\) (?:"([^"]*)"|NIL) (?:"((?:\\.|[^"\\])*)"|\{(\d+)\}|([^\s]+))$/i);
    if (!m) continue;
    const flags = (m[1] || '').split(/\s+/).filter(Boolean);
    const name = m[4] !== undefined ? (entry.literals[0] || '') : (m[3] || m[5] || '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (name && !flags.some((f) => f.toLowerCase() === '\\noselect')) {
      out.push({ name, flags, delimiter: m[2] || '/' });
    }
  }
  return out;
}

async function runSmtpSend(cfg, msg) {
  const { host, connectHost } = await validateHost(cfg.host);
  const port = validatePort(cfg.port || 465);
  const tlsMode = cfg.tls || (port === 465 ? 'tls' : 'starttls');
  let sock = await openSocket(connectHost, host, port, tlsMode);
  let reader = createLineReader(sock);

  const readResp = async () => {
    const lines = [];
    while (true) {
      const line = await reader.readLine();
      lines.push(line);
      const m = line.match(/^(\d{3})(?:([ -]).*)?$/);
      if (!m) throw new Error('Malformed SMTP response.');
      if (m[2] !== '-') return { code: Number(m[1]), lines };
    }
  };
  const rawCmd = async (c) => { sock.write(`${c}\r\n`); return readResp(); };
  const cmd = async (c, okCodes) => {
    const r = await rawCmd(c);
    if (!okCodes.includes(r.code)) throw new Error(`SMTP error (${r.code}): ${r.lines.join(' ').slice(0, 200)}`);
    return r;
  };

  try {
    const g = await readResp();
    if (g.code !== 220) throw new Error(`Bad SMTP greeting (${g.code})`);
    let ehlo = await cmd('EHLO [127.0.0.1]', [250]);
    if (tlsMode === 'starttls') {
      await cmd('STARTTLS', [220]);
      sock = await upgradeStartTls(sock, host);
      reader = createLineReader(sock);
      ehlo = await cmd('EHLO [127.0.0.1]', [250]);
    }
    const ehloUp = ehlo.lines.join(' ').toUpperCase();
    const doLogin = async () => {
      await cmd('AUTH LOGIN', [334]);
      await cmd(Buffer.from(cfg.username).toString('base64'), [334]);
      await cmd(Buffer.from(cfg.password).toString('base64'), [235]);
    };
    if (ehloUp.includes('AUTH') && !ehloUp.includes('PLAIN') && ehloUp.includes('LOGIN')) {
      await doLogin();
    } else {
      const plain = Buffer.from(`\0${assertNoCrlf(cfg.username, 'user')}\0${assertNoCrlf(cfg.password, 'pass')}`).toString('base64');
      const r = await rawCmd(`AUTH PLAIN ${plain}`);
      if (r.code !== 235) {
        if ([500, 502, 504].includes(r.code)) await doLogin();
        else throw new Error(`SMTP auth failed (${r.code}): ${r.lines.join(' ').slice(0, 200)}`);
      }
    }

    const fromEmail = validateEmail(msg.fromEmail, 'fromEmail');
    const to = (msg.to || []).map((x) => validateEmail(x, 'to'));
    const cc = (msg.cc || []).map((x) => validateEmail(x, 'cc'));
    const bcc = (msg.bcc || []).map((x) => validateEmail(x, 'bcc'));
    const allRcpts = [...new Set([...to, ...cc, ...bcc])];
    if (!allRcpts.length) throw new Error('At least one recipient is required.');
    await cmd(`MAIL FROM:<${fromEmail}>`, [250]);
    for (const rcpt of allRcpts) await cmd(`RCPT TO:<${rcpt}>`, [250, 251]);

    await cmd('DATA', [354]);
    const bAlt = `----=_NeonNodeAlt_${crypto.randomBytes(6).toString('hex')}`;
    const bMix = `----=_NeonNodeMix_${crypto.randomBytes(6).toString('hex')}`;
    const fname = formatDisplayName(msg.fromName);
    const headers = [
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${crypto.randomBytes(8).toString('hex')}@${fromEmail.split('@')[1] || 'neon-gmail.example'}>`,
      `From: ${fname ? `${fname} <${fromEmail}>` : `<${fromEmail}>`}`,
      `To: ${to.length ? to.join(', ') : 'undisclosed-recipients:;'}`,
      ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
      `Subject: ${encodeRfc2047(msg.subject || '(No Subject)')}`,
      ...(msg.inReplyTo ? [`In-Reply-To: ${assertNoCrlf(msg.inReplyTo, 'inReplyTo')}`] : []),
      ...(msg.references ? [`References: ${assertNoCrlf(msg.references, 'references')}`] : []),
      'MIME-Version: 1.0',
      'X-Mailer: Neon Gmail Node Proxy/1.0',
    ];
    const txtB64 = wrapB64(Buffer.from(String(msg.textBody || ''), 'utf8').toString('base64'));
    const hasHtml = Boolean(msg.htmlBody && String(msg.htmlBody).trim());
    const innerCt = hasHtml
      ? `multipart/alternative; boundary="${bAlt}"`
      : 'text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64';
    const innerBody = hasHtml
      ? [
          `--${bAlt}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', txtB64,
          `--${bAlt}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
          wrapB64(Buffer.from(String(msg.htmlBody), 'utf8').toString('base64')),
          `--${bAlt}--`,
        ].join('\r\n')
      : txtB64;

    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    let raw;
    if (!atts.length) {
      headers.push(`Content-Type: ${innerCt}`);
      raw = `${headers.join('\r\n')}\r\n\r\n${innerBody}\r\n`;
    } else {
      headers.push(`Content-Type: multipart/mixed; boundary="${bMix}"`);
      const parts = [`--${bMix}\r\nContent-Type: ${innerCt}\r\n\r\n${innerBody}`];
      for (const att of atts) {
        const safeName = encodeRfc2047(assertNoCrlf(att.filename || 'file.bin', 'filename').replace(/["\\]/g, '_'));
        const rt = assertNoCrlf(att.contentType || 'application/octet-stream', 'contentType').trim();
        const ct = MIME_TYPE_RE.test(rt) ? rt : 'application/octet-stream';
        parts.push(
          `--${bMix}\r\nContent-Type: ${ct}; name="${safeName}"\r\nContent-Disposition: attachment; filename="${safeName}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapB64(String(att.dataBase64 || ''))}`,
        );
      }
      parts.push(`--${bMix}--`);
      raw = `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`;
    }

    sock.write(raw.replace(/(^|\r\n)\./g, '$1..') + '\r\n.\r\n');
    const dr = await readResp();
    if (dr.code !== 250) throw new Error(`DATA failed (${dr.code})`);
    try { await cmd('QUIT', [221, 250]); } catch {}
    return { ok: true, serverResponse: dr.lines.join(' ') };
  } finally {
    sock.destroy();
  }
}

function resolveRoute(url) {
  const action = url.searchParams.get('action');
  const map = {
    health: '/health',
    test: '/api/test',
    imap_mailboxes: '/api/imap/mailboxes',
    imap_messages: '/api/imap/messages',
    imap_message: '/api/imap/message',
    imap_flags: '/api/imap/flags',
    imap_move: '/api/imap/move',
    imap_delete: '/api/imap/delete',
    smtp_send: '/api/smtp/send',
  };
  if (action && map[action]) return map[action];
  return url.pathname.replace(/\/+$/, '') || '/';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  let route = '/';
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    route = resolveRoute(url);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Malformed request URL.' });
  }

  if (req.method === 'GET' && (route === '/' || route === '/health')) {
    return sendJson(res, 200, { ok: true, service: 'neon-gmail-proxy', engine: 'node', protocols: ['imap', 'smtp'], cors: '*', version: '1.0.0' });
  }
  if (PROXY_AUTH_TOKEN) {
    const provided = String(req.headers['x-proxy-token'] || '');
    const a = Buffer.from(provided);
    const b = Buffer.from(PROXY_AUTH_TOKEN);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed. Use POST.' });

  try {
    const body = await readBody(req);
    if (route === '/api/test') {
      const started = Date.now();
      const data = await runImapSession(body.imap, async (cmd, greeting) => {
        const list = await cmd('LIST "" "*"');
        return { greeting, mailboxes: parseMailboxList(list.entries), latencyMs: Date.now() - started };
      });
      return sendJson(res, 200, { ok: true, ...data });
    }
    if (route === '/api/imap/mailboxes') {
      const mailboxes = await runImapSession(body.imap, async (cmd) => parseMailboxList((await cmd('LIST "" "*"')).entries));
      return sendJson(res, 200, { ok: true, mailboxes });
    }
    if (route === '/api/imap/messages') {
      const data = await runImapSession(body.imap, async (cmd) => {
        await cmd(`SELECT ${quoteImap(body.folder || 'INBOX')}`);
        const s = await cmd('UID SEARCH ALL');
        const uids = [];
        for (const e of s.entries) {
          if (!e.line.startsWith('* SEARCH')) continue;
          uids.push(...e.line.replace(/^\* SEARCH\s*/, '').trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => n > 0));
        }
        const total = uids.length;
        if (!total) return { total: 0, messages: [] };
        const limit = Math.min(Math.max(1, Number(body.limit) || 30), 60);
        const page = Math.max(1, Number(body.page) || 1);
        const pageUids = [...uids].reverse().slice((page - 1) * limit, page * limit);
        if (!pageUids.length) return { total, messages: [] };
        const f = await cmd(`UID FETCH ${pageUids.join(',')} (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])`);
        const messages = [];
        for (const e of f.entries) {
          if (!/^\* \d+ FETCH /i.test(e.line)) continue;
          const uid = Number((e.line.match(/\bUID (\d+)/i) || [])[1] || 0);
          const flags = ((e.line.match(/\bFLAGS \(([^)]*)\)/i) || [])[1] || '').split(/\s+/).filter(Boolean);
          const size = Number((e.line.match(/\bRFC822\.SIZE (\d+)/i) || [])[1] || 0);
          const internalDate = (e.line.match(/\bINTERNALDATE "([^"]+)"/i) || [])[1] || '';
          const raw = e.literals.reduce((best, cur) => (cur.length >= best.length ? cur : best), '');
          messages.push({ uid, flags, size: size || raw.length, internalDate, ...parseSimpleMime(raw) });
        }
        messages.sort((a, b) => b.uid - a.uid);
        return { total, messages };
      });
      return sendJson(res, 200, { ok: true, ...data });
    }
    if (route === '/api/imap/message') {
      const [uid] = validateUids([body.uid]);
      const message = await runImapSession(body.imap, async (cmd) => {
        await cmd(`SELECT ${quoteImap(body.folder || 'INBOX')}`);
        const f = await cmd(`UID FETCH ${uid} (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])`);
        const e = f.entries.find((x) => /^\* \d+ FETCH /i.test(x.line));
        if (!e) return null;
        const raw = e.literals.reduce((best, cur) => (cur.length >= best.length ? cur : best), '');
        const flags = ((e.line.match(/\bFLAGS \(([^)]*)\)/i) || [])[1] || '').split(/\s+/).filter(Boolean);
        const size = Number((e.line.match(/\bRFC822\.SIZE (\d+)/i) || [])[1] || raw.length);
        const internalDate = (e.line.match(/\bINTERNALDATE "([^"]+)"/i) || [])[1] || '';
        return { uid, flags, size, internalDate, ...parseSimpleMime(raw), raw };
      });
      if (!message) return sendJson(res, 404, { ok: false, error: 'Message not found.' });
      return sendJson(res, 200, { ok: true, message });
    }
    if (route === '/api/imap/flags') {
      const allowed = new Set(['\\Seen', '\\Flagged', '\\Answered', '\\Draft', '\\Deleted']);
      const flags = (body.flags || []).filter((f) => allowed.has(f));
      const uids = validateUids(body.uids);
      if (!flags.length) throw new Error('No valid IMAP flags.');
      await runImapSession(body.imap, async (cmd) => {
        await cmd(`SELECT ${quoteImap(body.folder || 'INBOX')}`);
        const mode = body.op === 'remove' ? '-FLAGS.SILENT' : '+FLAGS.SILENT';
        await cmd(`UID STORE ${uids.join(',')} ${mode} (${flags.join(' ')})`);
      });
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/api/imap/move') {
      const uids = validateUids(body.uids);
      const target = assertNoCrlf(String(body.targetFolder || '').trim(), 'targetFolder');
      if (!target) throw new Error('targetFolder must not be empty.');
      await runImapSession(body.imap, async (cmd) => {
        await cmd(`SELECT ${quoteImap(body.folder || 'INBOX')}`);
        const set = uids.join(',');
        try {
          await cmd(`UID MOVE ${set} ${quoteImap(target)}`);
        } catch {
          await cmd(`UID COPY ${set} ${quoteImap(target)}`);
          await cmd(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
          try { await cmd(`UID EXPUNGE ${set}`); } catch { await cmd('EXPUNGE'); }
        }
      });
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/api/imap/delete') {
      const uids = validateUids(body.uids);
      await runImapSession(body.imap, async (cmd) => {
        await cmd(`SELECT ${quoteImap(body.folder || 'INBOX')}`);
        const set = uids.join(',');
        await cmd(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
        if (body.expunge !== false) {
          try { await cmd(`UID EXPUNGE ${set}`); } catch { await cmd('EXPUNGE'); }
        }
      });
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/api/smtp/send') {
      return sendJson(res, 200, await runSmtpSend(body.smtp, body.message));
    }
    return sendJson(res, 404, { ok: false, error: `Unknown route: ${route}` });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400;
    return sendJson(res, status, { ok: false, error: String(err?.message || err).slice(0, 300) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Neon Gmail Node proxy listening on http://${HOST}:${PORT}`);
});
