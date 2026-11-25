import { describe, it, expect } from 'vitest';
import { buildMimeMessage, decodeRfc2047, dotStuffSmtp, encodeRfc2047, parseMimeMessage } from '../workers/mail-proxy/src/mime.ts';

describe('RFC5322 & RFC2047 MIME Parser / Builder', () => {
  it('encodes and decodes UTF-8 Japanese RFC2047 headers cleanly', () => {
    const original = '【重要】Neon Gmail リリース案内';
    const encoded = encodeRfc2047(original);
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
    expect(decodeRfc2047(encoded)).toBe(original);
  });

  it('builds and parses multipart/mixed MIME with HTML, text, and attachments', () => {
    const raw = buildMimeMessage({
      fromName: '高橋 みなみ',
      fromEmail: 'minami@example.com',
      to: ['alex@example.com'],
      cc: ['team@example.com'],
      subject: 'テストメール件名',
      textBody: 'こんにちは\nテスト本文です。',
      htmlBody: '<p>こんにちは</p><p><strong>テスト本文</strong>です。</p>',
      attachments: [
        {
          filename: 'notes.txt',
          contentType: 'text/plain',
          dataBase64: btoa('Hello attachment!'),
        },
      ],
    });

    const parsed = parseMimeMessage(raw);
    expect(parsed.subject).toBe('テストメール件名');
    expect(parsed.from).toContain('高橋 みなみ');
    expect(parsed.from).toContain('minami@example.com');
    expect(parsed.textBody).toContain('テスト本文です。');
    expect(parsed.htmlBody).toContain('<strong>テスト本文</strong>');
    expect(parsed.attachments.length).toBe(1);
    expect(parsed.attachments[0]!.filename).toBe('notes.txt');
    expect(atob(parsed.attachments[0]!.dataBase64)).toBe('Hello attachment!');
  });

  it('dot-stuffs leading dots for RFC5321 SMTP DATA safety', () => {
    const stuffed = dotStuffSmtp('Line 1\n.hidden\r\n..already\nNormal');
    expect(stuffed).toBe('Line 1\r\n..hidden\r\n...already\r\nNormal');
  });

  it('splits long RFC2047 subjects <=75 chars, quotes RFC5322 fromName specials, and handles Bcc-only & RFC2231 filenames', () => {
    const longJp = '非常に長い日本語の件名テスト文字列でRFC2047の75文字上限を超えない分割を検証します。';
    const encoded = encodeRfc2047(longJp);
    for (const word of encoded.split(' ')) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeRfc2047(encoded)).toBe(longJp);

    const bccOnlyRaw = buildMimeMessage({
      fromName: 'Acme, Inc.',
      fromEmail: 'news@acme.example',
      to: [],
      bcc: ['hidden@example.com'],
      subject: 'Announcement',
      textBody: 'Hi all',
    });
    expect(bccOnlyRaw).toContain('From: "Acme, Inc." <news@acme.example>');
    expect(bccOnlyRaw).toContain('To: undisclosed-recipients:;');

    const rfc2231Raw = [
      'From: sender@example.com',
      'To: user@example.com',
      'Subject: File',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'See attached',
      '--b1',
      'Content-Type: application/pdf',
      "Content-Disposition: attachment; filename*=UTF-8''%E8%AB%8B%E6%B1%82%E6%9B%B8.pdf",
      'Content-Transfer-Encoding: base64',
      '',
      btoa('%PDF-1.4'),
      '--b1--',
    ].join('\r\n');
    const parsed = parseMimeMessage(rfc2231Raw);
    expect(parsed.attachments[0]?.filename).toBe('請求書.pdf');
  });
});
