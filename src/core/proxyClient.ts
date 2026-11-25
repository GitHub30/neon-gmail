import type { MailAccount, MailAttachment, MailMessage, ProxyType, SystemFolder } from '../types/mail.ts';

export interface ProxyHealthResult {
  ok: boolean;
  engine?: string;
  protocols?: string[];
  cors?: string;
  error?: string;
}

export interface ImapMailboxMeta {
  name: string;
  flags?: string[];
  delimiter?: string;
}

export interface ProxyTestResult {
  ok: boolean;
  greeting?: string;
  mailboxes?: ImapMailboxMeta[];
  latencyMs?: number;
  error?: string;
}

interface RemoteFetchedMessage {
  uid: number;
  flags: string[];
  size: number;
  internalDate: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  messageId: string;
  inReplyTo: string;
  references: string;
  textBody: string;
  htmlBody: string;
  snippet: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
    dataBase64?: string;
  }>;
}

// Per-account discovered IMAP special-use folder names (handles Gmail [Gmail]/*, iCloud, Dovecot, etc.)
const discoveredFoldersCache = new Map<string, Partial<Record<SystemFolder, string>>>();

export function validateProxyUrl(proxyUrl: string): URL {
  const trimmed = proxyUrl.trim();
  if (!trimmed) throw new Error('Proxy URL is empty.');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Proxy URL must be a valid https:// or http:// URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Proxy URL must use https:// or http:// protocol.');
  }
  return parsed;
}

function buildEndpointUrl(proxyUrl: string, proxyType: ProxyType, path: string, action: string): string {
  const parsed = validateProxyUrl(proxyUrl);
  const trimmed = parsed.toString().replace(/\/+$/, '');
  const useQueryAction = proxyType === 'php' || parsed.pathname.toLowerCase().endsWith('.php');
  if (useQueryAction) {
    const sep = trimmed.includes('?') ? '&' : '?';
    return `${trimmed}${sep}action=${encodeURIComponent(action)}`;
  }
  return `${trimmed}${path}`;
}

