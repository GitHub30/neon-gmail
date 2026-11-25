import type { MailThread } from '../types/mail.ts';

export interface ParsedSearchQuery {
  from: string[];
  excludeFrom: string[];
  to: string[];
  excludeTo: string[];
  subject: string[];
  excludeSubject: string[];
  label: string[];
  excludeLabel: string[];
  inFolder?: string;
  hasAttachment?: boolean;
  isUnread?: boolean;
  isRead?: boolean;
  isStarred?: boolean;
  isImportant?: boolean;
  includes: string[];
  excludes: string[];
}

export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const result: ParsedSearchQuery = {
    from: [],
    excludeFrom: [],
    to: [],
    excludeTo: [],
    subject: [],
    excludeSubject: [],
    label: [],
    excludeLabel: [],
    includes: [],
    excludes: [],
  };

  const tokens: string[] = [];
  const regex = /(-?[a-z]+:"[^"]+"|-"[^"]+"|"[^"]+"|\S+)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawQuery)) !== null) {
    tokens.push(match[0]);
  }

  for (const rawTok of tokens) {
    const tok = rawTok.trim();
    if (!tok) continue;

    const negated = tok.startsWith('-') && tok.length > 1;
    const body = negated ? tok.slice(1) : tok;

    const colonIdx = body.indexOf(':');
    if (colonIdx > 0 && !body.startsWith('"')) {
      const key = body.slice(0, colonIdx).toLowerCase();
      const val = body.slice(colonIdx + 1).replace(/^"|"$/g, '').toLowerCase();
      if (!val) continue;

      switch (key) {
        case 'from':
          (negated ? result.excludeFrom : result.from).push(val);
          break;
        case 'to':
          (negated ? result.excludeTo : result.to).push(val);
          break;
        case 'subject':
          (negated ? result.excludeSubject : result.subject).push(val);
          break;
        case 'label':
          (negated ? result.excludeLabel : result.label).push(val);
          break;
        case 'in':
          if (!negated) result.inFolder = val;
          break;
        case 'has':
          if (val === 'attachment') result.hasAttachment = !negated;
          break;
        case 'is':
          if (val === 'unread') result.isUnread = !negated;
          if (val === 'read') result.isRead = !negated;
          if (val === 'starred') result.isStarred = !negated;
          if (val === 'important') result.isImportant = !negated;
          break;
        default:
          (negated ? result.excludes : result.includes).push(body.toLowerCase());
      }
    } else {
      const cleaned = body.replace(/^"|"$/g, '').toLowerCase();
      if (cleaned) (negated ? result.excludes : result.includes).push(cleaned);
    }
  }

  return result;
}

export function matchesSearch(thread: MailThread, rawQuery: string, labelNameById: Map<string, string>): boolean {
  const trimmed = rawQuery.trim();
  if (!trimmed) return true;

  const q = parseSearchQuery(trimmed);

  if (q.hasAttachment === true && !thread.hasAttachments) return false;
  if (q.hasAttachment === false && thread.hasAttachments) return false;
  if (q.isUnread === true && thread.unreadCount === 0) return false;
  if (q.isUnread === false && thread.unreadCount > 0) return false;
  if (q.isRead === true && thread.unreadCount > 0) return false;
  if (q.isRead === false && thread.unreadCount === 0) return false;
  if (q.isStarred === true && !thread.isStarred) return false;
  if (q.isStarred === false && thread.isStarred) return false;
  if (q.isImportant === true && !thread.isImportant) return false;
  if (q.isImportant === false && thread.isImportant) return false;
  if (q.inFolder && q.inFolder !== 'anywhere' && q.inFolder !== 'all') {
    if (thread.folder !== q.inFolder) return false;
  }

  const allFrom = thread.messages.map((m) => `${m.fromName} ${m.fromEmail}`).join(' ').toLowerCase();
  const allTo = thread.messages.map((m) => [...m.to, ...m.cc].join(' ')).join(' ').toLowerCase();
  const subj = thread.subject.toLowerCase();
  const labelNames = thread.labels
    .map((id) => (labelNameById.get(id) ?? id).toLowerCase())
    .join(' ');
  const fullText = [
    subj,
    allFrom,
    allTo,
    labelNames,
    ...thread.messages.map((m) => `${m.textBody} ${m.snippet} ${m.attachments.map((a) => a.filename).join(' ')}`),
  ].join(' ').toLowerCase();

  for (const f of q.from) if (!allFrom.includes(f)) return false;
  for (const f of q.excludeFrom) if (allFrom.includes(f)) return false;
  for (const t of q.to) if (!allTo.includes(t)) return false;
  for (const t of q.excludeTo) if (allTo.includes(t)) return false;
  for (const s of q.subject) if (!subj.includes(s)) return false;
  for (const s of q.excludeSubject) if (subj.includes(s)) return false;
  for (const l of q.label) if (!labelNames.includes(l)) return false;
  for (const l of q.excludeLabel) if (labelNames.includes(l)) return false;
  for (const inc of q.includes) if (!fullText.includes(inc)) return false;
  for (const exc of q.excludes) if (fullText.includes(exc)) return false;

  return true;
}
