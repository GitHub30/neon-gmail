import { connect } from 'cloudflare:sockets';
import { buildMimeMessage, bytesToBase64, dotStuffSmtp, type OutgoingEmail } from './mime.ts';
import { assertNoCrlf, validateEmailAddress, validateMailHost, validateMailPort } from './security.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  tls?: 'tls' | 'starttls' | 'none';
  username: string;
  password: string;
}

class SmtpLineReader {
  private chunks: Uint8Array[] = [];
  private totalLen = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder('utf-8');
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
            reject(new Error('SMTP socket read timeout'));
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

  async readLine(): Promise<string> {
    while (true) {
      const flat = this.flatten();
      for (let i = 0; i < flat.length; i++) {
        if (flat[i] === 0x0a) {
          const end = i > 0 && flat[i - 1] === 0x0d ? i - 1 : i;
          const line = this.decoder.decode(this.consume(i + 1).subarray(0, end));
          return line;
        }
      }
      if (this.totalLen > 256 * 1024) {
        this.broken = true;
        throw new Error('SMTP response line exceeded limit.');
      }
      const more = await this.fill();
      if (!more) {
        this.broken = true;
        throw new Error('SMTP connection closed unexpectedly.');
      }
    }
  }

  async readResponse(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      lines.push(line);
      const m = line.match(/^(\d{3})(?:([ -]).*)?$/);
      if (!m) {
        throw new Error(`Malformed SMTP response: ${line.slice(0, 120)}`);
      }
      if (m[2] !== '-') {
        return { code: Number(m[1]), lines };
      }
    }
  }

  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

export async function sendSmtpEmail(
  config: SmtpConfig,
  email: OutgoingEmail,
  allowCustomPorts = false,
  allowedHosts?: Set<string>,
): Promise<{ ok: true; serverResponse: string }> {
  const host = validateMailHost(config.host, allowedHosts);
  const port = validateMailPort(config.port, allowCustomPorts);
  const tlsMode = config.tls ?? (port === 465 ? 'tls' : 'starttls');

  const fromEmail = validateEmailAddress(email.fromEmail, 'fromEmail');
  const toList = email.to.map((addr) => validateEmailAddress(addr, 'to'));
  const ccList = (email.cc ?? []).map((addr) => validateEmailAddress(addr, 'cc'));
  const bccList = (email.bcc ?? []).map((addr) => validateEmailAddress(addr, 'bcc'));
  const allRecipients = [...new Set([...toList, ...ccList, ...bccList])];
  if (allRecipients.length === 0) {
    throw new Error('At least one valid recipient (To, Cc, or Bcc) is required.');
  }

  assertNoCrlf(config.username, 'SMTP username');
  assertNoCrlf(config.password, 'SMTP password');

  let socket = connect(
    { hostname: host, port },
    { secureTransport: tlsMode === 'tls' ? 'on' : tlsMode === 'starttls' ? 'starttls' : 'off', allowHalfOpen: false },
  );
  socket.opened?.catch(() => {});
  socket.closed.catch(() => {});
  let reader = new SmtpLineReader(socket.readable);
  let writer = socket.writable.getWriter();
  const encoder = new TextEncoder();

  const rawCmd = async (cmd: string) => {
    await writer.write(encoder.encode(`${cmd}\r\n`));
    return reader.readResponse();
  };

  const sendCmd = async (cmd: string, expectedCodes: number[]) => {
    const resp = await rawCmd(cmd);
    if (!expectedCodes.includes(resp.code)) {
      throw new Error(`SMTP error (${resp.code}): ${resp.lines.join(' ').slice(0, 200)}`);
    }
    return resp;
  };

  try {
    const greeting = await reader.readResponse();
    if (greeting.code !== 220) {
      throw new Error(`Unexpected SMTP greeting (${greeting.code})`);
    }

    let ehloResp = await sendCmd('EHLO [127.0.0.1]', [250]);

    if (tlsMode === 'starttls') {
      await sendCmd('STARTTLS', [220]);
      reader.release();
      writer.releaseLock();
      socket = socket.startTls();
      socket.opened?.catch(() => {});
      socket.closed.catch(() => {});
      reader = new SmtpLineReader(socket.readable);
      writer = socket.writable.getWriter();
      ehloResp = await sendCmd('EHLO [127.0.0.1]', [250]);
    }

    const ehloText = ehloResp.lines.join(' ').toUpperCase();
    const prefersLoginOnly = ehloText.includes('AUTH') && !ehloText.includes('PLAIN') && ehloText.includes('LOGIN');

    const doAuthLogin = async () => {
      await sendCmd('AUTH LOGIN', [334]);
      await sendCmd(bytesToBase64(encoder.encode(config.username)), [334]);
      await sendCmd(bytesToBase64(encoder.encode(config.password)), [235]);
    };

    if (prefersLoginOnly) {
      await doAuthLogin();
    } else {
      const plainB64 = bytesToBase64(encoder.encode(`\0${config.username}\0${config.password}`));
      const plainResp = await rawCmd(`AUTH PLAIN ${plainB64}`);
      if (plainResp.code !== 235) {
        // Only fall back to AUTH LOGIN if PLAIN mechanism is unsupported (500/502/504), NEVER on 535 bad credentials
        if (plainResp.code === 500 || plainResp.code === 502 || plainResp.code === 504) {
          await doAuthLogin();
        } else {
          throw new Error(`SMTP authentication failed (${plainResp.code}): ${plainResp.lines.join(' ').slice(0, 200)}`);
        }
      }
    }

    await sendCmd(`MAIL FROM:<${fromEmail}>`, [250]);
    for (const rcpt of allRecipients) {
      await sendCmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    }

    await sendCmd('DATA', [354]);
    const rawMime = buildMimeMessage({
      ...email,
      fromEmail,
      to: toList,
      cc: ccList,
      bcc: bccList,
    });
    const payload = `${dotStuffSmtp(rawMime)}\r\n.\r\n`;
    await writer.write(encoder.encode(payload));
    const dataResp = await reader.readResponse();
    if (dataResp.code !== 250) {
      throw new Error(`SMTP DATA rejected (${dataResp.code}): ${dataResp.lines.join(' ').slice(0, 200)}`);
    }

    if (!reader.broken) {
      try {
        await sendCmd('QUIT', [221, 250]);
      } catch {
        // ignore quit errors
      }
    }

    return { ok: true, serverResponse: dataResp.lines.join(' ') };
  } finally {
    try {
      reader.release();
      writer.releaseLock();
      await socket.close();
    } catch {
      // ignore
    }
  }
}
