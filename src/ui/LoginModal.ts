import { icons } from '../core/icons.ts';
import { escapeHtml } from '../core/sanitizer.ts';
import type { MailStore } from '../core/store.ts';
import { defaultServerForEmail, detectProvider } from '../data/providers.ts';
import type { MailAccount } from '../types/mail.ts';

export interface LoginModalState {
  open: boolean;
  editingAccountId: string | null;
  serverTouched: boolean;
  showPassword: boolean;
  showAdvanced: boolean;
  testing: boolean;
  testStatus: { ok: boolean; message: string } | null;
  email: string;
  password: string;
  displayName: string;
  proxyUrl: string;
  proxyType: MailAccount['proxyType'];
  proxyToken: string;
  imapHost: string;
  imapPort: number;
  imapTls: MailAccount['server']['imapTls'];
  smtpHost: string;
  smtpPort: number;
  smtpTls: MailAccount['server']['smtpTls'];
}

export function createInitialLoginState(account?: MailAccount): LoginModalState {
  if (account) {
    return {
      open: true,
      editingAccountId: account.id,
      serverTouched: true,
      showPassword: false,
      showAdvanced: Boolean(account.proxyUrl),
      testing: false,
      testStatus: null,
      email: account.email,
      password: account.password,
      displayName: account.displayName,
      proxyUrl: account.proxyUrl,
      proxyType: account.proxyType,
      proxyToken: account.proxyToken,
      imapHost: account.server.imapHost,
      imapPort: account.server.imapPort,
      imapTls: account.server.imapTls,
      smtpHost: account.server.smtpHost,
      smtpPort: account.server.smtpPort,
      smtpTls: account.server.smtpTls,
    };
  }
  const def = defaultServerForEmail('user@gmail.com');
  return {
    open: true,
    editingAccountId: null,
    serverTouched: false,
    showPassword: false,
    showAdvanced: false,
    testing: false,
    testStatus: null,
    email: '',
    password: '',
    displayName: '',
    proxyUrl: '',
    proxyType: 'auto',
    proxyToken: '',
    imapHost: def.imapHost,
    imapPort: def.imapPort,
    imapTls: def.imapTls,
    smtpHost: def.smtpHost,
    smtpPort: def.smtpPort,
    smtpTls: def.smtpTls,
  };
}

