import * as fs from 'fs';
import * as path from 'path';
import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, setIcon, Menu, MarkdownView, Keymap } from 'obsidian';
import type DshPlugin from '../main';
import { DshClient } from '../dsh/dsh-client';
import { DshRunner, type PreparationIssue } from '../dsh/dsh-runner';
import { buildTitleEntries, linkifyNoteTitles, type NoteInfo, type NoteTitleEntry } from '../core/linkify';
import { scanSkillRoots, type SkillEntry, type ScanRoot } from '../core/skills';
import { SkillSuggest } from './skill-suggest';
import { REASONING_OPTIONS, PERMISSION_OPTIONS, permissionLabel, type PermissionMode } from '../settings/types';
import { modelDisplayLabel, modelOptionsWithCurrent } from '../settings/validate';
import { ContextMeter, estimateTokens } from '../core/context-meter';
import { parseHeadlessOutput, parseDshEventLine, errorHint, contextWindowFor, resolveVaultRelativeDir, frontmatterAliases, partialTurnAnswer, stripCodeFence } from '../dsh/pure';
import { HistoryTool, type HistoryRunStatus, type HistoryTurn } from '../core/history';
import { MentionSuggest } from './mention';
import { ChipEditor } from './chip-editor';
import { HistoryPanel } from './history-panel';
import { SkillPanel } from './skill-panel';
import { t, type TranslationKey } from '../i18n/index';
import { isInside } from '../dsh/paths';
import { OBSIDIAN_SKILL_NAME } from '../core/obsidian-skill';
import { NoteCreatorModal } from './modals';
import { RunController, type RunHandle } from './run-controller';
import { snapshotVault, diffSnapshots, undoChange, type ChangeSnapshot } from '../core/change-tracker';
import { ChangeReviewModal } from './change-review-modal';
import {
  SelectionPreviewModal,
  type SelectionAction,
  type SelectionApplyMode,
} from './selection-modals';

export const VIEW_TYPE_CHAT = 'deepharness-chat';

/** Rough fixed token cost of the vault persona system prompt (built-in rules). */
const PERSONA_FIXED_TOKENS = 200;

/** Selections up to this many characters are quoted in full. */
const QUOTE_FULL_LIMIT = 600;
/** Longer selections are truncated to this many characters. */
const QUOTE_TRUNCATE_LIMIT = 300;

/**
 * Conversation context carried into the next task.
 *
 * dsh runs headless and stateless: every task is a fresh process that sees only
 * the text assembled here (plus the persona and the vault's Harness/memory.md).
 * That makes this the *only* carrier of in-session context, so what it contains
 * decides whether a follow-up question — or a resumed session — can build on
 * earlier turns.
 *
 * It used to contain almost nothing: each turn stored just the assistant
 * answer's first line capped at 200 characters, and the summary took the last 5
 * turns at 80 characters each (≈800 characters in total). Resuming a session
 * therefore looked like it worked while actually starting from scratch.
 */
const MEMORY_CONTEXT = {
  /** How many previous turns are carried into one task in full. */
  turns: 5,
  /**
   * Per-turn character budget for recent turns. Older turns of a resumed
   * session are folded into a separate digest (resumeDigestChars) so the
   * beginning of a long conversation is not silently dropped.
   */
  userChars: 1500,
  assistantChars: 2500,
  /** Turns kept in the in-memory window (history.json keeps the full record). */
  retainTurns: 20,
  /** Character budget for the compressed digest of pre-window resumed turns. */
  resumeDigestChars: 4000,
  /** Per-turn caps inside that digest (one line per older turn). */
  resumeUserChars: 240,
  resumeAssistantChars: 360,
} as const;

