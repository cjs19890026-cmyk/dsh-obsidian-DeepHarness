import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { DshClient } from './dsh-client';

/**
 * killReason tests: the real DshClient can spawn a short-lived node child that
 * ignores its argv, so no `dsh` binary is needed. DshClient now uses injected
 * or global timers, so no `window` shim is required in Node.
 */

let keepAliveJs: string;
let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-test-'));
  keepAliveJs = path.join(tmp, 'keep-alive.js');
  fs.writeFileSync(keepAliveJs, 'setInterval(() => {}, 1000);\n', 'utf8');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runOpts(extra: Record<string, unknown>) {
  return {
    dshBin: process.execPath, // unused: nodeBin + dshScript take precedence
    nodeBin: process.execPath,
    dshScript: keepAliveJs,
    cwd: tmp,
    ...extra,
  };
}

function createNodeClient(): DshClient {
  return new DshClient({
    setTimeout: ((handler: () => void, timeout?: number) => globalThis.setTimeout(handler, timeout)) as never,
    clearTimeout: ((handle: unknown) => globalThis.clearTimeout(handle as number)) as never,
  });
}


describe('DshClient killReason', () => {
  it('reports killReason "timeout" when the run exceeds timeoutMs', async () => {
    const client = createNodeClient();
    try {
      const result = await client.run('ignored', runOpts({ timeoutMs: 300 }));
      expect(result.killReason).toBe('timeout');
      expect(result.killed).toBe(true);
      expect(result.exitCode).toBeNull();
    } finally {
      client.dispose();
    }
  });

  it('reports killReason "user" when the caller aborts the signal', async () => {
    const client = createNodeClient();
    const controller = new AbortController();
    try {
      const pending = client.run('ignored', runOpts({ signal: controller.signal }));
      globalThis.setTimeout(() => controller.abort(), 150);
      const result = await pending;
      expect(result.killReason).toBe('user');
      expect(result.killed).toBe(true);
      expect(result.exitCode).toBeNull();
    } finally {
      client.dispose();
    }
  });

  it('keeps killReason null when the child exits on its own', async () => {
    const client = createNodeClient();
    try {
      // An already-resolved AbortSignal would kill; here nothing aborts and
      // the child runs until SIGTERM never comes — so use a script that
      // exits by itself instead.
      const exitJs = path.join(tmp, 'exit.js');
      fs.writeFileSync(exitJs, 'process.exit(0);\n', 'utf8');
      const result = await client.run('ignored', {
        dshBin: process.execPath,
        nodeBin: process.execPath,
        dshScript: exitJs,
        cwd: tmp,
        timeoutMs: 5000,
      });
      expect(result.killReason).toBeNull();
      expect(result.killed).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally {
      client.dispose();
    }
  });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
}

function createFakeSpawn() {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_bin: string, _args: string[], _options: unknown) => {
    const child = new EventEmitter() as unknown as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = undefined;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = vi.fn((_signal?: NodeJS.Signals) => {
      child.killed = true;
      queueMicrotask(() => child.emit('close', null));
      return true;
    });
    children.push(child);
    return child;
  });
  return { spawn, children };
}

function createFakeTimers() {
  const callbacks: Array<() => void> = [];
  const setTimeoutFn = vi.fn((callback: () => void) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const clearTimeoutFn = vi.fn();
  return { setTimeoutFn, clearTimeoutFn, callbacks };
}

function fakeClient(deps: ReturnType<typeof createFakeSpawn> & ReturnType<typeof createFakeTimers>) {
  return new DshClient({
    spawn: deps.spawn as never,
    setTimeout: deps.setTimeoutFn as never,
    clearTimeout: deps.clearTimeoutFn as never,
  });
}

describe('DshClient injected dependencies', () => {
  it('spawns node with patch args and plugin env vars', async () => {
    const fake = {
      ...createFakeSpawn(),
      ...createFakeTimers(),
    };
    const client = fakeClient(fake);
    try {
      const pending = client.run('hello task', {
        dshBin: '/fake/dsh',
        nodeBin: '/fake/node',
        dshScript: '/fake/dsh/bin.js',
        cwd: '/tmp/vault',
        dshHome: '/tmp/dsh-home',
        apiKey: 'sk-test',
        provider: 'opencode-go',
        toolsMode: 'code',
        permissionMode: 'workspace-write',
        patchPath: ['/tmp/p1.yml', '/tmp/p2.yml'],
      });

      expect(fake.spawn).toHaveBeenCalledTimes(1);
      expect(fake.spawn).toHaveBeenCalledWith(
        '/fake/node',
        ['/fake/dsh/bin.js', '--profile', 'headless', '--patch', '/tmp/p1.yml', '--patch', '/tmp/p2.yml', 'hello task'],
        expect.objectContaining({
          cwd: '/tmp/vault',
          env: expect.objectContaining({
            DSH_HOME: '/tmp/dsh-home',
            OPENCODE_GO_API_KEY: 'sk-test',
            DSH_TOOLS_MODE: 'code',
            DSH_PERMISSION_MODE: 'workspace-write',
          }),
          shell: false,
          detached: true,
        }),
      );

      fake.children[0].emit('close', 0);
      const result = await pending;
      expect(result.exitCode).toBe(0);
      expect(result.killReason).toBeNull();
    } finally {
      client.dispose();
    }
  });

  it('forwards spawn errors without hanging', async () => {
    const fake = {
      ...createFakeSpawn(),
      ...createFakeTimers(),
    };
    const client = fakeClient(fake);
    try {
      const pending = client.run('ignored', {
        dshBin: '/missing/dsh',
        cwd: '/tmp/vault',
      });

      fake.children[0].emit('error', new Error('ENOENT'));
      const result = await pending;
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain('spawn error: ENOENT');
    } finally {
      client.dispose();
    }
  });

  it('supports fake-timer timeout kills', async () => {
    const fake = {
      ...createFakeSpawn(),
      ...createFakeTimers(),
    };
    const client = fakeClient(fake);
    try {
      const pending = client.run('ignored', {
        dshBin: '/fake/dsh',
        cwd: '/tmp/vault',
        timeoutMs: 100,
      });

      expect(fake.callbacks.length).toBeGreaterThan(0);
      fake.callbacks[0]();
      const result = await pending;
      expect(result.killReason).toBe('timeout');
      expect(result.killed).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(fake.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      client.dispose();
    }
  });

  it('supports injected timers for user abort', async () => {
    const fake = {
      ...createFakeSpawn(),
      ...createFakeTimers(),
    };
    const client = fakeClient(fake);
    const controller = new AbortController();
    try {
      const pending = client.run('ignored', {
        dshBin: '/fake/dsh',
        cwd: '/tmp/vault',
        signal: controller.signal,
      });

      controller.abort();
      const result = await pending;
      expect(result.killReason).toBe('user');
      expect(result.killed).toBe(true);
      expect(fake.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      client.dispose();
    }
  });
});

