import { afterEach, describe, expect, it, vi } from 'vitest';

// updates.ts imports only `versionCmp` from ./pure, whose own imports are
// node's `path`/`url` plus the obsidian-free i18n table — so, unlike
// settings.test.ts, this suite needs no `vi.mock('obsidian', …)` stub.
import {
  DEFAULT_CHECK_FAILED_MESSAGE,
  LATEST_RELEASE_TIMEOUT_MS,
  PLUGIN_RELEASES_PAGE,
  RELEASES_LATEST_URL,
  comparePluginVersion,
  fetchLatestRelease,
  parseLatestRelease,
  type LatestRelease,
  type RequestUrlFn,
} from './updates';

/** Response shape the injected request function is expected to hand back. */
type RawResponse = { status: number; json?: unknown; text?: string };

/** One recorded call to the injected request function. */
type Call = { url: string; method?: string; headers?: Record<string, string> };

const RELEASE_URL =
  'https://github.com/cjs19890026-cmyk/dsh-obsidian-DeepHarness/releases/tag/0.2.0';

/** A well-formed GitHub `releases/latest` body, as the API really returns it. */
const goodPayload = {
  tag_name: '0.2.0',
  html_url: RELEASE_URL,
  body: 'Fixes the settings crash.',
  name: 'DeepHarness 0.2.0',
  draft: false,
  prerelease: false,
};

/**
 * Build a requestUrl stub that always answers with `behaviour`, recording every
 * call it received. `'hang'` models a request that never settles (the case the
 * deadline exists for); an Error instance models a rejected request.
 */
function stub(behaviour: RawResponse | Error | 'hang'): { fn: RequestUrlFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: RequestUrlFn = (req) => {
    calls.push(req);
    if (behaviour instanceof Error) return Promise.reject(behaviour);
    if (behaviour === 'hang') return new Promise<RawResponse>(() => undefined);
    return Promise.resolve(behaviour);
  };
  return { fn, calls };
}

/** A requestUrl that throws synchronously instead of returning a promise. */
const syncThrower: RequestUrlFn = () => {
  throw new Error('requestUrl exploded');
};

/**
 * A response whose `json` getter throws when read, exactly like Obsidian's
 * lazily-parsed `RequestUrlResponse.json` does on a non-JSON body.
 */
