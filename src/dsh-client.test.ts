import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { DshClient, buildDshEnv, DSH_ENV_ALLOWLIST } from './dsh-client';

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

describe('buildDshEnv (env whitelist)', () => {
  it('inherits only allowlisted keys from the source environment', () => {
    const source: Record<string, string | undefined> = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      USER: 'user',
      DEEPSEEK_API_KEY: 'sk-must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'shh',
      MY_APP_TOKEN: 'nope',
    };
    const env = buildDshEnv({ dshBin: '/fake/dsh', cwd: '/tmp/vault' }, source);
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      USER: 'user',
    });
  });

  it('keeps the child env minimal when nothing is configured', () => {
    const env = buildDshEnv({ dshBin: '/fake/dsh', cwd: '/tmp/vault' }, {});
    expect(Object.keys(env)).toHaveLength(0);
  });

  it('merges opts.env entries (explicit plugin opt-in) over the allowlist', () => {
    const env = buildDshEnv(
      {
        dshBin: '/fake/dsh',
        cwd: '/tmp/vault',
        env: { MY_FEATURE_FLAG: '1', PATH: '/opt/custom/bin:/usr/bin' },
      },
      { PATH: '/usr/bin:/bin', HOME: '/home/user' },
    );
    expect(env.MY_FEATURE_FLAG).toBe('1');
    expect(env.PATH).toBe('/opt/custom/bin:/usr/bin'); // opts.env beats inheritance
    expect(env.HOME).toBe('/home/user'); // inherited key kept
  });

  it('injects the API key as DEEPSEEK_API_KEY for the default provider', () => {
    const env = buildDshEnv(
      { dshBin: '/fake/dsh', cwd: '/tmp/vault', apiKey: 'sk-1' },
      {},
    );
    expect(env.DEEPSEEK_API_KEY).toBe('sk-1');
    expect(env.OPENCODE_GO_API_KEY).toBeUndefined();
  });

  it('injects plugin-owned vars and lets them win over opts.env', () => {
    const env = buildDshEnv(
      {
        dshBin: '/fake/dsh',
        cwd: '/tmp/vault',
        dshHome: '/tmp/dsh-home',
        apiKey: 'sk-abc',
        provider: 'opencode-go',
        toolsMode: 'both',
        permissionMode: 'workspace-write',
        env: {
          DSH_HOME: '/tmp/wrong',
          OPENCODE_GO_API_KEY: 'wrong-key',
          DSH_TOOLS_MODE: 'native',
        },
      },
      {},
    );
    expect(env.DSH_HOME).toBe('/tmp/dsh-home');
    expect(env.OPENCODE_GO_API_KEY).toBe('sk-abc');
    expect(env.DSH_TOOLS_MODE).toBe('both');
    expect(env.DSH_PERMISSION_MODE).toBe('workspace-write');
  });

  it('prepends the node dir to PATH when spawning node directly', () => {
    const env = buildDshEnv(
      {
        dshBin: '/fake/dsh',
        nodeBin: '/opt/node/bin/node',
        dshScript: '/fake/dsh/bin.js',
        cwd: '/tmp/vault',
      },
      { PATH: '/usr/bin:/bin' },
    );
    expect(env.PATH).toBe(`/opt/node/bin${path.delimiter}/usr/bin:/bin`);
  });

  it('falls back to a sane PATH when the source has none', () => {
    const sep = path.delimiter;
    const fallback = process.platform === 'win32'
      ? 'C:\\Windows\\System32;C:\\Windows'
      : '/usr/bin:/bin';
    const env = buildDshEnv(
      {
        dshBin: '/fake/dsh',
        nodeBin: '/opt/node/bin/node',
        cwd: '/tmp/vault',
      },
      { HOME: '/home/user' },
    );
    expect(env.PATH).toBe(`/opt/node/bin${sep}${fallback}`);
    expect(env.HOME).toBe('/home/user');
  });
});

describe('DshClient env isolation', () => {
  it('never forwards non-allowlisted process.env keys to the child', async () => {
    const leakKey = '__DSH_ENV_LEAK_GUARD__';
    const before = process.env[leakKey];
    process.env[leakKey] = 'super-secret';
    const fake = {
      ...createFakeSpawn(),
      ...createFakeTimers(),
    };
    const client = fakeClient(fake);
    try {
      const pending = client.run('ignored', {
        dshBin: '/fake/dsh',
        cwd: '/tmp/vault',
        dshHome: '/tmp/dsh-home',
        apiKey: 'sk-1',
        toolsMode: 'code',
        permissionMode: 'workspace-write',
      });

      const [, , spawnOpts] = fake.spawn.mock.calls[0] as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      const pluginOwned = [
        'DSH_HOME',
        'DEEPSEEK_API_KEY',
        'DSH_TOOLS_MODE',
        'DSH_PERMISSION_MODE',
      ];
      for (const key of Object.keys(spawnOpts.env)) {
        expect(DSH_ENV_ALLOWLIST.has(key) || pluginOwned.includes(key)).toBe(true);
      }
      expect(spawnOpts.env[leakKey]).toBeUndefined();
      expect(spawnOpts.env.DSH_HOME).toBe('/tmp/dsh-home');
      expect(spawnOpts.env.DEEPSEEK_API_KEY).toBe('sk-1');

      fake.children[0].emit('close', 0);
      await pending;
    } finally {
      if (before === undefined) delete process.env[leakKey];
      else process.env[leakKey] = before;
      client.dispose();
    }
  });
});

