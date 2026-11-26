import { App, Modal, Notice } from 'obsidian';
import { t } from '../i18n/index';
import { renderChangedRegion, type VaultChange } from '../core/change-tracker';

/**
 * Post-run review of every Markdown file the agent changed.
 *
 * Each file has its own undo button; "Undo all" is explicit, never automatic.
 * The modal is intentionally read-only until a button is pressed — the run has
 * already happened, and accidentally reverting user edits would be worse than
 * leaving a change in place.
 */
export class ChangeReviewModal extends Modal {
  private busy = false;

  constructor(
    app: App,
    private readonly changes: VaultChange[],
    private readonly incomplete: boolean,
    private readonly onUndo: (change: VaultChange) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: t('change.title') });
    contentEl.createEl('p', { text: t('change.desc'), cls: 'dsh-modal-desc' });
    if (this.incomplete) {
      contentEl.createEl('p', { text: t('change.incomplete'), cls: 'dsh-modal-warning' });
    }

    const list = contentEl.createDiv({ cls: 'dsh-change-list' });
    for (const change of this.changes) {
      const row = list.createDiv({ cls: 'dsh-change' });
      const header = row.createDiv({ cls: 'dsh-change-header' });
      header.createSpan({ text: change.path, cls: 'dsh-change-path' });
      header.createSpan({
        text: t(change.before === null ? 'change.created'
          : change.after === null ? 'change.deleted' : 'change.modified'),
        cls: 'dsh-change-badge',
      });
      row.createEl('pre', {
        text: renderChangedRegion(change.before, change.after),
        cls: 'dsh-change-diff',
      });
      const undo = row.createEl('button', { text: t('change.undo') });
      undo.onclick = () => {
        void this.undoOne(change);
      };
    }

    const buttons = contentEl.createDiv({ cls: 'dsh-modal-buttons' });
    const undoAll = buttons.createEl('button', { text: t('change.undoAll') });
    undoAll.onclick = () => {
      void (async () => {
        for (const change of this.changes) {
          if (!(await this.undoOne(change))) return;
        }
        this.close();
      })();
    };
    const close = buttons.createEl('button', { text: t('change.close'), cls: 'mod-cta' });
    close.onclick = () => this.close();
  }

  /**
   * Refuse to undo when the file no longer matches the post-run text: the user
   * may have edited it while the review modal was open, and overwriting that
   * edit would be a silent data loss.
   */
  private async stillMatches(change: VaultChange): Promise<boolean> {
    const adapter = this.app?.vault?.adapter;
    if (!adapter) return true;
    try {
      if (change.after === null) {
        if (typeof adapter.stat !== 'function') return true;
        return (await adapter.stat(change.path)) === null;
      }
      if (typeof adapter.read !== 'function') return true;
      return (await adapter.read(change.path)) === change.after;
    } catch {
      return false;
    }
  }

  /** Returns false when an undo failed, so "Undo all" stops at the first error. */
  private async undoOne(change: VaultChange): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      if (!(await this.stillMatches(change))) {
        new Notice(t('change.changedSinceRun', { path: change.path }), 8000);
        return false;
      }
      await this.onUndo(change);
      new Notice(t('change.undone', { path: change.path }));
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      new Notice(t('change.undoFailed', { path: change.path, message }), 8000);
      return false;
    } finally {
      this.busy = false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
