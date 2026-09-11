import { describe, expect, it } from 'vitest';
import {
  extractTopLevelBlock,
  isEmptySnapshot,
  isSafeModelId,
  isSafeProviderId,
  parseDshSettings,
  parseModelEntries,
  parseProviderEntries,
} from './dsh-config';

/**
 * A trimmed copy of a real `~/.dsh/settings.yaml` (macOS, DSH desktop).
 *
 * Kept verbatim on purpose — including the two folded `description` scalars
 * that wrap onto a deeper-indented continuation line. Those continuations are
 * the main way a line-oriented reader goes wrong, so the fixture must contain
 * them rather than an idealised version of the file.
 */
const REAL_SETTINGS = `ui-onboarding:
  seen: true
ui-theme:
  mode: dark
agent-default-model:
  provider: deepseek-official
  model: deepseek-flash
  reasoningEffort: high
locale:
  language: zh-CN
llm-deepseek:
  models:
    - id: deepseek-v4-flash
      name: DeepSeek-V4-Flash
      description: Fast, efficient, and economical; suited to focused, routine, or
        parallel tasks.
      contextWindow: 1000000
      inputModalities:
        - text
    - id: deepseek-v4-pro
      name: DeepSeek-V4-Pro
      description: Stronger agentic coding, knowledge, and difficult reasoning; suited
        to complex or quality-critical tasks at higher cost.
      contextWindow: 1000000
      inputModalities:
        - text
    - id: deepseek-v4-flash-vision-exp
      name: DeepSeek-V4-Flash-Vision-Exp
      contextWindow: 1000000
      inputModalities:
        - text
        - image
      imagePixelBudget: 640000
      imageMaxBytes: 1048576
    - id: deepseek-flash
      name: DeepSeek-V41-Flash
`;

describe('extractTopLevelBlock', () => {
  it('returns only the requested top-level subtree', () => {
    const block = extractTopLevelBlock(REAL_SETTINGS, 'llm-deepseek');
    expect(block).toBeTruthy();
    expect(block).toContain('deepseek-flash');
    // Must stop before any other column-0 key.
    expect(block).not.toContain('agent-default-model');
    expect(block).not.toContain('ui-theme');
  });

  it('does not mistake a nested key for the top-level one', () => {
    const text = 'outer:\n  llm-deepseek:\n    models:\n      - id: nested\n';
    expect(extractTopLevelBlock(text, 'llm-deepseek')).toBeNull();
  });

  it('returns null when the key is absent', () => {
    expect(extractTopLevelBlock(REAL_SETTINGS, 'llm-pi-ai')).toBeNull();
  });

  it('handles CRLF line endings', () => {
    const text = 'llm-deepseek:\r\n  models:\r\n    - id: a-model\r\n';
    expect(parseModelEntries(extractTopLevelBlock(text, 'llm-deepseek')!)).toEqual([
      { id: 'a-model' },
    ]);
  });
});

describe('parseModelEntries — real settings fixture', () => {
  const models = parseModelEntries(extractTopLevelBlock(REAL_SETTINGS, 'llm-deepseek')!);

  it('reads every declared model in order, including the hand-added one', () => {
    expect(models.map((m) => m.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
      'deepseek-flash',
    ]);
  });

  it('attaches names despite folded description continuations', () => {
    expect(models[0].name).toBe('DeepSeek-V4-Flash');
    expect(models[1].name).toBe('DeepSeek-V4-Pro');
    // The continuation line "parallel tasks." must not become a model name.
    expect(models.every((m) => m.name !== 'parallel tasks.')).toBe(true);
    expect(models[3].name).toBe('DeepSeek-V41-Flash');
  });

  it('reads contextWindow and leaves it undefined when omitted', () => {
    expect(models[0].contextWindow).toBe(1_000_000);
    expect(models[3].contextWindow).toBeUndefined();
  });

  it('ignores nested inputModalities sequences', () => {
    // `- text` / `- image` are sequence items too, but not `- id:` items.
    expect(models).toHaveLength(4);
    expect(models.some((m) => m.id === 'text' || m.id === 'image')).toBe(false);
  });
});