const explodingJson: RequestUrlFn = () =>
  Promise.resolve({
    status: 200,
    get json(): unknown {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    },
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('parseLatestRelease', () => {
  it('parses a well-formed release payload', () => {
    expect(parseLatestRelease(goodPayload)).toEqual({
      version: '0.2.0',
      url: RELEASE_URL,
      notes: 'Fixes the settings crash.',
    });
  });

  it('strips a leading "v" from the tag, whatever its case', () => {
    expect(parseLatestRelease({ ...goodPayload, tag_name: 'v0.2.0' })?.version).toBe('0.2.0');
    expect(parseLatestRelease({ ...goodPayload, tag_name: 'V0.2.0' })?.version).toBe('0.2.0');
    expect(parseLatestRelease({ ...goodPayload, tag_name: '  v0.2.0  ' })?.version).toBe('0.2.0');
  });

  it('keeps a tag that merely starts with the letter v intact', () => {
    expect(parseLatestRelease({ ...goodPayload, tag_name: 'vNext' })?.version).toBe('vNext');
  });

  it('falls back to the releases page when html_url is absent or blank', () => {
    const { html_url: _drop, ...noUrl } = goodPayload;
    expect(parseLatestRelease(noUrl)?.url).toBe(PLUGIN_RELEASES_PAGE);
    expect(parseLatestRelease({ ...goodPayload, html_url: '   ' })?.url).toBe(PLUGIN_RELEASES_PAGE);
    expect(parseLatestRelease({ ...goodPayload, html_url: 42 })?.url).toBe(PLUGIN_RELEASES_PAGE);
  });

  it('omits notes when the release body is missing or blank', () => {
    const { body: _drop, ...noBody } = goodPayload;
    expect(parseLatestRelease(noBody)).toEqual({ version: '0.2.0', url: RELEASE_URL });
    expect(parseLatestRelease({ ...goodPayload, body: '   ' })).toEqual({
      version: '0.2.0',
      url: RELEASE_URL,
    });
    expect(parseLatestRelease({ ...goodPayload, body: { html: '<p>x</p>' } })).toEqual({
      version: '0.2.0',
      url: RELEASE_URL,
    });
  });

  it('returns null for non-object payloads', () => {
    for (const raw of [undefined, null, 'garbage', 42, true, [], [goodPayload]]) {
      expect(parseLatestRelease(raw), `expected null for ${JSON.stringify(raw)}`).toBeNull();
    }
  });

  it('returns null when tag_name is missing, empty, or not a string', () => {
    expect(parseLatestRelease({})).toBeNull();
    expect(parseLatestRelease({ html_url: RELEASE_URL })).toBeNull();
    expect(parseLatestRelease({ tag_name: undefined })).toBeNull();
    expect(parseLatestRelease({ tag_name: 42 })).toBeNull();
    expect(parseLatestRelease({ tag_name: '' })).toBeNull();
    expect(parseLatestRelease({ tag_name: '   ' })).toBeNull();
  });

  it('never throws, whatever the payload', () => {
    const hostile: unknown[] = [
      undefined,
      null,
      'garbage',
      { tag_name: { nested: true } },
      { tag_name: '0.2.0', html_url: {} },
      Object.create(null) as unknown,
    ];
    for (const raw of hostile) {
      expect(() => parseLatestRelease(raw)).not.toThrow();
    }
  });
});

describe('comparePluginVersion', () => {
  const latest: LatestRelease = { version: '0.2.0', url: RELEASE_URL };

  it('reports an update when the release is newer', () => {
    expect(comparePluginVersion('0.1.7', latest)).toEqual({
      kind: 'update-available',
      current: '0.1.7',
      latest: '0.2.0',
      url: RELEASE_URL,
    });
  });

  it('compares numerically, not lexicographically', () => {
    expect(comparePluginVersion('0.9.0', { version: '0.10.0', url: RELEASE_URL }).kind)
      .toBe('update-available');
    expect(comparePluginVersion('0.10.0', { version: '0.9.0', url: RELEASE_URL }).kind)
      .toBe('up-to-date');
  });

  it('tolerates versions with or without a "v" prefix on either side', () => {
    expect(comparePluginVersion('v0.1.7', latest).kind).toBe('update-available');
    expect(comparePluginVersion('0.1.7', { version: 'v0.2.0', url: RELEASE_URL }).kind)
      .toBe('update-available');
    expect(comparePluginVersion('0.2.0', { version: 'v0.2.0', url: RELEASE_URL })).toEqual({
      kind: 'up-to-date',
      current: '0.2.0',
      latest: 'v0.2.0',
    });
  });

  it('reports up-to-date for an equal version', () => {
    expect(comparePluginVersion('0.1.7', { version: '0.1.7', url: RELEASE_URL })).toEqual({
      kind: 'up-to-date',
      current: '0.1.7',
      latest: '0.1.7',
    });
  });

  it('reports up-to-date when the running version is ahead of the release', () => {
    // A local build ahead of the published one must never be offered a link
    // that would downgrade the plugin.
    expect(comparePluginVersion('0.3.0', latest)).toEqual({
      kind: 'up-to-date',
      current: '0.3.0',
      latest: '0.2.0',
    });
  });

  it('passes the caller error through when there is no release to compare', () => {
    expect(comparePluginVersion('0.1.7', null, 'Timed out after 10000ms.')).toEqual({
      kind: 'check-failed',
      current: '0.1.7',
      error: 'Timed out after 10000ms.',
    });
  });

  it('falls back to a generic message when no error was supplied', () => {
    expect(comparePluginVersion('0.1.7', null)).toEqual({
      kind: 'check-failed',
      current: '0.1.7',
      error: DEFAULT_CHECK_FAILED_MESSAGE,
    });
    expect(DEFAULT_CHECK_FAILED_MESSAGE.length).toBeGreaterThan(0);
  });

  it('falls back to the releases page when a release carries no usable url', () => {
    expect(comparePluginVersion('0.1.7', { version: '0.2.0', url: '   ' })).toEqual({
      kind: 'update-available',
      current: '0.1.7',
      latest: '0.2.0',
      url: PLUGIN_RELEASES_PAGE,
    });
  });
});

describe('fetchLatestRelease', () => {
  it('returns the parsed release on success', async () => {
    const { fn, calls } = stub({ status: 200, json: goodPayload });
    await expect(fetchLatestRelease(fn)).resolves.toEqual({
      release: { version: '0.2.0', url: RELEASE_URL, notes: 'Fixes the settings crash.' },
      error: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RELEASES_LATEST_URL);
    expect(calls[0].method).toBe('GET');
    // GitHub's API answers 403 without a User-Agent.
    expect(calls[0].headers?.['User-Agent']).toBeTruthy();
  });

  it('parses a JSON body handed over as text only', async () => {
    const { fn } = stub({ status: 200, text: JSON.stringify(goodPayload) });
    await expect(fetchLatestRelease(fn)).resolves.toMatchObject({
      release: { version: '0.2.0' },
      error: null,
    });
  });

  it('treats a non-2xx status as an error string', async () => {
    for (const status of [301, 403, 404, 500]) {
      const { fn } = stub({ status, json: { message: 'nope' } });
      const res = await fetchLatestRelease(fn);
      expect(res.release).toBeNull();
      expect(res.error, `missing status in error for ${status}`).toContain(String(status));
    }
  });

  it('turns a thrown network error into an error string', async () => {
    const { fn } = stub(new Error('getaddrinfo ENOTFOUND api.github.com'));
    const res = await fetchLatestRelease(fn);
    expect(res.release).toBeNull();
    expect(res.error).toContain('ENOTFOUND');
  });

  it('turns a synchronous throw into an error string', async () => {
    const res = await fetchLatestRelease(syncThrower);
    expect(res.release).toBeNull();
    expect(res.error).toContain('exploded');
  });

  it('gives up after the timeout and clears its timer', async () => {
    vi.useFakeTimers();
    const { fn, calls } = stub('hang');
    const pending = fetchLatestRelease(fn, 500);
    await vi.advanceTimersByTimeAsync(500);
    const res = await pending;
    expect(calls).toHaveLength(1);
    expect(res.release).toBeNull();
    expect(res.error).toMatch(/timed out/i);
    expect(res.error).toContain('500');
    // The timer is cleared in `finally`, so nothing lingers after the check.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait for the deadline when the request answers first', async () => {
    vi.useFakeTimers();
    const { fn } = stub({ status: 200, json: goodPayload });
    await expect(fetchLatestRelease(fn, 500)).resolves.toMatchObject({
      error: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts a huge non-JSON body as a graceful failure', async () => {
    const { fn } = stub({ status: 200, text: '<html>'.repeat(40_000) });
    const res = await fetchLatestRelease(fn);
    expect(res.release).toBeNull();
    expect(res.error).toBeTruthy();
  });

  it('survives a response getter that throws while being read', async () => {
    const res = await fetchLatestRelease(explodingJson);
    expect(res.release).toBeNull();
    expect(res.error).toContain('Unexpected token');
  });

  it('rejects odd-but-2xx payloads as a failure, not a crash', async () => {
    const odd: RawResponse[] = [
      { status: 200 },
      { status: 200, json: null },
      { status: 200, json: 42 },
      { status: 200, json: 'a string' },
      { status: 200, json: [] },
      { status: 200, json: {} },
      { status: 200, json: { tag_name: '' } },
      { status: 200, json: { message: 'API rate limit exceeded' } },
      { status: 200, text: 'not json at all' },
    ];
    for (const response of odd) {
      const { fn } = stub(response);
      const res = await fetchLatestRelease(fn);
      expect(res.release, `unexpected release for ${JSON.stringify(response)}`).toBeNull();
      expect(res.error, `missing error for ${JSON.stringify(response)}`).toBeTruthy();
    }
  });

  it('never rejects — every failure path resolves to a message', async () => {
    const failures: RequestUrlFn[] = [
      stub({ status: 404 }).fn,
      stub({ status: 500 }).fn,
      stub(new Error('offline')).fn,
      stub('hang').fn,
      stub({ status: 200, text: '<html>error page</html>' }).fn,
      stub({ status: 200, json: {} }).fn,
      syncThrower,
      explodingJson,
    ];
    for (const fn of failures) {
      await expect(fetchLatestRelease(fn, 1000)).resolves.toMatchObject({ release: null });
    }
  });

  it('exposes a sane default deadline', () => {
    expect(Number.isFinite(LATEST_RELEASE_TIMEOUT_MS)).toBe(true);
    expect(LATEST_RELEASE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
