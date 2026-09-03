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
