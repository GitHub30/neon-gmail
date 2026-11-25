// Neon Gmail — Cloudflare Workers IMAP/SMTP CORS Proxy (Generated from workers/mail-proxy/src)
// Deploy with: cd workers/mail-proxy && npx wrangler deploy


// workers/mail-proxy/src/imap.ts
import { connect } from "cloudflare:sockets";

// workers/mail-proxy/src/security.ts
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Proxy-Token",
  "Access-Control-Max-Age": "86400",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store"
};
var ALLOWED_MAIL_PORTS = /* @__PURE__ */ new Set([143, 993, 25, 465, 587, 2525, 1143, 1025]);
var BLOCKED_HOSTNAMES = /* @__PURE__ */ new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data"
]);
function isPrivateIPv4(octets) {
  const [a, b, c] = octets;
  if (a === void 0 || b === void 0 || c === void 0) return true;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}
function parseStrictIPv4(host) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;
  const parts = host.split(".");
  const octets = [];
  for (const part of parts) {
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}
function parseStrictIPv6(raw) {
  let s = raw;
  if (s.startsWith("[") || s.endsWith("]")) {
    if (!(s.startsWith("[") && s.endsWith("]"))) return null;
    s = s.slice(1, -1);
  }
  if (!s || s.includes("[") || s.includes("]") || s.includes("%") || !s.includes(":")) {
    return null;
  }
  let embeddedIpv4Groups = [];
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseStrictIPv4(tail);
    if (!octets) return null;
    embeddedIpv4Groups = [octets[0] << 8 | octets[1], octets[2] << 8 | octets[3]];
    s = s.slice(0, lastColon);
    if (s.endsWith(":")) s = `${s}:`;
    if (s === "") s = "::";
  }
  const dblParts = s.split("::");
  if (dblParts.length > 2) return null;
  const parseGroups = (seg) => {
    if (!seg) return [];
    const items = seg.split(":");
    const out = [];
    for (const item of items) {
      if (!/^[0-9a-f]{1,4}$/i.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  if (dblParts.length === 1) {
    const groups = parseGroups(dblParts[0]);
    if (!groups) return null;
    const all = [...groups, ...embeddedIpv4Groups];
    return all.length === 8 ? all : null;
  }
  const left = parseGroups(dblParts[0]);
  const right = parseGroups(dblParts[1]);
  if (!left || !right) return null;
  const totalFixed = left.length + right.length + embeddedIpv4Groups.length;
  if (totalFixed >= 8) return null;
  const zeros = new Array(8 - totalFixed).fill(0);
  return [...left, ...zeros, ...right, ...embeddedIpv4Groups];
}
function isBlockedIPv6Groups(g) {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  const allZeroFirst6 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (allZeroFirst6 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  if (allZeroFirst6) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 65535) {
    return isPrivateIPv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  }
  if (g0 === 100 && g1 === 65435 && (g2 === 0 || g2 === 1)) return true;
  if (g0 === 256 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  if (g0 === 8193 && (g1 === 0 || g1 === 3512 || g1 === 2 && g2 === 0)) return true;
  if (g0 === 8194) return true;
  if ((g0 & 65024) === 64512) return true;
  if ((g0 & 65472) === 65152) return true;
  if ((g0 & 65280) === 65280) return true;
  return false;
}
function validateMailHost(rawHost, allowedHosts) {
  if (typeof rawHost !== "string") {
    throw new Error("Mail server host must be a non-empty string.");
  }
  const host = rawHost.trim().toLowerCase();
  if (!host || host.length > 253) {
    throw new Error("Invalid mail server host.");
  }
  if (/[\r\n\t\s@\\/?#%]/.test(host)) {
    throw new Error("Mail server host contains forbidden characters.");
  }
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    throw new Error("Connections to local or internal hosts are blocked for security.");
  }
  if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(host)) {
    const octets = parseStrictIPv4(host);
    if (!octets || isPrivateIPv4(octets)) {
      throw new Error("Connections to private, loopback, obfuscated, or reserved IP addresses are blocked.");
    }
    if (allowedHosts && allowedHosts.size > 0 && !allowedHosts.has(host)) {
      throw new Error("Mail server host is not in the configured ALLOWED_MAIL_HOSTS allowlist.");
    }
    return host;
  }
  if (host.includes(":") || host.includes("[") || host.includes("]")) {
    const groups = parseStrictIPv6(host);
    if (!groups) {
      throw new Error("Invalid IPv6 or colon-containing mail server host.");
    }
    if (isBlockedIPv6Groups(groups)) {
      throw new Error("Connections to private, loopback, or reserved IPv6 addresses are blocked.");
    }
    const cleanV6 = host.replace(/^\[|\]$/g, "");
    if (allowedHosts && allowedHosts.size > 0 && !allowedHosts.has(cleanV6)) {
      throw new Error("Mail server host is not in the configured ALLOWED_MAIL_HOSTS allowlist.");
    }
    return cleanV6;
  }
  const tld = host.split(".").pop() ?? "";
  if (!host.includes(".") || !/[a-z]/.test(tld) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    throw new Error("Invalid mail server hostname format.");
  }
  if (allowedHosts && allowedHosts.size > 0 && !allowedHosts.has(host)) {
    throw new Error("Mail server host is not in the configured ALLOWED_MAIL_HOSTS allowlist.");
  }
  return host;
}
function validateMailPort(rawPort, allowCustom = false) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid port number.");
  }
  if (!allowCustom && !ALLOWED_MAIL_PORTS.has(port)) {
    throw new Error(`Port ${port} is not in the allowed mail ports list (${Array.from(ALLOWED_MAIL_PORTS).join(", ")}).`);
  }
  return port;
}
function assertNoCrlf(value, fieldName) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${fieldName} must not contain CR, LF, or NUL characters.`);
  }
  return value;
}
function validateEmailAddress(raw, fieldName = "email") {
  if (typeof raw !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }
  const trimmed = raw.trim();
  assertNoCrlf(trimmed, fieldName);
  const angleMatch = trimmed.match(/<([^<>]+)>/);
  const addr = (angleMatch ? angleMatch[1] : trimmed) ?? "";
  if (!addr || addr.length > 254 || !/^[^\s@<>()[\],;:\\"]+@[^\s@<>()[\],;:\\"]+\.[^\s@<>()[\],;:\\"]+$/.test(addr)) {
    throw new Error(`Invalid email address in ${fieldName}.`);
  }
  return addr;
}
function validateFolderName(raw) {
  if (typeof raw !== "string") {
    throw new Error("Folder name must be a string.");
  }
  const folder = raw.trim();
  if (!folder || folder.length > 256) {
    throw new Error("Invalid folder name.");
  }
  assertNoCrlf(folder, "folder");
  return folder;
}
function validateUids(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0 || list.length > 500) {
    throw new Error("UID list must contain between 1 and 500 valid positive integers.");
  }
  return list.map((item) => {
    const n = Number(item);
    if (!Number.isInteger(n) || n <= 0 || n > 4294967295) {
      throw new Error(`Invalid IMAP UID: ${String(item)}`);
    }
    return n;
  });
}
function quoteImapString(input) {
  assertNoCrlf(input, "IMAP argument");
  return `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function timingSafeEqual(a, b) {
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
function sanitizeErrorMessage(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/[\r\n]+/g, " ").slice(0, 300);
}

