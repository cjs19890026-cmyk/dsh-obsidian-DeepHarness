import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import * as path from 'path';
import { DshSettings, DshSettingTab, normalizeStoredSettings, obsidianLocale, type OptionFieldKey, type PermissionMode } from './settings/index';
import { ChatView, VIEW_TYPE_CHAT } from './views/chat-view';
import { SecurityConfirmModal } from './views/modals';
import { DshClient } from './dsh/dsh-client';
import { HistoryStore } from './core/history';
import { resolveUserDshHome } from './dsh/paths';
import { resolvePluginDshHome } from './dsh/dsh-runner';
import { setLocale, resolveLocale, getLocale, t } from './i18n/index';

export default class DshPlugin extends Plugin {
  settings!: DshSettings;
  private commandsRegistered = false;
  /** P2-K: every open chat view, purely so unload can tear each one down
   *  (Obsidian may skip onClose() on unload). This is *not* a multi-panel
   *  feature: the plugin treats the chat as one panel — the ribbon, the
   *  commands and "ask current note" always target the one revealed by
   *  activateChatView(). A user can still open more views by hand; those are
   *  independent views, not command targets (review D-4). */
  private chatViews = new Set<ChatView>();
  history: HistoryStore | null = null;
  private settingsChangeListeners = new Set<() => void>();
  private localeChangeListeners = new Set<() => void>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyLocale();

    // History store: the conversation archive. It lives with the plugin's
    // DSH_HOME outside the vault (see paths.ts), so this is an absolute path.
    // Same resolution the run path uses (see resolvePluginDshHome), so the
    // history file the plugin reads is the one it writes — including the legacy
    // fallback when a migration could not complete. Passed as a *resolver*: the
    // DSH_HOME migration runs at the first task, after onload(), and a path
    // captured here would keep the whole session writing to the old directory.
    this.history = new HistoryStore(
      () => path.join(
        resolvePluginDshHome(
          this.getVaultRoot(),
          this.app.vault.configDir,
          resolveUserDshHome(this.settings.dshHome),
        ),
        'history.json',
      ),
      this.settings.historyLimit,
    );
    await this.history.load();

