import * as path from 'path';
import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, setIcon, Menu, MarkdownView, Keymap } from 'obsidian';
import type DshPlugin from './main';
import { DshClient } from './dsh-client';
import { DshRunner } from './dsh-runner';
import { buildTitleEntries, linkifyNoteTitles, type NoteInfo } from './linkify';
import { scanSkillRoots, type SkillEntry, type ScanRoot } from './skills';
import { SkillSuggest } from './skill-suggest';
import { MODEL_OPTIONS, REASONING_OPTIONS, PERMISSION_OPTIONS, permissionLabel } from './settings';
import { ContextMeter, estimateTokens } from './context-meter';
import { parseHeadlessOutput, errorHint, contextWindowFor, resolveVaultRelativeDir } from './pure';
import { HistoryTool } from './history';
import { MentionSuggest } from './mention';
import { ChipEditor } from './chip-editor';
import { t } from './i18n';
import { NoteCreatorModal } from './modals';

export const VIEW_TYPE_CHAT = 'deepharness-chat';

/** Rough fixed token cost of the vault persona system prompt (built-in rules). */
const PERSONA_FIXED_TOKENS = 200;

/** Selections up to this many characters are quoted in full. */
const QUOTE_FULL_LIMIT = 600;
/** Longer selections are truncated to this many characters. */
const QUOTE_TRUNCATE_LIMIT = 300;

interface MemoryTurn {
  user: string;
  assistant: string;
}

export class ChatView extends ItemView {
  plugin: DshPlugin;
  private client: DshClient;
  private runner: DshRunner;

