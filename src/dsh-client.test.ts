import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DshClient } from './dsh-client';

/**
 * killReason tests: the real DshClient spawns a short-lived node child that
 * ignores its argv, so no `dsh` binary or fake spawn is needed.
 *
 * DshClient schedules its timers via `window.setTimeout` (Obsidian/Electron).
 * The Node test runner has no `window`, so expose the Node timers under that
 * name for the duration of this suite — no production code is touched.
 */

let keepAliveJs: string;
let tmp: string;

beforeAll(() => {
  const g = globalThis as unknown as { window?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } };
  g.window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-test-'));
  keepAliveJs = path.join(tmp, 'keep-alive.js');
  fs.writeFileSync(keepAliveJs, 'setInterval(() => {}, 1000);\n', 'utf8');
});

afterAll(() => {
  const g = globalThis as unknown as { window?: unknown };
  delete g.window;
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

describe('DshClient killReason', () => {
  it('reports killReason "timeout" when the run exceeds timeoutMs', async () => {
    const client = new DshClient();
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
    const client = new DshClient();
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
    const client = new DshClient();
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
