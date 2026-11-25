import { describe, it, expect } from 'vitest';
import { matchesSearch, parseSearchQuery } from '../src/core/search.ts';
import type { MailThread } from '../src/types/mail.ts';

const sampleThread: MailThread = {
  id: 't1',
  subject: 'Q4 Invoice and Release Plan',
  latestDate: new Date().toISOString(),
  unreadCount: 1,
  isStarred: true,
  isImportant: true,
  hasAttachments: true,
  folder: 'inbox',
  category: 'primary',
  labels: ['lbl-work'],
  participants: [{ name: 'Alice Tanaka', email: 'alice@studio.example' }],
  snippet: 'Attached is the quarterly report',
  messages: [
    {
      id: 'm1',
      threadId: 't1',
      accountId: 'acc1',
      fromName: 'Alice Tanaka',
      fromEmail: 'alice@studio.example',
      to: ['me@neon-mail.dev'],
      cc: ['finance@studio.example'],
      subject: 'Q4 Invoice and Release Plan',
      snippet: 'Attached is the quarterly report',
      textBody: 'Please check the attached budget sheet before Friday.',
      date: new Date().toISOString(),
      isRead: false,
      isStarred: true,
      isImportant: true,
      folder: 'inbox',
      category: 'primary',
      labels: ['lbl-work'],
      attachments: [{ id: 'a1', filename: 'q4-budget.pdf', contentType: 'application/pdf', size: 1200 }],
    },
  ],
};

const labelMap = new Map([['lbl-work', 'プロジェクト']]);

describe('Gmail Search Query Parser & Matcher', () => {
  it('parses operators, quoted phrases, and exclusions', () => {
    const parsed = parseSearchQuery('from:alice subject:"Release Plan" has:attachment is:unread -spam');
    expect(parsed.from).toEqual(['alice']);
    expect(parsed.subject).toEqual(['release plan']);
    expect(parsed.hasAttachment).toBe(true);
    expect(parsed.isUnread).toBe(true);
    expect(parsed.excludes).toEqual(['spam']);
  });

  it('matches combined Gmail operators accurately', () => {
    expect(matchesSearch(sampleThread, 'from:alice@studio has:attachment is:unread is:starred', labelMap)).toBe(true);
    expect(matchesSearch(sampleThread, 'to:finance@studio.example label:プロジェクト', labelMap)).toBe(true);
    expect(matchesSearch(sampleThread, 'q4-budget.pdf', labelMap)).toBe(true);
    expect(matchesSearch(sampleThread, 'is:read', labelMap)).toBe(false);
    expect(matchesSearch(sampleThread, '-budget', labelMap)).toBe(false);
    expect(matchesSearch(sampleThread, 'in:sent', labelMap)).toBe(false);
    expect(matchesSearch(sampleThread, 'in:inbox', labelMap)).toBe(true);
  });
});
