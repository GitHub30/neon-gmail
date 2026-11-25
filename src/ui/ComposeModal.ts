import { icons } from '../core/icons.ts';
import { escapeHtml, sanitizeEmailHtml } from '../core/sanitizer.ts';
import type { MailStore } from '../core/store.ts';
import { formatBytes } from './formatDate.ts';

export function renderComposeDock(store: MailStore, showCcBccIds: Set<string>, scheduleOpenDraftId: string | null): string {
  const activeDrafts = store.getActiveDrafts();
  if (activeDrafts.length === 0) return '';
  const loc = store.settings.locale;

  return `
    <div class="compose-dock" aria-label="${loc === 'ja' ? 'メッセージ作成ウィンドウ' : 'Compose windows'}">
      ${activeDrafts
        .map((draft) => {
          const boundAcc = store.accounts.find((a) => a.id === draft.accountId) ?? store.getActiveAccount();
          const showCc = showCcBccIds.has(draft.id) || draft.cc.length > 0 || draft.bcc.length > 0;
          // Respect alwaysDisplayImages setting to prevent tracking pixels when forwarding
          const safeInitialHtml = sanitizeEmailHtml(draft.htmlBody, store.settings.alwaysDisplayImages).html;
          const isSchedOpen = scheduleOpenDraftId === draft.id;
          const scheduleMenu = isSchedOpen
            ? `
            <div class="menu-popover" style="bottom:calc(100% + 6px);top:auto;" role="menu">
              <button type="button" role="menuitem" class="dropdown-action-btn" data-action="schedule-send-preset" data-draft-id="${escapeHtml(draft.id)}" data-preset="later">${escapeHtml(store.tr('snoozeLaterToday'))}</button>
              <button type="button" role="menuitem" class="dropdown-action-btn" data-action="schedule-send-preset" data-draft-id="${escapeHtml(draft.id)}" data-preset="tomorrow">${escapeHtml(store.tr('snoozeTomorrow'))}</button>
              <button type="button" role="menuitem" class="dropdown-action-btn" data-action="schedule-send-preset" data-draft-id="${escapeHtml(draft.id)}" data-preset="nextWeek">${escapeHtml(store.tr('snoozeNextWeek'))}</button>
            </div>
          `
            : '';

          return `
            <section
              class="compose-window ${draft.minimized ? 'minimized' : ''} ${draft.expanded ? 'expanded' : ''}"
              data-draft-id="${escapeHtml(draft.id)}"
              aria-label="${escapeHtml(draft.subject || store.tr('compose'))}"
            >
              <div class="compose-header">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  ${escapeHtml(draft.subject || (loc === 'ja' ? '新規メッセージ' : 'New Message'))}
                </span>
                <div style="display:flex;align-items:center;gap:2px;">
                  <button type="button" class="icon-btn sm" aria-label="${loc === 'ja' ? '最小化' : 'Minimize'}" data-action="compose-minimize" data-draft-id="${escapeHtml(draft.id)}">${icons.minimize}</button>
                  <button type="button" class="icon-btn sm" aria-label="${loc === 'ja' ? '全画面切替' : 'Toggle full screen'}" data-action="compose-expand" data-draft-id="${escapeHtml(draft.id)}">${icons.maximize}</button>
                  <button type="button" class="icon-btn sm" aria-label="${escapeHtml(store.tr('close'))}" data-action="compose-close" data-draft-id="${escapeHtml(draft.id)}">${icons.close}</button>
                </div>
              </div>

              ${
                !draft.minimized
                  ? `
                <div class="compose-body-wrap">
                  ${
                    boundAcc
                      ? `
                    <div class="compose-field-row" style="font-size:0.8rem;color:var(--ink-muted);">
                      <span>From</span>
                      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(boundAcc.displayName)} &lt;${escapeHtml(boundAcc.email)}&gt;</span>
                      ${!showCc ? `<button type="button" class="btn btn-sm" style="border:none;height:24px;padding:0 6px;" data-action="compose-show-cc" data-draft-id="${escapeHtml(draft.id)}">Cc / Bcc</button>` : ''}
                    </div>
                  `
                      : ''
                  }

                  <div class="compose-field-row">
                    <label for="compose-to-${escapeHtml(draft.id)}">${escapeHtml(store.tr('to'))}</label>
                    <input
                      id="compose-to-${escapeHtml(draft.id)}"
                      type="text"
                      value="${escapeHtml(draft.to.join(', '))}"
                      placeholder="alice@example.com, bob@example.com"
                      data-compose-field="to"
                      data-draft-id="${escapeHtml(draft.id)}"
                    />
                  </div>

                  ${
                    showCc
                      ? `
                    <div class="compose-field-row">
                      <label for="compose-cc-${escapeHtml(draft.id)}">${escapeHtml(store.tr('cc'))}</label>
                      <input id="compose-cc-${escapeHtml(draft.id)}" type="text" value="${escapeHtml(draft.cc.join(', '))}" data-compose-field="cc" data-draft-id="${escapeHtml(draft.id)}" />
                    </div>
                    <div class="compose-field-row">
                      <label for="compose-bcc-${escapeHtml(draft.id)}">${escapeHtml(store.tr('bcc'))}</label>
                      <input id="compose-bcc-${escapeHtml(draft.id)}" type="text" value="${escapeHtml(draft.bcc.join(', '))}" data-compose-field="bcc" data-draft-id="${escapeHtml(draft.id)}" />
                    </div>
                  `
                      : ''
                  }

                  <div class="compose-field-row">
                    <label for="compose-subj-${escapeHtml(draft.id)}">${escapeHtml(store.tr('subject'))}</label>
                    <input
                      id="compose-subj-${escapeHtml(draft.id)}"
                      type="text"
                      value="${escapeHtml(draft.subject)}"
                      placeholder="${escapeHtml(store.tr('subject'))}"
                      data-compose-field="subject"
                      data-draft-id="${escapeHtml(draft.id)}"
                    />
                  </div>

                  <div class="compose-format-bar" role="toolbar" aria-label="${loc === 'ja' ? '書式設定' : 'Formatting'}">
                    <button type="button" class="fmt-btn" title="${loc === 'ja' ? '太字' : 'Bold'}" aria-label="${loc === 'ja' ? '太字' : 'Bold'}" data-action="compose-fmt" data-cmd="bold" data-draft-id="${escapeHtml(draft.id)}"><strong>B</strong></button>
                    <button type="button" class="fmt-btn" title="${loc === 'ja' ? '斜体' : 'Italic'}" aria-label="${loc === 'ja' ? '斜体' : 'Italic'}" data-action="compose-fmt" data-cmd="italic" data-draft-id="${escapeHtml(draft.id)}"><em>I</em></button>
                    <button type="button" class="fmt-btn" title="${loc === 'ja' ? '下線' : 'Underline'}" aria-label="${loc === 'ja' ? '下線' : 'Underline'}" data-action="compose-fmt" data-cmd="underline" data-draft-id="${escapeHtml(draft.id)}"><u>U</u></button>
                    <button type="button" class="fmt-btn" title="${loc === 'ja' ? '取り消し線' : 'Strikethrough'}" aria-label="${loc === 'ja' ? '取り消し線' : 'Strikethrough'}" data-action="compose-fmt" data-cmd="strikeThrough" data-draft-id="${escapeHtml(draft.id)}"><s>S</s></button>
                    <button type="button" class="fmt-btn" title="${loc === 'ja' ? '箇条書き' : 'Bulleted list'}" aria-label="${loc === 'ja' ? '箇条書き' : 'Bulleted list'}" data-action="compose-fmt" data-cmd="insertUnorderedList" data-draft-id="${escapeHtml(draft.id)}">&bull; List</button>
                    <button type="button" class="fmt-btn" title="${loc === 'ja' ? '番号付きリスト' : 'Numbered list'}" aria-label="${loc === 'ja' ? '番号付きリスト' : 'Numbered list'}" data-action="compose-fmt" data-cmd="insertOrderedList" data-draft-id="${escapeHtml(draft.id)}">1. List</button>
                    <button type="button" class="fmt-btn" title="${loc === 'ja' ? '書式クリア' : 'Clear formatting'}" aria-label="${loc === 'ja' ? '書式クリア' : 'Clear formatting'}" data-action="compose-fmt" data-cmd="removeFormat" data-draft-id="${escapeHtml(draft.id)}">Tx</button>
                  </div>

                  <div
                    id="compose-editor-${escapeHtml(draft.id)}"
                    class="compose-editor"
                    contenteditable="true"
                    role="textbox"
                    aria-multiline="true"
                    aria-label="${escapeHtml(store.tr('bodyPlaceholder'))}"
                    data-compose-editor="${escapeHtml(draft.id)}"
                  >${safeInitialHtml}</div>

                  ${
                    draft.attachments.length > 0
                      ? `
                    <div class="compose-attachments">
                      ${draft.attachments
                        .map(
                          (att) => `
                        <span class="compose-att-pill">
                          ${icons.paperclip}
                          <span>${escapeHtml(att.filename)} (${escapeHtml(formatBytes(att.size))})</span>
                          <button type="button" class="icon-btn sm" style="width:24px;height:24px;" aria-label="${loc === 'ja' ? '添付を削除' : 'Remove attachment'}" data-action="compose-remove-att" data-draft-id="${escapeHtml(draft.id)}" data-att-id="${escapeHtml(att.id)}">${icons.close}</button>
                        </span>
                      `,
                        )
                        .join('')}
                    </div>
                  `
                      : ''
                  }

                  <div class="compose-footer">
                    <div style="display:flex;align-items:center;gap:6px;">
                      <button type="button" class="btn btn-primary" data-action="compose-send" data-draft-id="${escapeHtml(draft.id)}">
                        ${icons.send}
                        <span>${escapeHtml(store.tr('send'))}</span>
                      </button>
                      <div class="popover-wrap">
                        <button type="button" class="icon-btn sm" title="${escapeHtml(store.tr('scheduleSend'))}" aria-label="${escapeHtml(store.tr('scheduleSend'))}" aria-haspopup="menu" aria-expanded="${isSchedOpen}" data-action="compose-toggle-schedule" data-draft-id="${escapeHtml(draft.id)}">
                          ${icons.calendarClock}
                        </button>
                        ${scheduleMenu}
                      </div>
                      <label class="icon-btn sm file-input-label" title="${escapeHtml(store.tr('attachFile'))}">
                        ${icons.paperclip}
                        <span class="sr-only">${escapeHtml(store.tr('attachFile'))}</span>
                        <input type="file" multiple class="sr-only" data-compose-file="${escapeHtml(draft.id)}" />
                      </label>
                    </div>
                    <button type="button" class="icon-btn sm" title="${escapeHtml(store.tr('discardDraft'))}" aria-label="${escapeHtml(store.tr('discardDraft'))}" data-action="compose-discard" data-draft-id="${escapeHtml(draft.id)}">
                      ${icons.trash}
                    </button>
                  </div>
                </div>
              `
                  : ''
              }
            </section>
          `;
        })
        .join('')}
    </div>
  `;
}
