import { icons } from '../core/icons.ts';
import { escapeHtml } from '../core/sanitizer.ts';
import type { MailStore } from '../core/store.ts';
import { DEFAULT_CLOUDFLARE_PROXY_URL, defaultServerForEmail, detectProvider } from '../data/providers.ts';
import type { MailAccount } from '../types/mail.ts';

export interface LoginModalState {
  open: boolean;
  editingAccountId: string | null;
  serverTouched: boolean;
  showPassword: boolean;
  showAdvanced: boolean;
  testing: boolean;
  testStatus: { kind: 'info' | 'success' | 'error'; message: string; allowSkipVerify?: boolean } | null;
  email: string;
  password: string;
  displayName: string;
  proxyUrl: string;
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
      showAdvanced: false,
      testing: false,
      testStatus: null,
      email: account.email,
      password: account.password,
      displayName: account.displayName,
      proxyUrl: account.proxyUrl || DEFAULT_CLOUDFLARE_PROXY_URL,
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
    proxyUrl: DEFAULT_CLOUDFLARE_PROXY_URL,
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

            ${
              state.testStatus
                ? `<div class="status-banner ${state.testStatus.kind}" role="status">
                    <div>${escapeHtml(state.testStatus.message)}</div>
                    ${
                      state.testStatus.allowSkipVerify
                        ? `<div style="margin-top:8px;">
                            <button type="button" class="btn btn-sm" data-action="save-login-skip-verify">
                              ${loc === 'ja' ? '接続確認をスキップして保存' : 'Save without verifying'}
                            </button>
                          </div>`
                        : ''
                    }
                  </div>`
                : ''
            }

            <div>
              <button type="button" class="btn btn-sm" aria-expanded="${state.showAdvanced}" data-action="toggle-login-advanced">
                ${icons.settings}
                <span id="login-advanced-summary">${escapeHtml(store.tr('advancedServerToggle'))} (${escapeHtml(state.imapHost)}:${state.imapPort})</span>
              </button>
            </div>

            ${
              state.showAdvanced
                ? `
              <div class="notice-box" style="flex-direction:column;gap:12px;">
                <div class="form-group" style="width:100%;">
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

                <div class="form-group" style="width:100%;">
                  <label for="login-proxy-url">${escapeHtml(store.tr('proxyUrlLabel'))}</label>
                  <input
                    id="login-proxy-url"
                    name="proxyUrl"
                    class="field-input"
                    type="url"
                    placeholder="${escapeHtml(DEFAULT_CLOUDFLARE_PROXY_URL)}"
                    value="${escapeHtml(state.proxyUrl)}"
                  />
                  <span class="form-hint">${escapeHtml(store.tr('proxyUrlHint'))}</span>
                </div>

                <div class="form-group" style="width:100%;">
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
            <button type="submit" class="btn btn-primary" ${state.testing ? 'disabled' : ''}>
              ${state.testing ? (loc === 'ja' ? '接続確認中…' : 'Signing in…') : escapeHtml(store.tr('signInSave'))}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}
