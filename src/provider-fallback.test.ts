import { describe, expect, it, vi } from 'vitest';

// settings.ts imports runtime values from the `obsidian` package, but the npm
// `obsidian` module ships types only (main is empty) — stub it for Node tests.
// settings → modals statically, so every symbol referenced at class-definition
// time (base classes for extends) must be present too.
vi.mock('obsidian', () => ({
  App: class {},
  PluginSettingTab: class {},
  Setting: class {},
  Modal: class {},
  Notice: class {},
  FuzzySuggestModal: class {},
  TFolder: class {},
}));

import { MODEL_OPTIONS } from './settings';
import { OPENCODE_GO_PROVIDER_FALLBACK } from './dsh-runner';

/**
 * Extract the model ids declared under `models:` in the fallback provider
 * YAML block. Restricting the scan to lines after the `models:` key keeps the
 * guard independent of unrelated `- id:` entries that may appear elsewhere.
 */
function fallbackModelIds(): string[] {
  const ids: string[] = [];
  let inModels = false;
  for (const line of OPENCODE_GO_PROVIDER_FALLBACK) {
    if (!inModels) {
      if (/^\s*models:\s*$/.test(line)) inModels = true;
      continue;
    }
    const m = line.match(/^\s+- id:\s+(\S+)/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

describe('opencode-go fallback provider <-> MODEL_OPTIONS sync', () => {
  it('declares every model selectable in settings', () => {
    const ids = fallbackModelIds();
    for (const m of MODEL_OPTIONS) {
      expect(ids, `opencode-go fallback is missing model ${m.id}`).toContain(m.id);
    }
  });

  it('declares no model outside MODEL_OPTIONS and no duplicates', () => {
    const ids = fallbackModelIds();
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    const allowed = new Set<string>(MODEL_OPTIONS.map((m) => m.id));
    for (const id of ids) {
      expect(allowed.has(id), `unexpected model ${id} in the opencode-go fallback`).toBe(true);
    }
  });

  it('mirrors MODEL_OPTIONS exactly (same set of ids)', () => {
    const fallback = [...fallbackModelIds()].sort();
    const options = MODEL_OPTIONS.map((m) => m.id).sort();
    expect(fallback).toEqual(options);
  });
});
