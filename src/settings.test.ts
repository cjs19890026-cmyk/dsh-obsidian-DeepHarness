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
  modelLabel,
  normalizeStoredSettings,
  PERMISSION_OPTIONS,
  PROVIDER_OPTIONS,
  REASONING_OPTIONS,
  TOOL_EXECUTION_MODES,
} from './settings';
import { MODEL_CONTEXT_WINDOWS } from './pure';
import { setLocale } from './i18n';

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
      provider: 'provider-that-never-existed',
      model: 'gpt-4',
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

  it('keeps every option field of the stored settings in its own option list', () => {
    const { settings } = normalizeStoredSettings({
      provider: 'nope',
      model: 'nope',
      reasoningEffort: 'nope',
      permissionMode: 'nope',
      toolExecutionMode: 'nope',
    });
    expect(optionIds.provider).toContain(settings.provider);
    expect(optionIds.model).toContain(settings.model);
    expect(optionIds.reasoningEffort).toContain(settings.reasoningEffort);
    expect(optionIds.permissionMode).toContain(settings.permissionMode);
    expect(optionIds.toolExecutionMode).toContain(settings.toolExecutionMode);
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

  it('falls back to the rolling alias once a stored id is retired', () => {
    // `deepseek-chat` was a real alias until DeepSeek dropped it on 2026-07-24.
    const { settings, reset } = normalizeStoredSettings({ model: 'deepseek-chat' });
    expect(reset).toEqual(['model']);
    expect(settings.model).toBe('deepseek-flash');
  });

  it('has a context window for every selectable model', () => {
    for (const m of MODEL_OPTIONS) {
      expect(MODEL_CONTEXT_WINDOWS[m.id], `missing context window for ${m.id}`).toBeTypeOf('number');
    }
  });
});

describe('modelLabel', () => {
  afterEach(() => setLocale('en'));

  it('localizes the rolling-alias descriptor', () => {
    setLocale('zh');
    expect(modelLabel('deepseek-flash')).toBe('最新模型(自动跟随)');
    setLocale('en');
    expect(modelLabel('deepseek-flash')).toBe('Latest model (auto-tracking)');
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
