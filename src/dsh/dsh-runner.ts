import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { versionCmp, streamRelayPatchYaml, shimJsTarget, resolveVaultRelativeDir } from './pure';
import { buildDshEnv, type DshDiagnostics } from './dsh-client';
import type { DshSettings } from '../settings/index';
import { ensureObsidianSkill as writeObsidianSkill, MEMORY_FILE } from '../core/obsidian-skill';
import { t, getLocale } from '../i18n/index';
import { extractTopLevelBlock, readDshSettings, type DshConfigSnapshot } from './dsh-config';
import { pluginPaths, resolveUserDshHome, systemDshHomeDir } from './paths';

const execFileAsync = promisify(execFile);

/**
 * P1-3: a degraded-setup notice. A preparation step that could not complete as
 * configured (DSH_HOME fallback, patch write failure, workdir fallback, …)
 * pushes one onto the optional collector the chat view passes per run, so the
 * UI can surface the degradation instead of silently continuing. `message` is
 * already localized at push time.
 */
export interface PreparationIssue {
  level: 'warning' | 'error';
  /** Stable identifier for tests / future filtering. */
  code: string;
  /** Human-readable, localized explanation. */
  message: string;
}

/**
 * Command construction and environment probing for the dsh CLI.
 *
 * - Detects the `dsh` binary (explicit setting > PATH > common locations).
 * - Detects a Node.js binary and dsh's real entry script so the plugin can
 *   spawn `node <dsh>/lib/bin.js` directly. Obsidian's Electron process runs
 *   with a restricted PATH (no Homebrew/nvm dirs), so relying on the `dsh`
 *   shebang (`#!/usr/bin/env node`) fails with "env: node: No such file or
 *   directory".
 * - Warms up the `headless` profile on first use (dsh bootstraps the
 *   profile directory under DSH_HOME on demand).
 * - Generates the vault persona `--patch` overlay once per vault.
 * - Assembles the task text: conversation memory + user message.
 */

const COMMON_BIN_CANDIDATES = [
  '/opt/homebrew/bin/dsh',
  '/usr/local/bin/dsh',
  '/usr/bin/dsh',
];

const COMMON_NODE_CANDIDATES = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
];

/** Windows: `which` does not exist; Node's PATH lookup must use `where`. */
const IS_WINDOWS = process.platform === 'win32';

/** `where dsh` / `which dsh` — the PATH lookup command for this platform. */
const WHICH_CMD = IS_WINDOWS ? 'where' : 'which';
/**
 * Write a text file atomically (tmp file in the same directory + rename) so a
 * crash or interruption never leaves a half-written file that dsh would parse
 * on the next run. Mirrors HistoryStore.save. The parent directory must exist.
 * A leftover *.tmp from a failed write is harmless and gets overwritten on the
 * next run.
 */
