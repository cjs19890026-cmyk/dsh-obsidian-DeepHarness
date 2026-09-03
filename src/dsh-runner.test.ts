import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DshRunner } from './dsh-runner';
import type { DshSettings } from './settings';

/**
 * extraSkillDirs containment at the DSH patch level: ensureSkillDirsPatch
 * hands resolved directories to DSH's skill scanner, so only vault-internal
 * relative dirs may ever reach the generated patch.
 */

let tmp: string;
let vault: string;
let configDir: string;
let settings: DshSettings;
let runner: DshRunner;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-test-'));
  vault = path.join(tmp, 'vault');
  configDir = '.obsidian';
  fs.mkdirSync(path.join(vault, 'Skills'), { recursive: true });
  fs.mkdirSync(path.join(vault, configDir, 'plugins', 'deepharness', 'generated'), {
    recursive: true,
  });
  // ensureSkillDirsPatch only reads settings.extraSkillDirs.
  settings = { extraSkillDirs: '' } as unknown as DshSettings;
  runner = new DshRunner(settings, configDir);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('DshRunner.ensureSkillDirsPatch extraSkillDirs containment', () => {
  /** Run the patch for a CSV of extra dirs and return its text (null = nothing registered). */
  function patchText(dirsCsv: string): string | null {
    settings.extraSkillDirs = dirsCsv;
    const file = runner.ensureSkillDirsPatch(vault);
    return file ? fs.readFileSync(file, 'utf8') : null;
  }

  /** JSON-quoted vault-internal dir, computed lazily (vault exists only after beforeAll). */
  const skillsDir = (): string => JSON.stringify(path.join(vault, 'Skills'));

  it('registers a vault-internal dir and rejects a ../ escape', () => {
    const yml = patchText('Skills, ../outside-skill');
    expect(yml).not.toBeNull();
    expect(yml!).toContain(skillsDir());
    expect(yml!).not.toContain('outside-skill');
  });

  it('rejects absolute extra dirs', () => {
    const evilAbs = path.join(tmp, 'evil-abs-skill');
    fs.mkdirSync(evilAbs, { recursive: true });
    const yml = patchText(`Skills, ${evilAbs}`);
    expect(yml).not.toBeNull();
    expect(yml!).toContain(skillsDir());
    expect(yml!).not.toContain(JSON.stringify(evilAbs));
  });

  it('returns null when every entry is rejected', () => {
    expect(patchText('../a, ../../b')).toBeNull();
    expect(patchText('/etc, /tmp/x')).toBeNull();
  });

  it('skips missing vault-internal dirs (valid empty state)', () => {
    const yml = patchText('Skills, MissingDir');
    expect(yml).not.toBeNull();
    expect(yml!).toContain(skillsDir());
    expect(yml!).not.toContain('MissingDir');
  });
});

describe('DshRunner.buildTask and workdir', () => {
  let dir: string;
  let vaultRoot: string;
  let settings: DshSettings;
  let runner: DshRunner;

  function makeSettings(): DshSettings {
    return {
      dshBin: '',
      nodeBin: '',
      dshHome: '~/.dsh',
      workdir: '',
      timeoutSec: 600,
      memoryEnabled: true,
      language: 'auto',
      customPersona: '',
      toolExecutionMode: '',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      permissionMode: 'workspace-write',
      showThinking: true,
      showTools: true,
      historyLimit: 50,
      obsidianSkill: true,
      extraSkillDirs: '',
      apiKey: '',
      provider: 'deepseek-official',
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-btask-'));
    vaultRoot = path.join(dir, 'vault');
    fs.mkdirSync(vaultRoot);
    settings = makeSettings();
    runner = new DshRunner(settings, '.obsidian');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('buildTask', () => {
    it('joins enabled memory and the user message', () => {
      settings.memoryEnabled = true;
      const task = runner.buildTask('do the work', ['Memory one', 'Memory two']);
      expect(task).toBe('Memory one\nMemory two\n\ndo the work');
    });

    it('omits memory when disabled', () => {
      settings.memoryEnabled = false;
      const task = runner.buildTask('do the work', ['Memory one']);
      expect(task).toBe('do the work');
    });

    it('omits memory when the memory list is empty', () => {
      settings.memoryEnabled = true;
      const task = runner.buildTask('do the work', []);
      expect(task).toBe('do the work');
    });

    it('includes trimmed extra context as a labeled block', () => {
      const task = runner.buildTask('summarize', [], '  please be concise  ');
      expect(task).toBe('[上下文]\nplease be concise\n\nsummarize');
    });

    it('omits whitespace-only extra context', () => {
      const task = runner.buildTask('summarize', [], '   ');
      expect(task).toBe('summarize');
    });

    it('orders memory, extra context, then user message', () => {
      settings.memoryEnabled = true;
      const task = runner.buildTask('write it', ['Memory one'], 'Context here');
      expect(task).toBe('Memory one\n\n[上下文]\nContext here\n\nwrite it');
    });
  });

  describe('workdir boundary', () => {
    it('returns the vault root for an empty workdir setting', () => {
      settings.workdir = '';
      expect(runner.workdir(vaultRoot)).toBe(vaultRoot);
    });

    it('creates and returns a vault-internal relative workdir', () => {
      settings.workdir = 'Projects/DeepHarness';
      const work = runner.workdir(vaultRoot);
      expect(work).toBe(path.join(vaultRoot, 'Projects', 'DeepHarness'));
      expect(fs.existsSync(work)).toBe(true);
    });

    it('accepts an absolute path that stays inside the vault', () => {
      settings.workdir = path.join(vaultRoot, 'Inside');
      const work = runner.workdir(vaultRoot);
      expect(work).toBe(path.join(vaultRoot, 'Inside'));
      expect(fs.existsSync(work)).toBe(true);
    });

    it('falls back to the vault root for a parent-directory escape', () => {
      settings.workdir = '../outside-vault';
      const outside = path.resolve(vaultRoot, settings.workdir);
      expect(runner.workdir(vaultRoot)).toBe(vaultRoot);
      expect(fs.existsSync(outside)).toBe(false);
    });

    it('falls back to the vault root for an absolute path outside the vault', () => {
      settings.workdir = path.join(dir, 'outside-vault');
      expect(runner.workdir(vaultRoot)).toBe(vaultRoot);
      expect(fs.existsSync(path.join(dir, 'outside-vault'))).toBe(false);
    });
  });
});
