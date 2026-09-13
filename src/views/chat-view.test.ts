// @vitest-environment jsdom
/**
 * ChatView lifecycle regression tests.
 *
 * Written for a real bug found in manual testing: both toolbar icons did
 * nothing at all. The floating panels were built in `ChatView`'s constructor,
 * but an `ItemView` has no DOM until `onOpen()`, so the panels captured
 * `undefined` anchors — and because the fields were declared with a `!`
 * definite-assignment assertion, TypeScript accepted it without complaint.
 * Every click then threw inside FloatingPanel.position()
 * (`anchorEl.ownerDocument`), and because the throw happens inside a DOM click
 * handler the UI just sits there: nothing opens, nothing is reported.
 *
 * That invisibility is why these tests also assert on unhandled errors: a click
 * that throws in an event handler still "succeeds" for the caller, so a plain
 * `expect(() => el.click()).not.toThrow()` would pass on the broken code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const doubles = await import('../../test/obsidian-view-double');
  return {
    ...actual,
    ItemView: doubles.FakeItemView,
    WorkspaceLeaf: doubles.FakeWorkspaceLeaf,
    Notice: doubles.FakeNotice,
    Menu: doubles.FakeMenu,
    MarkdownView: doubles.FakeMarkdownView,
  };
});

import { ChatView } from './chat-view';
import { appSlot, makeAppDouble, makePluginDouble } from '../../test/obsidian-view-double';

function buildView(): ChatView {
  const app = makeAppDouble();
  appSlot.current = app;
  return new ChatView({} as never, makePluginDouble(app) as never);
}

/**
 * Clicks an element and fails the test if the handler threw.
 *
 * jsdom reports event-handler exceptions through the window's `error` event
 * instead of rethrowing them to the `click()` caller, so without this the
 * original bug would pass every assertion in this file.
 */
function click(element: HTMLElement): void {
  const errors: string[] = [];
  const onError = (event: ErrorEvent): void => {
    errors.push(String(event.error ?? event.message));
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  try {
    element.click();
  } finally {
    window.removeEventListener('error', onError);
  }
  expect(errors).toEqual([]);
}

describe('ChatView toolbar panels', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appSlot.current = undefined;
  });

  it('opens the history panel when its icon is clicked', async () => {
    const view = buildView();
    await view.onOpen();

    const btn = view.containerEl.querySelector('.dsh-top-history') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    click(btn);
    expect(document.querySelectorAll('.dsh-history-panel')).toHaveLength(1);
  });

  it('opens the skills panel when its icon is clicked', async () => {
    const view = buildView();
    await view.onOpen();

    const btn = view.containerEl.querySelector('.dsh-top-skill') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    click(btn);
    expect(document.querySelectorAll('.dsh-skill-panel')).toHaveLength(1);
  });

  it('keeps the two panels mutually exclusive, and toggles each shut', async () => {
    const view = buildView();
    await view.onOpen();
    const historyBtn = view.containerEl.querySelector('.dsh-top-history') as HTMLButtonElement;
    const skillBtn = view.containerEl.querySelector('.dsh-top-skill') as HTMLButtonElement;

    click(historyBtn);
    expect(document.querySelectorAll('.dsh-history-panel')).toHaveLength(1);
    click(skillBtn);
    expect(document.querySelectorAll('.dsh-history-panel')).toHaveLength(1);
    expect(document.querySelector('.dsh-skill-panel')).toBeTruthy();
    click(skillBtn);
    expect(document.querySelectorAll('.dsh-history-panel')).toHaveLength(0);
  });

  it('tolerates lifecycle calls before onOpen() (locale/teardown must not throw)', async () => {
    // A view can be torn down without ever having rendered (plugin unload), and
    // a locale change can reach a view whose onOpen has not run yet. Both touch
    // the panels, so neither may assume they exist.
    const neverOpened = buildView();
    expect(() => neverOpened.shutdownForUnload()).not.toThrow();

    const view = buildView();
    await view.onOpen();
    // Private, but this is exactly the callback the locale subscription runs.
    const refresh = (view as unknown as Record<string, () => void>).refreshLocaleStrings;
    expect(() => refresh.call(view)).not.toThrow();
  });

  it('builds the panels with real, defined anchors', async () => {
    // Asserted on the panels directly (not only through a click) so a failure
    // names the cause: an undefined anchor is precisely the reported bug.
    const view = buildView();
    await view.onOpen();
    const panels = view as unknown as Record<string, { toggle(): void }>;
    for (const name of ['historyPanel', 'skillPanel']) {
      expect(panels[name], `${name} was not built by onOpen()`).toBeTruthy();
      expect(() => panels[name].toggle()).not.toThrow();
    }
    expect(document.querySelectorAll('.dsh-history-panel')).toHaveLength(1);
  });
});

