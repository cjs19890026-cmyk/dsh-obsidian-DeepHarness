import { spawn as nodeSpawn, ChildProcess } from 'child_process';
import * as path from 'path';

/** The child-process spawn function used by DshClient. */
export type SpawnFn = typeof nodeSpawn;

/** Optional dependencies that make DshClient testable in Node without a window shim. */
export interface DshClientDeps {
  /** Replace the real child_process.spawn (used for fake-spawn tests). */
  spawn?: SpawnFn;
  /** Replace window/global timers. Defaults to globalThis.setTimeout. */
  setTimeout?: (handler: () => void, timeout?: number) => unknown;
  /** Clear a timer returned by the injected setTimeout. */
  clearTimeout?: (handle: unknown) => void;
}

/**
 * Thin bridge between the plugin and the DeepSeek Harness CLI.
 *
 * The plugin never implements agent execution itself: it spawns
 * `dsh --profile headless "<task>"` with cwd = vault root, and the
 * harness agent uses its full toolset (bash, file tools, web search,
 * subagents, …) directly on the vault, under DSH's own file sandbox.
 */

export interface DshRunOptions {
  /** Binary path to the `dsh` CLI (used when nodeBin+dshScript are not given). */
  dshBin: string;
  /** Absolute path to a Node.js binary. Preferred over the dsh shebang:
   *  Obsidian's Electron process has a restricted PATH that usually lacks
   *  Homebrew/nvm dirs, so `#!/usr/bin/env node` fails with
   *  "env: node: No such file or directory". */
  nodeBin?: string;
  /** Absolute path to dsh's real bin.js entry (resolve symlinks). */
  dshScript?: string;
  /** Absolute working directory for the agent (the vault root). */
  cwd: string;
  /** DSH_HOME (credentials/config root). Defaults to ~/.dsh. */
  dshHome?: string;
  /** Plugin-only DeepSeek API key. When set, injected as DEEPSEEK_API_KEY —
   *  DSH's inherited-environment layer wins over the credentials file, so the
   *  plugin runs with its own key without touching the desktop app's
   *  ~/.dsh/.credentials.yaml. */
  apiKey?: string;
  /** Model API backend in use; selects which env var the plugin key is
   *  injected as (DEEPSEEK_API_KEY vs OPENCODE_GO_API_KEY). */
  provider?: string;
  /** Tool execution backend for the harness: '' (native default) | 'native' | 'code' | 'both'. */
  toolsMode?: string;
  /** DSH sandbox mode: read-only | workspace-write | danger-full-access. */
  permissionMode?: string;
  /** Additional environment entries the plugin wants the child to see.
   *  Merged over the inherited allowlist and under the plugin-owned DSH_*
   *  overrides below. Use this (not the allowlist) for one-off/feature vars. */
  env?: Record<string, string>;
  /** Path(s) to generated `--patch` overlays (repeatable). */
  patchPath?: string | string[];
  /** Kill the process after this many ms. 0 = no timeout. */
  timeoutMs?: number;
  /** Line-by-line stdout callback (used by the Phase-2 stream relay). */
  onStdoutLine?: (line: string) => void;
  /** Cancellation signal (user pressed Stop). */
  signal?: AbortSignal;
}

export interface DshRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when terminated by user/timeout rather than by dsh itself
   *  (kept for callers of the old shape; equals `killReason !== null`). */
  killed: boolean;
  /** Why the run was terminated early, so the UI can tell a timeout
   *  apart from a user-initiated stop. null = dsh exited on its own. */
  killReason: 'timeout' | 'user' | null;
}

export interface DshDiagnostics {
  bin: string;
  found: boolean;
  version: string | null;
  /** Non-empty when a binary-level problem was detected. */
  error: string | null;
  /** Detected Node.js binary path (may be null). */
  nodeBin: string | null;
}

/**
 * Environment keys the dsh child process may inherit from the plugin's
 * process. Everything else is dropped: Obsidian's Electron process can carry
 * secrets (API tokens, per-app config) and unrelated tool state that the
 * agent has no business seeing.
 *
 * Extend this list deliberately. For one-off / feature-specific variables use
 * DshRunOptions.env (an explicit plugin opt-in) instead of widening the
 * inheritance here.
 */
