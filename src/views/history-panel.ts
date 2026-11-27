import { Notice, setIcon } from 'obsidian';
import { t, type TranslationKey } from '../i18n/index';
import { FloatingPanel } from './floating-panel';
import type { HistoryRunStatus, SessionRecord } from '../core/history';
import type { ChatView } from './chat-view';

type HistoryRange = 'all' | '7d' | '30d';

/**
 * Session history popup, anchored under the history toolbar icon.
 *
 * Extracted from chat-view.ts (review C-1): the floating/anchor/dismiss
 * mechanics live in FloatingPanel, this file owns only what a row looks like
 * and what its buttons do.
 *
 * F3 adds an audit view: rows can expand into per-turn status, duration, tool
 * calls and changed files, and the whole session can be copied as a compact
 * markdown summary. Filtering is client-side; the history store stays the
 * source of truth.
 */
export class HistoryPanel extends FloatingPanel {
  private query = '';
  private range: HistoryRange = 'all';

  constructor(private readonly view: ChatView, anchorEl: HTMLElement) {
    super(anchorEl, '', (panel) => this.renderList(panel));
  }

  private renderList(panel: HTMLElement): void {
    const sessions = this.view.plugin.history?.getSessions() ?? [];
    if (sessions.length === 0) {
      panel.createDiv({ cls: 'dsh-history-empty', text: t('chat.historyEmpty') });
      return;
    }

    const controls = panel.createDiv({ cls: 'dsh-history-controls' });
    const filter = controls.createEl('input', {
      cls: 'dsh-history-filter',
      type: 'search',
      placeholder: t('history.filterPlaceholder'),
    });
    filter.value = this.query;

    const range = controls.createEl('select', { cls: 'dsh-history-range' });
    const ranges: Array<[HistoryRange, TranslationKey]> = [
      ['all', 'history.rangeAll'],
      ['7d', 'history.range7'],
      ['30d', 'history.range30'],
    ];
    for (const [value, label] of ranges) {
      range.createEl('option', { value, text: t(label) });
    }
    range.value = this.range;

    const list = panel.createDiv({ cls: 'dsh-history-list' });
    const rows: Array<{ el: HTMLElement; session: SessionRecord }> = [];
    for (const s of sessions) {
      rows.push({ el: this.renderSession(list, s), session: s });
    }
    const noMatches = panel.createDiv({ cls: 'dsh-history-empty hidden', text: t('history.noMatches') });

    const apply = (): void => {
      let visible = 0;
      for (const row of rows) {
        const show = this.matches(row.session);
        row.el.classList.toggle('hidden', !show);
        if (show) visible += 1;
      }
      noMatches.classList.toggle('hidden', visible > 0);
    };
    filter.addEventListener('input', () => {
      this.query = filter.value;
      apply();
    });
    range.addEventListener('change', () => {
      this.range = range.value as HistoryRange;
      apply();
    });
    apply();
  }

  private renderSession(panel: HTMLElement, s: SessionRecord): HTMLElement {
    const item = panel.createDiv({
      cls: `dsh-history-panel-item${s.pinned ? ' is-pinned' : ''}`,
    });

    // Row 1: bubble icon + title + (details / rename / pin / delete) icons
    const row1 = item.createDiv({ cls: 'dsh-history-row1' });
    const bubble = row1.createSpan({ cls: 'dsh-history-bubble' });
    setIcon(bubble, 'message-circle');
    const title = row1.createSpan({ cls: 'dsh-history-panel-title', text: s.title });

    const detailsBtn = row1.createEl('button', { cls: 'dsh-history-details-toggle' });
    setIcon(detailsBtn, 'chevron-right');
    detailsBtn.setAttribute('aria-label', t('history.details'));
    detailsBtn.title = t('history.details');

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

    // Expandable audit details. Clicking anywhere in here must not resume the
    // session as a side effect of selecting text or pressing a button.
    const details = this.renderDetails(item, s);
    details.classList.add('hidden');
    details.onclick = (e) => e.stopPropagation();
    detailsBtn.onclick = (e) => {
      e.stopPropagation();
      const expanded = details.classList.toggle('hidden');
      setIcon(detailsBtn, expanded ? 'chevron-right' : 'chevron-down');
    };

    // Click the item anywhere else → resume the session
    item.onclick = () => {
      this.close();
      void this.view.resumeSession(s);
    };
    return item;
  }

