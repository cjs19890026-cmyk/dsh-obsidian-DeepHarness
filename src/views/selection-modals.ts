import { App, Modal, Notice } from 'obsidian';
import { t } from '../i18n/index';

/** Actions offered by the selection command. Kept in one place so the prompt
 *  builder, the command and tests cannot drift apart. */
export type SelectionAction = 'rewrite' | 'summarize' | 'explain' | 'custom';

export type SelectionApplyMode = 'replace' | 'insert';

/**
 * Pick what to do with the current editor selection.
 *
 * The modal deliberately does not run the agent itself: the plugin captures
 * the editor range first, then this returns the chosen action. That keeps the
 * async run (and the preview) out of the modal lifecycle, which Obsidian tears
 * down as soon as a choice is made.
 */
export class SelectionActionModal extends Modal {
  constructor(
    app: App,
    private readonly onChoose: (action: SelectionAction, instruction?: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: t('selection.title') });
    contentEl.createEl('p', { text: t('selection.desc'), cls: 'dsh-modal-desc' });

    const actions = contentEl.createDiv({ cls: 'dsh-selection-actions' });
    const add = (action: SelectionAction, label: string, cta = false): void => {
      const btn = actions.createEl('button', {
        text: label,
        cls: cta ? 'mod-cta' : undefined,
      });
      btn.onclick = () => {
        this.onChoose(action);
        this.close();
      };
    };
    add('rewrite', t('selection.rewrite'), true);
    add('summarize', t('selection.summarize'));
    add('explain', t('selection.explain'));

    const custom = contentEl.createDiv({ cls: 'dsh-selection-custom' });
    custom.createEl('label', { text: t('selection.custom'), cls: 'dsh-selection-label' });
    const input = custom.createEl('input', {
      type: 'text',
      placeholder: t('selection.customPlaceholder'),
    });
    const customBtn = custom.createEl('button', { text: t('selection.custom') });
    customBtn.onclick = () => {
      const instruction = input.value.trim();
      if (!instruction) {
        new Notice(t('selection.customPlaceholder'));
        return;
      }
      this.onChoose('custom', instruction);
      this.close();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        customBtn.click();
      }
    });
    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Review the agent's result before touching the note.
 *
 * "Replace" and "Insert below" are separate on purpose: a summary or an
 * explanation usually belongs below the selection, while a rewrite replaces
 * it. Neither happens until this button is pressed.
 */
export class SelectionPreviewModal extends Modal {
  constructor(
    app: App,
    private readonly original: string,
    private readonly result: string,
    private readonly onApply: (replacement: string, mode: SelectionApplyMode) => boolean,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: t('selection.previewTitle') });

    contentEl.createDiv({ text: t('selection.original'), cls: 'dsh-selection-label' });
    contentEl.createEl('pre', { text: this.original, cls: 'dsh-selection-preview dsh-selection-preview-original' });

    contentEl.createDiv({ text: t('selection.result'), cls: 'dsh-selection-label' });
    contentEl.createEl('pre', { text: this.result, cls: 'dsh-selection-preview dsh-selection-preview-result' });

    const buttons = contentEl.createDiv({ cls: 'dsh-modal-buttons' });
    const replace = buttons.createEl('button', {
      text: t('selection.replace'),
      cls: 'mod-cta',
    });
    replace.onclick = () => {
      if (this.onApply(this.result, 'replace')) this.close();
    };
    const insert = buttons.createEl('button', { text: t('selection.insert') });
    insert.onclick = () => {
      if (this.onApply(this.result, 'insert')) this.close();
    };
    const cancel = buttons.createEl('button', { text: t('selection.cancel') });
    cancel.onclick = () => this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
