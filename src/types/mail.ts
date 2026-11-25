export type ProxyType = 'auto' | 'cloudflare' | 'php' | 'node' | 'local';
export type TlsMode = 'tls' | 'starttls' | 'none';
export type ThemeMode = 'light' | 'dark' | 'system';
export type Locale = 'ja' | 'en';
export type DensityMode = 'default' | 'comfortable' | 'compact';
export type ReadingPaneMode = 'none' | 'right' | 'bottom';

export type SystemFolder =
  | 'inbox'
  | 'starred'
  | 'snoozed'
  | 'sent'
  | 'drafts'
  | 'scheduled'
  | 'important'
  | 'all'
  | 'spam'
  | 'trash';

export type InboxCategory = 'primary' | 'promotions' | 'social' | 'updates';

export interface MailServerConfig {
  imapHost: string;
  imapPort: number;
  imapTls: TlsMode;
  smtpHost: string;
  smtpPort: number;
  smtpTls: TlsMode;
}

export interface MailAccount {
  id: string;
  email: string;
  password: string;
  displayName: string;
  proxyUrl: string;
  proxyType: ProxyType;
  proxyToken: string;
  server: MailServerConfig;
  signature: string;
  avatarColor: string;
  isDemo?: boolean;
  addedAt: string;
  lastSyncedAt?: string;
}

export interface MailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  dataBase64?: string;
}

export interface MailMessage {
  id: string;
  uid?: number;
  threadId: string;
  accountId: string;
  fromName: string;
  fromEmail: string;
  to: string[];
  cc: string[];
  bcc?: string[];
  subject: string;
  snippet: string;
  textBody: string;
  htmlBody?: string;
  date: string; // ISO string
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  folder: SystemFolder;
  category: InboxCategory;
  labels: string[];
  attachments: MailAttachment[];
  snoozedUntil?: string; // ISO string
  scheduledFor?: string; // ISO string
  messageId?: string;
  inReplyTo?: string;
  rawHeaders?: string;
}

export interface MailThread {
  id: string;
  subject: string;
  messages: MailMessage[];
  latestDate: string;
  unreadCount: number;
  isStarred: boolean;
  isImportant: boolean;
  hasAttachments: boolean;
  folder: SystemFolder;
  category: InboxCategory;
  labels: string[];
  participants: Array<{ name: string; email: string }>;
  snippet: string;
  snoozedUntil?: string;
  scheduledFor?: string;
}

export interface CustomLabel {
  id: string;
  name: string;
  color: string;
}

export interface ComposeDraft {
  id: string;
  accountId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  htmlBody: string;
  textBody: string;
  attachments: MailAttachment[];
  inReplyTo?: string;
  threadId?: string;
  updatedAt: string;
  minimized: boolean;
  expanded: boolean;
}

export interface AppSettings {
  theme: ThemeMode;
  locale: Locale;
  density: DensityMode;
  readingPane: ReadingPaneMode;
  undoSendSeconds: number;
  keyboardShortcuts: boolean;
  alwaysDisplayImages: boolean;
  pageSize: number;
}
