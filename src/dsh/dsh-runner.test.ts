import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DshRunner, diagnosticProbe, type PreparationIssue } from './dsh-runner';
import { DSH_ENV_ALLOWLIST } from './dsh-client';
import { DEFAULT_SETTINGS, type DshSettings } from '../settings/index';

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
      models: ['deepseek-flash', 'deepseek-v4-flash'],
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
  let userHome: string;
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
      models: ['deepseek-flash', 'deepseek-v4-flash'],
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
    // The plugin's DSH_HOME now lives under the user's real DSH root; point it
    // at the temp dir so a test run never touches the machine's actual ~/.dsh.
    userHome = path.join(dir, 'user-dsh');
    fs.mkdirSync(userHome, { recursive: true });
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
    const home = runner.ensurePluginDshHome(
      vaultRoot,
      { model: 'deepseek-v4-pro', effort: 'max' },
      undefined,
      userHome,
    );
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
  let userHome: string;
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
      models: ['deepseek-flash', 'deepseek-v4-flash'],
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
    // The plugin's DSH_HOME now lives under the user's real DSH root; point it
    // at the temp dir so a test run never touches the machine's actual ~/.dsh.
    userHome = path.join(dir, 'user-dsh');
    fs.mkdirSync(userHome, { recursive: true });
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

  it('removes a stale skill-dirs patch when the setting is cleared', () => {
    // Found in the wild: extraSkillDirs emptied, but the patch written by a
    // previous run survived and kept pointing DSH at a vault folder that holds
    // no skills. Nothing to register must mean nothing registered.
    settings.extraSkillDirs = 'Skills';
    const written = runner.ensureSkillDirsPatch(vaultRoot);
    expect(written).not.toBeNull();
    expect(fs.existsSync(written as string)).toBe(true);

    settings.extraSkillDirs = '';
    expect(runner.ensureSkillDirsPatch(vaultRoot)).toBeNull();
    expect(fs.existsSync(written as string)).toBe(false);
  });

  it('is idempotent when there was never a patch to remove', () => {
    settings.extraSkillDirs = '';
    expect(runner.ensureSkillDirsPatch(vaultRoot)).toBeNull();
    expect(runner.ensureSkillDirsPatch(vaultRoot)).toBeNull();
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
    // Block both locations: the system one (a file where the per-vault folder
    // goes) and the legacy in-vault one. Only then is there nowhere to run from,
    // and the caller falls back to the user's real DSH_HOME.
    fs.writeFileSync(path.join(userHome, 'deepharness'), 'a file in the way');
    fs.writeFileSync(path.join(vaultRoot, '.obsidian'), 'a file in the way');
    const issues: PreparationIssue[] = [];
    const home = runner.ensurePluginDshHome(
      vaultRoot,
      { model: 'deepseek-v4-flash', effort: 'high' },
      issues,
      userHome,
    );
    expect(home).toBeNull();
    // Migration is reported first, then the DSH_HOME failure.
    expect(codes(issues)).toEqual(['dsh-home-migrate', 'dsh-home']);
  });

  it('uses the system location for a fresh install, never the vault', () => {
    const issues: PreparationIssue[] = [];
    const home = runner.ensurePluginDshHome(
      vaultRoot,
      { model: 'deepseek-v4-flash', effort: 'high' },
      issues,
      userHome,
    );
    expect(issues).toEqual([]);
    expect(home).not.toBeNull();
    expect((home as string).startsWith(path.join(userHome, 'deepharness'))).toBe(true);
    expect((home as string).startsWith(vaultRoot)).toBe(false);
    // No in-vault dsh-home is created at all for a new install.
    expect(fs.existsSync(path.join(vaultRoot, '.obsidian', 'plugins', 'deepharness', 'dsh-home')))
      .toBe(false);
  });

  it('falls back to the legacy in-vault home when the system location fails', () => {
    // A pre-existing install: the legacy tree has content the plugin can use.
    const legacy = path.join(vaultRoot, '.obsidian', 'plugins', 'deepharness', 'dsh-home');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'history.json'), '{"sessions":[]}', 'utf8');
    fs.writeFileSync(path.join(userHome, 'deepharness'), 'a file in the way');

    const issues: PreparationIssue[] = [];
    const home = runner.ensurePluginDshHome(
      vaultRoot,
      { model: 'deepseek-v4-flash', effort: 'high' },
      issues,
      userHome,
    );

    // Degraded, but working: it runs from the legacy location rather than
    // refusing to start, and the user is told why.
    expect(home).toBe(legacy);
    expect(codes(issues)).toEqual(['dsh-home-migrate']);
  });

  it('migrates an existing in-vault home out of the vault, keeping the old tree', () => {
    const legacy = path.join(vaultRoot, '.obsidian', 'plugins', 'deepharness', 'dsh-home');
    fs.mkdirSync(path.join(legacy, 'skills', 'obsidian'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'history.json'), '{"sessions":["kept"]}', 'utf8');
    fs.writeFileSync(path.join(legacy, '.anonymous-user-id'), 'abc', 'utf8');
    fs.writeFileSync(path.join(legacy, 'skills', 'obsidian', 'SKILL.md'), '# skill', 'utf8');

    const issues: PreparationIssue[] = [];
    const home = runner.ensurePluginDshHome(
      vaultRoot,
      { model: 'deepseek-v4-flash', effort: 'high' },
      issues,
      userHome,
    );

    expect(issues).toEqual([]);
    // It must NOT be inside the vault any more — that is the whole point.
    expect(home).not.toBeNull();
    expect((home as string).startsWith(vaultRoot)).toBe(false);
    expect((home as string).startsWith(userHome)).toBe(true);
    // The data users cannot regenerate travelled with it.
    expect(fs.readFileSync(path.join(home as string, 'history.json'), 'utf8')).toContain('kept');
    expect(fs.readFileSync(path.join(home as string, '.anonymous-user-id'), 'utf8')).toBe('abc');
    expect(fs.existsSync(path.join(home as string, 'skills', 'obsidian', 'SKILL.md'))).toBe(true);
    // The source tree is left intact: it is the rollback path.
    expect(fs.existsSync(path.join(legacy, 'history.json'))).toBe(true);
  });

  it('writes the built-in skill into the prepared home, never back into the vault', () => {
    // Regression: ensureObsidianSkill derived its target from pluginHomeDir(),
    // which is the *legacy* in-vault path — so every run re-created
    // `<vault>/…/dsh-home/skills/obsidian`, undoing the migration that had just
    // moved that whole tree out of the synced folder.
    const home = runner.ensurePluginDshHome(
      vaultRoot,
      { model: 'deepseek-flash', effort: 'high' },
      undefined,
      userHome,
    );
    const dir = runner.ensureObsidianSkill(
      vaultRoot,
      undefined,
      home as string,
    );
    expect(dir).not.toBeNull();
    expect((dir as string).startsWith(home as string)).toBe(true);
    expect(fs.existsSync(path.join(home as string, 'skills', 'obsidian', 'SKILL.md'))).toBe(true);
    // The vault must stay free of any dsh-home tree.
    expect(fs.existsSync(path.join(vaultRoot, '.obsidian', 'plugins', 'deepharness', 'dsh-home')))
      .toBe(false);
  });

  it('does not copy the bootstrap profile cache during migration', () => {
    // profiles/ is DSH's own cache (400+ symlinks on macOS, tens of thousands
    // of files on Windows) and DSH rebuilds it. Copying it would be the slowest
    // part of the move and the very thing that broke synced vaults.
    const legacy = path.join(vaultRoot, '.obsidian', 'plugins', 'deepharness', 'dsh-home');
    fs.mkdirSync(path.join(legacy, 'profiles', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'profiles', 'node_modules', 'junk.js'), 'x', 'utf8');

    const home = runner.ensurePluginDshHome(
      vaultRoot,
      { model: 'deepseek-v4-flash', effort: 'high' },
      undefined,
      userHome,
    );

    expect(fs.existsSync(path.join(home as string, 'profiles'))).toBe(false);
  });

  it('is idempotent: a second run does not re-copy over the migrated home', () => {
    const legacy = path.join(vaultRoot, '.obsidian', 'plugins', 'deepharness', 'dsh-home');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'history.json'), 'old', 'utf8');

    const first = runner.ensurePluginDshHome(vaultRoot, { model: 'm', effort: 'high' }, undefined, userHome);
    // The plugin has since written its own history at the new location.
    fs.writeFileSync(path.join(first as string, 'history.json'), 'new', 'utf8');

    const second = runner.ensurePluginDshHome(vaultRoot, { model: 'm', effort: 'high' }, undefined, userHome);
    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(second as string, 'history.json'), 'utf8')).toBe('new');
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

