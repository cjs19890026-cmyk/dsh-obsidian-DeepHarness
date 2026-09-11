/**
 * Shared mechanics for the chat view's floating panels (history, skills).
 *
 * Both panels were ~240 lines of near-identical boilerplate inside
 * chat-view.ts: create the same shell, anchor it under its toolbar icon,
 * dismiss on an outside click or Escape, and close the other one when opening
 * (review C-1). That mechanism lives here; each panel only renders its own
 * contents.
 *
 * Behaviour preserved on purpose: same DOM shape, same anchoring geometry,
 * same deferred outside-click registration (so the click that opened the
 * panel does not immediately close it), same Escape handling.
 *
 * One deliberate improvement: the window used for positioning and listeners
 * comes from the anchor's own document. The panels used to read the ambient
 * `window`/`document`, which is wrong in an Obsidian popout window — the panel
 * would be measured against the main window. Nothing changes where there is no
 * popout.
 */
export class FloatingPanel {
  private panelEl: HTMLElement | null = null;
  /** Every open panel, so exactly one can be open at a time. */
  private static active = new Set<FloatingPanel>();

  constructor(
    private readonly anchorEl: HTMLElement,
    /** Extra class(es) appended to the shared panel shell class. */
    private readonly extraClass: string,
    /** Fill `panel` with this panel's contents. */
    private readonly render: (panel: HTMLElement) => void,
  ) {}

  get isOpen(): boolean {
    return this.panelEl !== null;
  }

  /** Toggle from the toolbar icon. */
  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Rebuild in place; no-op when closed. Used to re-render after a locale
   *  change or a settings/state change while the panel is visible. */
  refresh(): void {
    if (this.isOpen) this.open();
  }

  open(): void {
    this.close();
    FloatingPanel.closeAll();
    const panel = createDiv({
      cls: this.extraClass ? `dsh-history-panel ${this.extraClass}` : 'dsh-history-panel',
    });
    const doc = panel.ownerDocument;
    this.panelEl = panel;
    this.render(panel);
    doc.body.appendChild(panel);
    // Position before the first paint so the panel never flashes at 0,0;
    // the previous code always positioned immediately after appending.
    this.position(panel);
    FloatingPanel.active.add(this);
    this.listen(panel, doc);
  }

  close(): void {
    const panel = this.panelEl;
    if (panel) {
      const doc = panel.ownerDocument;
      doc.removeEventListener('mousedown', this.onOutside);
      doc.removeEventListener('keydown', this.onKeydown);
      panel.remove();
      this.panelEl = null;
    }
    FloatingPanel.active.delete(this);
  }

  /** Close every open panel (view teardown, Escape). */
  static closeAll(): void {
    for (const panel of [...FloatingPanel.active]) panel.close();
  }

  /**
   * Bottom-right corner against the toolbar icon, clamped to the window edge.
   */
  private position(panel: HTMLElement): void {
    const win = this.win();
    const rect = this.anchorEl.getBoundingClientRect();
    panel.style.right = `${Math.max(8, win.innerWidth - rect.right)}px`;
    panel.style.bottom = `${win.innerHeight - rect.top + 4}px`;
  }

  private listen(panel: HTMLElement, doc: Document): void {
    const win = this.win();
    // Deferred: the click that opened the panel is still propagating, so an
    // immediately registered handler would close it again.
    win.setTimeout(() => {
      if (this.panelEl === panel) doc.addEventListener('mousedown', this.onOutside);
    }, 0);
    doc.addEventListener('keydown', this.onKeydown);
  }

  /**
   * Dismiss on a click outside. The anchor is exempt so clicking the icon
   * toggles the panel through the normal click path instead of this handler
   * fighting it; so is any other panel's anchor, so switching between two
   * panels stays a clean toggle.
   */
  private onOutside = (e: MouseEvent): void => {
    const panel = this.panelEl;
    if (!panel) return;
    const target = e.target as Node | null;
    if (target && panel.contains(target)) return;
    if (target && this.isAnchor(target)) return;
    this.close();
  };

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close();
  };

  /** The icon fires this from a child element (its SVG), so containment, not
   *  equality, is the right test. */
  private isAnchor(target: Node): boolean {
    if (this.anchorEl.contains(target)) return true;
    return [...FloatingPanel.active].some(
      (panel) => panel !== this && panel.anchorEl.contains(target),
    );
  }

  /**
   * The window this panel belongs to: the anchor's own document's view, so a
   * panel opened in a popout window is measured against that window instead of
   * the main one.
   */
  private win(): Window {
    return this.anchorEl.ownerDocument.defaultView ?? window;
  }
}
