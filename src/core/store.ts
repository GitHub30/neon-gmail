import type {
  AppSettings,
  ComposeDraft,
  CustomLabel,
  InboxCategory,
  MailAccount,
  MailAttachment,
  MailMessage,
  MailThread,
  SystemFolder,
} from '../types/mail.ts';
import {
  deleteMessagesForAccount,
  loadAccounts,
  loadActiveAccountId,
  loadLabels,
  loadMessagesForAccount,
  loadSettings,
  saveAccounts,
  saveActiveAccountId,
  saveLabels,
  saveMessagesForAccount,
  saveSettings,
} from './storage.ts';
import { matchesSearch } from './search.ts';
import { escapeHtml, plainTextToSafeHtml, safeHexColor } from './sanitizer.ts';
import {
  deleteRemoteMessages,
  fetchRemoteMessages,
  moveRemoteMessages,
  sendRemoteEmail,
  syncRemoteFlags,
} from './proxyClient.ts';
import { colorForString, defaultServerForEmail } from '../data/providers.ts';
import { t, type DictKey } from '../data/i18n.ts';

export interface ToastItem {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  variant?: 'default' | 'error' | 'success';
}

export interface PendingSend {
  id: string;
  timerId: ReturnType<typeof setTimeout>;
  draft: ComposeDraft;
}

export type StoreChangeKind = 'all' | 'toasts' | 'list';
export type StoreListener = (kind: StoreChangeKind) => void;

const EMAIL_SIMPLE_RE = /^[^\s@<>()[\],;:\\"]+@[^\s@<>()[\],;:\\"]+\.[^\s@<>()[\],;:\\"]+$/;

export function extractEmailAddr(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/<([^<>]+)>/);
  const addr = (m ? m[1] : trimmed) ?? '';
  return EMAIL_SIMPLE_RE.test(addr.trim()) ? addr.trim() : null;
}

export class MailStore {
  accounts: MailAccount[] = [];
  activeAccountId = '';
  messages: MailMessage[] = [];
  labels: CustomLabel[] = [];
  settings: AppSettings;

  activeFolder: SystemFolder = 'inbox';
  activeCategory: InboxCategory = 'primary';
  activeLabelId: string | null = null;
  searchQuery = '';
  selectedThreadIds = new Set<string>();
  openThreadId: string | null = null;
  focusedThreadIndex = -1;
  currentPage = 1;
  isSyncing = false;
  syncError: string | null = null;
  sidebarOpenMobile = false;

  drafts: ComposeDraft[] = [];
  toasts: ToastItem[] = [];
  private pendingSends = new Map<string, PendingSend>();
  private listeners = new Set<StoreListener>();
  private scheduleTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.settings = loadSettings();
    this.labels = loadLabels();
    this.accounts = loadAccounts();
    this.activeAccountId = loadActiveAccountId(this.accounts);
    const active = this.getActiveAccount();
    this.messages = active ? loadMessagesForAccount(active) : [];
    this.applyTheme();
    this.startBackgroundTimers();
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(kind: StoreChangeKind = 'all'): void {
    for (const l of this.listeners) l(kind);
  }

  destroy(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    for (const p of this.pendingSends.values()) clearTimeout(p.timerId);
    this.pendingSends.clear();
  }

