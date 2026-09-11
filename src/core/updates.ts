/**
 * Update availability for the DeepHarness plugin.
 *
 * Obsidian already owns updating community plugins: it checks the store and
 * installs new builds itself. So this module does the smallest possible job —
 * ask the GitHub release API which version is newest — and the settings page
 * merely *surfaces* the answer plus a link to Obsidian's own update UI. Nothing
 * here downloads or installs anything; there is no write path in this file.
 *
 * The module deliberately imports nothing from `obsidian`. The one network
 * call is injected as `requestUrl` (see `RequestUrlFn`), because importing the
 * real one would drag the Obsidian runtime into every unit test that only
 * wants to exercise the version comparison.
 */
import { versionCmp } from '../dsh/pure';

/**
 * GitHub's "latest release" endpoint for this plugin's repo.
 *
 * Used instead of the raw `…/releases` list because GitHub already filters out
 * drafts and pre-releases for us, which is exactly the "is there a newer
 * published build?" question the settings page asks.
 */
export const RELEASES_LATEST_URL =
  'https://api.github.com/repos/cjs19890026-cmyk/dsh-obsidian-DeepHarness/releases/latest';

/**
 * Human-facing fallback link: the releases page itself.
 *
 * Used when a payload carries no usable `html_url`, so an "update available"
 * message always has somewhere to send the user.
 */
export const PLUGIN_RELEASES_PAGE =
  'https://github.com/cjs19890026-cmyk/dsh-obsidian-DeepHarness/releases';

/**
 * Default deadline for the release check.
 *
 * Generous enough for a slow mobile connection, short enough that the settings
 * page never looks hung: the check is a nicety, and a stale answer is worse
 * than a visible "could not check" line.
 */
export const LATEST_RELEASE_TIMEOUT_MS = 10_000;

/**
 * Message used when the caller knows the check failed but has no detail to
 * show (e.g. the release object is null without a specific error).
 */
export const DEFAULT_CHECK_FAILED_MESSAGE = 'Could not check for updates.';

/** Minimal shape of the GitHub release payload we rely on. */
export interface LatestRelease {
  /** Release version with any leading `v` already stripped (e.g. "0.2.0"). */
  version: string;
  /** Where to send the user when this release is newer than the running one. */
  url: string;
  /** Release body, when GitHub provided one, for a short "what's new" hint. */
  notes?: string;
}

/**
 * Result of comparing the running plugin version against the latest release.
 *
 * A closed union rather than booleans so the settings page can render every
 * case honestly: "up to date", "newer build exists, here is the link", and
 * "the check itself failed" are three different stories to tell the user.
 */
export type PluginUpdateStatus =
  | { kind: 'up-to-date'; current: string; latest: string }
  | { kind: 'update-available'; current: string; latest: string; url: string }
  | { kind: 'check-failed'; current: string; error: string };

/**
 * Structural subset of Obsidian's `requestUrl` (plus its response).
 *
 * Typed locally so this module stays importable — and trivially testable —
 * without the `obsidian` package. Obsidian's real `requestUrl` satisfies it
 * directly; wrap it if you want `throw: false`, since Obsidian throws on a
 * non-2xx status by default while this module also handles a returned status.
 */
export type RequestUrlFn = (req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}) => Promise<{ status: number; json?: unknown; text?: string }>;

/** Outcome of one request attempt, flattened so nothing here can reject. */
type RequestOutcome =
  | { kind: 'release'; release: LatestRelease }
  | { kind: 'status'; status: number }
  | { kind: 'timeout' }
  | { kind: 'failed'; error: string };

/**
 * Parse a GitHub `releases/latest` JSON body.
 *
 * Returns null when the payload is not usable (bad shape, missing/empty
 * `tag_name`). Never throws, because the body arrives straight from the
 * network and an unexpected shape (an HTML proxy page parsed as JSON, a
 * renamed field, a rate-limit object) must degrade to "no release info"
 * instead of breaking the settings page.
 */
export function parseLatestRelease(raw: unknown): LatestRelease | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const tag = typeof obj.tag_name === 'string' ? obj.tag_name.trim() : '';
  if (!tag) return null;

  // Tags in this repo have no `v` prefix, but a hand-made tag might. The
  // lookahead keeps a tag that merely starts with a letter `v` intact.
  const version = tag.replace(/^v(?=\d)/i, '');

  const htmlUrl = typeof obj.html_url === 'string' ? obj.html_url.trim() : '';
  const body = typeof obj.body === 'string' ? obj.body.trim() : '';
  return {
    version,
    url: htmlUrl || PLUGIN_RELEASES_PAGE,
    ...(body ? { notes: body } : {}),
  };
}

