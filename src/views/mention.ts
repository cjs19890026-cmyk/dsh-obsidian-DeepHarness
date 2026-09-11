/**
 * @mention suggestion for the chat composer.
 *
 * Typing "@" in the input box opens a floating list of vault notes; the list
 * filters live by title / path as you type. Selecting an entry replaces the
 * "@query" token with an Obsidian wikilink ([[path/to/Note]]) — the same
 * format the reference icon produces, so the DSH agent can resolve it with its
 * file tools. Modeled after claudian's @mention, without the SDK-side mention
 * expansion (the agent just sees the wikilink text).
 *
 * The composer is a plain <textarea>, so Obsidian's EditorSuggest (CodeMirror
 * only) does not apply — this is a hand-rolled popup following the same
 * pattern as the history panel: appended to document.body, anchored to the
 * top-toolbar button (bottom-right corner), dismissed on outside click / Esc
 * / token loss.
 */
import { App, TFile, setIcon } from 'obsidian';
import { t } from '../i18n/index';
import type { SuggestHost } from './chip-editor';

/** Cap on how many matches are rendered at once. */
const MAX_RESULTS = 50;

interface MentionItem {
  file: TFile;
  /** Basename without the .md extension (display title). */
  title: string;
  /** Vault-relative path, e.g. "Projects/Report.md". */
  path: string;
  /** Parent folder, '' for vault-root notes. */
  folder: string;
}

export interface MentionSuggestOptions {
  /** Returns the workdir scope ('' = whole vault). */
  getScope: () => string;
  /** Returns the toolbar button the popup anchors to (same spot as the
   *  history panel). */
  getAnchor: () => HTMLElement;
}

export class MentionSuggest {
  private popup: HTMLElement | null = null;
  private index: MentionItem[] = [];
  private filtered: MentionItem[] = [];
  private query = '';
  private selected = 0;
  private tokenStart = -1;

  private readonly onInput: () => void;

  constructor(
    private readonly app: App,
    private readonly host: SuggestHost,
    private readonly options: MentionSuggestOptions,
  ) {
    this.onInput = () => this.handleInput();
    // 'input' fires on typing; 'click' covers caret moves that change the
    // token context without changing the value.
    this.host.el.addEventListener('input', this.onInput);
    this.host.el.addEventListener('click', this.onInput);
  }

  /** Detach listeners and remove the popup. Call on view close. */
  dispose(): void {
    this.close();
    this.host.el.removeEventListener('input', this.onInput);
    this.host.el.removeEventListener('click', this.onInput);
  }