  private renderDetails(item: HTMLElement, s: SessionRecord): HTMLElement {
    const details = item.createDiv({ cls: 'dsh-history-details' });
    const turns = s.turns ?? [];
    const toolCount = turns.reduce((n, turn) => n + (turn.tools?.length ?? 0), 0);
    const fileCount = new Set(turns.flatMap((turn) => turn.changedFiles ?? [])).size;
    const totalMs = turns.reduce((n, turn) => n + (turn.durationMs || 0), 0);

    const stats = details.createDiv({ cls: 'dsh-history-stats' });
    stats.createSpan({ text: t('history.turns', { count: turns.length }) });
    stats.createSpan({ text: `${(totalMs / 1000).toFixed(1)}s` });
    if (toolCount > 0) stats.createSpan({ text: t('history.tools', { count: toolCount }) });
    if (fileCount > 0) stats.createSpan({ text: t('history.files', { count: fileCount }) });

    if (turns.length === 0) {
      details.createDiv({ cls: 'dsh-history-turn-empty', text: t('chat.historyEmpty') });
    }
    for (const turn of turns) {
      const turnEl = details.createDiv({ cls: 'dsh-history-turn' });
      const head = turnEl.createDiv({ cls: 'dsh-history-turn-head' });
      const status = turn.status ?? 'succeeded';
      head.createSpan({
        cls: `dsh-history-status is-${status}`,
        text: this.statusLabel(status),
      });
      head.createSpan({
        cls: 'dsh-history-turn-user',
        text: turn.user.length > 80 ? `${turn.user.slice(0, 80)}…` : turn.user,
      });
      head.createSpan({
        cls: 'dsh-history-turn-meta',
        text: `${(turn.durationMs / 1000).toFixed(1)}s`,
      });
      if (turn.tools?.length) {
        turnEl.createDiv({
          cls: 'dsh-history-turn-line',
          text: `${t('history.tools', { count: turn.tools.length })}: ${turn.tools.map((tool) => tool.name).join(', ')}`,
        });
      }
      if (turn.changedFiles?.length) {
        turnEl.createDiv({
          cls: 'dsh-history-turn-line',
          text: `${t('history.files', { count: turn.changedFiles.length })}: ${turn.changedFiles.join(', ')}`,
        });
      }
      if (turn.error) {
        turnEl.createDiv({
          cls: 'dsh-history-turn-error',
          text: t('history.error', { message: turn.error }),
        });
      }
    }

    const copy = details.createEl('button', {
      cls: 'dsh-history-copy',
      text: t('history.copySummary'),
    });
    copy.onclick = (e) => {
      e.stopPropagation();
      this.copySummary(s);
    };
    return details;
  }

  private matches(s: SessionRecord): boolean {
    const query = this.query.trim().toLowerCase();
    if (query && !`${s.title} ${s.note ?? ''}`.toLowerCase().includes(query)) return false;
    if (this.range === 'all') return true;
    const days = this.range === '7d' ? 7 : 30;
    return s.endedAt >= Date.now() - days * 24 * 60 * 60 * 1000;
  }

  private statusLabel(status: HistoryRunStatus): string {
    return t(`history.status.${status}` as TranslationKey);
  }

  /** Copy a compact, human-readable audit of the session. */
  private copySummary(s: SessionRecord): void {
    const turns = s.turns ?? [];
    const lines: string[] = [
      `# ${s.title}`,
      new Date(s.endedAt).toLocaleString(),
      [s.model, s.effort, s.permission].filter(Boolean).join(' · '),
      '',
    ];
    turns.forEach((turn, index) => {
      const status = turn.status ?? 'succeeded';
      lines.push(`## ${index + 1}. ${this.statusLabel(status)} · ${(turn.durationMs / 1000).toFixed(1)}s`);
      lines.push(`User: ${turn.user.slice(0, 500)}`);
      if (turn.answer) lines.push(`Answer: ${turn.answer.slice(0, 500)}`);
      if (turn.tools?.length) {
        lines.push(`Tools: ${turn.tools.map((tool) => `${tool.name}${tool.ok ? '' : ' (failed)'}`).join(', ')}`);
      }
      if (turn.changedFiles?.length) lines.push(`Changed: ${turn.changedFiles.join(', ')}`);
      if (turn.error) lines.push(`Error: ${turn.error}`);
      lines.push('');
    });
    const text = lines.join('\n').trim();
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(text).then(() => {
      new Notice(t('history.copied'));
    }).catch(() => {
      // Clipboard permission can be denied; there is nothing useful to say.
    });
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
