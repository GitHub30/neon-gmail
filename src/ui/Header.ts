import { icons } from '../core/icons.ts';
import { escapeHtml, safeHexColor } from '../core/sanitizer.ts';
import type { MailStore } from '../core/store.ts';
import { initialsForName } from '../data/providers.ts';

export interface HeaderUiState {
  accountMenuOpen: boolean;
  advSearchOpen: boolean;
  canInstallPwa: boolean;
  sidebarExpanded: boolean;
}

export function renderHeader(store: MailStore, ui: HeaderUiState): string {
  const active = store.getActiveAccount();
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const loc = store.settings.locale;

  const accountButtonHtml = active
    ? `
      <button
        type="button"
        id="account-switcher-btn"
        class="account-trigger"
        aria-haspopup="true"
        aria-expanded="${ui.accountMenuOpen}"
        title="${escapeHtml(store.tr('accountSwitcher'))}"
        data-action="toggle-account-menu"
      >
        <span class="avatar-circle" aria-hidden="true" style="background:${safeHexColor(active.avatarColor)}">${escapeHtml(initialsForName(active.displayName, active.email))}</span>
        <span class="account-trigger-meta">
          <span class="account-trigger-name">${escapeHtml(active.displayName)}</span>
          <span class="account-trigger-badge">${escapeHtml(store.hasLiveProxy(active) ? store.tr('liveProxy') : store.tr('demoMode'))}</span>
        </span>
        <span class="sr-only">${escapeHtml(store.tr('accountSwitcher'))}</span>
        ${icons.chevronDown}
      </button>
    `
    : `
      <button type="button" id="sign-in-header-btn" class="btn btn-primary" data-action="open-login">
        ${icons.userPlus}
        <span>${escapeHtml(store.tr('loginTitle'))}</span>
      </button>
    `;

  const accountDropdownHtml = ui.accountMenuOpen
    ? `
      <div class="account-dropdown" aria-label="${escapeHtml(store.tr('accountSwitcher'))}">
        ${
          active
            ? `
          <div class="account-current-card">
            <span class="avatar-circle lg" aria-hidden="true" style="background:${safeHexColor(active.avatarColor)}">${escapeHtml(initialsForName(active.displayName, active.email))}</span>
            <div class="account-current-info">
              <div class="account-current-name">${escapeHtml(active.displayName)}</div>
              <div class="account-current-email">${escapeHtml(active.email)}</div>
              <span class="conn-pill ${store.hasLiveProxy(active) ? 'live' : ''}">
                ${store.hasLiveProxy(active) ? icons.cloud : icons.shield}
                <span>${escapeHtml(store.hasLiveProxy(active) ? `${active.proxyType.toUpperCase()} · ${store.tr('liveProxy')}` : store.tr('demoMode'))}</span>
              </span>
            </div>
          </div>
        `
            : ''
        }

        <div role="menu" aria-label="${escapeHtml(store.tr('accountSwitcher'))}">
          <div class="account-list" role="group" aria-label="${loc === 'ja' ? '保存済みアカウント' : 'Saved accounts'}">
            ${store.accounts
              .map((acc) => {
                const isCurrent = acc.id === active?.id;
                const unread = store.getUnreadCountForAccount(acc);
                return `
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked="${isCurrent}"
                    class="account-item ${isCurrent ? 'is-active' : ''}"
                    data-action="switch-account"
                    data-account-id="${escapeHtml(acc.id)}"
                  >
                    <span class="avatar-circle" aria-hidden="true" style="background:${safeHexColor(acc.avatarColor)}">${escapeHtml(initialsForName(acc.displayName, acc.email))}</span>
                    <span class="account-item-text">
                      <span class="account-item-name">${escapeHtml(acc.displayName)}</span>
                      <span class="account-item-email">${escapeHtml(acc.email)}</span>
                    </span>
                    ${unread > 0 ? `<span class="account-unread-pill">${unread}</span>` : ''}
                    ${isCurrent ? icons.check : ''}
                  </button>
                `;
              })
              .join('')}
          </div>

          <div class="dropdown-divider" role="separator"></div>

          <button type="button" role="menuitem" class="dropdown-action-btn" data-action="open-login">
            ${icons.userPlus}
            <span>${escapeHtml(store.tr('addAccount'))}</span>
          </button>
          ${
            active
              ? `
            <button type="button" role="menuitem" class="dropdown-action-btn" data-action="edit-active-account">
              ${icons.cloud}
              <span>${escapeHtml(store.tr('editAccount'))}</span>
            </button>
            <button type="button" role="menuitem" class="dropdown-action-btn danger" data-action="remove-active-account">
              ${icons.trash}
              <span>${escapeHtml(store.tr('removeAccount'))}</span>
            </button>
          `
              : ''
          }
          ${
            store.accounts.length > 0
              ? `
            <button type="button" role="menuitem" class="dropdown-action-btn danger" data-action="sign-out-all">
              ${icons.logOut}
              <span>${escapeHtml(store.tr('signOutAll'))}</span>
            </button>
          `
              : ''
          }
        </div>
      </div>
    `
    : '';

  const advSearchHtml = ui.advSearchOpen
    ? `
      <form class="adv-search-popover" id="adv-search-form">
        <div class="adv-search-grid">
          <label for="adv-from">${loc === 'ja' ? '差出人 (From)' : 'From'}</label>
          <input id="adv-from" name="from" class="field-input" type="text" placeholder="alice@example.com" />

          <label for="adv-to">${loc === 'ja' ? '宛先 (To)' : 'To'}</label>
          <input id="adv-to" name="to" class="field-input" type="text" placeholder="bob@example.com" />

          <label for="adv-subject">${loc === 'ja' ? '件名 (Subject)' : 'Subject'}</label>
          <input id="adv-subject" name="subject" class="field-input" type="text" />

          <label for="adv-words">${loc === 'ja' ? '含む語句' : 'Includes words'}</label>
          <input id="adv-words" name="words" class="field-input" type="text" />
        </div>

        <fieldset class="adv-filter-fieldset">
          <legend>${loc === 'ja' ? '条件' : 'Filters'}</legend>
          <label class="inline-check-label">
            <input id="adv-has-att" name="hasAttachment" type="checkbox" />
            <span>${loc === 'ja' ? '添付ファイルあり' : 'Has attachment'}</span>
          </label>
          <label class="inline-check-label">
            <input id="adv-unread" name="isUnread" type="checkbox" />
            <span>${loc === 'ja' ? '未読のみ' : 'Unread only'}</span>
          </label>
          <label class="inline-check-label">
            <input id="adv-starred" name="isStarred" type="checkbox" />
            <span>${loc === 'ja' ? 'スター付き' : 'Starred'}</span>
          </label>
        </fieldset>

        <div class="adv-search-actions">
          <button type="button" class="btn btn-sm" data-action="close-adv-search">${escapeHtml(store.tr('cancel'))}</button>
          <button type="submit" class="btn btn-primary btn-sm">${loc === 'ja' ? '検索' : 'Search'}</button>
        </div>
      </form>
    `
    : '';

  return `
    <header class="top-header">
      <div class="header-left">
        <button
          type="button"
          id="sidebar-toggle-btn"
          class="icon-btn"
          aria-expanded="${ui.sidebarExpanded}"
          aria-label="${loc === 'ja' ? 'メインメニューを開閉' : 'Toggle main menu'}"
          data-action="toggle-sidebar"
        >
          ${icons.menu}
        </button>
        <a href="#inbox" class="brand-link" aria-label="Neon Gmail" data-action="go-inbox">
          ${icons.brandLogo}
          <h1 class="brand-title">Neon Gmail</h1>
        </a>
      </div>

      <div class="search-wrap" role="search">
        <div class="search-box">
          <button type="button" class="icon-btn sm" aria-label="${loc === 'ja' ? '検索を実行' : 'Search'}" data-action="focus-search">
            ${icons.search}
          </button>
          <input
            id="global-search-input"
            class="search-input"
            type="search"
            autocomplete="off"
            value="${escapeHtml(store.searchQuery)}"
            placeholder="${escapeHtml(store.tr('searchPlaceholder'))}"
            aria-label="${escapeHtml(store.tr('searchPlaceholder'))}"
          />
          <button
            type="button"
            id="clear-search-btn"
            class="icon-btn sm"
            style="${store.searchQuery ? '' : 'display:none;'}"
            aria-label="${loc === 'ja' ? '検索をクリア' : 'Clear search'}"
            data-action="clear-search"
          >${icons.close}</button>
          <button
            type="button"
            class="icon-btn sm ${ui.advSearchOpen ? 'active' : ''}"
            aria-label="${escapeHtml(store.tr('advancedSearch'))}"
            aria-expanded="${ui.advSearchOpen}"
            data-action="toggle-adv-search"
          >
            ${icons.tune}
          </button>
        </div>
        ${advSearchHtml}
      </div>

      <div class="header-right">
        ${
          ui.canInstallPwa
            ? `<button type="button" id="pwa-install-btn" class="btn btn-sm" data-action="install-pwa">${icons.download}<span>${escapeHtml(store.tr('installApp'))}</span></button>`
            : ''
        }
        <button
          type="button"
          id="theme-toggle-btn"
          class="icon-btn"
          aria-label="${isDark ? (loc === 'ja' ? 'ライトモードに切替' : 'Switch to light mode') : (loc === 'ja' ? 'ダークモードに切替' : 'Switch to dark mode')}"
          title="${isDark ? store.tr('themeLight') : store.tr('themeDark')}"
          data-action="toggle-theme"
        >
          ${isDark ? icons.sun : icons.moon}
        </button>
        <button
          type="button"
          id="shortcuts-btn"
          class="icon-btn"
          aria-label="${escapeHtml(store.tr('shortcutsTitle'))}"
          title="${escapeHtml(store.tr('shortcutsTitle'))} (?)"
          data-action="open-shortcuts"
        >
          ${icons.help}
        </button>
        <button
          type="button"
          id="settings-btn"
          class="icon-btn"
          aria-label="${escapeHtml(store.tr('settingsTitle'))}"
          title="${escapeHtml(store.tr('settingsTitle'))}"
          data-action="open-settings"
        >
          ${icons.settings}
        </button>

        <div class="account-switcher-wrap">
          ${accountButtonHtml}
          ${accountDropdownHtml}
        </div>
      </div>
    </header>
  `;
}