describe('parseModelEntries — malformed input', () => {
  it('returns [] when there is no models key', () => {
    expect(parseModelEntries('llm-deepseek:\n  baseURL: https://x\n')).toEqual([]);
  });

  it('returns [] for an empty block', () => {
    expect(parseModelEntries('')).toEqual([]);
  });

  it('drops entries whose id cannot be written safely', () => {
    const block = [
      'llm-deepseek:',
      '  models:',
      '    - id: good-model',
      '      name: Good',
      '    - id: "bad\\nmodel"',
      '      name: Bad',
      "    - id: 'has space'",
      '      name: Spaced',
      '    - id: has#hash',
      '      name: Hash',
    ].join('\n');
    expect(parseModelEntries(block)).toEqual([{ id: 'good-model', name: 'Good' }]);
  });

  it('does not graft a dropped entry\'s fields onto the previous one', () => {
    const block = [
      '  models:',
      '    - id: keep-me',
      '      name: Keep',
      '    - id: "bad id"',
      '      name: Leaked',
    ].join('\n');
    const models = parseModelEntries(block);
    expect(models).toEqual([{ id: 'keep-me', name: 'Keep' }]);
  });

  it('stops at the end of the sequence', () => {
    const block = ['  models:', '    - id: one', '  baseURL: https://x', '    - id: two'].join('\n');
    expect(parseModelEntries(block).map((m) => m.id)).toEqual(['one']);
  });

  it('accepts quoted names and strips the quotes', () => {
    const block = ['  models:', '    - id: m1', '      name: "DeepSeek V4 Pro"'].join('\n');
    expect(parseModelEntries(block)[0].name).toBe('DeepSeek V4 Pro');
  });
});

describe('parseProviderEntries', () => {
  it('reads provider route ids and their display names', () => {
    const block = [
      'llm-pi-ai:',
      '  providers:',
      '    opencode-go:',
      '      displayName: OpenCode Go',
      '      apiKeyEnv: OPENCODE_GO_API_KEY',
      '      api: openai-completions',
      '      baseURL: https://opencode.ai/zen/go/v1',
      '      models:',
      '        - id: deepseek-v4-flash',
      '          name: DeepSeek V4 Flash',
      '    my-gateway:',
      '      displayName: My Gateway',
      '      baseURL: https://gw.example/v1',
    ].join('\n');
    expect(parseProviderEntries(block)).toEqual([
      { id: 'opencode-go', displayName: 'OpenCode Go' },
      { id: 'my-gateway', displayName: 'My Gateway' },
    ]);
  });

  it('detects the child indent instead of assuming two spaces', () => {
    const block = [
      'llm-pi-ai:',
      '    providers:',
      '        custom-route:',
      '            displayName: Custom',
    ].join('\n');
    expect(parseProviderEntries(block)).toEqual([
      { id: 'custom-route', displayName: 'Custom' },
    ]);
  });

  it('returns [] without a providers key', () => {
    expect(parseProviderEntries('llm-pi-ai:\n  something: else\n')).toEqual([]);
  });

  it('skips provider ids that are not valid route ids', () => {
    const block = ['  providers:', '    Good-Route:', '    bad route:', '    ok-route2:'].join('\n');
    expect(parseProviderEntries(block).map((p) => p.id)).toEqual(['ok-route2']);
  });
});

describe('parseDshSettings', () => {
  it('reads models and providers from one document', () => {
    const snap = parseDshSettings(REAL_SETTINGS);
    expect(snap.models).toHaveLength(4);
    expect(snap.models[3].id).toBe('deepseek-flash');
    expect(snap.providers).toEqual([]);
  });

  it('never throws on garbage', () => {
    for (const bad of ['', '\n\n', '::: not yaml :::', 'llm-deepseek: [1,2,3', '\t\t- id: x']) {
      expect(() => parseDshSettings(bad)).not.toThrow();
    }
  });

  it('reports an empty snapshot for an unrelated document', () => {
    expect(isEmptySnapshot(parseDshSettings('other:\n  key: value\n'))).toBe(true);
    expect(isEmptySnapshot(null)).toBe(true);
  });

  it('reports a non-empty snapshot when models were found', () => {
    expect(isEmptySnapshot(parseDshSettings(REAL_SETTINGS))).toBe(false);
  });
});

describe('id validators (YAML injection boundary)', () => {
  it('accepts the ids DeepSeek and gateways actually use', () => {
    for (const id of [
      'deepseek-flash',
      'deepseek-v4-flash-vision-exp',
      'us.anthropic.claude-3',
      'qwen/qwen3-32b',
      'vendor:model-1',
    ]) {
      expect(isSafeModelId(id), id).toBe(true);
    }
  });

  it('rejects anything that could break out of the YAML scalar', () => {
    for (const id of [
      '',
      'has space',
      'new\nline',
      'carriage\rreturn',
      'quote"inside',
      "single'quote",
      'hash#comment',
      '- leading-dash',
      '@reserved',
      'tab\there',
      '  padded  ',
      'x'.repeat(129),
    ]) {
      expect(isSafeModelId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it('requires lowercase hyphenated provider route ids', () => {
    expect(isSafeProviderId('deepseek-official')).toBe(true);
    expect(isSafeProviderId('opencode-go')).toBe(true);
    for (const id of ['DeepSeek', 'has space', 'under_score', '', '-lead', 'x'.repeat(65)]) {
      expect(isSafeProviderId(id), id).toBe(false);
    }
  });
});
