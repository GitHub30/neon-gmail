const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li',
  'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'u', 'ul',
]);

const DROP_CONTENT_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'form', 'input',
  'button', 'textarea', 'select', 'option', 'meta', 'link', 'base', 'title',
  'head', 'svg', 'math', 'template', 'noscript', 'frame', 'frameset', 'audio',
  'video', 'source',
]);

const ALLOWED_ATTRS = new Set([
  'href', 'title', 'alt', 'src', 'width', 'height', 'colspan', 'rowspan',
  'align', 'valign', 'dir', 'lang', 'style',
]);

const SAFE_STYLE_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style',
  'text-decoration', 'text-align', 'line-height', 'margin', 'margin-top',
  'margin-bottom', 'margin-left', 'margin-right', 'padding', 'padding-top',
  'padding-bottom', 'padding-left', 'padding-right', 'border', 'border-radius',
  'border-collapse', 'border-left', 'max-width', 'width', 'display',
]);

export function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeHexColor(color: unknown, fallback = '#1a73e8'): string {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color.trim())) {
    return color.trim();
  }
  return fallback;
}

export function sanitizeFilename(raw: string): string {
  const cleaned = String(raw || 'attachment.bin')
    // Strip path separators, ASCII controls, and Unicode bidirectional spoofing controls
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_')
    .trim();
  return cleaned || 'attachment.bin';
}

function isSafeUrl(raw: string, allowDataImage = false): boolean {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f\s]+/g, '').toLowerCase();
  if (!cleaned) return false;
  if (
    cleaned.startsWith('https://') ||
    cleaned.startsWith('http://') ||
    cleaned.startsWith('mailto:') ||
    cleaned.startsWith('tel:') ||
    cleaned.startsWith('#')
  ) {
    return true;
  }
  if (allowDataImage && /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=]+$/i.test(cleaned)) {
    return true;
  }
  return false;
}

function sanitizeStyle(styleVal: string): string {
  if (/url\s*\(|expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding/i.test(styleVal)) {
    return '';
  }
  const safeParts: string[] = [];
  for (const decl of styleVal.split(';')) {
    const colon = decl.indexOf(':');
    if (colon <= 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (!SAFE_STYLE_PROPS.has(prop) || !val || val.length > 80) continue;
    if (/[<>\\]/.test(val)) continue;
    safeParts.push(`${prop}: ${val}`);
  }
  return safeParts.join('; ');
}

export interface SanitizeResult {
  html: string;
  hasBlockedImages: boolean;
}

export function sanitizeEmailHtml(dirtyHtml: string, allowRemoteImages = false): SanitizeResult {
  if (!dirtyHtml) return { html: '', hasBlockedImages: false };

  const parser = new DOMParser();
  const doc = parser.parseFromString(dirtyHtml, 'text/html');
  let hasBlockedImages = false;

  const cleanNode = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.textContent ?? '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (DROP_CONTENT_TAGS.has(tag)) return null;

    if (!ALLOWED_TAGS.has(tag)) {
      const frag = document.createDocumentFragment();
      for (const child of Array.from(el.childNodes)) {
        const cleaned = cleanNode(child);
        if (cleaned) frag.appendChild(cleaned);
      }
      return frag;
    }

    const safeEl = document.createElement(tag);
    let imgWasBlocked = false;

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value;
      if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) continue;

      if (name === 'href') {
        if (tag === 'a' && isSafeUrl(val, false)) {
          const trimmed = val.trim();
          safeEl.setAttribute('href', trimmed);
          if (!trimmed.startsWith('#')) {
            safeEl.setAttribute('target', '_blank');
            safeEl.setAttribute('rel', 'noopener noreferrer nofollow');
          }
        }
        continue;
      }

      if (name === 'src') {
        if (tag === 'img') {
          const trimmed = val.trim();
          const isDataImg = isSafeUrl(trimmed, true) && trimmed.toLowerCase().startsWith('data:image/');
          const isHttpImg = isSafeUrl(trimmed, false) && /^https?:\/\//i.test(trimmed);
          if (isDataImg) {
            safeEl.setAttribute('src', trimmed);
            safeEl.setAttribute('loading', 'lazy');
          } else if (isHttpImg) {
            if (allowRemoteImages) {
              safeEl.setAttribute('src', trimmed);
              safeEl.setAttribute('loading', 'lazy');
              safeEl.setAttribute('referrerpolicy', 'no-referrer');
            } else {
              hasBlockedImages = true;
              imgWasBlocked = true;
              safeEl.setAttribute('data-blocked-img', '1');
              safeEl.className = 'blocked-remote-img';
            }
          }
        }
        continue;
      }

      if (name === 'style') {
        const cleanStyle = sanitizeStyle(val);
        if (cleanStyle) safeEl.setAttribute('style', cleanStyle);
        continue;
      }

      safeEl.setAttribute(name, val);
    }

    // Ensure blocked remote images don't keep 1x1 tracking dimensions or empty alt text
    if (imgWasBlocked) {
      safeEl.removeAttribute('width');
      safeEl.removeAttribute('height');
      const existingAlt = safeEl.getAttribute('alt')?.trim();
      safeEl.setAttribute('alt', existingAlt || '[Blocked external image]');
    }

    for (const child of Array.from(el.childNodes)) {
      const cleaned = cleanNode(child);
      if (cleaned) safeEl.appendChild(cleaned);
    }

    return safeEl;
  };

  const container = document.createElement('div');
  for (const child of Array.from(doc.body.childNodes)) {
    const cleaned = cleanNode(child);
    if (cleaned) container.appendChild(cleaned);
  }

  return { html: container.innerHTML, hasBlockedImages };
}

export function plainTextToSafeHtml(text: string): string {
  const str = String(text ?? '');
  // Match raw URLs BEFORE HTML escaping so quotes/angle brackets are never absorbed into href
  const urlRe = /https?:\/\/[^\s<>"'`)\]]+/g;
  let out = '';
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  while ((m = urlRe.exec(str)) !== null) {
    out += escapeHtml(str.slice(lastIdx, m.index));
    // Trim trailing sentence punctuation cleanly
    const rawUrl = m[0].replace(/[.,;:!?]+$/, '');
    const trailing = m[0].slice(rawUrl.length);
    const escapedUrl = escapeHtml(rawUrl);
    out += `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer nofollow">${escapedUrl}</a>${escapeHtml(trailing)}`;
    lastIdx = m.index + m[0].length;
  }
  out += escapeHtml(str.slice(lastIdx));
  return out.replace(/\r?\n/g, '<br>');
}