export const DSH_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Core process / shell
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  // Locale
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  // Temp dirs
  'TMPDIR', 'TMP', 'TEMP',
  // git-over-SSH: the agent runs git on the vault and may need the user's
  // ssh-agent socket for private remotes.
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  // Proxy settings (dsh may bootstrap sandbox deps and call the API).
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  // npm registry mirror for the sandbox bootstrap.
  'NPM_CONFIG_REGISTRY', 'npm_config_registry',
  // Windows system dirs (case-preserving, as inherited).
  'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ALLUSERSPROFILE',
  'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE',
]);

/**
 * Build the child environment for a dsh run without leaking the plugin's whole
 * process.env.
 *
 * Layering, lowest to highest precedence:
 * 1. Inherited keys: only those on DSH_ENV_ALLOWLIST are copied over.
 * 2. opts.env entries: explicit plugin opt-ins for one-off vars.
 * 3. Plugin-owned overrides: DSH_HOME, the API key (under the env var the
 *    selected provider reads), DSH_TOOLS_MODE, DSH_PERMISSION_MODE.
 * 4. PATH: when spawning via node <bin.js>, node's directory is prepended so
 *    the agent's own bash tool can still find node/npm.
 */
export function buildDshEnv(
  opts: DshRunOptions,
  sourceEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DSH_ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      if (value !== undefined) env[key] = value;
    }
  }
  if (opts.dshHome) env.DSH_HOME = opts.dshHome;
  // Plugin-only API key: the environment layer wins over the credentials file
  // in DSH's precedence, so this key takes effect even when the plugin DSH_HOME
  // symlinks ~/.dsh/.credentials.yaml. Inject it under the env var the selected
  // provider actually reads.
  if (opts.apiKey) {
    const envVar = opts.provider === 'opencode-go'
      ? 'OPENCODE_GO_API_KEY'
      : 'DEEPSEEK_API_KEY';
    env[envVar] = opts.apiKey;
  }
  // DSH_TOOLS_MODE selects the tool execution backend (native/code/both); only
  // set it when the user explicitly chose one. It is NOT a file sandbox knob:
  // file tools scope to the session cwd (= the vault).
  if (opts.toolsMode) env.DSH_TOOLS_MODE = opts.toolsMode;
  // DSH_PERMISSION_MODE selects the sandbox mode (read-only / workspace-write
  // / danger-full-access), consumed by dsh-sandbox-policy and
  // dsh-permission-presets in the base bundle.
  if (opts.permissionMode) env.DSH_PERMISSION_MODE = opts.permissionMode;
  // Use platform dirname + delimiter: on Windows a 'C:\...\node.exe' path
  // has no '/', and PATH entries are separated by ';' not ':'.
  if (opts.nodeBin) {
    const nodeDir = path.dirname(opts.nodeBin);
    const fallback = process.platform === 'win32'
      ? 'C:\\Windows\\System32;C:\\Windows'
      : '/usr/bin:/bin';
    env.PATH = [nodeDir, env.PATH || fallback].join(path.delimiter);
  }
  return env;
}

export class DshClient {
  /** Every live client, so the plugin can kill all children on unload. */
  private static live = new Set<DshClient>();
  private child: ChildProcess | null = null;
  private readonly deps: DshClientDeps;
  private readonly setTimeoutFn: NonNullable<DshClientDeps['setTimeout']>;
  private readonly clearTimeoutFn: NonNullable<DshClientDeps['clearTimeout']>;

  constructor(deps: DshClientDeps = {}) {
    this.deps = deps;
    this.setTimeoutFn = deps.setTimeout ?? ((handler: () => void, timeout?: number): unknown => window.setTimeout(handler, timeout));
    this.clearTimeoutFn = deps.clearTimeout ?? ((handle: unknown): void => window.clearTimeout(handle as number));
    DshClient.live.add(this);
  }

