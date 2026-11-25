import { ImapClient, type ImapConfig } from './imap.ts';
import { sendSmtpEmail, type SmtpConfig } from './smtp.ts';
import type { OutgoingEmail } from './mime.ts';
import {
  buildCorsHeaders,
  isPrivateIPv4,
  sanitizeErrorMessage,
  timingSafeEqual,
  validateMailHost,
} from './security.ts';

export interface Env {
  PROXY_AUTH_TOKEN?: string;
  ALLOW_CUSTOM_PORTS?: string;
  ALLOWED_MAIL_HOSTS?: string;
}

const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15 MB

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(data: unknown, status = 200, request?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...buildCorsHeaders(request),
    },
  });
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request payload exceeds 15 MB limit.');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request payload exceeds 15 MB limit.');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON payload.');
  }
}

interface DohResponse {
  Status?: number;
  Answer?: Array<{ name?: string; type?: number; data?: string }>;
}

async function queryDoh(name: string, type: 'A' | 'PTR'): Promise<string[]> {
  const endpoints = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
  ];
  const expectedTypeNum = type === 'A' ? 1 : 12;

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        headers: { Accept: 'application/dns-json' },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as DohResponse;
      if (!Array.isArray(data.Answer)) continue;
      const values = data.Answer
        .filter((a) => a.type === expectedTypeNum && typeof a.data === 'string')
        .map((a) => a.data!.trim())
        .filter(Boolean);
      if (values.length > 0) return values;
    } catch {
      // try next DoH resolver
    }
  }
  return [];
}

