import { icons } from '../core/icons.ts';
import { escapeHtml, safeHexColor } from '../core/sanitizer.ts';
import { estimateStorageUsageBytes } from '../core/storage.ts';
import type { MailStore } from '../core/store.ts';
import { folderLabel } from '../data/i18n.ts';
import type { SystemFolder } from '../types/mail.ts';
import { formatBytes } from './formatDate.ts';

const PRIMARY_FOLDERS: Array<{ id: SystemFolder; icon: string }> = [
  { id: 'inbox', icon: icons.inbox },
  { id: 'starred', icon: icons.star },
  { id: 'snoozed', icon: icons.clock },
  { id: 'sent', icon: icons.send },
  { id: 'drafts', icon: icons.draft },
];

const SECONDARY_FOLDERS: Array<{ id: SystemFolder; icon: string }> = [
  { id: 'important', icon: icons.important },
  { id: 'scheduled', icon: icons.calendarClock },
  { id: 'all', icon: icons.allMail },
  { id: 'spam', icon: icons.spam },
  { id: 'trash', icon: icons.trash },
];

export function renderSidebar(store: MailStore, isMobileHidden = false, moreExpanded = false): string {
  const loc = store.settings.locale;
  const counts = store.getFolderCounts();
  const usedBytes = estimateStorageUsageBytes();
  const quotaBytes = 5 * 1024 * 1024;
  const pct = Math.min(100, Math.max(1, Math.round((usedBytes / quotaBytes) * 100)));

  const renderFolderItem = (item: { id: SystemFolder; icon: string }) => {
    const active = !store.activeLabelId && !store.searchQuery && store.activeFolder === item.id;
    const count = counts[item.id];
    const showCount = count > 0 && item.id !== 'all' && item.id !== 'sent';
    return `
      <li>
        <button
          type="button"
          class="nav-item-btn ${active ? 'active' : ''}"
          aria-current="${active ? 'page' : 'false'}"
          data-action="select-folder"
          data-folder="${item.id}"
        >
          ${item.icon}
          <span class="nav-label">${escapeHtml(folderLabel(loc, item.id))}</span>
          ${showCount ? `<span class="nav-count">${count}</span>` : ''}
        </button>
      </li>
    `;
  };

  // Auto-expand secondary list if user is currently viewing one of the secondary folders
  const isSecondaryActive = SECONDARY_FOLDERS.some((f) => f.id === store.activeFolder);
  const showMore = moreExpanded || isSecondaryActive;

  return `
    <aside
      class="sidebar"
      aria-label="${loc === 'ja' ? 'メールフォルダとラベル' : 'Mail folders and labels'}"
      ${isMobileHidden ? 'inert' : ''}
    >
      <button type="button" id="compose-btn" class="compose-btn" data-action="open-compose">
        ${icons.compose}
        <span class="compose-label">${escapeHtml(store.tr('compose'))}</span>
      </button>

      <nav class="sidebar-nav" aria-label="${loc === 'ja' ? 'システムフォルダ' : 'System folders'}">
        <ul class="nav-list">
          ${PRIMARY_FOLDERS.map(renderFolderItem).join('')}
          <li>
            <button
              type="button"
              class="nav-item-btn nav-more-btn"
              aria-expanded="${showMore}"
              data-action="toggle-more-folders"
            >
              <span class="more-chevron ${showMore ? 'open' : ''}">${icons.chevronDown}</span>
              <span class="nav-label">${showMore ? (loc === 'ja' ? '表示を減らす' : 'Less') : (loc === 'ja' ? 'もっと見る' : 'More')}</span>
            </button>
          </li>
          ${showMore ? SECONDARY_FOLDERS.map(renderFolderItem).join('') : ''}
        </ul>
      </nav>

      <div class="sidebar-section-header">
        <span>${escapeHtml(store.tr('labels'))}</span>
        <button
          type="button"
          class="icon-btn sm"
          aria-label="${escapeHtml(store.tr('newLabel'))}"
          title="${escapeHtml(store.tr('newLabel'))}"
          data-action="open-new-label"
        >
          ${icons.plus}
        </button>
      </div>

      ${
        store.labels.length > 0
          ? `
        <ul class="nav-list" aria-label="${escapeHtml(store.tr('labels'))}">
          ${store.labels
            .map((lbl) => {
              const active = store.activeLabelId === lbl.id;
              const deleteLabelAria = escapeHtml(
                loc === 'ja' ? `ラベル「${lbl.name}」を削除` : `Delete label ${lbl.name}`,
              );
              return `
                <li class="label-row">
                  <button
                    type="button"
                    class="nav-item-btn ${active ? 'active' : ''}"
                    aria-current="${active ? 'page' : 'false'}"
                    data-action="select-label"
                    data-label-id="${escapeHtml(lbl.id)}"
                  >
                    <span class="label-dot" style="background:${safeHexColor(lbl.color)}"></span>
                    <span class="nav-label">${escapeHtml(lbl.name)}</span>
                  </button>
                  <button
                    type="button"
                    class="icon-btn sm label-delete-btn"
                    aria-label="${deleteLabelAria}"
                    data-action="delete-label"
                    data-label-id="${escapeHtml(lbl.id)}"
                  >
                    ${icons.close}
                  </button>
                </li>
              `;
            })
            .join('')}
        </ul>
      `
          : `<p class="sidebar-empty-hint">${loc === 'ja' ? '「+」からラベルを作成' : 'Click + to add a label'}</p>`
      }

      <div class="storage-meter">
        <div>${escapeHtml(store.tr('storageUsed'))}: ${formatBytes(usedBytes)} / 5 MB</div>
        <div class="storage-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeHtml(store.tr('storageUsed'))}">
          <div class="storage-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="sidebar-footer-links">
          <a href="./docs/" target="_blank" rel="noopener noreferrer">${escapeHtml(store.tr('docsLink'))}</a>
          <a href="./llms.txt" target="_blank" rel="noopener noreferrer">llms.txt</a>
        </div>
      </div>
    </aside>
  `;
}
