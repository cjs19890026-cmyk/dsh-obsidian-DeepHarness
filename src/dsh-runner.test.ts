import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
