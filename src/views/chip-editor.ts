/**
 * Rich composer input for the chat view.
 *
 * The composer used to be a plain <textarea>; note references (from the
 * reference "<" button or the "@" mention) were inserted as long [[path]]
 * wikilink text. This editor keeps the same plain-text model internally but
 * renders those wikilinks as clickable "chips" (pill tags) showing only the
 * note's title. Clicking a chip opens the note (internal link); sending
 * serializes chips back to [[path]] so the DSH agent still receives the full
 * vault-relative path.
 *
 * Serialization contract (getText ⇄ renderText are inverses):
 *   - text nodes  → their text (newlines preserved via pre-wrap)
 *   - .dsh-chip   → [[data-path]]
 *   - <br>        → "\n"
 *
 * The class doubles as the SuggestHost for the @mention and /skill popups:
 * they parse tokens from `textBeforeCaret()` (same serialization, so offsets
 * agree with getText()) and commit selections through `replaceRange()`.
 */
import { App } from 'obsidian';

/** Minimal surface the @mention and /skill suggestors need from the editor. */
export interface SuggestHost {
  /** The contenteditable element (event binding + focus). */
  el: HTMLElement;
  /** Full serialized text (chips as [[path]]). */
  getText(): string;
  /** Serialized text before the caret (for token parsing). */
  textBeforeCaret(): string;
  /** Replace the serialized range [from, caret] with `replacement`, re-render
   *  chips, and place the caret right after the inserted text. */
  replaceRange(from: number, replacement: string): void;
  focus(): void;
}

export interface ChipEditorOptions {
  placeholder: string;
}

/** Display title of a note path: the last path segment. */
export function chipTitle(path: string): string {
  return path.split('/').pop() || path;
}

