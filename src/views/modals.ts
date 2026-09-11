import { Modal, App, Setting, Notice, FuzzySuggestModal, TFolder } from 'obsidian';
import { t } from '../i18n/index';

/** Simplified "save as note" modal (pattern borrowed from claudian). */
export class NoteCreatorModal extends Modal {
  private title = '';
  private content: string;

  constructor(app: App, content: string, private folder: string) {
    super(app);
    this.content = content;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl)
      .setName(t('chat.saveNoteTitle'))
      .addText((text) => text
        .setPlaceholder(t('chat.saveNotePrompt'))
        .onChange((v) => { this.title = v.trim(); }))
      .addButton((button) => button
        .setButtonText(t('chat.saveNote'))
        .setCta()
        .onClick(async () => {
          const name = this.title || `Harness-${Date.now()}`;
          const path = this.folder
            ? `${this.folder.replace(/\/$/, '')}/${name}.md`
            : `${name}.md`;
          try {
            await this.app.vault.create(path, this.content);
            new Notice(t('chat.saved'));
            this.close();
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Confirmation dialog when switching to danger-full-access. */
export class SecurityConfirmModal extends Modal {
  constructor(
    app: App,
    private onConfirm: () => void,
    private onCancel: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: t('security.confirmTitle') });
    contentEl.createEl('p', { text: t('security.confirmDesc') });
    const btns = contentEl.createDiv({ cls: 'dsh-modal-buttons' });
    const ok = btns.createEl('button', { cls: 'mod-cta', text: t('security.confirmOk') });
    ok.onclick = () => {
      this.onConfirm();
      this.close();
    };
    const cancel = btns.createEl('button', { text: t('security.cancel') });
    cancel.onclick = () => {
      this.onCancel();
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Pick a vault folder for `extraSkillDirs` without typing a path.
 *
 * Listing only real folders inside the vault makes the choice self-evident
 * for novices AND makes escapes (absolute paths / `../`) structurally
 * impossible — the vault-relative check stays as a safety net for hand-typed
 * values. Top-level folders are listed first, then nested ones.
 */
export class FolderSuggestModal extends FuzzySuggestModal<string> {
  constructor(app: App, private onPick: (folder: string) => void) {
    super(app);
    this.setPlaceholder(t('settings.extraSkillDirs.pickPlaceholder'));
  }

  getItems(): string[] {
    const depth = (p: string): number => p.split('/').length;
    return this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .map((f) => f.path)
      .filter((p) => p !== '' && p !== '/') // skip the vault root itself
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onPick(item);
  }
}

/**
 * Preview-and-copy dialog for the environment-check report.
 *
 * The text is shown in full and read-only before anything reaches the
 * clipboard. The report contains local absolute paths, so a silent copy would
 * be the wrong default even though the user is the one who pressed the button.
 */
export class DiagnosticPromptModal extends Modal {
  constructor(
    app: App,
    private prompt: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    // Widen the modal *frame*. Putting the width on contentEl instead made the
    // content box wider than its frame, so the tail of every long line was
    // clipped behind the modal border.
    this.modalEl.addClass('dsh-prompt-modal');
    contentEl.createEl('h3', { text: t('settings.check.copyTitle') });
    contentEl.createEl('p', { text: t('settings.check.copyDesc') });

    const area = contentEl.createEl('textarea', { cls: 'dsh-prompt-preview' });
    area.value = this.prompt;
    area.readOnly = true;
    area.rows = 16;

    new Setting(contentEl)
      .addButton((button) => button
        .setButtonText(t('settings.check.copyConfirm'))
        .setCta()
        .onClick(async () => {
          // Same API the chat view's copy button uses. It is async, so a
          // rejection (no permission, no focus) must be reported rather than
          // swallowed — the report is the entire point of this dialog.
          try {
            await navigator.clipboard.writeText(this.prompt);
            new Notice(t('settings.check.copied'));
            this.close();
          } catch {
            new Notice(t('settings.check.copyFailed'));
          }
        }))
      .addButton((button) => button
        .setButtonText(t('settings.check.copyCancel'))
        .onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