function writeFileAtomicSync(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Command + environment for the settings page's `dsh --version` probe.
 *
 * Split out of `diagnose()` so the D-2 guarantee is testable without spawning
 * anything: the probe runs under the same {@link buildDshEnv} whitelist as a
 * real task, never the plugin's whole `process.env`. The plugin API key is
 * deliberately not injected — `--version` needs no credentials, and a
 * diagnostic should not carry secrets around.
 *
 * `node <script>` is preferred so the probe works under Electron's restricted
 * PATH, where the `dsh` shebang (`#!/usr/bin/env node`) cannot find node.
 */
export function diagnosticProbe(
  bin: string,
  nodeBin: string | null,
  script: string | null,
  dshHome: string,
): { cmd: string; args: string[]; env: Record<string, string> } {
  const useNodeDirect = Boolean(script && nodeBin);
  return {
    cmd: useNodeDirect ? nodeBin! : bin,
    args: script && nodeBin ? [script, '--version'] : ['--version'],
    env: buildDshEnv({ nodeBin: nodeBin ?? undefined, dshHome }, process.env),
  };
}


/**
 * What must survive the move out of the vault.
 *
 * `profiles/` is deliberately absent: it is DSH's own bootstrap cache (400+
 * symlinks into the installed dsh package on macOS, tens of thousands of real
 * files on Windows) and DSH rebuilds it on the next run. Copying it would be
 * both pointless and the slowest part of the migration — and re-creating its
 * symlinks by hand is exactly the fragile step this move exists to avoid.
 */
const MIGRATED_DSH_HOME_ENTRIES = [
  'history.json',
  'settings.yaml',
  '.anonymous-user-id',
  'sessions',
  'skills',
];

export interface DshHomeMigration {
  /** Where the plugin will actually run from. */
  dshHome: string;
  /** True when the legacy in-vault home still exists (rollback is possible). */
  migratedFrom: string | null;
}

/**
 * Move the plugin's DSH_HOME out of the vault, once.
 *
 * Existing installs have the directory inside the vault; new ones never will.
 * The legacy tree is **copied, never deleted** — it is the rollback path, and
 * deleting a user's data as a side effect of an upgrade is not acceptable. A
 * failure at any point returns the legacy path so the plugin keeps working
 * exactly as before, and reports it as a preparation issue rather than throwing.
 */
export function migrateDshHomeToSystem(
  vaultRoot: string,
  configDir: string,
  userDshHome: string,
  issues?: PreparationIssue[],
): DshHomeMigration {
  const legacy = pluginPaths(vaultRoot, configDir).dshHomeDir;
  const target = systemDshHomeDir(vaultRoot, userDshHome);

  try {
    // Establish the target first, unconditionally: whether the system location
    // is usable is the question that decides this function's answer, and it must
    // not be masked by "there was nothing to migrate anyway" (a fresh install
    // must fail here loudly rather than later, pointing at the wrong path).
    fs.mkdirSync(target, { recursive: true });
    fs.chmodSync(target, 0o755);

    // Nothing to move: no legacy tree, or a previous migration already ran (the
    // legacy tree holds nothing the copy below does not already cover).
    if (!fs.existsSync(legacy) || fs.existsSync(path.join(target, '.migrated'))) {
      return { dshHome: target, migratedFrom: null };
    }

    for (const entry of MIGRATED_DSH_HOME_ENTRIES) {
      const from = path.join(legacy, entry);
      if (!fs.existsSync(from)) continue;
      copyTreeInto(from, path.join(target, entry));
    }
    // Marker so a later run does not copy a stale legacy tree back over data
    // the plugin has since written at the new location.
    fs.writeFileSync(path.join(target, '.migrated'), `${new Date().toISOString()}\n`, 'utf8');
    return { dshHome: target, migratedFrom: legacy };
  } catch {
    issues?.push({
      level: 'warning',
      code: 'dsh-home-migrate',
      message: t('chat.degrade.dshHomeMigrate', { path: legacy }),
    });
    return { dshHome: legacy, migratedFrom: null };
  }
}

/** Recursive copy that preserves symlinks (the credentials link stays live). */
function copyTreeInto(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, force: true, dereference: false });
}

/** Extra common Windows locations for the dsh CLI (npm global prefix). */
function windowsDshCandidates(): string[] {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return [path.join(appData, 'npm', 'dsh.cmd')];
}

/** Common Windows locations for a Node.js binary. */
function windowsNodeCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const userProfile = process.env.USERPROFILE ?? os.homedir();
  return [
    path.join(programFiles, 'nodejs', 'node.exe'),                        // official installer / nvm-windows
    path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),            // per-user installer
    path.join(userProfile, 'scoop', 'apps', 'nodejs', 'current', 'node.exe'), // scoop
  ];
}

/** Bump to force regeneration of the generated persona patch (see migration). */
const PERSONA_VERSION = 5;

/**
 * Fallback definition of the OpenCode Go provider, used when the user's real
 * DSH_HOME does not declare `llm-pi-ai.providers.opencode-go`. Mirrors the
 * config shipped in the official ~/.dsh/settings.yaml defaults.
 *
 * Model ids here MUST stay in sync with `MODEL_OPTIONS` in settings.ts — the
 * consistency is guarded by provider-fallback.test.ts.
 *
 * Note: `deepseek-flash` is DeepSeek's rolling alias and is listed first, so it
 * matches the order and default in settings.ts. The `contextWindow` values here
 * (131072) are the fallback provider's own figures and are intentionally not
 * tied to MODEL_CONTEXT_WINDOWS in pure.ts.
 */
export const OPENCODE_GO_PROVIDER_FALLBACK = [
  'llm-pi-ai:',
  '  providers:',
  '    opencode-go:',
  '      displayName: OpenCode Go',
  '      apiKeyEnv: OPENCODE_GO_API_KEY',
  '      api: openai-completions',
  '      baseURL: https://opencode.ai/zen/go/v1',
  '      compat:',
  '        thinkingFormat: deepseek',
  '        supportsDeveloperRole: false',
  '        maxTokensField: max_tokens',
  '      models:',
  '        - id: deepseek-flash',
  '          name: DeepSeek V4.1 Flash',
  '          contextWindow: 131072',
  '        - id: deepseek-v4-flash',
  '          name: DeepSeek V4 Flash',
  '          contextWindow: 131072',
  '        - id: deepseek-v4-pro',
  '          name: DeepSeek V4 Pro',
  '          contextWindow: 131072',
  '        - id: deepseek-v4-flash-vision-exp',
  '          name: DeepSeek V4 Flash Vision (Exp)',
  '          contextWindow: 131072',
];