export class ChipEditor implements SuggestHost {
  readonly el: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly app: App,
    opts: ChipEditorOptions,
  ) {
    this.el = container.createDiv({ cls: 'dsh-input dsh-chip-input' });
    this.el.setAttribute('contenteditable', 'true');
    this.el.setAttribute('data-placeholder', opts.placeholder);
    this.el.setAttribute('spellcheck', 'true');
    this.el.addEventListener('input', () => this.updatePlaceholder());
    this.el.addEventListener('keydown', this.onKeydown);
    this.el.addEventListener('paste', this.onPaste);
    this.el.addEventListener('mousedown', this.onMousedown);
    this.el.addEventListener('click', this.onClick);
    this.updatePlaceholder();
  }

  // ── serialization ────────────────────────────────────

  getText(): string {
    let out = '';
    for (const child of Array.from(this.el.childNodes)) {
      out += this.serializeNode(child);
    }
    return out;
  }

  private serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return (node as Text).data;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList.contains('dsh-chip')) return `[[${el.dataset.path ?? ''}]]`;
      if (el.tagName === 'BR') return '\n';
      let out = '';
      for (const child of Array.from(el.childNodes)) out += this.serializeNode(child);
      return out;
    }
    return '';
  }

  /** Serialized text before the caret (for mention / skill token parsing). */
  textBeforeCaret(): string {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return this.getText();
    const range = sel.getRangeAt(0);
    if (!this.el.contains(range.startContainer)) return this.getText();
    return this.serializePartial(this.el, range.startContainer, range.startOffset);
  }

  /** Serialize the content of `parent` up to (not including) the end point. */
  private serializePartial(parent: Node, endNode: Node, endOffset: number): string {
    let out = '';
    const visit = (n: Node): boolean => {
      if (n === endNode) {
        if (n.nodeType === Node.TEXT_NODE) {
          out += (n as Text).data.slice(0, endOffset);
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          const count = Math.min(endOffset, n.childNodes.length);
          for (let i = 0; i < count; i++) {
            if (visit(n.childNodes[i])) return true;
          }
        }
        return true;
      }
      if (n.nodeType === Node.TEXT_NODE) { out += (n as Text).data; return false; }
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as HTMLElement;
        if (el.classList.contains('dsh-chip')) { out += `[[${el.dataset.path ?? ''}]]`; return false; }
        if (el.tagName === 'BR') { out += '\n'; return false; }
        for (const child of Array.from(el.childNodes)) {
          if (visit(child)) return true;
        }
      }
      return false;
    };
    visit(parent);
    return out;
  }

  // ── mutations ────────────────────────────────────────

  /**
   * Replace the serialized range [from, caret] with `replacement`, re-render
   * the whole content (wikilinks become chips), place the caret after the
   * inserted text, and focus the editor.
   */
  replaceRange(from: number, replacement: string): void {
    const full = this.getText();
    const caret = this.textBeforeCaret().length;
    const next = full.slice(0, from) + replacement + full.slice(caret);
    this.renderText(next, from + replacement.length);
  }

  /** Insert plain text at the caret, adding single spaces around it so it
   *  never glues to neighbouring content (same policy as the old textarea). */
  insertTextWithSpacing(text: string): void {
    const full = this.getText();
    const caret = this.textBeforeCaret().length;
    const before = full.slice(0, caret);
    const after = full.slice(caret);
    const needSpaceBefore = before.length > 0 && !/\s$/.test(before);
    const needSpaceAfter = after.length > 0 && !/^\s/.test(after);
    const insert = (needSpaceBefore ? ' ' : '') + text + (needSpaceAfter ? ' ' : '');
    this.replaceRange(caret, insert);
  }

  /** Replace the whole content with plain text (no chips). */
  setText(text: string): void {
    this.renderText(text);
  }

  clear(): void {
    this.setText('');
  }

  focus(): void {
    this.el.focus();
  }

  /**
   * Render serialized text into the editor: split on [[wikilink]] tokens,
   * render each as a chip, everything else as text nodes. Tracks the serialized
   * offset where the caret should land (right after a chip when the boundary
   * falls inside a chip's serialized length).
   */
  private renderText(text: string, caretOffset?: number): void {
    this.el.empty();
    const parts = text.split(/(\[\[[^\]]+\]\])/g);
    let acc = 0;
    let caretNode: Node | null = null;
    let caretInNode = 0;
    for (const part of parts) {
      if (!part) continue;
      const m = part.match(/^\[\[([^\]]+)\]\]$/);
      let node: Node;
      if (m) {
        const path = m[1].trim();
        const chip = createSpan({ cls: 'dsh-chip' });
        // Atomic unit: the caret can never enter the chip, typing never edits
        // its label, and clicks target the chip element itself. Without this,
        // Chromium lets the caret land inside the label span after insertion.
        chip.setAttribute('contenteditable', 'false');
        chip.createSpan({ cls: 'dsh-chip-label', text: chipTitle(path) });
        chip.dataset.path = path;
        chip.setAttribute('title', path);
        node = chip;
      } else {
        node = document.createTextNode(part);
      }
      this.el.appendChild(node);
      const len = node.nodeType === Node.TEXT_NODE
        ? (node as Text).data.length
        : ((node as HTMLElement).dataset.path ?? '').length + 2;
      if (caretOffset !== undefined && caretNode === null && acc + len >= caretOffset) {
        if (node.nodeType === Node.TEXT_NODE) {
          caretNode = node;
          caretInNode = Math.min(caretOffset - acc, (node as Text).data.length);
        } else {
          // Caret boundary inside a chip → land right after it.
          caretNode = node;
          caretInNode = -1;
        }
      }
      acc += len;
    }
    this.placeCaret(caretNode, caretInNode);
    this.updatePlaceholder();
  }

  /**
   * Put the caret at the rendered position (or the end by default).
   * Focus FIRST, then set the selection: calling focus() after addRange lets
   * Chromium re-place the caret (it can land inside an inline chip) when the
   * editor was not focused yet.
   */
  private placeCaret(node: Node | null, inNode: number): void {
    this.el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    if (node && (node as HTMLElement).classList?.contains('dsh-chip')) {
      range.setStartAfter(node);
    } else if (node && node.nodeType === Node.TEXT_NODE) {
      range.setStart(node, inNode);
    } else {
      const target = node ?? this.el;
      range.setStart(target, target.childNodes.length);
    }
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  // ── events ───────────────────────────────────────────

  /** Backspace right after a chip removes the whole chip. */
  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Backspace') return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return; // let the default delete the selection
    const node = range.startContainer;
    const offset = range.startOffset;
    if (node.nodeType === Node.TEXT_NODE && offset === 0) {
      const prev = node.previousSibling;
      if (prev && (prev as HTMLElement).classList?.contains('dsh-chip')) {
        e.preventDefault();
        prev.remove();
        this.updatePlaceholder();
      }
    }
  };

  /** Paste as plain text so HTML never pollutes the serialization. */
  private onPaste = (e: ClipboardEvent): void => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    const caret = this.textBeforeCaret().length;
    this.replaceRange(caret, text);
  };

  /**
   * Mousedown on a chip: never place the caret inside the chip, and open the
   * note. Navigation happens here (not on click) because preventDefault on
   * mousedown suppresses the subsequent click event in Chromium.
   */
  private onMousedown = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const chip = target.closest<HTMLElement>('.dsh-chip');
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    const path = chip.dataset.path;
    if (path) void this.app.workspace.openLinkText(path, '');
  };

  /** Clicking a chip opens the note (internal link). */
  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const chip = target.closest<HTMLElement>('.dsh-chip');
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
  };

  /** Placeholder visibility: only when there is no text and no chips. */
  private updatePlaceholder(): void {
    this.el.toggleClass('is-empty', this.getText().trim().length === 0);
  }
}