  /**
   * Keydown hook for the composer. Returns true when the event was consumed
   * by the suggestion popup (navigation / select / dismiss).
   */
  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.popup) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.select(this.selected);
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return true; }
    // Caret left the token context (or is about to): dismiss the popup.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      this.close();
      return false;
    }
    return false;
  }

  /**
   * Programmatic trigger (toolbar @ button): insert "@" at the caret when not
   * already inside a mention token, then open the suggestion popup. Unlike
   * typed input, the button is an explicit intent, so the popup opens even
   * when the "@" sits right after a chip (where the token-boundary regex
   * would not match — the preceding char is "]").
   */
  trigger(): void {
    const text = this.host.textBeforeCaret();
    if (!/(?:^|\s)@([^\s@]*)$/.test(text)) {
      this.host.replaceRange(text.length, '@');
    }
    this.host.focus();
    // The "@" is now the last char at the caret; open with an empty query.
    this.openWithQuery('', this.host.textBeforeCaret().length - 1);
  }

  // ── parsing & filtering ──────────────────────────────

  private handleInput(): void {
    const token = this.parseToken();
    if (!token) {
      this.close();
      return;
    }
    this.openWithQuery(token.query, token.tokenStart);
  }

  /** Build the index lazily, filter, and open / refresh the popup. */
  private openWithQuery(query: string, tokenStart: number): void {
    this.query = query;
    this.tokenStart = tokenStart;
    if (!this.popup) {
      // Lazy index rebuild every time the popup opens (getMarkdownFiles is
      // fast even for thousands of notes; no event-based cache to maintain).
      this.index = this.buildIndex();
    }
    this.filtered = this.filter(this.query);
    this.selected = 0;
    if (this.popup) this.render();
    else this.open();
  }

  /** Parse the "@query" token immediately before the caret. */
  private parseToken(): { query: string; tokenStart: number } | null {
    const text = this.host.textBeforeCaret();
    const m = text.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m || m.index === undefined) return null;
    return { query: m[1], tokenStart: m.index + m[0].indexOf('@') };
  }

  /** All md notes under the workdir scope, sorted by path. */
  private buildIndex(): MentionItem[] {
    const scope = this.options.getScope().trim().replace(/^\/+|\/+$/g, '');
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => !scope || f.path.startsWith(scope + '/'))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({
        file: f,
        title: f.basename,
        path: f.path,
        folder: f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '',
      }));
  }

  /** Case-insensitive contains-match on title or path. */
  private filter(query: string): MentionItem[] {
    const q = query.toLowerCase();
    return this.index
      .filter((it) => it.title.toLowerCase().includes(q) || it.path.toLowerCase().includes(q))
      .slice(0, MAX_RESULTS);
  }

  // ── popup DOM & interaction ──────────────────────────

  private open(): void {
    const popup = createDiv({ cls: 'dsh-mention-popup' });
    document.body.appendChild(popup);
    this.popup = popup;
    document.addEventListener('mousedown', this.onOutside);
    this.render();
  }

  close(): void {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
    document.removeEventListener('mousedown', this.onOutside);
  }

  private render(): void {
    const popup = this.popup;
    if (!popup) return;
    popup.empty();
    if (this.filtered.length === 0) {
      popup.createDiv({ cls: 'dsh-mention-empty', text: t('chat.mentionNoMatch') });
    } else {
      for (let i = 0; i < this.filtered.length; i++) {
        const item = this.filtered[i];
        const row = popup.createDiv({
          cls: `dsh-mention-item${i === this.selected ? ' is-selected' : ''}`,
        });
        const icon = row.createSpan({ cls: 'dsh-mention-icon' });
        setIcon(icon, 'file-text');
        row.createSpan({ cls: 'dsh-mention-title', text: item.title });
        if (item.folder) row.createSpan({ cls: 'dsh-mention-path', text: item.folder });
        row.onmousemove = () => {
          this.selected = i;
          this.highlight();
        };
        row.onclick = () => this.select(i);
      }
    }
    this.positionPopup();
  }

  private move(delta: number): void {
    if (this.filtered.length === 0) return;
    this.selected = (this.selected + delta + this.filtered.length) % this.filtered.length;
    this.highlight();
  }

  private highlight(): void {
    const popup = this.popup;
    if (!popup) return;
    const rows = popup.querySelectorAll('.dsh-mention-item');
    rows.forEach((row, i) => row.classList.toggle('is-selected', i === this.selected));
    const current = rows[this.selected] as HTMLElement | undefined;
    if (current) current.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Replace the "@query" token with a wikilink — the chip editor renders it
   * as a clickable title tag — and move the caret after it.
   */
  private select(index: number): void {
    const item = this.filtered[index];
    if (!item) return;
    const ref = `[[${item.path.replace(/\.md$/, '')}]]`;
    this.host.replaceRange(this.tokenStart, ref);
    this.host.focus();
    this.close();
  }

  private onOutside = (e: MouseEvent): void => {
    if (this.popup && !this.popup.contains(e.target as Node)) {
      this.close();
    }
  };

  // ── positioning (anchored to the toolbar button, like the history panel) ─

  private positionPopup(): void {
    const popup = this.popup;
    if (!popup) return;
    const anchor = this.options.getAnchor();
    if (!anchor || !anchor.isConnected) return;
    // Same anchor logic as the history panel: the popup's bottom-right corner
    // sits against the button's top-left corner.
    const rect = anchor.getBoundingClientRect();
    popup.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  }
}
