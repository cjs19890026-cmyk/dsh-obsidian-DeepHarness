/**
 * /skill completion for the chat composer — the sibling of the @mention
 * popup. Typing "/" at a word boundary opens a floating list of installed
 * DSH skills (from the same roots the 🔧 panel scans); the list filters live
 * by name / description. Selecting an entry replaces the "/query" token with
 * the literal "/name " text — DSH's own pre-step boundary recognizes the
 * whitespace-bounded `/name` token and injects the skill's full
 * <skill_content> for that run, so the plugin only has to insert text.
 */
import { App, setIcon } from 'obsidian';
import { t } from '../i18n/index';
import { filterSkillEntries, SkillEntry } from '../core/skills';
import type { SuggestHost } from './chip-editor';

/** Cap on how many matches are rendered at once. */
const MAX_RESULTS = 50;

export interface SkillSuggestOptions {
  /** Lazily returns the skill catalog (rebuilt on popup open). */
  getSkills: () => SkillEntry[];
  /** Returns the toolbar button the popup anchors to (same spot as the
   *  mention / history panels). */
  getAnchor: () => HTMLElement;
}

export class SkillSuggest {
  private popup: HTMLElement | null = null;
  private index: SkillEntry[] = [];
  private filtered: SkillEntry[] = [];
  private query = '';
  private selected = 0;
  private tokenStart = -1;

  private readonly onInput: () => void;

  constructor(
    private readonly app: App,
    private readonly host: SuggestHost,
    private readonly options: SkillSuggestOptions,
  ) {
    this.onInput = () => this.handleInput();
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
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      this.close();
      return false;
    }
    return false;
  }

  // ── parsing & filtering ──────────────────────────────

  private handleInput(): void {
    const token = this.parseToken();
    if (!token) {
      this.close();
      return;
    }
    this.query = token.query;
    this.tokenStart = token.tokenStart;
    if (!this.popup) {
      this.index = this.options.getSkills();
    }
    this.filtered = filterSkillEntries(this.index, this.query, MAX_RESULTS);
    this.selected = 0;
    if (this.popup) this.render();
    else this.open();
  }

  /**
   * Parse the "/query" token immediately before the caret. "/" must sit at
   * line start or after whitespace (so paths like "Harness/memory.md" or
   * URLs never trigger); the query stops at whitespace or another "/".
   */
  private parseToken(): { query: string; tokenStart: number } | null {
    const text = this.host.textBeforeCaret();
    const m = text.match(/(?:^|\s)\/([^\s/]*)$/);
    if (!m || m.index === undefined) return null;
    return { query: m[1], tokenStart: m.index + m[0].indexOf('/') };
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
      const text = this.index.length === 0
        ? t('chat.skillEmpty')
        : t('chat.skillNoMatch');
      popup.createDiv({ cls: 'dsh-mention-empty', text });
    } else {
      for (let i = 0; i < this.filtered.length; i++) {
        const item = this.filtered[i];
        const row = popup.createDiv({
          cls: `dsh-mention-item${i === this.selected ? ' is-selected' : ''}`,
        });
        const icon = row.createSpan({ cls: 'dsh-mention-icon' });
        setIcon(icon, 'wrench');
        row.createSpan({ cls: 'dsh-mention-title', text: item.name });
        row.createSpan({ cls: 'dsh-skill-suggest-desc', text: item.description });
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

  /** Replace the "/query" token with "/name " and move the caret after it. */
  private select(index: number): void {
    const item = this.filtered[index];
    if (!item) return;
    const ref = `/${item.name} `;
    this.host.replaceRange(this.tokenStart, ref);
    this.host.focus();
    this.close();
  }

  private onOutside = (e: MouseEvent): void => {
    if (this.popup && !this.popup.contains(e.target as Node)) {
      this.close();
    }
  };

  // ── positioning (anchored to the toolbar button, like the other panels) ─

  private positionPopup(): void {
    const popup = this.popup;
    if (!popup) return;
    const anchor = this.options.getAnchor();
    if (!anchor || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    popup.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  }
}
