import { describe, expect, it, vi } from 'vitest';
import type { DshRunOptions, DshRunResult } from './dsh-client';
import type { DshRunner } from './dsh-runner';
import type { DshSettings } from '../settings/types';
import { BatchExecutorImpl, prepareBatchEnvironment } from './batch-runner';
import type { BatchItem } from '../core/batch-controller';

const settings = {
  model: 'm',
  reasoningEffort: 'high',
  apiKey: '',
  provider: 'deepseek-official',
  toolExecutionMode: 'native',
  permissionMode: 'workspace-write',
  timeoutSec: 60,
} as unknown as DshSettings;

function fakeRunner(): DshRunner {
  return {
    detectBin: vi.fn(async () => '/bin/dsh'),
    detectNode: vi.fn(async () => '/bin/node'),
    resolveDshScript: vi.fn(() => '/bin/dsh.js'),
    ensureVaultPatch: vi.fn(async () => ({ persona: '/p/persona.yml', think: '/p/think.yml' })),
    ensureSkillDirsPatch: vi.fn(() => '/p/skills.yml'),
    ensurePluginDshHome: vi.fn(() => '/home/dsh'),
    dshHome: vi.fn(() => '/home/user-dsh'),
    ensureObsidianSkill: vi.fn(),
    ensureMemoryFile: vi.fn(),
    workdir: vi.fn(() => '/vault'),
    buildTask: vi.fn((message: string) => `TASK:${message}`),
  } as unknown as DshRunner;
}

function item(path: string): BatchItem {
  return { path, status: 'pending' };
}

describe('prepareBatchEnvironment', () => {
  it('prepares the shared environment once and returns localized issues', async () => {
    const runner = fakeRunner();
    const prepared = await prepareBatchEnvironment(runner, '/vault', settings);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.env).toMatchObject({
      bin: '/bin/dsh',
      nodeBin: '/bin/node',
      dshScript: '/bin/dsh.js',
      dshHome: '/home/dsh',
      workdir: '/vault',
      patchPath: ['/p/persona.yml', '/p/think.yml', '/p/skills.yml'],
    });
    expect(runner.ensureVaultPatch).toHaveBeenCalledWith('/vault', expect.any(Array));
  });

  it('stops before spawning when dsh is missing', async () => {
    const runner = fakeRunner();
    (runner.detectBin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const prepared = await prepareBatchEnvironment(runner, '/vault', settings);
    expect(prepared.ok).toBe(false);
  });
});

describe('BatchExecutorImpl', () => {
  it('runs one headless task and returns the parsed answer', async () => {
    const run = vi.fn(async (_task: string, _opts: DshRunOptions): Promise<DshRunResult> => ({
      exitCode: 0,
      stdout: 'changed the note\n',
      stderr: '',
      durationMs: 12,
      killReason: null,
    }));
    const client = { run, stop: vi.fn(), dispose: vi.fn() };
    const runner = fakeRunner();
    const executor = new BatchExecutorImpl(
      client as never,
      runner,
      settings,
      { bin: '/bin/dsh', nodeBin: '/bin/node', dshScript: '/bin/dsh.js', dshHome: '/home/dsh', workdir: '/vault', patchPath: [] },
      'add a tag',
    );

    const result = await executor.run(item('note.md'), new AbortController().signal);

    expect(result).toMatchObject({ ok: true, answer: 'changed the note', durationMs: 12 });
    expect(runner.buildTask).toHaveBeenCalledWith(expect.stringContaining('add a tag'), []);
    const task = run.mock.calls[0][0];
    expect(task).toContain('note.md');
    expect(task).toContain('add a tag');
    expect(run.mock.calls[0][1]).toMatchObject({ cwd: '/vault', permissionMode: 'workspace-write' });
  });

  it('reports a non-zero exit with the first stderr line', async () => {
    const run = vi.fn(async (): Promise<DshRunResult> => ({
      exitCode: 2,
      stdout: '',
      stderr: 'permission denied\nmore',
      durationMs: 3,
      killReason: null,
    }));
    const executor = new BatchExecutorImpl(
      { run, stop: vi.fn(), dispose: vi.fn() } as never,
      fakeRunner(),
      settings,
      { bin: '/bin/dsh', nodeBin: '/bin/node', dshScript: '/bin/dsh.js', dshHome: '/home/dsh', workdir: '/vault', patchPath: [] },
      'do it',
    );
    const result = await executor.run(item('bad.md'), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: 'permission denied' });
  });
});