describe('ChatView conversation context', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appSlot.current = undefined;
  });

  /** The text the agent is actually spawned with, for the next send. */
  async function captureNextTaskText(view: ChatView): Promise<string> {
    const client = (view as unknown as { client: { run(task: string, opts: unknown): Promise<unknown> } }).client;
    let task = '';
    client.run = async (t: string): Promise<unknown> => {
      task = t;
      return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, killReason: null };
    };
    // The run path touches the DOM and the runner; only the task text matters
    // here, so keep the editor usable and send.
    // A real message must be in the editor or sendMessage() returns early.
    (view as unknown as { editor: { setText(t: string): void } }).editor.setText('follow-up question');
    await (view as unknown as { sendMessage(): Promise<void> }).sendMessage();
    return task;
  }

  it('carries earlier turns of the session into the next task', async () => {
    const view = buildView();
    await view.onOpen();
    const memory = (view as unknown as { memory: Array<{ user: string; assistant: string }> }).memory;
    memory.push({ user: 'What is the capital of France?', assistant: 'Paris.' });

    const task = await captureNextTaskText(view);
    expect(task).toContain('What is the capital of France?');
    expect(task).toContain('Paris.');
  });

  it('rebuilds that context when an archived session is resumed', async () => {
    // The reported bug: opening a session from the history panel restored the
    // visible transcript but left the agent with no memory of it, because the
    // rebuild kept only the first line of each answer, capped at 200 chars.
    const app = makeAppDouble();
    appSlot.current = app;
    const plugin = makePluginDouble(app);
    const multiLine = `archived first line ${'y'.repeat(250)}\nARCHIVED_SECOND_LINE`;
    (plugin.history as unknown as Record<string, unknown>).activateSession = async () => ({
      id: 's1',
      title: 'Archived',
      turns: [
        { ts: 0, user: 'ARCHIVED_USER_TURN', answer: multiLine, durationMs: 0 },
      ],
    });
    const view = new ChatView({} as never, plugin as never);
    await view.onOpen();
    await (view as unknown as { resumeSession(s: unknown): Promise<void> }).resumeSession({ id: 's1' });

    const task = await captureNextTaskText(view);
    expect(task).toContain('ARCHIVED_USER_TURN');
    expect(task).toContain('ARCHIVED_SECOND_LINE');
  });

  it('carries a full multi-line answer, not just its first line', async () => {
    // The bug: memory kept `answer.split('\n')[0].slice(0, 200)`, so everything
    // after the first line was silently dropped when a session was resumed.
    const view = buildView();
    await view.onOpen();
    const longAnswer = `FIRST_LINE_${'x'.repeat(300)}\nSECOND_LINE_MARKER`;
    (view as unknown as { memory: unknown[] }).memory.push(
      { user: 'question', assistant: longAnswer },
    );

    const task = await captureNextTaskText(view);
    expect(task).toContain('SECOND_LINE_MARKER');
  });
});

