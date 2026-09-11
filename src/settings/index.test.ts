import { afterEach, describe, expect, it, vi } from 'vitest';

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

import {
  DEFAULT_SETTINGS,
  MODEL_OPTIONS,
  buildModelOptions,
  buildProviderOptions,
  modelDisplayLabel,
  mergeModelIds,
  modelLabel,
  modelOptionsWithCurrent,
  normalizeStoredSettings,
  PERMISSION_OPTIONS,
  PROVIDER_OPTIONS,
  REASONING_OPTIONS,
  TOOL_EXECUTION_MODES,
} from './index';
import { MODEL_CONTEXT_WINDOWS } from '../dsh/pure';
import { setLocale } from '../i18n/index';

const optionIds = {
  provider: PROVIDER_OPTIONS.map((o) => o.id),
  model: MODEL_OPTIONS.map((o) => o.id),
  reasoningEffort: REASONING_OPTIONS.map((o) => o.id),
  permissionMode: PERMISSION_OPTIONS.map((o) => o.id),
  toolExecutionMode: [...TOOL_EXECUTION_MODES],
} as const;

describe('normalizeStoredSettings (P1-5)', () => {
  it('keeps every valid option value untouched', () => {
    const raw = {
      provider: 'opencode-go',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      permissionMode: 'danger-full-access',
      toolExecutionMode: 'code',
      dshBin: '/custom/dsh',
    };
    const { settings, reset } = normalizeStoredSettings(raw);
    expect(reset).toEqual([]);
    expect(settings.provider).toBe('opencode-go');
    expect(settings.model).toBe('deepseek-v4-pro');
    expect(settings.reasoningEffort).toBe('max');
    expect(settings.permissionMode).toBe('danger-full-access');
    expect(settings.toolExecutionMode).toBe('code');
    // non-option fields keep their stored value
    expect(settings.dshBin).toBe('/custom/dsh');
  });

  it('resets each invalid option-backed field to its default', () => {
    const { settings, reset } = normalizeStoredSettings({
      // `provider` / `model` are open fields, so "invalid" now means "not
      // expressible as a safe YAML scalar" rather than "not in the list".
      provider: 'Has Space',
      model: 'has space',
      reasoningEffort: 'ultra',
      permissionMode: 'root',
      toolExecutionMode: 'sudo',
    });
    expect(reset.sort()).toEqual([
      'model',
      'permissionMode',
      'provider',
      'reasoningEffort',
      'toolExecutionMode',
    ]);
    expect(settings.provider).toBe(DEFAULT_SETTINGS.provider);
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(settings.reasoningEffort).toBe(DEFAULT_SETTINGS.reasoningEffort);
    expect(settings.permissionMode).toBe(DEFAULT_SETTINGS.permissionMode);
    expect(settings.toolExecutionMode).toBe(DEFAULT_SETTINGS.toolExecutionMode);
  });

  it('treats a non-string stored value (e.g. hand-edited number) as invalid', () => {
    const { settings, reset } = normalizeStoredSettings({ model: 42 });
    expect(reset).toEqual(['model']);
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
  });

  it('does not report fields that were not stored at all', () => {
    const { settings, reset } = normalizeStoredSettings({ reasoningEffort: 'off' });
    expect(reset).toEqual([]);
    expect(settings.reasoningEffort).toBe('off');
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
  });

  it('accepts non-object data (corrupted file) as all defaults', () => {
    for (const raw of [null, undefined, 'garbage', 7]) {
      const { settings, reset } = normalizeStoredSettings(raw);
      expect(reset).toEqual([]);
      expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    }
  });

  it('keeps the genuinely closed option fields inside their own lists', () => {
    const { settings } = normalizeStoredSettings({
      reasoningEffort: 'nope',
      permissionMode: 'nope',
      toolExecutionMode: 'nope',
    });
    expect(optionIds.reasoningEffort).toContain(settings.reasoningEffort);
    expect(optionIds.permissionMode).toContain(settings.permissionMode);
    expect(optionIds.toolExecutionMode).toContain(settings.toolExecutionMode);
  });

  it('preserves a valid model/provider id that is not in any built-in list', () => {
    // The whole point of the open fields: a model the plugin has never heard
    // of — one DSH discovered, or one the user typed before this release —
    // must survive a reload. Resetting it to the default would silently
    // revert the user to a different model than the one they chose.
    const { settings, reset } = normalizeStoredSettings({
      model: 'deepseek-v5-ultra',
      provider: 'my-gateway',
    });
    expect(reset).toEqual([]);
    expect(settings.model).toBe('deepseek-v5-ultra');
    expect(settings.provider).toBe('my-gateway');
    expect(optionIds.model).not.toContain(settings.model);
  });

  it('drops the legacy modelCustom key from an older data.json', () => {
    // A one-release migration: the second model field is gone, and leaving it
    // in data.json would keep a stale duplicate of `model` around forever.
    const { settings, reset } = normalizeStoredSettings({
      model: 'deepseek-flash',
      modelCustom: 'deepseek-flash',
    });
    expect(reset).toEqual([]);
    expect(settings.model).toBe('deepseek-flash');
    expect('modelCustom' in settings).toBe(false);
  });
});

