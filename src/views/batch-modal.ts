import { Modal, Notice, setIcon, type App } from 'obsidian';
import { t } from '../i18n/index';
import type { BatchItem, BatchResult } from '../core/batch-controller';

/** Multi-select notes + one instruction. Notes are processed in path order. */
export class BatchNotesModal extends Modal {
  private selected = new Set<string>();
  private instruction = '';

  constructor(
    app: App,
    private readonly onSubmit: (paths: string[], instruction: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.addClass('dsh-batch-modal');
    this.titleEl.setText(t('batch.title'));
    this.contentEl.createDiv({ cls: 'dsh-modal-desc', text: t('batch.desc') });

    const toolbar = this.contentEl.createDiv({ cls: 'dsh-batch-toolbar' });
    const search = toolbar.createEl('input', {
      cls: 'dsh-batch-search',
      type: 'search',
      placeholder: t('history.filterPlaceholder'),
    });
    const all = toolbar.createEl('button', { cls: 'dsh-batch-link', text: t('batch.selectAll') });
    const none = toolbar.createEl('button', { cls: 'dsh-batch-link', text: t('batch.selectNone') });

    const list = this.contentEl.createDiv({ cls: 'dsh-batch-list' });
    const files = this.app.vault.getMarkdownFiles().slice().sort((a, b) => a.path.localeCompare(b.path));
    const rows: Array<{ el: HTMLElement; path: string }> = [];
    for (const file of files) {
      const row = list.createEl('label', { cls: 'dsh-batch-note' });
      const box = row.createEl('input');
      box.type = 'checkbox';
      row.createSpan({ text: file.path });
      box.addEventListener('change', () => {
        if (box.checked) this.selected.add(file.path);
        else this.selected.delete(file.path);
      });
      rows.push({ el: row, path: file.path });
    }
    if (files.length === 0) {
      list.createDiv({ cls: 'dsh-batch-empty', text: t('chat.historyEmpty') });
    }

    const applyFilter = (): void => {
      const q = search.value.trim().toLowerCase();
      for (const row of rows) row.el.classList.toggle('hidden', q.length > 0 && !row.path.toLowerCase().includes(q));
    };
    search.addEventListener('input', applyFilter);
    all.onclick = () => {
      for (const row of rows) {
        if (row.el.classList.contains('hidden')) continue;
        const box = row.el.querySelector('input') as HTMLInputElement;
        box.checked = true;
        this.selected.add(row.path);
      }
    };
    none.onclick = () => {
      for (const row of rows) {
        const box = row.el.querySelector('input') as HTMLInputElement;
        box.checked = false;
      }
      this.selected.clear();
    };

    const input = this.contentEl.createEl('textarea', {
      cls: 'dsh-batch-instruction',
      placeholder: t('batch.instructionPlaceholder'),
    });
    input.value = this.instruction;
    input.addEventListener('input', () => { this.instruction = input.value; });

    const actions = this.contentEl.createDiv({ cls: 'dsh-modal-actions' });
    const cancel = actions.createEl('button', { text: t('batch.cancel') });
    cancel.onclick = () => this.close();
    const start = actions.createEl('button', { cls: 'mod-cta', text: t('batch.start') });
    start.onclick = () => {
      if (this.selected.size === 0) {
        new Notice(t('batch.noSelection'));
        return;
      }
      if (!this.instruction.trim()) {
        new Notice(t('batch.noInstruction'));
        return;
      }
      const paths = [...this.selected].sort();
      this.close();
      this.onSubmit(paths, this.instruction.trim());
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Live per-item status; closing the dialog while running cancels the batch. */
export class BatchProgressModal extends Modal {
  private running = true;
  private listEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private cancelBtn!: HTMLButtonElement;
  private closeBtn!: HTMLButtonElement;

  constructor(
    app: App,
    private readonly onCancel: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.addClass('dsh-batch-modal');
    this.titleEl.setText(t('batch.title'));
    this.summaryEl = this.contentEl.createDiv({ cls: 'dsh-modal-desc', text: t('batch.running', { done: 0, total: 0 }) });
    this.listEl = this.contentEl.createDiv({ cls: 'dsh-batch-list' });
    const actions = this.contentEl.createDiv({ cls: 'dsh-modal-actions' });
    this.cancelBtn = actions.createEl('button', { text: t('batch.cancel') });
    this.cancelBtn.onclick = () => {
      this.onCancel();
      this.cancelBtn.disabled = true;
      this.cancelBtn.setText(t('batch.cancelled'));
    };
    this.closeBtn = actions.createEl('button', { cls: 'mod-cta', text: t('batch.close') });
    this.closeBtn.onclick = () => this.close();
    this.closeBtn.disabled = true;
  }

  update(items: BatchItem[]): void {
    const done = items.filter((item) => item.status !== 'pending' && item.status !== 'running').length;
    this.summaryEl.setText(t('batch.running', { done, total: items.length }));
    this.listEl.empty();
    for (const item of items) {
      const row = this.listEl.createDiv({ cls: `dsh-batch-row is-${item.status}` });
      const icon = row.createSpan({ cls: 'dsh-batch-icon' });
      setIcon(icon, iconFor(item.status));
      row.createSpan({ cls: 'dsh-batch-path', text: item.path });
      row.createSpan({ cls: 'dsh-batch-status', text: item.status });
      if (item.error) row.createDiv({ cls: 'dsh-batch-error', text: item.error });
    }
  }

  finish(result: BatchResult, changedFiles: number): void {
    this.running = false;
    this.cancelBtn.disabled = true;
    this.closeBtn.disabled = false;
    const ok = result.items.filter((item) => item.status === 'succeeded').length;
    const failed = result.items.length - ok;
    const suffix = changedFiles > 0 ? ` · ${t('history.files', { count: changedFiles })}` : '';
    this.summaryEl.setText(t('batch.done', { ok, failed }) + suffix);
    this.update(result.items);
    this.summaryEl.setText(t('batch.done', { ok, failed }) + suffix);
  }

  setError(message: string): void {
    this.running = false;
    this.cancelBtn.disabled = true;
    this.closeBtn.disabled = false;
    this.summaryEl.setText(message);
  }

  onClose(): void {
    if (this.running) this.onCancel();
    this.contentEl.empty();
  }
}

function iconFor(status: BatchItem['status']): string {
  switch (status) {
    case 'running': return 'loader-circle';
    case 'succeeded': return 'check';
    case 'failed': return 'x';
    case 'cancelled': return 'ban';
    default: return 'circle';
  }
}
