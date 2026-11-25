import type { AppSettings, CustomLabel, MailAccount, MailMessage, ThemeMode } from '../types/mail.ts';
import { createDefaultLabels, createDemoAccounts, createDemoMessages } from '../data/demoMailbox.ts';
import { colorForString, defaultServerForEmail } from '../data/providers.ts';
import { safeHexColor } from './sanitizer.ts';

export const STORAGE_KEYS = {
  ACCOUNTS: 'neon_gmail_accounts_v1',
  ACTIVE_ACCOUNT: 'neon_gmail_active_account_v1',
  THEME: 'neon_gmail_theme_v1',
  SETTINGS: 'neon_gmail_settings_v1',
  LABELS: 'neon_gmail_labels_v1',
  MESSAGES_PREFIX: 'neon_gmail_msgs_v1_',
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  locale: 'ja',
  density: 'default',
  readingPane: 'none',
  undoSendSeconds: 6,
  keyboardShortcuts: true,
  alwaysDisplayImages: false,
  pageSize: 50,
};

function safeReadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeWriteJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function normalizeAccount(raw: Partial<MailAccount>): MailAccount | null {
  if (!raw || typeof raw.email !== 'string' || !raw.email.trim()) return null;
  const email = raw.email.trim();
  const def = defaultServerForEmail(email);
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `acc-${Date.now().toString(36)}`,
    email,
    password: typeof raw.password === 'string' ? raw.password : '',
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : email.split('@')[0] || email,
    proxyUrl: typeof raw.proxyUrl === 'string' ? raw.proxyUrl.trim() : '',
    proxyType: raw.proxyType && ['auto', 'cloudflare', 'php', 'node', 'local'].includes(raw.proxyType) ? raw.proxyType : 'local',
    proxyToken: typeof raw.proxyToken === 'string' ? raw.proxyToken.trim() : '',
    server: {
      imapHost: raw.server?.imapHost || def.imapHost,
      imapPort: Number(raw.server?.imapPort) || def.imapPort,
      imapTls: raw.server?.imapTls || def.imapTls,
      smtpHost: raw.server?.smtpHost || def.smtpHost,
      smtpPort: Number(raw.server?.smtpPort) || def.smtpPort,
      smtpTls: raw.server?.smtpTls || def.smtpTls,
    },
    signature: typeof raw.signature === 'string' ? raw.signature : '',
    avatarColor: safeHexColor(raw.avatarColor, colorForString(email)),
    isDemo: Boolean(raw.isDemo),
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : new Date().toISOString(),
    lastSyncedAt: typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : undefined,
  };
}

function normalizeLabel(raw: Partial<CustomLabel>): CustomLabel | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !raw.name.trim()) return null;
  return {
    id: raw.id.trim(),
    name: raw.name.trim().slice(0, 48),
    color: safeHexColor(raw.color, '#1a73e8'),
  };
}

function normalizeMessage(raw: Partial<MailMessage>, accountId: string): MailMessage | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.threadId !== 'string') return null;
  return {
    id: raw.id,
    uid: typeof raw.uid === 'number' ? raw.uid : undefined,
    threadId: raw.threadId,
    accountId,
    fromName: typeof raw.fromName === 'string' ? raw.fromName : '',
    fromEmail: typeof raw.fromEmail === 'string' ? raw.fromEmail : 'unknown@invalid',
    to: Array.isArray(raw.to) ? raw.to.filter((x): x is string => typeof x === 'string') : [],
    cc: Array.isArray(raw.cc) ? raw.cc.filter((x): x is string => typeof x === 'string') : [],
    bcc: Array.isArray(raw.bcc) ? raw.bcc.filter((x): x is string => typeof x === 'string') : undefined,
    subject: typeof raw.subject === 'string' ? raw.subject : '(No Subject)',
    snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
    textBody: typeof raw.textBody === 'string' ? raw.textBody : '',
    htmlBody: typeof raw.htmlBody === 'string' ? raw.htmlBody : undefined,
    date: typeof raw.date === 'string' ? raw.date : new Date().toISOString(),
    isRead: Boolean(raw.isRead),
    isStarred: Boolean(raw.isStarred),
    isImportant: Boolean(raw.isImportant),
    folder: raw.folder ?? 'inbox',
    category: raw.category ?? 'primary',
    labels: Array.isArray(raw.labels) ? raw.labels.filter((x): x is string => typeof x === 'string') : [],
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    snoozedUntil: typeof raw.snoozedUntil === 'string' ? raw.snoozedUntil : undefined,
    scheduledFor: typeof raw.scheduledFor === 'string' ? raw.scheduledFor : undefined,
    messageId: typeof raw.messageId === 'string' ? raw.messageId : undefined,
    inReplyTo: typeof raw.inReplyTo === 'string' ? raw.inReplyTo : undefined,
    rawHeaders: typeof raw.rawHeaders === 'string' ? raw.rawHeaders : undefined,
  };
}

export function loadAccounts(): MailAccount[] {
  const stored = safeReadJson<Partial<MailAccount>[]>(STORAGE_KEYS.ACCOUNTS);
  if (Array.isArray(stored)) {
    return stored.map(normalizeAccount).filter((a): a is MailAccount => a !== null);
  }
  const demos = createDemoAccounts();
  saveAccounts(demos);
  return demos;
}

export function saveAccounts(accounts: MailAccount[]): boolean {
  return safeWriteJson(STORAGE_KEYS.ACCOUNTS, accounts);
}