async function requestProxy<T>(
  proxyUrl: string,
  proxyType: ProxyType,
  proxyToken: string,
  path: string,
  action: string,
  method: 'GET' | 'POST',
  payload?: unknown,
  timeoutMs = 25000,
): Promise<T> {
  const url = buildEndpointUrl(proxyUrl, proxyType, path, action);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {};
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  if (proxyToken.trim()) headers['X-Proxy-Token'] = proxyToken.trim();

  try {
    const res = await fetch(url, {
      method,
      mode: 'cors',
      headers,
      body: method === 'POST' ? JSON.stringify(payload ?? {}) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Proxy returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
    }
    if (!res.ok || parsed.ok === false) {
      throw new Error(String(parsed.error || `Proxy HTTP ${res.status}`));
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Proxy request timed out. Check your proxy URL and mail server port.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function imapPayload(account: MailAccount) {
  return {
    host: account.server.imapHost,
    port: account.server.imapPort,
    tls: account.server.imapTls,
    username: account.email,
    password: account.password,
  };
}

function smtpPayload(account: MailAccount) {
  return {
    host: account.server.smtpHost,
    port: account.server.smtpPort,
    tls: account.server.smtpTls,
    username: account.email,
    password: account.password,
  };
}

function parseAddressString(raw: string): { name: string; email: string } {
  const m = raw.match(/^(.*?)\s*<([^<>]+)>$/);
  if (m) {
    const name = (m[1] ?? '').trim().replace(/^["']|["']$/g, '');
    const email = (m[2] ?? '').trim();
    return { name: name || email, email };
  }
  const clean = raw.trim();
  return { name: clean || 'Unknown', email: clean || 'unknown@invalid' };
}

function detectSpecialFolders(mailboxes: ImapMailboxMeta[]): Partial<Record<SystemFolder, string>> {
  const map: Partial<Record<SystemFolder, string>> = { inbox: 'INBOX' };
  for (const mb of mailboxes) {
    const flags = (mb.flags ?? []).map((f) => f.toLowerCase());
    const low = mb.name.toLowerCase();
    if (flags.includes('\\sent') || (!map.sent && (low === 'sent' || low === 'sent messages' || low.endsWith('/sent mail')))) {
      map.sent = mb.name;
    }
    if (flags.includes('\\drafts') || (!map.drafts && (low === 'drafts' || low.endsWith('/drafts')))) {
      map.drafts = mb.name;
    }
    if (flags.includes('\\junk') || (!map.spam && (low === 'junk' || low === 'spam' || low.endsWith('/spam')))) {
      map.spam = mb.name;
    }
    if (flags.includes('\\trash') || (!map.trash && (low === 'trash' || low === 'deleted messages' || low.endsWith('/trash')))) {
      map.trash = mb.name;
    }
    if (flags.includes('\\all') || flags.includes('\\archive') || (!map.all && (low === 'archive' || low.endsWith('/all mail')))) {
      map.all = mb.name;
    }
  }
  return map;
}

async function resolveImapFolder(account: MailAccount, folder: SystemFolder): Promise<string> {
  if (folder === 'inbox') return 'INBOX';
  let cached = discoveredFoldersCache.get(account.id);
  if (!cached) {
    try {
      const res = await requestProxy<{ ok: true; mailboxes: ImapMailboxMeta[] }>(
        account.proxyUrl,
        account.proxyType,
        account.proxyToken,
        '/api/imap/mailboxes',
        'imap_mailboxes',
        'POST',
        { imap: imapPayload(account) },
        12000,
      );
      cached = detectSpecialFolders(res.mailboxes ?? []);
      discoveredFoldersCache.set(account.id, cached);
    } catch {
      cached = {};
    }
  }
  if (cached[folder]) return cached[folder]!;
  switch (folder) {
    case 'sent': return 'Sent';
    case 'drafts': return 'Drafts';
    case 'spam': return 'Junk';
    case 'trash': return 'Trash';
    case 'all': return 'Archive';
    default: return 'INBOX';
  }
}

function normalizeSubjectForThread(subject: string): string {
  return subject.replace(/^(?:\s*(?:re|fwd|fw)\s*:\s*)+/i, '').trim().toLowerCase();
}

function computeThreadKey(m: RemoteFetchedMessage): string {
  const refRoot = m.references?.trim().split(/\s+/)[0] || m.inReplyTo?.trim();
  if (refRoot) {
    return `thr-ref-${refRoot.replace(/[^a-z0-9@._-]+/gi, '').slice(0, 64)}`;
  }
  const norm = normalizeSubjectForThread(m.subject || '');
  if (!norm || norm === '(no subject)') {
    return `thr-uid-${m.uid}`;
  }
  return `thr-sub-${norm.replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]+/gi, '-').slice(0, 48)}`;
}

export interface DnsPtrResult {
  domain: string;
  aRecords: string[];
  ptrHosts: string[];
  primaryHost: string | null;
}

export interface PtrFallbackTestOutcome {
  ok: boolean;
  result?: ProxyTestResult;
  usedPtrFallback: boolean;
  server: MailAccount['server'];
  aRecords: string[];
  ptrHost?: string;
  initialError?: string;
  ptrError?: string;
}

interface DohJsonResponse {
  Answer?: Array<{ type?: number; data?: string }>;
}

function isPublicIpv4(ip: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return false;
  const o = ip.split('.').map(Number);
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = o as [number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

async function queryBrowserDoh(name: string, type: 'A' | 'PTR'): Promise<string[]> {
  const endpoints = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
  ];
  const expectedType = type === 'A' ? 1 : 12;

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(endpoint, {
        headers: { Accept: 'application/dns-json' },
        mode: 'cors',
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const data = (await res.json()) as DohJsonResponse;
      if (!Array.isArray(data.Answer)) continue;
      const values = data.Answer
        .filter((ans) => ans.type === expectedType && typeof ans.data === 'string')
        .map((ans) => ans.data!.trim())
        .filter(Boolean);
      if (values.length > 0) return values;
    } catch {
      // try next resolver
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

export async function resolveDomainPtrHosts(
  emailOrDomain: string,
  proxyUrl?: string,
  proxyType: ProxyType = 'cloudflare',
  proxyToken = '',
): Promise<DnsPtrResult> {
  const domain = emailOrDomain.trim().toLowerCase().replace(/^.*@/, '').replace(/\.$/, '');
  if (!domain || !domain.includes('.')) {
    return { domain, aRecords: [], ptrHosts: [], primaryHost: null };
  }

  // 1) Try proxy /api/dns/ptr first (avoids browser DoH blocks on restrictive networks)
  if (proxyUrl && proxyUrl.trim()) {
    try {
      const res = await requestProxy<{ ok: true } & DnsPtrResult>(
        proxyUrl,
        proxyType,
        proxyToken,
        '/api/dns/ptr',
        'dns_ptr',
        'POST',
        { domain },
        10000,
      );
      if (Array.isArray(res.aRecords) && (res.ptrHosts?.length > 0 || res.aRecords.length > 0)) {
        return {
          domain: res.domain || domain,
          aRecords: res.aRecords,
          ptrHosts: res.ptrHosts ?? [],
          primaryHost: res.primaryHost ?? res.ptrHosts?.[0] ?? null,
        };
      }
    } catch {
      // fall back to direct browser DoH (supports older/custom proxies without /api/dns/ptr)
    }
  }

  // 2) Direct DNS-over-HTTPS fallback: A record -> reverse IP -> PTR record
  const rawAs = await queryBrowserDoh(domain, 'A');
  const aRecords = [...new Set(rawAs.filter(isPublicIpv4))];
  const ptrHosts: string[] = [];

  for (const ip of aRecords.slice(0, 5)) {
    const arpa = `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
    const ptrs = await queryBrowserDoh(arpa, 'PTR');
    for (const raw of ptrs) {
      const clean = raw.replace(/\.$/, '').trim().toLowerCase();
      if (clean && clean.includes('.') && !ptrHosts.includes(clean)) {
        ptrHosts.push(clean);
      }
    }
  }

  return {
    domain,
    aRecords,
    ptrHosts,
    primaryHost: ptrHosts[0] ?? null,
  };
}

export async function checkProxyHealth(proxyUrl: string, proxyType: ProxyType, proxyToken = ''): Promise<ProxyHealthResult> {
  return requestProxy<ProxyHealthResult>(proxyUrl, proxyType, proxyToken, '/health', 'health', 'GET', undefined, 10000);
}

export async function testAccountConnection(account: MailAccount): Promise<ProxyTestResult> {
  const res = await requestProxy<ProxyTestResult>(
    account.proxyUrl,
    account.proxyType,
    account.proxyToken,
    '/api/test',
    'test',
    'POST',
    { imap: imapPayload(account) },
  );
  if (Array.isArray(res.mailboxes)) {
    discoveredFoldersCache.set(account.id, detectSpecialFolders(res.mailboxes));
  }
  return res;
}

export async function testAccountConnectionWithPtrFallback(
  account: MailAccount,
  onProgress?: (stage: 'initial' | 'dns' | 'ptr_test', detail?: string) => void,
): Promise<PtrFallbackTestOutcome> {
  onProgress?.('initial', account.server.imapHost);
  try {
    const result = await testAccountConnection(account);
    return {
      ok: true,
      result,
      usedPtrFallback: false,
      server: account.server,
      aRecords: [],
    };
  } catch (err) {
    const initialError = err instanceof Error ? err.message : String(err);
    const domain = account.email.trim().toLowerCase().split('@')[1] ?? '';
    if (!domain || !domain.includes('.')) {
      return { ok: false, usedPtrFallback: false, server: account.server, aRecords: [], initialError };
    }

    onProgress?.('dns', domain);
    const dnsRes = await resolveDomainPtrHosts(domain, account.proxyUrl, account.proxyType, account.proxyToken);
    const candidates = dnsRes.ptrHosts.filter(
      (h) => h.toLowerCase() !== account.server.imapHost.trim().toLowerCase(),
    );

    let lastPtrHost: string | undefined;
    let lastPtrError: string | undefined;

    for (const ptrHost of candidates.slice(0, 3)) {
      const candidateServer = {
        ...account.server,
        imapHost: ptrHost,
        smtpHost: ptrHost,
      };
      lastPtrHost = ptrHost;
      onProgress?.('ptr_test', ptrHost);
      try {
        const result = await testAccountConnection({ ...account, server: candidateServer });
        return {
          ok: true,
          result,
          usedPtrFallback: true,
          server: candidateServer,
          aRecords: dnsRes.aRecords,
          ptrHost,
          initialError,
        };
      } catch (ptrErr) {
        lastPtrError = ptrErr instanceof Error ? ptrErr.message : String(ptrErr);
      }
    }

    return {
      ok: false,
      usedPtrFallback: false,
      server: lastPtrHost ? { ...account.server, imapHost: lastPtrHost, smtpHost: lastPtrHost } : account.server,
      aRecords: dnsRes.aRecords,
      ptrHost: lastPtrHost,
      initialError,
      ptrError: lastPtrError,
    };
  }
}

export async function fetchRemoteMessages(
  account: MailAccount,
  folder: SystemFolder = 'inbox',
  limit = 25,
  page = 1,
): Promise<{ total: number; messages: MailMessage[] }> {
  const imapFolder = await resolveImapFolder(account, folder);
  const res = await requestProxy<{ ok: true; total: number; messages: RemoteFetchedMessage[] }>(
    account.proxyUrl,
    account.proxyType,
    account.proxyToken,
    '/api/imap/messages',
    'imap_messages',
    'POST',
    { imap: imapPayload(account), folder: imapFolder, limit, page },
  );

  const messages: MailMessage[] = (res.messages ?? []).map((m) => {
    const sender = parseAddressString(m.from);
    const flagsLower = (m.flags ?? []).map((f) => f.toLowerCase());
    const parsedDate = Number.isNaN(Date.parse(m.date)) ? new Date().toISOString() : new Date(m.date).toISOString();

    return {
      id: `imap-${account.id}-${imapFolder}-${m.uid}`,
      uid: m.uid,
      threadId: computeThreadKey(m),
      accountId: account.id,
      fromName: sender.name,
      fromEmail: sender.email,
      to: m.to ? m.to.split(',').map((s) => s.trim()).filter(Boolean) : [account.email],
      cc: m.cc ? m.cc.split(',').map((s) => s.trim()).filter(Boolean) : [],
      subject: m.subject || '(No Subject)',
      snippet: m.snippet || m.textBody.slice(0, 160),
      textBody: m.textBody || '',
      htmlBody: m.htmlBody || undefined,
      date: parsedDate,
      isRead: flagsLower.includes('\\seen'),
      isStarred: flagsLower.includes('\\flagged'),
      isImportant: false,
      folder,
      category: 'primary',
      labels: [],
      attachments: (m.attachments ?? []).map((a, idx) => ({
        id: `att-${m.uid}-${idx}`,
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        dataBase64: a.dataBase64,
      })),
      messageId: m.messageId || undefined,
      inReplyTo: m.inReplyTo || undefined,
    };
  });

  return { total: res.total ?? messages.length, messages };
}

export async function syncRemoteFlags(
  account: MailAccount,
  folder: SystemFolder,
  uids: number[],
  op: 'add' | 'remove',
  flags: string[],
): Promise<void> {
  if (!account.proxyUrl.trim() || uids.length === 0) return;
  const imapFolder = await resolveImapFolder(account, folder);
  await requestProxy(
    account.proxyUrl,
    account.proxyType,
    account.proxyToken,
    '/api/imap/flags',
    'imap_flags',
    'POST',
    { imap: imapPayload(account), folder: imapFolder, uids, op, flags },
  );
}

export async function moveRemoteMessages(
  account: MailAccount,
  sourceFolder: SystemFolder,
  uids: number[],
  targetFolder: SystemFolder,
): Promise<void> {
  if (!account.proxyUrl.trim() || uids.length === 0) return;
  const [src, dst] = await Promise.all([
    resolveImapFolder(account, sourceFolder),
    resolveImapFolder(account, targetFolder),
  ]);
  if (src === dst) return;
  await requestProxy(
    account.proxyUrl,
    account.proxyType,
    account.proxyToken,
    '/api/imap/move',
    'imap_move',
    'POST',
    { imap: imapPayload(account), folder: src, uids, targetFolder: dst },
  );
}

export async function deleteRemoteMessages(
  account: MailAccount,
  folder: SystemFolder,
  uids: number[],
): Promise<void> {
  if (!account.proxyUrl.trim() || uids.length === 0) return;
  const imapFolder = await resolveImapFolder(account, folder);
  await requestProxy(
    account.proxyUrl,
    account.proxyType,
    account.proxyToken,
    '/api/imap/delete',
    'imap_delete',
    'POST',
    { imap: imapPayload(account), folder: imapFolder, uids, expunge: true },
  );
}

export async function sendRemoteEmail(
  account: MailAccount,
  email: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    textBody: string;
    htmlBody?: string;
    inReplyTo?: string;
    attachments?: MailAttachment[];
  },
): Promise<{ ok: true; serverResponse?: string }> {
  return requestProxy<{ ok: true; serverResponse?: string }>(
    account.proxyUrl,
    account.proxyType,
    account.proxyToken,
    '/api/smtp/send',
    'smtp_send',
    'POST',
    {
      smtp: smtpPayload(account),
      message: {
        fromName: account.displayName,
        fromEmail: account.email,
        to: email.to,
        cc: email.cc,
        bcc: email.bcc,
        subject: email.subject,
        textBody: email.textBody,
        htmlBody: email.htmlBody,
        inReplyTo: email.inReplyTo,
        attachments: (email.attachments ?? [])
          .filter((a) => Boolean(a.dataBase64))
          .map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            dataBase64: a.dataBase64!,
          })),
      },
    },
  );
}
