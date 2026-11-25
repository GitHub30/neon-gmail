import { icons } from '../core/icons.ts';
import { escapeHtml, safeHexColor } from '../core/sanitizer.ts';
import type { MailStore } from '../core/store.ts';
import { categoryLabel } from '../data/i18n.ts';
import type { InboxCategory, MailThread } from '../types/mail.ts';
import { formatShortDate } from './formatDate.ts';

export interface ListUiState {
  selectMenuOpen: boolean;
  labelMenuOpen: boolean;
  snoozeMenuOpen: boolean;
}

const CATEGORIES: Array<{ id: InboxCategory; icon: string }> = [
  { id: 'primary', icon: icons.inbox },
  { id: 'promotions', icon: icons.promotions },
  { id: 'social', icon: icons.social },
  { id: 'updates', icon: icons.updates },
];

export function renderMessageList(store: MailStore, threads: MailThread[], ui: ListUiState): string {
  const loc = store.settings.locale;
  const pageSize = store.settings.pageSize;
  const total = threads.length;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(store.currentPage, maxPage);
  const startIdx = (page - 1) * pageSize;
  const pageThreads = threads.slice(startIdx, startIdx + pageSize);

  const selectedCount = store.selectedThreadIds.size;
  const allVisibleSelected = pageThreads.length > 0 && pageThreads.every((th) => store.selectedThreadIds.has(th.id));
  const labelById = new Map(store.labels.map((l) => [l.id, l]));
  const catCounts = store.getCategoryUnreadCounts();
  const activeAcc = store.getActiveAccount();

  const toolbarHtml = `
    <div class="mail-toolbar" role="toolbar" aria-label="${loc === 'ja' ? 'メール操作ツールバー' : 'Mail actions'}">
      <div class="toolbar-group popover-wrap">
        <label class="row-check-wrap" style="padding:4px 4px 4px 6px;">
          <input
            type="checkbox"
            class="row-checkbox"
            aria-label="${escapeHtml(store.tr('selectAll'))}"
            ${allVisibleSelected ? 'checked' : ''}
            data-action="toggle-select-all"
          />
        </label>
        <button
          type="button"
          class="icon-btn sm"
          aria-label="${loc === 'ja' ? '選択メニュー' : 'Selection options'}"
          aria-haspopup="menu"
          aria-expanded="${ui.selectMenuOpen}"
          data-action="toggle-select-menu"
        >
          ${icons.chevronDown}
        </button>
        ${
          ui.selectMenuOpen
            ? `
          <div class="menu-popover" role="menu">
            <button type="button" role="menuitem" class="dropdown-action-btn" data-action="select-filter" data-filter="all">${escapeHtml(store.tr('selectAll'))}</button>
            <button type="button" role="menuitem" class="dropdown-action-btn" data-action="select-filter" data-filter="none">${escapeHtml(store.tr('selectNone'))}</button>
            <button type="button" role="menuitem" class="dropdown-action-btn" data-action="select-filter" data-filter="read">${escapeHtml(store.tr('selectRead'))}</button>
            <button type="button" role="menuitem" class="dropdown-action-btn" data-action="select-filter" data-filter="unread">${escapeHtml(store.tr('selectUnread'))}</button>
            <button type="button" role="menuitem" class="dropdown-action-btn" data-action="select-filter" data-filter="starred">${escapeHtml(store.tr('selectStarred'))}</button>
          </div>
        `
            : ''
        }
      </div>

      ${
        selectedCount > 0
          ? `
        <div class="toolbar-group">
          <button type="button" class="icon-btn" title="${escapeHtml(store.tr('archive'))}" aria-label="${escapeHtml(store.tr('archive'))}" data-action="bulk-archive">${icons.archive}</button>
          ${
            store.activeFolder === 'spam'
              ? `<button type="button" class="btn btn-sm" data-action="bulk-not-spam">${escapeHtml(store.tr('notSpam'))}</button>`
              : `<button type="button" class="icon-btn" title="${escapeHtml(store.tr('reportSpam'))}" aria-label="${escapeHtml(store.tr('reportSpam'))}" data-action="bulk-spam">${icons.spam}</button>`
          }
          <button type="button" class="icon-btn" title="${escapeHtml(store.tr('delete'))}" aria-label="${escapeHtml(store.tr('delete'))}" data-action="bulk-delete">${icons.trash}</button>
          <button type="button" class="icon-btn" title="${escapeHtml(store.tr('markRead'))}" aria-label="${escapeHtml(store.tr('markRead'))}" data-action="bulk-read">${icons.mailOpen}</button>
          <button type="button" class="icon-btn" title="${escapeHtml(store.tr('markUnread'))}" aria-label="${escapeHtml(store.tr('markUnread'))}" data-action="bulk-unread">${icons.mailUnread}</button>

          <div class="popover-wrap">
            <button type="button" class="icon-btn" title="${escapeHtml(store.tr('snooze'))}" aria-label="${escapeHtml(store.tr('snooze'))}" aria-haspopup="menu" aria-expanded="${ui.snoozeMenuOpen}" data-action="toggle-snooze-menu">${icons.clock}</button>
            ${
              ui.snoozeMenuOpen
                ? `
              <div class="menu-popover" role="menu">
                <button type="button" role="menuitem" class="dropdown-action-btn" data-action="bulk-snooze" data-preset="later">${escapeHtml(store.tr('snoozeLaterToday'))}</button>
                <button type="button" role="menuitem" class="dropdown-action-btn" data-action="bulk-snooze" data-preset="tomorrow">${escapeHtml(store.tr('snoozeTomorrow'))}</button>
                <button type="button" role="menuitem" class="dropdown-action-btn" data-action="bulk-snooze" data-preset="nextWeek">${escapeHtml(store.tr('snoozeNextWeek'))}</button>
              </div>
            `
                : ''
            }
          </div>

          <div class="popover-wrap">
            <button type="button" class="icon-btn" title="${escapeHtml(store.tr('labels'))}" aria-label="${escapeHtml(store.tr('labels'))}" aria-haspopup="menu" aria-expanded="${ui.labelMenuOpen}" data-action="toggle-label-menu">${icons.tag}</button>
            ${
              ui.labelMenuOpen
                ? `
              <div class="menu-popover" role="menu">
                ${store.labels
                  .map(
                    (lbl) => `
                  <button type="button" role="menuitem" class="dropdown-action-btn" data-action="bulk-label" data-label-id="${escapeHtml(lbl.id)}">
                    <span class="label-dot" style="background:${safeHexColor(lbl.color)}"></span>
                    <span>${escapeHtml(lbl.name)}</span>
                  </button>
                `,
                  )
                  .join('')}
              </div>
            `
                : ''
            }
          </div>
        </div>
      `
          : `
        <button
          type="button"
          class="icon-btn ${store.isSyncing ? 'sync-spinning' : ''}"
          title="${escapeHtml(store.tr('refresh'))}"
          aria-label="${escapeHtml(store.tr('refresh'))}"
          data-action="sync-mail"
        >
          ${icons.refresh}
        </button>
      `
      }

      <div class="toolbar-spacer"></div>

      <span class="pagination-text">
        ${total === 0 ? '0' : `${startIdx + 1}–${Math.min(startIdx + pageSize, total)} / ${total}`}
      </span>
      <button type="button" class="icon-btn sm" aria-label="${loc === 'ja' ? '前のページ' : 'Previous page'}" ${page <= 1 ? 'disabled' : ''} data-action="prev-page">${icons.chevronLeft}</button>
      <button type="button" class="icon-btn sm" aria-label="${loc === 'ja' ? '次のページ' : 'Next page'}" ${page >= maxPage ? 'disabled' : ''} data-action="next-page">${icons.chevronRight}</button>
      <button
        type="button"
        class="icon-btn sm ${store.settings.readingPane !== 'none' ? 'active' : ''}"
        title="${escapeHtml(store.tr('readingPaneLabel'))}"
        aria-label="${escapeHtml(store.tr('readingPaneLabel'))}"
        data-action="cycle-reading-pane"
      >
        ${icons.splitPane}
      </button>
    </div>
  `;

  const showCategoryTabs = store.activeFolder === 'inbox' && !store.activeLabelId && !store.searchQuery;
  const categoryTabsHtml = showCategoryTabs
    ? `
      <div class="category-tabs" role="tablist" aria-label="${loc === 'ja' ? '受信トレイのカテゴリ' : 'Inbox categories'}">
        ${CATEGORIES.map((cat) => {
          const selected = store.activeCategory === cat.id;
          const unread = catCounts[cat.id];
          return `
            <button
              type="button"
              id="cat-tab-${cat.id}"
              role="tab"
              aria-selected="${selected}"
              aria-controls="mail-list-panel"
              tabindex="${selected ? '0' : '-1'}"
              class="category-tab"
              data-action="select-category"
              data-category="${cat.id}"
            >
              ${cat.icon}
              <span>${escapeHtml(categoryLabel(loc, cat.id))}</span>
              ${unread > 0 ? `<span class="cat-badge">${unread}</span>` : ''}
            </button>
          `;
        }).join('')}
      </div>
    `
    : '';

  const trashBannerHtml =
    store.activeFolder === 'trash' && total > 0
      ? `
      <div class="folder-banner">
        <span>${loc === 'ja' ? 'ゴミ箱内のメッセージは30日後に自動削除されます。' : 'Messages in Trash are automatically removed after 30 days.'}</span>
        <button type="button" class="btn btn-sm" data-action="empty-trash">${escapeHtml(store.tr('emptyTrash'))}</button>
      </div>
    `
      : '';

  const panelAttrs = showCategoryTabs
    ? `id="mail-list-panel" role="tabpanel" aria-labelledby="cat-tab-${store.activeCategory}"`
    : `id="mail-list-panel"`;

  if (pageThreads.length === 0) {
    return `
      ${toolbarHtml}
      ${categoryTabsHtml}
      ${trashBannerHtml}
      <div ${panelAttrs} class="empty-state">
        ${icons.inbox}
        <p>${escapeHtml(store.searchQuery ? store.tr('noSearchResults') : store.tr('noMessages'))}</p>
        ${
          !activeAcc
            ? `<button type="button" class="btn btn-primary" data-action="open-login">${escapeHtml(store.tr('loginTitle'))}</button>`
            : ''
        }
      </div>
    `;
  }

  const rowsHtml = pageThreads
    .map((th) => {
      const isSelected = store.selectedThreadIds.has(th.id);
      const isUnread = th.unreadCount > 0;
      const isOpen = store.openThreadId === th.id;
      const senderNames = th.participants
        .map((p) => (activeAcc && p.email.toLowerCase() === activeAcc.email.toLowerCase() ? store.tr('me') : p.name))
        .join(', ');
      const labelChips = th.labels
        .map((id) => labelById.get(id))
        .filter(Boolean)
        .map(
          (lbl) =>
            `<span class="label-chip"><span class="label-dot" style="background:${safeHexColor(lbl!.color)};width:7px;height:7px;"></span>${escapeHtml(lbl!.name)}</span>`,
        )
        .join('');

      return `
        <li
          class="thread-row ${isUnread ? 'unread' : ''} ${isSelected ? 'selected' : ''} ${isOpen ? 'active-open' : ''}"
          data-thread-id="${escapeHtml(th.id)}"
        >
          <span class="row-check-wrap">
            <input
              type="checkbox"
              class="row-checkbox"
              aria-label="${escapeHtml(th.subject)}"
              ${isSelected ? 'checked' : ''}
              data-action="toggle-select-thread"
              data-thread-id="${escapeHtml(th.id)}"
            />
          </span>

          <button
            type="button"
            class="star-btn ${th.isStarred ? 'starred' : ''}"
            aria-label="${escapeHtml(th.isStarred ? store.tr('removeStar') : store.tr('addStar'))}"
            aria-pressed="${th.isStarred}"
            data-action="toggle-star"
            data-thread-id="${escapeHtml(th.id)}"
          >
            ${th.isStarred ? icons.starFilled : icons.star}
          </button>

          <button
            type="button"
            class="important-btn ${th.isImportant ? 'important' : ''}"
            aria-label="${escapeHtml(store.tr('important'))}"
            aria-pressed="${th.isImportant}"
            data-action="toggle-important"
            data-thread-id="${escapeHtml(th.id)}"
          >
            ${th.isImportant ? icons.importantFilled : icons.important}
          </button>

          <button
            type="button"
            class="row-open-btn"
            data-action="open-thread"
            data-thread-id="${escapeHtml(th.id)}"
          >
            <span class="row-sender">
              <span style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(senderNames)}</span>
              ${th.messages.length > 1 ? `<span class="msg-count-tag">${th.messages.length}</span>` : ''}
            </span>

            <span class="row-content">
              ${labelChips ? `<span class="row-labels">${labelChips}</span>` : ''}
              <span class="row-subject">${escapeHtml(th.subject)}</span>
              <span class="row-snippet">— ${escapeHtml(th.snippet)}</span>
            </span>
          </button>

          <span class="row-meta-right">
            ${th.hasAttachments ? `<span class="attachment-indicator" title="${loc === 'ja' ? '添付ファイルあり' : 'Has attachment'}">${icons.paperclip}</span>` : ''}
            <span class="row-date">${escapeHtml(formatShortDate(th.latestDate, loc))}</span>
            <span class="row-hover-actions">
              <button type="button" class="icon-btn sm" title="${escapeHtml(store.tr('archive'))}" aria-label="${escapeHtml(store.tr('archive'))}" data-action="row-archive" data-thread-id="${escapeHtml(th.id)}">${icons.archive}</button>
              <button type="button" class="icon-btn sm" title="${escapeHtml(store.tr('delete'))}" aria-label="${escapeHtml(store.tr('delete'))}" data-action="row-delete" data-thread-id="${escapeHtml(th.id)}">${icons.trash}</button>
              <button type="button" class="icon-btn sm" title="${escapeHtml(isUnread ? store.tr('markRead') : store.tr('markUnread'))}" aria-label="${escapeHtml(isUnread ? store.tr('markRead') : store.tr('markUnread'))}" data-action="row-toggle-read" data-thread-id="${escapeHtml(th.id)}">${isUnread ? icons.mailOpen : icons.mailUnread}</button>
              <button type="button" class="icon-btn sm" title="${escapeHtml(store.tr('snooze'))}" aria-label="${escapeHtml(store.tr('snooze'))}" data-action="row-snooze" data-thread-id="${escapeHtml(th.id)}">${icons.clock}</button>
            </span>
          </span>
        </li>
      `;
    })
    .join('');

  return `
    ${toolbarHtml}
    ${categoryTabsHtml}
    ${trashBannerHtml}
    <div ${panelAttrs} class="thread-list-panel">
      <ul class="thread-list" aria-label="${loc === 'ja' ? 'メール一覧' : 'Email conversations'}">
        ${rowsHtml}
      </ul>
    </div>
  `;
}