export function loadActiveAccountId(accounts: MailAccount[]): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.ACTIVE_ACCOUNT);
    if (stored && accounts.some((a) => a.id === stored)) {
      return stored;
    }
  } catch {
    // ignore
  }
  const firstId = accounts[0]?.id ?? '';
  saveActiveAccountId(firstId);
  return firstId;
}

export function saveActiveAccountId(accountId: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_ACCOUNT, accountId);
  } catch {
    // ignore
  }
}

export function loadSettings(): AppSettings {
  const stored = safeReadJson<Partial<AppSettings>>(STORAGE_KEYS.SETTINGS);
  let theme: ThemeMode = stored?.theme ?? 'system';
  try {
    const rawTheme = localStorage.getItem(STORAGE_KEYS.THEME) as ThemeMode | null;
    if (rawTheme === 'light' || rawTheme === 'dark' || rawTheme === 'system') {
      theme = rawTheme;
    }
  } catch {
    // ignore
  }
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    theme,
  };
}

export function saveSettings(settings: AppSettings): void {
  safeWriteJson(STORAGE_KEYS.SETTINGS, settings);
  try {
    localStorage.setItem(STORAGE_KEYS.THEME, settings.theme);
  } catch {
    // ignore
  }
}

export function loadLabels(): CustomLabel[] {
  const stored = safeReadJson<Partial<CustomLabel>[]>(STORAGE_KEYS.LABELS);
  if (Array.isArray(stored)) {
    return stored.map(normalizeLabel).filter((l): l is CustomLabel => l !== null);
  }
  const defaults = createDefaultLabels();
  saveLabels(defaults);
  return defaults;
}

export function saveLabels(labels: CustomLabel[]): void {
  safeWriteJson(STORAGE_KEYS.LABELS, labels);
}

export function loadMessagesForAccount(account: MailAccount): MailMessage[] {
  const key = `${STORAGE_KEYS.MESSAGES_PREFIX}${account.id}`;
  const stored = safeReadJson<Partial<MailMessage>[]>(key);
  if (Array.isArray(stored)) {
    return stored.map((m) => normalizeMessage(m, account.id)).filter((m): m is MailMessage => m !== null);
  }
  const seed = account.isDemo ? createDemoMessages(account.id, account.email) : [];
  saveMessagesForAccount(account.id, seed);
  return seed;
}

export function saveMessagesForAccount(accountId: string, messages: MailMessage[]): boolean {
  const key = `${STORAGE_KEYS.MESSAGES_PREFIX}${accountId}`;
  return safeWriteJson(key, messages);
}

export function deleteMessagesForAccount(accountId: string): void {
  try {
    localStorage.removeItem(`${STORAGE_KEYS.MESSAGES_PREFIX}${accountId}`);
  } catch {
    // ignore
  }
}

export function estimateStorageUsageBytes(): number {
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('neon_gmail_')) continue;
      const v = localStorage.getItem(k) ?? '';
      total += (k.length + v.length) * 2;
    }
  } catch {
    // ignore
  }
  return total;
}

export function exportAllBackup(includeCredentials = false): string {
  const accounts = loadAccounts();
  const exportedAccounts = includeCredentials
    ? accounts
    : accounts.map((a) => ({ ...a, password: '', proxyToken: '' }));
  const messagesByAccount: Record<string, MailMessage[]> = {};
  for (const acc of accounts) {
    messagesByAccount[acc.id] = loadMessagesForAccount(acc);
  }
  return JSON.stringify(
    {
      version: 1,
      credentialsIncluded: includeCredentials,
      exportedAt: new Date().toISOString(),
      accounts: exportedAccounts,
      activeAccountId: loadActiveAccountId(accounts),
      settings: loadSettings(),
      labels: loadLabels(),
      messagesByAccount,
    },
    null,
    2,
  );
}

export function importAllBackup(jsonText: string): void {
  const data = JSON.parse(jsonText) as {
    accounts?: Partial<MailAccount>[];
    activeAccountId?: string;
    settings?: Partial<AppSettings>;
    labels?: Partial<CustomLabel>[];
    messagesByAccount?: Record<string, Partial<MailMessage>[]>;
  };
  if (!data || !Array.isArray(data.accounts)) {
    throw new Error('Invalid backup file: missing accounts array.');
  }
  const cleanAccounts = data.accounts.map(normalizeAccount).filter((a): a is MailAccount => a !== null);
  saveAccounts(cleanAccounts);
  if (typeof data.activeAccountId === 'string' && cleanAccounts.some((a) => a.id === data.activeAccountId)) {
    saveActiveAccountId(data.activeAccountId);
  } else {
    saveActiveAccountId(cleanAccounts[0]?.id ?? '');
  }
  if (data.settings && typeof data.settings === 'object') {
    saveSettings({ ...DEFAULT_SETTINGS, ...data.settings });
  }
  if (Array.isArray(data.labels)) {
    const cleanLabels = data.labels.map(normalizeLabel).filter((l): l is CustomLabel => l !== null);
    saveLabels(cleanLabels);
  }
  if (data.messagesByAccount && typeof data.messagesByAccount === 'object') {
    for (const acc of cleanAccounts) {
      const rawMsgs = data.messagesByAccount[acc.id];
      if (Array.isArray(rawMsgs)) {
        const cleanMsgs = rawMsgs.map((m) => normalizeMessage(m, acc.id)).filter((m): m is MailMessage => m !== null);
        saveMessagesForAccount(acc.id, cleanMsgs);
      }
    }
  }
}
