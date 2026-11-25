import { icons } from '../core/icons.ts';
import { escapeHtml } from '../core/sanitizer.ts';
import type { MailStore } from '../core/store.ts';

export function renderSettingsModal(store: MailStore, isOpen: boolean): string {
  if (!isOpen) return '';
  const s = store.settings;
  const active = store.getActiveAccount();
  const loc = s.locale;

  return `
    <div class="modal-backdrop" data-action="close-modal-backdrop" role="presentation">
      <div class="modal-card wide" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
        <div class="modal-header">
          <h2 id="settings-dialog-title">${escapeHtml(store.tr('settingsTitle'))}</h2>
          <button type="button" class="icon-btn" aria-label="${escapeHtml(store.tr('close'))}" data-action="close-settings-modal">${icons.close}</button>
        </div>

        <div class="modal-body">
          <div class="form-row-2">
            <div class="form-group">
              <label for="set-theme">${escapeHtml(store.tr('themeLabel'))}</label>
              <select id="set-theme" class="field-select" data-setting="theme">
                <option value="light" ${s.theme === 'light' ? 'selected' : ''}>${escapeHtml(store.tr('themeLight'))}</option>
                <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>${escapeHtml(store.tr('themeDark'))}</option>
                <option value="system" ${s.theme === 'system' ? 'selected' : ''}>${escapeHtml(store.tr('themeSystem'))}</option>
              </select>
            </div>

            <div class="form-group">
              <label for="set-locale">${escapeHtml(store.tr('languageLabel'))}</label>
              <select id="set-locale" class="field-select" data-setting="locale">
                <option value="ja" ${s.locale === 'ja' ? 'selected' : ''}>日本語 (Japanese)</option>
                <option value="en" ${s.locale === 'en' ? 'selected' : ''}>English</option>
              </select>
            </div>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label for="set-density">${escapeHtml(store.tr('densityLabel'))}</label>
              <select id="set-density" class="field-select" data-setting="density">
                <option value="default" ${s.density === 'default' ? 'selected' : ''}>${escapeHtml(store.tr('densityDefault'))}</option>
                <option value="comfortable" ${s.density === 'comfortable' ? 'selected' : ''}>${escapeHtml(store.tr('densityComfortable'))}</option>
                <option value="compact" ${s.density === 'compact' ? 'selected' : ''}>${escapeHtml(store.tr('densityCompact'))}</option>
              </select>
            </div>

            <div class="form-group">
              <label for="set-reading-pane">${escapeHtml(store.tr('readingPaneLabel'))}</label>
              <select id="set-reading-pane" class="field-select" data-setting="readingPane">
                <option value="none" ${s.readingPane === 'none' ? 'selected' : ''}>${escapeHtml(store.tr('readingPaneNone'))}</option>
                <option value="right" ${s.readingPane === 'right' ? 'selected' : ''}>${escapeHtml(store.tr('readingPaneRight'))}</option>
                <option value="bottom" ${s.readingPane === 'bottom' ? 'selected' : ''}>${escapeHtml(store.tr('readingPaneBottom'))}</option>
              </select>
            </div>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label for="set-undo-delay">${escapeHtml(store.tr('undoDelayLabel'))}</label>
              <select id="set-undo-delay" class="field-select" data-setting="undoSendSeconds">
                <option value="5" ${s.undoSendSeconds === 5 ? 'selected' : ''}>5</option>
                <option value="6" ${s.undoSendSeconds === 6 ? 'selected' : ''}>6</option>
                <option value="10" ${s.undoSendSeconds === 10 ? 'selected' : ''}>10</option>
                <option value="20" ${s.undoSendSeconds === 20 ? 'selected' : ''}>20</option>
                <option value="30" ${s.undoSendSeconds === 30 ? 'selected' : ''}>30</option>
              </select>
            </div>

            <div class="form-group" style="justify-content:center;gap:8px;padding-top:16px;">
              <label style="display:flex;align-items:center;gap:8px;font-weight:500;">
                <input type="checkbox" data-setting-bool="keyboardShortcuts" ${s.keyboardShortcuts ? 'checked' : ''} />
                <span>${loc === 'ja' ? 'Gmail キーボードショートカットを有効にする' : 'Enable Gmail keyboard shortcuts'}</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;font-weight:500;">
                <input type="checkbox" data-setting-bool="alwaysDisplayImages" ${s.alwaysDisplayImages ? 'checked' : ''} />
                <span>${loc === 'ja' ? '外部画像を常に自動表示する' : 'Always display external images'}</span>
              </label>
            </div>
          </div>

          ${
            active
              ? `
            <div class="form-group">
              <label for="set-signature">${escapeHtml(store.tr('signatureLabel'))} (${escapeHtml(active.email)})</label>
              <textarea id="set-signature" class="field-textarea" rows="3" data-action-signature="1">${escapeHtml(active.signature)}</textarea>
            </div>
          `
              : ''
          }

          <div class="notice-box" style="flex-direction:column;gap:10px;">
            <strong style="color:var(--ink-primary);">${escapeHtml(store.tr('proxyDownloadTitle'))}</strong>
            <span>${
              loc === 'ja'
                ? 'ブラウザからIMAP (993/143)・SMTP (465/587) へ接続するためのプロキシファイルを直接ダウンロードできます。すべて Access-Control-Allow-Origin: * および SSRF 対策に対応しています。'
                : 'Download any self-hosted IMAP/SMTP proxy below. All proxies support CORS (Access-Control-Allow-Origin: *), TLS/STARTTLS, and SSRF protection.'
            }</span>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              <a class="btn btn-sm" href="./proxies/proxy.php" download="proxy.php">${icons.download}<span>proxy.php (PHP 8+)</span></a>
              <a class="btn btn-sm" href="./proxies/cloudflare-worker.js" download="cloudflare-worker.js">${icons.download}<span>cloudflare-worker.js</span></a>
              <a class="btn btn-sm" href="./proxies/proxy-node.mjs" download="proxy-node.mjs">${icons.download}<span>proxy-node.mjs (Node 20+)</span></a>
              <a class="btn btn-sm" href="./docs/" target="_blank" rel="noopener noreferrer">${escapeHtml(store.tr('docsLink'))}</a>
            </div>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
            <button type="button" class="btn btn-sm" data-action="export-backup">${icons.download}<span>${loc === 'ja' ? 'JSONバックアップ（パスワード除外）' : 'Export JSON Backup (passwords redacted)'}</span></button>
            <label class="btn btn-sm file-input-label">
              <span>${loc === 'ja' ? 'バックアップを復元' : 'Import JSON Backup'}</span>
              <input type="file" accept="application/json" class="sr-only" id="import-backup-input" />
            </label>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-primary" data-action="close-settings-modal">${escapeHtml(store.tr('close'))}</button>
        </div>
      </div>
    </div>
  `;
}