describe('ChatView.prepareRun (extracted preparation phase)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appSlot.current = undefined;
  });

  /** A view whose runner reports whatever the test wants it to find. */
  function viewWithProbes(probes: { bin?: string | null; node?: string | null; script?: string | null }) {
    const view = buildView();
    const runner = (view as unknown as { runner: Record<string, unknown> }).runner;
    runner.detectBin = async () => probes.bin ?? null;
    runner.detectNode = async () => probes.node ?? null;
    runner.resolveDshScript = () => probes.script ?? null;
    return view;
  }

  it('reports a missing dsh binary instead of spawning', async () => {
    const view = viewWithProbes({ bin: null });
    await view.onOpen();
    let spawned = false;
    (view as unknown as { client: { run(): Promise<unknown> } }).client.run = async () => {
      spawned = true;
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 0, killReason: null };
    };

    const prep = await (view as unknown as {
      prepareRun(m: string): Promise<{ ok: boolean }>;
    }).prepareRun('hello');

    expect(prep.ok).toBe(false);
    expect(spawned).toBe(false);
    // The original code rendered a setup error and announced it; both stay.
    expect(view.containerEl.querySelector('.dsh-message-system')).toBeTruthy();
  });

  it('reports a missing node binary instead of spawning', async () => {
    const view = viewWithProbes({ bin: '/usr/bin/dsh', node: null });
    await view.onOpen();
    const prep = await (view as unknown as {
      prepareRun(m: string): Promise<{ ok: boolean }>;
    }).prepareRun('hello');
    expect(prep.ok).toBe(false);
    expect(view.containerEl.querySelector('.dsh-message-system')).toBeTruthy();
  });

  it('returns everything a run needs when the environment is complete', async () => {
    const view = viewWithProbes({
      bin: '/usr/local/bin/dsh',
      node: process.execPath,
      script: '/usr/local/lib/dsh/bin.js',
    });
    await view.onOpen();
    const prep = await (view as unknown as { prepareRun(m: string): Promise<Record<string, unknown>> })
      .prepareRun('summarise my notes');

    expect(prep.ok).toBe(true);
    // The assembled task carries the user's message; the rest are the paths the
    // spawn needs. Losing any of these was the failure mode this guards.
    expect(prep.task).toContain('summarise my notes');
    expect(prep.bin).toBe('/usr/local/bin/dsh');
    expect(prep.nodeBin).toBe(process.execPath);
    expect(prep.dshScript).toBe('/usr/local/lib/dsh/bin.js');
    expect(typeof prep.dshHome).toBe('string');
    expect(typeof prep.workdir).toBe('string');
    expect(Array.isArray(prep.patchPaths)).toBe(true);
    expect(Array.isArray(prep.issues)).toBe(true);
  });

  it('stops before preparing when the view was torn down mid-detection', async () => {
    // P2-K: the four `closed` guards used to sit inline in sendMessage; this
    // pins the one that fires between binary detection and the rest.
    const view = viewWithProbes({ bin: '/usr/bin/dsh', node: process.execPath, script: '/x/bin.js' });
    await view.onOpen();
    const runner = (view as unknown as { runner: Record<string, unknown> }).runner;
    runner.detectNode = async () => {
      (view as unknown as { closed: boolean }).closed = true;
      return process.execPath;
    };

    const prep = await (view as unknown as { prepareRun(m: string): Promise<{ ok: boolean }> })
      .prepareRun('hello');
    expect(prep.ok).toBe(false);
  });
});

describe('skill discovery roots', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appSlot.current = undefined;
  });

  /**
   * Skills for a vault live in exactly one place: the plugin's DSH_HOME
   * (`~/.dsh/deepharness/<vaultKey>/skills`, outside the vault), which also
   * holds the built-in obsidian skill. Scanning the vault's own `.dsh/skills`
   * and `.agents/skills` was removed because it made "where do I put a skill?"
   * ambiguous and kept skill files inside synced folders.
   */
  it('scans the plugin DSH_HOME and nothing inside the vault', async () => {
    const view = buildView();
    await view.onOpen();
    const roots = (view as unknown as {
      scanRoots(v: string): Array<{ dir: string; source: string }>;
    }).scanRoots('/tmp/some-vault');

    const vaultRoot = (view as unknown as { plugin: { getVaultRoot(): string } }).plugin.getVaultRoot();
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root.dir.startsWith(vaultRoot)).toBe(false);
    }
    // The vault-scoped root carries its own source so the panel can label it.
    expect(roots.some((r) => r.source === 'vault')).toBe(true);
  });

  it('includes vault-scoped skills registered from settings as custom roots', async () => {
    const view = buildView();
    await view.onOpen();
    const settings = (view as unknown as { plugin: { settings: Record<string, unknown> } }).plugin.settings;
    settings.extraSkillDirs = 'Harness';
    const roots = (view as unknown as {
      scanRoots(v: string): Array<{ dir: string; source: string }>;
    }).scanRoots((view as unknown as { plugin: { getVaultRoot(): string } }).plugin.getVaultRoot());

    // Custom dirs are vault-internal by design (containment-checked elsewhere),
    // and must still be labelled separately from the vault skills folder.
    expect(roots.some((r) => r.source === 'custom' && r.dir.endsWith('Harness'))).toBe(true);
  });
});
