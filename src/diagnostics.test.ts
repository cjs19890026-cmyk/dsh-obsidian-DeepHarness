import { describe, expect, it } from 'vitest';
import {
  buildCheckOutcomes,
  buildRepairPrompt,
  CHECK_HINT_KEYS,
  CHECK_LABEL_KEYS,
  failures,
  hasFailures,
  type CheckId,
  type CheckOutcome,
  type DiagnosticContext,
} from './diagnostics';

const CTX: DiagnosticContext = {
  pluginVersion: '0.1.8',
  vaultRoot: '/Users/tester/Documents/Vault',
  configDir: '.obsidian',
  dshHome: '/Users/tester/.dsh',
  platform: 'darwin',
  arch: 'arm64',
  nodeVersion: 'v22.11.0',
};

const OK: CheckOutcome[] = [
  { id: 'dsh', ok: true, detail: '/opt/homebrew/bin/dsh' },
  { id: 'node', ok: true, detail: '/opt/homebrew/bin/node' },
  { id: 'generatedDir', ok: true, detail: '/Users/tester/Documents/Vault/.obsidian/plugins/deepharness/generated' },
];

const FAILING: CheckOutcome[] = [
  { id: 'dsh', ok: false, detail: '', error: 'not-found' },
  { id: 'node', ok: true, detail: '/opt/homebrew/bin/node' },
  {
    id: 'pluginHome',
    ok: false,
    detail: '/Users/tester/Documents/Vault/.obsidian/plugins/deepharness/dsh-home',
    error: 'EACCES: permission denied, open ...',
  },
];

describe('hasFailures / failures', () => {
  it('reports nothing wrong for an all-clear run', () => {
    expect(hasFailures(OK)).toBe(false);
    expect(failures(OK)).toEqual([]);
  });

  it('collects only the failing outcomes, in order', () => {
    expect(hasFailures(FAILING)).toBe(true);
    expect(failures(FAILING).map((o) => o.id)).toEqual(['dsh', 'pluginHome']);
  });

  it('treats an empty run as passing', () => {
    expect(hasFailures([])).toBe(false);
  });
});

describe('check metadata', () => {
  const ids: CheckId[] = ['dsh', 'node', 'generatedDir', 'pluginHome', 'settingsYaml'];

  it('names every check', () => {
    for (const id of ids) expect(CHECK_LABEL_KEYS[id], id).toBeTruthy();
  });

  it('offers a remedy for every check that can fail', () => {
    for (const id of ids) expect(CHECK_HINT_KEYS[id], id).toBeTruthy();
  });
});

