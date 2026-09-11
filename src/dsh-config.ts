import * as fs from 'fs';
import * as path from 'path';

/**
 * Reader for the user's *real* DSH settings (`$DSH_HOME/settings.yaml`).
 *
 * The plugin runs DSH against its own isolated DSH_HOME and writes a minimal
 * `settings.yaml` there. Without this module that isolated home would silently
 * lose everything the user curated in the desktop app — most importantly the
 * `llm-deepseek.models` catalog and any custom `llm-pi-ai.providers` route, so
 * a model the user hand-added (or a gateway they configured through DSH's own
 * "Add a custom provider" + "Fetch available models" flow) would be invisible
 * inside Obsidian.
 *
 * This is deliberately a *narrow* reader rather than a general YAML parser:
 * it only recognises the two shapes we consume, and it validates every value
 * it accepts. Anything unexpected is ignored rather than guessed at, because
 * every caller falls back to the built-in option lists — a model simply not
 * appearing in the dropdown is a far better failure than a misparsed id being
 * written into a generated `settings.yaml`.
 *
 * `dsh --dump-config` was evaluated as an alternative and rejected: it prints
 * the composed *profile* tree only. `settings.yaml` is applied by
 * `dsh-settings-file` at runtime, so the user layer (and thus the catalog we
 * need) never appears in that output.
 */

/**
 * Model ids are pasted straight into a generated `settings.yaml`
 * (`  model: <id>`), so this pattern is a security boundary, not cosmetics:
 * it must reject anything that could terminate the scalar and inject sibling
 * keys — newlines, quotes, `#`, and the YAML indicators that are only special
 * as a *first* character (hence the leading alphanumeric).
 *
 * Generous about the interior (dots, slashes, colons appear in real gateway
 * ids such as `us.anthropic.claude-3` or `qwen/qwen3-32b`) while staying
 * inside what YAML accepts unquoted.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * Provider route ids land in `agent-default-model.provider` and key the
 * `llm-pi-ai.providers` mapping. DSH itself requires a lowercase hyphenated
 * identifier before a route may address a stored credential, so mirror that
 * constraint here instead of discovering it from a DSH startup error.
 */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True when `id` is safe to emit as a YAML scalar in a generated settings file. */
export function isSafeModelId(id: string): boolean {
  return MODEL_ID_PATTERN.test(id);
}

/** True when `id` is a usable DSH provider route id. */
export function isSafeProviderId(id: string): boolean {
  return PROVIDER_ID_PATTERN.test(id);
}

/** One model declared under `llm-deepseek.models`. */
export interface DshModelEntry {
  id: string;
  /** Human name from the catalog; brand names are not localized. */
  name?: string;
  contextWindow?: number;
}

/** One route declared under `llm-pi-ai.providers`. */
export interface DshProviderEntry {
  id: string;
  displayName?: string;
}

export interface DshConfigSnapshot {
  /** `llm-deepseek.models`, in declaration order. */
  models: DshModelEntry[];
  /** `llm-pi-ai.providers` keys, in declaration order. */
  providers: DshProviderEntry[];
}