/**
 * Source of the stream-relay DSH plugin injected via --patch.
 * It listens on the live `session/event` stream and emits real-time
 * JSON Lines (`DLEVENT\t<json>`) for reasoning blocks and tool calls:
 *   {t:'think', text}                       reasoning increment
 *   {t:'tool', status:'start', id, name, args}   tool call started
 *   {t:'tool', status:'result', id, ok, summary} tool result
 * The headless runner itself only prints the final text at the end, so
 * without this plugin the plugin never sees thinking or tool activity live.
 */
const STREAM_RELAY_SRC = `// deepharness stream relay: real-time thinking + tool events.
// Injected as a patch overlay; owned and regenerated by the plugin.
module.exports = {
  name: 'deepharness-stream-relay',
  apply(ctx) {
    const callNames = new Map();
    const emit = (obj) => process.stdout.write('DLEVENT\\t' + JSON.stringify(obj) + '\\n');
    const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
    const summarizeArgs = (args) => {
      if (!args || typeof args !== 'object') return String(args ?? '');
      const pick = ['command', 'filePath', 'path', 'query', 'pattern', 'url', 'text', 'target', 'from', 'to'];
      const parts = [];
      for (const k of pick) if (typeof args[k] === 'string' && args[k]) parts.push(k + '=' + truncate(args[k], 60));
      return parts.length ? parts.join(' ') : truncate(JSON.stringify(args), 120);
    };
    // Tool results nest text: [{type:'tool-result', content:[{type:'text', text}]}]
    const collectText = (node, out) => {
      if (Array.isArray(node)) {
        for (const c of node) collectText(c, out);
        return;
      }
      if (typeof node === 'string') { out.push(node); return; }
      if (!node || typeof node !== 'object') return;
      if (typeof node.text === 'string') out.push(node.text);
      if (Array.isArray(node.content)) {
        for (const c of node.content) collectText(c, out);
      } else if (node.content && typeof node.content === 'object') {
        collectText(node.content, out);
      }
    };
    const summarizeResult = (content) => {
      const out = [];
      collectText(content, out);
      const text = out.join('\\n').trim();
      return text ? truncate(text, 300) : '';
    };
    ctx.on('session/event', (session, event) => {
      switch (event.type) {
        case 'assistant/message': {
          for (const b of event.data.message.content ?? []) {
            if (b.type === 'reasoning' && b.text) emit({ t: 'think', text: b.text });
          }
          break;
        }
        case 'tool/call': {
          callNames.set(event.data.callId, event.data.name);
          emit({
            t: 'tool',
            status: 'start',
            id: event.data.callId,
            name: event.data.name,
            args: summarizeArgs(event.data.arguments),
            argsFull: JSON.stringify(event.data.arguments)
          });
          break;
        }
        case 'tool/result': {
          const msg = event.data.message ?? {};
          // callId lives on message.source.callId (not on the message root)
          const callId = msg.callId ?? msg.source?.callId;
          const name = callNames.get(callId) ?? 'tool';
          emit({ t: 'tool', status: 'result', id: callId, ok: msg.isError !== true, summary: summarizeResult(msg.content) });
          break;
        }
        default:
          break;
      }
    });
  }
};
`;

/** Whether a resolved dsh entry is a JS file node can run directly. */
function isNodeScript(p: string): boolean {
  if (/\.(?:m?js|cjs)$/i.test(p)) return true;
  try {
    return /^#!.*\bnode\b/.test(fs.readFileSync(p, 'utf8').slice(0, 128));
  } catch {
    return false;
  }
}

export class DshRunner {
  /**
   * Memo for `userDshConfig`, keyed on the settings file's mtime. Held per
   * runner instance; runners are cheap and short-lived, so this only has to
   * absorb repeated reads within one render or one run.
   */
  private userConfigCache: { mtimeMs: number; snapshot: DshConfigSnapshot | null } | null = null;

  constructor(
    private settings: DshSettings,
    private configDir: string,
  ) {}

