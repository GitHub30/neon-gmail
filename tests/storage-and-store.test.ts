import { describe, it, expect, beforeEach, vi } from 'vitest';
import { STORAGE_KEYS } from '../src/core/storage.ts';
import { MailStore } from '../src/core/store.ts';

describe('MailStore & localStorage Multi-Account Persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves email, password, and optional proxyUrl into localStorage and switches accounts cleanly', () => {
    const store = new MailStore();
    const initialCount = store.accounts.length;
    expect(initialCount).toBeGreaterThanOrEqual(2);

    const added = store.addOrUpdateAccount({
      email: 'alice@example.com',
      password: 'app-password-1234',
      displayName: 'Alice Work',
      proxyUrl: 'https://my-proxy.workers.dev',
      proxyType: 'cloudflare',
    });

    expect(store.activeAccountId).toBe(added.id);

    // Verify localStorage actually persisted credentials & proxyUrl
    const raw = localStorage.getItem(STORAGE_KEYS.ACCOUNTS);
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw!) as Array<{ email: string; password: string; proxyUrl: string }>;
    const found = saved.find((a) => a.email === 'alice@example.com');
    expect(found).toBeDefined();
    expect(found!.password).toBe('app-password-1234');
    expect(found!.proxyUrl).toBe('https://my-proxy.workers.dev');

    // Switch back to first demo account and verify mailbox isolation
    const demoId = store.accounts[0]!.id;
    store.switchAccount(demoId);
    expect(store.activeAccountId).toBe(demoId);
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_ACCOUNT)).toBe(demoId);

    store.destroy();
  });

  it('supports optional blank proxyUrl for local/offline mode', () => {
    const store = new MailStore();
    const acc = store.addOrUpdateAccount({
      email: 'offline@example.com',
      password: 'secret',
      proxyUrl: '',
    });
    expect(acc.proxyType).toBe('local');
    expect(acc.proxyUrl).toBe('');
    store.destroy();
  });

  it('supports archive, undo archive, trash, empty trash, labels, and undo send', () => {
    vi.useFakeTimers();
    const store = new MailStore();
    const visible = store.getVisibleThreads();
    expect(visible.length).toBeGreaterThan(0);
    const firstId = visible[0]!.id;

    // Archive and undo
    store.archiveThreads([firstId]);
    expect(store.getVisibleThreads().some((t) => t.id === firstId)).toBe(false);
    const undoToast = store.toasts[store.toasts.length - 1];
    expect(undoToast?.onAction).toBeDefined();
    undoToast?.onAction?.();
    expect(store.getVisibleThreads().some((t) => t.id === firstId)).toBe(true);

    // Custom label
    const lbl = store.createLabel('VIP', '#d93025');
    store.toggleLabelOnThreads([firstId], lbl.id);
    store.setLabelFilter(lbl.id);
    expect(store.getVisibleThreads().some((t) => t.id === firstId)).toBe(true);

    // Compose + Send + Undo Send
    const draft = store.openCompose({
      to: ['bob@example.com'],
      subject: 'Undo Test',
      textBody: 'Hello Bob',
    });
    store.sendDraft(draft.id);
    expect(store.drafts.length).toBe(0);
    const sendToast = store.toasts[store.toasts.length - 1];
    sendToast?.onAction?.(); // Click Undo before timeout!
    expect(store.drafts.length).toBe(1);
    expect(store.drafts[0]!.subject).toBe('Undo Test');

    // Trash & Empty Trash
    store.setFolder('inbox');
    store.deleteThreads([firstId]);
    store.setFolder('trash');
    expect(store.getVisibleThreads().some((t) => t.id === firstId)).toBe(true);
    store.emptyTrash();
    expect(store.getVisibleThreads().length).toBe(0);

    store.destroy();
    vi.useRealTimers();
  });
});
