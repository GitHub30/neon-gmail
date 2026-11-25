import { describe, it, expect, vi, afterEach } from 'vitest';
import { testAccountConnectionWithPtrFallback } from '../src/core/proxyClient.ts';
import { DEFAULT_CLOUDFLARE_PROXY_URL, inferProxyTypeFromUrl } from '../src/data/providers.ts';
import type { MailAccount } from '../src/types/mail.ts';

function makeAccount(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'acc-ptr-test',
    email: 'info@my-custom-domain.jp',
    password: 'secret-password',
    displayName: 'Info',
    proxyUrl: DEFAULT_CLOUDFLARE_PROXY_URL,
    proxyType: 'cloudflare',
    proxyToken: '',
    server: {
      imapHost: 'imap.my-custom-domain.jp',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'smtp.my-custom-domain.jp',
      smtpPort: 465,
      smtpTls: 'tls',
    },
    signature: '',
    avatarColor: '#1a73e8',
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Default Cloudflare Proxy & DNS A → PTR Fallback Login', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('infers proxy types cleanly without a manual connection-method selector', () => {
    expect(DEFAULT_CLOUDFLARE_PROXY_URL).toMatch(/^https:\/\/.*\.workers\.dev$/);
    expect(inferProxyTypeFromUrl(DEFAULT_CLOUDFLARE_PROXY_URL)).toBe('cloudflare');
    expect(inferProxyTypeFromUrl('https://example.jp/mail/proxy.php')).toBe('php');
    expect(inferProxyTypeFromUrl('')).toBe('local');
  });

  it('falls back to A → PTR host for both IMAP and SMTP when initial host login fails (via proxy /api/dns/ptr)', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, body });

      if (url.endsWith('/api/test')) {
        const imap = body?.imap as { host?: string } | undefined;
        if (imap?.host === 'imap.my-custom-domain.jp') {
          return new Response(JSON.stringify({ ok: false, error: 'Connection refused on imap.my-custom-domain.jp' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (imap?.host === 'sv12345.xserver.jp') {
          return new Response(
            JSON.stringify({ ok: true, greeting: '* OK Dovecot ready', mailboxes: [{ name: 'INBOX' }], latencyMs: 42 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }

      if (url.endsWith('/api/dns/ptr')) {
        return new Response(
          JSON.stringify({
            ok: true,
            domain: 'my-custom-domain.jp',
            aRecords: ['183.90.240.12'],
            ptrHosts: ['sv12345.xserver.jp'],
            primaryHost: 'sv12345.xserver.jp',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ ok: false, error: 'unexpected url' }), { status: 404 });
    }) as typeof fetch;

    const stages: string[] = [];
    const outcome = await testAccountConnectionWithPtrFallback(makeAccount(), (stage, detail) => {
      stages.push(`${stage}:${detail}`);
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.usedPtrFallback).toBe(true);
    expect(outcome.ptrHost).toBe('sv12345.xserver.jp');
    expect(outcome.aRecords).toEqual(['183.90.240.12']);
    expect(outcome.server.imapHost).toBe('sv12345.xserver.jp');
    expect(outcome.server.smtpHost).toBe('sv12345.xserver.jp');
    expect(stages).toEqual([
      'initial:imap.my-custom-domain.jp',
      'dns:my-custom-domain.jp',
      'ptr_test:sv12345.xserver.jp',
    ]);
  });

  it('falls back to browser DoH (A → reversed in-addr.arpa PTR) when custom proxy lacks /api/dns/ptr', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;

      if (url.includes('action=dns_ptr') || url.endsWith('/api/dns/ptr')) {
        return new Response(JSON.stringify({ ok: false, error: 'Not found' }), { status: 404 });
      }
      if (url.startsWith('https://cloudflare-dns.com/dns-query') && url.includes('type=A')) {
        return new Response(JSON.stringify({ Answer: [{ type: 1, data: '183.90.240.55' }] }), { status: 200 });
      }
      if (url.startsWith('https://cloudflare-dns.com/dns-query') && url.includes('55.240.90.183.in-addr.arpa') && url.includes('type=PTR')) {
        return new Response(JSON.stringify({ Answer: [{ type: 12, data: 'www999.sakura.ne.jp.' }] }), { status: 200 });
      }
      if (url.endsWith('/api/test')) {
        const imap = body?.imap as { host?: string } | undefined;
        if (imap?.host === 'www999.sakura.ne.jp') {
          return new Response(JSON.stringify({ ok: true, mailboxes: [{ name: 'INBOX' }], latencyMs: 30 }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: false, error: 'TLS handshake failed' }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    }) as typeof fetch;

    const outcome = await testAccountConnectionWithPtrFallback(makeAccount());
    expect(outcome.ok).toBe(true);
    expect(outcome.usedPtrFallback).toBe(true);
    expect(outcome.server.imapHost).toBe('www999.sakura.ne.jp');
    expect(outcome.server.smtpHost).toBe('www999.sakura.ne.jp');
  });
});