  /** Resolve the dsh binary path, or null when not found. */
  async detectBin(): Promise<string | null> {
    const explicit = this.settings.dshBin.trim();
    if (explicit) {
      if (await this.exists(explicit)) return explicit;
      return null;
    }
    // PATH lookup (`which` on POSIX, `where` on Windows)
    try {
      const { stdout } = await execFileAsync(WHICH_CMD, ['dsh'], { timeout: 5000 });
      // Prefer a .cmd shim on Windows: it is the launcher cmd.exe can run,
      // and resolveDshScript parses it to find the real node script.
      const hits = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const preferred = IS_WINDOWS
        ? hits.find((p) => /\.cmd$/i.test(p)) ?? hits[0]
        : hits[0];
      if (preferred) return preferred;
    } catch {
      // not in PATH
    }
    const candidates = IS_WINDOWS
      ? windowsDshCandidates()
      : COMMON_BIN_CANDIDATES;
    for (const candidate of candidates) {
      if (await this.exists(candidate)) return candidate;
    }
    return null;
  }

  /** Probe binary + profile readiness for the settings page. */
  async diagnose(): Promise<DshDiagnostics> {
    const bin = await this.detectBin();
    const nodeBin = await this.detectNode();
    if (!bin) {
      return { bin: '', found: false, version: null, error: 'not-found', nodeBin };
    }
    try {
      const probe = diagnosticProbe(bin, nodeBin, this.resolveDshScript(bin), this.dshHome());
      const { stdout } = await execFileAsync(probe.cmd, probe.args, {
        timeout: 10000,
        env: probe.env,
      });
      return { bin, found: true, version: stdout.trim(), error: null, nodeBin };
    } catch (e) {
      return { bin, found: true, version: null, error: e instanceof Error ? e.message : String(e), nodeBin };
    }
  }

  /**
   * Detect a usable Node.js binary.
   * Order: explicit setting > PATH > common install dirs > nvm/volta.
   */
  async detectNode(): Promise<string | null> {
    const explicit = this.settings.nodeBin.trim();
    if (explicit) {
      return (await this.exists(explicit)) ? explicit : null;
    }
    // PATH lookup (`which` on POSIX, `where` on Windows)
    try {
      const { stdout } = await execFileAsync(WHICH_CMD, ['node'], { timeout: 5000 });
      const hits = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // Prefer the real .exe on Windows (the .cmd shim would need cmd.exe).
      const preferred = IS_WINDOWS
        ? hits.find((p) => /\.exe$/i.test(p)) ?? hits[0]
        : hits[0];
      if (preferred && (await this.exists(preferred))) return preferred;
    } catch {
      // not in PATH
    }
    if (IS_WINDOWS) {
      for (const candidate of windowsNodeCandidates()) {
        if (await this.exists(candidate)) return candidate;
      }
      return null;
    }
    for (const candidate of COMMON_NODE_CANDIDATES) {
      if (await this.exists(candidate)) return candidate;
    }
    // nvm: ~/.nvm/versions/node/vX.Y.Z/bin/node — pick the newest by semver
    // (not lexicographic, which would rank v9 above v18).
    try {
      const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
      const versions = fs.readdirSync(nvmRoot)
        .filter((v) => /^v\d+\.\d+\.\d+/.test(v))
        .sort((a, b) => versionCmp(b, a));
      for (const v of versions) {
        const p = path.join(nvmRoot, v, 'bin', 'node');
        if (await this.exists(p)) return p;
      }
    } catch {
      // no nvm
    }
    // volta
    const volta = path.join(os.homedir(), '.volta', 'bin', 'node');
    if (await this.exists(volta)) return volta;
    return null;
  }

