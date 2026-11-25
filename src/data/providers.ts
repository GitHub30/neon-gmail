import type { MailServerConfig, ProxyType } from '../types/mail.ts';

export const DEFAULT_CLOUDFLARE_PROXY_URL = 'https://neon-gmail-proxy.6u.workers.dev';

export function inferProxyTypeFromUrl(proxyUrl: string): ProxyType {
  const trimmed = proxyUrl.trim();
  if (!trimmed) return 'local';
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname.toLowerCase().endsWith('.php')) return 'php';
  } catch {
    if (trimmed.toLowerCase().includes('.php')) return 'php';
  }
  return 'cloudflare';
}

export interface ProviderPreset {
  id: string;
  name: string;
  domains: string[];
  server: MailServerConfig;
  appPasswordHintJa: string;
  appPasswordHintEn: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'gmail',
    name: 'Gmail / Google Workspace',
    domains: ['gmail.com', 'googlemail.com'],
    server: {
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpTls: 'tls',
    },
    appPasswordHintJa: 'Gmailは2段階認証を有効にし、Googleアカウントの「アプリパスワード」の入力を推奨します。',
    appPasswordHintEn: 'For Gmail, enable 2-Step Verification and use a Google App Password.',
  },
  {
    id: 'outlook',
    name: 'Outlook / Hotmail / Live',
    domains: ['outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.com', 'live.jp'],
    server: {
      imapHost: 'outlook.office365.com',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'smtp.office365.com',
      smtpPort: 587,
      smtpTls: 'starttls',
    },
    appPasswordHintJa: 'Outlook.comではIMAPアクセス設定とアプリパスワードが必要な場合があります。',
    appPasswordHintEn: 'Ensure IMAP access is enabled and use an App Password if 2FA is active.',
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    server: {
      imapHost: 'imap.mail.me.com',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'smtp.mail.me.com',
      smtpPort: 587,
      smtpTls: 'starttls',
    },
    appPasswordHintJa: 'Apple Accountの「App用パスワード」を発行して入力してください。',
    appPasswordHintEn: 'Generate an App-Specific Password from your Apple Account settings.',
  },
  {
    id: 'yahoo-jp',
    name: 'Yahoo!メール (Japan)',
    domains: ['yahoo.co.jp', 'ymail.ne.jp'],
    server: {
      imapHost: 'imap.mail.yahoo.co.jp',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'smtp.mail.yahoo.co.jp',
      smtpPort: 465,
      smtpTls: 'tls',
    },
    appPasswordHintJa: 'Yahoo!メール設定でIMAP/SMTPアクセスを有効にしてください。',
    appPasswordHintEn: 'Enable IMAP/SMTP access in Yahoo! Japan Mail settings.',
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    domains: ['yahoo.com', 'ymail.com'],
    server: {
      imapHost: 'imap.mail.yahoo.com',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'smtp.mail.yahoo.com',
      smtpPort: 465,
      smtpTls: 'tls',
    },
    appPasswordHintJa: 'Yahooアカウントセキュリティ画面でアプリパスワードを生成してください。',
    appPasswordHintEn: 'Generate a third-party App Password in Yahoo Account Security.',
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm', 'fastmail.jp'],
    server: {
      imapHost: 'imap.fastmail.com',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'smtp.fastmail.com',
      smtpPort: 465,
      smtpTls: 'tls',
    },
    appPasswordHintJa: 'Fastmail設定のApp PasswordsからIMAP/SMTP用パスワードを作成してください。',
    appPasswordHintEn: 'Create an IMAP/SMTP App Password in Fastmail Settings.',
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com', 'zohomail.jp'],
    server: {
      imapHost: 'imap.zoho.com',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'smtp.zoho.com',
      smtpPort: 465,
      smtpTls: 'tls',
    },
    appPasswordHintJa: 'Zoho Mail設定でIMAPアクセスを有効にしてください。',
    appPasswordHintEn: 'Enable IMAP access in Zoho Mail settings.',
  },
  {
    id: 'sakura',
    name: 'さくらメール (Sakura)',
    domains: ['sakura.ne.jp'],
    server: {
      imapHost: 'mail.sakura.ne.jp',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'mail.sakura.ne.jp',
      smtpPort: 587,
      smtpTls: 'starttls',
    },
    appPasswordHintJa: '初期ドメインのメールサーバー名に合わせてIMAP/SMTPホストを調整してください。',
    appPasswordHintEn: 'Adjust IMAP/SMTP host to match your Sakura initial domain server.',
  },
  {
    id: 'xserver',
    name: 'Xserver Mail',
    domains: ['xsrv.jp', 'xserver.jp'],
    server: {
      imapHost: 'sv.xserver.jp',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'sv.xserver.jp',
      smtpPort: 465,
      smtpTls: 'tls',
    },
    appPasswordHintJa: 'Xserverパネルに表示されるサーバー番号（例: svXXXX.xserver.jp）を詳細設定に入力してください。',
    appPasswordHintEn: 'Enter your assigned Xserver hostname (e.g., svXXXX.xserver.jp) in Advanced settings.',
  },
  {
    id: 'lolipop',
    name: 'ロリポップ！メール (Lolipop)',
    domains: ['lolipop.jp', 'main.jp', 'moo.jp'],
    server: {
      imapHost: 'imap.lolipop.jp',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'smtp.lolipop.jp',
      smtpPort: 465,
      smtpTls: 'tls',
    },
    appPasswordHintJa: 'ロリポップのメールアカウントパスワードを入力してください。',
    appPasswordHintEn: 'Enter your Lolipop mail account password.',
  },
  {
    id: 'conoha',
    name: 'ConoHa WING Mail',
    domains: ['conoha.ne.jp', 'cnode.jp'],
    server: {
      imapHost: 'mail.conoha.ne.jp',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'mail.conoha.ne.jp',
      smtpPort: 465,
      smtpTls: 'tls',
    },
    appPasswordHintJa: 'ConoHaコントロールパネルのメールサーバーホスト名を確認してください。',
    appPasswordHintEn: 'Verify the mail server hostname shown in your ConoHa control panel.',
  },
];

export function detectProvider(email: string): ProviderPreset | null {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  if (!domain) return null;
  for (const preset of PROVIDER_PRESETS) {
    if (preset.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      return preset;
    }
  }
  return null;
}

export function defaultServerForEmail(email: string): MailServerConfig {
  const preset = detectProvider(email);
  if (preset) return { ...preset.server };
  const domain = email.trim().toLowerCase().split('@')[1] || 'example.com';
  return {
    imapHost: `imap.${domain}`,
    imapPort: 993,
    imapTls: 'tls',
    smtpHost: `smtp.${domain}`,
    smtpPort: 465,
    smtpTls: 'tls',
  };
}

// All colors WCAG AA >= 4.5:1 with #ffffff text
const AVATAR_COLORS = [
  '#1a73e8',
  '#188038',
  '#c5221f',
  '#b05a00',
  '#007b83',
  '#3f51b5',
  '#137333',
  '#9c4d00',
  '#1967d2',
  '#455a64',
];

export function colorForString(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? '#1a73e8';
}

export function initialsForName(name: string, email: string): string {
  const stripped = (name || '').replace(/\s*[（(【\[][^）)】\]]*[）)】\]]/g, '').trim();
  const clean = stripped || (name || email || '?').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}
