import { connect } from 'cloudflare:sockets';
import { parseMimeMessage } from './mime.ts';
import { assertNoCrlf, quoteImapString, validateFolderName, validateMailHost, validateMailPort, validateUids } from './security.ts';

export interface ImapConfig {
  host: string;
  port: number;
  tls?: 'tls' | 'starttls' | 'none';
  username: string;
  password: string;
}

export interface ImapMailboxInfo {
  name: string;
  flags: string[];
  delimiter: string;
}

export interface ImapFetchedMessage {
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
    contentId?: string;
    dataBase64: string;
  }>;
  raw?: string;
}

interface UntaggedEntry {
  line: string;
  literals: string[];
}

class SocketLineReader {
  private chunks: Uint8Array[] = [];
  private totalLen = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder('latin1');
  broken = false;

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  private flatten(): Uint8Array {
    if (this.chunks.length === 0) return new Uint8Array(0);
    if (this.chunks.length === 1) return this.chunks[0]!;
    const out = new Uint8Array(this.totalLen);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    this.chunks = [out];
    return out;
  }

  private consume(n: number): Uint8Array {
    const flat = this.flatten();
    const head = flat.subarray(0, n);
    const rest = flat.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.totalLen = rest.length;
    return head;
  }

  private async fill(timeoutMs = 15000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.broken = true;
            void this.reader.cancel().catch(() => {});
            reject(new Error('IMAP socket read timeout'));
          }, timeoutMs);
        }),
      ]);
      if (result.done || !result.value) return false;
      this.chunks.push(result.value);
      this.totalLen += result.value.length;
      return true;
    } catch (e) {
      this.broken = true;
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async readLine(timeoutMs = 15000): Promise<string> {
    while (true) {
      const flat = this.flatten();
      for (let i = 0; i < flat.length - 1; i++) {
        if (flat[i] === 0x0d && flat[i + 1] === 0x0a) {
          const lineBytes = this.consume(i + 2).subarray(0, i);
          return this.decoder.decode(lineBytes);
        }
      }
      if (this.totalLen > 1024 * 1024) {
        this.broken = true;
        throw new Error('IMAP response line exceeded 1 MB safety limit.');
      }
      const more = await this.fill(timeoutMs);
      if (!more) {
        if (this.totalLen > 0) {
          return this.decoder.decode(this.consume(this.totalLen));
        }
        this.broken = true;
        throw new Error('IMAP connection closed unexpectedly.');
      }
    }
  }

  async readExact(byteLen: number, timeoutMs = 20000): Promise<string> {
    while (this.totalLen < byteLen) {
      const more = await this.fill(timeoutMs);
      if (!more) {
        this.broken = true;
        throw new Error('IMAP connection closed while reading literal.');
      }
    }
    return this.decoder.decode(this.consume(byteLen));
  }

  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

export class ImapClient {
  private socket?: ReturnType<typeof connect>;
  private reader?: SocketLineReader;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private tagCounter = 0;
  private config: ImapConfig;
  private allowCustomPorts: boolean;
  private allowedHosts?: Set<string>;
  private broken = false;

  constructor(config: ImapConfig, allowCustomPorts = false, allowedHosts?: Set<string>) {
    this.config = config;
    this.allowCustomPorts = allowCustomPorts;
    this.allowedHosts = allowedHosts;
  }

  async connectAndLogin(): Promise<string> {
    const host = validateMailHost(this.config.host, this.allowedHosts);
    const port = validateMailPort(this.config.port, this.allowCustomPorts);
    const tlsMode = this.config.tls ?? (port === 993 ? 'tls' : 'starttls');

    this.socket = connect(
      { hostname: host, port },
      { secureTransport: tlsMode === 'tls' ? 'on' : tlsMode === 'starttls' ? 'starttls' : 'off', allowHalfOpen: false },
    );
    this.reader = new SocketLineReader(this.socket.readable);
    this.writer = this.socket.writable.getWriter();

    const greeting = await this.reader.readLine();
    if (!greeting.startsWith('* OK')) {
      this.broken = true;
      throw new Error(`Unexpected IMAP greeting: ${greeting.slice(0, 120)}`);
    }

    if (tlsMode === 'starttls') {
      await this.command('STARTTLS');
      this.reader.release();
      this.writer.releaseLock();
      this.socket = this.socket.startTls();
      this.reader = new SocketLineReader(this.socket.readable);
      this.writer = this.socket.writable.getWriter();
    }

    assertNoCrlf(this.config.username, 'username');
    assertNoCrlf(this.config.password, 'password');

    await this.command(`LOGIN ${quoteImapString(this.config.username)} ${quoteImapString(this.config.password)}`);
    return greeting;
  }

  async command(cmd: string): Promise<{ entries: UntaggedEntry[]; status: string }> {
    if (!this.reader || !this.writer) throw new Error('IMAP socket not connected.');
    const tag = `A${String(++this.tagCounter).padStart(4, '0')}`;
    await this.writer.write(this.encoder.encode(`${tag} ${cmd}\r\n`));

    const entries: UntaggedEntry[] = [];

    while (true) {
      const line = await this.reader.readLine();
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1);
        if (!status.startsWith('OK')) {
          throw new Error(`IMAP command failed: ${status.slice(0, 200)}`);
        }
        return { entries, status };
      }

      // Pair each untagged response with its own literals array (eliminates index desync!)
      let fullLine = line;
      const entryLiterals: string[] = [];
      let litMatch = fullLine.match(/\{(\d+)\}$/);
      while (litMatch) {
        const size = Number(litMatch[1]);
        if (!Number.isInteger(size) || size < 0 || size > 25 * 1024 * 1024) {
          this.broken = true;
          throw new Error('IMAP literal size out of safe bounds.');
        }
        entryLiterals.push(await this.reader.readExact(size));
        const tail = await this.reader.readLine();
        fullLine = `${fullLine}\n${tail}`;
        litMatch = tail.match(/\{(\d+)\}$/);
      }
      entries.push({ line: fullLine, literals: entryLiterals });
    }
  }

  async listMailboxes(): Promise<ImapMailboxInfo[]> {
    const res = await this.command('LIST "" "*"');
    const mailboxes: ImapMailboxInfo[] = [];
    for (const entry of res.entries) {
      const firstLine = entry.line.split('\n')[0] ?? '';
      const m = firstLine.match(/^\* LIST \(([^)]*)\) (?:"([^"]*)"|NIL) (?:"((?:\\.|[^"\\])*)"|\{(\d+)\}|([^\s]+))$/i);
      if (!m) continue;
      const flags = (m[1] ?? '').split(/\s+/).filter(Boolean);
      const delimiter = m[2] ?? '/';
      const name = m[4] !== undefined
        ? (entry.literals[0] ?? '')
        : (m[3] ?? m[5] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (name && !flags.some((f) => f.toLowerCase() === '\\noselect')) {
        mailboxes.push({ name, flags, delimiter });
      }
    }
    return mailboxes;
  }

  async fetchMessages(folder: string, limit = 30, page = 1): Promise<{ total: number; messages: ImapFetchedMessage[] }> {
    const safeFolder = validateFolderName(folder);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 30), 60);
    const safePage = Math.max(1, Number(page) || 1);

    await this.command(`SELECT ${quoteImapString(safeFolder)}`);
    const searchRes = await this.command('UID SEARCH ALL');
    const allUids: number[] = [];
    for (const entry of searchRes.entries) {
      if (!entry.line.startsWith('* SEARCH')) continue;
      const nums = entry.line
        .replace(/^\* SEARCH\s*/, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      allUids.push(...nums);
    }

    const total = allUids.length;
    if (total === 0) return { total: 0, messages: [] };

    const newestFirst = [...allUids].reverse();
    const start = (safePage - 1) * safeLimit;
    const pageUids = newestFirst.slice(start, start + safeLimit);
    if (pageUids.length === 0) return { total, messages: [] };

    const fetchRes = await this.command(`UID FETCH ${pageUids.join(',')} (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])`);

    const messages: ImapFetchedMessage[] = [];
    for (const entry of fetchRes.entries) {
      if (!/^\* \d+ FETCH /i.test(entry.line)) continue;
      const uidMatch = entry.line.match(/\bUID (\d+)/i);
      const flagsMatch = entry.line.match(/\bFLAGS \(([^)]*)\)/i);
      const sizeMatch = entry.line.match(/\bRFC822\.SIZE (\d+)/i);
      const dateMatch = entry.line.match(/\bINTERNALDATE "([^"]+)"/i);

      // Select largest literal as the BODY[] payload cleanly paired with this FETCH entry
      const rawMime = entry.literals.reduce((best, cur) => (cur.length >= best.length ? cur : best), '');
      const parsed = parseMimeMessage(rawMime);

      messages.push({
        uid: uidMatch ? Number(uidMatch[1]) : 0,
        flags: (flagsMatch?.[1] ?? '').split(/\s+/).filter(Boolean),
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
      });
    }

    messages.sort((a, b) => b.uid - a.uid);
    return { total, messages };
  }

  async fetchSingleMessage(folder: string, uid: number): Promise<ImapFetchedMessage | null> {
    const safeFolder = validateFolderName(folder);
    const [safeUid] = validateUids([uid]);
    await this.command(`SELECT ${quoteImapString(safeFolder)}`);
    const fetchRes = await this.command(`UID FETCH ${safeUid} (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[])`);
    const entry = fetchRes.entries.find((e) => /^\* \d+ FETCH /i.test(e.line));
    if (!entry) return null;

    const rawMime = entry.literals.reduce((best, cur) => (cur.length >= best.length ? cur : best), '');
    const flagsMatch = entry.line.match(/\bFLAGS \(([^)]*)\)/i);
    const sizeMatch = entry.line.match(/\bRFC822\.SIZE (\d+)/i);
    const dateMatch = entry.line.match(/\bINTERNALDATE "([^"]+)"/i);
    const parsed = parseMimeMessage(rawMime);

    return {
      uid: safeUid!,
      flags: (flagsMatch?.[1] ?? '').split(/\s+/).filter(Boolean),
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
      raw: rawMime,
    };
  }

  async updateFlags(folder: string, uids: number[], op: 'add' | 'remove', flags: string[]): Promise<void> {
    const safeFolder = validateFolderName(folder);
    const safeUids = validateUids(uids);
    const allowedFlags = new Set(['\\Seen', '\\Flagged', '\\Answered', '\\Draft', '\\Deleted']);
    const cleanFlags = flags.filter((f) => allowedFlags.has(f));
    if (cleanFlags.length === 0) throw new Error('No valid IMAP flags specified.');

    await this.command(`SELECT ${quoteImapString(safeFolder)}`);
    const mode = op === 'add' ? '+FLAGS.SILENT' : '-FLAGS.SILENT';
    await this.command(`UID STORE ${safeUids.join(',')} ${mode} (${cleanFlags.join(' ')})`);
  }

  async moveMessages(folder: string, uids: number[], targetFolder: string): Promise<void> {
    const safeFolder = validateFolderName(folder);
    const safeTarget = validateFolderName(targetFolder);
    const safeUids = validateUids(uids);
    await this.command(`SELECT ${quoteImapString(safeFolder)}`);
    const uidSet = safeUids.join(',');
    try {
      await this.command(`UID MOVE ${uidSet} ${quoteImapString(safeTarget)}`);
    } catch {
      await this.command(`UID COPY ${uidSet} ${quoteImapString(safeTarget)}`);
      await this.command(`UID STORE ${uidSet} +FLAGS.SILENT (\\Deleted)`);
      try {
        await this.command(`UID EXPUNGE ${uidSet}`);
      } catch {
        await this.command('EXPUNGE');
      }
    }
  }

  async deleteMessages(folder: string, uids: number[], expunge = true): Promise<void> {
    const safeFolder = validateFolderName(folder);
    const safeUids = validateUids(uids);
    const uidSet = safeUids.join(',');
    await this.command(`SELECT ${quoteImapString(safeFolder)}`);
    await this.command(`UID STORE ${uidSet} +FLAGS.SILENT (\\Deleted)`);
    if (expunge) {
      try {
        await this.command(`UID EXPUNGE ${uidSet}`);
      } catch {
        await this.command('EXPUNGE');
      }
    }
  }

  async close(): Promise<void> {
    if (!this.broken && !this.reader?.broken && this.writer) {
      try {
        await this.command('LOGOUT');
      } catch {
        // ignore
      }
    }
    try {
      this.reader?.release();
      this.writer?.releaseLock();
      await this.socket?.close();
    } catch {
      // ignore
    }
  }
}