// workers/mail-proxy/src/mime.ts
var MAX_ATTACHMENT_EXTRACT_BYTES = 5 * 1024 * 1024;
var MIME_TYPE_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
function decodeBytes(bytes, charset = "utf-8") {
  const normalized = charset.trim().toLowerCase().replace(/^["']|["']$/g, "");
  const map = {
    utf8: "utf-8",
    "utf-8": "utf-8",
    "us-ascii": "utf-8",
    ascii: "utf-8",
    "iso-8859-1": "iso-8859-1",
    latin1: "iso-8859-1",
    shift_jis: "shift-jis",
    "shift-jis": "shift-jis",
    sjis: "shift-jis",
    csiso2022jp: "iso-2022-jp",
    "iso-2022-jp": "iso-2022-jp",
    "euc-jp": "euc-jp",
    "windows-1252": "windows-1252"
  };
  const label = map[normalized] ?? "utf-8";
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}
function base64ToBytes(b64) {
  const cleaned = b64.replace(/\s+/g, "");
  try {
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}
function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function decodeQuotedPrintableToBytes(input, isHeaderQ = false) {
  const unwrapped = isHeaderQ ? input.replace(/_/g, " ") : input.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < unwrapped.length; i++) {
    const ch = unwrapped[i];
    if (ch === "=" && i + 2 < unwrapped.length && /^[0-9A-Fa-f]{2}$/.test(unwrapped.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unwrapped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 255);
    }
  }
  return new Uint8Array(bytes);
}
function decodeRfc2047(value) {
  if (!value || !value.includes("=?")) return value;
  const collapsed = value.replace(/\?=\s+=\?/g, "?==?");
  return collapsed.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset, encoding, text) => {
    const bytes = encoding.toUpperCase() === "B" ? base64ToBytes(text) : decodeQuotedPrintableToBytes(text, true);
    return decodeBytes(bytes, charset);
  });
}
function encodeRfc2047(value) {
  assertNoCrlf(value, "header");
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const encoder = new TextEncoder();
  const words = [];
  let chunkBytes = [];
  const flush = () => {
    if (chunkBytes.length === 0) return;
    words.push(`=?UTF-8?B?${bytesToBase64(new Uint8Array(chunkBytes))}?=`);
    chunkBytes = [];
  };
  for (const ch of value) {
    const b = encoder.encode(ch);
    if (chunkBytes.length + b.length > 45) flush();
    for (const byte of b) chunkBytes.push(byte);
  }
  flush();
  return words.join(" ");
}
function formatDisplayName(name) {
  assertNoCrlf(name, "fromName");
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (!/^[\x20-\x7e]*$/.test(trimmed)) {
    return encodeRfc2047(trimmed);
  }
  if (/[()<>@,;:\\".[\]]/.test(trimmed)) {
    return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return trimmed;
}
function parseHeaders(headerBlock) {
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${val}` : val;
  }
  return headers;
}
function decodeRfc2231Value(rawVal) {
  const m = rawVal.match(/^([^']*)'[^']*'(.*)$/);
  const charset = m?.[1] || "utf-8";
  const encoded = m?.[2] ?? rawVal;
  const bytes = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%" && i + 2 < encoded.length && /^[0-9A-Fa-f]{2}$/.test(encoded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i) & 255);
    }
  }
  return decodeBytes(new Uint8Array(bytes), charset);
}
function extractHeaderParam(headerVal, paramName) {
  const extRe = new RegExp(`(?:^|;)\\s*${paramName}\\*\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i");
  const extMatch = headerVal.match(extRe);
  if (extMatch) {
    return decodeRfc2231Value(extMatch[1] ?? extMatch[2] ?? "");
  }
  const contRe = new RegExp(`(?:^|;)\\s*${paramName}\\*(\\d+)(\\*?)\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "gi");
  const segs = [];
  let cm;
  while ((cm = contRe.exec(headerVal)) !== null) {
    segs.push({ idx: Number(cm[1]), enc: cm[2] === "*", val: cm[3] ?? cm[4] ?? "" });
  }
  if (segs.length > 0) {
    segs.sort((a, b) => a.idx - b.idx);
    const joined = segs.map((s) => s.val).join("");
    return segs.some((s) => s.enc) ? decodeRfc2231Value(joined) : decodeRfc2047(joined);
  }
  const re = new RegExp(`(?:^|;)\\s*${paramName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^;\\s]+))`, "i");
  const m = headerVal.match(re);
  return m ? decodeRfc2047(m[1] ?? m[2] ?? m[3] ?? "") : void 0;
}
function splitHeaderAndBody(raw) {
  const crlfIdx = raw.indexOf("\r\n\r\n");
  if (crlfIdx !== -1) return { headerText: raw.slice(0, crlfIdx), bodyText: raw.slice(crlfIdx + 4) };
  const lfIdx = raw.indexOf("\n\n");
  if (lfIdx !== -1) return { headerText: raw.slice(0, lfIdx), bodyText: raw.slice(lfIdx + 2) };
  return { headerText: raw, bodyText: "" };
}
function decodeBodyTransfer(body, transferEncoding, charset) {
  const enc = transferEncoding.trim().toLowerCase();
  if (enc === "base64") {
    const bytes = base64ToBytes(body);
    return { text: decodeBytes(bytes, charset), bytes };
  }
  if (enc === "quoted-printable") {
    const bytes = decodeQuotedPrintableToBytes(body, false);
    return { text: decodeBytes(bytes, charset), bytes };
  }
  const rawBytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) rawBytes[i] = body.charCodeAt(i) & 255;
  return { text: decodeBytes(rawBytes, charset), bytes: rawBytes };
}
function splitMultipartByBoundary(bodyText, boundary) {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, "g");
  const parts = [];
  let prevEnd = -1;
  let m;
  while ((m = re.exec(bodyText)) !== null) {
    if (prevEnd !== -1) {
      parts.push(bodyText.slice(prevEnd, m.index));
    }
    if (m[1] === "--") break;
    prevEnd = m.index + m[0].length;
  }
  return parts;
}
function walkMimePart(rawPart, acc, depth = 0) {
  if (depth > 8) return;
  const { headerText, bodyText } = splitHeaderAndBody(rawPart);
  const headers = parseHeaders(headerText);
  const contentTypeHeader = headers["content-type"] ?? "text/plain; charset=utf-8";
  const mimeType = (contentTypeHeader.split(";")[0] ?? "text/plain").trim().toLowerCase();
  const charset = extractHeaderParam(contentTypeHeader, "charset") ?? "utf-8";
  const transferEncoding = headers["content-transfer-encoding"] ?? "7bit";
  const disposition = headers["content-disposition"] ?? "";
  if (mimeType.startsWith("multipart/")) {
    const boundary = extractHeaderParam(contentTypeHeader, "boundary");
    if (!boundary) return;
    for (const seg of splitMultipartByBoundary(bodyText, boundary)) {
      if (seg.trim()) walkMimePart(seg, acc, depth + 1);
    }
    return;
  }
  const filename = extractHeaderParam(disposition, "filename") ?? extractHeaderParam(contentTypeHeader, "name");
  const isAttachment = disposition.toLowerCase().startsWith("attachment") || Boolean(filename && mimeType !== "text/plain" && mimeType !== "text/html");
  const decoded = decodeBodyTransfer(bodyText, transferEncoding, charset);
  if (isAttachment) {
    const size = decoded.bytes.byteLength;
    acc.attachments.push({
      filename: filename || "attachment.bin",
      contentType: mimeType,
      size,
      contentId: headers["content-id"]?.replace(/^<|>$/g, ""),
      dataBase64: size <= MAX_ATTACHMENT_EXTRACT_BYTES ? bytesToBase64(decoded.bytes) : ""
    });
    return;
  }
  if (mimeType === "text/html") acc.htmlParts.push(decoded.text);
  else if (mimeType === "text/plain") acc.textParts.push(decoded.text);
}
function stripHtmlToSnippet(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
}
function parseMimeMessage(raw) {
  const { headerText } = splitHeaderAndBody(raw);
  const headers = parseHeaders(headerText);
  const acc = { textParts: [], htmlParts: [], attachments: [] };
  walkMimePart(raw, acc, 0);
  const textBody = acc.textParts.join("\n").trim();
  const htmlBody = acc.htmlParts.join("\n").trim();
  const snippetSource = textBody || stripHtmlToSnippet(htmlBody);
  const snippet = snippetSource.replace(/\s+/g, " ").trim().slice(0, 180);
  return {
    subject: decodeRfc2047(headers["subject"] ?? "(No Subject)"),
    from: decodeRfc2047(headers["from"] ?? ""),
    to: decodeRfc2047(headers["to"] ?? ""),
    cc: decodeRfc2047(headers["cc"] ?? ""),
    replyTo: decodeRfc2047(headers["reply-to"] ?? ""),
    date: headers["date"] ?? (/* @__PURE__ */ new Date()).toUTCString().replace("GMT", "+0000"),
    messageId: headers["message-id"] ?? "",
    inReplyTo: headers["in-reply-to"] ?? "",
    references: headers["references"] ?? "",
    textBody,
    htmlBody,
    snippet,
    attachments: acc.attachments,
    headers
  };
}
function wrapBase64Lines(b64, lineLen = 76) {
  const clean = b64.replace(/\s+/g, "");
  const lines = [];
  for (let i = 0; i < clean.length; i += lineLen) {
    lines.push(clean.slice(i, i + lineLen));
  }
  return lines.join("\r\n");
}
function buildMimeMessage(email) {
  const boundaryAlt = `----=_NeonAlt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const boundaryMix = `----=_NeonMix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const domain = email.fromEmail.split("@")[1] ?? "neon-gmail.example";
  const msgId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}@${domain}>`;
  const formattedName = email.fromName ? formatDisplayName(email.fromName) : "";
  const fromHeader = formattedName ? `${formattedName} <${email.fromEmail}>` : `<${email.fromEmail}>`;
  const toHeader = email.to.length > 0 ? email.to.map((a) => assertNoCrlf(a, "To")).join(", ") : "undisclosed-recipients:;";
  const headers = [
    `Date: ${(/* @__PURE__ */ new Date()).toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${msgId}`,
    `From: ${fromHeader}`,
    `To: ${toHeader}`
  ];
  if (email.cc && email.cc.length > 0) {
    headers.push(`Cc: ${email.cc.map((a) => assertNoCrlf(a, "Cc")).join(", ")}`);
  }
  headers.push(`Subject: ${encodeRfc2047(email.subject || "(No Subject)")}`);
  if (email.inReplyTo) headers.push(`In-Reply-To: ${assertNoCrlf(email.inReplyTo, "In-Reply-To")}`);
  if (email.references) headers.push(`References: ${assertNoCrlf(email.references, "References")}`);
  headers.push("MIME-Version: 1.0");
  headers.push("X-Mailer: Neon Gmail WebClient/1.0");
  const textEncoded = wrapBase64Lines(bytesToBase64(new TextEncoder().encode(email.textBody || "")));
  const hasHtml = Boolean(email.htmlBody && email.htmlBody.trim().length > 0);
  const hasAttachments = Boolean(email.attachments && email.attachments.length > 0);
  const buildBodyContent = () => {
    if (!hasHtml) {
      return {
        contentType: 'text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64',
        body: textEncoded
      };
    }
    const htmlEncoded = wrapBase64Lines(bytesToBase64(new TextEncoder().encode(email.htmlBody)));
    return {
      contentType: `multipart/alternative; boundary="${boundaryAlt}"`,
      body: [
        `--${boundaryAlt}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        textEncoded,
        `--${boundaryAlt}`,
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        htmlEncoded,
        `--${boundaryAlt}--`
      ].join("\r\n")
    };
  };
  const inner = buildBodyContent();
  if (!hasAttachments) {
    headers.push(`Content-Type: ${inner.contentType}`);
    return `${headers.join("\r\n")}\r
\r
${inner.body}\r
`;
  }
  headers.push(`Content-Type: multipart/mixed; boundary="${boundaryMix}"`);
  const parts = [
    `--${boundaryMix}`,
    `Content-Type: ${inner.contentType}`,
    "",
    inner.body
  ];
  for (const att of email.attachments) {
    const safeName = assertNoCrlf(att.filename, "attachment filename").replace(/["\\]/g, "_");
    const rawType = assertNoCrlf(att.contentType || "application/octet-stream", "attachment contentType").trim();
    const safeType = MIME_TYPE_RE.test(rawType) ? rawType : "application/octet-stream";
    parts.push(
      `--${boundaryMix}`,
      `Content-Type: ${safeType}; name="${encodeRfc2047(safeName)}"`,
      `Content-Disposition: attachment; filename="${encodeRfc2047(safeName)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64Lines(att.dataBase64)
    );
  }
  parts.push(`--${boundaryMix}--`);
  return `${headers.join("\r\n")}\r
\r
${parts.join("\r\n")}\r
`;
}
function dotStuffSmtp(rawMime) {
  const normalized = rawMime.replace(/\r?\n/g, "\r\n");
  return normalized.replace(/(^|\r\n)\./g, "$1..");
}

// workers/mail-proxy/src/imap.ts
var SocketLineReader = class {
  chunks = [];
  totalLen = 0;
  reader;
  decoder = new TextDecoder("latin1");
  broken = false;
  constructor(readable) {
    this.reader = readable.getReader();
  }
  flatten() {
    if (this.chunks.length === 0) return new Uint8Array(0);
    if (this.chunks.length === 1) return this.chunks[0];
    const out = new Uint8Array(this.totalLen);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    this.chunks = [out];
    return out;
  }
  consume(n) {
    const flat = this.flatten();
    const head = flat.subarray(0, n);
    const rest = flat.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.totalLen = rest.length;
    return head;
  }
  async fill(timeoutMs = 15e3) {
    let timer;
    try {
      const result = await Promise.race([
        this.reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            this.broken = true;
            void this.reader.cancel().catch(() => {
            });
            reject(new Error("IMAP socket read timeout"));
          }, timeoutMs);
        })
      ]);
      if (result.done || !result.value) return false;
      this.chunks.push(result.value);
      this.totalLen += result.value.length;
      return true;
    } catch (e) {
      this.broken = true;
      throw e;
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  }
  async readLine(timeoutMs = 15e3) {
    while (true) {
      const flat = this.flatten();
      for (let i = 0; i < flat.length - 1; i++) {
        if (flat[i] === 13 && flat[i + 1] === 10) {
          const lineBytes = this.consume(i + 2).subarray(0, i);
          return this.decoder.decode(lineBytes);
        }
      }
      if (this.totalLen > 1024 * 1024) {
        this.broken = true;
        throw new Error("IMAP response line exceeded 1 MB safety limit.");
      }
      const more = await this.fill(timeoutMs);
      if (!more) {
        if (this.totalLen > 0) {
          return this.decoder.decode(this.consume(this.totalLen));
        }
        this.broken = true;
        throw new Error("IMAP connection closed unexpectedly.");
      }
    }
  }
  async readExact(byteLen, timeoutMs = 2e4) {
    while (this.totalLen < byteLen) {
      const more = await this.fill(timeoutMs);
      if (!more) {
        this.broken = true;
        throw new Error("IMAP connection closed while reading literal.");
      }
    }
    return this.decoder.decode(this.consume(byteLen));
  }
  release() {
    try {
      this.reader.releaseLock();
    } catch {
    }
  }
};
var ImapClient = class {
  socket;
  reader;
  writer;
  encoder = new TextEncoder();
  tagCounter = 0;
  config;
  allowCustomPorts;
  allowedHosts;
  broken = false;
  constructor(config, allowCustomPorts = false, allowedHosts) {
    this.config = config;
    this.allowCustomPorts = allowCustomPorts;
    this.allowedHosts = allowedHosts;
  }
  async connectAndLogin() {
    const host = validateMailHost(this.config.host, this.allowedHosts);
    const port = validateMailPort(this.config.port, this.allowCustomPorts);
    const tlsMode = this.config.tls ?? (port === 993 ? "tls" : "starttls");
    this.socket = connect(
      { hostname: host, port },
      { secureTransport: tlsMode === "tls" ? "on" : tlsMode === "starttls" ? "starttls" : "off", allowHalfOpen: false }
    );
    this.reader = new SocketLineReader(this.socket.readable);
    this.writer = this.socket.writable.getWriter();
    const greeting = await this.reader.readLine();
    if (!greeting.startsWith("* OK")) {
      this.broken = true;
      throw new Error(`Unexpected IMAP greeting: ${greeting.slice(0, 120)}`);
    }
    if (tlsMode === "starttls") {
      await this.command("STARTTLS");
      this.reader.release();
      this.writer.releaseLock();
      this.socket = this.socket.startTls();
      this.reader = new SocketLineReader(this.socket.readable);
      this.writer = this.socket.writable.getWriter();
    }
    assertNoCrlf(this.config.username, "username");
    assertNoCrlf(this.config.password, "password");
    await this.command(`LOGIN ${quoteImapString(this.config.username)} ${quoteImapString(this.config.password)}`);
    return greeting;
  }
  async command(cmd) {
    if (!this.reader || !this.writer) throw new Error("IMAP socket not connected.");
    const tag = `A${String(++this.tagCounter).padStart(4, "0")}`;
    await this.writer.write(this.encoder.encode(`${tag} ${cmd}\r
`));
    const entries = [];
    while (true) {
      const line = await this.reader.readLine();
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1);
        if (!status.startsWith("OK")) {
          throw new Error(`IMAP command failed: ${status.slice(0, 200)}`);
        }
        return { entries, status };
      }
      let fullLine = line;
      const entryLiterals = [];
      let litMatch = fullLine.match(/\{(\d+)\}$/);
      while (litMatch) {
        const size = Number(litMatch[1]);
        if (!Number.isInteger(size) || size < 0 || size > 25 * 1024 * 1024) {
          this.broken = true;
          throw new Error("IMAP literal size out of safe bounds.");
        }
        entryLiterals.push(await this.reader.readExact(size));
        const tail = await this.reader.readLine();
        fullLine = `${fullLine}
${tail}`;
        litMatch = tail.match(/\{(\d+)\}$/);
      }
      entries.push({ line: fullLine, literals: entryLiterals });
    }
  }
  async listMailboxes() {
    const res = await this.command('LIST "" "*"');
    const mailboxes = [];
    for (const entry of res.entries) {
      const firstLine = entry.line.split("\n")[0] ?? "";
      const m = firstLine.match(/^\* LIST \(([^)]*)\) (?:"([^"]*)"|NIL) (?:"((?:\\.|[^"\\])*)"|\{(\d+)\}|([^\s]+))$/i);
      if (!m) continue;
      const flags = (m[1] ?? "").split(/\s+/).filter(Boolean);
      const delimiter = m[2] ?? "/";
      const name = m[4] !== void 0 ? entry.literals[0] ?? "" : (m[3] ?? m[5] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      if (name && !flags.some((f) => f.toLowerCase() === "\\noselect")) {
        mailboxes.push({ name, flags, delimiter });
      }
    }
    return mailboxes;
  }
  async fetchMessages(folder, limit = 30, page = 1) {
    const safeFolder = validateFolderName(folder);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 30), 60);
    const safePage = Math.max(1, Number(page) || 1);
    await this.command(`SELECT ${quoteImapString(safeFolder)}`);
    const searchRes = await this.command("UID SEARCH ALL");
    const allUids = [];
    for (const entry of searchRes.entries) {
      if (!entry.line.startsWith("* SEARCH")) continue;
      const nums = entry.line.replace(/^\* SEARCH\s*/, "").trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      allUids.push(...nums);
    }
    const total = allUids.length;
    if (total === 0) return { total: 0, messages: [] };
    const newestFirst = [...allUids].reverse();
    const start = (safePage - 1) * safeLimit;
    const pageUids = newestFirst.slice(start, start + safeLimit);
    if (pageUids.length === 0) return { total, messages: [] };
    const fetchRes = await this.command(`UID FETCH ${pageUids.join(",")} (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])`);
    const messages = [];
    for (const entry of fetchRes.entries) {
      if (!/^\* \d+ FETCH /i.test(entry.line)) continue;
      const uidMatch = entry.line.match(/\bUID (\d+)/i);
      const flagsMatch = entry.line.match(/\bFLAGS \(([^)]*)\)/i);
      const sizeMatch = entry.line.match(/\bRFC822\.SIZE (\d+)/i);
      const dateMatch = entry.line.match(/\bINTERNALDATE "([^"]+)"/i);
      const rawMime = entry.literals.reduce((best, cur) => cur.length >= best.length ? cur : best, "");
      const parsed = parseMimeMessage(rawMime);
      messages.push({
        uid: uidMatch ? Number(uidMatch[1]) : 0,
        flags: (flagsMatch?.[1] ?? "").split(/\s+/).filter(Boolean),
        size: sizeMatch ? Number(sizeMatch[1]) : rawMime.length,
        internalDate: dateMatch?.[1] ?? parsed.date,
        subject: parsed.subject,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        date: parsed.date,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        textBody: parsed.textBody,
        htmlBody: parsed.htmlBody,
        snippet: parsed.snippet,
        attachments: parsed.attachments
      });
    }
    messages.sort((a, b) => b.uid - a.uid);
    return { total, messages };
  }
  async fetchSingleMessage(folder, uid) {
    const safeFolder = validateFolderName(folder);
    const [safeUid] = validateUids([uid]);
    await this.command(`SELECT ${quoteImapString(safeFolder)}`);
    const fetchRes = await this.command(`UID FETCH ${safeUid} (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])`);
    const entry = fetchRes.entries.find((e) => /^\* \d+ FETCH /i.test(e.line));
    if (!entry) return null;
    const rawMime = entry.literals.reduce((best, cur) => cur.length >= best.length ? cur : best, "");
    const flagsMatch = entry.line.match(/\bFLAGS \(([^)]*)\)/i);
    const sizeMatch = entry.line.match(/\bRFC822\.SIZE (\d+)/i);
    const dateMatch = entry.line.match(/\bINTERNALDATE "([^"]+)"/i);
    const parsed = parseMimeMessage(rawMime);
    return {
      uid: safeUid,
      flags: (flagsMatch?.[1] ?? "").split(/\s+/).filter(Boolean),
      size: sizeMatch ? Number(sizeMatch[1]) : rawMime.length,
      internalDate: dateMatch?.[1] ?? parsed.date,
      subject: parsed.subject,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      date: parsed.date,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      textBody: parsed.textBody,
      htmlBody: parsed.htmlBody,
      snippet: parsed.snippet,
      attachments: parsed.attachments,
      raw: rawMime
    };
  }
  async updateFlags(folder, uids, op, flags) {
    const safeFolder = validateFolderName(folder);
    const safeUids = validateUids(uids);
    const allowedFlags = /* @__PURE__ */ new Set(["\\Seen", "\\Flagged", "\\Answered", "\\Draft", "\\Deleted"]);
    const cleanFlags = flags.filter((f) => allowedFlags.has(f));
    if (cleanFlags.length === 0) throw new Error("No valid IMAP flags specified.");
    await this.command(`SELECT ${quoteImapString(safeFolder)}`);
    const mode = op === "add" ? "+FLAGS.SILENT" : "-FLAGS.SILENT";
    await this.command(`UID STORE ${safeUids.join(",")} ${mode} (${cleanFlags.join(" ")})`);
  }
  async moveMessages(folder, uids, targetFolder) {
    const safeFolder = validateFolderName(folder);
    const safeTarget = validateFolderName(targetFolder);
    const safeUids = validateUids(uids);
    await this.command(`SELECT ${quoteImapString(safeFolder)}`);
    const uidSet = safeUids.join(",");
    try {
      await this.command(`UID MOVE ${uidSet} ${quoteImapString(safeTarget)}`);
    } catch {
      await this.command(`UID COPY ${uidSet} ${quoteImapString(safeTarget)}`);
      await this.command(`UID STORE ${uidSet} +FLAGS.SILENT (\\Deleted)`);
      try {
        await this.command(`UID EXPUNGE ${uidSet}`);
      } catch {
        await this.command("EXPUNGE");
      }
    }
  }
  async deleteMessages(folder, uids, expunge = true) {
    const safeFolder = validateFolderName(folder);
    const safeUids = validateUids(uids);
    const uidSet = safeUids.join(",");
    await this.command(`SELECT ${quoteImapString(safeFolder)}`);
    await this.command(`UID STORE ${uidSet} +FLAGS.SILENT (\\Deleted)`);
    if (expunge) {
      try {
        await this.command(`UID EXPUNGE ${uidSet}`);
      } catch {
        await this.command("EXPUNGE");
      }
    }
  }
  async close() {
    if (!this.broken && !this.reader?.broken && this.writer) {
      try {
        await this.command("LOGOUT");
      } catch {
      }
    }
    try {
      this.reader?.release();
      this.writer?.releaseLock();
      await this.socket?.close();
    } catch {
    }
  }
};