  /**
   * Run one headless task to completion.
   * Resolves with stdout (the agent's final answer) plus metadata.
   */
  run(task: string, opts: DshRunOptions): Promise<DshRunResult> {
    return new Promise((resolve) => {
      const args = ['--profile', 'headless'];
      const patches = Array.isArray(opts.patchPath)
        ? opts.patchPath
        : opts.patchPath ? [opts.patchPath] : [];
      for (const p of patches) {
        args.push('--patch', p);
      }
      args.push(task);

      // Prefer spawning node directly with dsh's real entry script: this
      // bypasses the shebang, which fails under Electron's restricted PATH.
      const useNodeDirect = Boolean(opts.nodeBin && opts.dshScript);
      const spawnBin = useNodeDirect ? opts.nodeBin! : opts.dshBin;
      const spawnArgs = useNodeDirect ? [opts.dshScript!, ...args] : args;

      const env = buildDshEnv(opts, process.env);
      const spawnFn = this.deps.spawn ?? nodeSpawn;
      const startedAt = Date.now();
      let stdout = '';
      let stderr = '';
      let killReason: DshRunResult['killReason'] = null;
      let settled = false;

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        if (this.child === child) this.child = null;
        resolve({
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          killed: killReason !== null,
          killReason,
        });
      };

      const child = spawnFn(spawnBin, spawnArgs, {
        cwd: opts.cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so Stop / unload can signal dsh AND its sandboxed
        // bash children together (process.kill(-pid)).
        detached: true,
      });
      this.child = child;

      // The first termination request wins: a timeout and a user stop racing
      // each other must not overwrite the reason that was reported first.
      const requestKill = (reason: 'timeout' | 'user'): void => {
        if (killReason !== null) return;
        killReason = reason;
        this.killChild(child);
      };

      let stdoutBuffer = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        // Always accumulate the full stdout (final answer may span lines);
        // the buffer is only for line-splitting callbacks.
        stdout += text;
        stdoutBuffer += text;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? ''; // keep the incomplete tail
        for (const line of lines) {
          if (line.trim() && opts.onStdoutLine) opts.onStdoutLine(line);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        // e.g. ENOENT when the binary does not exist
        stderr += `spawn error: ${err.message}`;
        finish(null);
      });

      child.on('close', (code) => {
        // Flush the incomplete tail to line callbacks (stdout already holds it).
        if (stdoutBuffer.trim() && opts.onStdoutLine) {
          opts.onStdoutLine(stdoutBuffer);
        }
        finish(code);
      });

      // Timeout
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        const timer = this.setTimeoutFn(() => requestKill('timeout'), opts.timeoutMs);
        child.on('close', () => this.clearTimeoutFn(timer));
      }

      // User cancellation
      if (opts.signal) {
        if (opts.signal.aborted) {
          requestKill('user');
        } else {
          opts.signal.addEventListener('abort', () => requestKill('user'), { once: true });
        }
      }
    });
  }

  /** Terminate the currently running child (SIGTERM, then SIGKILL). */
  stop(): void {
    if (this.child && !this.child.killed) {
      this.killChild(this.child);
    }
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  /** Kill any live children and drop this client from the registry. */
  dispose(): void {
    this.stop();
    DshClient.live.delete(this);
  }

  /** Kill every live child (plugin unload / reload). */
  static disposeAll(): void {
    for (const client of [...DshClient.live]) client.dispose();
  }

  private killChild(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    const kill = (signal: NodeJS.Signals): void => {
      // Signal the whole process group on POSIX (dsh + its sandboxed bash
      // children); Windows has no group-kill, so fall back to the child only.
      if (pid !== undefined && process.platform !== 'win32') {
        try { process.kill(-pid, signal); return; } catch { /* group gone */ }
      }
      try { child.kill(signal); } catch { /* already gone */ }
    };
    try {
      kill('SIGTERM');
      // Escalate after a grace period, unless the child already exited.
      // Cleared on close so no stray timer keeps the process alive.
      const escalate = (): void => {
        if (child.exitCode === null && child.signalCode === null) {
          kill('SIGKILL');
        }
      };
      const timer = this.setTimeoutFn(escalate, 3000);
      child.once('close', () => this.clearTimeoutFn(timer));
    } catch {
      // Already gone
    }
  }
}
