import { isSafeModelId, isSafeProviderId } from '../dsh/dsh-config';
import {
  DEFAULT_SETTINGS,
  MODEL_OPTIONS,
  PERMISSION_OPTIONS,
  PROVIDER_OPTIONS,
  REASONING_OPTIONS,
  TOOL_EXECUTION_MODES,
  modelLabel,
  type DshSettings,
  type OptionFieldKey,
} from './types';

export type { OptionFieldKey };


/**
 * Loading, validating and repairing stored settings — the settings *rules*.
 *
 * Split out of settings.ts (review C-2): this half is pure logic over plain
 * values, so it is unit-testable without an Obsidian app, and the settings page
 * no longer has to be loaded just to repair a data.json.
 *
 * The shape itself is in `./types`; the page is `./index`.
 */

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
/**
 * Validate settings read from the plugin data file and fall back to the
 * DEFAULT_SETTINGS value whenever a stored field is unusable.
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
