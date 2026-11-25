import { assertNoCrlf } from './security.ts';

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  dataBase64: string;
}

export interface ParsedMimeMessage {
  subject: string;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  date: string;
  messageId: string;
  inReplyTo: string;
  references: string;
  textBody: string;
  htmlBody: string;
  snippet: string;
  attachments: ParsedAttachment[];
  headers: Record<string, string>;
}

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export interface OutgoingEmail {
  fromName?: string;
  fromEmail: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutgoingAttachment[];
}

const MAX_ATTACHMENT_EXTRACT_BYTES = 5 * 1024 * 1024;
const MIME_TYPE_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

function decodeBytes(bytes: Uint8Array, charset = 'utf-8'): string {
  const normalized = charset.trim().toLowerCase().replace(/^["']|["']$/g, '');
  const map: Record<string, string> = {
    utf8: 'utf-8',
    'utf-8': 'utf-8',
    'us-ascii': 'utf-8',
    ascii: 'utf-8',
    'iso-8859-1': 'iso-8859-1',
    latin1: 'iso-8859-1',
    shift_jis: 'shift-jis',
    'shift-jis': 'shift-jis',
    sjis: 'shift-jis',
    csiso2022jp: 'iso-2022-jp',
    'iso-2022-jp': 'iso-2022-jp',
    'euc-jp': 'euc-jp',
    'windows-1252': 'windows-1252',
  };
  const label = map[normalized] ?? 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/\s+/g, '');
  try {
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function decodeQuotedPrintableToBytes(input: string, isHeaderQ = false): Uint8Array {
  const unwrapped = isHeaderQ ? input.replace(/_/g, ' ') : input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < unwrapped.length; i++) {
    const ch = unwrapped[i]!;
    if (ch === '=' && i + 2 < unwrapped.length && /^[0-9A-Fa-f]{2}$/.test(unwrapped.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unwrapped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function decodeRfc2047(value: string): string {
  if (!value || !value.includes('=?')) return value;
  const collapsed = value.replace(/\?=\s+=\?/g, '?==?');
  return collapsed.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, encoding: string, text: string) => {
    const bytes = encoding.toUpperCase() === 'B'
      ? base64ToBytes(text)
      : decodeQuotedPrintableToBytes(text, true);
    return decodeBytes(bytes, charset);
  });
}

/**
 * RFC 2047 compliant UTF-8 Base64 header encoding split into <=75-char encoded-words.
 */
export function encodeRfc2047(value: string): string {
  assertNoCrlf(value, 'header');
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunkBytes: number[] = [];
  const flush = () => {
    if (chunkBytes.length === 0) return;
    words.push(`=?UTF-8?B?${bytesToBase64(new Uint8Array(chunkBytes))}?=`);
    chunkBytes = [];
  };
  for (const ch of value) {
    const b = encoder.encode(ch);
    // 45 raw bytes -> 60 base64 chars + 12 wrapper chars = 72 chars (<= 75 RFC limit)
    if (chunkBytes.length + b.length > 45) flush();
    for (const byte of b) chunkBytes.push(byte);
  }
  flush();
  return words.join(' ');
}

export function formatDisplayName(name: string): string {
  assertNoCrlf(name, 'fromName');
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (!/^[\x20-\x7e]*$/.test(trimmed)) {
    return encodeRfc2047(trimmed);
  }
  // Quote ASCII display names containing RFC 5322 specials
  if (/[()<>@,;:\\".[\]]/.test(trimmed)) {
    return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return trimmed;
}

export function parseHeaders(headerBlock: string): Record<string, string> {
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${val}` : val;
  }
  return headers;
}

function decodeRfc2231Value(rawVal: string): string {
  // Format: charset'lang'percent-encoded-bytes
  const m = rawVal.match(/^([^']*)'[^']*'(.*)$/);
  const charset = m?.[1] || 'utf-8';
  const encoded = m?.[2] ?? rawVal;
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%' && i + 2 < encoded.length && /^[0-9A-Fa-f]{2}$/.test(encoded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i) & 0xff);
    }
  }
  return decodeBytes(new Uint8Array(bytes), charset);
}

function extractHeaderParam(headerVal: string, paramName: string): string | undefined {
  // Check RFC 2231 extended parameter first (e.g. filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf)
  const extRe = new RegExp(`(?:^|;)\\s*${paramName}\\*\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i');
  const extMatch = headerVal.match(extRe);
  if (extMatch) {
    return decodeRfc2231Value(extMatch[1] ?? extMatch[2] ?? '');
  }
  // Check RFC 2231 multi-segment continuations (filename*0*=..., filename*1*=...)
  const contRe = new RegExp(`(?:^|;)\\s*${paramName}\\*(\\d+)(\\*?)\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'gi');
  const segs: Array<{ idx: number; val: string; enc: boolean }> = [];
  let cm: RegExpExecArray | null;
  while ((cm = contRe.exec(headerVal)) !== null) {
    segs.push({ idx: Number(cm[1]), enc: cm[2] === '*', val: cm[3] ?? cm[4] ?? '' });
  }
  if (segs.length > 0) {
    segs.sort((a, b) => a.idx - b.idx);
    const joined = segs.map((s) => s.val).join('');
    return segs.some((s) => s.enc) ? decodeRfc2231Value(joined) : decodeRfc2047(joined);
  }

  const re = new RegExp(`(?:^|;)\\s*${paramName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, 'i');
  const m = headerVal.match(re);
  return m ? decodeRfc2047(m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

function splitHeaderAndBody(raw: string): { headerText: string; bodyText: string } {
  const crlfIdx = raw.indexOf('\r\n\r\n');
  if (crlfIdx !== -1) return { headerText: raw.slice(0, crlfIdx), bodyText: raw.slice(crlfIdx + 4) };
  const lfIdx = raw.indexOf('\n\n');
  if (lfIdx !== -1) return { headerText: raw.slice(0, lfIdx), bodyText: raw.slice(lfIdx + 2) };
  return { headerText: raw, bodyText: '' };
}

function decodeBodyTransfer(body: string, transferEncoding: string, charset: string): { text: string; bytes: Uint8Array } {
  const enc = transferEncoding.trim().toLowerCase();
  if (enc === 'base64') {
    const bytes = base64ToBytes(body);
    return { text: decodeBytes(bytes, charset), bytes };
  }
  if (enc === 'quoted-printable') {
    const bytes = decodeQuotedPrintableToBytes(body, false);
    return { text: decodeBytes(bytes, charset), bytes };
  }
  const rawBytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) rawBytes[i] = body.charCodeAt(i) & 0xff;
  return { text: decodeBytes(rawBytes, charset), bytes: rawBytes };
}

function splitMultipartByBoundary(bodyText: string, boundary: string): string[] {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, 'g');
  const parts: string[] = [];
  let prevEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyText)) !== null) {
    if (prevEnd !== -1) {
      parts.push(bodyText.slice(prevEnd, m.index));
    }
    if (m[1] === '--') break;
    prevEnd = m.index + m[0].length;
  }
  return parts;
}

function walkMimePart(
  rawPart: string,
  acc: { textParts: string[]; htmlParts: string[]; attachments: ParsedAttachment[] },
  depth = 0,
): void {
  if (depth > 8) return;
  const { headerText, bodyText } = splitHeaderAndBody(rawPart);
  const headers = parseHeaders(headerText);
  const contentTypeHeader = headers['content-type'] ?? 'text/plain; charset=utf-8';
  const mimeType = (contentTypeHeader.split(';')[0] ?? 'text/plain').trim().toLowerCase();
  const charset = extractHeaderParam(contentTypeHeader, 'charset') ?? 'utf-8';
  const transferEncoding = headers['content-transfer-encoding'] ?? '7bit';
  const disposition = headers['content-disposition'] ?? '';

  if (mimeType.startsWith('multipart/')) {
    const boundary = extractHeaderParam(contentTypeHeader, 'boundary');
    if (!boundary) return;
    for (const seg of splitMultipartByBoundary(bodyText, boundary)) {
      if (seg.trim()) walkMimePart(seg, acc, depth + 1);
    }
    return;
  }

  const filename =
    extractHeaderParam(disposition, 'filename') ??
    extractHeaderParam(contentTypeHeader, 'name');
  const isAttachment =
    disposition.toLowerCase().startsWith('attachment') ||
    Boolean(filename && mimeType !== 'text/plain' && mimeType !== 'text/html');

  const decoded = decodeBodyTransfer(bodyText, transferEncoding, charset);

  if (isAttachment) {
    const size = decoded.bytes.byteLength;
    acc.attachments.push({
      filename: filename || 'attachment.bin',
      contentType: mimeType,
      size,
      contentId: headers['content-id']?.replace(/^<|>$/g, ''),
      dataBase64: size <= MAX_ATTACHMENT_EXTRACT_BYTES ? bytesToBase64(decoded.bytes) : '',
    });
    return;
  }

  if (mimeType === 'text/html') acc.htmlParts.push(decoded.text);
  else if (mimeType === 'text/plain') acc.textParts.push(decoded.text);
}

export function stripHtmlToSnippet(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseMimeMessage(raw: string): ParsedMimeMessage {
  const { headerText } = splitHeaderAndBody(raw);
  const headers = parseHeaders(headerText);
  const acc = { textParts: [] as string[], htmlParts: [] as string[], attachments: [] as ParsedAttachment[] };
  walkMimePart(raw, acc, 0);

  const textBody = acc.textParts.join('\n').trim();
  const htmlBody = acc.htmlParts.join('\n').trim();
  const snippetSource = textBody || stripHtmlToSnippet(htmlBody);
  const snippet = snippetSource.replace(/\s+/g, ' ').trim().slice(0, 180);

  return {
    subject: decodeRfc2047(headers['subject'] ?? '(No Subject)'),
    from: decodeRfc2047(headers['from'] ?? ''),
    to: decodeRfc2047(headers['to'] ?? ''),
    cc: decodeRfc2047(headers['cc'] ?? ''),
    replyTo: decodeRfc2047(headers['reply-to'] ?? ''),
    date: headers['date'] ?? new Date().toUTCString().replace('GMT', '+0000'),
    messageId: headers['message-id'] ?? '',
    inReplyTo: headers['in-reply-to'] ?? '',
    references: headers['references'] ?? '',
    textBody,
    htmlBody,
    snippet,
    attachments: acc.attachments,
    headers,
  };
}

function wrapBase64Lines(b64: string, lineLen = 76): string {
  const clean = b64.replace(/\s+/g, '');
  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += lineLen) {
    lines.push(clean.slice(i, i + lineLen));
  }
  return lines.join('\r\n');
}

export function buildMimeMessage(email: OutgoingEmail): string {
  const boundaryAlt = `----=_NeonAlt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const boundaryMix = `----=_NeonMix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const domain = email.fromEmail.split('@')[1] ?? 'neon-gmail.example';
  const msgId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}@${domain}>`;
  const formattedName = email.fromName ? formatDisplayName(email.fromName) : '';
  const fromHeader = formattedName ? `${formattedName} <${email.fromEmail}>` : `<${email.fromEmail}>`;
  const toHeader = email.to.length > 0
    ? email.to.map((a) => assertNoCrlf(a, 'To')).join(', ')
    : 'undisclosed-recipients:;';

  const headers: string[] = [
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${msgId}`,
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
  ];
  if (email.cc && email.cc.length > 0) {
    headers.push(`Cc: ${email.cc.map((a) => assertNoCrlf(a, 'Cc')).join(', ')}`);
  }
  headers.push(`Subject: ${encodeRfc2047(email.subject || '(No Subject)')}`);
  if (email.inReplyTo) headers.push(`In-Reply-To: ${assertNoCrlf(email.inReplyTo, 'In-Reply-To')}`);
  if (email.references) headers.push(`References: ${assertNoCrlf(email.references, 'References')}`);
  headers.push('MIME-Version: 1.0');
  headers.push('X-Mailer: Neon Gmail WebClient/1.0');

  const textEncoded = wrapBase64Lines(bytesToBase64(new TextEncoder().encode(email.textBody || '')));
  const hasHtml = Boolean(email.htmlBody && email.htmlBody.trim().length > 0);
  const hasAttachments = Boolean(email.attachments && email.attachments.length > 0);

  const buildBodyContent = (): { contentType: string; body: string } => {
    if (!hasHtml) {
      return {
        contentType: 'text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64',
        body: textEncoded,
      };
    }
    const htmlEncoded = wrapBase64Lines(bytesToBase64(new TextEncoder().encode(email.htmlBody!)));
    return {
      contentType: `multipart/alternative; boundary="${boundaryAlt}"`,
      body: [
        `--${boundaryAlt}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        textEncoded,
        `--${boundaryAlt}`,
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        htmlEncoded,
        `--${boundaryAlt}--`,
      ].join('\r\n'),
    };
  };

  const inner = buildBodyContent();

  if (!hasAttachments) {
    headers.push(`Content-Type: ${inner.contentType}`);
    return `${headers.join('\r\n')}\r\n\r\n${inner.body}\r\n`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundaryMix}"`);
  const parts: string[] = [
    `--${boundaryMix}`,
    `Content-Type: ${inner.contentType}`,
    '',
    inner.body,
  ];

  for (const att of email.attachments!) {
    const safeName = assertNoCrlf(att.filename, 'attachment filename').replace(/["\\]/g, '_');
    const rawType = assertNoCrlf(att.contentType || 'application/octet-stream', 'attachment contentType').trim();
    const safeType = MIME_TYPE_RE.test(rawType) ? rawType : 'application/octet-stream';
    parts.push(
      `--${boundaryMix}`,
      `Content-Type: ${safeType}; name="${encodeRfc2047(safeName)}"`,
      `Content-Disposition: attachment; filename="${encodeRfc2047(safeName)}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64Lines(att.dataBase64),
    );
  }
  parts.push(`--${boundaryMix}--`);

  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`;
}

export function dotStuffSmtp(rawMime: string): string {
  const normalized = rawMime.replace(/\r?\n/g, '\r\n');
  return normalized.replace(/(^|\r\n)\./g, '$1..');
}
