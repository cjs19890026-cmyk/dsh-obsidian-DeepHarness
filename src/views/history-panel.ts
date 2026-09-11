import { setIcon } from 'obsidian';
import { t } from '../i18n/index';
import { FloatingPanel } from './floating-panel';
import type { SessionRecord } from '../core/history';
import type { ChatView } from './chat-view';

/**
 * Session history popup, anchored under the history toolbar icon.
 *
 * Extracted from chat-view.ts (review C-1): the floating/anchor/dismiss
 * mechanics live in FloatingPanel, this file owns only what a row looks like
 * and what its buttons do.
 */
export class HistoryPanel extends FloatingPanel {
  constructor(private readonly view: ChatView, anchorEl: HTMLElement) {
    super(anchorEl, '', (panel) => this.renderList(panel));
  }

  private renderList(panel: HTMLElement): void {
    const sessions = this.view.plugin.history?.getSessions() ?? [];
    if (sessions.length === 0) {
      panel.createDiv({ cls: 'dsh-history-empty', text: t('chat.historyEmpty') });
      return;
    }
    for (const s of sessions) {
      const item = panel.createDiv({
        cls: `dsh-history-panel-item${s.pinned ? ' is-pinned' : ''}`,
      });

      // Row 1: bubble icon + title + (rename / pin / delete) icons
      const row1 = item.createDiv({ cls: 'dsh-history-row1' });
      const bubble = row1.createSpan({ cls: 'dsh-history-bubble' });
      setIcon(bubble, 'message-circle');
      const title = row1.createSpan({ cls: 'dsh-history-panel-title', text: s.title });

      const renameBtn = row1.createEl('button', { cls: 'dsh-history-act' });
      setIcon(renameBtn, 'pencil');
      renameBtn.setAttribute('aria-label', t('chat.rename'));
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        this.renameInPanel(title, s);
      };

      const pinBtn = row1.createEl('button', { cls: `dsh-history-act${s.pinned ? ' is-active' : ''}` });
      setIcon(pinBtn, 'pin');
      pinBtn.setAttribute('aria-label', s.pinned ? t('chat.unpin') : t('chat.pin'));
      pinBtn.onclick = (e) => {
        e.stopPropagation();
        void this.view.plugin.history?.togglePin(s.id).then(() => this.refresh());
      };

      const delBtn = row1.createEl('button', { cls: 'dsh-history-act' });
      setIcon(delBtn, 'x');
      delBtn.setAttribute('aria-label', t('chat.deleteSession'));
      delBtn.onclick = (e) => {
        e.stopPropagation();
        void this.view.plugin.history?.removeSession(s.id).then(() => this.refresh());
      };

      // Row 2: date + editable note
      const row2 = item.createDiv({ cls: 'dsh-history-row2' });
      row2.createSpan({ cls: 'dsh-history-date', text: new Date(s.endedAt).toLocaleString() });
      const note = row2.createSpan({ cls: 'dsh-history-note', text: s.note || t('chat.addNote') });
      note.onclick = (e) => {
        e.stopPropagation();
        this.editNoteInPanel(note, s);
      };

      // Click the item anywhere (not on a button) → resume the session
      item.onclick = () => {
        this.close();
        void this.view.resumeSession(s);
      };
    }
  }

  /** Inline rename of a session title inside the panel. */
  private renameInPanel(titleEl: HTMLElement, s: SessionRecord): void {
    const input = createEl('input', { cls: 'dsh-history-rename-input' });
    input.value = s.title;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = (): void => {
      const v = input.value.trim();
      if (v) void this.view.plugin.history?.renameSession(s.id, v);
      this.refresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { this.refresh(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  /** Inline note editing inside the panel. */
  private editNoteInPanel(noteEl: HTMLElement, s: SessionRecord): void {
    const input = createEl('input', { cls: 'dsh-history-note-input' });
    input.value = s.note || '';
    input.placeholder = t('chat.addNote');
    noteEl.replaceWith(input);
    input.focus();
    const commit = (): void => {
      void this.view.plugin.history?.setNote(s.id, input.value);
      this.refresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { this.refresh(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());
  }
}