// workers/mail-proxy/src/smtp.ts
import { connect as connect2 } from "cloudflare:sockets";
var SmtpLineReader = class {
  chunks = [];
  totalLen = 0;
  reader;
  decoder = new TextDecoder("utf-8");
  broken = false;
  constructor(readable) {
    this.reader = readable.getReader();
  }
  flatten() {
    if (this.chunks.length === 0) return new Uint8Array(0);
    if (this.chunks.length === 1) return this.chunks[0];
    const out = new Uint8Array(this.totalLen);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    this.chunks = [out];
    return out;
  }
  consume(n) {
    const flat = this.flatten();
    const head = flat.subarray(0, n);
    const rest = flat.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.totalLen = rest.length;
    return head;
  }
  async fill(timeoutMs = 15e3) {
    let timer;
    try {
      const result = await Promise.race([
        this.reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            this.broken = true;
            void this.reader.cancel().catch(() => {
            });
            reject(new Error("SMTP socket read timeout"));
          }, timeoutMs);
        })
      ]);
      if (result.done || !result.value) return false;
      this.chunks.push(result.value);
      this.totalLen += result.value.length;
      return true;
    } catch (e) {
      this.broken = true;
      throw e;
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  }
  async readLine() {
    while (true) {
      const flat = this.flatten();
      for (let i = 0; i < flat.length; i++) {
        if (flat[i] === 10) {
          const end = i > 0 && flat[i - 1] === 13 ? i - 1 : i;
          const line = this.decoder.decode(this.consume(i + 1).subarray(0, end));
          return line;
        }
      }
      if (this.totalLen > 256 * 1024) {
        this.broken = true;
        throw new Error("SMTP response line exceeded limit.");
      }
      const more = await this.fill();
      if (!more) {
        this.broken = true;
        throw new Error("SMTP connection closed unexpectedly.");
      }
    }
  }
  async readResponse() {
    const lines = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      const m = line.match(/^(\d{3})(?:([ -]).*)?$/);
      if (!m) {
        throw new Error(`Malformed SMTP response: ${line.slice(0, 120)}`);
      }
      if (m[2] !== "-") {
        return { code: Number(m[1]), lines };
      }
    }
  }
  release() {
    try {
      this.reader.releaseLock();
    } catch {
    }
  }
};
async function sendSmtpEmail(config, email, allowCustomPorts = false, allowedHosts) {
  const host = validateMailHost(config.host, allowedHosts);
  const port = validateMailPort(config.port, allowCustomPorts);
  const tlsMode = config.tls ?? (port === 465 ? "tls" : "starttls");
  const fromEmail = validateEmailAddress(email.fromEmail, "fromEmail");
  const toList = email.to.map((addr) => validateEmailAddress(addr, "to"));
  const ccList = (email.cc ?? []).map((addr) => validateEmailAddress(addr, "cc"));
  const bccList = (email.bcc ?? []).map((addr) => validateEmailAddress(addr, "bcc"));
  const allRecipients = [.../* @__PURE__ */ new Set([...toList, ...ccList, ...bccList])];
  if (allRecipients.length === 0) {
    throw new Error("At least one valid recipient (To, Cc, or Bcc) is required.");
  }
  assertNoCrlf(config.username, "SMTP username");
  assertNoCrlf(config.password, "SMTP password");
  let socket = connect2(
    { hostname: host, port },
    { secureTransport: tlsMode === "tls" ? "on" : tlsMode === "starttls" ? "starttls" : "off", allowHalfOpen: false }
  );
  let reader = new SmtpLineReader(socket.readable);
  let writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  const rawCmd = async (cmd) => {
    await writer.write(encoder.encode(`${cmd}\r
`));
    return reader.readResponse();
  };
  const sendCmd = async (cmd, expectedCodes) => {
    const resp = await rawCmd(cmd);
    if (!expectedCodes.includes(resp.code)) {
      throw new Error(`SMTP error (${resp.code}): ${resp.lines.join(" ").slice(0, 200)}`);
    }
    return resp;
  };
  try {
    const greeting = await reader.readResponse();
    if (greeting.code !== 220) {
      throw new Error(`Unexpected SMTP greeting (${greeting.code})`);
    }
    let ehloResp = await sendCmd("EHLO [127.0.0.1]", [250]);
    if (tlsMode === "starttls") {
      await sendCmd("STARTTLS", [220]);
      reader.release();
      writer.releaseLock();
      socket = socket.startTls();
      reader = new SmtpLineReader(socket.readable);
      writer = socket.writable.getWriter();
      ehloResp = await sendCmd("EHLO [127.0.0.1]", [250]);
    }
    const ehloText = ehloResp.lines.join(" ").toUpperCase();
    const prefersLoginOnly = ehloText.includes("AUTH") && !ehloText.includes("PLAIN") && ehloText.includes("LOGIN");
    const doAuthLogin = async () => {
      await sendCmd("AUTH LOGIN", [334]);
      await sendCmd(bytesToBase64(encoder.encode(config.username)), [334]);
      await sendCmd(bytesToBase64(encoder.encode(config.password)), [235]);
    };
    if (prefersLoginOnly) {
      await doAuthLogin();
    } else {
      const plainB64 = bytesToBase64(encoder.encode(`\0${config.username}\0${config.password}`));
      const plainResp = await rawCmd(`AUTH PLAIN ${plainB64}`);
      if (plainResp.code !== 235) {
        if (plainResp.code === 500 || plainResp.code === 502 || plainResp.code === 504) {
          await doAuthLogin();
        } else {
          throw new Error(`SMTP authentication failed (${plainResp.code}): ${plainResp.lines.join(" ").slice(0, 200)}`);
        }
      }
    }
    await sendCmd(`MAIL FROM:<${fromEmail}>`, [250]);
    for (const rcpt of allRecipients) {
      await sendCmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    }
    await sendCmd("DATA", [354]);
    const rawMime = buildMimeMessage({
      ...email,
      fromEmail,
      to: toList,
      cc: ccList,
      bcc: bccList
    });
    const payload = `${dotStuffSmtp(rawMime)}\r
.\r
`;
    await writer.write(encoder.encode(payload));
    const dataResp = await reader.readResponse();
    if (dataResp.code !== 250) {
      throw new Error(`SMTP DATA rejected (${dataResp.code}): ${dataResp.lines.join(" ").slice(0, 200)}`);
    }
    if (!reader.broken) {
      try {
        await sendCmd("QUIT", [221, 250]);
      } catch {
      }
    }
    return { ok: true, serverResponse: dataResp.lines.join(" ") };
  } finally {
    try {
      reader.release();
      writer.releaseLock();
      await socket.close();
    } catch {
    }
  }
}

