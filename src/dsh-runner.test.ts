import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DshRunner, type PreparationIssue } from './dsh-runner';
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

describe('DshRunner generated-file writes are atomic', () => {
  let dir: string;
  let vaultRoot: string;
  let settings: DshSettings;
  let runner: DshRunner;
  const generatedRel = path.join('.obsidian', 'plugins', 'deepharness', 'generated');

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

  function listTmpFiles(folder: string): string[] {
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter((f) => f.endsWith('.tmp'));
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-atomic-'));
    vaultRoot = path.join(dir, 'vault');
    fs.mkdirSync(path.join(vaultRoot, 'Skills'), { recursive: true });
    settings = makeSettings();
    runner = new DshRunner(settings, '.obsidian');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ensureSkillDirsPatch leaves no .tmp file behind', () => {
    settings.extraSkillDirs = 'Skills';
    const file = runner.ensureSkillDirsPatch(vaultRoot);
    expect(file).not.toBeNull();
    expect(fs.existsSync(file as string)).toBe(true);
    expect(listTmpFiles(path.join(vaultRoot, generatedRel))).toEqual([]);
  });

  it('ensureVaultPatch writes persona and stream patches atomically', async () => {
    const res = await runner.ensureVaultPatch(vaultRoot);
    const generated = path.join(vaultRoot, generatedRel);
    expect(res.persona).not.toBeNull();
    expect(res.think).not.toBeNull();
    expect(fs.existsSync(path.join(generated, 'vault.yml'))).toBe(true);
    expect(fs.existsSync(path.join(generated, 'stream.yml'))).toBe(true);
    expect(fs.existsSync(path.join(generated, 'stream-relay.js'))).toBe(true);
    expect(listTmpFiles(generated)).toEqual([]);
    const personaText = fs.readFileSync(path.join(generated, 'vault.yml'), 'utf8');
    expect(personaText).toContain('deepharness-persona-v');
  });

  it('ensurePluginDshHome writes settings.yaml atomically', () => {
    const home = runner.ensurePluginDshHome(vaultRoot, { model: 'deepseek-v4-pro', effort: 'max' });
    expect(home).not.toBeNull();
    const yaml = fs.readFileSync(path.join(home as string, 'settings.yaml'), 'utf8');
    expect(yaml).toContain('model: deepseek-v4-pro');
    expect(yaml).toContain('reasoningEffort: max');
    expect(listTmpFiles(home as string)).toEqual([]);
  });
});

describe('DshRunner preparation degradation reporting (P1-3)', () => {
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-degrade-'));
    vaultRoot = path.join(dir, 'vault');
    fs.mkdirSync(vaultRoot);
    fs.mkdirSync(path.join(vaultRoot, 'Skills'), { recursive: true });
    settings = makeSettings();
    runner = new DshRunner(settings, '.obsidian');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function codes(issues: PreparationIssue[]): string[] {
    return issues.map((i) => i.code);
  }

  it('reports an out-of-vault workdir and falls back to the root', () => {
    settings.workdir = '../outside-vault';
    const issues: PreparationIssue[] = [];
    expect(runner.workdir(vaultRoot, issues)).toBe(vaultRoot);
    expect(codes(issues)).toEqual(['workdir-outside']);
  });

  it('reports an absolute-path workdir outside the vault and falls back', () => {
    settings.workdir = path.join(dir, 'elsewhere');
    const issues: PreparationIssue[] = [];
    expect(runner.workdir(vaultRoot, issues)).toBe(vaultRoot);
    expect(codes(issues)).toEqual(['workdir-outside']);
  });

  it('reports an unwritable workdir and falls back to the root', () => {
    settings.workdir = 'blocked';
    fs.writeFileSync(path.join(vaultRoot, 'blocked'), 'a file in the way');
    const issues: PreparationIssue[] = [];
    expect(runner.workdir(vaultRoot, issues)).toBe(vaultRoot);
    expect(codes(issues)).toEqual(['workdir-mkdir']);
  });

  it('keeps quiet when the workdir is a valid vault-internal folder', () => {
    settings.workdir = 'Skills';
    const issues: PreparationIssue[] = [];
    expect(runner.workdir(vaultRoot, issues)).toBe(path.join(vaultRoot, 'Skills'));
    expect(issues).toEqual([]);
  });

  it('reports rejected extra skill dirs alongside the valid patch', () => {
    settings.extraSkillDirs = `Skills, ${path.join(dir, 'outside-skill')}, ../escape`;
    const issues: PreparationIssue[] = [];
    const file = runner.ensureSkillDirsPatch(vaultRoot, issues);
    expect(file).not.toBeNull();
    expect(codes(issues)).toContain('skill-dirs-rejected');
  });

  it('returns null + an issue when every extra skill dir is rejected', () => {
    settings.extraSkillDirs = '../a, /etc';
    const issues: PreparationIssue[] = [];
    expect(runner.ensureSkillDirsPatch(vaultRoot, issues)).toBeNull();
    expect(codes(issues)).toEqual(['skill-dirs-rejected']);
  });

  it('reports nothing for a legitimately empty extraSkillDirs', () => {
    settings.extraSkillDirs = '';
    const issues: PreparationIssue[] = [];
    expect(runner.ensureSkillDirsPatch(vaultRoot, issues)).toBeNull();
    expect(issues).toEqual([]);
  });

  it('reports when the plugin DSH_HOME cannot be created', () => {
    fs.writeFileSync(path.join(vaultRoot, '.obsidian'), 'a file in the way');
    const issues: PreparationIssue[] = [];
    const home = runner.ensurePluginDshHome(
      vaultRoot,
      { model: 'deepseek-v4-flash', effort: 'high' },
      issues,
    );
    expect(home).toBeNull();
    expect(codes(issues)).toEqual(['dsh-home']);
  });

  it('reports when the generated patch directory cannot be created', async () => {
    fs.writeFileSync(path.join(vaultRoot, '.obsidian'), 'a file in the way');
    const issues: PreparationIssue[] = [];
    const res = await runner.ensureVaultPatch(vaultRoot, issues);
    expect(res.persona).toBeNull();
    expect(res.think).toBeNull();
    expect(codes(issues)).toEqual(['patch-dir']);
  });

  it('reports when the obsidian skill cannot be installed', () => {
    fs.writeFileSync(path.join(vaultRoot, '.obsidian'), 'a file in the way');
    const issues: PreparationIssue[] = [];
    expect(runner.ensureObsidianSkill(vaultRoot, issues)).toBeNull();
    expect(codes(issues)).toEqual(['obsidian-skill']);
  });

  it('stays quiet when the obsidian skill is disabled in settings', () => {
    settings.obsidianSkill = false;
    const issues: PreparationIssue[] = [];
    expect(runner.ensureObsidianSkill(vaultRoot, issues)).toBeNull();
    expect(issues).toEqual([]);
  });

  it('reports when the memory seed file cannot be created', () => {
    fs.writeFileSync(path.join(vaultRoot, 'Harness'), 'a file in the way');
    const issues: PreparationIssue[] = [];
    expect(runner.ensureMemoryFile(vaultRoot, issues)).toBeNull();
    expect(codes(issues)).toEqual(['memory-file']);
  });
});