/**
 * Compare the running plugin version against the latest release. Pure.
 *
 * Only a strictly newer release counts as `update-available`: a release the
 * user already has (or a locally built version ahead of the published one,
 * which happens while developing) must not nag them with an update link that
 * would *downgrade* the plugin. `latest === null` means the check itself
 * failed, and the caller's `error` text is passed through verbatim so the
 * specific cause (timeout, HTTP status, offline) survives.
 */
export function comparePluginVersion(
  current: string,
  latest: LatestRelease | null,
  error?: string,
): PluginUpdateStatus {
  if (!latest) {
    return { kind: 'check-failed', current, error: error ?? DEFAULT_CHECK_FAILED_MESSAGE };
  }
  const url = latest.url.trim() || PLUGIN_RELEASES_PAGE;
  if (versionCmp(withVPrefix(latest.version), withVPrefix(current)) > 0) {
    return { kind: 'update-available', current, latest: latest.version, url };
  }
  return { kind: 'up-to-date', current, latest: latest.version };
}

/**
 * Fetch the latest release via Obsidian's `requestUrl` (bypasses CORS).
 *
 * NEVER throws — any failure resolves to an error string — because this runs
 * from the settings page, where an unhandled rejection would leave a spinner
 * (or a red console error) instead of the honest "could not check" line the
 * user can act on. The deadline is enforced by racing the request against a
 * timer, whose `AbortController` is told to abort as a best-effort cancel for
 * hosts that observe the signal; the timer is always cleared, so a resolved
 * check cannot keep the app awake or fire a late abort.
 */
export async function fetchLatestRelease(
  requestUrl: RequestUrlFn,
  timeoutMs: number = LATEST_RELEASE_TIMEOUT_MS,
): Promise<{ release: LatestRelease | null; error: string | null }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Wrapped in an async IIFE so a synchronous throw from the request
    // function, a rejection, or a throwing response getter all land in one
    // place instead of escaping as different failure modes.
    const request = (async (): Promise<RequestOutcome> => {
      try {
        const res = await requestUrl({
          url: RELEASES_LATEST_URL,
          method: 'GET',
          // GitHub's API rejects requests with no User-Agent (403).
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'deepharness-obsidian-plugin',
          },
        });
        if (res.status < 200 || res.status >= 300) {
          return { kind: 'status', status: res.status };
        }
        let payload: unknown;
        try {
          // Obsidian's `json` is a lazily-parsed getter that throws when the
          // body is not JSON (an HTML error page, a truncated response), so
          // reading it is itself a failure mode, not just parsing it.
          payload = res.json !== undefined ? res.json : JSON.parse(res.text ?? '');
        } catch (e) {
          return { kind: 'failed', error: messageOf(e) };
        }
        const release = parseLatestRelease(payload);
        if (!release) return { kind: 'failed', error: 'Unexpected release payload.' };
        return { kind: 'release', release };
      } catch (e) {
        return { kind: 'failed', error: messageOf(e) };
      }
    })();

    const timeout = new Promise<RequestOutcome>((resolve) => {
      timer = globalThis.setTimeout(() => {
        controller.abort();
        resolve({ kind: 'timeout' });
      }, timeoutMs);
    });

    // Narrowed in order so the last branch is provably `failed` — the union is
    // closed, so no unreachable `default` is needed.
    const outcome = await Promise.race([request, timeout]);
    if (outcome.kind === 'release') return { release: outcome.release, error: null };
    if (outcome.kind === 'timeout') {
      return { release: null, error: `Timed out after ${timeoutMs}ms.` };
    }
    if (outcome.kind === 'status') {
      return { release: null, error: `GitHub replied with HTTP ${outcome.status}.` };
    }
    return { release: null, error: outcome.error };
  } catch (e) {
    // Defensive: the contract of this function is "resolves, always".
    return { release: null, error: messageOf(e) };
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}

/**
 * `versionCmp` was written for nvm directory names and only recognises the
 * explicit `vX.Y.Z` form (`/^v(\d+)…/`), so a bare plugin version like "0.1.7"
 * would key as [0,0,0] and compare equal to everything. Normalising here keeps
 * a single semver comparator in the repo instead of a second, subtly different
 * one next to it.
 */
function withVPrefix(version: string): string {
  const v = version.trim();
  return /^v\d/i.test(v) ? v : `v${v}`;
}

/** Render an unknown thrown value as a message for the UI. */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : String(e);
}