/** Leading-space count (tabs are treated as one column; DSH writes spaces). */function indentOf(line: string): number {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

/**
 * Strip one layer of matching surrounding quotes.
 *
 * `name:` values are free text and DSH quotes them when the value would
 * otherwise be ambiguous (`name: "DeepSeek V4 Pro"`), so a naive read would
 * surface the quotes in the dropdown.
 */
function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Extract a top-level YAML block (e.g. `llm-deepseek:`) from a settings file.
 *
 * "Top level" means the key starts in column 0: a nested `llm-deepseek:` under
 * some other parent must not be mistaken for the real one. The block ends at
 * the next column-0 key, so callers get exactly the subtree they asked for.
 *
 * Shared with `dsh-runner`, which copies these blocks verbatim into the
 * plugin-owned home — keeping one implementation means what the dropdown
 * reports and what DSH is handed can never come from different parses.
 */
export function extractTopLevelBlock(text: string, key: string): string | null {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart() === line && line.startsWith(`${key}:`)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart() === line && /^[A-Za-z0-9_.-]+:/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

/**
 * Read the `models:` sequence of an `llm-deepseek` block.
 *
 * Only three fields are taken: `id` (required), `name` and `contextWindow`.
 * Everything else — descriptions, image budgets, prompt templates — is DSH's
 * business and is preserved by copying the block verbatim, not by re-emitting
 * it from this structure. Values that fail validation are dropped, and a
 * sequence we cannot make sense of yields `[]` rather than a partial guess.
 */
export function parseModelEntries(block: string): DshModelEntry[] {
  const lines = block.split(/\r?\n/);
  let key = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*models:\s*$/.test(lines[i])) {
      key = i;
      break;
    }
  }
  if (key === -1) return [];

  const modelsIndent = indentOf(lines[key]);
  const out: DshModelEntry[] = [];
  let current: DshModelEntry | null = null;
  let itemIndent = -1;

  for (let i = key + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const ind = indentOf(line);
    // Back at or above the `models:` key: the sequence is over.
    if (ind <= modelsIndent) break;

    // Any `- …` at the item indent starts a new entry — including one whose id
    // we reject, which is why the marker is handled before the id is parsed.
    // Ignoring a rejected marker instead would let its sibling `name:` graft
    // onto the previous, valid entry. Dashes deeper than the item indent are
    // nested sequences (`inputModalities:`) and are left alone.
    const item = line.match(/^\s*-\s*(.*)$/);
    if (item) {
      if (itemIndent === -1 || ind === itemIndent) {
        itemIndent = ind;
        current = null;
        const idMatch = item[1].match(/^id:\s*(.+?)\s*$/);
        if (idMatch) {
          const id = unquote(idMatch[1]);
          if (isSafeModelId(id)) {
            current = { id };
            out.push(current);
          }
        }
      }
      continue;
    }

    // Sibling fields must sit deeper than the `- id:` marker; a folded
    // description continuation line never matches these keys anyway.
    if (!current || ind <= itemIndent) continue;

    const name = line.match(/^\s*name:\s*(.+?)\s*$/);
    if (name) {
      const value = unquote(name[1]);
      if (value) current.name = value;
      continue;
    }

    const cw = line.match(/^\s*contextWindow:\s*(\d+)\s*$/);
    if (cw) {
      const value = Number(cw[1]);
      if (Number.isSafeInteger(value) && value > 0) current.contextWindow = value;
    }
  }

  return out;
}

/**
 * Read the provider route ids of an `llm-pi-ai` block.
 *
 * `providers` is a mapping keyed by route id, so the children are keys rather
 * than a sequence. The child indent is detected from the first child instead
 * of assumed to be two spaces, so a hand-edited file with four-space nesting
 * still reads correctly.
 */
export function parseProviderEntries(block: string): DshProviderEntry[] {
  const lines = block.split(/\r?\n/);
  let key = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*providers:\s*$/.test(lines[i])) {
      key = i;
      break;
    }
  }
  if (key === -1) return [];

  const providersIndent = indentOf(lines[key]);

  // Pass 1: the shallowest child indent below `providers:`.
  let childIndent = -1;
  for (let i = key + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const ind = indentOf(line);
    if (ind <= providersIndent) break;
    if (childIndent === -1 || ind < childIndent) childIndent = ind;
  }
  if (childIndent === -1) return [];

  // Pass 2: collect the keys at that indent and their nested display names.
  const out: DshProviderEntry[] = [];
  let current: DshProviderEntry | null = null;
  for (let i = key + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const ind = indentOf(line);
    if (ind <= providersIndent) break;

    if (ind === childIndent) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+):\s*$/) ?? line.match(/^\s*([A-Za-z0-9_.-]+):\s*\{\s*\}\s*$/);
      const id = m ? m[1] : '';
      current = isSafeProviderId(id) ? { id } : null;
      if (current) out.push(current);
      continue;
    }

    if (!current) continue;
    const dn = line.match(/^\s*displayName:\s*(.+?)\s*$/);
    if (dn) {
      const value = unquote(dn[1]);
      if (value) current.displayName = value;
    }
  }

  return out;
}

/**
 * Parse the two subtrees we consume out of a `settings.yaml` body.
 * Never throws: a malformed document simply yields fewer entries.
 */
export function parseDshSettings(text: string): DshConfigSnapshot {
  const deepseek = extractTopLevelBlock(text, 'llm-deepseek');
  const piAi = extractTopLevelBlock(text, 'llm-pi-ai');
  return {
    models: deepseek ? parseModelEntries(deepseek) : [],
    providers: piAi ? parseProviderEntries(piAi) : [],
  };
}

/**
 * Read and parse `$DSH_HOME/settings.yaml`.
 *
 * Returns null when the file is missing or unreadable — the caller then keeps
 * its built-in lists, which is also the correct behaviour for a fresh install
 * where the user has not launched the desktop app yet.
 */
export function readDshSettings(dshHome: string): DshConfigSnapshot | null {
  const file = path.join(dshHome, 'settings.yaml');
  try {
    if (!fs.existsSync(file)) return null;
    return parseDshSettings(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** True when a snapshot carries nothing worth merging. */
export function isEmptySnapshot(s: DshConfigSnapshot | null): boolean {
  if (!s) return true;
  return s.models.length === 0 && s.providers.length === 0;
}
