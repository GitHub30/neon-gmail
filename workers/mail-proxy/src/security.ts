export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Token',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

export function buildCorsHeaders(request?: Request): Record<string, string> {
  const reqHeaders = request?.headers.get('Access-Control-Request-Headers')?.trim();
  return {
    ...CORS_HEADERS,
    ...(reqHeaders ? { 'Access-Control-Allow-Headers': reqHeaders } : {}),
  };
}

export const ALLOWED_MAIL_PORTS = new Set([143, 993, 25, 465, 587, 2525, 1143, 1025]);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

export function isPrivateIPv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === undefined || b === undefined || c === undefined) return true;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local / cloud metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay 192.88.99.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 203.0.113.0/24
  if (a >= 224) return true; // multicast & reserved
  return false;
}

function parseStrictIPv4(host: string): number[] | null {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;
  const parts = host.split('.');
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Strict IPv6 parser expanding any valid literal (including embedded IPv4 tail)
 * into 8 x 16-bit integer groups. Rejects zone IDs, malformed brackets, and non-IPv6 colon strings.
 */
export function parseStrictIPv6(raw: string): number[] | null {
  let s = raw;
  if (s.startsWith('[') || s.endsWith(']')) {
    if (!(s.startsWith('[') && s.endsWith(']'))) return null;
    s = s.slice(1, -1);
  }
  if (!s || s.includes('[') || s.includes(']') || s.includes('%') || !s.includes(':')) {
    return null;
  }

  // Handle optional embedded dotted IPv4 in the final 32 bits (e.g., ::ffff:127.0.0.1)
  let embeddedIpv4Groups: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = parseStrictIPv4(tail);
    if (!octets) return null;
    embeddedIpv4Groups = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    s = s.slice(0, lastColon);
    if (s.endsWith(':')) s = `${s}:`; // preserve '::' when input was '::127.0.0.1'
    if (s === '') s = '::';
  }

  const dblParts = s.split('::');
  if (dblParts.length > 2) return null;

  const parseGroups = (seg: string): number[] | null => {
    if (!seg) return [];
    const items = seg.split(':');
    const out: number[] = [];
    for (const item of items) {
      if (!/^[0-9a-f]{1,4}$/i.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };

  if (dblParts.length === 1) {
    const groups = parseGroups(dblParts[0]!);
    if (!groups) return null;
    const all = [...groups, ...embeddedIpv4Groups];
    return all.length === 8 ? all : null;
  }

  const left = parseGroups(dblParts[0]!);
  const right = parseGroups(dblParts[1]!);
  if (!left || !right) return null;
  const totalFixed = left.length + right.length + embeddedIpv4Groups.length;
  if (totalFixed >= 8) return null;
  const zeros = new Array<number>(8 - totalFixed).fill(0);
  return [...left, ...zeros, ...right, ...embeddedIpv4Groups];
}

export function isBlockedIPv6Groups(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const allZeroFirst6 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  // ::/128 unspecified & ::1/128 loopback
  if (allZeroFirst6 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // ::/96 deprecated IPv4-compatible IPv6
  if (allZeroFirst6) return true;
  // ::ffff:0:0/96 IPv4-mapped IPv6 -> validate embedded IPv4
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  // 64:ff9b::/96 & 64:ff9b:1::/48 NAT64
  if (g0 === 0x0064 && g1 === 0xff9b && (g2 === 0 || g2 === 1)) return true;
  // 100::/64 discard-only
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // 2001::/32 Teredo, 2001:db8::/32 documentation, 2001:2::/48 benchmark
  if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0db8 || (g1 === 0x0002 && g2 === 0))) return true;
  // 2002::/16 6to4
  if (g0 === 0x2002) return true;
  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

export function validateMailHost(rawHost: unknown, allowedHosts?: Set<string>): string {
  if (typeof rawHost !== 'string') {
    throw new Error('Mail server host must be a non-empty string.');
  }
  const host = rawHost.trim().toLowerCase();
  if (!host || host.length > 253) {
    throw new Error('Invalid mail server host.');
  }
  if (/[\r\n\t\s@\\/?#%]/.test(host)) {
    throw new Error('Mail server host contains forbidden characters.');
  }
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new Error('Connections to local or internal hosts are blocked for security.');
  }

  // Reject integer, hex, octal, or short-form IPv4 tricks (e.g., 2130706433, 0x7f000001, 0177.0.0.1, 127.1)
  if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) {
    const octets = parseStrictIPv4(host);
    if (!octets || isPrivateIPv4(octets)) {
      throw new Error('Connections to private, loopback, obfuscated, or reserved IP addresses are blocked.');
    }
    if (allowedHosts && allowedHosts.size > 0 && !allowedHosts.has(host)) {
      throw new Error('Mail server host is not in the configured ALLOWED_MAIL_HOSTS allowlist.');
    }
    return host;
  }

  // Strict IPv6 validation (rejects non-IPv6 colon strings like 127.0.0.1:6379 or [[::1]])
  if (host.includes(':') || host.includes('[') || host.includes(']')) {
    const groups = parseStrictIPv6(host);
    if (!groups) {
      throw new Error('Invalid IPv6 or colon-containing mail server host.');
    }
    if (isBlockedIPv6Groups(groups)) {
      throw new Error('Connections to private, loopback, or reserved IPv6 addresses are blocked.');
    }
    const cleanV6 = host.replace(/^\[|\]$/g, '');
    if (allowedHosts && allowedHosts.size > 0 && !allowedHosts.has(cleanV6)) {
      throw new Error('Mail server host is not in the configured ALLOWED_MAIL_HOSTS allowlist.');
    }
    return cleanV6;
  }

  // Standard RFC 1123 hostname validation (must contain at least one dot and alphabetic TLD)
  const tld = host.split('.').pop() ?? '';
  if (!host.includes('.') || !/[a-z]/.test(tld) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    throw new Error('Invalid mail server hostname format.');
  }
  if (allowedHosts && allowedHosts.size > 0 && !allowedHosts.has(host)) {
    throw new Error('Mail server host is not in the configured ALLOWED_MAIL_HOSTS allowlist.');
  }
  return host;
}

export function validateMailPort(rawPort: unknown, allowCustom = false): number {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid port number.');
  }
  if (!allowCustom && !ALLOWED_MAIL_PORTS.has(port)) {
    throw new Error(`Port ${port} is not in the allowed mail ports list (${Array.from(ALLOWED_MAIL_PORTS).join(', ')}).`);
  }
  return port;
}

