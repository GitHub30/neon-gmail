import { describe, it, expect } from 'vitest';
import {
  assertNoCrlf,
  CORS_HEADERS,
  quoteImapString,
  timingSafeEqual,
  validateEmailAddress,
  validateMailHost,
  validateMailPort,
  validateUids,
} from '../workers/mail-proxy/src/security.ts';

describe('Cloudflare Worker Security & SSRF Protection (Adversarial Hardened)', () => {
  it('blocks private, loopback, metadata, obfuscated, colon-bypass, and IPv6 special-range hosts', () => {
    const blockedHosts = [
      'localhost',
      'localhost.localdomain',
      '127.0.0.1',
      '127.1',
      '127.255.255.254',
      '0.0.0.0',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '198.51.100.1',
      '203.0.113.5',
      '192.88.99.1',
      'metadata.google.internal',
      'internal.local',
      'db.internal',
      '::',
      '::1',
      '[::1]',
      '0::1',
      '::0:1',
      '0000::1',
      '[[::1]]',
      '::1%lo',
      '127.0.0.1:6379',
      'localhost:22',
      '::ffff:127.0.0.1',
      '[::ffff:127.0.0.1]',
      '0:0:0:0:0:ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::127.0.0.1',
      '::169.254.169.254',
      '64:ff9b::127.0.0.1',
      '2002:7f00:0001::1',
      '2001::1',
      '2001:db8::1',
      '100::1',
      'fe80::1',
      'febf::1',
      'fc00::1',
      'fd12::1',
      'ff02::1',
      '2130706433',
      '0x7f000001',
      '0177.0.0.1',
      'imap.gmail.com\r\nINJECT',
    ];
    for (const h of blockedHosts) {
      expect(() => validateMailHost(h), `Expected host ${h} to be blocked`).toThrow();
    }
  });

  it('allows legitimate public mail server hostnames and enforces optional allowlist', () => {
    expect(validateMailHost('imap.gmail.com')).toBe('imap.gmail.com');
    expect(validateMailHost('smtp.office365.com')).toBe('smtp.office365.com');
    expect(validateMailHost('mail.sakura.ne.jp')).toBe('mail.sakura.ne.jp');
    expect(validateMailHost('imap.gmail.com', new Set(['imap.gmail.com']))).toBe('imap.gmail.com');
    expect(() => validateMailHost('evil.example.com', new Set(['imap.gmail.com']))).toThrow();
  });

  it('enforces allowed mail ports unless custom ports explicitly enabled', () => {
    expect(validateMailPort(993)).toBe(993);
    expect(validateMailPort(465)).toBe(465);
    expect(validateMailPort(587)).toBe(587);
    expect(() => validateMailPort(22)).toThrow();
    expect(() => validateMailPort(6379)).toThrow();
    expect(() => validateMailPort(80)).toThrow();
    expect(validateMailPort(2500, true)).toBe(2500);
  });

  it('prevents CRLF command and header injection', () => {
    expect(() => assertNoCrlf('INBOX\r\nA002 DELETE INBOX', 'folder')).toThrow();
    expect(() => quoteImapString('user\npass')).toThrow();
    expect(() => validateEmailAddress('victim@example.com\r\nBcc: evil@attacker.com')).toThrow();
    expect(validateEmailAddress('Alice <alice@example.com>')).toBe('alice@example.com');
    expect(quoteImapString('my "quoted" \\ folder')).toBe('"my \\"quoted\\" \\\\ folder"');
  });

  it('validates UIDs, constant-time tokens, and CORS wildcard header', () => {
    expect(validateUids([1, 42, 999])).toEqual([1, 42, 999]);
    expect(() => validateUids(['1:*'])).toThrow();
    expect(() => validateUids([-5])).toThrow();
    expect(timingSafeEqual('secret-token', 'secret-token')).toBe(true);
    expect(timingSafeEqual('secret-token', 'secret-tokeN')).toBe(false);
    expect(CORS_HEADERS['Access-Control-Allow-Origin']).toBe('*');
  });
});
