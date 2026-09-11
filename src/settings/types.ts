import type { Locale } from '../i18n/index';

/**
 * Settings shape and the option tables the UI and the runner share.
 *
 * Split out of settings.ts (review C-2), which mixed three jobs in one 947-line
 * file: the data shape, its validation, and the settings page's markup. This
 * module is the data shape alone — no Obsidian import, no I/O — so anything
 * that only needs to *describe* settings (DshRunner, the chat view's dropdowns)
 * does not drag the settings page in with it.
 *
 * The validation rules live in `./validate`; the page itself is `./index`.
 */

export interface DshSettings {
  dshBin: string;
  nodeBin: string;
  dshHome: string;
  workdir: string;
  timeoutSec: number;
  memoryEnabled: boolean;
  language: 'auto' | Locale;
  customPersona: string;
  /** Tool execution backend: '' (default native) | 'native' | 'code' | 'both'. */
  toolExecutionMode: ToolExecutionMode;
  /**
   * Model id handed to DSH. Free-form by design: it may name a built-in
   * option, or any id the user added to their model list. Validated by
   * character set, not by membership of a list, so an id that only exists on
   * the API (a model DeepSeek shipped after this release) still works.
   *
   * This is the *only* place the active model is stored. An earlier design
   * kept a second `modelCustom` override field, which allowed the dropdown and
   * the free-text box to hold the same id and contradict each other on screen;
   * one value with two editors is worse than one editor.
   */
  model: string;
  /**
   * The model ids offered in the dropdowns, in display order. User-owned and
   * user-editable: they may add a brand-new id or delete a built-in one.
   * Always non-empty after `normalizeStoredSettings` — the plugin needs at
   * least one selectable model to be usable.
   */
  models: string[];
  /** Reasoning effort (one of REASONING_OPTIONS). */
  reasoningEffort: ReasoningEffort;
  /** DSH sandbox mode (one of PERMISSION_OPTIONS). */
  permissionMode: PermissionMode;
  /** Show the thinking (reasoning) block in the chat. */
  showThinking: boolean;
  /** Show tool call blocks in the chat. */
  showTools: boolean;
  /** Max history entries kept (10-200). */
  historyLimit: number;
  /** Ship the built-in `obsidian` DSH skill into the isolated DSH_HOME. */
  obsidianSkill: boolean;
  /** Comma-separated vault-relative extra skill dirs (scanned + passed to DSH). */
  extraSkillDirs: string;
  /** Plugin-only DeepSeek API key; empty = reuse the desktop DSH credentials. */
  apiKey: string;
  /** Provider route used by the plugin's isolated DSH_HOME. Open, because the
   *  user may add a custom provider route in DSH's own Models settings. */
  provider: string;
}

export const DEFAULT_SETTINGS: DshSettings = {
  dshBin: '',
  nodeBin: '',
  dshHome: '~/.dsh',
  workdir: '',
  timeoutSec: 600,
  memoryEnabled: true,
  language: 'auto',
  customPersona: '',
  toolExecutionMode: '',
  model: 'deepseek-flash',
  /**
   * The user-owned model list shown in the dropdowns, in display order.
   *
   * The plugin deliberately does not derive this from anywhere else: an
   * earlier design read the user's `~/.dsh/settings.yaml` catalog, which made
   * the list depend on whether (and in which client) the user had ever opened
   * DSH's own model settings — so the same plugin behaved differently for
   * different people, invisibly. A list the user owns is predictable, works
   * identically under desktop / web / TUI-only installs, and lets a brand-new
   * DeepSeek model be added in one field without waiting for a release.
   */
  models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
  reasoningEffort: 'high',
  permissionMode: 'workspace-write',
  showThinking: true,
  showTools: true,
  historyLimit: 50,
  obsidianSkill: true,
  // Optional by design: novices should not inherit the creator's folders.
  // Examples live in the placeholder/desc; pick via the "Browse…" button.
  extraSkillDirs: '',
  apiKey: '',
  provider: 'deepseek-official',
};

