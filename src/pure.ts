/**
 * Obsidian-free pure helpers, extracted so they can be unit-tested in Node
 * without pulling in the `obsidian` API.
 */
import * as path from 'path';
import { pathToFileURL } from 'url';
import { t } from './i18n';

/**
 * Render the stream-relay patch overlay (`stream.yml`) for a relay script.
 *
 * The relay script must be referenced by a `file://` URL: Node's ESM loader
 * rejects bare Windows absolute paths ("D:\\...") as plugin import
 * specifiers (ERR_UNSUPPORTED_ESM_URL_SCHEME), while file URLs work on
 * every platform.
 */
export function streamRelayPatchYaml(relayFile: string): string {
  const spec = pathToFileURL(relayFile).href;
  return [
    '# 由 deepharness 生成。实时输出 agent 的思考( reasoning )与',
    '# 工具调用( tool )事件,格式 "DLEVENT\\t<json>" 供插件流式解析。',
    '- insert:',
    '    - id: deepharness-stream-relay',
    `      name: ${JSON.stringify(spec)}`,
    '',
  ].join('\n');
}

/**
 * Extract the real Node.js script target from an npm-generated Windows shim
 * (.cmd / .ps1 / POSIX-sh "dsh" launcher). npm writes one of these per global
 * bin; each delegates to the actual JS entry, e.g. .cmd:
 *
 *   "%_prog%"  "%dp0%\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
 *
 * or .ps1:
 *
 *   & "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args
 *
 * Returns the `node_modules/...` relative path found in the text (relative to
 * the shim's own directory), or null when the file is not an npm shim.
 */
export function shimJsTarget(text: string): string | null {
  const m = /node_modules[\\/][^"\s`']+?\.(?:c?js|mjs)/i.exec(text);
  return m ? m[0] : null;
}

/**
 * Strip DLEVENT lines emitted by the injected stream-relay plugin from the
 * headless stdout. Those were already consumed live via onStdoutLine
 * (thinking + tool events); what remains is the agent's final answer.
 */
export function parseHeadlessOutput(stdout: string): string {
  const answerParts: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('DLEVENT\t')) continue;
    answerParts.push(line);
  }
  return answerParts.join('\n').trim();
}

/**
 * One real-time event parsed from a `DLEVENT\t<json>` stdout line.
 * The stream relay emits these for reasoning increments and tool calls.
 */
export type DshStreamEvent =
  | { t: 'think'; text: string }
  | { t: 'tool'; status: 'start'; id: string; name: string; args: string; argsFull?: string }
  | { t: 'tool'; status: 'result'; id?: string; ok: boolean; summary?: string };

const DLEVENT_PREFIX = 'DLEVENT\t';

/**
 * Parse a single raw stream-relay stdout line into a typed DshStreamEvent.
 *
 * Non-DLEVENT lines, malformed JSON, and shapes outside the known relay
 * protocol return null. This is the pure half of the inline parser previously
 * embedded in ChatView.handleStreamLine; it does not perform any UI work.
 */
export function parseDshEventLine(line: string): DshStreamEvent | null {
  if (!line.startsWith(DLEVENT_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(DLEVENT_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (obj.t === 'think' && typeof obj.text === 'string') {
    return { t: 'think', text: obj.text };
  }

  if (obj.t === 'tool' && typeof obj.status === 'string') {
    if (obj.status === 'start' && typeof obj.id === 'string') {
      return {
        t: 'tool',
        status: 'start',
        id: obj.id,
        name: typeof obj.name === 'string' ? obj.name : 'tool',
        args: typeof obj.args === 'string' ? obj.args : '',
        ...(typeof obj.argsFull === 'string' ? { argsFull: obj.argsFull } : {}),
      };
    }
    if (obj.status === 'result' && typeof obj.ok === 'boolean') {
      return {
        t: 'tool',
        status: 'result',
        ...(typeof obj.id === 'string' ? { id: obj.id } : {}),
        ok: obj.ok,
        ...(typeof obj.summary === 'string' ? { summary: obj.summary } : {}),
      };
    }
  }
  return null;
}


/** Map a dsh error CODE to a user-friendly message; null = unknown code. */
export function errorHint(code: string): string | null {
  switch (code) {
    case 'INVALID_CREDENTIAL':
    case 'MISSING_CREDENTIAL':
    case 'NO_ADAPTER':
      return t('chat.noCredential');
    case 'QUOTA':
      return t('chat.errQuota');
    case 'RATE_LIMIT':
      return t('chat.errRateLimit');
    case 'TIMEOUT':
      return t('chat.errTimeout');
    case 'TRANSPORT':
    case 'SERVER':
      return t('chat.errNetwork');
    case 'CONTEXT_WINDOW_EXCEEDED':
      return t('chat.errContextWindow');
    case 'SANDBOX_UNAVAILABLE':
      return t('chat.errSandbox');
    default:
      return null;
  }
}

/** Numeric semver compare for nvm "vX.Y.Z" dirs (a < b => negative). */
export function versionCmp(a: string, b: string): number {
  const key = (v: string): number[] => {
    const m = v.match(/^v(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < 3; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

/** Default context window when the model isn't in the map. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/** Context window (tokens) per model id. */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash-vision-exp': 1_000_000,
};

/** Resolve the context window for a model id (safe default). */
export function contextWindowFor(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Resolve a user-configured, vault-relative directory against the vault root.
 *
 * Guards every consumer of `extraSkillDirs` (the skill UI scan and the DSH
 * skill-dirs patch): the setting is documented as "vault-relative folders",
 * so an absolute path or a `../` sequence must never move the skill boundary
 * outside the vault.
 *
 * Returns the absolute directory, or null when the input is empty, is an
 * absolute path, or would escape the vault root via `..`.
 */
export function resolveVaultRelativeDir(vaultRoot: string, rel: string): string | null {
  const t = rel.trim();
  if (!t) return null;
  // Absolute paths ('/…' on POSIX, 'C:\…' on Windows) are never vault-relative.
  if (path.isAbsolute(t)) return null;
  const base = path.resolve(vaultRoot, t);
  const relToRoot = path.relative(vaultRoot, base);
  // `..` / `../…` escape the vault; an absolute relToRoot can only happen on
  // Windows across different drives, which is an escape as well.
  if (relToRoot === '..' || relToRoot.startsWith('..' + path.sep) || path.isAbsolute(relToRoot)) {
    return null;
  }
  return base;
}

/**
 * Normalize the Obsidian `aliases` frontmatter value (array, comma-separated
 * string, or garbage) into a clean string list.
 *
 * Extracted from ChatView.linkifyAnswer (P2-H) so the fiddly parsing can be
 * unit-tested Obsidian-free; used to build the vault-note title index.
 */
export function frontmatterAliases(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