export function renderLoginModal(store: MailStore, state: LoginModalState): string {
  if (!state.open) return '';
  const loc = store.settings.locale;
  const preset = detectProvider(state.email);
  const providerHint = preset
    ? (loc === 'ja'
        ? `${preset.name} を自動検出しました — ${preset.appPasswordHintJa}`
        : `${preset.name} auto-detected — ${preset.appPasswordHintEn}`)
    : '';

  return `
    <div class="modal-backdrop" data-action="close-modal-backdrop" role="presentation">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="login-dialog-title">
        <div class="modal-header">
          <div>
            <h2 id="login-dialog-title">${escapeHtml(store.tr('loginTitle'))}</h2>
            <p class="form-hint" style="margin:4px 0 0;">${escapeHtml(store.tr('loginSubtitle'))}</p>
          </div>
          <button type="button" class="icon-btn" aria-label="${escapeHtml(store.tr('close'))}" data-action="close-login-modal">${icons.close}</button>
        </div>

        <form id="login-account-form" class="modal-form">
          <div class="modal-body">
            <div class="form-group">
              <label for="login-email">${escapeHtml(store.tr('emailLabel'))} *</label>
              <input
                id="login-email"
                name="email"
                class="field-input"
                type="email"
                required
                autocomplete="email"
                placeholder="you@gmail.com"
                value="${escapeHtml(state.email)}"
              />
              <span id="login-provider-hint" class="form-hint" style="color:var(--accent);${providerHint ? '' : 'display:none;'}">${escapeHtml(providerHint)}</span>
            </div>

            <div class="form-group">
              <label for="login-password">${escapeHtml(store.tr('passwordLabel'))} *</label>
              <div class="password-wrap">
                <input
                  id="login-password"
                  name="password"
                  class="field-input"
                  type="${state.showPassword ? 'text' : 'password'}"
                  required
                  autocomplete="current-password"
                  placeholder="••••••••••••••••"
                  value="${escapeHtml(state.password)}"
                />
                <button
                  type="button"
                  class="icon-btn sm password-toggle"
                  aria-label="${state.showPassword ? (loc === 'ja' ? 'パスワードを隠す' : 'Hide password') : (loc === 'ja' ? 'パスワードを表示' : 'Show password')}"
                  aria-pressed="${state.showPassword}"
                  data-action="toggle-login-password"
                >
                  ${state.showPassword ? icons.eyeOff : icons.eye}
                </button>
              </div>
            </div>

            <div class="form-group">
              <label for="login-display-name">${escapeHtml(store.tr('displayNameLabel'))}</label>
              <input
                id="login-display-name"
                name="displayName"
                class="field-input"
                type="text"
                placeholder="${loc === 'ja' ? '山田 太郎' : 'Your Name'}"
                value="${escapeHtml(state.displayName)}"
              />
            </div>

            <div class="form-group">
              <label for="login-proxy-url">${escapeHtml(store.tr('proxyUrlLabel'))}</label>
              <input
                id="login-proxy-url"
                name="proxyUrl"
                class="field-input"
                type="url"
                placeholder="https://neon-gmail-proxy.your-sub.workers.dev  or  https://example.com/proxy.php"
                value="${escapeHtml(state.proxyUrl)}"
              />
              <span class="form-hint">${escapeHtml(store.tr('proxyUrlHint'))}</span>
            </div>

            <div class="form-row-2">
              <div class="form-group">
                <label for="login-proxy-type">${escapeHtml(store.tr('proxyTypeLabel'))}</label>
                <select id="login-proxy-type" name="proxyType" class="field-select">
                  <option value="auto" ${state.proxyType === 'auto' ? 'selected' : ''}>Auto Detect</option>
                  <option value="cloudflare" ${state.proxyType === 'cloudflare' ? 'selected' : ''}>Cloudflare Workers (IMAP/SMTP)</option>
                  <option value="php" ${state.proxyType === 'php' ? 'selected' : ''}>PHP proxy.php (IMAP/SMTP)</option>
                  <option value="node" ${state.proxyType === 'node' ? 'selected' : ''}>Node.js proxy-node.mjs</option>
                  <option value="local" ${state.proxyType === 'local' ? 'selected' : ''}>Local / Offline Mode</option>
                </select>
              </div>

              <div class="form-group">
                <label for="login-proxy-token">${escapeHtml(store.tr('proxyTokenLabel'))}</label>
                <input
                  id="login-proxy-token"
                  name="proxyToken"
                  class="field-input"
                  type="password"
                  autocomplete="off"
                  placeholder="${loc === 'ja' ? '任意の共有シークレット' : 'Optional shared secret'}"
                  value="${escapeHtml(state.proxyToken)}"
                />
              </div>
            </div>

            <div>
              <button type="button" class="btn btn-sm" aria-expanded="${state.showAdvanced}" data-action="toggle-login-advanced">
                ${icons.settings}
                <span id="login-advanced-summary">${escapeHtml(store.tr('advancedServerToggle'))} (${escapeHtml(state.imapHost)}:${state.imapPort})</span>
              </button>
            </div>

            ${
              state.showAdvanced
                ? `
              <div class="notice-box" style="flex-direction:column;gap:10px;">
                <div class="form-row-2" style="width:100%;">
                  <div class="form-group">
                    <label for="login-imap-host">IMAP Host</label>
                    <input id="login-imap-host" name="imapHost" class="field-input" type="text" value="${escapeHtml(state.imapHost)}" />
                  </div>
                  <div class="form-row-2">
                    <div class="form-group">
                      <label for="login-imap-port">IMAP Port</label>
                      <input id="login-imap-port" name="imapPort" class="field-input" type="number" min="1" max="65535" value="${state.imapPort}" />
                    </div>
                    <div class="form-group">
                      <label for="login-imap-tls">IMAP TLS</label>
                      <select id="login-imap-tls" name="imapTls" class="field-select">
                        <option value="tls" ${state.imapTls === 'tls' ? 'selected' : ''}>SSL/TLS</option>
                        <option value="starttls" ${state.imapTls === 'starttls' ? 'selected' : ''}>STARTTLS</option>
                        <option value="none" ${state.imapTls === 'none' ? 'selected' : ''}>Plain</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div class="form-row-2" style="width:100%;">
                  <div class="form-group">
                    <label for="login-smtp-host">SMTP Host</label>
                    <input id="login-smtp-host" name="smtpHost" class="field-input" type="text" value="${escapeHtml(state.smtpHost)}" />
                  </div>
                  <div class="form-row-2">
                    <div class="form-group">
                      <label for="login-smtp-port">SMTP Port</label>
                      <input id="login-smtp-port" name="smtpPort" class="field-input" type="number" min="1" max="65535" value="${state.smtpPort}" />
                    </div>
                    <div class="form-group">
                      <label for="login-smtp-tls">SMTP TLS</label>
                      <select id="login-smtp-tls" name="smtpTls" class="field-select">
                        <option value="tls" ${state.smtpTls === 'tls' ? 'selected' : ''}>SSL/TLS</option>
                        <option value="starttls" ${state.smtpTls === 'starttls' ? 'selected' : ''}>STARTTLS</option>
                        <option value="none" ${state.smtpTls === 'none' ? 'selected' : ''}>Plain</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            `
                : ''
            }

            ${
              state.testStatus
                ? `<div class="status-banner ${state.testStatus.ok ? 'success' : 'error'}" role="status">${escapeHtml(state.testStatus.message)}</div>`
                : ''
            }

            <div class="notice-box">
              ${icons.shield}
              <span>${escapeHtml(store.tr('localStorageNotice'))}</span>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn" data-action="test-login-connection" ${state.testing ? 'disabled' : ''}>
              ${icons.cloud}
              <span>${state.testing ? (loc === 'ja' ? '接続テスト中…' : 'Testing…') : escapeHtml(store.tr('testConnection'))}</span>
            </button>
            <button type="button" class="btn" data-action="close-login-modal">${escapeHtml(store.tr('cancel'))}</button>
            <button type="submit" class="btn btn-primary">${escapeHtml(store.tr('signInSave'))}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}