/** Fold whitespace so a digest entry stays on one line. */
function clipForDigest(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

interface MemoryTurn {
  user: string;
  assistant: string;
}

/**
 * One memory entry, condensed at the only place that matters: from the full
 * turn text, keeping the head of the user's request and of the assistant's
 * answer (where the substance of a reply lives — the tail is usually a
 * trailing list or sign-off). Both sendMessage and resumeSession build memory
 * through this, so a resumed turn carries exactly what a live one does.
 */
function makeMemoryTurn(user: string, answer: string): MemoryTurn {
  return {
    user: user.slice(0, MEMORY_CONTEXT.userChars),
    assistant: answer.slice(0, MEMORY_CONTEXT.assistantChars),
  };
}

/**
 * Injectable seams for the run path.
 *
 * Production constructs the real client/runner. Tests (and future agents)
 * need to drive the view through `prepareRun -> spawn -> stream -> finish`
 * without launching dsh or writing to the user's real DSH_HOME. Keeping this
 * explicit is what makes the main chain testable: previously the constructor
 * called `new DshClient()` / `new DshRunner()` and a view test could only
 * monkey-patch private fields after the fact.
 */
export interface ChatViewDeps {
  client?: DshClient;
  runner?: DshRunner;
}

/**
 * A selection action waiting for the current run's final answer.
 *
 * `apply` is supplied by the plugin and owns the editor range, so the view
 * never has to hold an `Editor` (which may be replaced when the user switches
 * notes). The view only decides *when* the preview is safe to show.
 */
export interface SelectionRequest {
  action: SelectionAction;
  instruction?: string;
  original: string;
  apply: (replacement: string, mode: SelectionApplyMode) => boolean;
}

/**
 * Everything the history store needs to audit one terminal run. Collected as
 * the run proceeds, then written once in `recordTurn()` so success, failure,
 * cancellation and timeout all leave the same shape of record.
 */
interface RunAudit {
  message: string;
  startedAt: number;
  thinking: string;
  tools: HistoryTool[];
  answer: string;
  status: HistoryRunStatus;
  durationMs: number;
  error?: string;
  exitCode?: number;
  killReason?: 'user' | 'timeout';
  /** Partial stdout kept for an interrupted run. */
  stdout?: string;
}

export class ChatView extends ItemView {
  plugin: DshPlugin;
  private client: DshClient;
  private runner: DshRunner;
  private readonly run = new RunController();
  private selectionRequest: SelectionRequest | null = null;

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
  /**
   * Floating panels, each owning its own open/close state (see
   * floating-panel.ts). Built in onOpen(), because they anchor to the toolbar
   * buttons — an ItemView has no DOM until onOpen runs, so creating them in the
   * constructor would capture `undefined` anchors and every click would throw.
   */
  private historyPanel: HistoryPanel | null = null;
  private skillPanel: SkillPanel | null = null;
  private skillSuggest: SkillSuggest | null = null;
  private statusTimer: number | null = null;
  private statusStartedAt = 0;
  private memory: MemoryTurn[] = [];
  /**
   * Digest of the turns older than the recent-memory window, built when a
   * session is resumed. Kept for the rest of that session so every follow-up
   * still sees the beginning of the conversation, not just the last 5 turns.
   */
  private resumeContext: string[] = [];
  /** True once this view has resumed an archived session. Explicitly resumed
   *  conversations carry context even when automatic memory is disabled. */
  private resumed = false;
  private contextMeter: ContextMeter | null = null;
  private settingsUnsub: (() => void) | null = null;
  private localeUnsub: (() => void) | null = null;
  /** P2-H: cached wikilink title index; invalidated when the vault changes. */
  private linkifyEntries: NoteTitleEntry[] | null = null;
  /** P2-I: cached skill catalog (keyed by scanned roots); invalidated on
   *  vault/settings changes instead of on every panel open / suggestion. */
  private skillCache: { key: string; skills: SkillEntry[] } | null = null;
  /** P2-K: the view (or the plugin) has been torn down. Once true, an
   *  in-flight run's promise must never touch the DOM again — it may only
   *  persist an optional partial turn. Set by onClose() / shutdownForUnload(). */
  private closed = false;

  constructor(leaf: WorkspaceLeaf, plugin: DshPlugin, deps: ChatViewDeps = {}) {
    super(leaf);
    this.plugin = plugin;
    this.client = deps.client ?? new DshClient();
    this.runner = deps.runner
      ?? new DshRunner(plugin.settings, plugin.app.vault.configDir);
    // The plugin walks its open views on unload (Obsidian may skip onClose()),
    // so every view joins the registry at birth and leaves on teardown.
    plugin.registerChatView(this);
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

    // P2-H / P2-I: keep the linkify title index and the skill catalog caches
    // in sync with the vault. Marking them dirty on any vault change is
    // cheaper than scanning the whole vault / skill roots on every render,
    // panel open or "/" suggestion; the scans happen again on next use.
    const invalidateCaches = (): void => {
      this.linkifyEntries = null;
      this.skillCache = null;
    };
    this.registerEvent(this.app.vault.on('create', invalidateCaches));
    this.registerEvent(this.app.vault.on('delete', invalidateCaches));
    this.registerEvent(this.app.vault.on('rename', invalidateCaches));
    this.registerEvent(this.app.vault.on('modify', invalidateCaches));

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

    // The floating panels anchor to those two buttons, so they can only be
    // built now that the toolbar exists (never in the constructor).
    this.historyPanel = new HistoryPanel(this, this.historyBtn);
    this.skillPanel = new SkillPanel(this, this.skillBtn);

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
    this.contextMeter = new ContextMeter(toolbar, this.contextWindow());

    // Send button (capsule)
    this.sendButton = toolbar.createEl('button', { cls: 'dsh-send-btn', text: t('chat.send') });
    this.sendButton.onclick = () => {
      if (this.run.isActive()) {
        this.stopRun();
      } else {
        void this.sendMessage();
      }
    };

    this.updateTriggerLabels();
    // Reflect settings-tab changes (model / effort / permission) into the
    // trigger labels, which otherwise only refresh from our own menus.
    this.settingsUnsub = this.plugin.onSettingsChange(() => {
      // extraSkillDirs feeds the skill catalog — drop the cache so the next
      // panel open / suggestion rescans with the updated roots.
      this.skillCache = null;
      this.updateTriggerLabels();
    });
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
    if (this.sendButton) this.sendButton.setText(this.run.isActive() ? t('chat.stop') : t('chat.send'));
    const welcomeSub = this.messagesContainer.querySelector('.dsh-welcome-sub');
    if (welcomeSub) welcomeSub.textContent = t('chat.welcomeSub');
    this.updateTriggerLabels();
    // Floating panels carry their own localized labels; rebuild any that is open.
    this.historyPanel?.refresh();
    this.skillPanel?.refresh();
  }

  /** Refresh trigger button labels from settings. */
  private updateTriggerLabels(): void {
    if (!this.modelTrigger || !this.securityTrigger) return;
    const r = REASONING_OPTIONS.find((x) => x.id === this.plugin.settings.reasoningEffort);
    const nameEl = this.modelTrigger.querySelector('.dsh-trigger-model-name') as HTMLElement;
    const effortEl = this.modelTrigger.querySelector('.dsh-trigger-effort') as HTMLElement;
    if (nameEl) nameEl.textContent = modelDisplayLabel(this.plugin.settings.model);
    if (effortEl) effortEl.textContent = `· ${r ? r.label : this.plugin.settings.reasoningEffort}`;
    const secLabel = this.securityTrigger.querySelector('.dsh-trigger-security-label') as HTMLElement;
    const p = PERMISSION_OPTIONS.find((x) => x.id === this.plugin.settings.permissionMode);
    if (secLabel) secLabel.textContent = p ? permissionLabel(p.id) : this.plugin.settings.permissionMode;
    this.securityTrigger.toggleClass(
      'dsh-trigger-danger',
      this.plugin.settings.permissionMode === 'danger-full-access',
    );
    // Keep the context meter's denominator in sync with the selected model.
    this.contextMeter?.setContextWindow(this.contextWindow());
  }

  /** Context window of the active model, preferring the user's own DSH catalog. */
  private contextWindow(): number {
    return contextWindowFor(this.plugin.settings.model);
  }

  /**
   * Model + reasoning effort menu (two sections in one popup).
   *
   * The model list is rebuilt on every open rather than captured once, so a
   * model the user adds in DSH shows up without reloading the plugin — that is
   * the whole point of reading the catalog at runtime.
   */
  private showModelMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const current = this.plugin.settings.model;
    for (const m of modelOptionsWithCurrent(this.plugin.settings.models, current)) {
      menu.addItem((item) => item
        .setTitle(m.label)
        .setChecked(m.id === current)
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
  private async applyPermissionMode(mode: PermissionMode): Promise<void> {
    await this.plugin.setPermissionMode(mode);
    this.updateTriggerLabels();
  }

  /** True while this view owns a run; used to keep batches and chats from
   *  writing the same vault at once. */
  isBusy(): boolean {
    return this.run.isActive();
  }

  onClose(): Promise<void> {
    this.teardown();
    this.plugin.unregisterChatView(this);
    return Promise.resolve();
  }

  /**
   * Plugin-unload hook, called by DshPlugin.onunload() for every open chat
   * view. Obsidian does NOT reliably call onClose() on each view before
   * unload, so the plugin walks its view registry explicitly. Idempotent:
   * safe even when Obsidian later calls onClose() as well.
   */
  shutdownForUnload(): void {
    this.teardown();
    this.plugin.unregisterChatView(this);
  }

  /**
   * Shared view teardown (P2-K). Marks the view closed and stops any in-flight
   * run so its promise settles through the closed-view path in sendMessage()
   * — nothing may touch the DOM after this point. abort() reports the
   * interruption as killReason 'user'; dispose() kills the child and drops the
   * client from the plugin's live registry.
   */
  private teardown(): void {
    this.closed = true;
    this.run.dispose();
    this.clearSelectionRequest();
    this.client.dispose();
    this.closePanels();
    this.mention?.dispose();
    this.mention = null;
    this.skillSuggest?.dispose();
    this.skillSuggest = null;
    if (this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    this.settingsUnsub?.();
    this.settingsUnsub = null;
    this.localeUnsub?.();
    this.localeUnsub = null;
  }

  private showWelcome(): void {
    const w = this.messagesContainer.createDiv({ cls: 'dsh-welcome' });
    const icon = w.createDiv({ cls: 'dsh-welcome-icon' });
    setIcon(icon, 'bot');
    w.createDiv({ cls: 'dsh-welcome-title', text: 'DeepHarness' });
    w.createDiv({ cls: 'dsh-welcome-sub', text: t('chat.welcomeSub') });
  }

  private clearChat(): void {
    if (this.run.isActive()) {
      new Notice(t('chat.busy'));
      return;
    }
    this.clearSelectionRequest();
    // Archive the current session into history, then start a new one.
    void this.plugin.history?.endSession();
    this.mention?.close();
    this.skillSuggest?.close();
    this.memory = [];
    this.resumeContext = [];
    this.resumed = false;
    this.contextMeter?.reset();
    this.messagesContainer.empty();
    this.showWelcome();
    new Notice(t('chat.cleared'));
  }

  /**
   * Everything that must be true before a dsh process may be spawned, in one
   * place: locate the binary, node and dsh's real script; make sure the vault
   * has its patch overlays, DSH_HOME, seeded skill and memory file; and collect
   * whatever degraded along the way instead of failing silently.
   *
   * Extracted from sendMessage() (review C-1), which had this interleaved with
   * streaming and result handling in a ~270-line method. Two concrete reasons
   * beyond readability: the four `closed` guards that protect a torn-down view
   * all live here now, and the phase-3 RunController needs this as an explicit
   * step rather than a stretch of code to be untangled later.
   *
   * `ok: false` means "already reported to the user, do not start a run" — the
   * setup error is rendered and announced here, exactly as before.
   */
  private async prepareRun(
    message: string,
  ): Promise<
    | { ok: true; issues: PreparationIssue[]; bin: string; nodeBin: string; dshScript: string;
        task: string; dshHome: string; workdir: string; patchPaths: string[] }
    | { ok: false }
  > {
    const fail = (title: TranslationKey, notice: TranslationKey): { ok: false } => {
      this.renderSetupError(t(title), t(notice));
      new Notice(t(notice), 6000);
      return { ok: false };
    };

    const bin = await this.runner.detectBin();
    // The view may be torn down while we await (close panel / plugin unload):
    // never continue into a dead view — no DOM writes, no spawn.
    if (this.closed) return { ok: false };
    if (!bin) return fail('chat.noDshTitle', 'chat.noDsh');
    // Detect node + dsh's real script so we spawn `node bin.js` directly
    // (bypasses the shebang, which fails under Electron's restricted PATH).
    const nodeBin = await this.runner.detectNode();
    if (this.closed) return { ok: false };
    if (!nodeBin) return fail('chat.noNodeTitle', 'chat.noNode');
    const dshScript = this.runner.resolveDshScript(bin);
    if (!dshScript) return fail('chat.dshNotNodeScriptTitle', 'chat.dshNotNodeScript');

    const vaultRoot = this.plugin.getVaultRoot();
    const task = this.runner.buildTask(
      message,
      this.buildMemorySummary(),
      undefined,
      { forceMemory: this.resumed },
    );
    // Context meter: account for this turn's prompt (system persona +
    // assembled task) right when it is sent.
    if (this.contextMeter) {
      this.contextMeter.addTokens(PERSONA_FIXED_TOKENS + estimateTokens(task));
    }

    // P1-3: preparation-step degradation (fallbacks / failed writes) is
    // collected here and surfaced by the caller before the run starts.
    const issues: PreparationIssue[] = [];
    const patches = await this.runner.ensureVaultPatch(vaultRoot, issues);
    if (this.closed) return { ok: false }; // torn down during patch prep
    const skillDirsPatch = this.runner.ensureSkillDirsPatch(vaultRoot, issues);
    const patchPaths = [patches.persona, patches.think, skillDirsPatch]
      .filter((p): p is string => p !== null);
    // Isolated DSH_HOME with the selected model + reasoning effort;
    // falls back to the user home when it cannot be prepared. Prepared first
    // because the built-in skill below has to be written *into* it: deriving its
    // path separately would target the legacy in-vault location and re-create
    // `dsh-home/` inside the vault.
    const pluginHome = this.runner.ensurePluginDshHome(vaultRoot, {
      model: this.plugin.settings.model,
      effort: this.plugin.settings.reasoningEffort,
    }, issues);
    const dshHome = pluginHome ?? this.runner.dshHome();
    // Built-in obsidian skill + long-term memory seed. The skill goes into the
    // prepared DSH_HOME (system location, or the legacy fallback), where DSH's
    // own skill-filesystem discovers it.
    this.runner.ensureObsidianSkill(vaultRoot, issues, dshHome);
    this.runner.ensureMemoryFile(vaultRoot, issues);
    // Guardrail: the plugin's DSH_HOME must never live inside the vault. It used
    // to, and that made DSH bootstrap its headless profile (400+ symlinks, or
    // tens of thousands of files on Windows) inside a synced folder — the iCloud
    // stall this move exists to fix. If a future change ever puts it back, report
    // it loudly rather than silently re-creating that failure. It is a report and
    // not a hard stop on purpose: the plugin still works, and refusing to run
    // would punish the user for a mistake that is ours.
    if (isInside(dshHome, vaultRoot)) {
      issues.push({
        level: 'warning',
        code: 'dsh-home-inside-vault',
        message: t('chat.degrade.dshHomeInsideVault', { path: dshHome }),
      });
    }
    const workdir = this.runner.workdir(vaultRoot, issues);

    return { ok: true, issues, bin, nodeBin, dshScript, task, dshHome, workdir, patchPaths };
  }

  private async sendMessage(): Promise<void> {
    if (this.plugin.isBatchRunning?.()) {
      new Notice(t('batch.busy'));
      return;
    }
    const message = this.editor.getText().trim();
    if (!message || !this.run.canStart()) {
      if (this.run.isActive()) new Notice(t('chat.busy'));
      return;
    }

    // Claim the lifecycle before any await. If starting fails (a run is
    // already active), the editor and transcript must be left untouched.
    const handle = this.run.start();
    if (!handle) return;

    try {
      this.editor.clear();
      this.renderMessage('user', message);
      this.setButtonToStop();
      await this.executeRun(message, handle);
    } finally {
      // This is the invariant the old `running` boolean was missing: every
      // path — preparation failure, spawn failure, cancel, timeout, close —
      // finishes the controller and returns the composer to Send.
      this.run.finish(handle);
      if (!this.closed) {
        this.resetButtonToSend();
        this.scrollToBottom();
      }
    }
  }

  /**
   * Run one already-claimed turn. Kept separate from `sendMessage()` so the
   * UI bookkeeping above has exactly one cleanup path; `executeRun` may throw
   * and `sendMessage`'s finally still restores the composer.
   */
  private async executeRun(
    message: string,
    handle: RunHandle,
  ): Promise<void> {
    const audit: RunAudit = {
      message,
      startedAt: Date.now(),
      thinking: '',
      tools: [],
      answer: '',
      status: 'failed',
      durationMs: 0,
    };
    const prep = await this.prepareRun(message);
    if (!prep.ok) {
      this.run.fail(handle);
      this.clearSelectionRequest();
      if (!this.closed) {
        audit.error = t('chat.prepareFailed');
        audit.durationMs = Date.now() - audit.startedAt;
        this.recordTurn(audit);
      }
      return;
    }
    // A Stop while preparation was in flight cancels the handle; the late
    // preparation result must not spawn a child or touch the transcript.
    if (!this.run.isCurrent(handle) || !this.run.markRunning(handle)) {
      // Stop landed while preparation was in flight. Nothing spawned, but the
      // user still gets a terminal, auditable turn instead of a silent no-op.
      if (!this.closed) {
        audit.status = 'cancelled';
        audit.durationMs = Date.now() - audit.startedAt;
        audit.answer = t('chat.cancelled');
        this.recordTurn(audit);
      }
      return;
    }
    const { bin, nodeBin, dshScript, task, dshHome, workdir, patchPaths } = prep;
    // P1-3: preparation degraded (DSH_HOME fallback, patch / skill / memory
    // write failures, workdir fallback…) — surface it once instead of running
    // degraded silently.
    if (prep.issues.length > 0) this.renderPreparationIssues(prep.issues);

    // Post-run review needs the pre-spawn text. Selection runs already end in a
    // preview dialog, so they skip this (and avoid stacking two modals).
    const reviewBefore = this.selectionRequest ? null : await this.captureVaultSnapshot();
    // Stop can land while the snapshot is being read; `isCurrent` alone would
    // still be true for the terminal state, so require an active run.
    if (!this.run.isCurrent(handle) || !this.run.isActive()) {
      if (!this.closed) {
        audit.status = 'cancelled';
        audit.durationMs = Date.now() - audit.startedAt;
        audit.answer = t('chat.cancelled');
        this.recordTurn(audit);
      }
      return;
    }

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
    // Metadata is collected independently of the show-tools toggle: hiding the
    // live rows must not hide the run from the audit trail.
    const toolMeta = new Map<string, { name: string; args: string }>();
    const recordedToolIds = new Set<string>();
    const toolsHistory: HistoryTool[] = [];
    let thinkingText = '';
    const handleStreamLine = (line: string): void => {
      // The view/plugin may be torn down between the kill request and the
      // child actually exiting — nothing may stream into a dead DOM (P2-K).
      if (this.closed) return;
      const evt = parseDshEventLine(line);
      if (!evt) return;
      if (evt.t === 'think') {
        thinkingText += evt.text;
        if (thinkBody) {
          thinkBody.setText(thinkingText.length > 4000 ? `…${thinkingText.slice(-4000)}` : thinkingText);
        }
        this.scrollToBottom();
        return;
      }
      // evt.t === 'tool'
      if (evt.status === 'start') {
        toolMeta.set(evt.id, { name: evt.name, args: evt.argsFull ?? evt.args });
        if (!toolsWrap) {
          this.scrollToBottom();
          return;
        }
        // One tool call block: clickable header + expanded content
        const call = toolsWrap.createDiv({ cls: 'dsh-tool-call' });
        const header = call.createEl('button', { cls: 'dsh-tool-header' });
        const icon = header.createSpan({ cls: 'dsh-tool-icon' });
        setIcon(icon, 'wrench');
        header.createSpan({ cls: 'dsh-tool-name', text: evt.name });
        header.createSpan({ cls: 'dsh-tool-summary', text: evt.args });
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
        toolRows.set(evt.id, { status, chevron, content, name: evt.name, args: evt.argsFull ?? evt.args });
      } else {
        const meta = evt.id ? toolMeta.get(evt.id) : undefined;
        const entry = evt.id ? toolRows.get(evt.id) : undefined;
        if (meta && (!evt.id || !recordedToolIds.has(evt.id))) {
          if (evt.id) recordedToolIds.add(evt.id);
          toolsHistory.push({
            name: meta.name,
            args: meta.args,
            ok: evt.ok,
            summary: evt.summary || undefined,
          });
        }
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
        }
      }
      this.scrollToBottom();
    };

    // Status line
    const statusEl = this.createStatusElement();
    this.startStatusTimer(statusEl);

    audit.tools = toolsHistory;
    let turnTs: number | null = null;

    try {
      const result = await this.client.run(task, {
        dshBin: bin,
        nodeBin,
        dshScript,
        cwd: workdir,
        dshHome,
        apiKey: this.plugin.settings.apiKey.trim() || undefined,
        provider: this.plugin.settings.provider,
        toolsMode: this.plugin.settings.toolExecutionMode,
        permissionMode: this.plugin.settings.permissionMode,
        patchPath: patchPaths,
        timeoutMs: this.plugin.settings.timeoutSec * 1000,
        signal: handle.signal,
        onStdoutLine: handleStreamLine,
      });

      this.stopStatusTimer();

      audit.thinking = thinkingText;
      audit.tools = toolsHistory;
      audit.stdout = result.stdout;
      audit.durationMs = result.durationMs;
      audit.exitCode = result.exitCode ?? undefined;
      if (result.killReason) audit.killReason = result.killReason;

      if (this.closed) {
        // P2-K: the view (or the plugin) went away while the task ran. The DOM
        // is gone — never write to it. What the run produced before the kill
        // is kept as a partial turn (when it is worth keeping) instead of
        // being silently dropped.
        this.run.fail(handle);
        this.clearSelectionRequest();
        audit.status = 'interrupted';
        this.savePartialTurn(audit);
      } else if (result.killReason === 'user') {
        // Stopped by the user: keep it subtle — a small status note only.
        this.run.cancel(handle);
        this.clearSelectionRequest();
        statusEl.setText(`⏹ ${t('chat.cancelled')}`);
        this.finalizeStreamMessage(respEl, contentEl, thinkBlock, thinkBody, thinkingText, null);
        audit.status = 'cancelled';
        audit.answer = partialTurnAnswer(result.stdout, thinkingText, toolsHistory.length > 0, t('chat.cancelled')) ?? '';
      } else if (result.killReason === 'timeout') {
        // Auto-stopped after the configured timeout: surface it as an error
        // with its own message, so it is never mistaken for a manual stop.
        this.run.timeout(handle);
        this.clearSelectionRequest();
        const msg = t('chat.timedOut');
        statusEl.setText(`✗ ${msg}`);
        statusEl.addClass('dsh-status-error');
        contentEl.createSpan({ text: `> ❌ ${msg}`, cls: 'dsh-error-inline' });
        this.finalizeStreamMessage(respEl, contentEl, thinkBlock, thinkBody, thinkingText, null);
        audit.status = 'timedOut';
        audit.error = msg;
        audit.answer = partialTurnAnswer(result.stdout, thinkingText, toolsHistory.length > 0, msg) ?? '';
      } else if (result.exitCode !== 0 || !result.stdout.trim()) {
        this.run.fail(handle);
        this.clearSelectionRequest();
        const errMsg = this.extractError(result.stderr);
        statusEl.setText(`✗ ${t('chat.failed', { message: errMsg })}`);
        statusEl.addClass('dsh-status-error');
        contentEl.createSpan({ text: `> ❌ ${t('chat.failed', { message: errMsg })}`, cls: 'dsh-error-inline' });
        this.finalizeStreamMessage(respEl, contentEl, thinkBlock, thinkBody, thinkingText, null);
        audit.status = 'failed';
        audit.error = errMsg;
        audit.answer = partialTurnAnswer(result.stdout, thinkingText, toolsHistory.length > 0, errMsg) ?? '';
      } else {
        this.run.succeed(handle);
        // The stream relay consumed DLEVENT lines live; the remaining stdout
        // is the final answer.
        const answer = parseHeadlessOutput(result.stdout);
        statusEl.setText(`✓ ${t('chat.completed', { duration: String(Math.round(result.durationMs / 1000)) })}`);
        this.finalizeStreamMessage(respEl, contentEl, thinkBlock, thinkBody, thinkingText, answer);
        // Selection runs show a review dialog; nothing is written to the note
        // until the user chooses Replace / Insert below.
        this.showSelectionPreview(answer);
        // Remember this turn for the next task (condensed, not first-line-only:
        // see MEMORY_CONTEXT for why this is the whole context window).
        this.memory.push(makeMemoryTurn(message, answer));
        if (this.memory.length > MEMORY_CONTEXT.retainTurns) this.memory.shift();
        audit.status = 'succeeded';
        audit.answer = answer;
      }

      if (audit.status !== 'interrupted') turnTs = this.recordTurn(audit);
    } catch (e) {
      this.stopStatusTimer();
      this.run.fail(handle);
      this.clearSelectionRequest();
      const msg = e instanceof Error ? e.message : String(e);
      audit.status = 'failed';
      audit.error = msg;
      audit.durationMs = Date.now() - audit.startedAt;
      audit.thinking = thinkingText;
      audit.tools = toolsHistory;
      if (this.closed) {
        audit.status = 'interrupted';
        this.savePartialTurn(audit);
      } else {
        statusEl.setText(`✗ ${t('chat.failed', { message: msg })}`);
        statusEl.addClass('dsh-status-error');
        contentEl.createSpan({ text: `> ❌ ${t('chat.failed', { message: msg })}`, cls: 'dsh-error-inline' });
        this.finalizeStreamMessage(respEl, contentEl, thinkBlock, thinkBody, thinkingText, null);
        turnTs = this.recordTurn(audit);
      }
    }

    // The turn is persisted above without a file list; the diff fills it in
    // afterwards. This keeps a slow vault snapshot off the composer path.
    if (!this.closed && reviewBefore && turnTs !== null) void this.reviewChanges(reviewBefore, turnTs);
  }

  /** Best-effort pre-run snapshot; a failure must never block the task. */
  private async captureVaultSnapshot(): Promise<ChangeSnapshot | null> {
    try {
      return await snapshotVault(this.app);
    } catch {
      return null;
    }
  }

  /**
   * Persist one terminal run. The turn is written before the after-run vault
   * diff so the composer returns to Send immediately; `reviewChanges` fills in
   * `changedFiles` once the snapshot finishes.
   */
  private recordTurn(audit: RunAudit): number {
    const ts = Date.now();
    void this.plugin.history?.addTurn?.({
      ts,
      user: audit.message,
      answer: audit.answer,
      thinking: audit.thinking.trim() || undefined,
      tools: audit.tools.length > 0 ? audit.tools : undefined,
      durationMs: audit.durationMs,
      status: audit.status,
      ...(audit.error ? { error: audit.error } : {}),
      ...(audit.exitCode !== undefined ? { exitCode: audit.exitCode } : {}),
      ...(audit.killReason ? { killReason: audit.killReason } : {}),
    }, {
      model: this.plugin.settings.model,
      effort: this.plugin.settings.reasoningEffort,
      permission: this.plugin.settings.permissionMode,
    });
    return ts;
  }

  /**
   * Compare the vault with the pre-run snapshot and offer an explicit undo.
   * Runs after the turn settles, so opening the modal never delays the answer
   * or the composer returning to Send.
   */
  private async reviewChanges(before: ChangeSnapshot, turnTs: number): Promise<void> {
    try {
      const after = await snapshotVault(this.app);
      const changes = diffSnapshots(before, after);
      if (changes.length > 0) {
        void this.plugin.history?.updateTurn?.(turnTs, {
          changedFiles: changes.map((change) => change.path),
        });
      }
      if (changes.length === 0 || this.closed) return;
      new ChangeReviewModal(
        this.app,
        changes,
        before.incomplete || after.incomplete,
        (change) => undoChange(this.app, change),
      ).open();
    } catch {
      // The run itself already succeeded/failed; a review failure is not worth
      // interrupting the conversation. The next run takes a fresh snapshot.
    }
  }

  /**
   * P2-K: persist an interrupted run (the view was closed / the plugin was
   * unloaded while the task ran) as a partial turn, so reasoning + tool
   * activity produced before the kill is not silently lost. Nothing is
   * recorded when the run produced no content worth keeping.
   */
  private savePartialTurn(audit: RunAudit): number | null {
    const answer = partialTurnAnswer(
      audit.stdout ?? '',
      audit.thinking,
      audit.tools.length > 0,
      t('chat.runInterrupted'),
    );
    if (answer === null) return null; // nothing worth keeping
    audit.answer = answer;
    audit.status = 'interrupted';
    return this.recordTurn(audit);
  }

  /**
   * P1-3: surface degraded preparation (DSH_HOME fallback, failed persona /
   * stream / skill / memory writes, workdir fallback, rejected extra skill
   * dirs) as one system message listing every issue, plus a Notice. The run
   * still proceeds — but the user now sees that some capabilities are missing.
   */
  private renderPreparationIssues(issues: PreparationIssue[]): void {
    const el = this.messagesContainer.createDiv({ cls: 'dsh-message dsh-message-system' });
    const row = el.createDiv({ cls: 'dsh-notice' });
    const icon = row.createSpan({ cls: 'dsh-notice-icon' });
    setIcon(icon, 'alert-triangle');
    const body = row.createDiv({ cls: 'dsh-notice-body' });
    body.createDiv({ text: t('chat.degrade.title'), cls: 'dsh-notice-title' });
    // One line per issue, as list items rather than Markdown bullets: the
    // messages are raw error text and must not be reinterpreted.
    const list = body.createEl('ul', { cls: 'dsh-notice-list' });
    for (const issue of issues) list.createEl('li', { text: issue.message });
    new Notice(t('chat.degrade.notice', { count: String(issues.length) }), 6000);
    this.scrollToBottom();
  }

  private stopRun(): void {
    this.run.cancelCurrent();
    this.client.stop();
  }

  /**
   * Carry the recent conversation into the next task.
   *
   * This is what makes follow-up questions and resumed sessions work: the agent
   * has no other memory of earlier turns. Entries are already condensed to
   * MEMORY_CONTEXT budgets when they are stored, so nothing is re-truncated
   * here.
   */
  private buildMemorySummary(): string[] {
    const blocks: string[] = [];
    // Resumed sessions keep a digest of everything before the recent window.
    // It stays for the rest of the session, not just the first follow-up:
    // DSH is stateless, so every task needs the whole carried context.
    if (this.resumeContext.length > 0) {
      blocks.push(this.resumeContext.join('\n'));
    }
    if (this.memory.length > 0) {
      const recent = this.memory.slice(-MEMORY_CONTEXT.turns);
      const lines = [t('chat.memoryHeader')];
      for (const turn of recent) {
        lines.push(`- ${t('chat.memoryUser')}${turn.user}`);
        if (turn.assistant) lines.push(`  ${t('chat.memoryAssistant')}${turn.assistant}`);
      }
      blocks.push(lines.join('\n'));
    }
    return blocks;
  }

  /**
   * Compress the turns that fall outside the recent-memory window into a
   * bounded digest. Without this a resumed 10-turn session only carried its
   * last 5 turns: the visible transcript looked complete, but the beginning
   * (goals, constraints, earlier files) was invisible to the agent.
   */
  private buildResumeDigest(turns: readonly HistoryTurn[]): string[] {
    const olderCount = Math.max(0, turns.length - MEMORY_CONTEXT.turns);
    if (olderCount === 0) return [];

    const entries = turns
      .slice(0, olderCount)
      .map((turn) => this.formatResumeDigestEntry(turn));
    const header = t('chat.resumeDigestHeader');
    const total = header.length + entries.reduce((sum, entry) => sum + entry.length + 1, 0);

    let selected = entries;
    if (total > MEMORY_CONTEXT.resumeDigestChars) {
      // Keep the beginning (where goals/constraints usually live) and as many
      // of the newest older turns as fit; drop the middle first.
      const first = entries.slice(0, 2);
      const tail: string[] = [];
      let used = header.length + first.reduce((sum, entry) => sum + entry.length + 1, 0);
      for (let i = entries.length - 1; i >= first.length; i -= 1) {
        const entry = entries[i];
        if (used + entry.length + 1 > MEMORY_CONTEXT.resumeDigestChars) break;
        tail.unshift(entry);
        used += entry.length + 1;
      }
      const omitted = entries.length - first.length - tail.length;
      selected = [
        ...first,
        ...(omitted > 0
          ? [t('chat.resumeDigestOmitted', { count: String(omitted) })]
          : []),
        ...tail,
      ];
    }

    return [[header, ...selected].join('\n')];
  }

  private formatResumeDigestEntry(turn: HistoryTurn): string {
    const lines = [
      `- ${t('chat.memoryUser')}${clipForDigest(turn.user, MEMORY_CONTEXT.resumeUserChars)}`,
    ];
    const answer = turn.answer?.trim();
    if (answer) {
      lines.push(`  ${t('chat.memoryAssistant')}${clipForDigest(answer, MEMORY_CONTEXT.resumeAssistantChars)}`);
    }
    const meta: string[] = [];
    if (turn.tools && turn.tools.length > 0) {
      const tools = turn.tools
        .map((tool) => `${tool.name}${tool.ok ? '' : t('chat.resumeToolFailed')}`)
        .join(', ');
      meta.push(`${t('chat.resumeTools')}${tools}`);
    }
    if (turn.changedFiles && turn.changedFiles.length > 0) {
      const files = turn.changedFiles.slice(0, 8).join(', ');
      const more = turn.changedFiles.length > 8
        ? t('chat.resumeFilesMore', { count: String(turn.changedFiles.length - 8) })
        : '';
      meta.push(`${t('chat.resumeFiles')}${files}${more}`);
    }
    if (turn.status && turn.status !== 'succeeded') {
      const status = t(`history.status.${turn.status}` as TranslationKey);
      const error = turn.error ? `: ${clipForDigest(turn.error, 120)}` : '';
      meta.push(`${t('chat.resumeStatus')}${status}${error}`);
    }
    if (meta.length > 0) lines.push(`  ${meta.join('; ')}`);
    return lines.join('\n');
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
    const statusEl = this.messagesContainer.createDiv({ cls: 'dsh-status' });
    statusEl.setText(`${t('chat.starting')} …`);
    this.scrollToBottom();
    return statusEl;
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

  /**
   * Render a blocking setup error as plain DOM instead of Markdown.
   *
   * The previous version emitted `> ⚠️ <text>` through the Markdown renderer.
   * That left the warning glyph at the mercy of emoji-font metrics — it is not
   * sized by anything the plugin controls, and users reported it ballooning
   * until it covered the message — while the container painted
   * `--text-error` on top of `--background-modifier-error`, i.e. red on red,
   * which is barely legible in dark mode.
   *
   * A real SVG icon in a fixed-size box cannot be scaled by a font, and the
   * body text uses the normal foreground colour so it stays readable on the
   * tinted background. The text is not Markdown, so nothing in it can be
   * reinterpreted as a quote, list or emphasis either.
   */
  private renderSetupError(title: string, detail?: string): void {
    const el = this.messagesContainer.createDiv({ cls: 'dsh-message dsh-message-system' });
    const row = el.createDiv({ cls: 'dsh-notice' });
    const icon = row.createSpan({ cls: 'dsh-notice-icon' });
    setIcon(icon, 'alert-triangle');
    const body = row.createDiv({ cls: 'dsh-notice-body' });
    body.createDiv({ text: title, cls: 'dsh-notice-title' });
    if (detail) body.createDiv({ text: detail, cls: 'dsh-notice-detail' });
    this.scrollToBottom();
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
    if (!this.linkifyEntries) {
      this.linkifyEntries = buildTitleEntries(this.collectNoteInfos());
    }
    return linkifyNoteTitles(text, this.linkifyEntries);
  }

  /** Collect one NoteInfo per markdown file (title, path, aliases). */
  private collectNoteInfos(): NoteInfo[] {
    return this.app.vault.getMarkdownFiles().map((f) => {
      let aliases: string[] = [];
      try {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
          | { aliases?: unknown }
          | undefined;
        aliases = frontmatterAliases(fm?.aliases);
      } catch {
        // metadata read failure: link by title only
      }
      return {
        name: f.basename,
        path: f.path.replace(/\.md$/, ''),
        aliases,
      };
    });
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

  /** Public for SkillPanel: jumping to the composer after inserting a skill. */
  scrollToBottom(): void {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  /** Prefill the input (used by the "ask about active note" command). */
  setPendingInput(text: string): void {
    this.editor.setText(text);
    this.editor.focus();
    this.scrollToBottom();
  }

  /**
   * Start a selection action chosen by the plugin's "selection" command.
   *
   * The prompt is sent immediately (the user already picked an action in the
   * modal); the result is never applied automatically. `SelectionPreviewModal`
   * is opened only after this run succeeds.
   */
  beginSelectionAction(request: SelectionRequest): void {
    if (this.plugin.isBatchRunning?.()) {
      new Notice(t('batch.busy'));
      return;
    }
    if (!this.editor) {
      new Notice(t('chat.noChatView'));
      return;
    }
    if (!this.run.canStart()) {
      new Notice(t('chat.busy'));
      return;
    }
    this.selectionRequest = request;
    const instruction = request.action === 'custom'
      ? (request.instruction ?? '')
      : this.selectionInstruction(request.action);
    this.setPendingInput(t('selection.promptTemplate', {
      instruction,
      text: request.original,
    }));
    void this.sendMessage();
  }

  private selectionInstruction(action: Exclude<SelectionAction, 'custom'>): string {
    switch (action) {
      case 'rewrite':
        return t('selection.prompt.rewrite');
      case 'summarize':
        return t('selection.prompt.summarize');
      case 'explain':
        return t('selection.prompt.explain');
    }
  }

  /**
   * Show the preview for the run that just succeeded, then forget it. Called
   * only from the success branch: failed/cancelled runs must not leave a
   * stale request that would capture the next ordinary answer.
   */
  private showSelectionPreview(answer: string): void {
    const request = this.selectionRequest;
    this.selectionRequest = null;
    if (!request) return;
    const cleaned = stripCodeFence(answer);
    new SelectionPreviewModal(
      this.app,
      request.original,
      cleaned,
      (replacement, mode) => request.apply(replacement, mode),
    ).open();
  }

  private clearSelectionRequest(): void {
    this.selectionRequest = null;
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

  /** Insert text at the caret with one-space separation from neighbours.
   *  Public for SkillPanel: insert `/skill ` at the caret. */
  insertTextAtCursor(text: string): void {
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

  /** Resume an archived session: re-activate it so new turns append back, and
   *  rebuild the context the agent needs to continue it. Public for
   *  HistoryPanel: clicking a session row resumes it. */
  async resumeSession(s: import('../core/history').SessionRecord): Promise<void> {
    const activated = await this.plugin.history?.activateSession(s.id);
    if (!activated) {
      new Notice(t('chat.resumeFail'));
      return;
    }
    // Rebuild the conversation context from the archived turns. Without this the
    // resumed session would look right but answer as if nothing had been said:
    // the agent only ever sees what buildMemorySummary() carries into the task.
    this.resumed = true;
    this.resumeContext = this.buildResumeDigest(activated.turns);
    this.memory = activated.turns
      .slice(-MEMORY_CONTEXT.retainTurns)
      .map((t) => makeMemoryTurn(t.user, t.answer));
    // Restore the transcript so the conversation is visible again.
    this.messagesContainer.empty();
    for (const t of activated.turns) {
      this.renderMessage('user', t.user);
      this.renderMessage('assistant', t.answer, false, t.thinking, t.tools);
    }
    this.contextMeter?.reset();
    this.scrollToBottom();
    new Notice(t('chat.resumed', { title: activated.title }));
    const olderCount = Math.max(0, activated.turns.length - MEMORY_CONTEXT.turns);
    if (olderCount > 0) {
      new Notice(t('chat.resumedCompressed', { count: String(olderCount) }), 6000);
    }
    if (!this.plugin.settings.memoryEnabled) {
      new Notice(t('chat.resumeMemoryForced'), 6000);
    }
  }

  // ── Floating panels (see floating-panel.ts / *-panel.ts) ───────────

  /**
   * The panels exist once onOpen() has built the toolbar. Callers that can run
   * before that (teardown, locale change) must tolerate their absence; a click
   * cannot happen without a rendered toolbar, so the panel must be there.
   */
  private requireHistoryPanel(): HistoryPanel {
    if (!this.historyPanel) throw new Error('HistoryPanel used before onOpen() built the toolbar');
    return this.historyPanel;
  }

  private requireSkillPanel(): SkillPanel {
    if (!this.skillPanel) throw new Error('SkillPanel used before onOpen() built the toolbar');
    return this.skillPanel;
  }

  private toggleHistoryPanel(): void {
    this.requireHistoryPanel().toggle();
  }

  private toggleSkillPanel(): void {
    this.requireSkillPanel().toggle();
  }

  private closeHistoryPanel(): void {
    this.historyPanel?.close();
  }

  private closeSkillPanel(): void {
    this.skillPanel?.close();
  }

  /** Close whichever panel is open (Escape, teardown). */
  private closePanels(): void {
    this.historyPanel?.close();
    this.skillPanel?.close();
  }

  /** Public for SkillPanel: localized label for a skill's source badge. */
  skillSourceLabel(source: SkillEntry['source']): string {
    switch (source) {
      case 'builtin': return t('chat.skillSourceBuiltin');
      case 'vault': return t('chat.skillSourceVault');
      case 'custom': return t('chat.skillSourceCustom');
    }
  }

  /** Roots mirroring DSH discovery + user-configured extra directories. */
  private scanRoots(vaultRoot: string): ScanRoot[] {
    // One home for vault-scoped skills, outside the vault: the plugin's DSH_HOME
    // (`~/.dsh/deepharness/<vaultKey>/skills`). It used to be scattered across
    // `<vault>/.dsh/skills`, `<vault>/.agents/skills` and the plugin folder,
    // which made "where do I put a skill?" unclear and put skill files inside
    // synced folders. The built-in obsidian skill lives here too, in its own
    // subfolder, so the panel and DSH's own skill-filesystem see one tree.
    const roots: ScanRoot[] = [
      { dir: path.join(this.runner.pluginDshHome(vaultRoot), 'skills'), source: 'vault' },
    ];
    for (const rel of this.plugin.settings.extraSkillDirs.split(',')) {
      // Only vault-internal relative directories are scanned: absolute paths
      // and `../` escapes are rejected (see resolveVaultRelativeDir).
      const dir = resolveVaultRelativeDir(vaultRoot, rel);
      if (dir) roots.push({ dir, source: 'custom' });
    }
    return roots;
  }

  /**
   * Skill catalog for the 🔧 panel and the "/" suggestions. Cached (P2-I):
   * the sync readdirSync/readFileSync scan only reruns after a vault change
   * or an extraSkillDirs edit, not on every panel open / popup trigger.
   */
  /** Public for SkillPanel: the cached catalog (P2-I), shared so the panel
   *  never triggers its own filesystem walk. */
  scanSkills(): SkillEntry[] {
    const vaultRoot = this.plugin.getVaultRoot();
    // Key covers every input of the scan; cheap to compute per call. It must
    // include each root's *contents*: the vault skills folder is the one users
    // add skills to, and nothing in settings changes when they do, so a key of
    // settings alone kept the panel stale until a reload.
    const rootDirs = this.scanRoots(vaultRoot).map((r) => r.dir);
    const contents = rootDirs.map((dir) => {
      try {
        return `${dir}:${fs.readdirSync(dir).sort().join(',')}`;
      } catch {
        return `${dir}:missing`; // not created yet is a valid state
      }
    }).join('\u0000');
    const key = `${vaultRoot}\u0000${this.plugin.settings.extraSkillDirs.trim()}\u0000${contents}`;
    if (this.skillCache && this.skillCache.key === key) return this.skillCache.skills;
    const skills = scanSkillRoots(this.scanRoots(vaultRoot))
      // The built-in obsidian skill lives in the same folder as this vault's
      // skills (one tree, one answer to "where do my skills go"), so it has to
      // be re-labelled here or the panel would present the plugin's own skill as
      // something the user wrote.
      .map((s) => (s.name === OBSIDIAN_SKILL_NAME ? { ...s, source: 'builtin' as const } : s));
    this.skillCache = { key, skills };
    return skills;
  }
}