describe('DshRunner inherits the user DSH_HOME config', () => {
  let dir: string;
  let vaultRoot: string;
  let userHome: string;
  let settings: DshSettings;
  let runner: DshRunner;

  const USER_SETTINGS = [
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: deepseek-flash',
    'llm-deepseek:',
    '  models:',
    '    - id: deepseek-v4-flash',
    '      name: DeepSeek-V4-Flash',
    '      description: wrapped onto a continuation line',
    '        that a naive reader would misread',
    '      contextWindow: 1000000',
    '    - id: deepseek-flash',
    '      name: DeepSeek-V41-Flash',
    'llm-pi-ai:',
    '  providers:',
    '    my-gateway:',
    '      displayName: My Gateway',
    '      baseURL: https://gw.example/v1',
    '',
  ].join('\n');

  function makeSettings(provider: string): DshSettings {
    return {
      dshBin: '',
      nodeBin: '',
      dshHome: userHome,
      models: ['deepseek-flash'],
      workdir: '',
      timeoutSec: 600,
      memoryEnabled: true,
      language: 'auto',
      customPersona: '',
      toolExecutionMode: '',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      permissionMode: 'workspace-write',
      showThinking: true,
      showTools: true,
      historyLimit: 50,
      obsidianSkill: true,
      extraSkillDirs: '',
      apiKey: '',
      provider,
    };
  }

  function readPluginYaml(): string {
    const home = runner.ensurePluginDshHome(
      vaultRoot,
      { model: 'deepseek-flash', effort: 'high' },
      undefined,
      userHome,
    );
    expect(home).not.toBeNull();
    return fs.readFileSync(path.join(home as string, 'settings.yaml'), 'utf8');
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-inherit-'));
    vaultRoot = path.join(dir, 'vault');
    userHome = path.join(dir, 'user-dsh');
    fs.mkdirSync(vaultRoot);
    fs.mkdirSync(userHome, { recursive: true });
    fs.writeFileSync(path.join(userHome, 'settings.yaml'), USER_SETTINGS);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT copy the llm-deepseek catalog into the plugin home', () => {
    // The model list is owned by the plugin's own settings. Inheriting a
    // catalog that only exists for users who opened DSH's model settings is
    // exactly the invisible, client-dependent behaviour that was removed.
    settings = makeSettings('deepseek-official');
    runner = new DshRunner(settings, '.obsidian');
    const yaml = readPluginYaml();
    expect(yaml).not.toContain('llm-deepseek:');
    expect(yaml).not.toContain('DeepSeek-V41-Flash');
    // The generated file is only the selection, as before.
    expect(yaml).toContain('model: deepseek-flash');
  });

  it('copies the user\'s llm-pi-ai block for the opencode-go route', () => {
    settings = makeSettings('opencode-go');
    runner = new DshRunner(settings, '.obsidian');
    const yaml = readPluginYaml();
    expect(yaml).toContain('my-gateway:');
    expect(yaml).toContain('baseURL: https://gw.example/v1');
    expect(yaml).toContain('provider: opencode-go');
  });

  it('keeps the opencode-go synthetic fallback when the user declares no llm-pi-ai', () => {
    fs.writeFileSync(
      path.join(userHome, 'settings.yaml'),
      'llm-deepseek:\n  models:\n    - id: deepseek-flash\n',
    );
    settings = makeSettings('opencode-go');
    runner = new DshRunner(settings, '.obsidian');
    const yaml = readPluginYaml();
    expect(yaml).toContain('opencode-go:');
    expect(yaml).toContain('OPENCODE_GO_API_KEY');
  });

  it('does not invent a provider block for an unknown route', () => {
    fs.writeFileSync(
      path.join(userHome, 'settings.yaml'),
      'llm-deepseek:\n  models:\n    - id: deepseek-flash\n',
    );
    settings = makeSettings('some-unconfigured-route');
    runner = new DshRunner(settings, '.obsidian');
    const yaml = readPluginYaml();
    expect(yaml).not.toContain('OPENCODE_GO_API_KEY');
    expect(yaml).toContain('provider: some-unconfigured-route');
  });

  it('still writes agent-default-model when the user has no settings.yaml', () => {
    fs.rmSync(path.join(userHome, 'settings.yaml'));
    settings = makeSettings('deepseek-official');
    runner = new DshRunner(settings, '.obsidian');
    const yaml = readPluginYaml();
    expect(yaml).toContain('provider: deepseek-official');
    expect(yaml).toContain('model: deepseek-flash');
    expect(yaml).not.toContain('llm-deepseek:');
  });

  it('exposes the user catalog and provider routes, memoized on mtime', () => {
    settings = makeSettings('deepseek-official');
    runner = new DshRunner(settings, '.obsidian');
    const snap = runner.userDshConfig();
    expect(snap?.models.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-flash']);
    expect(snap?.providers.map((p) => p.id)).toEqual(['my-gateway']);
    // Same mtime => the same memoized object, not a re-read.
    expect(runner.userDshConfig()).toBe(snap);
  });

  it('reports null rather than throwing when the DSH_HOME is unreadable', () => {
    settings = makeSettings('deepseek-official');
    settings.dshHome = path.join(dir, 'does-not-exist');
    runner = new DshRunner(settings, '.obsidian');
    expect(runner.userDshConfig()).toBeNull();
  });
});

