import { icons } from '../core/icons.ts';
import { escapeHtml, plainTextToSafeHtml, safeHexColor, sanitizeEmailHtml } from '../core/sanitizer.ts';
import type { MailStore } from '../core/store.ts';
import { colorForString, initialsForName } from '../data/providers.ts';
import type { MailThread } from '../types/mail.ts';
import { formatBytes, formatFullDate } from './formatDate.ts';

export interface ThreadUiState {
  expandedMsgIds: Set<string>;
  collapsedMsgIds: Set<string>;
  showImagesMsgIds: Set<string>;
  showRawMsgIds: Set<string>;
  inlineReplyMode: null | 'reply' | 'replyAll';
  inlineReplyText: string;
  labelMenuOpen: boolean;
  snoozeMenuOpen: boolean;
}

export function renderThreadView(store: MailStore, thread: MailThread, ui: ThreadUiState): string {
  const loc = store.settings.locale;
  const labelById = new Map(store.labels.map((l) => [l.id, l]));
  const smartReplies =
    loc === 'ja'
      ? ['了解しました、ありがとうございます！', '確認して後ほど折り返します。', '素晴らしいですね、進めてください！']
      : ['Got it, thank you!', 'I will review and follow up shortly.', 'Looks great, please proceed!'];

  const labelChips = thread.labels
    .map((id) => labelById.get(id))
    .filter(Boolean)
    .map(
      (lbl) =>
        `<span class="label-chip"><span class="label-dot" style="background:${safeHexColor(lbl!.color)};width:8px;height:8px;"></span>${escapeHtml(lbl!.name)}</span>`,
    )
    .join('');

  return `
    <div class="mail-toolbar" role="toolbar" aria-label="${loc === 'ja' ? 'スレッド操作' : 'Thread actions'}">
      <button type="button" class="icon-btn back-to-list-btn" title="${escapeHtml(store.tr('back'))}" aria-label="${escapeHtml(store.tr('back'))}" data-action="close-thread">${icons.arrowLeft}</button>
      <button type="button" class="icon-btn" title="${escapeHtml(store.tr('archive'))}" aria-label="${escapeHtml(store.tr('archive'))}" data-action="thread-archive">${icons.archive}</button>
      <button type="button" class="icon-btn" title="${escapeHtml(store.tr('reportSpam'))}" aria-label="${escapeHtml(store.tr('reportSpam'))}" data-action="thread-spam">${icons.spam}</button>
      <button type="button" class="icon-btn" title="${escapeHtml(store.tr('delete'))}" aria-label="${escapeHtml(store.tr('delete'))}" data-action="thread-delete">${icons.trash}</button>
      <button type="button" class="icon-btn" title="${escapeHtml(store.tr('markUnread'))}" aria-label="${escapeHtml(store.tr('markUnread'))}" data-action="thread-unread">${icons.mailUnread}</button>

      <div class="popover-wrap">
        <button type="button" class="icon-btn" title="${escapeHtml(store.tr('snooze'))}" aria-label="${escapeHtml(store.tr('snooze'))}" aria-haspopup="menu" aria-expanded="${ui.snoozeMenuOpen}" data-action="toggle-thread-snooze">${icons.clock}</button>
        ${
          ui.snoozeMenuOpen
            ? `
          <div class="menu-popover" role="menu">
            <button type="button" role="menuitem" class="dropdown-action-btn" data-action="thread-snooze" data-preset="later">${escapeHtml(store.tr('snoozeLaterToday'))}</button>
            <button type="button" role="menuitem" class="dropdown-action-btn" data-action="thread-snooze" data-preset="tomorrow">${escapeHtml(store.tr('snoozeTomorrow'))}</button>
            <button type="button" role="menuitem" class="dropdown-action-btn" data-action="thread-snooze" data-preset="nextWeek">${escapeHtml(store.tr('snoozeNextWeek'))}</button>
          </div>
        `
            : ''
        }
      </div>

      <div class="popover-wrap">
        <button type="button" class="icon-btn" title="${escapeHtml(store.tr('labels'))}" aria-label="${escapeHtml(store.tr('labels'))}" aria-haspopup="menu" aria-expanded="${ui.labelMenuOpen}" data-action="toggle-thread-labels">${icons.tag}</button>
        ${
          ui.labelMenuOpen
            ? `
          <div class="menu-popover" role="menu">
            ${store.labels
              .map((lbl) => {
                const applied = thread.labels.includes(lbl.id);
                return `
                  <button type="button" role="menuitemcheckbox" aria-checked="${applied}" class="dropdown-action-btn" data-action="thread-toggle-label" data-label-id="${escapeHtml(lbl.id)}">
                    <span class="label-dot" style="background:${safeHexColor(lbl.color)}"></span>
                    <span style="flex:1">${escapeHtml(lbl.name)}</span>
                    ${applied ? icons.check : ''}
                  </button>
                `;
              })
              .join('')}
          </div>
        `
            : ''
        }
      </div>

      <div class="toolbar-spacer"></div>
      <button type="button" class="icon-btn" title="${escapeHtml(store.tr('print'))}" aria-label="${escapeHtml(store.tr('print'))}" data-action="print-thread">${icons.printer}</button>
    </div>

    <div class="thread-scroll">
      <div class="thread-subject-bar">
        <h2 class="thread-subject-title">${escapeHtml(thread.subject)}</h2>
        <div class="row-labels">${labelChips}</div>
        <button
          type="button"
          class="star-btn ${thread.isStarred ? 'starred' : ''}"
          aria-label="${escapeHtml(thread.isStarred ? store.tr('removeStar') : store.tr('addStar'))}"
          aria-pressed="${thread.isStarred}"
          data-action="toggle-star"
          data-thread-id="${escapeHtml(thread.id)}"
        >
          ${thread.isStarred ? icons.starFilled : icons.star}
        </button>
      </div>

      ${thread.messages
        .map((msg, idx) => {
          const isLatest = idx === thread.messages.length - 1;
          const isExpanded = isLatest
            ? !ui.collapsedMsgIds.has(msg.id)
            : ui.expandedMsgIds.has(msg.id);
          const allowImgs = store.settings.alwaysDisplayImages || ui.showImagesMsgIds.has(msg.id);
          const showRaw = ui.showRawMsgIds.has(msg.id);
          const avatarBg = safeHexColor(colorForString(msg.fromEmail));
          const sanitized = msg.htmlBody
            ? sanitizeEmailHtml(msg.htmlBody, allowImgs)
            : { html: plainTextToSafeHtml(msg.textBody), hasBlockedImages: false };

          return `
            <article class="message-card">
              <div class="message-card-header">
                <button
                  type="button"
                  class="msg-toggle-btn"
                  aria-expanded="${isExpanded}"
                  data-action="toggle-msg-expand"
                  data-msg-id="${escapeHtml(msg.id)}"
                  data-is-latest="${isLatest ? '1' : '0'}"
                >
                  <span class="avatar-circle" aria-hidden="true" style="background:${avatarBg}">${escapeHtml(initialsForName(msg.fromName, msg.fromEmail))}</span>
                  <span class="msg-header-main">
                    <span class="msg-sender-line">
                      <span class="msg-sender-name">${escapeHtml(msg.fromName || msg.fromEmail)}</span>
                      <span class="msg-sender-email">&lt;${escapeHtml(msg.fromEmail)}&gt;</span>
                    </span>
                    <span class="msg-recipients-line">
                      ${
                        isExpanded
                          ? `${escapeHtml(store.tr('to'))}: ${escapeHtml(msg.to.join(', '))}${msg.cc.length ? ` · Cc: ${escapeHtml(msg.cc.join(', '))}` : ''}`
                          : escapeHtml(msg.snippet)
                      }
                    </span>
                  </span>
                </button>
                <div class="msg-date-actions">
                  <span class="msg-date-full">${escapeHtml(formatFullDate(msg.date, loc))}</span>
                  <button type="button" class="icon-btn sm" title="${escapeHtml(showRaw ? store.tr('hideOriginal') : store.tr('showOriginal'))}" aria-label="${escapeHtml(showRaw ? store.tr('hideOriginal') : store.tr('showOriginal'))}" aria-pressed="${showRaw}" data-action="toggle-raw-msg" data-msg-id="${escapeHtml(msg.id)}">${icons.code}</button>
                  <button type="button" class="icon-btn sm" title="${escapeHtml(store.tr('reply'))}" aria-label="${escapeHtml(store.tr('reply'))}" data-action="open-inline-reply">${icons.reply}</button>
                </div>
              </div>

              ${
                isExpanded
                  ? `
                <div class="message-card-body">
                  ${
                    sanitized.hasBlockedImages
                      ? `
                    <div class="remote-img-banner">
                      <span>${icons.image} ${escapeHtml(store.tr('displayImagesBanner'))}</span>
                      <button type="button" class="btn btn-sm" data-action="allow-msg-images" data-msg-id="${escapeHtml(msg.id)}">${escapeHtml(store.tr('displayImagesBtn'))}</button>
                    </div>
                  `
                      : ''
                  }

                  <div class="email-html-body">${sanitized.html}</div>

                  ${
                    msg.attachments.length > 0
                      ? `
                    <div class="attachment-grid">
                      ${msg.attachments
                        .map(
                          (att) => `
                        <button type="button" class="attachment-card" data-action="download-attachment" data-msg-id="${escapeHtml(msg.id)}" data-att-id="${escapeHtml(att.id)}">
                          ${icons.paperclip}
                          <span>
                            <strong>${escapeHtml(att.filename)}</strong>
                            <span style="display:block;font-size:0.75rem;color:var(--ink-muted);">${escapeHtml(formatBytes(att.size))}</span>
                          </span>
                          ${icons.download}
                        </button>
                      `,
                        )
                        .join('')}
                    </div>
                  `
                      : ''
                  }

                  ${
                    showRaw
                      ? `
                    <pre class="raw-headers-box">${escapeHtml(
                      msg.rawHeaders ||
                        `From: ${msg.fromName} <${msg.fromEmail}>\r\nTo: ${msg.to.join(', ')}\r\nSubject: ${msg.subject}\r\nDate: ${msg.date}\r\nMessage-ID: ${msg.messageId || `<${msg.id}@neon-gmail.local>`}`,
                    )}</pre>
                  `
                      : ''
                  }
                </div>
              `
                  : ''
              }
            </article>
          `;
        })
        .join('')}

      ${
        !ui.inlineReplyMode
          ? `
        <div class="smart-reply-row">
          ${smartReplies
            .map(
              (text) =>
                `<button type="button" class="smart-reply-chip" data-action="smart-reply" data-text="${escapeHtml(text)}">${escapeHtml(text)}</button>`,
            )
            .join('')}
        </div>
        <div class="thread-reply-actions">
          <button type="button" class="btn" data-action="open-inline-reply">${icons.reply}<span>${escapeHtml(store.tr('reply'))}</span></button>
          <button type="button" class="btn" data-action="open-inline-reply-all">${icons.replyAll}<span>${escapeHtml(store.tr('replyAll'))}</span></button>
          <button type="button" class="btn" data-action="forward-thread">${icons.forward}<span>${escapeHtml(store.tr('forward'))}</span></button>
        </div>
      `
          : `
        <div class="inline-reply-box">
          <div style="font-size:0.82rem;color:var(--ink-muted);margin-bottom:8px;">
            ${ui.inlineReplyMode === 'replyAll' ? icons.replyAll : icons.reply}
            ${escapeHtml(ui.inlineReplyMode === 'replyAll' ? store.tr('replyAll') : store.tr('reply'))}
          </div>
          <textarea
            id="inline-reply-textarea"
            class="inline-reply-textarea"
            placeholder="${escapeHtml(store.tr('bodyPlaceholder'))}"
            aria-label="${escapeHtml(store.tr('reply'))}"
          >${escapeHtml(ui.inlineReplyText)}</textarea>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
            <button type="button" class="btn btn-primary" data-action="submit-inline-reply">${icons.send}<span>${escapeHtml(store.tr('send'))}</span></button>
            <button type="button" class="icon-btn" aria-label="${escapeHtml(store.tr('discardDraft'))}" data-action="cancel-inline-reply">${icons.trash}</button>
          </div>
        </div>
      `
      }
    </div>
  `;
}