// workers/mail-proxy/src/index.ts
var MAX_BODY_BYTES = 15 * 1024 * 1024;
var HttpError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}
async function parseJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request payload exceeds 15 MB limit.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request payload exceeds 15 MB limit.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON payload.");
  }
}
function resolveRoute(url) {
  const action = url.searchParams.get("action");
  if (action) {
    const map = {
      health: "/health",
      test: "/api/test",
      imap_mailboxes: "/api/imap/mailboxes",
      imap_messages: "/api/imap/messages",
      imap_message: "/api/imap/message",
      imap_flags: "/api/imap/flags",
      imap_move: "/api/imap/move",
      imap_delete: "/api/imap/delete",
      smtp_send: "/api/smtp/send"
    };
    if (map[action]) return map[action];
  }
  return url.pathname.replace(/\/+$/, "") || "/";
}
var index_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const route = resolveRoute(url);
    if (request.method === "GET" && (route === "/" || route === "/health")) {
      return jsonResponse({
        ok: true,
        service: "neon-gmail-proxy",
        engine: "cloudflare-workers",
        protocols: ["imap", "smtp"],
        cors: "*",
        version: "1.0.0"
      });
    }
    if (env.PROXY_AUTH_TOKEN) {
      const provided = request.headers.get("X-Proxy-Token") ?? "";
      if (!provided || !timingSafeEqual(provided, env.PROXY_AUTH_TOKEN)) {
        return jsonResponse({ ok: false, error: "Unauthorized: invalid or missing X-Proxy-Token." }, 401);
      }
    }
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed. Use POST." }, 405);
    }
    const allowCustomPorts = env.ALLOW_CUSTOM_PORTS === "true";
    const allowedHosts = env.ALLOWED_MAIL_HOSTS ? new Set(env.ALLOWED_MAIL_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)) : void 0;
    try {
      if (route === "/api/test") {
        const body = await parseJsonBody(request);
        const started = Date.now();
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          const greeting = await client.connectAndLogin();
          const mailboxes = await client.listMailboxes();
          return jsonResponse({
            ok: true,
            greeting,
            mailboxes,
            latencyMs: Date.now() - started
          });
        } finally {
          await client.close();
        }
      }
      if (route === "/api/imap/mailboxes") {
        const body = await parseJsonBody(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          const mailboxes = await client.listMailboxes();
          return jsonResponse({ ok: true, mailboxes });
        } finally {
          await client.close();
        }
      }
      if (route === "/api/imap/messages") {
        const body = await parseJsonBody(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          const result = await client.fetchMessages(body.folder || "INBOX", body.limit ?? 30, body.page ?? 1);
          return jsonResponse({ ok: true, ...result });
        } finally {
          await client.close();
        }
      }
      if (route === "/api/imap/message") {
        const body = await parseJsonBody(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          const message = await client.fetchSingleMessage(body.folder || "INBOX", body.uid);
          if (!message) return jsonResponse({ ok: false, error: "Message not found." }, 404);
          return jsonResponse({ ok: true, message });
        } finally {
          await client.close();
        }
      }
      if (route === "/api/imap/flags") {
        const body = await parseJsonBody(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          await client.updateFlags(body.folder || "INBOX", body.uids, body.op, body.flags);
          return jsonResponse({ ok: true });
        } finally {
          await client.close();
        }
      }
      if (route === "/api/imap/move") {
        const body = await parseJsonBody(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          await client.moveMessages(body.folder || "INBOX", body.uids, body.targetFolder);
          return jsonResponse({ ok: true });
        } finally {
          await client.close();
        }
      }
      if (route === "/api/imap/delete") {
        const body = await parseJsonBody(request);
        const client = new ImapClient(body.imap, allowCustomPorts, allowedHosts);
        try {
          await client.connectAndLogin();
          await client.deleteMessages(body.folder || "INBOX", body.uids, body.expunge ?? true);
          return jsonResponse({ ok: true });
        } finally {
          await client.close();
        }
      }
      if (route === "/api/smtp/send") {
        const body = await parseJsonBody(request);
        const result = await sendSmtpEmail(body.smtp, body.message, allowCustomPorts, allowedHosts);
        return jsonResponse(result);
      }
      return jsonResponse({ ok: false, error: `Unknown endpoint: ${route}` }, 404);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      return jsonResponse({ ok: false, error: sanitizeErrorMessage(err) }, status);
    }
  }
};
export {
  index_default as default
};