describe('diagnosticProbe (D-2: the version probe uses the env whitelist)', () => {
  const bin = '/opt/homebrew/bin/dsh';
  const nodeBin = '/opt/homebrew/bin/node';
  const script = '/opt/homebrew/lib/node_modules/dsh/bin.js';
  const dshHome = '/Users/me/.dsh';

  it('prefers node <script> so the shebang cannot break under Electron', () => {
    const probe = diagnosticProbe(bin, nodeBin, script, dshHome);
    expect(probe.cmd).toBe(nodeBin);
    expect(probe.args).toEqual([script, '--version']);
  });

  it('falls back to the binary itself when it is not node-runnable', () => {
    expect(diagnosticProbe(bin, null, null, dshHome)).toMatchObject({
      cmd: bin,
      args: ['--version'],
    });
    expect(diagnosticProbe(bin, nodeBin, null, dshHome).cmd).toBe(bin);
  });

  it('points the probe at the configured DSH_HOME', () => {
    expect(diagnosticProbe(bin, nodeBin, script, dshHome).env.DSH_HOME).toBe(dshHome);
  });

  it('never hands the child the plugin process secrets or whole environment', () => {
    const env = diagnosticProbe(bin, nodeBin, script, dshHome).env;
    // The probe must not carry credentials around: no API key is injected.
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.OPENCODE_GO_API_KEY).toBeUndefined();
    // And it is the allowlist, not `{...process.env}`: a random variable from
    // the plugin's own process must not reach the child.
    for (const key of Object.keys(env)) {
      expect(DSH_ENV_ALLOWLIST.has(key) || key === 'DSH_HOME').toBe(true);
    }
  });
});

