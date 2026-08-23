import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { DshSettings, DshSettingTab, DEFAULT_SETTINGS, obsidianLocale } from './settings';
import { ChatView, VIEW_TYPE_CHAT } from './chat-view';
import { SecurityConfirmModal } from './modals';
import { DshClient } from './dsh-client';
import { HistoryStore } from './history';
import { setLocale, resolveLocale, t } from './i18n';

export default class DshPlugin extends Plugin {
  settings!: DshSettings;
  private vaultPatchInvalidated = false;
  history: HistoryStore | null = null;
  private settingsChangeListeners = new Set<() => void>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyLocale();

    // History store: human-readable task history in the plugin DSH_HOME.
    // NOTE: vault.adapter paths are relative to the vault root (not absolute).
    const configDir = this.app.vault.configDir;
    const historyFile = `${configDir}/plugins/deepharness/dsh-home/history.json`;
    this.history = new HistoryStore(this.app, historyFile, this.settings.historyLimit);
    await this.history.load();

    // Register chat view
    this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    // Ribbon icon
    this.addRibbonIcon('bot', 'DeepHarness', () => {
      void this.activateChatView();
    });

    // Command: open chat
    this.addCommand({
      id: 'open-harness-chat',
      name: t('chat.openChat'),
      callback: () => {
        void this.activateChatView();
      },
    });

    // Command: ask about the active note
    this.addCommand({
      id: 'ask-active-note',
      name: t('chat.processNote'),
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension === 'md') {
          if (!checking) {
            void this.askWithActiveNote();
          }
          return true;
        }
        return false;
      },
    });

    this.addSettingTab(new DshSettingTab(this.app, this));
  }

  onunload(): void {
    // Kill any running dsh child processes. Obsidian may or may not call each
    // view's onClose() during unload, so walk the live-client registry
    // explicitly — the safety net for reload/disable while a task runs.
    DshClient.disposeAll();
    // Persist the in-progress conversation into history before unload.
    // endSession() + save() are synchronous (fs.writeFileSync + renameSync),
    // so the archive + write complete inline. Obsidian declares onunload() as
    // void and does NOT await a returned Promise — an async onunload would be
    // cut off mid-write on quit.
    void this.history?.endSession();
  }

  /** Absolute filesystem path of the vault root. */
  getVaultRoot(): string {
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    if (typeof adapter.getBasePath === 'function') {
      return adapter.getBasePath();
    }
    // Fallback: use the vault name under the default Obsidian location.
    return this.app.vault.getName() || 'vault';
  }

  /** Re-apply UI language from settings + Obsidian locale. */
  applyLocale(): void {
    const locale = resolveLocale(obsidianLocale(this.app), this.settings.language);
    setLocale(locale);
  }

  /** Force regeneration of the persona patch (custom persona changed). */
  invalidateVaultPatch(): void {
    this.vaultPatchInvalidated = true;
  }

  /**
   * Set the sandbox mode, confirming first when switching INTO
   * danger-full-access. This is the single entry point shared by the settings
   * tab and the chat header, so the "confirm before full access" rule cannot
   * be bypassed from one UI surface. Returns true when the mode was applied,
   * false when the user cancelled.
   */
  async setPermissionMode(mode: string): Promise<boolean> {
    const switchingToFull = mode === 'danger-full-access'
      && this.settings.permissionMode !== 'danger-full-access';
    if (!switchingToFull) {
      this.settings.permissionMode = mode;
      await this.saveSettings();
      return true;
    }
    return new Promise<boolean>((resolve) => {
      new SecurityConfirmModal(
        this.app,
        () => {
          this.settings.permissionMode = mode;
          void this.saveSettings();
          resolve(true);
        },
        () => resolve(false),
      ).open();
    });
  }

  private async askWithActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const content = await this.app.vault.cachedRead(file);
    const prompt = t('chat.askNotePrompt', {
      title: file.basename,
      content: content.slice(0, 20000),
    });
    await this.activateChatView();
    const view = this.getChatView();
    if (view) {
      view.setPendingInput(prompt);
    } else {
      new Notice(t('chat.noChatView'));
    }
  }

  private getChatView(): ChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    return leaves.length > 0 ? (leaves[0].view as ChatView) : null;
  }

  async activateChatView(): Promise<void> {
    const { workspace } = this.app;
    // The chat view lives in the right sidebar; if that sidebar is collapsed
    // the leaf is created/focused but invisible. Expanding it here makes the
    // ribbon icon and "打开聊天面板" command always reveal the panel.
    const rightSplit = (workspace as { rightSplit?: { collapsed?: boolean; expand?: () => void } }).rightSplit;
    if (rightSplit && rightSplit.collapsed) {
      rightSplit.expand?.();
    }
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      }
    }
    if (leaf) {
      workspace.setActiveLeaf(leaf, { focus: true });
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<DshSettings>);
    // Migration: v0.1.0 wrongly injected DSH_TOOLS_MODE=workspace-write (a
    // file-sandbox value into a tool-backend knob, breaking profile boot).
    // Drop the legacy field so it can never be read again.
    const legacy = this.settings as unknown as { toolsMode?: string };
    if (legacy.toolsMode !== undefined) {
      delete legacy.toolsMode;
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.notifySettingsChange();
  }

  /**
   * Subscribe to settings saves (returns an unsubscribe fn). Views that render
   * settings-derived labels (model / effort / permission triggers) use this to
   * refresh when a value changes from the settings tab.
   */
  onSettingsChange(listener: () => void): () => void {
    this.settingsChangeListeners.add(listener);
    return () => this.settingsChangeListeners.delete(listener);
  }

  private notifySettingsChange(): void {
    for (const listener of this.settingsChangeListeners) listener();
  }
}