  /**
   * Resolve the real entry script of the dsh CLI.
   * npm's global bin entries are symlinks (dsh -> ../lib/node_modules/
   * @deepseek-ai/dsh/lib/bin.js); we need the real path to run it with node.
   * On Windows the npm bin is a .cmd/.ps1 launcher shim instead, so we parse
   * the shim to recover the JS script it spawns node with.
   * Returns null when no node-runnable script can be found (a shell wrapper
   * or native binary), so callers can surface a clear diagnostic instead of
   * failing later with a node syntax error.
   */
  resolveDshScript(dshBin: string): string | null {
    try {
      const real = fs.realpathSync(dshBin);
      if (isNodeScript(real)) return real;
      if (IS_WINDOWS) {
        const viaShim = this.resolveWindowsShim(real);
        if (viaShim) return viaShim;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Parse a Windows npm launcher shim (.cmd/.ps1/sh) for the node script. */
  private resolveWindowsShim(shim: string): string | null {
    try {
      const text = fs.readFileSync(shim, 'utf8');
      const rel = shimJsTarget(text);
      if (!rel) return null;
      const target = path.join(path.dirname(shim), rel);
      return isNodeScript(target) ? target : null;
    } catch {
      return null;
    }
  }

  /** Effective DSH_HOME (expand ~). See paths.resolveUserDshHome. */
  dshHome(): string {
    return resolveUserDshHome(this.settings.dshHome);
  }

  /**
   * Plugin-owned DSH_HOME: an isolated directory inside the vault so the
   * per-task model / reasoning settings never pollute the user's global
   * `~/.dsh` (which the web app also reads). Credentials are symlinked from
   * the user's real DSH_HOME; settings.yaml is (re)written on every task
   * with the currently selected model + reasoning effort.
   *
   * Returns the plugin home, or null on failure (caller falls back to the
   * user home, where the model dropdown is then ignored).
   */
  /** Absolute path of the plugin-owned DSH_HOME inside the vault. */
  pluginHomeDir(vaultRoot: string): string {
    return pluginPaths(vaultRoot, this.configDir).dshHomeDir;
  }

  /** Raw text of the user's real `$DSH_HOME/settings.yaml`, or null. */
  private readUserSettingsText(): string | null {
    try {
      const file = path.join(this.dshHome(), 'settings.yaml');
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * The user's own DSH catalog: models under `llm-deepseek`, provider routes
   * under `llm-pi-ai`.
   *
   * Memoized on the file's mtime because callers include the chat toolbar,
   * which recomputes labels far more often than the user edits `settings.yaml`.
   * An mtime change is the only invalidation needed: the desktop app rewrites
   * the file on every settings save. Returns null when the file is absent or
   * unreadable, and every consumer falls back to the built-in lists.
   */
  userDshConfig(): DshConfigSnapshot | null {
    const file = path.join(this.dshHome(), 'settings.yaml');
    try {
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (this.userConfigCache && this.userConfigCache.mtimeMs === mtimeMs) {
        return this.userConfigCache.snapshot;
      }
      const snapshot = readDshSettings(this.dshHome());
      this.userConfigCache = { mtimeMs, snapshot };
      return snapshot;
    } catch {
      // Missing file, or a stat/read race with the desktop app rewriting it.
      this.userConfigCache = null;
      return null;
    }
  }

  /**
   * Prepare the plugin's isolated DSH_HOME, **outside the vault**, and return
   * where it ended up.
   *
   * Returns null when it cannot be prepared at all, in which case the caller
   * falls back to the user's real DSH_HOME (the model dropdown then has no
   * effect — that is the pre-existing behaviour this keeps).
   */
  ensurePluginDshHome(
    vaultRoot: string,
    sel: { model: string; effort: string },
    issues?: PreparationIssue[],
    /** The user's real DSH root; injectable so tests never write into the
     *  machine's actual `~/.dsh`. Defaults to the configured one. */
    userDshHome: string = this.dshHome(),
  ): string | null {
    const { dshHome: base } = migrateDshHomeToSystem(
      vaultRoot,
      this.configDir,
      userDshHome,
      issues,
    );
    try {
      fs.mkdirSync(base, { recursive: true });
      // Same as ensureVaultPatch: force standard perms (missing execute bit
      // silently breaks settings.yaml writes).
      fs.chmodSync(base, 0o755);
      // Reuse credentials from the user's real DSH home (symlink once).
      const credSrc = path.join(userDshHome, '.credentials.yaml');
      const credDst = path.join(base, '.credentials.yaml');
      if (fs.existsSync(credSrc) && !fs.existsSync(credDst)) {
        // Prefer a symlink (credentials stay live); Windows usually lacks
        // symlink privileges (EPERM without Developer Mode / admin), so fall
        // back to copying the file.
        try {
          fs.symlinkSync(credSrc, credDst);
        } catch {
          fs.copyFileSync(credSrc, credDst);
        }
      }
      // The selected provider consumes `agent-default-model` (provider/model)
      // plus its reasoningEffort. Custom routes (e.g. OpenCode Go) also need
      // their `llm-pi-ai.providers.*` definition, which we inherit from the
      // user's real DSH_HOME settings when they have one.
      //
      // The user's `llm-deepseek.models` catalog is deliberately *not*
      // inherited: the plugin's model list is owned by the user (see
      // `DshSettings.models`), and pulling in a catalog that only exists for
      // people who opened DSH's own model settings is what made the same
      // plugin behave differently for different users. DSH is perfectly happy
      // with an id it has no catalog entry for — it falls back to the
      // connection defaults — so nothing here depends on that catalog.
      const provider = this.settings.provider || 'deepseek-official';
      const settingsLines: string[] = [];
      const userSettings = this.readUserSettingsText();

      const piAi = userSettings ? extractTopLevelBlock(userSettings, 'llm-pi-ai') : null;
      if (provider === 'opencode-go') {
        if (piAi) {
          settingsLines.push(piAi.trimEnd());
        } else {
          // Only this route needs a synthetic definition to work at all: it is
          // the one built-in option whose provider block a stock DSH_HOME may
          // not declare.
          settingsLines.push(...OPENCODE_GO_PROVIDER_FALLBACK);
        }
      }

      settingsLines.push(
        'agent-default-model:',
        `  provider: ${provider}`,
        `  model: ${sel.model}`,
        `  reasoningEffort: ${sel.effort}`,
        '',
      );
      writeFileAtomicSync(path.join(base, 'settings.yaml'), settingsLines.join('\n'));
      return base;
    } catch {
      issues?.push({
        level: 'warning',
        code: 'dsh-home',
        message: t('chat.degrade.dshHome'),
      });
      return null;
    }
  }

  /**
   * Directory the agent works on. Empty = vault root.
   * Returns an absolute path; ensures it exists.
   * Degraded fallbacks (out-of-vault setting / unwritable dir) report a
   * preparation issue when a collector is supplied (P1-3).
   */
  workdir(vaultRoot: string, issues?: PreparationIssue[]): string {
    const rel = this.settings.workdir.trim();
    if (!rel) return vaultRoot;
    // Resolve `..` and absolute paths, then verify the result stays inside the
    // vault: the workspace root is ALSO the sandbox write boundary, so an
    // out-of-vault workdir would silently move that boundary.
    const base = path.resolve(vaultRoot, rel);
    const rel2 = path.relative(vaultRoot, base);
    if (rel2 === '..' || rel2.startsWith('..' + path.sep)) {
      issues?.push({
        level: 'warning',
        code: 'workdir-outside',
        message: t('chat.degrade.workdirOutside'),
      });
      return vaultRoot;
    }
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch {
      // read-only vault subpath: fall back to root
      issues?.push({
        level: 'warning',
        code: 'workdir-mkdir',
        message: t('chat.degrade.workdirMkdir'),
      });
      return vaultRoot;
    }
    return base;
  }

  /**
   * Write the built-in `obsidian` skill into the plugin-owned DSH_HOME so the
   * headless agent discovers it via dsh-skill-filesystem (<dshHome>/skills,
   * rank 400). Plugin-owned: always regenerated so the skill tracks the plugin
   * version. Users override it by dropping their own skill at
   * `<vault>/.dsh/skills/obsidian/` (rank 100 project root, wins).
   *
   * Returns the skill directory, or null on failure / when disabled.
   */
  ensureObsidianSkill(
    vaultRoot: string,
    issues?: PreparationIssue[],
    /** The DSH_HOME in use, as returned by {@link ensurePluginDshHome}. Passed
     *  in rather than derived: `pluginHomeDir()` points at the *legacy* in-vault
     *  location, so deriving it here re-created `dsh-home/skills/` inside the
     *  vault on every run — exactly the synced-folder problem the migration
     *  exists to remove. Defaults to the legacy path only so the existing
     *  signature keeps working for callers that do not prepare a home. */
    dshHome: string = this.pluginHomeDir(vaultRoot),
  ): string | null {
    if (!this.settings.obsidianSkill) return null;
    const skillRoot = path.join(dshHome, 'skills');
    const fail = (): null => {
      issues?.push({
        level: 'warning',
        code: 'obsidian-skill',
        message: t('chat.degrade.obsidianSkill'),
      });
      return null;
    };
    try {
      fs.mkdirSync(skillRoot, { recursive: true });
      fs.chmodSync(skillRoot, 0o755);
    } catch {
      return fail();
    }
    const res = writeObsidianSkill(skillRoot);
    return res ? res.dir : fail();
  }

  /**
   * Seed the long-term memory file at the vault root (Harness/memory.md) so
   * the agent always finds it. The file lives at the vault root (a stable
   * vault-relative path), so it stays reachable even when the sandbox workdir
   * is a vault subfolder.
   */
  ensureMemoryFile(vaultRoot: string, issues?: PreparationIssue[]): string | null {
    const file = path.join(vaultRoot, MEMORY_FILE);
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const seed = [
          '# 长期记忆 (Long-term memory)',
          '',
          '> 由 DeepHarness 维护。agent 在每次任务开始时读这里、结束时把跨会话结论写回这里。',
          '> 你可以自由编辑;删除某行即让 agent 忘记那条结论。',
          '',
          '## Vault 结构',
          '',
          '## 用户偏好',
          '',
          '## 进行中的项目',
          '',
        ].join('\n');
        fs.writeFileSync(file, seed, 'utf8');
      }
      return file;
    } catch {
      issues?.push({
        level: 'warning',
        code: 'memory-file',
        message: t('chat.degrade.memoryFile'),
      });
      return null;
    }
  }

  /**
   * Generate the skill-dirs patch that registers user-configured extra skill
   * directories (settings.extraSkillDirs, e.g. Library/Skills or .claude/skills)
   * with dsh-skill-filesystem's `customSkillDirs`, so `/name` invocation sees
   * them. Regenerated on every run, like the stream-relay patch.
   *
   * Returns the patch path, or null when there is nothing to register.
   */
  ensureSkillDirsPatch(vaultRoot: string, issues?: PreparationIssue[]): string | null {
    const dirs: string[] = [];
    const rejected: string[] = [];
    for (const rel of this.settings.extraSkillDirs.split(',')) {
      // Only vault-internal relative directories are accepted: an absolute
      // path or a `../` escape would point DSH's skill scanner outside the
      // vault, so such entries are rejected (skipped) — and reported, since
      // they are misconfigured (P1-3). Blank CSV slots are ignored silently.
      const abs = resolveVaultRelativeDir(vaultRoot, rel);
      if (!abs) {
        if (rel.trim()) rejected.push(rel.trim());
        continue;
      }
      try {
        if (fs.statSync(abs).isDirectory()) dirs.push(abs);
      } catch {
        // missing dir: skip (valid empty state)
      }
    }
    if (rejected.length > 0) {
      issues?.push({
        level: 'warning',
        code: 'skill-dirs-rejected',
        message: t('chat.degrade.skillDirsRejected', { dirs: rejected.join(', ') }),
      });
    }
    if (dirs.length === 0) return null;
    const dir = pluginPaths(vaultRoot, this.configDir).generatedDir;
    const file = path.join(dir, 'skill-dirs.yml');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o755);
      const yml = [
        '# 由 deepharness 生成。把附加技能目录注册给 DSH 的 skill-filesystem',
        '# (customSkillDirs),使 /技能名 斜杠调用能发现这些目录里的 skill。',
        '- id: skill-filesystem',
        '  config:',
        '    customSkillDirs:',
        ...dirs.map((d) => `      - ${JSON.stringify(d)}`),
        '',
      ].join('\n');
      writeFileAtomicSync(file, yml);
      return file;
    } catch {
      issues?.push({
        level: 'warning',
        code: 'skill-dirs-write',
        message: t('chat.degrade.skillDirsWrite'),
      });
      return null;
    }
  }

  /**
   * Generate (once per vault) the persona patch overlay that turns the
   * generic coding agent into a vault-aware assistant, plus the think-relay
   * plugin patch that streams reasoning blocks to stdout.
   *
   * Returns paths to both patch files (either may be null on failure).
   */
  async ensureVaultPatch(
    vaultRoot: string,
    issues?: PreparationIssue[],
  ): Promise<{ persona: string | null; think: string | null }> {
    const dir = pluginPaths(vaultRoot, this.configDir).generatedDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Some environments create dirs without the execute bit, which breaks
      // file creation inside; force standard perms so the plugin always works.
      fs.chmodSync(dir, 0o755);
    } catch {
      issues?.push({
        level: 'warning',
        code: 'patch-dir',
        message: t('chat.degrade.patchDir'),
      });
      return { persona: null, think: null };
    }

    // 1) Persona patch (user-editable; regenerated on a version bump, on a
    //    UI-language change — the marker embeds the locale — or when a custom
    //    persona is set but missing from the file. User edits are preserved as
    //    vault.yml.bak before regeneration.)
    let persona: string | null = null;
    const personaFile = path.join(dir, 'vault.yml');
    try {
      const marker = this.personaMarker();
      if (!fs.existsSync(personaFile)) {
        writeFileAtomicSync(personaFile, this.renderPersonaYaml(this.buildPersonaLines(), marker));
      } else {
        const existing = fs.readFileSync(personaFile, 'utf8');
        const custom = this.settings.customPersona.trim();
        const customMissing = custom !== '' && !existing.includes(custom);
        if (!existing.includes(marker) || customMissing) {
          // Stale or locale-mismatched file. Back the old one up first, then
          // regenerate in the current locale. The backup is unconditional: the
          // previous code skipped it when the file matched the *v2* default
          // byte for byte, to avoid leaving a .bak for users who had never
          // edited it. That pre-v2 renderer is three generations back
          // (PERSONA_VERSION is 5), so its only remaining effect was to suppress
          // one harmless backup file for a handful of old installs.
          try { writeFileAtomicSync(`${personaFile}.bak`, existing); } catch { /* ignore */ }
          writeFileAtomicSync(personaFile, this.renderPersonaYaml(this.buildPersonaLines(), marker));
        }
      }
      persona = personaFile;
    } catch {
      issues?.push({
        level: 'warning',
        code: 'patch-persona',
        message: t('chat.degrade.patchPersona'),
      });
      persona = null;
    }

    // 2) Stream-relay plugin patch (plugin-managed; regenerated on upgrade)
    let think: string | null = null;
    const thinkJs = path.join(dir, 'stream-relay.js');
    const thinkYml = path.join(dir, 'stream.yml');
    try {
      writeFileAtomicSync(thinkJs, STREAM_RELAY_SRC);
      // `name` must be a file:// URL: Node's ESM loader rejects bare Windows
      // paths ("D:\\...") as plugin import specifiers
      // (ERR_UNSUPPORTED_ESM_URL_SCHEME) — see streamRelayPatchYaml.
      writeFileAtomicSync(thinkYml, streamRelayPatchYaml(thinkJs));
      think = thinkYml;
    } catch {
      issues?.push({
        level: 'warning',
        code: 'patch-stream',
        message: t('chat.degrade.patchStream'),
      });
      think = null;
    }

    return { persona, think };
  }