async function resolveDomainAToPtr(
  rawDomain: string,
  allowedHosts?: Set<string>,
): Promise<{ domain: string; aRecords: string[]; ptrHosts: string[]; primaryHost: string | null }> {
  const cleaned = rawDomain.trim().toLowerCase().replace(/^.*@/, '').replace(/\.$/, '');
  const domain = validateMailHost(cleaned);
  const rawAs = await queryDoh(domain, 'A');

  const aRecords: string[] = [];
  for (const ip of rawAs) {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) continue;
    const octets = ip.split('.').map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) continue;
    if (isPrivateIPv4(octets)) continue;
    if (!aRecords.includes(ip)) aRecords.push(ip);
  }

  const ptrHosts: string[] = [];
  for (const ip of aRecords.slice(0, 5)) {
    const arpa = `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
    const ptrs = await queryDoh(arpa, 'PTR');
    for (const rawPtr of ptrs) {
      const candidate = rawPtr.replace(/\.$/, '').trim().toLowerCase();
      if (!candidate) continue;
      try {
        const safeHost = validateMailHost(candidate, allowedHosts);
        if (!ptrHosts.includes(safeHost)) ptrHosts.push(safeHost);
      } catch {
        // skip blocked/invalid PTR targets
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

function resolveRoute(url: URL): string {
  const action = url.searchParams.get('action');
  if (action) {
    const map: Record<string, string> = {
      health: '/health',
      test: '/api/test',
      dns_ptr: '/api/dns/ptr',
      imap_mailboxes: '/api/imap/mailboxes',
      imap_messages: '/api/imap/messages',
      imap_message: '/api/imap/message',
      imap_flags: '/api/imap/flags',
      imap_move: '/api/imap/move',
      imap_delete: '/api/imap/delete',
      smtp_send: '/api/smtp/send',
    };
    if (map[action]) return map[action]!;
  }
  return url.pathname.replace(/\/+$/, '') || '/';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: buildCorsHeaders(request) });
      }

      const url = new URL(request.url);
      const route = resolveRoute(url);

      if (request.method === 'GET' && (route === '/' || route === '/health')) {
        return jsonResponse(
          {
            ok: true,
            service: 'neon-gmail-proxy',
            engine: 'cloudflare-workers',
            protocols: ['imap', 'smtp', 'dns-ptr'],
            cors: '*',
            version: '1.1.0',
          },
          200,
          request,
        );
      }

      if (env.PROXY_AUTH_TOKEN) {
        const provided = request.headers.get('X-Proxy-Token') ?? '';
        if (!provided || !timingSafeEqual(provided, env.PROXY_AUTH_TOKEN)) {
          return jsonResponse({ ok: false, error: 'Unauthorized: invalid or missing X-Proxy-Token.' }, 401, request);
        }
      }

      const allowCustomPorts = env.ALLOW_CUSTOM_PORTS === 'true';
      const allowedHosts = env.ALLOWED_MAIL_HOSTS
        ? new Set(env.ALLOWED_MAIL_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
        : undefined;

      if (route === '/api/dns/ptr' && (request.method === 'GET' || request.method === 'POST')) {
        let domain = url.searchParams.get('domain') || url.searchParams.get('email') || '';
        if (!domain && request.method === 'POST') {
          const body = await parseJsonBody<{ domain?: string; email?: string }>(request);
          domain = body.domain || body.email || '';
        }
        if (!domain.trim()) {
          throw new HttpError(400, 'domain or email is required.');
        }
        const resolved = await resolveDomainAToPtr(domain, allowedHosts);
        return jsonResponse({ ok: true, ...resolved }, 200, request);
      }

      if (request.method !== 'POST') {
        return jsonResponse({ ok: false, error: 'Method not allowed. Use POST.' }, 405, request);
      }

      if (route === '/api/test') {
        const body = await parseJsonBody<{ imap: ImapConfig }>(request);
        const started = Date.now();
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          const greeting = await client.connectAndLogin();
          const mailboxes = await client.listMailboxes();
          return jsonResponse(
            {
              ok: true,
              greeting,
              mailboxes,
              latencyMs: Date.now() - started,
            },
            200,
            request,
          );
        } finally {
          await client.close();
        }
      }

      if (route === '/api/imap/mailboxes') {
        const body = await parseJsonBody<{ imap: ImapConfig }>(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          const mailboxes = await client.listMailboxes();
          return jsonResponse({ ok: true, mailboxes }, 200, request);
        } finally {
          await client.close();
        }
      }

      if (route === '/api/imap/messages') {
        const body = await parseJsonBody<{ imap: ImapConfig; folder?: string; limit?: number; page?: number }>(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          const result = await client.fetchMessages(body.folder || 'INBOX', body.limit ?? 30, body.page ?? 1);
          return jsonResponse({ ok: true, ...result }, 200, request);
        } finally {
          await client.close();
        }
      }

      if (route === '/api/imap/message') {
        const body = await parseJsonBody<{ imap: ImapConfig; folder?: string; uid: number }>(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          const message = await client.fetchSingleMessage(body.folder || 'INBOX', body.uid);
          if (!message) return jsonResponse({ ok: false, error: 'Message not found.' }, 404, request);
          return jsonResponse({ ok: true, message }, 200, request);
        } finally {
          await client.close();
        }
      }

      if (route === '/api/imap/flags') {
        const body = await parseJsonBody<{ imap: ImapConfig; folder?: string; uids: number[]; op: 'add' | 'remove'; flags: string[] }>(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          await client.updateFlags(body.folder || 'INBOX', body.uids, body.op, body.flags);
          return jsonResponse({ ok: true }, 200, request);
        } finally {
          await client.close();
        }
      }

      if (route === '/api/imap/move') {
        const body = await parseJsonBody<{ imap: ImapConfig; folder?: string; uids: number[]; targetFolder: string }>(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          await client.moveMessages(body.folder || 'INBOX', body.uids, body.targetFolder);
          return jsonResponse({ ok: true }, 200, request);
        } finally {
          await client.close();
        }
      }

      if (route === '/api/imap/delete') {
        const body = await parseJsonBody<{ imap: ImapConfig; folder?: string; uids: number[]; expunge?: boolean }>(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          await client.deleteMessages(body.folder || 'INBOX', body.uids, body.expunge ?? true);
          return jsonResponse({ ok: true }, 200, request);
        } finally {
          await client.close();
        }
      }

      if (route === '/api/smtp/send') {
        const body = await parseJsonBody<{ smtp: SmtpConfig; message: OutgoingEmail }>(request);
        const result = await sendSmtpEmail(body.smtp, body.message, allowCustomPorts, allowedHosts);
        return jsonResponse(result, 200, request);
      }

      return jsonResponse({ ok: false, error: `Unknown endpoint: ${route}` }, 404, request);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      return jsonResponse({ ok: false, error: sanitizeErrorMessage(err) }, status, request);
    }
  },
};
