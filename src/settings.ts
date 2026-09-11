import { App, Notice, Platform, PluginSettingTab, Setting, requestUrl, type DropdownComponent, type SettingDefinitionItem, type SettingDefinitionRender, type TextComponent } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type DshPlugin from './main';
import { t, Locale, type TranslationKey } from './i18n';
import { DshRunner } from './dsh-runner';
import { DiagnosticPromptModal, FolderSuggestModal } from './modals';
import { isSafeModelId, isSafeProviderId } from './dsh-config';
import { comparePluginVersion, fetchLatestRelease, type PluginUpdateStatus } from './updates';
import {
  buildCheckOutcomes,
  buildRepairPrompt,
  CHECK_HINT_KEYS,
  CHECK_LABEL_KEYS,
  hasFailures,
  type CheckOutcome,
  type WriteProbe,
} from './diagnostics';

/** Return an error message when a directory cannot be created/written. */
function checkWritableDir(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.deepharness-write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Return an error message when an existing file cannot be opened for writing.
 *  A missing settings.yaml is allowed if its parent directory is writable. */
function checkWritableFile(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return checkWritableDir(path.dirname(file));
    const fd = fs.openSync(file, 'r+');
    fs.closeSync(fd);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

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
const TOOL_EXECUTION_LABELS: Record<Exclude<ToolExecutionMode, ''>, string> = {
  native: 'Native',
  code: 'Code',
  both: 'Both',
};

/** Label for a permission mode id (used in chat + settings). Never localized. */
export function permissionLabel(id: PermissionMode): string {
  const o = PERMISSION_OPTIONS.find((x) => x.id === id);
  return o ? o.label : id;
}

/** DshSettings keys whose stored value is pattern-checked on load. */
export type OptionFieldKey =
  | 'provider'
  | 'model'
  | 'reasoningEffort'
  | 'permissionMode'
  | 'toolExecutionMode';

const REASONING_IDS: readonly string[] = REASONING_OPTIONS.map((o) => o.id);
const PERMISSION_IDS: readonly string[] = PERMISSION_OPTIONS.map((o) => o.id);
const TOOL_MODE_IDS: readonly string[] = [...TOOL_EXECUTION_MODES];

/**
 * Load-time validator per stored key.
 *
 * `model` and `provider` used to be closed enums, and that membership check
 * doubled as the YAML injection guard: both values are pasted straight into
 * the generated `settings.yaml`. They are open now — the user may type any
 * model id, and DSH may declare any provider route — so the guard moves from
 * "is in a fixed list" to an explicit character-set check
 * (`isSafeModelId` / `isSafeProviderId`). The genuinely closed fields keep
 * their list check.
 */
const FIELD_VALIDATORS: Record<OptionFieldKey, (value: unknown) => boolean> = {
  provider: (v) => typeof v === 'string' && isSafeProviderId(v),
  model: (v) => typeof v === 'string' && isSafeModelId(v),
  reasoningEffort: (v) => typeof v === 'string' && REASONING_IDS.includes(v),
  permissionMode: (v) => typeof v === 'string' && PERMISSION_IDS.includes(v),
  toolExecutionMode: (v) => typeof v === 'string' && TOOL_MODE_IDS.includes(v),
};

/**
 * Display label for a model id.
 *
 * Ids the plugin recognises get a friendly label; anything else is shown as
 * its raw id, which is the honest answer for a value the user typed
 * themselves — no guessing, and no label that promises more than it can keep.
 */
export function modelDisplayLabel(id: string): string {
  return MODEL_OPTIONS.some((m) => m.id === id) ? modelLabel(id) : id;
}

/** The dropdown contents for a user-owned model list. */
export function buildModelOptions(models: readonly string[]): { id: string; label: string }[] {
  return models.map((id) => ({ id, label: modelDisplayLabel(id) }));
}

/** The provider dropdown's contents. Providers are still a fixed pair. */
export function buildProviderOptions(): { id: string; label: string }[] {
  return PROVIDER_OPTIONS.map((p) => ({ id: p.id, label: p.label }));
}

/**
 * The model list as the dropdown needs it, with the selected id guaranteed to
 * be present.
 *
 * `normalizeStoredSettings` keeps `model` inside `models`, so this is a
 * belt-and-braces guard for the window between a delete and the next save:
 * Obsidian is told to `setValue` the active id, and a value with no matching
 * option would leave the control blank and misreport the active model.
 */
export function modelOptionsWithCurrent(
  models: readonly string[],
  current: string,
): { id: string; label: string }[] {
  const out = buildModelOptions(models);
  if (current && !out.some((o) => o.id === current)) {
    out.push({ id: current, label: modelDisplayLabel(current) });
  }
  return out;
}

/**
 * Merge imported ids into the list, keeping the user's order and dropping
 * anything already present.
 *
 * Used by the explicit "import from DSH" action. Duplicates are the common
 * case — a stock catalog overlaps the seed almost entirely — so the result is
 * the caller's list plus only what is genuinely new.
 */
export function mergeModelIds(
  existing: readonly string[],
  incoming: readonly string[],
): { models: string[]; added: string[] } {
  const seen = new Set(existing);
  const models = [...existing];
  const added: string[] = [];
  for (const id of incoming) {
    if (!isSafeModelId(id) || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    added.push(id);
  }
  return { models, added };
}

/**
 * P1-5: validate settings read from the plugin data file and fall back to the
 * DEFAULT_SETTINGS value whenever a stored field is unusable (a model id no
 * longer valid, a hand-edited data.json, a value that could not be written
 * into the generated YAML safely). Non-option fields keep their stored values.
 * `reset` lists the fields that were corrected, so the caller can heal the
 * file and surface one notice.
 */
export function normalizeStoredSettings(
  raw: unknown,
): { settings: DshSettings; reset: OptionFieldKey[] } {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored) as DshSettings;
  const reset: OptionFieldKey[] = [];
  // One-release migration: `modelCustom` was a second, competing home for the
  // active model. Its value is already reflected in `model` (or was a
  // duplicate of it), so dropping the key loses nothing a user can observe —
  // and leaving it behind would keep a stale override lying in data.json.
  delete (settings as unknown as Record<string, unknown>).modelCustom;
  // Fallbacks are written through a plain record: fields here are validated
  // dynamically, and TypeScript cannot assign across distinct union keys via
  // a single index access (their intersection is `never`).
  const target = settings as unknown as Record<string, unknown>;
  for (const field of Object.keys(FIELD_VALIDATORS) as OptionFieldKey[]) {
    if (!Object.prototype.hasOwnProperty.call(stored, field)) continue;
    if (!FIELD_VALIDATORS[field](stored[field])) {
      target[field] = DEFAULT_SETTINGS[field];
      reset.push(field);
    }
  }

  // The model list is user-owned, so it is sanitized rather than validated
  // against a fixed set: unusable ids are dropped (they could not be written
  // into the generated YAML), duplicates collapse, and order is preserved.
  // An empty or unreadable list falls back to the seed, because the plugin
  // needs at least one selectable model to be usable at all.
  const rawList = stored.models;
  if (Array.isArray(rawList)) {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const entry of rawList) {
      if (typeof entry !== 'string') continue;
      const id = entry.trim();
      if (!isSafeModelId(id) || seen.has(id)) continue;
      seen.add(id);
      list.push(id);
    }
    settings.models = list.length > 0 ? list : [...DEFAULT_SETTINGS.models];
  } else {
    settings.models = [...DEFAULT_SETTINGS.models];
  }

  // Keep the selection selectable. Adding it is the right repair rather than
  // replacing it: `model` may come from a data.json written before the list
  // existed (or a hand edit), and silently switching the user to a different
  // model would change what the agent runs behind their back. Only a value
  // that could not be written to the generated YAML at all is replaced.
  if (!settings.models.includes(settings.model)) {
    if (isSafeModelId(settings.model)) {
      settings.models = [...settings.models, settings.model];
    } else {
      settings.model = settings.models[0];
    }
  }

  return { settings, reset };
}

export class DshSettingTab extends PluginSettingTab {
  plugin: DshPlugin;

  constructor(app: App, plugin: DshPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const render = (
      name: string,
      desc: string | undefined,
      fn: (setting: Setting) => void,
    ): SettingDefinitionRender => ({
      name,
      ...(desc ? { desc } : {}),
      render: fn,
    });

    // The model list editor adds and removes rows imperatively, so it needs
    // the live dropdown handle and the "new model" input to redraw them in
    // place: the settings tab is not re-rendered on change.
    let modelDropdown: DropdownComponent | null = null;
    let newModelText: TextComponent | null = null;

    return [
      {
        type: 'group',
        heading: t('settings.groupGeneral'),
        items: [
          render(t('settings.language.name'), t('settings.language.desc'), (setting) => {
            setting.addDropdown((dd) => {
              dd.addOption('auto', 'Auto');
              dd.addOption('en', 'English');
              dd.addOption('zh', '中文');
              dd.setValue(s.language).onChange(async (value) => {
                s.language = value as DshSettings['language'];
                // Apply the locale BEFORE persisting: saveSettings() notifies
                // settings listeners (chat trigger labels), which must render
                // in the NEW language rather than the old one.
                this.plugin.applyLocale();
                await this.plugin.saveSettings();
                this.update();
              });
            });
          }),

          render(t('settings.workdir.name'), t('settings.workdir.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.workdir.placeholder'))
              .setValue(s.workdir)
              .onChange(async (value) => {
                s.workdir = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.timeout.name'), t('settings.timeout.desc'), (setting) => {
            setting.addSlider((slider) => slider
              .setLimits(30, 1800, 30)
              .setValue(s.timeoutSec)
              .onChange(async (value) => {
                s.timeoutSec = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.memory.name'), t('settings.memory.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(s.memoryEnabled)
              .onChange(async (value) => {
                s.memoryEnabled = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.historyLimit.name'), t('settings.historyLimit.desc'), (setting) => {
            setting.addSlider((slider) => slider
              .setLimits(10, 200, 10)
              .setValue(s.historyLimit)
              .onChange(async (value) => {
                s.historyLimit = value;
                await this.plugin.saveSettings();
                this.plugin.history?.setLimit(value);
              }));
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupModel'),
        items: [
          render(t('settings.provider.name'), t('settings.provider.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const p of buildProviderOptions()) {
                dd.addOption(p.id, p.label);
              }
              dd.setValue(s.provider).onChange(async (value) => {
                s.provider = value;
                await this.plugin.saveSettings();
              });
            });
          }),

          render(t('settings.model.name'), t('settings.model.desc'), (setting) => {
            const options = modelOptionsWithCurrent(s.models, s.model);
            setting.addDropdown((dd) => {
              modelDropdown = dd;
              for (const m of options) dd.addOption(m.id, m.label);
              dd.setValue(s.model).onChange(async (value) => {
                if (value === s.model) return;
                s.model = value;
                await this.plugin.saveSettings();
              });
            });
          }),

          // The model list is user-grown, so it is the one control that can
          // become arbitrarily tall. It lives in a bounded, scrollable box and
          // the row is stacked (description on top, controls underneath) so
          // importing a large catalog cannot stretch the settings page.
          render(t('settings.modelList.name'), t('settings.modelList.desc'), (setting) => {
            setting.settingEl.addClass('dsh-setting-stacked');

            const box = setting.settingEl.createDiv({ cls: 'dsh-model-box' });
            const rows = box.createDiv({ cls: 'dsh-model-list' });
            const countEl = box.createDiv({ cls: 'dsh-model-count' });

            const redraw = (): void => {
              rows.empty();
              for (const id of s.models) {
                const row = rows.createDiv({ cls: 'dsh-model-row' });
                row.createSpan({ text: modelDisplayLabel(id), cls: 'dsh-model-row-label' });
                row.createSpan({ text: id, cls: 'dsh-model-row-id' });
                const del = row.createEl('button', {
                  text: t('settings.modelList.remove'),
                  cls: 'dsh-model-row-remove',
                });
                // Keep at least one model: an empty dropdown would leave the
                // plugin with nothing to run and no obvious way back.
                del.disabled = s.models.length <= 1;
                del.onclick = async () => {
                  s.models = s.models.filter((x) => x !== id);
                  // Deleting the active model is an explicit act, so switching
                  // the selection to the first survivor is expected here (the
                  // load-time normalizer never switches it silently).
                  if (s.model === id) s.model = s.models[0];
                  await this.plugin.saveSettings();
                  redraw();
                  refreshDropdown();
                };
              }
              countEl.setText(t('settings.modelList.count', { count: String(s.models.length) }));
            };

            // Rebuild the dropdown in place so a removal or addition shows up
            // without closing the settings tab.
            const refreshDropdown = (): void => {
              const dd = modelDropdown;
              if (!dd) return;
              dd.selectEl.empty();
              for (const m of modelOptionsWithCurrent(s.models, s.model)) {
                dd.addOption(m.id, m.label);
              }
              dd.setValue(s.model);
            };

            setting.addText((text) => {
              text.setPlaceholder(t('settings.modelList.placeholder'));
              newModelText = text;
            });
            setting.addButton((button) => button
              .setButtonText(t('settings.modelList.add'))
              .setCta()
              .onClick(async () => {
                const input = newModelText;
                const next = input?.getValue().trim() ?? '';
                if (!next) return;
                if (!isSafeModelId(next)) {
                  input?.inputEl.addClass('dsh-input-invalid');
                  if (input) input.inputEl.title = t('settings.modelList.invalid');
                  return;
                }
                input?.inputEl.removeClass('dsh-input-invalid');
                if (input) input.inputEl.title = '';
                s.models = mergeModelIds(s.models, [next]).models;
                input?.setValue('');
                await this.plugin.saveSettings();
                redraw();
                refreshDropdown();
              }));
            setting.addButton((button) => button
              .setButtonText(t('settings.modelList.import'))
              .setTooltip(t('settings.modelList.importTooltip'))
              .onClick(async () => {
                // Explicit, never automatic: this is the only place the plugin
                // reads the user's DSH catalog, so someone running TUI-only (or
                // who never opened DSH's model settings) is unaffected by it.
                const runner = new DshRunner(
                  this.plugin.settings,
                  this.plugin.app.vault.configDir,
                );
                const found = (runner.userDshConfig()?.models ?? []).map((m) => m.id);
                const { models, added } = mergeModelIds(s.models, found);
                s.models = models;
                await this.plugin.saveSettings();
                redraw();
                refreshDropdown();
                new Notice(added.length > 0
                  ? t('settings.modelList.imported', { count: String(added.length) })
                  : t('settings.modelList.importNone'));
              }));

            // Move the box above the controls: Obsidian appends the control row
            // in the Setting constructor, and the list reads better between the
            // description and the add/import controls.
            const control = setting.settingEl.querySelector('.setting-item-control');
            if (control) {
              setting.settingEl.insertBefore(box, control);
            }

            redraw();
          }),

          render(t('settings.reasoning.name'), t('settings.reasoning.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const r of REASONING_OPTIONS) dd.addOption(r.id, r.label);
              dd.setValue(s.reasoningEffort).onChange(async (value) => {
                s.reasoningEffort = value as ReasoningEffort;
                await this.plugin.saveSettings();
              });
            });
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupPermission'),
        items: [
          render(t('settings.permission.name'), t('settings.permission.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const p of PERMISSION_OPTIONS) dd.addOption(p.id, permissionLabel(p.id));
              dd.setValue(s.permissionMode).onChange(async (value) => {
                await this.plugin.setPermissionMode(value as PermissionMode);
                dd.setValue(s.permissionMode);
              });
            });
          }),

          render(t('settings.toolMode.name'), t('settings.toolMode.desc'), (setting) => {
            setting.addDropdown((dd) => {
              for (const mode of TOOL_EXECUTION_MODES) {
                const label = mode === '' ? t('settings.toolModeDefault') : TOOL_EXECUTION_LABELS[mode];
                dd.addOption(mode, label);
              }
              dd.setValue(s.toolExecutionMode).onChange(async (value) => {
                s.toolExecutionMode = value as ToolExecutionMode;
                await this.plugin.saveSettings();
              });
            });
          }),

          render(t('settings.showThinking.name'), t('settings.showThinking.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(s.showThinking)
              .onChange(async (value) => {
                s.showThinking = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.showTools.name'), t('settings.showTools.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(s.showTools)
              .onChange(async (value) => {
                s.showTools = value;
                await this.plugin.saveSettings();
              }));
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupSkills'),
        items: [
          render(t('settings.obsidianSkill.name'), t('settings.obsidianSkill.desc'), (setting) => {
            setting.addToggle((toggle) => toggle
              .setValue(s.obsidianSkill)
              .onChange(async (value) => {
                s.obsidianSkill = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.extraSkillDirs.name'), t('settings.extraSkillDirs.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.extraSkillDirs.placeholder'))
              .setValue(s.extraSkillDirs)
              .onChange(async (value) => {
                s.extraSkillDirs = value;
                await this.plugin.saveSettings();
              }));
            // Folder picker: novice-friendly way to add vault folders without
            // typing a path (picked folders are vault-internal by construction).
            setting.addButton((button) => button
              .setButtonText(t('settings.extraSkillDirs.pick'))
              .onClick(() => {
                new FolderSuggestModal(this.app, (picked) => {
                  const existing = s.extraSkillDirs.split(',').map((x) => x.trim()).filter(Boolean);
                  if (!existing.includes(picked)) existing.push(picked);
                  s.extraSkillDirs = existing.join(', ');
                  void this.plugin.saveSettings();
                  this.update();
                }).open();
              }));
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupPersona'),
        items: [
          render(t('settings.persona.name'), t('settings.persona.desc'), (setting) => {
            setting.addTextArea((text) => {
              text
                .setPlaceholder(t('settings.persona.placeholder'))
                .setValue(s.customPersona)
                .onChange(async (value) => {
                  s.customPersona = value;
                  await this.plugin.saveSettings();
                });
              text.inputEl.rows = 3;
            });
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupRuntime'),
        items: [
          render(t('settings.dshBin.name'), t('settings.dshBin.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.dshBin.placeholder'))
              .setValue(s.dshBin)
              .onChange(async (value) => {
                s.dshBin = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.nodeBin.name'), t('settings.nodeBin.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.nodeBin.placeholder'))
              .setValue(s.nodeBin)
              .onChange(async (value) => {
                s.nodeBin = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.dshHome.name'), t('settings.dshHome.desc'), (setting) => {
            setting.addText((text) => text
              .setPlaceholder(t('settings.dshHome.placeholder'))
              .setValue(s.dshHome)
              .onChange(async (value) => {
                s.dshHome = value;
                await this.plugin.saveSettings();
              }));
          }),

          render(t('settings.apiKey.name'), t('settings.apiKey.desc'), (setting) => {
            // P2-D: surface the plaintext-storage risk while a plugin key is set
            // (data.json lives inside the vault, so it syncs with the vault).
            const warningEl = setting.descEl.createDiv({ cls: 'dsh-setting-warning' });
            warningEl.setText(t('settings.apiKey.warning'));
            const applyWarning = (): void => {
              warningEl.style.display = s.apiKey ? '' : 'none';
            };
            applyWarning();
            setting.addText((text) => {
              text
                .setPlaceholder(t('settings.apiKey.placeholder'))
                .setValue(s.apiKey)
                .onChange(async (value) => {
                  s.apiKey = value.trim();
                  await this.plugin.saveSettings();
                  applyWarning();
                });
              text.inputEl.type = 'password';
              text.inputEl.autocomplete = 'off';
            });
          }),

        ],
      },
      {
        type: 'group',
        heading: t('settings.groupUpdates'),
        items: [
          render(t('settings.update.name'), t('settings.update.desc'), (setting) => {
            const current = this.plugin.manifest.version;
            const statusEl = setting.settingEl.createEl('p', { cls: 'dsh-check-ok' });
            statusEl.setText(t('settings.update.current', { version: current }));

            setting.addButton((button) => button
              .setButtonText(t('settings.update.check'))
              .onClick(async () => {
                button.setDisabled(true);
                statusEl.removeClass('dsh-check-ok', 'dsh-check-fail', 'dsh-check-warn');
                statusEl.setText(t('settings.update.checking'));
                // Only on explicit user action: GitHub rate-limits
                // unauthenticated callers to ~60 requests per hour per IP.
                let status: PluginUpdateStatus;
                try {
                  const { release, error } = await fetchLatestRelease(requestUrl);
                  status = comparePluginVersion(current, release, error ?? undefined);
                } catch (e) {
                  status = {
                    kind: 'check-failed',
                    current,
                    error: e instanceof Error ? e.message : String(e),
                  };
                }
                statusEl.removeClass('dsh-check-ok', 'dsh-check-fail', 'dsh-check-warn');
                if (status.kind === 'update-available') {
                  statusEl.addClass('dsh-check-warn');
                  statusEl.setText(t('settings.update.available', {
                    current: status.current,
                    latest: status.latest,
                  }));
                  new Notice(t('settings.update.notice'));
                } else if (status.kind === 'up-to-date') {
                  statusEl.addClass('dsh-check-ok');
                  statusEl.setText(t('settings.update.latest', { version: status.current }));
                } else {
                  statusEl.addClass('dsh-check-fail');
                  statusEl.setText(t('settings.update.failed', { message: status.error }));
                }
                button.setDisabled(false);
              }));
          }),

          // Stacked, bounded, and rebuilt on every run: the previous version
          // appended <p> elements straight into the row, which is a flex row,
          // so long paths spilled outside the border — and repeated clicks
          // stacked duplicate reports on top of each other.
          render(t('settings.check.title'), t('settings.check.help'), (setting) => {
            setting.settingEl.addClass('dsh-setting-stacked');

            const box = setting.settingEl.createDiv({ cls: 'dsh-check-box' });
            const list = box.createDiv({ cls: 'dsh-check-list' });
            const actions = box.createDiv({ cls: 'dsh-check-actions' });

            // Latest outcomes, kept so the copy button can report without
            // forcing a second run.
            let lastOutcomes: CheckOutcome[] = [];

            const renderRow = (o: CheckOutcome, hint: string | undefined): void => {
              const row = list.createDiv({ cls: `dsh-check-row ${o.ok ? 'is-ok' : 'is-fail'}` });
              const head = row.createDiv({ cls: 'dsh-check-head' });
              head.createSpan({ text: o.ok ? '✓' : '✗', cls: 'dsh-check-icon' });
              head.createSpan({ text: t(CHECK_LABEL_KEYS[o.id] as TranslationKey) });
              if (o.detail) {
                row.createDiv({ text: o.detail, cls: 'dsh-check-detail' });
              }
              if (o.error) {
                row.createDiv({ text: o.error, cls: 'dsh-check-error' });
              }
              // The remedy only appears under a failure: an advisory next to a
              // passing check is noise, and this is the part that turns "EACCES:
              // permission denied" into something a user can act on.
              if (!o.ok && hint) {
                row.createDiv({ text: `→ ${hint}`, cls: 'dsh-check-hint' });
              }
            };

            const runChecks = async (): Promise<void> => {
              list.empty();
              const runner = new DshRunner(this.plugin.settings, this.plugin.app.vault.configDir);
              const diag = await runner.diagnose();

              const vaultRoot = this.plugin.getVaultRoot();
              const configDir = this.plugin.app.vault.configDir;
              const targets: Array<{ id: WriteProbe['id']; path: string; isFile: boolean }> = [
                { id: 'generatedDir', path: path.join(vaultRoot, configDir, 'plugins', 'deepharness', 'generated'), isFile: false },
                { id: 'pluginHome', path: path.join(vaultRoot, configDir, 'plugins', 'deepharness', 'dsh-home'), isFile: false },
                { id: 'settingsYaml', path: path.join(vaultRoot, configDir, 'plugins', 'deepharness', 'dsh-home', 'settings.yaml'), isFile: true },
              ];

              const outcomes = buildCheckOutcomes(diag, targets.map((target) => ({
                id: target.id,
                path: target.path,
                error: target.isFile
                  ? checkWritableFile(target.path)
                  : checkWritableDir(target.path),
              })), {
                missingDsh: t('settings.check.missing'),
                missingNode: t('settings.checkNoNode'),
              });

              lastOutcomes = outcomes;
              for (const o of outcomes) {
                const hintKey = CHECK_HINT_KEYS[o.id];
                renderRow(o, hintKey ? t(hintKey as TranslationKey) : undefined);
              }

              // The escape hatch is only worth showing once something is
              // actually wrong; on a clean run it is pure clutter.
              actions.toggleClass('is-hidden', !hasFailures(outcomes));
            };

            setting.addButton((button) => button
              .setButtonText(t('settings.check.run'))
              .setCta()
              .onClick(() => void runChecks()));

            // The copy action lives in the escape-hatch row inside the box,
            // not beside "Run check": it is a follow-up to a failure, not a
            // peer of running the checks.
            actions.createSpan({ text: t('settings.check.copyNote'), cls: 'dsh-check-copy-note' });
            const copyBtn = actions.createEl('button', {
              text: t('settings.check.copy'),
              cls: 'dsh-check-copy',
            });
            copyBtn.setAttr('aria-label', t('settings.check.copyTooltip'));
            copyBtn.onclick = async () => {
              // Copying before running would produce a report with no results,
              // so run first when nothing has been collected yet.
              if (lastOutcomes.length === 0) await runChecks();
              new DiagnosticPromptModal(this.app, buildRepairPrompt(lastOutcomes, {
                pluginVersion: this.plugin.manifest.version,
                vaultRoot: this.plugin.getVaultRoot(),
                configDir: this.plugin.app.vault.configDir,
                dshHome: this.plugin.settings.dshHome,
                platform: Platform.isMacOS ? 'darwin' : (Platform.isWin ? 'win32' : 'linux'),
                arch: process.arch,
                nodeVersion: process.version,
              })).open();
            };

            const control = setting.settingEl.querySelector('.setting-item-control');
            if (control) setting.settingEl.insertBefore(box, control);
          }),

          {
            name: '',
            desc: t('settings.footer'),
            render: () => {},
          },
        ],
      },
    ];
  }
}

export function obsidianLocale(app: App): string {
  return (app as unknown as { i18n?: { language?: string } }).i18n?.language ?? 'en';
}