  /** Marker line embedding the persona version + current UI locale, so a
   *  language switch in settings regenerates the persona patch in the new
   *  language (vault.yml.bak preserves any user edits). */
  private personaMarker(): string {
    return `# deepharness-persona-v${PERSONA_VERSION}-${getLocale()}`;
  }

  /** Default persona body: localized Obsidian expert + L1 rules + reply language. */
  private buildPersonaLines(): string[] {
    const lines = [
      t('persona.role'),
      t('persona.safety'),
      t('persona.vaultSkill'),
      t('persona.replyLanguage'),
    ];
    if (this.settings.customPersona.trim()) {
      lines.push('', t('persona.customLabel'), this.settings.customPersona.trim());
    }
    return lines;
  }

  private renderPersonaYaml(lines: string[], marker: string): string {
    return [
      marker,
      '# 由 deepharness 生成。可自由编辑;插件升级时可能重新生成(旧版会备份为 vault.yml.bak)。',
      '- id: system-prompt',
      '  config:',
      '    persona: >-',
      ...lines.map((line) => `      ${line}`),
      '',
    ].join('\n');
  }

  /** Assemble the final task text handed to `dsh --profile headless`. */
  buildTask(userMessage: string, memory: string[], extraContext?: string): string {
    const parts: string[] = [];
    if (this.settings.memoryEnabled && memory.length > 0) {
      parts.push(memory.join('\n'));
    }
    if (extraContext && extraContext.trim()) {
      parts.push(`[上下文]\n${extraContext.trim()}`);
    }
    parts.push(userMessage);
    return parts.join('\n\n');
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Where the plugin's DSH_HOME is, without preparing or creating anything.
 *
 * `main.ts` (history file) and the run path must agree on this, or the plugin
 * would read a different history.json than it writes. It mirrors
 * {@link migrateDshHomeToSystem}'s decision — system location when it is usable,
 * the legacy in-vault tree when a migration failed and left that as the only
 * option — without touching the disk.
 */
export function resolvePluginDshHome(
  vaultRoot: string,
  configDir: string,
  userDshHome: string,
): string {
  const legacy = pluginPaths(vaultRoot, configDir).dshHomeDir;
  try {
    const target = systemDshHomeDir(vaultRoot, userDshHome);
    // A migration that never completed leaves the legacy tree as the live one.
    if (fs.existsSync(legacy) && !fs.existsSync(path.join(target, '.migrated'))) {
      return fs.existsSync(target) ? target : legacy;
    }
    return target;
  } catch {
    return legacy;
  }
}
