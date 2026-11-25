import { icons } from '../core/icons.ts';
import { checkProxyHealth, testAccountConnection } from '../core/proxyClient.ts';
import { escapeHtml, sanitizeEmailHtml, sanitizeFilename } from '../core/sanitizer.ts';
import { exportAllBackup, importAllBackup, saveAccounts } from '../core/storage.ts';
import { MailStore, type StoreChangeKind } from '../core/store.ts';
import { createDemoAccounts, createDemoMessages } from '../data/demoMailbox.ts';
import { defaultServerForEmail, detectProvider } from '../data/providers.ts';
import type { InboxCategory, MailAccount, MailAttachment, ReadingPaneMode, SystemFolder } from '../types/mail.ts';
import { renderComposeDock } from './ComposeModal.ts';
import { computeSnoozeDate } from './formatDate.ts';
import { renderHeader } from './Header.ts';
import { createInitialLoginState, renderLoginModal, type LoginModalState } from './LoginModal.ts';
import { renderMessageList } from './MessageList.ts';
import { renderSettingsModal } from './SettingsModal.ts';
import { renderNewLabelModal, renderShortcutsModal } from './ShortcutsModal.ts';
import { renderSidebar } from './Sidebar.ts';
import { renderThreadView, type ThreadUiState } from './ThreadView.ts';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class NeonGmailApp {
  private root: HTMLElement;
  private store: MailStore;

  // Persistent DOM slots so toast updates & search filtering NEVER wipe active forms, IME, or scroll!
  private shellEl!: HTMLElement;
  private headerSlot!: HTMLElement;
  private sidebarSlot!: HTMLElement;
  private mainSlot!: HTMLElement;
  private fabSlot!: HTMLElement;
  private composeSlot!: HTMLElement;
  private modalSlot!: HTMLElement;
  private toastSlot!: HTMLElement;

  private sidebarCollapsed = false;
  private accountMenuOpen = false;
  private advSearchOpen = false;
  private selectMenuOpen = false;
  private labelMenuOpen = false;
  private snoozeMenuOpen = false;

  private settingsOpen = false;
  private shortcutsOpen = false;
  private newLabelOpen = false;
  private loginState: LoginModalState = { ...createInitialLoginState(), open: false };

  private showCcBccIds = new Set<string>();
  private scheduleOpenDraftId: string | null = null;
  private threadUi: ThreadUiState = {
    expandedMsgIds: new Set(),
    collapsedMsgIds: new Set(),
    showImagesMsgIds: new Set(),
    showRawMsgIds: new Set(),
    inlineReplyMode: null,
    inlineReplyText: '',
    labelMenuOpen: false,
    snoozeMenuOpen: false,
  };

  private isSearchComposing = false;
  private lastTriggerBeforeModal: HTMLElement | null = null;
  private pendingGoKey = false;
  private goKeyTimer?: ReturnType<typeof setTimeout>;
  private deferredInstallPrompt: BeforeInstallPromptEvent | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.store = new MailStore();
    this.handleUrlParams();
    this.mountPersistentShell();
    this.bindGlobalEvents();
    this.store.subscribe((kind) => this.onStoreChange(kind));
    this.renderAll();
  }

  private mountPersistentShell(): void {
    this.root.innerHTML = `
      <div class="gmail-shell" id="gmail-shell">
        <div id="header-slot" class="slot-contents"></div>
        <div class="mobile-backdrop" data-action="close-mobile-drawer" aria-hidden="true"></div>
        <div id="sidebar-slot" class="slot-contents"></div>
        <main id="main-content" class="main-canvas"></main>
      </div>
      <div id="fab-slot"></div>
      <div id="compose-slot"></div>
      <div id="modal-slot"></div>
      <div id="toast-slot"></div>
    `;
    this.shellEl = this.root.querySelector('#gmail-shell')!;
    this.headerSlot = this.root.querySelector('#header-slot')!;
    this.sidebarSlot = this.root.querySelector('#sidebar-slot')!;
    this.mainSlot = this.root.querySelector('#main-content')!;
    this.fabSlot = this.root.querySelector('#fab-slot')!;
    this.composeSlot = this.root.querySelector('#compose-slot')!;
    this.modalSlot = this.root.querySelector('#modal-slot')!;
    this.toastSlot = this.root.querySelector('#toast-slot')!;
  }

  private onStoreChange(kind: StoreChangeKind): void {
    if (kind === 'toasts') {
      this.renderToastsSlot();
      return;
    }
    if (kind === 'list') {
      this.renderMainSlot();
      this.renderSidebarSlot();
      const clearBtn = this.headerSlot.querySelector<HTMLElement>('#clear-search-btn');
      if (clearBtn) clearBtn.style.display = this.store.searchQuery ? '' : 'none';
      return;
    }
    this.renderAll();
  }

  private handleUrlParams(): void {
    try {
      const params = new URLSearchParams(window.location.search);
      const lang = params.get('lang');
      if (lang === 'en' || lang === 'ja') {
        this.store.updateSettings({ locale: lang });
      }
      const folder = params.get('folder') as SystemFolder | null;
      if (folder && ['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'scheduled', 'important', 'all', 'spam', 'trash'].includes(folder)) {
        this.store.activeFolder = folder;
      }
      const q = params.get('q');
      if (q) this.store.searchQuery = q;
      if (params.get('compose') === '1') {
        this.store.openCompose();
      }
    } catch {
      // ignore
    }
  }

  private isAnyModalOpen(): boolean {
    return this.loginState.open || this.settingsOpen || this.shortcutsOpen || this.newLabelOpen;
  }

  private openModalCleanup(): void {
    this.lastTriggerBeforeModal = document.activeElement as HTMLElement | null;
    this.closeAllPopovers();
  }

  private closeAllModals(): void {
    const wasOpen = this.isAnyModalOpen();
    this.loginState.open = false;
    this.settingsOpen = false;
    this.shortcutsOpen = false;
    this.newLabelOpen = false;
    this.renderModalSlot();
    if (wasOpen && this.lastTriggerBeforeModal && document.contains(this.lastTriggerBeforeModal)) {
      this.lastTriggerBeforeModal.focus();
      this.lastTriggerBeforeModal = null;
    }
  }

  private closeAllPopovers(): void {
    this.accountMenuOpen = false;
    this.advSearchOpen = false;
    this.selectMenuOpen = false;
    this.labelMenuOpen = false;
    this.snoozeMenuOpen = false;
    this.threadUi.labelMenuOpen = false;
    this.threadUi.snoozeMenuOpen = false;
    this.scheduleOpenDraftId = null;
  }

  private bindGlobalEvents(): void {
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.store.settings.theme === 'system') {
        this.store.applyTheme();
        this.renderHeaderSlot();
      }
    });

    window.addEventListener('resize', () => {
      this.syncShellClasses();
      this.renderSidebarSlot();
      this.renderMainSlot();
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e as BeforeInstallPromptEvent;
      this.renderHeaderSlot();
    });

    // Close popovers on outside click
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      let headerDirty = false;
      let mainDirty = false;
      let composeDirty = false;

      if (this.accountMenuOpen && !target.closest('.account-switcher-wrap')) {
        this.accountMenuOpen = false;
        headerDirty = true;
      }
      if (this.advSearchOpen && !target.closest('.search-wrap')) {
        this.advSearchOpen = false;
        headerDirty = true;
      }
      if ((this.selectMenuOpen || this.labelMenuOpen || this.snoozeMenuOpen || this.threadUi.labelMenuOpen || this.threadUi.snoozeMenuOpen) && !target.closest('.popover-wrap')) {
        this.selectMenuOpen = false;
        this.labelMenuOpen = false;
        this.snoozeMenuOpen = false;
        this.threadUi.labelMenuOpen = false;
        this.threadUi.snoozeMenuOpen = false;
        mainDirty = true;
      }
      if (this.scheduleOpenDraftId && !target.closest('.popover-wrap')) {
        this.scheduleOpenDraftId = null;
        composeDirty = true;
      }

      if (headerDirty) this.renderHeaderSlot();
      if (mainDirty) this.renderMainSlot();
      if (composeDirty) this.renderComposeSlot();
    });

    // CJK IME composition safety for search bar
    this.root.addEventListener('compositionstart', (e) => {
      if ((e.target as HTMLElement | null)?.id === 'global-search-input') {
        this.isSearchComposing = true;
      }
    });
    this.root.addEventListener('compositionend', (e) => {
      const target = e.target as HTMLInputElement | null;
      if (target?.id === 'global-search-input') {
        this.isSearchComposing = false;
        this.store.setSearchQuery(target.value);
      }
    });

    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('input', (e) => this.onInput(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
    this.root.addEventListener('submit', (e) => this.onSubmit(e));
    this.root.addEventListener('keydown', (e) => this.onRootKeydown(e));
    document.addEventListener('keydown', (e) => this.onGlobalKeydown(e));
  }

  private onRootKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // ARIA tablist Left/Right arrow keyboard support on Inbox categories
    if (target.matches('.category-tab') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const cats: InboxCategory[] = ['primary', 'promotions', 'social', 'updates'];
      const cur = cats.indexOf(this.store.activeCategory);
      const next = cats[(cur + (e.key === 'ArrowRight' ? 1 : cats.length - 1)) % cats.length]!;
      this.store.setCategory(next);
      this.mainSlot.querySelector<HTMLElement>(`#cat-tab-${next}`)?.focus();
    }
  }

  private trapModalFocus(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || !this.isAnyModalOpen()) return;
    const dialog = this.modalSlot.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => el.offsetParent !== null || el.classList.contains('sr-only'),
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private onGlobalKeydown(e: KeyboardEvent): void {
    if (this.isAnyModalOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeAllModals();
        return;
      }
      this.trapModalFocus(e);
      return;
    }

    if (e.key === 'Escape') {
      const hadPopovers =
        this.accountMenuOpen ||
        this.advSearchOpen ||
        this.selectMenuOpen ||
        this.labelMenuOpen ||
        this.snoozeMenuOpen ||
        this.threadUi.labelMenuOpen ||
        this.threadUi.snoozeMenuOpen ||
        Boolean(this.scheduleOpenDraftId) ||
        this.store.sidebarOpenMobile;

      if (hadPopovers) {
        this.closeAllPopovers();
        this.store.sidebarOpenMobile = false;
        this.renderAll();
        return;
      }
      if (this.store.openThreadId && (this.store.settings.readingPane === 'none' || window.innerWidth <= 900)) {
        this.store.closeThread();
        return;
      }
      return;
    }

    if (!this.store.settings.keyboardShortcuts) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) {
      return;
    }

    const key = e.key;

    if (this.pendingGoKey) {
      this.pendingGoKey = false;
      clearTimeout(this.goKeyTimer);
      if (key === 'i') { this.store.setFolder('inbox'); return; }
      if (key === 's') { this.store.setFolder('starred'); return; }
      if (key === 't') { this.store.setFolder('sent'); return; }
      if (key === 'd') { this.store.setFolder('drafts'); return; }
      if (key === 'a') { this.store.setFolder('all'); return; }
      return;
    }

    if (key === 'g') {
      this.pendingGoKey = true;
      this.goKeyTimer = setTimeout(() => { this.pendingGoKey = false; }, 1200);
      return;
    }

    if (key === '?') {
      e.preventDefault();
      this.openModalCleanup();
      this.shortcutsOpen = true;
      this.renderModalSlot();
      this.modalSlot.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
      return;
    }

    if (key === '/') {
      e.preventDefault();
      this.headerSlot.querySelector<HTMLInputElement>('#global-search-input')?.focus();
      return;
    }

    if (key === 'c') {
      e.preventDefault();
      this.store.openCompose();
      return;
    }

    // Current page threads slice for j/k navigation
    const allVisible = this.store.getVisibleThreads();
    const pageSize = this.store.settings.pageSize;
    const startIdx = (this.store.currentPage - 1) * pageSize;
    const pageThreads = allVisible.slice(startIdx, startIdx + pageSize);

    const targetIds = this.store.openThreadId
      ? [this.store.openThreadId]
      : this.store.selectedThreadIds.size > 0
        ? Array.from(this.store.selectedThreadIds)
        : (pageThreads[this.store.focusedThreadIndex] ? [pageThreads[this.store.focusedThreadIndex]!.id] : []);

    if (key === 'j' && pageThreads.length > 0) {
      e.preventDefault();
      this.store.focusedThreadIndex = Math.min(pageThreads.length - 1, this.store.focusedThreadIndex + 1);
      const btn = this.mainSlot.querySelectorAll<HTMLElement>('.row-open-btn')[this.store.focusedThreadIndex];
      btn?.focus();
      return;
    }

    if (key === 'k' && pageThreads.length > 0) {
      e.preventDefault();
      this.store.focusedThreadIndex = Math.max(0, this.store.focusedThreadIndex - 1);
      const btn = this.mainSlot.querySelectorAll<HTMLElement>('.row-open-btn')[this.store.focusedThreadIndex];
      btn?.focus();
      return;
    }

    // NEVER hijack Enter when focus is already on a button or link!
    const isInteractiveFocused = Boolean(active && (active.tagName === 'BUTTON' || active.tagName === 'A'));
    if ((key === 'o' || (key === 'Enter' && !isInteractiveFocused)) && !this.store.openThreadId && pageThreads[this.store.focusedThreadIndex]) {
      e.preventDefault();
      this.openThreadResetUi(pageThreads[this.store.focusedThreadIndex]!.id);
      return;
    }

    if (key === 'u' && this.store.openThreadId) {
      e.preventDefault();
      this.store.closeThread();
      return;
    }

    if (targetIds.length > 0) {
      if (key === 'e') { e.preventDefault(); this.store.archiveThreads(targetIds); return; }
      if (key === '#') { e.preventDefault(); this.store.deleteThreads(targetIds); return; }
      if (key === '!') { e.preventDefault(); this.store.moveThreadsToFolder(targetIds, 'spam', 'spamToast'); return; }
      if (key === 's') { e.preventDefault(); this.store.toggleStar(targetIds[0]!); return; }
      if (e.shiftKey && key === 'I') { e.preventDefault(); this.store.setThreadsRead(targetIds, true); return; }
      if (e.shiftKey && key === 'U') { e.preventDefault(); this.store.setThreadsRead(targetIds, false); return; }
    }

    if (this.store.openThreadId) {
      if (key === 'r') {
        e.preventDefault();
        this.threadUi.inlineReplyMode = 'reply';
        this.renderMainSlot();
        this.mainSlot.querySelector<HTMLTextAreaElement>('#inline-reply-textarea')?.focus();
        return;
      }
      if (key === 'a') {
        e.preventDefault();
        this.threadUi.inlineReplyMode = 'replyAll';
        this.renderMainSlot();
        this.mainSlot.querySelector<HTMLTextAreaElement>('#inline-reply-textarea')?.focus();
        return;
      }
      if (key === 'f') {
        e.preventDefault();
        this.forwardOpenThread();
      }
    }
  }

  private openThreadResetUi(threadId: string): void {
    this.threadUi = {
      expandedMsgIds: new Set(),
      collapsedMsgIds: new Set(),
      showImagesMsgIds: new Set(),
      showRawMsgIds: new Set(),
      inlineReplyMode: null,
      inlineReplyText: '',
      labelMenuOpen: false,
      snoozeMenuOpen: false,
    };
    this.store.openThread(threadId);
  }

  private forwardOpenThread(): void {
    const thread = this.store.getAllThreads().find((t) => t.id === this.store.openThreadId);
    if (!thread) return;
    const latest = thread.messages[thread.messages.length - 1]!;
    const fwdHeader = `\n\n---------- Forwarded message ---------\nFrom: ${latest.fromName} <${latest.fromEmail}>\nDate: ${latest.date}\nSubject: ${latest.subject}\n\n`;
    const safeLatestHtml = latest.htmlBody
      ? sanitizeEmailHtml(latest.htmlBody, this.store.settings.alwaysDisplayImages).html
      : escapeHtml(latest.textBody).replace(/\n/g, '<br>');
    this.store.openCompose({
      subject: /^fwd:/i.test(thread.subject) ? thread.subject : `Fwd: ${thread.subject}`,
      textBody: `${fwdHeader}${latest.textBody}`,
      htmlBody: `<br><br><div>---------- Forwarded message ---------<br>From: ${escapeHtml(latest.fromName)} &lt;${escapeHtml(latest.fromEmail)}&gt;<br>Subject: ${escapeHtml(latest.subject)}</div><br>${safeLatestHtml}`,
      attachments: [...latest.attachments],
    });
  }

  private syncLoginProviderHintInPlace(): void {
    const preset = detectProvider(this.loginState.email);
    const loc = this.store.settings.locale;
    const hintEl = this.modalSlot.querySelector<HTMLElement>('#login-provider-hint');
    if (hintEl) {
      if (preset) {
        hintEl.textContent = loc === 'ja'
          ? `${preset.name} を自動検出しました — ${preset.appPasswordHintJa}`
          : `${preset.name} auto-detected — ${preset.appPasswordHintEn}`;
        hintEl.style.display = '';
      } else {
        hintEl.textContent = '';
        hintEl.style.display = 'none';
      }
    }
    const summaryEl = this.modalSlot.querySelector<HTMLElement>('#login-advanced-summary');
    if (summaryEl) {
      summaryEl.textContent = `${this.store.tr('advancedServerToggle')} (${this.loginState.imapHost}:${this.loginState.imapPort})`;
    }
    // Sync advanced inputs if expanded without re-rendering DOM!
    const setVal = (id: string, val: string | number) => {
      const el = this.modalSlot.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
      if (el) el.value = String(val);
    };
    setVal('login-imap-host', this.loginState.imapHost);
    setVal('login-imap-port', this.loginState.imapPort);
    setVal('login-imap-tls', this.loginState.imapTls);
    setVal('login-smtp-host', this.loginState.smtpHost);
    setVal('login-smtp-port', this.loginState.smtpPort);
    setVal('login-smtp-tls', this.loginState.smtpTls);
  }

  private onInput(e: Event): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Live IME-safe search (only patches #main-content & #sidebar-slot, NEVER touches input!)
    if (target.id === 'global-search-input') {
      if (this.isSearchComposing) return;
      this.store.setSearchQuery((target as HTMLInputElement).value);
      return;
    }

    if (target.id === 'inline-reply-textarea') {
      this.threadUi.inlineReplyText = (target as HTMLTextAreaElement).value;
      return;
    }

    const composeField = target.dataset.composeField;
    if (composeField && target.dataset.draftId) {
      const val = (target as HTMLInputElement).value;
      const draftId = target.dataset.draftId;
      if (composeField === 'subject') {
        this.store.updateDraft(draftId, { subject: val });
      } else if (composeField === 'to' || composeField === 'cc' || composeField === 'bcc') {
        // Split on commas or semicolons only so "Display Name <a@b.com>" stays intact!
        const list = val.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
        this.store.updateDraft(draftId, { [composeField]: list });
      }
      return;
    }

    const editorDraftId = target.dataset.composeEditor;
    if (editorDraftId) {
      this.store.updateDraft(editorDraftId, {
        htmlBody: target.innerHTML,
        textBody: target.innerText || target.textContent || '',
      });
      return;
    }

    if (target.dataset.actionSignature === '1') {
      const active = this.store.getActiveAccount();
      if (active) {
        active.signature = (target as HTMLTextAreaElement).value;
        saveAccounts(this.store.accounts);
      }
      return;
    }

    // Login modal in-place state updates (never destroys modal DOM while typing/clicking!)
    if (target.closest('#login-account-form')) {
      const input = target as HTMLInputElement | HTMLSelectElement;
      const name = input.name as keyof LoginModalState;
      if (name === 'email') {
        this.loginState.email = input.value;
        if (!this.loginState.serverTouched && !this.loginState.editingAccountId) {
          const srv = defaultServerForEmail(input.value);
          this.loginState.imapHost = srv.imapHost;
          this.loginState.imapPort = srv.imapPort;
          this.loginState.imapTls = srv.imapTls;
          this.loginState.smtpHost = srv.smtpHost;
          this.loginState.smtpPort = srv.smtpPort;
          this.loginState.smtpTls = srv.smtpTls;
          this.syncLoginProviderHintInPlace();
        }
      } else if (name === 'imapHost' || name === 'imapPort' || name === 'imapTls' || name === 'smtpHost' || name === 'smtpPort' || name === 'smtpTls') {
        this.loginState.serverTouched = true;
        if (name === 'imapPort' || name === 'smtpPort') {
          this.loginState[name] = Number(input.value) || (name === 'imapPort' ? 993 : 465);
        } else {
          (this.loginState as unknown as Record<string, unknown>)[name] = input.value;
        }
        const summaryEl = this.modalSlot.querySelector<HTMLElement>('#login-advanced-summary');
        if (summaryEl) {
          summaryEl.textContent = `${this.store.tr('advancedServerToggle')} (${this.loginState.imapHost}:${this.loginState.imapPort})`;
        }
      } else if (name in this.loginState) {
        (this.loginState as unknown as Record<string, unknown>)[name] = input.value;
      }
    }
  }

  private onChange(e: Event): void {
    const target = e.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;

    const settingKey = target.dataset.setting;
    if (settingKey) {
      const val = settingKey === 'undoSendSeconds' ? Number(target.value) : target.value;
      this.store.updateSettings({ [settingKey]: val });
      return;
    }

    const boolKey = target.dataset.settingBool;
    if (boolKey && target instanceof HTMLInputElement) {
      this.store.updateSettings({ [boolKey]: target.checked });
      return;
    }

    // Compose attachment file picker (3 MB per file cap so localStorage fits comfortably)
    const attDraftId = target.dataset.composeFile;
    if (attDraftId && target instanceof HTMLInputElement && target.files) {
      const draft = this.store.drafts.find((d) => d.id === attDraftId);
      if (!draft) return;
      const files = Array.from(target.files);
      Promise.all(
        files.map(
          (file) =>
            new Promise<MailAttachment>((resolve, reject) => {
              if (file.size > 3 * 1024 * 1024) {
                reject(new Error(`${file.name} exceeds 3 MB browser attachment limit.`));
                return;
              }
              const reader = new FileReader();
              reader.onload = () => {
                const res = String(reader.result || '');
                const b64 = res.includes(',') ? res.split(',')[1]! : '';
                resolve({
                  id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                  filename: sanitizeFilename(file.name),
                  contentType: file.type || 'application/octet-stream',
                  size: file.size,
                  dataBase64: b64,
                });
              };
              reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
              reader.readAsDataURL(file);
            }),
        ),
      )
        .then((added) => {
          this.store.updateDraft(attDraftId, { attachments: [...draft.attachments, ...added] });
          this.renderComposeSlot();
        })
        .catch((err) => {
          this.store.pushToast(String(err instanceof Error ? err.message : err), 'error');
        });
      return;
    }

    if (target.id === 'import-backup-input' && target instanceof HTMLInputElement && target.files?.[0]) {
      const file = target.files[0];
      file.text().then((text: string) => {
        try {
          importAllBackup(text);
          window.location.reload();
        } catch (err) {
          this.store.pushToast(`Import failed: ${String(err instanceof Error ? err.message : err)}`, 'error');
        }
      });
    }
  }

  private onSubmit(e: Event): void {
    const form = e.target as HTMLFormElement | null;
    if (!form) return;

    if (form.id === 'adv-search-form') {
      e.preventDefault();
      const fd = new FormData(form);
      const quoteIfSpace = (k: string, v: string) => (v.includes(' ') ? `${k}:"${v.replace(/"/g, '')}"` : `${k}:${v}`);
      const parts: string[] = [];
      const from = String(fd.get('from') || '').trim();
      const to = String(fd.get('to') || '').trim();
      const subject = String(fd.get('subject') || '').trim();
      const words = String(fd.get('words') || '').trim();
      if (from) parts.push(quoteIfSpace('from', from));
      if (to) parts.push(quoteIfSpace('to', to));
      if (subject) parts.push(quoteIfSpace('subject', subject));
      if (fd.get('hasAttachment')) parts.push('has:attachment');
      if (fd.get('isUnread')) parts.push('is:unread');
      if (fd.get('isStarred')) parts.push('is:starred');
      if (words) parts.push(words);
      this.advSearchOpen = false;
      this.store.setSearchQuery(parts.join(' '));
      this.renderHeaderSlot();
      return;
    }

    if (form.id === 'new-label-form') {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      const color = String(fd.get('color') || '#1a73e8');
      if (name) this.store.createLabel(name, color);
      this.closeAllModals();
      return;
    }

    if (form.id === 'login-account-form') {
      e.preventDefault();
      const email = this.loginState.email.trim();
      const password = this.loginState.password;
      if (!email || !password) return;

      this.store.addOrUpdateAccount({
        id: this.loginState.editingAccountId ?? undefined,
        email,
        password,
        displayName: this.loginState.displayName.trim(),
        proxyUrl: this.loginState.proxyUrl.trim(),
        proxyType: this.loginState.proxyType,
        proxyToken: this.loginState.proxyToken.trim(),
        server: {
          imapHost: this.loginState.imapHost.trim() || defaultServerForEmail(email).imapHost,
          imapPort: Number(this.loginState.imapPort) || 993,
          imapTls: this.loginState.imapTls,
          smtpHost: this.loginState.smtpHost.trim() || defaultServerForEmail(email).smtpHost,
          smtpPort: Number(this.loginState.smtpPort) || 465,
          smtpTls: this.loginState.smtpTls,
        },
      });
      this.closeAllModals();
      this.store.pushToast(
        this.store.settings.locale === 'ja' ? `アカウント ${email} を保存しました` : `Saved account ${email}`,
        'success',
      );
    }
  }

  private async runConnectionTest(): Promise<void> {
    const proxyUrl = this.loginState.proxyUrl.trim();
    if (!proxyUrl || this.loginState.proxyType === 'local') {
      this.loginState.testStatus = {
        ok: true,
        message:
          this.store.settings.locale === 'ja'
            ? 'ローカル／デモモードとして動作します（このまま保存可能です）。'
            : 'Configured for Local / Offline mode (ready to save).',
      };
      this.renderModalSlot();
      return;
    }

    this.loginState.testing = true;
    this.loginState.testStatus = null;
    this.renderModalSlot();

    try {
      const health = await checkProxyHealth(proxyUrl, this.loginState.proxyType, this.loginState.proxyToken);
      if (!this.loginState.email.trim() || !this.loginState.password) {
        this.loginState.testStatus = {
          ok: true,
          message: `Proxy healthy (${health.engine ?? 'ok'}, CORS: ${health.cors ?? '*'}). Enter email & password to verify IMAP login.`,
        };
      } else {
        const tempAcc: MailAccount = {
          id: 'test',
          email: this.loginState.email.trim(),
          password: this.loginState.password,
          displayName: this.loginState.displayName,
          proxyUrl,
          proxyType: this.loginState.proxyType,
          proxyToken: this.loginState.proxyToken,
          server: {
            imapHost: this.loginState.imapHost.trim(),
            imapPort: Number(this.loginState.imapPort) || 993,
            imapTls: this.loginState.imapTls,
            smtpHost: this.loginState.smtpHost.trim(),
            smtpPort: Number(this.loginState.smtpPort) || 465,
            smtpTls: this.loginState.smtpTls,
          },
          signature: '',
          avatarColor: '#1a73e8',
          addedAt: new Date().toISOString(),
        };
        const testRes = await testAccountConnection(tempAcc);
        const count = Array.isArray(testRes.mailboxes) ? testRes.mailboxes.length : 0;
        this.loginState.testStatus = {
          ok: true,
          message: `IMAP OK (${health.engine ?? 'proxy'}) · ${count} mailboxes · ${testRes.latencyMs ?? 0}ms`,
        };
      }
    } catch (err) {
      this.loginState.testStatus = {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.loginState.testing = false;
      this.renderModalSlot();
    }
  }

  private onClick(e: Event): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const actionEl = target.closest<HTMLElement>('[data-action]');
    if (!actionEl) return;

    const action = actionEl.dataset.action!;

    switch (action) {
      case 'toggle-sidebar':
        if (window.innerWidth <= 900) {
          this.store.sidebarOpenMobile = !this.store.sidebarOpenMobile;
        } else {
          this.sidebarCollapsed = !this.sidebarCollapsed;
        }
        this.syncShellClasses();
        this.renderHeaderSlot();
        this.renderSidebarSlot();
        break;

      case 'close-mobile-drawer':
        this.store.sidebarOpenMobile = false;
        this.syncShellClasses();
        this.renderHeaderSlot();
        this.renderSidebarSlot();
        break;

      case 'go-inbox':
        e.preventDefault();
        this.store.setFolder('inbox');
        break;

      case 'focus-search':
        this.headerSlot.querySelector<HTMLInputElement>('#global-search-input')?.focus();
        break;

      case 'clear-search': {
        this.store.setSearchQuery('');
        const input = this.headerSlot.querySelector<HTMLInputElement>('#global-search-input');
        if (input) {
          input.value = '';
          input.focus();
        }
        break;
      }

      case 'toggle-adv-search':
        this.advSearchOpen = !this.advSearchOpen;
        this.accountMenuOpen = false;
        this.renderHeaderSlot();
        break;

      case 'close-adv-search':
        this.advSearchOpen = false;
        this.renderHeaderSlot();
        break;

      case 'toggle-theme':
        this.store.toggleTheme();
        break;

      case 'install-pwa':
        if (this.deferredInstallPrompt) {
          void this.deferredInstallPrompt.prompt();
          this.deferredInstallPrompt = null;
          this.renderHeaderSlot();
        }
        break;

      case 'toggle-account-menu':
        this.accountMenuOpen = !this.accountMenuOpen;
        this.advSearchOpen = false;
        this.renderHeaderSlot();
        break;

      case 'switch-account': {
        const id = actionEl.dataset.accountId;
        this.accountMenuOpen = false;
        if (id) this.store.switchAccount(id);
        break;
      }

      case 'open-login':
        this.openModalCleanup();
        this.loginState = createInitialLoginState();
        this.renderHeaderSlot();
        this.renderModalSlot();
        this.modalSlot.querySelector<HTMLInputElement>('#login-email')?.focus();
        break;

      case 'edit-active-account': {
        this.openModalCleanup();
        const active = this.store.getActiveAccount();
        this.loginState = createInitialLoginState(active);
        this.renderHeaderSlot();
        this.renderModalSlot();
        this.modalSlot.querySelector<HTMLInputElement>('#login-email')?.focus();
        break;
      }

      case 'remove-active-account': {
        const active = this.store.getActiveAccount();
        this.accountMenuOpen = false;
        if (active) this.store.removeAccount(active.id);
        break;
      }

      case 'sign-out-all':
        this.accountMenuOpen = false;
        this.store.signOutAll();
        break;

      case 'load-demo-accounts': {
        const demos = createDemoAccounts();
        for (const d of demos) {
          if (!this.store.accounts.some((a) => a.email === d.email)) {
            this.store.accounts = [...this.store.accounts, d];
            localStorage.setItem(`neon_gmail_msgs_v1_${d.id}`, JSON.stringify(createDemoMessages(d.id, d.email)));
          }
        }
        saveAccounts(this.store.accounts);
        if (demos[0]) this.store.switchAccount(demos[0].id);
        this.closeAllModals();
        break;
      }

      case 'close-login-modal':
      case 'close-settings-modal':
      case 'close-shortcuts-modal':
      case 'close-new-label':
        this.closeAllModals();
        break;

      case 'toggle-login-password':
        this.loginState.showPassword = !this.loginState.showPassword;
        this.renderModalSlot();
        break;

      case 'toggle-login-advanced':
        this.loginState.showAdvanced = !this.loginState.showAdvanced;
        this.renderModalSlot();
        break;

      case 'test-login-connection':
        void this.runConnectionTest();
        break;

      case 'open-settings':
        this.openModalCleanup();
        this.settingsOpen = true;
        this.renderHeaderSlot();
        this.renderModalSlot();
        this.modalSlot.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
        break;

      case 'open-shortcuts':
        this.openModalCleanup();
        this.shortcutsOpen = true;
        this.renderHeaderSlot();
        this.renderModalSlot();
        this.modalSlot.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
        break;

      case 'open-new-label':
        this.openModalCleanup();
        this.newLabelOpen = true;
        this.renderModalSlot();
        this.modalSlot.querySelector<HTMLInputElement>('#new-label-name')?.focus();
        break;

      case 'close-modal-backdrop':
        if (e.target === actionEl) this.closeAllModals();
        break;

      case 'select-folder': {
        const folder = actionEl.dataset.folder as SystemFolder | undefined;
        if (folder) this.store.setFolder(folder);
        break;
      }

      case 'select-category': {
        const cat = actionEl.dataset.category as InboxCategory | undefined;
        if (cat) this.store.setCategory(cat);
        break;
      }

      case 'select-label': {
        const lbl = actionEl.dataset.labelId;
        if (lbl) this.store.setLabelFilter(lbl);
        break;
      }

      case 'delete-label': {
        const lbl = actionEl.dataset.labelId;
        if (lbl) this.store.deleteLabel(lbl);
        break;
      }

      case 'open-compose':
        this.store.sidebarOpenMobile = false;
        this.store.openCompose();
        break;

      case 'sync-mail':
        void this.store.syncActiveAccount();
        break;

      case 'toggle-select-all': {
        const visible = this.store.getVisibleThreads();
        const allSelected = visible.length > 0 && visible.every((t) => this.store.selectedThreadIds.has(t.id));
        this.store.selectThreadsByFilter(allSelected ? 'none' : 'all');
        break;
      }

      case 'toggle-select-menu':
        this.selectMenuOpen = !this.selectMenuOpen;
        this.labelMenuOpen = false;
        this.snoozeMenuOpen = false;
        this.renderMainSlot();
        break;

      case 'select-filter': {
        const f = actionEl.dataset.filter as 'all' | 'none' | 'read' | 'unread' | 'starred';
        this.selectMenuOpen = false;
        this.store.selectThreadsByFilter(f);
        break;
      }

      case 'toggle-select-thread': {
        const id = actionEl.dataset.threadId;
        if (id) this.store.toggleSelectThread(id);
        break;
      }

      case 'toggle-star': {
        const id = actionEl.dataset.threadId;
        if (id) this.store.toggleStar(id);
        break;
      }

      case 'toggle-important': {
        const id = actionEl.dataset.threadId;
        if (id) this.store.toggleImportant(id);
        break;
      }

      case 'open-thread': {
        const id = actionEl.dataset.threadId;
        if (id) this.openThreadResetUi(id);
        break;
      }

      case 'close-thread':
        this.store.closeThread();
        break;

      case 'bulk-archive':
        this.store.archiveThreads(Array.from(this.store.selectedThreadIds));
        break;

      case 'bulk-spam':
        this.store.moveThreadsToFolder(Array.from(this.store.selectedThreadIds), 'spam', 'spamToast');
        break;

      case 'bulk-not-spam':
        this.store.moveThreadsToFolder(Array.from(this.store.selectedThreadIds), 'inbox');
        break;

      case 'bulk-delete':
        this.store.deleteThreads(Array.from(this.store.selectedThreadIds));
        break;

      case 'bulk-read':
        this.store.setThreadsRead(Array.from(this.store.selectedThreadIds), true);
        break;

      case 'bulk-unread':
        this.store.setThreadsRead(Array.from(this.store.selectedThreadIds), false);
        break;

      case 'toggle-snooze-menu':
        this.snoozeMenuOpen = !this.snoozeMenuOpen;
        this.labelMenuOpen = false;
        this.renderMainSlot();
        break;

      case 'bulk-snooze': {
        const preset = actionEl.dataset.preset as 'later' | 'tomorrow' | 'nextWeek';
        this.snoozeMenuOpen = false;
        this.store.snoozeThreads(Array.from(this.store.selectedThreadIds), computeSnoozeDate(preset));
        break;
      }

      case 'toggle-label-menu':
        this.labelMenuOpen = !this.labelMenuOpen;
        this.snoozeMenuOpen = false;
        this.renderMainSlot();
        break;

      case 'bulk-label': {
        const lbl = actionEl.dataset.labelId;
        this.labelMenuOpen = false;
        if (lbl) this.store.toggleLabelOnThreads(Array.from(this.store.selectedThreadIds), lbl);
        break;
      }

      case 'empty-trash':
        this.store.emptyTrash();
        break;

      case 'prev-page':
        if (this.store.currentPage > 1) {
          this.store.currentPage--;
          this.store.focusedThreadIndex = -1;
          this.renderMainSlot();
        }
        break;

      case 'next-page': {
        const maxPage = Math.max(1, Math.ceil(this.store.getVisibleThreads().length / this.store.settings.pageSize));
        if (this.store.currentPage < maxPage) {
          this.store.currentPage++;
          this.store.focusedThreadIndex = -1;
          this.renderMainSlot();
        }
        break;
      }

      case 'cycle-reading-pane': {
        const order: ReadingPaneMode[] = ['none', 'right', 'bottom'];
        const next = order[(order.indexOf(this.store.settings.readingPane) + 1) % order.length]!;
        this.store.updateSettings({ readingPane: next });
        break;
      }

      case 'row-archive': {
        const id = actionEl.dataset.threadId;
        if (id) this.store.archiveThreads([id]);
        break;
      }

      case 'row-delete': {
        const id = actionEl.dataset.threadId;
        if (id) this.store.deleteThreads([id]);
        break;
      }

      case 'row-toggle-read': {
        const id = actionEl.dataset.threadId;
        const th = this.store.getAllThreads().find((t) => t.id === id);
        if (th) this.store.setThreadsRead([th.id], th.unreadCount > 0);
        break;
      }

      case 'row-snooze': {
        const id = actionEl.dataset.threadId;
        if (id) this.store.snoozeThreads([id], computeSnoozeDate('tomorrow'));
        break;
      }

      case 'thread-archive':
        if (this.store.openThreadId) this.store.archiveThreads([this.store.openThreadId]);
        break;

      case 'thread-spam':
        if (this.store.openThreadId) this.store.moveThreadsToFolder([this.store.openThreadId], 'spam', 'spamToast');
        break;

      case 'thread-delete':
        if (this.store.openThreadId) this.store.deleteThreads([this.store.openThreadId]);
        break;

      case 'thread-unread':
        if (this.store.openThreadId) {
          const id = this.store.openThreadId;
          this.store.setThreadsRead([id], false);
          this.store.closeThread();
        }
        break;

      case 'toggle-thread-snooze':
        this.threadUi.snoozeMenuOpen = !this.threadUi.snoozeMenuOpen;
        this.threadUi.labelMenuOpen = false;
        this.renderMainSlot();
        break;

      case 'thread-snooze': {
        const preset = actionEl.dataset.preset as 'later' | 'tomorrow' | 'nextWeek';
        this.threadUi.snoozeMenuOpen = false;
        if (this.store.openThreadId) this.store.snoozeThreads([this.store.openThreadId], computeSnoozeDate(preset));
        break;
      }

      case 'toggle-thread-labels':
        this.threadUi.labelMenuOpen = !this.threadUi.labelMenuOpen;
        this.threadUi.snoozeMenuOpen = false;
        this.renderMainSlot();
        break;

      case 'thread-toggle-label': {
        const lbl = actionEl.dataset.labelId;
        if (lbl && this.store.openThreadId) this.store.toggleLabelOnThreads([this.store.openThreadId], lbl);
        break;
      }

      case 'print-thread':
        window.print();
        break;

      case 'toggle-msg-expand': {
        const msgId = actionEl.dataset.msgId;
        const isLatest = actionEl.dataset.isLatest === '1';
        if (!msgId) break;
        if (isLatest) {
          if (this.threadUi.collapsedMsgIds.has(msgId)) this.threadUi.collapsedMsgIds.delete(msgId);
          else this.threadUi.collapsedMsgIds.add(msgId);
        } else {
          if (this.threadUi.expandedMsgIds.has(msgId)) this.threadUi.expandedMsgIds.delete(msgId);
          else this.threadUi.expandedMsgIds.add(msgId);
        }
        this.renderMainSlot();
        break;
      }

      case 'allow-msg-images': {
        const msgId = actionEl.dataset.msgId;
        if (msgId) {
          this.threadUi.showImagesMsgIds.add(msgId);
          this.renderMainSlot();
        }
        break;
      }

      case 'toggle-raw-msg': {
        const msgId = actionEl.dataset.msgId;
        if (!msgId) break;
        if (this.threadUi.showRawMsgIds.has(msgId)) this.threadUi.showRawMsgIds.delete(msgId);
        else this.threadUi.showRawMsgIds.add(msgId);
        this.renderMainSlot();
        break;
      }

      case 'download-attachment': {
        const msgId = actionEl.dataset.msgId;
        const attId = actionEl.dataset.attId;
        const msg = this.store.messages.find((m) => m.id === msgId);
        const att = msg?.attachments.find((a) => a.id === attId);
        if (!att) break;
        if (!att.dataBase64) {
          this.store.pushToast(
            this.store.settings.locale === 'ja'
              ? 'この添付ファイルはサイズ制限のため本文に含まれていません。'
              : 'Attachment payload was omitted due to proxy size limit.',
            'error',
          );
          break;
        }
        try {
          const bin = atob(att.dataBase64.replace(/\s+/g, ''));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          // Force application/octet-stream so active HTML/SVG attachments can never execute on same origin
          const blob = new Blob([bytes], { type: 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.rel = 'noopener';
          a.download = sanitizeFilename(att.filename);
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1500);
        } catch {
          this.store.pushToast(
            this.store.settings.locale === 'ja' ? '添付ファイルのデコードに失敗しました' : 'Failed to decode attachment.',
            'error',
          );
        }
        break;
      }

      case 'smart-reply': {
        const text = actionEl.dataset.text || '';
        this.threadUi.inlineReplyMode = 'reply';
        this.threadUi.inlineReplyText = text;
        this.renderMainSlot();
        this.mainSlot.querySelector<HTMLTextAreaElement>('#inline-reply-textarea')?.focus();
        break;
      }

      case 'open-inline-reply':
        this.threadUi.inlineReplyMode = 'reply';
        this.renderMainSlot();
        this.mainSlot.querySelector<HTMLTextAreaElement>('#inline-reply-textarea')?.focus();
        break;

      case 'open-inline-reply-all':
        this.threadUi.inlineReplyMode = 'replyAll';
        this.renderMainSlot();
        this.mainSlot.querySelector<HTMLTextAreaElement>('#inline-reply-textarea')?.focus();
        break;

      case 'cancel-inline-reply':
        this.threadUi.inlineReplyMode = null;
        this.threadUi.inlineReplyText = '';
        this.renderMainSlot();
        break;

      case 'submit-inline-reply': {
        const thread = this.store.getAllThreads().find((t) => t.id === this.store.openThreadId);
        if (thread && this.threadUi.inlineReplyText.trim()) {
          this.store.sendQuickReply(thread, this.threadUi.inlineReplyText, this.threadUi.inlineReplyMode === 'replyAll');
          this.threadUi.inlineReplyMode = null;
          this.threadUi.inlineReplyText = '';
        }
        break;
      }

      case 'forward-thread':
        this.forwardOpenThread();
        break;

      case 'compose-minimize': {
        const id = actionEl.dataset.draftId;
        const d = this.store.drafts.find((x) => x.id === id);
        if (d) {
          d.minimized = !d.minimized;
          if (d.minimized) d.expanded = false;
          this.renderComposeSlot();
        }
        break;
      }

      case 'compose-expand': {
        const id = actionEl.dataset.draftId;
        const d = this.store.drafts.find((x) => x.id === id);
        if (d) {
          d.expanded = !d.expanded;
          if (d.expanded) d.minimized = false;
          this.renderComposeSlot();
        }
        break;
      }

      case 'compose-close': {
        const id = actionEl.dataset.draftId;
        if (id) this.store.closeDraftWindow(id);
        break;
      }

      case 'compose-show-cc': {
        const id = actionEl.dataset.draftId;
        if (id) {
          this.showCcBccIds.add(id);
          this.renderComposeSlot();
        }
        break;
      }

      case 'compose-fmt': {
        const cmd = actionEl.dataset.cmd;
        const id = actionEl.dataset.draftId;
        if (cmd && id) {
          const editor = this.composeSlot.querySelector<HTMLElement>(`#compose-editor-${CSS.escape(id)}`);
          editor?.focus();
          try {
            document.execCommand(cmd, false);
          } catch {
            // ignore
          }
          if (editor) {
            this.store.updateDraft(id, {
              htmlBody: editor.innerHTML,
              textBody: editor.innerText || editor.textContent || '',
            });
          }
        }
        break;
      }

      case 'compose-remove-att': {
        const draftId = actionEl.dataset.draftId;
        const attId = actionEl.dataset.attId;
        const d = this.store.drafts.find((x) => x.id === draftId);
        if (d && attId) {
          this.store.updateDraft(d.id, { attachments: d.attachments.filter((a) => a.id !== attId) });
          this.renderComposeSlot();
        }
        break;
      }

      case 'compose-send': {
        const id = actionEl.dataset.draftId;
        if (id) this.store.sendDraft(id);
        break;
      }

      case 'compose-toggle-schedule': {
        const id = actionEl.dataset.draftId ?? null;
        this.scheduleOpenDraftId = this.scheduleOpenDraftId === id ? null : id;
        this.renderComposeSlot();
        break;
      }

      case 'schedule-send-preset': {
        const id = actionEl.dataset.draftId;
        const preset = actionEl.dataset.preset as 'later' | 'tomorrow' | 'nextWeek';
        this.scheduleOpenDraftId = null;
        if (id) this.store.sendDraft(id, computeSnoozeDate(preset));
        break;
      }

      case 'compose-discard': {
        const id = actionEl.dataset.draftId;
        if (id) this.store.discardDraft(id);
        break;
      }

      case 'export-backup': {
        const json = exportAllBackup(false);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.rel = 'noopener';
        a.download = `neon-gmail-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        break;
      }

      case 'toast-action': {
        const toastId = actionEl.dataset.toastId;
        const toast = this.store.toasts.find((x) => x.id === toastId);
        if (toast?.onAction) toast.onAction();
        if (toastId) this.store.dismissToast(toastId);
        break;
      }
    }
  }

  private syncShellClasses(): void {
    this.shellEl.classList.toggle('sidebar-collapsed', this.sidebarCollapsed);
    this.shellEl.classList.toggle('mobile-drawer-open', this.store.sidebarOpenMobile);
  }

  private isMobileViewport(): boolean {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;
  }

  private renderHeaderSlot(isMobile = this.isMobileViewport()): void {
    const sidebarExpanded = isMobile ? this.store.sidebarOpenMobile : !this.sidebarCollapsed;
    this.headerSlot.innerHTML = renderHeader(this.store, {
      accountMenuOpen: this.accountMenuOpen,
      advSearchOpen: this.advSearchOpen,
      canInstallPwa: Boolean(this.deferredInstallPrompt),
      sidebarExpanded,
    });
  }

  private renderSidebarSlot(isMobile = this.isMobileViewport()): void {
    const isMobileHidden = isMobile && !this.store.sidebarOpenMobile;
    this.sidebarSlot.innerHTML = renderSidebar(this.store, isMobileHidden);
  }

  private renderMainSlot(isMobile = this.isMobileViewport()): void {
    const visibleThreads = this.store.getVisibleThreads();
    const openThread = this.store.openThreadId
      ? this.store.getAllThreads().find((t) => t.id === this.store.openThreadId) ?? null
      : null;

    // Force clean single-pane view on mobile viewports regardless of desktop readingPane setting
    const effectivePane: ReadingPaneMode = isMobile ? 'none' : this.store.settings.readingPane;
    const splitClass = effectivePane === 'right' ? 'pane-right' : effectivePane === 'bottom' ? 'pane-bottom' : '';

    let mainInner = '';
    if (effectivePane === 'none') {
      mainInner = openThread
        ? `<div class="detail-pane">${renderThreadView(this.store, openThread, this.threadUi)}</div>`
        : `<div class="list-pane">${renderMessageList(this.store, visibleThreads, {
            selectMenuOpen: this.selectMenuOpen,
            labelMenuOpen: this.labelMenuOpen,
            snoozeMenuOpen: this.snoozeMenuOpen,
          })}</div>`;
    } else {
      mainInner = `
        <div class="list-pane">
          ${renderMessageList(this.store, visibleThreads, {
            selectMenuOpen: this.selectMenuOpen,
            labelMenuOpen: this.labelMenuOpen,
            snoozeMenuOpen: this.snoozeMenuOpen,
          })}
        </div>
        <div class="detail-pane">
          ${
            openThread
              ? renderThreadView(this.store, openThread, this.threadUi)
              : `<div class="empty-state">${icons.mailOpen}<p>${escapeHtml(this.store.tr('selectHint'))}</p></div>`
          }
        </div>
      `;
    }

    this.mainSlot.innerHTML = `<div class="split-container ${splitClass}">${mainInner}</div>`;
    this.fabSlot.innerHTML =
      !openThread && this.store.getActiveDrafts().length === 0
        ? `<button type="button" class="mobile-fab" data-action="open-compose">${icons.compose}<span>${escapeHtml(this.store.tr('compose'))}</span></button>`
        : '';
  }

  private renderComposeSlot(): void {
    this.composeSlot.innerHTML = renderComposeDock(this.store, this.showCcBccIds, this.scheduleOpenDraftId);
  }

  private renderModalSlot(): void {
    if (!this.isAnyModalOpen()) {
      this.modalSlot.innerHTML = '';
      return;
    }
    this.modalSlot.innerHTML = `
      ${renderLoginModal(this.store, this.loginState)}
      ${renderSettingsModal(this.store, this.settingsOpen)}
      ${renderShortcutsModal(this.store, this.shortcutsOpen)}
      ${renderNewLabelModal(this.store, this.newLabelOpen)}
    `;
  }

  private renderToastsSlot(): void {
    if (this.store.toasts.length === 0) {
      this.toastSlot.innerHTML = '';
      return;
    }
    this.toastSlot.innerHTML = `
      <div class="toast-stack" role="status" aria-live="polite">
        ${this.store.toasts
          .map(
            (toast) => `
          <div class="toast-item ${toast.variant === 'error' ? 'error' : ''}">
            <span>${escapeHtml(toast.message)}</span>
            ${
              toast.actionLabel
                ? `<button type="button" class="toast-action" data-action="toast-action" data-toast-id="${escapeHtml(toast.id)}">${escapeHtml(toast.actionLabel)}</button>`
                : ''
            }
          </div>
        `,
          )
          .join('')}
      </div>
    `;
  }

  renderAll(): void {
    const isMobile = this.isMobileViewport();
    this.syncShellClasses();
    this.renderHeaderSlot(isMobile);
    this.renderSidebarSlot(isMobile);
    this.renderMainSlot(isMobile);
    this.renderComposeSlot();
    this.renderModalSlot();
    this.renderToastsSlot();
  }
}
