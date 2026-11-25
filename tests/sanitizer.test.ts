import { describe, it, expect } from 'vitest';
import { escapeHtml, plainTextToSafeHtml, sanitizeEmailHtml } from '../src/core/sanitizer.ts';

describe('HTML Email Sanitizer (Adversarial XSS Suite)', () => {
  it('strips script tags and inline event handlers', () => {
    const dirty = `
      <p onclick="alert(1)">Hello</p>
      <script>window.__pwned = true;</script>
      <img src="x" onerror="alert(2)" />
      <div onmouseover="fetch('https://evil.test')">Hover</div>
    `;
    const { html } = sanitizeEmailHtml(dirty, true);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain('alert(');
    expect(html).toContain('Hello');
    expect(html).toContain('Hover');
  });

  it('strips dangerous URL schemes including obfuscated javascript: and data:text/html', () => {
    const payloads = [
      '<a href="javascript:alert(1)">Click</a>',
      '<a href="  JaVaScRiPt:alert(1)">Click</a>',
      '<a href="java\tscript:alert(1)">Click</a>',
      '<a href="vbscript:msgbox(1)">Click</a>',
      '<a href="data:text/html,<script>alert(1)</script>">Click</a>',
    ];
    for (const payload of payloads) {
      const { html } = sanitizeEmailHtml(payload, true);
      expect(html.toLowerCase()).not.toContain('javascript:');
      expect(html.toLowerCase()).not.toContain('vbscript:');
      expect(html.toLowerCase()).not.toContain('data:text/html');
    }
  });

  it('strips iframe, svg, math, object, embed, form, meta, base, and style tags', () => {
    const dirty = `
      <iframe srcdoc="<script>alert(1)</script>"></iframe>
      <svg onload="alert(1)"><script>alert(2)</script></svg>
      <object data="javascript:alert(1)"></object>
      <embed src="evil.swf" />
      <form action="https://phish.test"><input name="pw" /><button>Login</button></form>
      <base href="https://evil.test/" />
      <style>body{background:url(https://leak.test/pixel)}</style>
      <p>Safe text</p>
    `;
    const { html } = sanitizeEmailHtml(dirty, true);
    for (const bad of ['<iframe', '<svg', '<object', '<embed', '<form', '<input', '<base', '<style']) {
      expect(html.toLowerCase()).not.toContain(bad);
    }
    expect(html).toContain('Safe text');
  });

  it('blocks CSS exfiltration and execution inside style attributes', () => {
    const dirty = `
      <div style="background-image: url('https://tracker.test/a.png'); color: red;">Track</div>
      <span style="width: expression(alert(1)); font-weight: bold;">Expr</span>
    `;
    const { html } = sanitizeEmailHtml(dirty, true);
    expect(html.toLowerCase()).not.toContain('url(');
    expect(html.toLowerCase()).not.toContain('expression(');
  });

  it('blocks remote HTTP/HTTPS images by default and allows them when opted in', () => {
    const dirty = '<p>Banner: <img src="https://cdn.example/img.png" alt="Promo" /></p>';
    const blocked = sanitizeEmailHtml(dirty, false);
    expect(blocked.hasBlockedImages).toBe(true);
    expect(blocked.html).not.toContain('src="https://cdn.example/img.png"');
    expect(blocked.html).toContain('data-blocked-img="1"');

    const allowed = sanitizeEmailHtml(dirty, true);
    expect(allowed.hasBlockedImages).toBe(false);
    expect(allowed.html).toContain('src="https://cdn.example/img.png"');
    expect(allowed.html).toContain('referrerpolicy="no-referrer"');
  });

  it('enforces safe link target and rel attributes', () => {
    const { html } = sanitizeEmailHtml('<a href="https://github.com/GitHub30/neon-gmail">Repo</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('escapes raw HTML entities and safely linkifies plain text without absorbing trailing quotes/brackets', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    const safe = plainTextToSafeHtml('Visit "https://example.com/a" or <https://example.org/b>. and <script>alert(1)</script>');
    expect(safe).toContain('<a href="https://example.com/a"');
    expect(safe).toContain('<a href="https://example.org/b"');
    expect(safe).not.toContain('&quot;"');
    expect(safe).not.toContain('<script>');
  });

  it('does not add target=_blank to hash anchors and clears dimensions on blocked tracking pixels', () => {
    const anchor = sanitizeEmailHtml('<a href="#section-1">Jump</a>');
    expect(anchor.html).toContain('href="#section-1"');
    expect(anchor.html).not.toContain('target="_blank"');

    const pixel = sanitizeEmailHtml('<img src="https://track.example/p.gif" alt="" width="1" height="1" />', false);
    expect(pixel.hasBlockedImages).toBe(true);
    expect(pixel.html).toContain('[Blocked external image]');
    expect(pixel.html).not.toContain('width="1"');
  });
});