describe('model options — rolling alias default', () => {
  it('defaults to the rolling alias so a new install rides the newest model', () => {
    expect(DEFAULT_SETTINGS.model).toBe('deepseek-flash');
    expect(optionIds.model).toContain(DEFAULT_SETTINGS.model);
  });

  it('lists the rolling alias first in the dropdown', () => {
    expect(MODEL_OPTIONS[0].id).toBe('deepseek-flash');
  });

  it('keeps a stored versioned id untouched (no silent migration)', () => {
    const { settings, reset } = normalizeStoredSettings({ model: 'deepseek-v4-flash' });
    expect(reset).toEqual([]);
    expect(settings.model).toBe('deepseek-v4-flash');
  });

  it('keeps a retired alias selectable rather than resetting it', () => {
    // `deepseek-chat` was a real alias until DeepSeek dropped it on 2026-07-24.
    // It is still a syntactically valid id, so it is preserved: the user — not
    // this plugin — decides whether it still resolves, and DSH reports the
    // truth when it does not. Silently swapping in a different model would
    // change what the agent runs behind the user's back.
    const { settings, reset } = normalizeStoredSettings({ model: 'deepseek-chat' });
    expect(reset).toEqual([]);
    expect(settings.model).toBe('deepseek-chat');
  });

  it('has a context window for every built-in model', () => {
    for (const m of MODEL_OPTIONS) {
      expect(MODEL_CONTEXT_WINDOWS[m.id], `missing context window for ${m.id}`).toBeTypeOf('number');
    }
  });
});

describe('modelDisplayLabel', () => {
  it('uses the friendly label for an id the plugin recognises', () => {
    expect(modelDisplayLabel('deepseek-flash')).toBe('DeepSeek Flash');
    expect(modelDisplayLabel('deepseek-v4-pro')).toBe('DeepSeek V4 Pro');
  });

  it('falls back to the raw id, so a user-typed model is shown honestly', () => {
    // No guessing and no "auto-tracking"-style promise that the plugin cannot
    // keep on every endpoint.
    expect(modelDisplayLabel('deepseek-v5-ultra')).toBe('deepseek-v5-ultra');
    expect(modelDisplayLabel('my-gateway/llama-3')).toBe('my-gateway/llama-3');
  });
});

describe('model list (user-owned)', () => {
  it('builds dropdown options straight from the list, in order', () => {
    expect(buildModelOptions(['deepseek-v4-pro', 'deepseek-flash'])).toEqual([
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'deepseek-flash', label: 'DeepSeek Flash' },
    ]);
  });

  it('shows a raw id for a model the plugin does not recognise', () => {
    expect(buildModelOptions(['brand-new-model'])).toEqual([
      { id: 'brand-new-model', label: 'brand-new-model' },
    ]);
  });

  it('seeds the list with the built-in ids', () => {
    expect(DEFAULT_SETTINGS.models).toEqual(MODEL_OPTIONS.map((m) => m.id));
    expect(DEFAULT_SETTINGS.models).toContain(DEFAULT_SETTINGS.model);
  });

  it('surfaces the current value when it is missing from the list', () => {
    // Otherwise Obsidian's dropdown would render blank and misreport the model.
    const opts = modelOptionsWithCurrent(['deepseek-v4-pro'], 'not-in-list');
    expect(opts.map((o) => o.id)).toEqual(['deepseek-v4-pro', 'not-in-list']);
  });

  it('does not duplicate a current value that is already listed', () => {
    const opts = modelOptionsWithCurrent(['deepseek-v4-pro'], 'deepseek-v4-pro');
    expect(opts).toHaveLength(1);
  });

  it('merges imported ids, preserving order and skipping duplicates', () => {
    const { models, added } = mergeModelIds(
      ['deepseek-flash', 'deepseek-v4-pro'],
      ['deepseek-v4-pro', 'deepseek-v5-ultra', 'another-new-one'],
    );
    expect(models).toEqual(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v5-ultra', 'another-new-one']);
    expect(added).toEqual(['deepseek-v5-ultra', 'another-new-one']);
  });

  it('refuses to merge an id that could not be written to settings.yaml', () => {
    const { models, added } = mergeModelIds(['deepseek-flash'], ['has space', 'ok-model']);
    expect(models).toEqual(['deepseek-flash', 'ok-model']);
    expect(added).toEqual(['ok-model']);
  });

  it('lists the fixed provider pair', () => {
    expect(buildProviderOptions().map((o) => o.id)).toEqual(['deepseek-official', 'opencode-go']);
  });
});

describe('modelLabel', () => {
  afterEach(() => setLocale('en'));

  it('never localizes a brand name, in either locale', () => {
    // These are product names, not UI copy — and an earlier localized
    // "auto-tracking" descriptor promised behaviour the plugin cannot
    // guarantee on a non-official endpoint, so it is gone for good.
    for (const locale of ['en', 'zh'] as const) {
      setLocale(locale);
      expect(modelLabel('deepseek-flash')).toBe('DeepSeek Flash');
    }
  });

  it('leaves brand names untranslated in both locales', () => {
    for (const locale of ['en', 'zh'] as const) {
      setLocale(locale);
      expect(modelLabel('deepseek-v4-pro')).toBe('DeepSeek V4 Pro');
      expect(modelLabel('deepseek-v4-flash-vision-exp')).toBe('DeepSeek V4 Flash Vision (Exp)');
    }
  });

  it('returns the id itself for a model outside the list', () => {
    expect(modelLabel('not-a-model' as never)).toBe('not-a-model');
  });

  it('returns a non-empty label for every option', () => {
    for (const m of MODEL_OPTIONS) {
      expect(modelLabel(m.id).length, `empty label for ${m.id}`).toBeGreaterThan(0);
    }
  });
});