    // Register chat view
    this.registerView(VIEW_TYPE_CHAT, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));

    // Ribbon icon
    this.addRibbonIcon('bot', 'DeepHarness', () => {
      void this.activateChatView();
    });

    // Commands (names are localized; re-registered on language change)
    this.registerCommands();

    this.addSettingTab(new DshSettingTab(this.app, this));
  }

  onunload(): void {
    // Views may not receive onClose() during unload; tear each open chat view
    // down explicitly so an in-flight run settles through the closed-view path
    // (P2-K): no DOM writes after teardown, and partial work is preserved as a
    // history turn below.
    for (const view of [...this.chatViews]) view.shutdownForUnload();
    this.chatViews.clear();
    // Kill any remaining running dsh child processes. Obsidian may or may not
    // call each view's onClose() during unload, so walk the live-client
    // registry explicitly — the safety net for reload/disable while a task
    // runs.
    DshClient.disposeAll();
    // Persist the in-progress conversation into history before unload.
    // endSession() + save() are synchronous (fs.writeFileSync + renameSync),
    // so the archive + write complete inline. Obsidian declares onunload() as
    // void and does NOT await a returned Promise — an async onunload would be
    // cut off mid-write on quit.
    void this.history?.endSession();
  }

  /** Track an open chat view (registered by ChatView at construction). */
  registerChatView(view: ChatView): void {
    this.chatViews.add(view);
  }

  /** Forget a chat view once it has been torn down. */
  unregisterChatView(view: ChatView): void {
    this.chatViews.delete(view);
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

  /** Re-apply UI language from settings + Obsidian locale. Notifies locale
   *  listeners (chat view re-renders its strings) only when the locale
   *  actually changed, so open views refresh without being recreated. */
  applyLocale(): void {
    const locale = resolveLocale(obsidianLocale(this.app), this.settings.language);
    if (locale === getLocale()) return;
    setLocale(locale);
    // Command-palette names are captured at registration time; re-register so
    // the palette follows the UI language without a plugin reload.
    if (this.commandsRegistered) {
      this.removeCommand('open-harness-chat');
      this.removeCommand('ask-active-note');
      this.registerCommands();
    }
    this.notifyLocaleChange();
  }

  /** Register the plugin's commands (localized names). */
  private registerCommands(): void {
    this.addCommand({
      id: 'open-harness-chat',
      name: t('chat.openChat'),
      callback: () => {
        void this.activateChatView();
      },
    });
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
    this.commandsRegistered = true;
  }

  /**
   * Subscribe to UI-language changes (returns an unsubscribe fn). Views that
   * render localized strings use this to re-render in place when the user
   * switches the language in settings — no view teardown / plugin reload needed.
   */
  onLocaleChange(listener: () => void): () => void {
    this.localeChangeListeners.add(listener);
    return () => this.localeChangeListeners.delete(listener);
  }

  private notifyLocaleChange(): void {
    for (const listener of this.localeChangeListeners) listener();
  }

  /**
   * Set the sandbox mode, confirming first when switching INTO
   * danger-full-access. This is the single entry point shared by the settings
   * tab and the chat header, so the "confirm before full access" rule cannot
   * be bypassed from one UI surface. Returns true when the mode was applied,
   * false when the user cancelled.
   */
  async setPermissionMode(mode: PermissionMode): Promise<boolean> {
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
    // The single chat panel: the commands write into the view this call just
    // brought on screen, never into "whichever leaf happens to be first".
    const view = await this.activateChatView();
    if (view) {
      view.setPendingInput(prompt);
    } else {
      new Notice(t('chat.noChatView'));
    }
  }

  /**
   * Reveal the chat panel and return it: what the ribbon icon, the command
   * palette and the "ask current note" command all target.
   */
  async activateChatView(): Promise<ChatView | null> {
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
      // Already narrowed to ChatView when the leaf came from getLeavesOfType.
      // (A freshly created view may be Obsidian's deferred placeholder, so this
      // deliberately does not re-test the instance here.)
      return leaf.view as ChatView;
    }
    return null;
  }
  async loadSettings(): Promise<void> {
    // P1-5: data-file settings are untrusted. Option-backed fields (model /
    // reasoningEffort / permissionMode / toolExecutionMode / provider) fall
    // back to DEFAULT_SETTINGS when the stored value is not in the option
    // lists any more (hand-edited data.json, id removed in a newer release).
    const { settings, reset } = normalizeStoredSettings(await this.loadData());
    this.settings = settings;
    // Migration: v0.1.0 wrongly injected DSH_TOOLS_MODE=workspace-write (a
    // file-sandbox value into a tool-backend knob, breaking profile boot).
    // Drop the legacy field so it can never be read again.
    const legacy = this.settings as unknown as { toolsMode?: string };
    const legacyMigrated = legacy.toolsMode !== undefined;
    if (legacyMigrated) delete legacy.toolsMode;
    if (reset.length > 0 || legacyMigrated) {
      // Heal data.json so a corrected value does not reset again on launch.
      await this.saveSettings();
    }
    if (reset.length > 0) {
      // loadSettings runs before applyLocale() in onload — apply the locale
      // first so the reset notice is shown in the user's UI language.
      this.applyLocale();
      const fieldLabels: Record<OptionFieldKey, string> = {
        provider: t('settings.provider.name'),
        model: t('settings.model.name'),
        reasoningEffort: t('settings.reasoning.name'),
        permissionMode: t('settings.permission.name'),
        toolExecutionMode: t('settings.toolMode.name'),
      };
      new Notice(t('settings.storedOptionReset', {
        fields: reset.map((field) => fieldLabels[field]).join(', '),
      }));
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