export function assertNoCrlf(value: string, fieldName: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${fieldName} must not contain CR, LF, or NUL characters.`);
  }
  return value;
}

export function validateEmailAddress(raw: unknown, fieldName = 'email'): string {
  if (typeof raw !== 'string') {
    throw new Error(`${fieldName} must be a string.`);
  }
  const trimmed = raw.trim();
  assertNoCrlf(trimmed, fieldName);
  const angleMatch = trimmed.match(/<([^<>]+)>/);
  const addr = (angleMatch ? angleMatch[1] : trimmed) ?? '';
  if (!addr || addr.length > 254 || !/^[^\s@<>()[\],;:\\"]+@[^\s@<>()[\],;:\\"]+\.[^\s@<>()[\],;:\\"]+$/.test(addr)) {
    throw new Error(`Invalid email address in ${fieldName}.`);
  }
  return addr;
}

export function validateFolderName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('Folder name must be a string.');
  }
  const folder = raw.trim();
  if (!folder || folder.length > 256) {
    throw new Error('Invalid folder name.');
  }
  assertNoCrlf(folder, 'folder');
  return folder;
}

export function validateUids(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0 || list.length > 500) {
    throw new Error('UID list must contain between 1 and 500 valid positive integers.');
  }
  return list.map((item) => {
    const n = Number(item);
    if (!Number.isInteger(n) || n <= 0 || n > 4294967295) {
      throw new Error(`Invalid IMAP UID: ${String(item)}`);
    }
    return n;
  });
}

export function quoteImapString(input: string): string {
  assertNoCrlf(input, 'IMAP argument');
  return `"${input.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const maxLen = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export function sanitizeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[\r\n]+/g, ' ').slice(0, 300);
}