  private messagesContainer!: HTMLElement;
  private editor!: ChipEditor;
  private sendButton!: HTMLButtonElement;
  private clearBtn!: HTMLButtonElement;
  private modelTrigger!: HTMLButtonElement;
  private securityTrigger!: HTMLButtonElement;
  private referenceBtn!: HTMLButtonElement;
  private mentionBtn!: HTMLButtonElement;
  private skillBtn!: HTMLButtonElement;
  private historyBtn!: HTMLButtonElement;
  private mention: MentionSuggest | null = null;
  /** Last focused markdown view, so its selection can be read even while the
   *  chat panel has focus. Kept in sync via the active-leaf-change event. */
  private lastMarkdownView: MarkdownView | null = null;
  private historyPanel: HTMLElement | null = null;
  private skillPanel: HTMLElement | null = null;
  private skillSuggest: SkillSuggest | null = null;
  private statusEl: HTMLElement | null = null;
  private statusTimer: number | null = null;
  private statusStartedAt = 0;
  private abortController: AbortController | null = null;
  private running = false;
  private memory: MemoryTurn[] = [];
  private contextMeter: ContextMeter | null = null;
  private settingsUnsub: (() => void) | null = null;
  private localeUnsub: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: DshPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.client = new DshClient();
    this.runner = new DshRunner(plugin.settings, plugin.app.vault.configDir);
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return 'DeepHarness';
  }

  getIcon(): string {
    return 'bot';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('dsh-container');

    // Cursor text selection is enabled via the .dsh-container CSS rules.

    // Track the last focused markdown view so the reference icon can quote its
    // selection even after the chat panel itself has taken focus.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const view = leaf?.view;
        if (view instanceof MarkdownView) {
          this.lastMarkdownView = view;
        }
      }),
    );

    // Header
    const header = container.createDiv({ cls: 'dsh-header' });
    const title = header.createDiv({ cls: 'dsh-header-title' });
    title.createEl('h4', { text: 'DeepHarness' });
    title.createSpan({ cls: 'dsh-header-sub', text: 'DeepSeek · Obsidian' });

    this.clearBtn = header.createEl('button', { cls: 'dsh-icon-btn' });
    setIcon(this.clearBtn, 'pen');
    this.clearBtn.setAttribute('aria-label', t('chat.clear'));
    this.clearBtn.onclick = () => this.clearChat();

    // Messages
    this.messagesContainer = container.createDiv({ cls: 'dsh-messages' });
    this.showWelcome();

    // Top toolbar (above the composer): reference (left) + history (right)
    const topToolbar = container.createDiv({ cls: 'dsh-top-toolbar' });
    this.referenceBtn = topToolbar.createEl('button', { cls: 'dsh-top-btn dsh-top-reference', text: '<' });
    this.referenceBtn.setAttribute('aria-label', t('chat.referenceNote'));
    this.referenceBtn.setAttribute('title', t('chat.referenceNote'));
    this.referenceBtn.onclick = () => this.insertActiveNoteReference();

    // @mention trigger: same as typing "@" in the input box (opens the note
    // suggestion popup). Sits to the left of the skills (wrench) button.
    this.mentionBtn = topToolbar.createEl('button', { cls: 'dsh-top-btn dsh-top-mention' });
    setIcon(this.mentionBtn, 'at-sign');
    this.mentionBtn.setAttribute('aria-label', t('chat.mentionButton'));
    this.mentionBtn.setAttribute('title', t('chat.mentionButton'));
    this.mentionBtn.onclick = () => this.mention?.trigger();

    this.skillBtn = topToolbar.createEl('button', { cls: 'dsh-top-btn dsh-top-skill' });
    setIcon(this.skillBtn, 'wrench');
    this.skillBtn.setAttribute('aria-label', t('chat.skillButton'));
    this.skillBtn.setAttribute('title', t('chat.skillButton'));
    this.skillBtn.onclick = () => this.toggleSkillPanel();

    this.historyBtn = topToolbar.createEl('button', { cls: 'dsh-top-btn dsh-top-history' });
    setIcon(this.historyBtn, 'clock');
    this.historyBtn.setAttribute('aria-label', t('chat.historyButton'));
    this.historyBtn.onclick = () => this.toggleHistoryPanel();

    // Composer card: rich chip editor + toolbar (model/effort/security/meter/send)
    const composer = container.createDiv({ cls: 'dsh-composer' });

    // Chip editor: contenteditable; [[wikilink]] references render as
    // clickable chips instead of long path text.
    this.editor = new ChipEditor(composer, this.app, { placeholder: t('chat.placeholder') });
    // @mention suggestion (own input/click listeners; only keydown is routed
    // through here so Enter/send stays in one place).
    this.mention = new MentionSuggest(this.app, this.editor, {
      getScope: () => this.plugin.settings.workdir,
      getAnchor: () => this.historyBtn,
    });
    // /skill completion: same popup pattern, anchored to the skill button.
    this.skillSuggest = new SkillSuggest(this.app, this.editor, {
      getSkills: () => this.scanSkills(),
      getAnchor: () => this.skillBtn,
    });
    this.editor.el.addEventListener('keydown', (e) => {
      if (this.skillSuggest?.handleKeydown(e)) return;
      if (this.mention?.handleKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.sendMessage();
      }
    });

    const toolbar = composer.createDiv({ cls: 'dsh-composer-toolbar' });

    // Model + reasoning trigger button (single line: name · effort)
    this.modelTrigger = toolbar.createEl('button', { cls: 'dsh-trigger dsh-trigger-model' });
    this.modelTrigger.createSpan({ cls: 'dsh-trigger-model-name' });
    this.modelTrigger.createSpan({ cls: 'dsh-trigger-effort' });
    this.modelTrigger.onclick = (e) => this.showModelMenu(e);

    // Security trigger button
    this.securityTrigger = toolbar.createEl('button', { cls: 'dsh-trigger dsh-trigger-security' });
    const securityIcon = this.securityTrigger.createSpan({ cls: 'dsh-trigger-security-icon' });
    setIcon(securityIcon, 'shield');
    this.securityTrigger.createSpan({ cls: 'dsh-trigger-security-label' });
    this.securityTrigger.onclick = (e) => this.showSecurityMenu(e);

    // Context usage ring
    this.contextMeter = new ContextMeter(toolbar, contextWindowFor(this.plugin.settings.model));

    // Send button (capsule)
    this.sendButton = toolbar.createEl('button', { cls: 'dsh-send-btn', text: t('chat.send') });
    this.sendButton.onclick = () => {
      if (this.running) {
        this.stopRun();
      } else {
        void this.sendMessage();
      }
    };

    this.updateTriggerLabels();
    // Reflect settings-tab changes (model / effort / permission) into the
    // trigger labels, which otherwise only refresh from our own menus.
    this.settingsUnsub = this.plugin.onSettingsChange(() => this.updateTriggerLabels());
    // Reflect language changes into every locale-dependent string in place,
    // so the panel refreshes without being closed/reopened.
    this.localeUnsub = this.plugin.onLocaleChange(() => this.refreshLocaleStrings());
  }

  /** Re-apply locale-dependent strings in place after a language switch:
   *  toolbar tooltips, composer placeholder, send text, welcome line, trigger
   *  labels and any open floating panel. Historical messages keep their text. */
  private refreshLocaleStrings(): void {
    if (this.clearBtn) this.clearBtn.setAttribute('aria-label', t('chat.clear'));
    if (this.referenceBtn) {
      this.referenceBtn.setAttribute('aria-label', t('chat.referenceNote'));
      this.referenceBtn.setAttribute('title', t('chat.referenceNote'));
    }
    if (this.mentionBtn) {
      this.mentionBtn.setAttribute('aria-label', t('chat.mentionButton'));
      this.mentionBtn.setAttribute('title', t('chat.mentionButton'));
    }
    if (this.skillBtn) {
      this.skillBtn.setAttribute('aria-label', t('chat.skillButton'));
      this.skillBtn.setAttribute('title', t('chat.skillButton'));
    }
    if (this.historyBtn) this.historyBtn.setAttribute('aria-label', t('chat.historyButton'));
    this.editor.el.setAttribute('data-placeholder', t('chat.placeholder'));
    if (this.sendButton) this.sendButton.setText(this.running ? t('chat.stop') : t('chat.send'));
    const welcomeSub = this.messagesContainer.querySelector('.dsh-welcome-sub');
    if (welcomeSub) welcomeSub.textContent = t('chat.welcomeSub');
    this.updateTriggerLabels();
    // Floating panels carry their own localized labels; rebuild any that is open.
    if (this.historyPanel) this.openHistoryPanel();
    if (this.skillPanel) this.openSkillPanel();
  }

  /** Refresh trigger button labels from settings. */
  private updateTriggerLabels(): void {
    if (!this.modelTrigger || !this.securityTrigger) return;
    const m = MODEL_OPTIONS.find((x) => x.id === this.plugin.settings.model);
    const r = REASONING_OPTIONS.find((x) => x.id === this.plugin.settings.reasoningEffort);
    const nameEl = this.modelTrigger.querySelector('.dsh-trigger-model-name') as HTMLElement;
    const effortEl = this.modelTrigger.querySelector('.dsh-trigger-effort') as HTMLElement;
    if (nameEl) nameEl.textContent = m ? m.label : this.plugin.settings.model;
    if (effortEl) effortEl.textContent = `· ${r ? r.label : this.plugin.settings.reasoningEffort}`;
    const secLabel = this.securityTrigger.querySelector('.dsh-trigger-security-label') as HTMLElement;
    const p = PERMISSION_OPTIONS.find((x) => x.id === this.plugin.settings.permissionMode);
    if (secLabel) secLabel.textContent = p ? permissionLabel(p.id) : this.plugin.settings.permissionMode;
    this.securityTrigger.toggleClass(
      'dsh-trigger-danger',
      this.plugin.settings.permissionMode === 'danger-full-access',
    );
    // Keep the context meter's denominator in sync with the selected model.
    this.contextMeter?.setContextWindow(contextWindowFor(this.plugin.settings.model));
  }

  /** Model + reasoning effort menu (two sections in one popup). */
  private showModelMenu(evt: MouseEvent): void {
    const menu = new Menu();
    for (const m of MODEL_OPTIONS) {
      menu.addItem((item) => item
        .setTitle(m.label)
        .setChecked(m.id === this.plugin.settings.model)
        .onClick(() => {
          this.plugin.settings.model = m.id;
          void this.plugin.saveSettings();
          this.updateTriggerLabels();
        }));
    }
    menu.addSeparator();
    for (const r of REASONING_OPTIONS) {
      menu.addItem((item) => item
        .setTitle(r.label)
        .setChecked(r.id === this.plugin.settings.reasoningEffort)
        .onClick(() => {
          this.plugin.settings.reasoningEffort = r.id;
          void this.plugin.saveSettings();
          this.updateTriggerLabels();
        }));
    }
    menu.showAtMouseEvent(evt);
  }

  /** Security / sandbox mode menu. */
  private showSecurityMenu(evt: MouseEvent): void {
    const menu = new Menu();
    for (const p of PERMISSION_OPTIONS) {
      menu.addItem((item) => item
        .setTitle(permissionLabel(p.id))
        .setChecked(p.id === this.plugin.settings.permissionMode)
        .onClick(() => { void this.applyPermissionMode(p.id); }));
    }
    menu.showAtMouseEvent(evt);
  }

  /** Delegate to the plugin's single confirmation path, then refresh labels. */
  private async applyPermissionMode(mode: string): Promise<void> {
    await this.plugin.setPermissionMode(mode);
    this.updateTriggerLabels();
  }

  onClose(): Promise<void> {
    this.closeHistoryPanel();
    this.closeSkillPanel();
    this.mention?.dispose();
    this.mention = null;
    this.skillSuggest?.dispose();
    this.skillSuggest = null;
    this.client.dispose();
    if (this.statusTimer !== null) window.clearInterval(this.statusTimer);
    this.settingsUnsub?.();
    this.settingsUnsub = null;
    this.localeUnsub?.();
    this.localeUnsub = null;
    return Promise.resolve();
  }

  private showWelcome(): void {
    const w = this.messagesContainer.createDiv({ cls: 'dsh-welcome' });
    const icon = w.createDiv({ cls: 'dsh-welcome-icon' });
    setIcon(icon, 'bot');
    w.createDiv({ cls: 'dsh-welcome-title', text: 'DeepHarness' });
    w.createDiv({ cls: 'dsh-welcome-sub', text: t('chat.welcomeSub') });
  }

  private clearChat(): void {
    if (this.running) {
      new Notice(t('chat.busy'));
      return;
    }
    // Archive the current session into history, then start a new one.
    void this.plugin.history?.endSession();
    this.mention?.close();
    this.skillSuggest?.close();
    this.memory = [];
    this.contextMeter?.reset();
    this.messagesContainer.empty();
    this.showWelcome();
    new Notice(t('chat.cleared'));
  }

  private async sendMessage(): Promise<void> {
    const message = this.editor.getText().trim();
    if (!message || this.running) {
      if (this.running) new Notice(t('chat.busy'));
      return;
    }

    const bin = await this.runner.detectBin();
    if (!bin) {
      this.renderMessage('assistant', `> ⚠️ ${t('chat.noDsh')}`, true);
      new Notice(t('chat.noDsh'), 6000);
      return;
    }
    // Detect node + dsh's real script so we spawn `node bin.js` directly
    // (bypasses the shebang, which fails under Electron's restricted PATH).
    const nodeBin = await this.runner.detectNode();
    if (!nodeBin) {
      this.renderMessage('assistant', `> ⚠️ ${t('chat.noNode')}`, true);
      new Notice(t('chat.noNode'), 6000);
      return;
    }
    const dshScript = this.runner.resolveDshScript(bin);
    if (!dshScript) {
      this.renderMessage('assistant', `> ⚠️ ${t('chat.dshNotNodeScript')}`, true);
      new Notice(t('chat.dshNotNodeScript'), 6000);
      return;
    }

    this.editor.clear();
    this.renderMessage('user', message);

    this.running = true;
    this.abortController = new AbortController();
    this.setButtonToStop();

    const vaultRoot = this.plugin.getVaultRoot();
    const memorySummary = this.buildMemorySummary();
    const task = this.runner.buildTask(message, memorySummary);
    // Context meter: account for this turn's prompt (system persona +
    // assembled task) right when it is sent.
    if (this.contextMeter) {
      this.contextMeter.addTokens(PERSONA_FIXED_TOKENS + estimateTokens(task));
    }
    const patches = await this.runner.ensureVaultPatch(vaultRoot);
    const skillDirsPatch = this.runner.ensureSkillDirsPatch(vaultRoot);
    const patchPaths = [patches.persona, patches.think, skillDirsPatch].filter((p): p is string => p !== null);
    // Built-in obsidian skill + long-term memory seed.
    this.runner.ensureObsidianSkill(vaultRoot);
    this.runner.ensureMemoryFile(vaultRoot);
    // Isolated DSH_HOME with the selected model + reasoning effort;
    // falls back to the user home when it cannot be prepared.
    const pluginHome = this.runner.ensurePluginDshHome(vaultRoot, {
      model: this.plugin.settings.model,
      effort: this.plugin.settings.reasoningEffort,
    });
    const dshHome = pluginHome ?? this.runner.dshHome();

    // Streaming assistant message: thinking + tools stream inline into the
    // message (web-UI style, no wrapper container), then the answer renders
    // below them in the same message. Both sections honor the settings
    // show-thinking / show-tools toggles.
    const respEl = this.createMessageElement('assistant');
    const contentEl = respEl.querySelector('.dsh-message-content') as HTMLElement;

    // Collapsible thinking block, live-filled (auto-collapsed on completion)
    let thinkBlock: HTMLElement | null = null;
    let thinkBody: HTMLElement | null = null;
    if (this.plugin.settings.showThinking) {
      thinkBlock = contentEl.createDiv({ cls: 'dsh-think' });
      const thinkToggle = thinkBlock.createEl('button', { cls: 'dsh-think-toggle' });
      const thinkChevron = thinkToggle.createSpan({ cls: 'dsh-think-chevron' });
      setIcon(thinkChevron, 'chevron-down');
      thinkToggle.createSpan({ text: t('chat.thinkToggle') });
      thinkBody = thinkBlock.createDiv({ cls: 'dsh-think-body' });
      thinkToggle.onclick = () => {
        const collapsed = thinkBody!.classList.contains('hidden');
        thinkBody!.classList.toggle('hidden', !collapsed);
        setIcon(thinkChevron, collapsed ? 'chevron-down' : 'chevron-right');
      };
    }

    // Tool calls stream directly into the message body (when enabled)
    const toolsWrap = this.plugin.settings.showTools
      ? contentEl.createDiv({ cls: 'dsh-stream-tools' })
      : null;

    const toolRows = new Map<string, {
      status: HTMLElement;
      chevron: HTMLElement;
      content: HTMLElement;
      name: string;
      args: string;
    }>();
    const toolsHistory: HistoryTool[] = [];
    let thinkingText = '';
    const handleStreamLine = (line: string): void => {
      if (!line.startsWith('DLEVENT\t')) return;
      let evt: { t?: string; text?: string; status?: string; id?: string; name?: string; args?: string; argsFull?: string; ok?: boolean; summary?: string };
      try {
        evt = JSON.parse(line.slice('DLEVENT\t'.length)) as typeof evt;
      } catch {
        return;
      }
      if (evt.t === 'think' && typeof evt.text === 'string') {
        thinkingText += evt.text;
        if (thinkBody) {
          thinkBody.setText(thinkingText.length > 4000 ? `…${thinkingText.slice(-4000)}` : thinkingText);
        }
        this.scrollToBottom();
      } else if (evt.t === 'tool' && evt.status) {
        if (!toolsWrap) return; // tool display disabled
        if (evt.status === 'start' && evt.id) {
          // One tool call block: clickable header + expanded content
          const call = toolsWrap.createDiv({ cls: 'dsh-tool-call' });
          const header = call.createEl('button', { cls: 'dsh-tool-header' });
          const icon = header.createSpan({ cls: 'dsh-tool-icon' });
          setIcon(icon, 'wrench');
          header.createSpan({ cls: 'dsh-tool-name', text: evt.name ?? 'tool' });
          header.createSpan({ cls: 'dsh-tool-summary', text: evt.args ?? '' });
          const status = header.createSpan({ cls: 'dsh-tool-status status-running' });
          setIcon(status, 'loader-circle');
          const chevron = header.createSpan({ cls: 'dsh-tool-chevron' });
          setIcon(chevron, 'chevron-right');
          const content = call.createDiv({ cls: 'dsh-tool-content hidden' });
          // Show the full arguments (the detailed command) right away
          if (evt.argsFull) {
            content.createDiv({ cls: 'dsh-tool-cmd', text: evt.argsFull });
          }
          header.onclick = () => {
            const collapsed = content.classList.contains('hidden');
            content.classList.toggle('hidden', !collapsed);
            setIcon(chevron, collapsed ? 'chevron-down' : 'chevron-right');
          };
          toolRows.set(evt.id, { status, chevron, content, name: evt.name ?? 'tool', args: evt.argsFull ?? evt.args ?? '' });
        } else if (evt.status === 'result') {
          const entry = evt.id ? toolRows.get(evt.id) : undefined;
          if (entry) {
            entry.status.classList.remove('status-running');
            if (evt.ok) {
              entry.status.classList.add('status-completed');
              setIcon(entry.status, 'check');
            } else {
              entry.status.classList.add('status-error');
              setIcon(entry.status, 'x');
            }
            const lineText = evt.summary
              ? evt.summary
              : evt.ok ? t('chat.toolNoOutput') : t('chat.toolFailed');
            // Tools stay collapsed by default; result visible when expanded.
            entry.content.createDiv({ cls: 'dsh-tool-line', text: lineText });
            // Collect for history
            toolsHistory.push({
              name: entry.name,
              args: entry.args,
              ok: evt.ok !== false,
              summary: evt.summary || undefined,
            });
          }
        }
        this.scrollToBottom();
      }
    };

    // Status line
    const statusEl = this.createStatusElement();
    this.startStatusTimer(statusEl);

    try {
      const result = await this.client.run(task, {
        dshBin: bin,
        nodeBin,
        dshScript,
        cwd: this.runner.workdir(vaultRoot),
        dshHome,
        apiKey: this.plugin.settings.apiKey.trim() || undefined,
        provider: this.plugin.settings.provider,
        toolsMode: this.plugin.settings.toolExecutionMode,
        permissionMode: this.plugin.settings.permissionMode,
        patchPath: patchPaths,
        timeoutMs: this.plugin.settings.timeoutSec * 1000,
        signal: this.abortController.signal,
        onStdoutLine: handleStreamLine,
      });

      this.stopStatusTimer();

      if (result.killReason === 'user') {
        // Stopped by the user: keep it subtle — a small status note only.
        statusEl.setText(`⏹ ${t('chat.cancelled')}`);
        this.finalizeStreamMessage(respEl, contentEl, thinkBlock, thinkBody, thinkingText, null);
      } else if (result.killReason === 'timeout') {
        // Auto-stopped after the configured timeout: surface it as an error
        // with its own message, so it is never mistaken for a manual stop.
        const msg = t('chat.timedOut');
        statusEl.setText(`✗ ${msg}`);
        statusEl.addClass('dsh-status-error');
        contentEl.createSpan({ text: `> ❌ ${msg}`, cls: 'dsh-error-inline' });
        this.finalizeStreamMessage(respEl, contentEl, thinkBlock, thinkBody, thinkingText, null);
      } else if (result.exitCode !== 0 || !result.stdout.trim()) {
        const errMsg = this.extractError(result.stderr);
        statusEl.setText(`✗ ${t('chat.failed', { message: errMsg })}`);
        statusEl.addClass('dsh-status-error');
        contentEl.createSpan({ text: `> ❌ ${t('chat.failed', { message: errMsg })}`, cls: 'dsh-error-inline' });
        this.finalizeStreamMessage(respEl, contentEl, thinkBlock, thinkBody, thinkingText, null);
      } else {
        // The stream relay consumed DLEVENT lines live; the remaining stdout
        // is the final answer.
        const answer = parseHeadlessOutput(result.stdout);
        statusEl.setText(`✓ ${t('chat.completed', { duration: String(Math.round(result.durationMs / 1000)) })}`);
        this.finalizeStreamMessage(respEl, contentEl, thinkBlock, thinkBody, thinkingText, answer);
        // Remember this turn for the next task
        this.memory.push({
          user: message,
          assistant: answer.split('\n')[0].slice(0, 200),
        });
        if (this.memory.length > 20) this.memory.shift();
        // Persist this turn into the current session
        void this.plugin.history?.addTurn({
          ts: Date.now(),
          user: message,
          answer,
          thinking: thinkingText || undefined,
          tools: toolsHistory.length > 0 ? toolsHistory : undefined,
          durationMs: result.durationMs,
        }, {
          model: this.plugin.settings.model,
          effort: this.plugin.settings.reasoningEffort,
          permission: this.plugin.settings.permissionMode,
        });
      }
    } catch (e) {
      this.stopStatusTimer();
      const msg = e instanceof Error ? e.message : String(e);
      statusEl.setText(`✗ ${t('chat.failed', { message: msg })}`);
      statusEl.addClass('dsh-status-error');
      contentEl.createSpan({ text: `> ❌ ${t('chat.failed', { message: msg })}`, cls: 'dsh-error-inline' });
      this.finalizeStreamMessage(respEl, contentEl, thinkBlock, thinkBody, thinkingText, null);
    } finally {
      this.running = false;
      this.abortController = null;
      this.resetButtonToSend();
      this.scrollToBottom();
    }
  }

  private stopRun(): void {
    this.abortController?.abort();
    this.client.stop();
  }

  /** Summarize recent turns into compact bullet lines for context refill. */
  private buildMemorySummary(): string[] {
    if (this.memory.length === 0) return [];
    const recent = this.memory.slice(-5);
    const lines = [t('chat.memoryHeader')];
    for (const turn of recent) {
      lines.push(`- ${t('chat.memoryUser')}${turn.user.slice(0, 80)}`);
      if (turn.assistant) lines.push(`  ${t('chat.memoryAssistant')}${turn.assistant.slice(0, 80)}`);
    }
    return [lines.join('\n')];
  }

  /** Parse a dsh stderr line: `dsh: CODE: message`, mapping known codes to hints. */
  private extractError(stderr: string): string {
    const m = stderr.match(/dsh:\s*(?:([A-Z][A-Z0-9_]*):\s*)?(.+)/s);
    const code = m?.[1];
    const raw = m ? m[2].trim() : stderr.trim();
    if (code) {
      const hint = errorHint(code);
      if (hint) return hint;
    }
    return raw || 'unknown error';
  }

  private createStatusElement(): HTMLElement {
    this.statusEl = this.messagesContainer.createDiv({ cls: 'dsh-status' });
    this.statusEl.setText(`${t('chat.starting')} …`);
    this.scrollToBottom();
    return this.statusEl;
  }

  private startStatusTimer(statusEl: HTMLElement): void {
    this.statusStartedAt = Date.now();
    this.stopStatusTimer();
    const tick = (): void => {
      const sec = Math.round((Date.now() - this.statusStartedAt) / 1000);
      statusEl.setText(`⏳ ${t('chat.thinking')} ${sec}s`);
    };
    tick();
    this.statusTimer = window.setInterval(tick, 1000);
  }

  private stopStatusTimer(): void {
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  private setButtonToStop(): void {
    this.sendButton.setText(t('chat.stop'));
    this.sendButton.addClass('is-stop');
    this.clearBtn.disabled = true;
  }

  private resetButtonToSend(): void {
    this.sendButton.setText(t('chat.send'));
    this.sendButton.removeClass('is-stop');
    this.clearBtn.disabled = false;
  }

  /** Create a message wrapper element (used by streaming send). */
  private createMessageElement(role: 'user' | 'assistant'): HTMLElement {
    const el = this.messagesContainer.createDiv({
      cls: `dsh-message dsh-message-${role}`,
    });
    el.createDiv({ cls: 'dsh-message-content' });
    return el;
  }

  private renderMessage(
    role: 'user' | 'assistant',
    content: string,
    isSystem = false,
    thinking?: string | null,
    tools?: HistoryTool[],
  ): void {
    const el = this.messagesContainer.createDiv({
      cls: `dsh-message dsh-message-${role}${isSystem ? ' dsh-message-system' : ''}`,
    });
    const contentEl = el.createDiv({ cls: 'dsh-message-content' });
    if (role === 'assistant') {
      // Collapsible thinking block (shown before the answer)
      if (thinking) {
        this.renderThinkingBlock(contentEl, thinking);
      }
      if (tools && tools.length > 0) {
        this.renderToolsBlock(contentEl, tools);
      }
      // Auto-link note titles mentioned in the answer (keeps the raw text
      // untouched for copy / save-as-note).
      const rendered = isSystem ? content : this.linkifyAnswer(content);
      this.renderMarkdownWithLinks(rendered, contentEl);
      if (!isSystem) this.addMessageActions(el, content);
    } else {
      contentEl.setText(content);
    }
    this.scrollToBottom();
  }

  /**
   * Wrap vault note titles / aliases / paths mentioned in an answer into
   * [[wikilinks]] so they become clickable, without touching the raw text
   * (copy / save-as-note keep the original answer).
   */
  private linkifyAnswer(text: string): string {
    const files = this.app.vault.getMarkdownFiles();
    const notes: NoteInfo[] = files.map((f) => {
      let aliases: string[] = [];
      try {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
          | { aliases?: unknown }
          | undefined;
        const raw = fm?.aliases;
        if (Array.isArray(raw)) aliases = raw.map(String);
        else if (typeof raw === 'string') {
          aliases = raw.split(',').map((s) => s.trim()).filter(Boolean);
        }
      } catch {
        // metadata read failure: link by title only
      }
      return {
        name: f.basename,
        path: f.path.replace(/\.md$/, ''),
        aliases,
      };
    });
    return linkifyNoteTitles(text, buildTitleEntries(notes));
  }

  /** Collapsible "思考过程" block (default collapsed, plain text). */
  private renderThinkingBlock(container: HTMLElement, thinking: string): void {
    const block = container.createDiv({ cls: 'dsh-think' });
    const toggle = block.createEl('button', { cls: 'dsh-think-toggle' });
    const chevron = toggle.createSpan({ cls: 'dsh-think-chevron' });
    setIcon(chevron, 'chevron-right');
    toggle.createSpan({ text: t('chat.thinkToggle') });
    const body = block.createDiv({ cls: 'dsh-think-body hidden' });
    body.setText(thinking);
    toggle.onclick = () => {
      const collapsed = body.hasClass('hidden');
      body.toggleClass('hidden', !collapsed);
      if (collapsed) setIcon(chevron, 'chevron-down');
      else setIcon(chevron, 'chevron-right');
    };
  }

  /** Collapsed "工具调用" block for restored history turns. */
  private renderToolsBlock(container: HTMLElement, tools: HistoryTool[]): void {
    const wrap = container.createDiv({ cls: 'dsh-stream-tools' });
    for (const tool of tools) {
      const call = wrap.createDiv({ cls: 'dsh-tool-call' });
      const header = call.createEl('button', { cls: 'dsh-tool-header' });
      const icon = header.createSpan({ cls: 'dsh-tool-icon' });
      setIcon(icon, 'wrench');
      header.createSpan({ cls: 'dsh-tool-name', text: tool.name });
      if (tool.args) header.createSpan({ cls: 'dsh-tool-summary', text: tool.args });
      const status = header.createSpan({ cls: 'dsh-tool-status' });
      if (tool.ok) {
        status.addClass('status-completed');
        setIcon(status, 'check');
      } else {
        status.addClass('status-error');
        setIcon(status, 'x');
      }
      const chevron = header.createSpan({ cls: 'dsh-tool-chevron' });
      setIcon(chevron, 'chevron-right');
      const content = call.createDiv({ cls: 'dsh-tool-content hidden' });
      if (tool.args) content.createDiv({ cls: 'dsh-tool-cmd', text: tool.args });
      const lineText = tool.summary
        ? tool.summary
        : tool.ok ? t('chat.toolNoOutput') : t('chat.toolFailed');
      content.createDiv({ cls: 'dsh-tool-line', text: lineText });
      header.onclick = () => {
        const collapsed = content.hasClass('hidden');
        content.toggleClass('hidden', !collapsed);
        if (collapsed) setIcon(chevron, 'chevron-down');
        else setIcon(chevron, 'chevron-right');
      };
    }
  }

  /** Finalize the streaming message: collapse thinking, render the answer. */
  private finalizeStreamMessage(
    respEl: HTMLElement,
    contentEl: HTMLElement,
    thinkBlock: HTMLElement | null,
    thinkBody: HTMLElement | null,
    thinkingText: string,
    answer: string | null,
  ): void {
    if (thinkBlock && thinkBody) {
      if (thinkingText && thinkingText.trim()) {
        thinkBody.setText(thinkingText);
        // Thinking is live-expanded while running, then auto-collapsed once
        // the answer is complete (user can re-expand it).
        thinkBody.classList.add('hidden');
        const chevron = thinkBlock.querySelector<HTMLElement>('.dsh-think-chevron');
        if (chevron) setIcon(chevron, 'chevron-right');
      } else {
        thinkBlock.remove();
      }
    }
    if (answer) {
      // Linkify for display; the raw answer stays for copy / save-as-note.
      this.renderMarkdownWithLinks(this.linkifyAnswer(answer), contentEl);
      this.addMessageActions(respEl, answer);
    }
    this.scrollToBottom();
  }

  /**
   * Render markdown into the message and wire internal-link clicks.
   *
   * Obsidian only attaches click navigation to [[wikilinks]] inside real
   * markdown preview views — links rendered into a custom ItemView get the
   * correct HTML (hover preview works) but clicking does nothing. Attach the
   * navigation manually after the async render completes.
   */
  private renderMarkdownWithLinks(markdown: string, contentEl: HTMLElement): void {
    void MarkdownRenderer.render(this.app, markdown, contentEl, '', this).then(() => {
      for (const a of Array.from(contentEl.querySelectorAll<HTMLAnchorElement>('a.internal-link'))) {
        const el = a as HTMLAnchorElement & { __dshLinkWired?: boolean };
        if (el.__dshLinkWired) continue;
        el.__dshLinkWired = true;
        el.addEventListener('click', (evt: MouseEvent) => {
          evt.preventDefault();
          const linktext = el.getAttribute('data-href') ?? el.getAttribute('href');
          if (linktext) {
            void this.app.workspace.openLinkText(linktext, '', Keymap.isModEvent(evt));
          }
        });
      }
    });
  }

  private addMessageActions(messageEl: HTMLElement, content: string): void {
    const actions = messageEl.createDiv({ cls: 'dsh-message-actions' });
    const copyBtn = actions.createEl('button', { cls: 'dsh-action-btn' });
    setIcon(copyBtn, 'clipboard-copy');
    copyBtn.setAttribute('aria-label', t('chat.copy'));
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(content);
      new Notice(t('chat.copied'));
    };
    const noteBtn = actions.createEl('button', { cls: 'dsh-action-btn' });
    setIcon(noteBtn, 'file-plus');
    noteBtn.setAttribute('aria-label', t('chat.saveNote'));
    noteBtn.onclick = () => {
      const folder = this.plugin.settings.workdir.trim();
      new NoteCreatorModal(this.app, content, folder).open();
    };
  }

  private scrollToBottom(): void {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  /** Prefill the input (used by the "ask about active note" command). */
  setPendingInput(text: string): void {
    this.editor.setText(text);
    this.editor.focus();
    this.scrollToBottom();
  }

  /**
   * Insert a reference to the currently active note into the input box at the
   * cursor. If text is selected in the note, the selection is quoted as a
   * blockquote (with a source line); otherwise just the wikilink is inserted
   * (Claudian "new conversation" style: reference the note you are reading
   * right now, then ask your question around it).
   */
  insertActiveNoteReference(): void {
    // Use a single source of truth for both path and selection: the currently
    // active markdown view, falling back to the last one we observed (the chat
    // panel may be the active leaf when the icon is clicked).
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) ?? this.lastMarkdownView;
    const file = view?.file ?? this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new Notice(t('chat.noActiveNote'));
      return;
    }
    // Vault-relative path without the .md extension, as an Obsidian wikilink.
    const pathRef = file.path.replace(/\.md$/, '');
    const ref = this.buildNoteReference(pathRef, view);
    this.insertTextAtCursor(ref);
    this.scrollToBottom();
  }

  /** Insert text at the caret with one-space separation from neighbours. */
  private insertTextAtCursor(text: string): void {
    this.editor.insertTextWithSpacing(text);
  }

  /**
   * Build the reference text for the current note. When the markdown editor
   * has a selection, quote it as a blockquote with a source line (truncated
   * when too long); otherwise fall back to a bare wikilink.
   */
  private buildNoteReference(pathRef: string, view: MarkdownView | null): string {
    const selection = view ? this.safeGetSelection(view) : '';
    if (!selection || !selection.trim()) return `[[${pathRef}]]`;
    let body = selection.trim();
    if (body.length > QUOTE_FULL_LIMIT) {
      body = body.slice(0, QUOTE_TRUNCATE_LIMIT) + t('chat.quoteTruncated', { path: pathRef });
    }
    // One "> " line per source line, then a source attribution line.
    const quoted = body.split('\n').map((line) => `> ${line}`).join('\n');
    return `${quoted}\n> ${t('chat.quoteFrom', { path: pathRef })}`;
  }

  /** Selection from a markdown view's editor, or '' if unavailable. */
  private safeGetSelection(view: MarkdownView): string {
    try {
      return view.editor.getSelection() ?? '';
    } catch {
      return '';
    }
  }

  /** Resume an archived session: re-activate it so new turns append back. */
  private async resumeSession(s: import('./history').SessionRecord): Promise<void> {
    const activated = await this.plugin.history?.activateSession(s.id);
    if (!activated) {
      new Notice(t('chat.resumeFail'));
      return;
    }
    // Rebuild context memory from the most recent turns (used for refill).
    this.memory = activated.turns.slice(-20).map((t) => ({
      user: t.user,
      assistant: t.answer.split('\n')[0].slice(0, 200),
    }));
    // Restore the transcript so the conversation is visible again.
    this.messagesContainer.empty();
    for (const t of activated.turns) {
      this.renderMessage('user', t.user);
      this.renderMessage('assistant', t.answer, false, t.thinking, t.tools);
    }
    this.contextMeter?.reset();
    this.scrollToBottom();
    new Notice(t('chat.resumed', { title: activated.title }));
  }

  // ── History panel (floating, anchored to the toolbar icon) ─────────

  private toggleHistoryPanel(): void {
    if (this.historyPanel) {
      this.closeHistoryPanel();
      return;
    }
    this.openHistoryPanel();
  }

  private openHistoryPanel(): void {
    this.closeHistoryPanel();
    this.closeSkillPanel();
    const panel = createDiv({ cls: 'dsh-history-panel' });
    this.historyPanel = panel;

    const sessions = this.plugin.history?.getSessions() ?? [];
    if (sessions.length === 0) {
      panel.createDiv({ cls: 'dsh-history-empty', text: t('chat.historyEmpty') });
    } else {
      for (const s of sessions) {
        const item = panel.createDiv({
          cls: `dsh-history-panel-item${s.pinned ? ' is-pinned' : ''}`,
        });

        // Row 1: bubble icon + title + (rename / pin / delete) icons
        const row1 = item.createDiv({ cls: 'dsh-history-row1' });
        const bubble = row1.createSpan({ cls: 'dsh-history-bubble' });
        setIcon(bubble, 'message-circle');
        const title = row1.createSpan({ cls: 'dsh-history-panel-title', text: s.title });

        const renameBtn = row1.createEl('button', { cls: 'dsh-history-act' });
        setIcon(renameBtn, 'pencil');
        renameBtn.setAttribute('aria-label', t('chat.rename'));
        renameBtn.onclick = (e) => {
          e.stopPropagation();
          this.renameInPanel(item, title, s);
        };

        const pinBtn = row1.createEl('button', { cls: `dsh-history-act${s.pinned ? ' is-active' : ''}` });
        setIcon(pinBtn, 'pin');
        pinBtn.setAttribute('aria-label', s.pinned ? t('chat.unpin') : t('chat.pin'));
        pinBtn.onclick = (e) => {
          e.stopPropagation();
          void this.plugin.history?.togglePin(s.id).then(() => this.openHistoryPanel());
        };

        const delBtn = row1.createEl('button', { cls: 'dsh-history-act' });
        setIcon(delBtn, 'x');
        delBtn.setAttribute('aria-label', t('chat.deleteSession'));
        delBtn.onclick = (e) => {
          e.stopPropagation();
          void this.plugin.history?.removeSession(s.id).then(() => this.openHistoryPanel());
        };

        // Row 2: date + editable note
        const row2 = item.createDiv({ cls: 'dsh-history-row2' });
        row2.createSpan({ cls: 'dsh-history-date', text: new Date(s.endedAt).toLocaleString() });
        const note = row2.createSpan({ cls: 'dsh-history-note', text: s.note || t('chat.addNote') });
        note.onclick = (e) => {
          e.stopPropagation();
          this.editNoteInPanel(note, s);
        };

        // Click the item anywhere (not on a button) → resume the session
        item.onclick = () => {
          this.closeHistoryPanel();
          void this.resumeSession(s);
        };
      }
    }

    document.body.appendChild(panel);

    // Anchor: the panel's bottom-right corner sits against the icon.
    const rect = this.historyBtn.getBoundingClientRect();
    panel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    panel.style.bottom = `${window.innerHeight - rect.top + 4}px`;

    window.setTimeout(() => {
      document.addEventListener('mousedown', this.onPanelOutside);
    }, 0);
    document.addEventListener('keydown', this.onPanelKeydown);
  }

  /** Inline rename of a session title inside the panel. */
  private renameInPanel(item: HTMLElement, titleEl: HTMLElement, s: import('./history').SessionRecord): void {
    const input = createEl('input', { cls: 'dsh-history-rename-input' });
    input.value = s.title;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = (): void => {
      const v = input.value.trim();
      if (v) void this.plugin.history?.renameSession(s.id, v);
      this.openHistoryPanel();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { this.openHistoryPanel(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  /** Inline note editing inside the panel. */
  private editNoteInPanel(noteEl: HTMLElement, s: import('./history').SessionRecord): void {
    const input = createEl('input', { cls: 'dsh-history-note-input' });
    input.value = s.note || '';
    input.placeholder = t('chat.addNote');
    noteEl.replaceWith(input);
    input.focus();
    const commit = (): void => {
      void this.plugin.history?.setNote(s.id, input.value);
      this.openHistoryPanel();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { this.openHistoryPanel(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  private closeHistoryPanel(): void {
    if (this.historyPanel) {
      this.historyPanel.remove();
      this.historyPanel = null;
    }
    document.removeEventListener('mousedown', this.onPanelOutside);
    document.removeEventListener('keydown', this.onPanelKeydown);
  }

  private onPanelOutside = (e: MouseEvent): void => {
    if (this.historyPanel && !this.historyPanel.contains(e.target as Node)) {
      this.closeHistoryPanel();
    }
    if (this.skillPanel && !this.skillPanel.contains(e.target as Node)) {
      this.closeSkillPanel();
    }
  };

  private onPanelKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.closeHistoryPanel();
      this.closeSkillPanel();
    }
  };

  // ── Skill panel (floating, anchored to the toolbar icon) ─────────

  private toggleSkillPanel(): void {
    if (this.skillPanel) {
      this.closeSkillPanel();
      return;
    }
    this.openSkillPanel();
  }

  private openSkillPanel(): void {
    this.closeHistoryPanel();
    this.closeSkillPanel();
    const panel = createDiv({ cls: 'dsh-history-panel dsh-skill-panel' });
    this.skillPanel = panel;

    const skills = this.scanSkills();
    if (skills.length === 0) {
      panel.createDiv({ cls: 'dsh-history-empty', text: t('chat.skillEmpty') });
    } else {
      for (const s of skills) {
        const item = panel.createDiv({ cls: 'dsh-skill-item' });
        const row1 = item.createDiv({ cls: 'dsh-skill-row1' });
        row1.createSpan({ cls: 'dsh-skill-name', text: s.name });
        row1.createSpan({ cls: 'dsh-skill-badge', text: this.skillSourceLabel(s.source) });
        item.createDiv({ cls: 'dsh-skill-desc', text: s.description });
        item.onclick = () => {
          this.closeSkillPanel();
          this.insertTextAtCursor(`/${s.name} `);
          this.scrollToBottom();
        };
      }
    }

    document.body.appendChild(panel);

    // Anchor: same geometry as the history panel.
    const rect = this.skillBtn.getBoundingClientRect();
    panel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    panel.style.bottom = `${window.innerHeight - rect.top + 4}px`;

    window.setTimeout(() => {
      document.addEventListener('mousedown', this.onPanelOutside);
    }, 0);
    document.addEventListener('keydown', this.onPanelKeydown);
  }

  private closeSkillPanel(): void {
    if (this.skillPanel) {
      this.skillPanel.remove();
      this.skillPanel = null;
    }
    document.removeEventListener('mousedown', this.onPanelOutside);
    document.removeEventListener('keydown', this.onPanelKeydown);
  }

  private skillSourceLabel(source: SkillEntry['source']): string {
    switch (source) {
      case 'project': return t('chat.skillSourceProject');
      case 'extra': return t('chat.skillSourceExtra');
      case 'plugin': return t('chat.skillSourcePlugin');
    }
  }

  /** Roots mirroring DSH discovery + user-configured extra directories. */
  private scanSkills(): SkillEntry[] {
    const vaultRoot = this.plugin.getVaultRoot();
    const roots: ScanRoot[] = [
      { dir: path.join(vaultRoot, '.dsh', 'skills'), source: 'project' },
      { dir: path.join(vaultRoot, '.agents', 'skills'), source: 'project' },
      { dir: path.join(this.runner.pluginHomeDir(vaultRoot), 'skills'), source: 'plugin' },
    ];
    for (const rel of this.plugin.settings.extraSkillDirs.split(',')) {
      // Only vault-internal relative directories are scanned: absolute paths
      // and `../` escapes are rejected (see resolveVaultRelativeDir).
      const dir = resolveVaultRelativeDir(vaultRoot, rel);
      if (dir) roots.push({ dir, source: 'extra' });
    }
    return scanSkillRoots(roots);
  }
}