export const PROVIDER_OPTIONS = [
  { id: 'deepseek-official', label: 'DeepSeek 官方 API' },
  { id: 'opencode-go', label: 'OpenCode Go' },
] as const;

/**
 * Known model ids and their display labels.
 *
 * This is no longer the selectable list — that is `DshSettings.models`, which
 * the user owns and edits. This table only supplies (a) the first-run seed and
 * (b) a friendly, localized label for ids it recognises; anything else is shown
 * as its raw id.
 *
 * `deepseek-flash` is DeepSeek's *rolling alias* on the official endpoint —
 * the API repoints that id to its newest model (V4.1 Flash as of 2026-09-10).
 * It is seeded first because that is a useful default, but the plugin makes no
 * "automatically tracks the latest" promise: the alias only rolls on the
 * official API, and a third-party gateway may pin it or not serve it at all.
 * Whether it keeps pointing at the newest model is DeepSeek's business, not
 * something this label should assert.
 *
 * `labelKey` marks entries whose label is UI copy rather than a brand name;
 * brand names stay untranslated (see `modelLabel`). Adding an id here also
 * requires an entry in `MODEL_CONTEXT_WINDOWS` (pure.ts) and in
 * `OPENCODE_GO_PROVIDER_FALLBACK` (dsh-runner.ts) — guarded by tests.
 */
export const MODEL_OPTIONS = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision (Exp)' },
] as const;

export const REASONING_OPTIONS = [
  { id: 'off', label: 'Off' },
  { id: 'high', label: 'High' },
  { id: 'max', label: 'Max' },
] as const;

// Hardcoded English labels, matching the DSH app's security-mode selector
// (kebab-case → Title Case, with "danger-full-access" shown as "Full access").
// Kept intentionally outside i18n: they never change with the UI language.
export const PERMISSION_OPTIONS = [
  { id: 'read-only', label: 'Read Only' },
  { id: 'workspace-write', label: 'Workspace Write' },
  { id: 'danger-full-access', label: 'Full access' },
] as const;

/** Union types derived from the option lists above (see §4.5 of HANDOFF.md). */
/* The `as const` tables above are the single source of these unions (HANDOFF
   §4.5): adding an option there widens the type, and `loadSettings` validates
   stored values against them. */
export type ProviderId = typeof PROVIDER_OPTIONS[number]['id'];
/** The built-in model ids. `DshSettings.model` is deliberately wider — the
 *  user may add any id to their model list. */
export type ModelId = typeof MODEL_OPTIONS[number]['id'];
export type ReasoningEffort = typeof REASONING_OPTIONS[number]['id'];
export type PermissionMode = typeof PERMISSION_OPTIONS[number]['id'];

/**
 * Friendly label for a model id the plugin recognises, else the raw id.
 *
 * Labels are plain brand names and are never localized, so this is a lookup
 * rather than an i18n call — an honest name beats a translated descriptor that
 * could promise something the alias does not guarantee.
 */
export function modelLabel(id: string): string {
  return MODEL_OPTIONS.find((x) => x.id === id)?.label ?? id;
}

/** Tool execution modes ('' = DSH default). Kept as an option list so the type
 *  and the settings dropdown cannot drift apart. */
export const TOOL_EXECUTION_MODES = ['', 'native', 'code', 'both'] as const;
export type ToolExecutionMode = typeof TOOL_EXECUTION_MODES[number];

/** Non-localized labels for the non-empty tool modes ('' shows the localized
 *  'Default (native)' label). */
export const TOOL_EXECUTION_LABELS: Record<Exclude<ToolExecutionMode, ''>, string> = {
  native: 'Native',
  code: 'Code',
  both: 'Both',
};

/** The stored fields validated against an option list at load time (./validate). */
export type OptionFieldKey =
  | 'provider'
  | 'model'
  | 'reasoningEffort'
  | 'permissionMode'
  | 'toolExecutionMode';

/** Label for a permission mode id (used in chat + settings). Never localized. */
export function permissionLabel(id: PermissionMode): string {
  const o = PERMISSION_OPTIONS.find((x) => x.id === id);
  return o ? o.label : id;
}

/** DshSettings keys whose stored value is pattern-checked on load. */
