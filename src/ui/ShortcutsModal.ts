import { icons } from '../core/icons.ts';
import { escapeHtml } from '../core/sanitizer.ts';
import type { MailStore } from '../core/store.ts';

export function renderShortcutsModal(store: MailStore, isOpen: boolean): string {
  if (!isOpen) return '';
  const loc = store.settings.locale;
  const rows: Array<[string, string]> =
    loc === 'ja'
      ? [
          ['c', '新規メールを作成'],
          ['/', '検索バーにフォーカス'],
          ['j / k', '次 / 前のスレッドへ移動'],
          ['Enter / o', 'スレッドを開く'],
          ['u', '一覧へ戻る'],
          ['e', 'アーカイブ'],
          ['#', 'ゴミ箱へ移動'],
          ['!', '迷惑メールを報告'],
          ['s', 'スターを切替'],
          ['r', '返信'],
          ['a', '全員に返信'],
          ['f', '転送'],
          ['Shift + I', '既読にする'],
          ['Shift + U', '未読にする'],
          ['g → i', '受信トレイへ移動'],
          ['g → s', 'スター付きへ移動'],
          ['g → t', '送信済みへ移動'],
          ['g → d', '下書きへ移動'],
          ['g → a', 'すべてのメールへ移動'],
          ['?', 'このショートカット一覧を表示'],
          ['Esc', 'モーダル・メニューを閉じる'],
        ]
      : [
          ['c', 'Compose new email'],
          ['/', 'Focus search bar'],
          ['j / k', 'Next / previous thread'],
          ['Enter / o', 'Open conversation'],
          ['u', 'Back to thread list'],
          ['e', 'Archive'],
          ['#', 'Move to Trash'],
          ['!', 'Report spam'],
          ['s', 'Toggle star'],
          ['r', 'Reply'],
          ['a', 'Reply all'],
          ['f', 'Forward'],
          ['Shift + I', 'Mark as read'],
          ['Shift + U', 'Mark as unread'],
          ['g → i', 'Go to Inbox'],
          ['g → s', 'Go to Starred'],
          ['g → t', 'Go to Sent'],
          ['g → d', 'Go to Drafts'],
          ['g → a', 'Go to All Mail'],
          ['?', 'Show shortcuts help'],
          ['Esc', 'Close dialog / menu'],
        ];

  return `
    <div class="modal-backdrop" data-action="close-modal-backdrop" role="presentation">
      <div class="modal-card wide" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div class="modal-header">
          <h2 id="shortcuts-title">${escapeHtml(store.tr('shortcutsTitle'))}</h2>
          <button type="button" class="icon-btn" aria-label="${escapeHtml(store.tr('close'))}" data-action="close-shortcuts-modal">${icons.close}</button>
        </div>
        <div class="modal-body">
          <div class="shortcut-grid">
            ${rows
              .map(
                ([key, desc]) => `
              <div class="shortcut-row">
                <span>${escapeHtml(desc)}</span>
                <kbd>${escapeHtml(key)}</kbd>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-primary" data-action="close-shortcuts-modal">${escapeHtml(store.tr('close'))}</button>
        </div>
      </div>
    </div>
  `;
}

const LABEL_COLORS: Array<{ hex: string; ja: string; en: string }> = [
  { hex: '#1a73e8', ja: 'ブルー', en: 'Blue' },
  { hex: '#188038', ja: 'グリーン', en: 'Green' },
  { hex: '#d93025', ja: 'レッド', en: 'Red' },
  { hex: '#b05a00', ja: 'オレンジ', en: 'Orange' },
  { hex: '#007b83', ja: 'ティール', en: 'Teal' },
  { hex: '#3f51b5', ja: 'インディゴ', en: 'Indigo' },
  { hex: '#9c4d00', ja: 'アンバー', en: 'Amber' },
  { hex: '#5f6368', ja: 'スレート', en: 'Slate' },
];

export function renderNewLabelModal(store: MailStore, isOpen: boolean): string {
  if (!isOpen) return '';
  const loc = store.settings.locale;
  return `
    <div class="modal-backdrop" data-action="close-modal-backdrop" role="presentation">
      <div class="modal-card" style="max-width:420px;" role="dialog" aria-modal="true" aria-labelledby="new-label-title">
        <div class="modal-header">
          <h2 id="new-label-title">${escapeHtml(store.tr('newLabel'))}</h2>
          <button type="button" class="icon-btn" aria-label="${escapeHtml(store.tr('close'))}" data-action="close-new-label">${icons.close}</button>
        </div>
        <form id="new-label-form" class="modal-body">
          <div class="form-group">
            <label for="new-label-name">${loc === 'ja' ? 'ラベル名' : 'Label name'}</label>
            <input id="new-label-name" name="name" class="field-input" type="text" required maxlength="32" placeholder="${loc === 'ja' ? '例: 重要クライアント' : 'e.g. Important Clients'}" />
          </div>
          <fieldset class="color-radio-fieldset">
            <legend>${loc === 'ja' ? 'カラー' : 'Color'}</legend>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              ${LABEL_COLORS.map(
                (color, i) => `
                <label class="color-radio-option">
                  <input type="radio" name="color" value="${color.hex}" ${i === 0 ? 'checked' : ''} aria-label="${loc === 'ja' ? color.ja : color.en}" />
                  <span class="label-dot" aria-hidden="true" style="background:${color.hex};width:18px;height:18px;"></span>
                  <span class="sr-only">${loc === 'ja' ? color.ja : color.en}</span>
                </label>
              `,
              ).join('')}
            </div>
          </fieldset>
          <div class="modal-footer" style="margin:6px -20px -18px;">
            <button type="button" class="btn" data-action="close-new-label">${escapeHtml(store.tr('cancel'))}</button>
            <button type="submit" class="btn btn-primary">${escapeHtml(store.tr('save'))}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}