  private startBackgroundTimers(): void {
    this.scheduleTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const msg of this.messages) {
        if (msg.folder === 'snoozed' && msg.snoozedUntil && Date.parse(msg.snoozedUntil) <= now) {
          msg.folder = 'inbox';
          msg.isRead = false;
          msg.snoozedUntil = undefined;
          msg.date = new Date().toISOString();
          changed = true;
        }
        if (msg.folder === 'scheduled' && msg.scheduledFor && Date.parse(msg.scheduledFor) <= now) {
          msg.folder = 'sent';
          msg.scheduledFor = undefined;
          msg.date = new Date().toISOString();
          changed = true;
          const acc = this.accounts.find((a) => a.id === msg.accountId);
          if (acc && this.hasLiveProxy(acc)) {
            void sendRemoteEmail(acc, {
              to: msg.to,
              cc: msg.cc,
              bcc: msg.bcc ?? [],
              subject: msg.subject,
              textBody: msg.textBody,
              htmlBody: msg.htmlBody,
              inReplyTo: msg.inReplyTo,
              attachments: msg.attachments,
            }).catch((e) => this.pushToast(`SMTP Error: ${String(e instanceof Error ? e.message : e)}`, 'error'));
          }
        }
      }
      if (changed) {
        this.persistMessages();
        this.emit('list');
      }
    }, 15000);
  }

  tr(key: DictKey): string {
    return t(this.settings.locale, key);
  }

  hasLiveProxy(acc?: MailAccount): boolean {
    return Boolean(acc && acc.proxyUrl.trim() && acc.proxyType !== 'local');
  }

  getActiveAccount(): MailAccount | undefined {
    return this.accounts.find((a) => a.id === this.activeAccountId) ?? this.accounts[0];
  }

  getActiveDrafts(): ComposeDraft[] {
    return this.drafts.filter((d) => d.accountId === this.activeAccountId);
  }

  applyTheme(): void {
    if (typeof document === 'undefined') return;
    const mode = this.settings.theme;
    const resolved =
      mode === 'system'
        ? (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : mode;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('lang', this.settings.locale);
    document.documentElement.setAttribute('data-density', this.settings.density);
    const meta = document.getElementById('meta-theme-color');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#111317' : '#f6f8fc');
  }

  updateSettings(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    this.applyTheme();
    this.emit('all');
  }

  toggleTheme(): void {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    this.updateSettings({ theme: current === 'dark' ? 'light' : 'dark' });
  }

  private persistMessages(): void {
    const active = this.getActiveAccount();
    if (!active) return;
    const ok = saveMessagesForAccount(active.id, this.messages);
    if (!ok) {
      this.pushToast(
        this.settings.locale === 'ja'
          ? 'ブラウザの保存容量上限に達しました。不要なメールや添付を削除してください。'
          : 'Browser localStorage quota reached. Remove large drafts/attachments to save changes.',
        'error',
        undefined,
        undefined,
        7000,
      );
    }
  }

  pushToast(message: string, variant: ToastItem['variant'] = 'default', actionLabel?: string, onAction?: () => void, durationMs = 5000): string {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.toasts = [...this.toasts.slice(-2), { id, message, variant, actionLabel, onAction }];
    this.emit('toasts');
    setTimeout(() => {
      this.dismissToast(id);
    }, durationMs);
    return id;
  }

  dismissToast(id: string): void {
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((x) => x.id !== id);
    if (this.toasts.length !== before) this.emit('toasts');
  }

  // ---- Account Management ----

  addOrUpdateAccount(input: {
    id?: string;
    email: string;
    password: string;
    displayName?: string;
    proxyUrl?: string;
    proxyType?: MailAccount['proxyType'];
    proxyToken?: string;
    server?: MailAccount['server'];
    signature?: string;
  }): MailAccount {
    const email = input.email.trim();
    const existing = input.id
      ? this.accounts.find((a) => a.id === input.id)
      : this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());

    const server = input.server ?? defaultServerForEmail(email);
    const proxyUrl = (input.proxyUrl ?? '').trim();
    const proxyType: MailAccount['proxyType'] =
      input.proxyType === 'local'
        ? 'local'
        : proxyUrl
          ? (input.proxyType || (proxyUrl.toLowerCase().endsWith('.php') ? 'php' : 'auto'))
          : 'local';

    if (existing) {
      const updated: MailAccount = {
        ...existing,
        email,
        password: input.password,
        displayName: input.displayName?.trim() || existing.displayName || email.split('@')[0] || email,
        proxyUrl,
        proxyType,
        proxyToken: (input.proxyToken ?? existing.proxyToken ?? '').trim(),
        server,
        signature: input.signature ?? existing.signature,
        isDemo: false,
      };
      this.accounts = this.accounts.map((a) => (a.id === existing.id ? updated : a));
      saveAccounts(this.accounts);
      this.switchAccount(updated.id);
      return updated;
    }

    const newAcc: MailAccount = {
      id: `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      email,
      password: input.password,
      displayName: input.displayName?.trim() || email.split('@')[0] || email,
      proxyUrl,
      proxyType,
      proxyToken: (input.proxyToken ?? '').trim(),
      server,
      signature: input.signature ?? '',
      avatarColor: safeHexColor(colorForString(email)),
      isDemo: false,
      addedAt: new Date().toISOString(),
    };
    this.accounts = [...this.accounts, newAcc];
    saveAccounts(this.accounts);
    saveMessagesForAccount(newAcc.id, []);
    this.switchAccount(newAcc.id);
    if (this.hasLiveProxy(newAcc)) {
      void this.syncActiveAccount();
    }
    return newAcc;
  }

  switchAccount(accountId: string): void {
    const target = this.accounts.find((a) => a.id === accountId);
    if (!target) return;
    this.activeAccountId = target.id;
    saveActiveAccountId(target.id);
    this.messages = loadMessagesForAccount(target);
    this.openThreadId = null;
    this.selectedThreadIds.clear();
    this.activeFolder = 'inbox';
    this.activeLabelId = null;
    this.focusedThreadIndex = -1;
    this.currentPage = 1;
    this.syncError = null;
    this.emit('all');
  }

  removeAccount(accountId: string): void {
    this.accounts = this.accounts.filter((a) => a.id !== accountId);
    this.drafts = this.drafts.filter((d) => d.accountId !== accountId);
    deleteMessagesForAccount(accountId);
    saveAccounts(this.accounts);
    if (this.activeAccountId === accountId) {
      const next = this.accounts[0];
      this.activeAccountId = next?.id ?? '';
      saveActiveAccountId(this.activeAccountId);
      this.messages = next ? loadMessagesForAccount(next) : [];
      this.openThreadId = null;
      this.selectedThreadIds.clear();
      this.focusedThreadIndex = -1;
    }
    this.emit('all');
  }

  signOutAll(): void {
    for (const acc of this.accounts) {
      deleteMessagesForAccount(acc.id);
    }
    this.accounts = [];
    this.drafts = [];
    saveAccounts([]);
    this.activeAccountId = '';
    saveActiveAccountId('');
    this.messages = [];
    this.openThreadId = null;
    this.selectedThreadIds.clear();
    this.focusedThreadIndex = -1;
    this.emit('all');
  }

  // ---- Remote IMAP Sync (race-safe across account switches) ----

  async syncActiveAccount(): Promise<void> {
    const acc = this.getActiveAccount();
    if (!acc) return;
    if (!this.hasLiveProxy(acc)) {
      this.pushToast(this.tr('syncedToast'), 'success');
      return;
    }
    const targetAccId = acc.id;
    const folderToFetch: SystemFolder =
      this.activeFolder === 'sent' || this.activeFolder === 'drafts' || this.activeFolder === 'spam' || this.activeFolder === 'trash'
        ? this.activeFolder
        : 'inbox';

    this.isSyncing = true;
    this.syncError = null;
    this.emit('all');
    try {
      const { messages: remote } = await fetchRemoteMessages(acc, folderToFetch, 25, 1);

      // Account-scoped merge so switching accounts mid-sync never leaks messages into another account
      const currentBucket = this.activeAccountId === targetAccId ? this.messages : loadMessagesForAccount(acc);
      const otherMsgs = currentBucket.filter((m) => m.folder !== folderToFetch || !m.uid);
      const merged = [...remote, ...otherMsgs.filter((local) => !remote.some((r) => r.id === local.id))];

      if (this.activeAccountId === targetAccId) {
        this.messages = merged;
        this.persistMessages();
      } else {
        saveMessagesForAccount(targetAccId, merged);
      }

      const accRef = this.accounts.find((a) => a.id === targetAccId);
      if (accRef) {
        accRef.lastSyncedAt = new Date().toISOString();
        saveAccounts(this.accounts);
      }
      this.pushToast(`${this.tr('syncedToast')} (${remote.length})`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.activeAccountId === targetAccId) this.syncError = msg;
      this.pushToast(`Sync error: ${msg}`, 'error', undefined, undefined, 7000);
    } finally {
      this.isSyncing = false;
      this.emit('all');
    }
  }

  // ---- Thread Computation ----

  getAllThreads(): MailThread[] {
    const grouped = new Map<string, MailMessage[]>();
    for (const msg of this.messages) {
      const list = grouped.get(msg.threadId) ?? [];
      list.push(msg);
      grouped.set(msg.threadId, list);
    }

    const threads: MailThread[] = [];
    for (const [id, msgs] of grouped.entries()) {
      msgs.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      const latest = msgs[msgs.length - 1]!;
      const participants: Array<{ name: string; email: string }> = [];
      const seen = new Set<string>();
      for (const m of msgs) {
        const key = m.fromEmail.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          participants.push({ name: m.fromName || m.fromEmail, email: m.fromEmail });
        }
      }
      const labelSet = new Set<string>();
      for (const m of msgs) for (const l of m.labels) labelSet.add(l);

      threads.push({
        id,
        subject: msgs[0]!.subject || '(No Subject)',
        messages: msgs,
        latestDate: latest.date,
        unreadCount: msgs.filter((m) => !m.isRead).length,
        isStarred: msgs.some((m) => m.isStarred),
        isImportant: msgs.some((m) => m.isImportant),
        hasAttachments: msgs.some((m) => m.attachments.length > 0),
        folder: latest.folder,
        category: latest.category,
        labels: Array.from(labelSet),
        participants,
        snippet: latest.snippet || latest.textBody.slice(0, 140),
        snoozedUntil: latest.snoozedUntil,
        scheduledFor: latest.scheduledFor,
      });
    }

    threads.sort((a, b) => Date.parse(b.latestDate) - Date.parse(a.latestDate));
    return threads;
  }

  getVisibleThreads(): MailThread[] {
    const all = this.getAllThreads();
    const labelMap = new Map(this.labels.map((l) => [l.id, l.name]));
    const activeEmail = this.getActiveAccount()?.email.toLowerCase() ?? '';

    if (this.searchQuery.trim()) {
      return all.filter((th) => matchesSearch(th, this.searchQuery, labelMap));
    }

    if (this.activeLabelId) {
      return all.filter((th) => th.labels.includes(this.activeLabelId!) && th.folder !== 'trash' && th.folder !== 'spam');
    }

    switch (this.activeFolder) {
      case 'inbox':
        return all.filter((th) => th.folder === 'inbox' && th.category === this.activeCategory);
      case 'starred':
        return all.filter((th) => th.isStarred && th.folder !== 'trash' && th.folder !== 'spam');
      case 'sent':
        return all.filter(
          (th) =>
            th.folder === 'sent' ||
            (Boolean(activeEmail) &&
              th.folder !== 'trash' &&
              th.folder !== 'spam' &&
              th.folder !== 'drafts' &&
              th.folder !== 'scheduled' &&
              th.messages.some((m) => m.fromEmail.toLowerCase() === activeEmail)),
        );
      case 'important':
        return all.filter((th) => th.isImportant && th.folder !== 'trash' && th.folder !== 'spam');
      case 'all':
        return all.filter((th) => th.folder !== 'trash' && th.folder !== 'spam');
      default:
        return all.filter((th) => th.folder === this.activeFolder);
    }
  }

  getFolderCounts(): Record<SystemFolder, number> {
    const all = this.getAllThreads();
    const activeEmail = this.getActiveAccount()?.email.toLowerCase() ?? '';
    return {
      inbox: all.filter((th) => th.folder === 'inbox' && th.unreadCount > 0).length,
      starred: all.filter((th) => th.isStarred && th.folder !== 'trash' && th.folder !== 'spam').length,
      snoozed: all.filter((th) => th.folder === 'snoozed').length,
      sent: all.filter(
        (th) => th.folder === 'sent' || (Boolean(activeEmail) && th.messages.some((m) => m.fromEmail.toLowerCase() === activeEmail && m.folder !== 'drafts')),
      ).length,
      drafts: all.filter((th) => th.folder === 'drafts').length,
      scheduled: all.filter((th) => th.folder === 'scheduled').length,
      important: all.filter((th) => th.isImportant && th.unreadCount > 0 && th.folder !== 'trash' && th.folder !== 'spam').length,
      all: all.filter((th) => th.folder !== 'trash' && th.folder !== 'spam').length,
      spam: all.filter((th) => th.folder === 'spam').length,
      trash: all.filter((th) => th.folder === 'trash').length,
    };
  }

  getCategoryUnreadCounts(): Record<InboxCategory, number> {
    const all = this.getAllThreads().filter((th) => th.folder === 'inbox' && th.unreadCount > 0);
    return {
      primary: all.filter((th) => th.category === 'primary').length,
      promotions: all.filter((th) => th.category === 'promotions').length,
      social: all.filter((th) => th.category === 'social').length,
      updates: all.filter((th) => th.category === 'updates').length,
    };
  }

  getUnreadCountForAccount(account: MailAccount): number {
    const msgs = account.id === this.activeAccountId ? this.messages : loadMessagesForAccount(account);
    const unreadThreads = new Set(msgs.filter((m) => m.folder === 'inbox' && !m.isRead).map((m) => m.threadId));
    return unreadThreads.size;
  }

  // ---- Navigation & Selection ----

  setFolder(folder: SystemFolder): void {
    this.activeFolder = folder;
    this.activeLabelId = null;
    this.searchQuery = '';
    this.openThreadId = null;
    this.selectedThreadIds.clear();
    this.focusedThreadIndex = -1;
    this.currentPage = 1;
    this.sidebarOpenMobile = false;
    this.emit('all');
  }

  setCategory(cat: InboxCategory): void {
    this.activeFolder = 'inbox';
    this.activeCategory = cat;
    this.activeLabelId = null;
    this.openThreadId = null;
    this.selectedThreadIds.clear();
    this.focusedThreadIndex = -1;
    this.currentPage = 1;
    this.emit('list');
  }

  setLabelFilter(labelId: string): void {
    this.activeLabelId = labelId;
    this.searchQuery = '';
    this.openThreadId = null;
    this.selectedThreadIds.clear();
    this.focusedThreadIndex = -1;
    this.currentPage = 1;
    this.sidebarOpenMobile = false;
    this.emit('all');
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query;
    this.openThreadId = null;
    this.selectedThreadIds.clear();
    this.focusedThreadIndex = -1;
    this.currentPage = 1;
    // Emit 'list' so Header's search input is NEVER destroyed mid-typing/IME!
    this.emit('list');
  }

  openThread(threadId: string): void {
    const thread = this.getAllThreads().find((x) => x.id === threadId);
    if (!thread) return;

    if (thread.folder === 'drafts' && thread.messages.length === 1) {
      const m = thread.messages[0]!;
      this.openCompose({
        id: m.id,
        to: m.to,
        cc: m.cc,
        bcc: m.bcc ?? [],
        subject: m.subject,
        htmlBody: m.htmlBody || plainTextToSafeHtml(m.textBody),
        textBody: m.textBody,
        attachments: m.attachments,
      });
      return;
    }

    this.openThreadId = threadId;
    if (thread.unreadCount > 0) {
      this.setThreadsRead([threadId], true, false);
    }
    this.emit('all');
  }

  closeThread(): void {
    this.openThreadId = null;
    this.emit('all');
  }

  toggleSelectThread(threadId: string): void {
    if (this.selectedThreadIds.has(threadId)) this.selectedThreadIds.delete(threadId);
    else this.selectedThreadIds.add(threadId);
    this.emit('list');
  }

  selectThreadsByFilter(mode: 'all' | 'none' | 'read' | 'unread' | 'starred'): void {
    this.selectedThreadIds.clear();
    if (mode !== 'none') {
      for (const th of this.getVisibleThreads()) {
        if (
          mode === 'all' ||
          (mode === 'read' && th.unreadCount === 0) ||
          (mode === 'unread' && th.unreadCount > 0) ||
          (mode === 'starred' && th.isStarred)
        ) {
          this.selectedThreadIds.add(th.id);
        }
      }
    }
    this.emit('list');
  }

  // ---- Mail Actions (with folder-grouped IMAP sync) ----

  private groupUidsByFolder(threadIds: string[]): Map<SystemFolder, number[]> {
    const set = new Set(threadIds);
    const byFolder = new Map<SystemFolder, number[]>();
    for (const m of this.messages) {
      if (set.has(m.threadId) && m.uid) {
        const arr = byFolder.get(m.folder) ?? [];
        arr.push(m.uid);
        byFolder.set(m.folder, arr);
      }
    }
    return byFolder;
  }

  toggleStar(threadId: string): void {
    const msgs = this.messages.filter((m) => m.threadId === threadId);
    if (!msgs.length) return;
    const nextStar = !msgs.some((m) => m.isStarred);
    const uidsByFolder = this.groupUidsByFolder([threadId]);
    for (const m of msgs) m.isStarred = nextStar;
    this.persistMessages();
    const acc = this.getActiveAccount();
    if (this.hasLiveProxy(acc)) {
      for (const [folder, uids] of uidsByFolder.entries()) {
        void syncRemoteFlags(acc!, folder, uids, nextStar ? 'add' : 'remove', ['\\Flagged']).catch(() => {});
      }
    }
    this.emit('all');
  }

  toggleImportant(threadId: string): void {
    const msgs = this.messages.filter((m) => m.threadId === threadId);
    if (!msgs.length) return;
    const nextImp = !msgs.some((m) => m.isImportant);
    for (const m of msgs) m.isImportant = nextImp;
    this.persistMessages();
    this.emit('all');
  }

  setThreadsRead(threadIds: string[], isRead: boolean, notify = true): void {
    const set = new Set(threadIds);
    const uidsByFolder = this.groupUidsByFolder(threadIds);
    for (const m of this.messages) {
      if (set.has(m.threadId)) m.isRead = isRead;
    }
    this.persistMessages();
    const acc = this.getActiveAccount();
    if (this.hasLiveProxy(acc)) {
      for (const [folder, uids] of uidsByFolder.entries()) {
        void syncRemoteFlags(acc!, folder, uids, isRead ? 'add' : 'remove', ['\\Seen']).catch(() => {});
      }
    }
    if (notify) {
      this.pushToast(isRead ? this.tr('markRead') : this.tr('markUnread'));
    }
    this.emit('all');
  }

  archiveThreads(threadIds: string[]): void {
    const set = new Set(threadIds);
    const uidsByFolder = this.groupUidsByFolder(threadIds);
    const prevFolders = new Map<string, SystemFolder>();
    for (const m of this.messages) {
      if (set.has(m.threadId)) {
        prevFolders.set(m.id, m.folder);
        m.folder = 'all';
      }
    }
    if (this.openThreadId && set.has(this.openThreadId)) this.openThreadId = null;
    for (const id of threadIds) this.selectedThreadIds.delete(id);
    this.persistMessages();

    const acc = this.getActiveAccount();
    if (this.hasLiveProxy(acc)) {
      for (const [folder, uids] of uidsByFolder.entries()) {
        void moveRemoteMessages(acc!, folder, uids, 'all').catch(() => {});
      }
    }

    this.pushToast(this.tr('archivedToast'), 'default', this.tr('undo'), () => {
      for (const m of this.messages) {
        const prev = prevFolders.get(m.id);
        if (prev) m.folder = prev;
      }
      this.persistMessages();
      this.emit('all');
    });
    this.emit('all');
  }

  moveThreadsToFolder(threadIds: string[], targetFolder: SystemFolder, toastKey?: DictKey): void {
    const set = new Set(threadIds);
    const uidsByFolder = this.groupUidsByFolder(threadIds);
    const prevFolders = new Map<string, SystemFolder>();
    for (const m of this.messages) {
      if (set.has(m.threadId)) {
        prevFolders.set(m.id, m.folder);
        m.folder = targetFolder;
        if (targetFolder !== 'snoozed') m.snoozedUntil = undefined;
      }
    }
    if (this.openThreadId && set.has(this.openThreadId)) this.openThreadId = null;
    for (const id of threadIds) this.selectedThreadIds.delete(id);
    this.persistMessages();

    const acc = this.getActiveAccount();
    if (this.hasLiveProxy(acc) && (targetFolder === 'trash' || targetFolder === 'spam' || targetFolder === 'inbox')) {
      for (const [folder, uids] of uidsByFolder.entries()) {
        void moveRemoteMessages(acc!, folder, uids, targetFolder).catch(() => {});
      }
    }

    if (toastKey) {
      this.pushToast(this.tr(toastKey), 'default', this.tr('undo'), () => {
        for (const m of this.messages) {
          const prev = prevFolders.get(m.id);
          if (prev) m.folder = prev;
        }
        this.persistMessages();
        this.emit('all');
      });
    }
    this.emit('all');
  }

  deleteThreads(threadIds: string[]): void {
    if (this.activeFolder === 'trash' || this.activeFolder === 'spam') {
      const set = new Set(threadIds);
      const uidsByFolder = this.groupUidsByFolder(threadIds);
      this.messages = this.messages.filter((m) => !set.has(m.threadId));
      if (this.openThreadId && set.has(this.openThreadId)) this.openThreadId = null;
      for (const id of threadIds) this.selectedThreadIds.delete(id);
      this.persistMessages();

      const acc = this.getActiveAccount();
      if (this.hasLiveProxy(acc)) {
        for (const [folder, uids] of uidsByFolder.entries()) {
          void deleteRemoteMessages(acc!, folder, uids).catch(() => {});
        }
      }

      this.pushToast(this.tr('deleteForever'));
      this.emit('all');
      return;
    }
    this.moveThreadsToFolder(threadIds, 'trash', 'deletedToast');
  }

  emptyTrash(): void {
    const trashUids = this.messages.filter((m) => m.folder === 'trash' && m.uid).map((m) => m.uid!);
    this.messages = this.messages.filter((m) => m.folder !== 'trash');
    this.openThreadId = null;
    this.selectedThreadIds.clear();
    this.persistMessages();

    const acc = this.getActiveAccount();
    if (this.hasLiveProxy(acc) && trashUids.length > 0) {
      void deleteRemoteMessages(acc!, 'trash', trashUids).catch(() => {});
    }

    this.pushToast(this.tr('emptyTrash'));
    this.emit('all');
  }

  snoozeThreads(threadIds: string[], untilIso: string): void {
    const set = new Set(threadIds);
    for (const m of this.messages) {
      if (set.has(m.threadId)) {
        m.folder = 'snoozed';
        m.snoozedUntil = untilIso;
      }
    }
    if (this.openThreadId && set.has(this.openThreadId)) this.openThreadId = null;
    for (const id of threadIds) this.selectedThreadIds.delete(id);
    this.persistMessages();
    this.pushToast(this.tr('snoozedToast'));
    this.emit('all');
  }

  // ---- Custom Labels ----

  createLabel(name: string, color: string): CustomLabel {
    const label: CustomLabel = {
      id: `lbl-${Date.now().toString(36)}`,
      name: name.trim().slice(0, 48),
      color: safeHexColor(color, '#1a73e8'),
    };
    this.labels = [...this.labels, label];
    saveLabels(this.labels);
    this.emit('all');
    return label;
  }

  deleteLabel(labelId: string): void {
    this.labels = this.labels.filter((l) => l.id !== labelId);
    for (const m of this.messages) {
      m.labels = m.labels.filter((id) => id !== labelId);
    }
    if (this.activeLabelId === labelId) this.activeLabelId = null;
    saveLabels(this.labels);
    this.persistMessages();
    this.emit('all');
  }

  toggleLabelOnThreads(threadIds: string[], labelId: string): void {
    const set = new Set(threadIds);
    const affected = this.messages.filter((m) => set.has(m.threadId));
    const alreadyHas = affected.every((m) => m.labels.includes(labelId));
    for (const m of affected) {
      if (alreadyHas) {
        m.labels = m.labels.filter((l) => l !== labelId);
      } else if (!m.labels.includes(labelId)) {
        m.labels = [...m.labels, labelId];
      }
    }
    this.persistMessages();
    this.emit('all');
  }

  // ---- Compose, Drafts, Undo Send & Reply ----

  openCompose(prefill?: Partial<ComposeDraft>): ComposeDraft {
    const acc = this.getActiveAccount();
    const sigHtml = acc?.signature
      ? `<br><br><div class="mail-sig">--<br>${escapeHtml(acc.signature).replace(/\n/g, '<br>')}</div>`
      : '';
    const existing = prefill?.id ? this.drafts.find((d) => d.id === prefill.id) : undefined;
    if (existing) {
      existing.minimized = false;
      this.emit('all');
      return existing;
    }

    const draft: ComposeDraft = {
      id: prefill?.id ?? `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      accountId: acc?.id ?? '',
      to: prefill?.to ?? [],
      cc: prefill?.cc ?? [],
      bcc: prefill?.bcc ?? [],
      subject: prefill?.subject ?? '',
      htmlBody: prefill?.htmlBody ?? sigHtml,
      textBody: prefill?.textBody ?? (acc?.signature ? `\n\n--\n${acc.signature}` : ''),
      attachments: prefill?.attachments ?? [],
      inReplyTo: prefill?.inReplyTo,
      threadId: prefill?.threadId,
      updatedAt: new Date().toISOString(),
      minimized: false,
      expanded: false,
    };
    this.drafts = [...this.drafts, draft];
    this.emit('all');
    return draft;
  }

  updateDraft(draftId: string, patch: Partial<ComposeDraft>): void {
    this.drafts = this.drafts.map((d) =>
      d.id === draftId ? { ...d, ...patch, updatedAt: new Date().toISOString() } : d,
    );
    const current = this.drafts.find((d) => d.id === draftId);
    if (current) this.saveDraftToMailbox(current);
  }

  private saveDraftToMailbox(draft: ComposeDraft): void {
    const acc = this.accounts.find((a) => a.id === draft.accountId);
    if (!acc) return;
    if (!draft.subject && !draft.textBody.trim() && draft.to.length === 0) return;

    const draftMsg: MailMessage = {
      id: draft.id,
      threadId: draft.threadId ?? `thr-${draft.id}`,
      accountId: acc.id,
      fromName: acc.displayName,
      fromEmail: acc.email,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject || '(No Subject)',
      snippet: draft.textBody.replace(/\s+/g, ' ').trim().slice(0, 140),
      textBody: draft.textBody,
      htmlBody: draft.htmlBody,
      date: new Date().toISOString(),
      isRead: true,
      isStarred: false,
      isImportant: false,
      folder: 'drafts',
      category: 'primary',
      labels: [],
      attachments: draft.attachments,
      inReplyTo: draft.inReplyTo,
    };

    if (this.activeAccountId === acc.id) {
      const idx = this.messages.findIndex((m) => m.id === draft.id && m.folder === 'drafts');
      if (idx >= 0) this.messages[idx] = draftMsg;
      else this.messages = [draftMsg, ...this.messages];
      this.persistMessages();
    } else {
      const bucket = loadMessagesForAccount(acc);
      const idx = bucket.findIndex((m) => m.id === draft.id && m.folder === 'drafts');
      if (idx >= 0) bucket[idx] = draftMsg;
      else bucket.unshift(draftMsg);
      saveMessagesForAccount(acc.id, bucket);
    }
  }

  discardDraft(draftId: string): void {
    this.drafts = this.drafts.filter((d) => d.id !== draftId);
    this.messages = this.messages.filter((m) => !(m.id === draftId && m.folder === 'drafts'));
    this.persistMessages();
    this.emit('all');
  }

  closeDraftWindow(draftId: string): void {
    const draft = this.drafts.find((d) => d.id === draftId);
    if (draft) this.saveDraftToMailbox(draft);
    this.drafts = this.drafts.filter((d) => d.id !== draftId);
    this.emit('all');
  }

  sendDraft(draftId: string, scheduleIso?: string): void {
    const draft = this.drafts.find((d) => d.id === draftId);
    if (!draft) return;
    const acc = this.accounts.find((a) => a.id === draft.accountId) ?? this.getActiveAccount();
    if (!acc) return;

    const toValid = draft.to.map(extractEmailAddr).filter((x): x is string => Boolean(x));
    const ccValid = draft.cc.map(extractEmailAddr).filter((x): x is string => Boolean(x));
    const bccValid = draft.bcc.map(extractEmailAddr).filter((x): x is string => Boolean(x));
    const invalidCount =
      (draft.to.length - toValid.length) +
      (draft.cc.length - ccValid.length) +
      (draft.bcc.length - bccValid.length);

    if (invalidCount > 0 || (toValid.length === 0 && ccValid.length === 0 && bccValid.length === 0)) {
      this.pushToast(
        this.settings.locale === 'ja'
          ? '有効なメールアドレスを1件以上入力してください'
          : 'Please enter valid recipient email addresses.',
        'error',
      );
      return;
    }

    const cleanDraft: ComposeDraft = { ...draft, to: toValid, cc: ccValid, bcc: bccValid };

    this.drafts = this.drafts.filter((d) => d.id !== draftId);
    if (this.activeAccountId === acc.id) {
      this.messages = this.messages.filter((m) => !(m.id === draftId && m.folder === 'drafts'));
    } else {
      const bucket = loadMessagesForAccount(acc).filter((m) => !(m.id === draftId && m.folder === 'drafts'));
      saveMessagesForAccount(acc.id, bucket);
    }

    if (scheduleIso) {
      const scheduledMsg: MailMessage = {
        id: `sched-${Date.now().toString(36)}`,
        threadId: cleanDraft.threadId ?? `thr-sched-${Date.now().toString(36)}`,
        accountId: acc.id,
        fromName: acc.displayName,
        fromEmail: acc.email,
        to: cleanDraft.to,
        cc: cleanDraft.cc,
        bcc: cleanDraft.bcc,
        subject: cleanDraft.subject || '(No Subject)',
        snippet: cleanDraft.textBody.replace(/\s+/g, ' ').trim().slice(0, 140),
        textBody: cleanDraft.textBody,
        htmlBody: cleanDraft.htmlBody,
        date: new Date().toISOString(),
        isRead: true,
        isStarred: false,
        isImportant: false,
        folder: 'scheduled',
        category: 'primary',
        labels: [],
        attachments: cleanDraft.attachments,
        scheduledFor: scheduleIso,
        inReplyTo: cleanDraft.inReplyTo,
      };
      if (this.activeAccountId === acc.id) {
        this.messages = [scheduledMsg, ...this.messages];
        this.persistMessages();
      } else {
        saveMessagesForAccount(acc.id, [scheduledMsg, ...loadMessagesForAccount(acc)]);
      }
      this.pushToast(this.tr('scheduleSend'), 'success');
      this.emit('all');
      return;
    }

    const delayMs = Math.max(1, this.settings.undoSendSeconds) * 1000;
    const pendingId = `send-${Date.now().toString(36)}`;
    const timerId = setTimeout(() => {
      this.pendingSends.delete(pendingId);
      void this.commitSend(acc, cleanDraft);
    }, delayMs);

    this.pendingSends.set(pendingId, { id: pendingId, timerId, draft: cleanDraft });
    this.pushToast(
      this.tr('sendingToast'),
      'default',
      this.tr('undo'),
      () => {
        const pending = this.pendingSends.get(pendingId);
        if (!pending) return;
        clearTimeout(pending.timerId);
        this.pendingSends.delete(pendingId);
        this.drafts = [...this.drafts, { ...pending.draft, minimized: false }];
        this.pushToast(this.tr('undoneToast'));
        this.emit('all');
      },
      delayMs,
    );
    this.emit('all');
  }

  private async commitSend(acc: MailAccount, draft: ComposeDraft): Promise<void> {
    if (this.hasLiveProxy(acc)) {
      try {
        await sendRemoteEmail(acc, {
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject || '(No Subject)',
          textBody: draft.textBody,
          htmlBody: draft.htmlBody,
          inReplyTo: draft.inReplyTo,
          attachments: draft.attachments,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.drafts = [...this.drafts, { ...draft, minimized: false }];
        this.pushToast(`SMTP Error: ${msg}`, 'error', undefined, undefined, 8000);
        this.emit('all');
        return;
      }
    }

    const bucket = this.activeAccountId === acc.id ? this.messages : loadMessagesForAccount(acc);
    const parentFolder = draft.threadId ? bucket.find((m) => m.threadId === draft.threadId)?.folder ?? 'sent' : 'sent';

    const sentMsg: MailMessage = {
      id: `sent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      threadId: draft.threadId ?? `thr-sent-${Date.now().toString(36)}`,
      accountId: acc.id,
      fromName: acc.displayName,
      fromEmail: acc.email,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject || '(No Subject)',
      snippet: draft.textBody.replace(/\s+/g, ' ').trim().slice(0, 140),
      textBody: draft.textBody,
      htmlBody: draft.htmlBody,
      date: new Date().toISOString(),
      isRead: true,
      isStarred: false,
      isImportant: false,
      folder: parentFolder,
      category: 'primary',
      labels: [],
      attachments: draft.attachments,
      inReplyTo: draft.inReplyTo,
    };

    if (this.activeAccountId === acc.id) {
      this.messages = [...this.messages, sentMsg];
      this.persistMessages();
    } else {
      saveMessagesForAccount(acc.id, [...bucket, sentMsg]);
    }

    this.pushToast(this.tr('sentToast'), 'success');
    this.emit('all');
  }

  sendQuickReply(thread: MailThread, textBody: string, replyAll = false, attachments: MailAttachment[] = []): void {
    const acc = this.getActiveAccount();
    if (!acc || !textBody.trim()) return;
    const latest = thread.messages[thread.messages.length - 1]!;
    const to = [latest.fromEmail === acc.email ? (latest.to[0] ?? acc.email) : latest.fromEmail];
    const cc = replyAll
      ? [...new Set([...latest.to, ...latest.cc].filter((e) => e.toLowerCase() !== acc.email.toLowerCase() && !to.includes(e)))]
      : [];
    const subj = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`;
    const draft = this.openCompose({
      to,
      cc,
      subject: subj,
      textBody,
      htmlBody: `<p>${escapeHtml(textBody).replace(/\n/g, '<br>')}</p>`,
      attachments,
      inReplyTo: latest.messageId,
      threadId: thread.id,
    });
    this.sendDraft(draft.id);
  }
}