describe('DshRunner.ensureVaultPatch persona regeneration', () => {
  let dir: string;
  let vaultRoot: string;
  let generated: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-'));
    vaultRoot = path.join(dir, 'vault');
    generated = path.join(vaultRoot, '.obsidian', 'plugins', 'deepharness', 'generated');
    fs.mkdirSync(generated, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The real defaults, not a hand-copied subset: this path reads several
   *  fields (customPersona, dshHome, …) and a partial cast silently produced no
   *  file at all. */
  const makeRunner = (overrides: Partial<DshSettings> = {}): DshRunner =>
    new DshRunner({ ...DEFAULT_SETTINGS, ...overrides }, '.obsidian');

  const personaFile = (): string => path.join(generated, 'vault.yml');
  const bakFile = (): string => `${personaFile()}.bak`;

  it('writes a persona carrying the current version marker', async () => {
    const made = makeRunner();
    await made.ensureVaultPatch(vaultRoot);
    expect(fs.readFileSync(personaFile(), 'utf8')).toContain('deepharness-persona-v');
  });

  it('leaves a current file alone (no rewrite, no backup)', async () => {
    const made = makeRunner();
    await made.ensureVaultPatch(vaultRoot);
    const first = fs.readFileSync(personaFile(), 'utf8');

    await made.ensureVaultPatch(vaultRoot);
    expect(fs.readFileSync(personaFile(), 'utf8')).toBe(first);
    expect(fs.existsSync(bakFile())).toBe(false);
  });

  it('backs up the previous persona before regenerating a stale one', async () => {
    // An older marker (version bump or UI-language change): the old file is
    // preserved as .bak so user edits are never lost. This path had no test.
    const stale = '# deepharness-persona-v4-en\nmy own edits\n';
    fs.writeFileSync(personaFile(), stale, 'utf8');

    const made = makeRunner();
    await made.ensureVaultPatch(vaultRoot);

    expect(fs.readFileSync(bakFile(), 'utf8')).toBe(stale);
    const regenerated = fs.readFileSync(personaFile(), 'utf8');
    expect(regenerated).not.toBe(stale);
    expect(regenerated).toContain('deepharness-persona-v');
  });

  it('backs up even an untouched pre-v2 default file (behaviour change)', async () => {
    // The removed renderLegacyPersonaYaml existed only to skip the backup when
    // the file was byte-for-byte the v2 default. Three versions later
    // (PERSONA_VERSION 5) its sole effect was suppressing one harmless .bak, so
    // the backup is now unconditional. This test pins that: the old code left
    // no .bak for exactly this input, the new code does.
    const v2Default = [
      '# 由 deepharness 生成。可自由编辑,插件不会覆盖此文件。',
      '- id: system-prompt',
      '  config:',
      '    persona: >-',
      '      你是运行在 Obsidian vault 里的 DeepSeek Harness 助手。',
      '      你的工作目录 {{cwd}} 就是用户的 vault。',
      '      规则:',
      '      1. 新建笔记使用 Markdown + YAML frontmatter,笔记间用 [[wikilink]] 互链。',
      '',
    ].join('\n');
    fs.writeFileSync(personaFile(), v2Default, 'utf8');

    const made = makeRunner();
    await made.ensureVaultPatch(vaultRoot);

    expect(fs.readFileSync(personaFile(), 'utf8')).toContain('deepharness-persona-v5');
    expect(fs.readFileSync(bakFile(), 'utf8')).toBe(v2Default);
  });

  it('regenerates when a custom persona is missing from the file', async () => {
    const made = makeRunner({ customPersona: 'ALWAYS ANSWER IN LATIN' });
    await made.ensureVaultPatch(vaultRoot);
    const first = fs.readFileSync(personaFile(), 'utf8');

    // Simulate the user wiping the custom block: the marker is still current,
    // so only the customMissing check can catch this.
    fs.writeFileSync(personaFile(), first.replace('ALWAYS ANSWER IN LATIN', ''), 'utf8');
    await made.ensureVaultPatch(vaultRoot);
    expect(fs.readFileSync(personaFile(), 'utf8')).toContain('ALWAYS ANSWER IN LATIN');
  });
});
