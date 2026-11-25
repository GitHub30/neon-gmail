import { describe, it, expect, beforeEach, vi } from 'vitest';
import { STORAGE_KEYS } from '../src/core/storage.ts';
import { MailStore } from '../src/core/store.ts';

describe('MailStore & localStorage Multi-Account Persistence (Zero Test Data by Default)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts cleanly with zero fake demo accounts, emails, or labels', () => {
    const store = new MailStore();
    expect(store.accounts).toEqual([]);
    expect(store.messages).toEqual([]);
    expect(store.labels).toEqual([]);
    store.destroy();
  });

  it('purges legacy auto-seeded demo accounts on upgrade while keeping real user accounts', () => {
    localStorage.setItem(
      STORAGE_KEYS.ACCOUNTS,
      JSON.stringify([
        { id: 'acc-demo-work', email: 'alex.tanaka@neon-mail.dev', password: 'demo', isDemo: true },
        { id: 'acc-demo-personal', email: 'alex.private@neon-mail.dev', password: 'demo', isDemo: true },
        { id: 'acc-real-1', email: 'real@example.com', password: 'real-password', proxyUrl: 'https://proxy.example/proxy.php' },
        { id: 'acc-real-local', email: 'local-user@example.com', password: 'pw', proxyUrl: '', isDemo: true },
      ]),
    );
    const store = new MailStore();
    expect(store.accounts.map((a) => a.email)).toEqual(['real@example.com', 'local-user@example.com']);
    store.destroy();
  });

  it('saves email, password, and optional proxyUrl into localStorage and switches accounts cleanly', () => {
    const store = new MailStore();

    const first = store.addOrUpdateAccount({
      email: 'alice@example.com',
      password: 'app-password-1234',
      displayName: 'Alice Work',
      proxyUrl: 'https://my-proxy.workers.dev',
      proxyType: 'cloudflare',
    });

    const second = store.addOrUpdateAccount({
      email: 'bob@example.com',
      password: 'offline-password',
      proxyUrl: '',
    });

    expect(store.activeAccountId).toBe(second.id);
    expect(second.proxyType).toBe('local');
    expect(second.proxyUrl).toBe('');

    // Verify localStorage persisted both accounts
    const raw = localStorage.getItem(STORAGE_KEYS.ACCOUNTS);
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw!) as Array<{ email: string; password: string; proxyUrl: string }>;
    const foundAlice = saved.find((a) => a.email === 'alice@example.com');
    expect(foundAlice?.password).toBe('app-password-1234');
    expect(foundAlice?.proxyUrl).toBe('https://my-proxy.workers.dev');

    // Switch back to Alice
    store.switchAccount(first.id);
    expect(store.activeAccountId).toBe(first.id);
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_ACCOUNT)).toBe(first.id);

    store.destroy();
  });

  it('supports compose, Undo Send, send commit, archive + undo, custom labels, trash, and empty trash', () => {
    vi.useFakeTimers();
    const store = new MailStore();
    store.addOrUpdateAccount({
      email: 'user@example.com',
      password: 'secret',
      displayName: 'User',
      proxyUrl: '',
    });

    // Compose + Send + Undo Send
    const draft1 = store.openCompose({
      to: ['bob@example.com'],
      subject: 'Undo Test',
      textBody: 'Hello Bob',
    });
    store.sendDraft(draft1.id);
    expect(store.drafts.length).toBe(0);
    const sendToast = store.toasts[store.toasts.length - 1];
    sendToast?.onAction?.();
    expect(store.drafts.length).toBe(1);
    expect(store.drafts[0]!.subject).toBe('Undo Test');

    // Commit send after undo window
    store.sendDraft(draft1.id);
    vi.advanceTimersByTime(10000);
    store.setFolder('sent');
    const sentThreads = store.getVisibleThreads();
    expect(sentThreads.length).toBe(1);
    const threadId = sentThreads[0]!.id;

    // Custom label
    const lbl = store.createLabel('VIP', '#d93025');
    store.toggleLabelOnThreads([threadId], lbl.id);
    store.setLabelFilter(lbl.id);
    expect(store.getVisibleThreads().some((t) => t.id === threadId)).toBe(true);

    // Archive and undo
    store.archiveThreads([threadId]);
    const undoArchive = store.toasts[store.toasts.length - 1];
    undoArchive?.onAction?.();

    // Trash & Empty Trash
    store.setFolder('all');
    store.deleteThreads([threadId]);
    store.setFolder('trash');
    expect(store.getVisibleThreads().some((t) => t.id === threadId)).toBe(true);
    store.emptyTrash();
    expect(store.getVisibleThreads().length).toBe(0);

    store.destroy();
    vi.useRealTimers();
  });
});