describe('buildRepairPrompt', () => {
  it('is self-contained, so it still works when dsh itself is missing', () => {
    const p = buildRepairPrompt(FAILING, CTX);
    // The dsh-missing case is exactly when the plugin cannot help, so the text
    // must explain itself rather than say "ask this plugin".
    expect(p).toContain('DeepSeek Harness CLI');
    expect(p).toContain('Obsidian plugin');
    expect(p).toContain('dsh binary present');
  });

  it('asks for a diagnosis and steps, not an unconditional repair', () => {
    const p = buildRepairPrompt(FAILING, CTX);
    expect(p).toContain('likely cause');
    expect(p).toContain('exact steps');
    // Some causes are out of reach from a chat window; the prompt must allow
    // the assistant to say so.
    expect(p).toContain('not fixable from a chat window');
  });

  it('lists the failing checks with their raw error text', () => {
    const p = buildRepairPrompt(FAILING, CTX);
    expect(p).toContain('- dsh: ');
    expect(p).toContain('error: not-found');
    expect(p).toContain('EACCES: permission denied');
    expect(p).not.toContain('/opt/homebrew/bin/node\n  error');
  });

  it('includes the environment the diagnosis needs', () => {
    const p = buildRepairPrompt(FAILING, CTX);
    expect(p).toContain('0.1.8');
    expect(p).toContain('darwin / arm64');
    expect(p).toContain('v22.11.0');
    expect(p).toContain(CTX.vaultRoot);
    expect(p).toContain(CTX.dshHome);
    expect(p).toContain(CTX.configDir);
  });

  it('still produces a usable report when everything passes', () => {
    const p = buildRepairPrompt(OK, CTX);
    expect(p).toContain('all checks passed');
    expect(p).toContain('[ok] dsh');
  });

  it('cannot leak a credential: the context type has no field to carry one', () => {
    // Belt-and-braces tripwire. The real guarantee is that
    // `DiagnosticContext` has no key field, so there is nothing to serialise;
    // this catches a future edit that starts interpolating settings wholesale.
    // It is a guard, not user-facing copy — the report deliberately says
    // nothing about keys, because mentioning them invites the very suspicion
    // it would be trying to dispel.
    const p = buildRepairPrompt(FAILING, CTX);
    expect(p.toLowerCase()).not.toContain('apikey');
    expect(p.toLowerCase()).not.toContain('api_key');
    expect(p).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it('never throws on a sparse outcome list', () => {
    expect(() => buildRepairPrompt([], CTX)).not.toThrow();
    expect(() => buildRepairPrompt([{ id: 'dsh', ok: false, detail: '' }], CTX)).not.toThrow();
  });
});

describe('buildCheckOutcomes', () => {
  const LABELS = { missingDsh: 'dsh not found', missingNode: 'node not found' };
  const WRITES = [
    { id: 'generatedDir' as const, path: '/v/.obsidian/plugins/deepharness/generated', error: null },
    { id: 'pluginHome' as const, path: '/v/.obsidian/plugins/deepharness/dsh-home', error: 'EACCES' },
  ];

  it('passes a working dsh, reporting the version alongside the path', () => {
    const out = buildCheckOutcomes(
      { found: true, bin: '/opt/homebrew/bin/dsh', version: '0.1.7', error: null, nodeBin: '/usr/bin/node' },
      [], LABELS,
    );
    expect(out[0]).toEqual({ id: 'dsh', ok: true, detail: '/opt/homebrew/bin/dsh · 0.1.7' });
  });

  it('fails a dsh that exists but cannot run', () => {
    // Present-but-broken is a failure, not a pass — it needs different advice.
    const out = buildCheckOutcomes(
      { found: true, bin: '/opt/homebrew/bin/dsh', version: null, error: 'spawn EACCES', nodeBin: '/usr/bin/node' },
      [], LABELS,
    );
    expect(out[0].ok).toBe(false);
    expect(out[0].detail).toBe('/opt/homebrew/bin/dsh');
    expect(out[0].error).toBe('spawn EACCES');
  });

  it('fails a missing dsh with the localized hint text', () => {
    const out = buildCheckOutcomes(
      { found: false, bin: '', version: null, error: 'not-found', nodeBin: '/usr/bin/node' },
      [], LABELS,
    );
    expect(out[0]).toEqual({ id: 'dsh', ok: false, detail: '', error: 'dsh not found' });
  });

  it('reports a missing Node.js', () => {
    const out = buildCheckOutcomes(
      { found: true, bin: '/dsh', version: '1.0.0', error: null, nodeBin: null },
      [], LABELS,
    );
    expect(out[1]).toEqual({ id: 'node', ok: false, detail: '', error: 'node not found' });
  });

  it('maps write probes onto outcomes, keeping the path verbatim', () => {
    const out = buildCheckOutcomes(
      { found: true, bin: '/dsh', version: '1.0.0', error: null, nodeBin: '/usr/bin/node' },
      WRITES, LABELS,
    );
    expect(out.map((o) => o.id)).toEqual(['dsh', 'node', 'generatedDir', 'pluginHome']);
    expect(out[2]).toEqual({ id: 'generatedDir', ok: true, detail: WRITES[0].path });
    expect(out[3]).toEqual({ id: 'pluginHome', ok: false, detail: WRITES[1].path, error: 'EACCES' });
  });

  it('produces a report the prompt builder accepts', () => {
    const out = buildCheckOutcomes(
      { found: false, bin: '', version: null, error: null, nodeBin: null },
      WRITES, LABELS,
    );
    expect(hasFailures(out)).toBe(true);
    expect(buildRepairPrompt(out, CTX)).toContain('dsh not found');
  });
});
