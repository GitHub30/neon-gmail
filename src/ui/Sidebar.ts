import { icons } from '../core/icons.ts';
import { escapeHtml, safeHexColor } from '../core/sanitizer.ts';
import { estimateStorageUsageBytes } from '../core/storage.ts';
import type { MailStore } from '../core/store.ts';
import { folderLabel } from '../data/i18n.ts';
import type { SystemFolder } from '../types/mail.ts';
import { formatBytes } from './formatDate.ts';

const FOLDER_ITEMS: Array<{ id: SystemFolder; icon: string }> = [
  { id: 'inbox', icon: icons.inbox },
  { id: 'starred', icon: icons.star },
  { id: 'snoozed', icon: icons.clock },
  { id: 'sent', icon: icons.send },
  { id: 'drafts', icon: icons.draft },
  { id: 'scheduled', icon: icons.calendarClock },
  { id: 'important', icon: icons.important },
  { id: 'all', icon: icons.allMail },
  { id: 'spam', icon: icons.spam },
  { id: 'trash', icon: icons.trash },
];

export function renderSidebar(store: MailStore, isMobileHidden = false): string {
  const counts = store.getFolderCounts();
  const usedBytes = estimateStorageUsageBytes();
  const quotaBytes = 5 * 1024 * 1024;
  const pct = Math.min(100, Math.max(2, Math.round((usedBytes / quotaBytes) * 100)));

  return `
    <aside
      class="sidebar"
      aria-label="${store.settings.locale === 'ja' ? 'メールフォルダとラベル' : 'Mail folders and labels'}"
      ${isMobileHidden ? 'inert' : ''}
    >
      <button type="button" id="compose-btn" class="compose-btn" data-action="open-compose">
        ${icons.compose}
        <span class="compose-label">${escapeHtml(store.tr('compose'))}</span>
      </button>

      <nav aria-label="${store.settings.locale === 'ja' ? 'システムフォルダ' : 'System folders'}">
        <ul class="nav-list">
          ${FOLDER_ITEMS.map((item) => {
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
                  <span class="nav-label">${escapeHtml(folderLabel(store.settings.locale, item.id))}</span>
                  ${showCount ? `<span class="nav-count">${count}</span>` : ''}
                </button>
              </li>
            `;
          }).join('')}
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

      <ul class="nav-list" aria-label="${escapeHtml(store.tr('labels'))}">
        ${store.labels
          .map((lbl) => {
            const active = store.activeLabelId === lbl.id;
            const deleteLabelAria = escapeHtml(
              store.settings.locale === 'ja' ? `ラベル「${lbl.name}」を削除` : `Delete label ${lbl.name}`,
            );
            return `
              <li style="display:flex;align-items:center;gap:2px;">
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
                  class="icon-btn sm"
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
