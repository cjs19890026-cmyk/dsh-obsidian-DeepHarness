// @vitest-environment jsdom
/**
 * Main-chain tests for ChatView: prepare -> spawn -> stream -> finish.
 *
 * The view used to construct `DshClient` and `DshRunner` itself, so the only
 * way to test a send was to monkey-patch private fields after construction.
 * `ChatViewDeps` now makes the two seams explicit; these tests drive the real
 * `sendMessage`/`executeRun` path with a fake client and runner and assert the
 * RunController's invariant after every terminal state:
 *
 *   state === 'idle' and the composer is back on "Send".
 *
 * That invariant is the fix for the confirmed stuck-Stop bug: when
 * `prepareRun()` failed, the old code returned before its `finally`, leaving
 * `running = true` forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const doubles = await import('../../test/obsidian-view-double');
  class FakeModal {
    contentEl = document.createElement('div');
    constructor(_app: unknown) {}
    open(): void {
      document.body.appendChild(this.contentEl);
      (this as unknown as { onOpen(): void }).onOpen();
    }
    close(): void {
      (this as unknown as { onClose?(): void }).onClose?.();
      this.contentEl.remove();
    }
  }
  return {
    ...actual,
    ItemView: doubles.FakeItemView,
    WorkspaceLeaf: doubles.FakeWorkspaceLeaf,
    Notice: doubles.FakeNotice,
    Menu: doubles.FakeMenu,
    MarkdownView: doubles.FakeMarkdownView,
    Modal: FakeModal,
  };
});

import { ChatView, type ChatViewDeps } from './chat-view';
import { appSlot, makeAppDouble, makePluginDouble } from '../../test/obsidian-view-double';

interface RunOptionsLike {
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
}

interface ResultLike {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killReason: 'timeout' | 'user' | null;
}

function result(overrides: Partial<ResultLike> = {}): ResultLike {
  return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, killReason: null, ...overrides };
}

function makeRunner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    detectBin: async () => '/usr/local/bin/dsh',
    detectNode: async () => process.execPath,
    resolveDshScript: () => '/usr/local/lib/dsh/bin.js',
    buildTask: (message: string) => `TASK:${message}`,
    ensureVaultPatch: async () => ({ persona: '/tmp/persona.yml', think: '/tmp/think.yml' }),
    ensureSkillDirsPatch: () => '/tmp/skill-dirs.yml',
    ensurePluginDshHome: () => '/tmp/deepharness-home',
    dshHome: () => '/tmp/deepharness-home',
    ensureObsidianSkill: () => {},
    ensureMemoryFile: () => {},
    workdir: () => '/tmp/vault',
    ...overrides,
  };
}

function makeClient(
  handler: (task: string, opts: RunOptionsLike) => Promise<ResultLike>,
): { run: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(handler),
    stop: vi.fn(),
    dispose: vi.fn(),
  };
}

function buildView(
  client: unknown,
  runner: unknown = makeRunner(),
  app = makeAppDouble(),
): {
  view: ChatView;
  plugin: ReturnType<typeof makePluginDouble>;
} {
  appSlot.current = app;
  const plugin = makePluginDouble(app);
  (plugin.history as unknown as Record<string, unknown>).addTurn = vi.fn(async () => {});
  (plugin.history as unknown as Record<string, unknown>).updateTurn = vi.fn(async () => {});
  const view = new ChatView({} as never, plugin as never, {
    client: client as ChatViewDeps['client'],
    runner: runner as ChatViewDeps['runner'],
  });
  return { view, plugin };
}

function typeAndSend(view: ChatView, text = 'hello world'): Promise<void> {
  const editor = (view as unknown as { editor: { setText(t: string): void } }).editor;
  editor.setText(text);
  return (view as unknown as { sendMessage(): Promise<void> }).sendMessage();
}

function runState(view: ChatView): string {
  return (view as unknown as { run: { state: string } }).run.state;
}

function sendButton(view: ChatView): HTMLButtonElement {
  return view.containerEl.querySelector('.dsh-send-btn') as HTMLButtonElement;
}

function stopButton(view: ChatView): void {
  (view as unknown as { stopRun(): void }).stopRun();
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ChatView run chain', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appSlot.current = undefined;
  });

  it('runs prepare -> spawn -> stream -> success, then returns to idle', async () => {
    let seenTask = '';
    let streamed = '';
    const client = makeClient(async (task, opts) => {
      seenTask = task;
      opts.onStdoutLine?.('DLEVENT\t{"t":"think","text":"planning"}');
      opts.onStdoutLine?.('DLEVENT\t{"t":"tool","status":"start","id":"t1","name":"Read","args":"note.md"}');
      opts.onStdoutLine?.('DLEVENT\t{"t":"tool","status":"result","id":"t1","ok":true,"summary":"read 6 bytes"}');
      streamed = 'streamed';
      return result({ stdout: 'FINAL_ANSWER' });
    });
    const { view, plugin } = buildView(client);
    await view.onOpen();

    await typeAndSend(view);

    expect(seenTask).toContain('TASK:hello world');
    expect(streamed).toBe('streamed');
    expect(runState(view)).toBe('idle');
    expect(sendButton(view).classList.contains('is-stop')).toBe(false);
    // The answer is persisted even though jsdom's MarkdownRenderer stub does
    // not materialise text into the DOM.
    expect((plugin.history as unknown as { addTurn: ReturnType<typeof vi.fn> }).addTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: 'FINAL_ANSWER',
        status: 'succeeded',
        tools: [{ name: 'Read', args: 'note.md', ok: true, summary: 'read 6 bytes' }],
      }),
      expect.anything(),
    );
  });

  it('cancels a running child and returns the composer to Send', async () => {
    let optsSeen: RunOptionsLike | undefined;
    const client = makeClient((_task, opts) => {
      optsSeen = opts;
      return new Promise<ResultLike>((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve(result({ killReason: 'user' })));
      });
    });
    const { view } = buildView(client);
    await view.onOpen();

    const sending = typeAndSend(view);
    // Wait until prepare finished and the child is marked running.
    await settle();
    expect(client.run).toHaveBeenCalled();
    expect(runState(view)).toBe('running');
    expect(optsSeen?.signal?.aborted).toBe(false);

    stopButton(view);
    expect(optsSeen?.signal?.aborted).toBe(true);
    await sending;

    expect(client.stop).toHaveBeenCalled();
    expect(runState(view)).toBe('idle');
    expect(sendButton(view).classList.contains('is-stop')).toBe(false);
  });

  it('handles a timeout as a terminal state and returns to idle', async () => {
    const client = makeClient(async () => result({ killReason: 'timeout' }));
    const { view } = buildView(client);
    await view.onOpen();

    await typeAndSend(view);

    expect(runState(view)).toBe('idle');
    expect(sendButton(view).classList.contains('is-stop')).toBe(false);
  });

  it('handles a non-zero exit and keeps the error visible', async () => {
    const client = makeClient(async () => result({ exitCode: 1, stderr: 'spawn failed hard' }));
    const { view, plugin } = buildView(client);
    await view.onOpen();

    await typeAndSend(view);

    expect(runState(view)).toBe('idle');
    expect(sendButton(view).classList.contains('is-stop')).toBe(false);
    expect(view.containerEl.textContent).toContain('spawn failed hard');
    expect((plugin.history as unknown as { addTurn: ReturnType<typeof vi.fn> }).addTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        exitCode: 1,
        error: 'spawn failed hard',
      }),
      expect.anything(),
    );
  });

  it('restores the composer when preparation fails (the stuck-Stop regression)', async () => {
    const client = makeClient(async () => result());
    const { view, plugin } = buildView(client, makeRunner({ detectBin: async () => null }));
    await view.onOpen();

    await typeAndSend(view);

    expect(client.run).not.toHaveBeenCalled();
    expect(runState(view)).toBe('idle');
    expect(sendButton(view).classList.contains('is-stop')).toBe(false);
    expect(view.containerEl.textContent).toContain('dsh');
    expect((plugin.history as unknown as { addTurn: ReturnType<typeof vi.fn> }).addTurn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('Preparation failed') }),
      expect.anything(),
    );
  });

  it('opens a change review after the run reports changed markdown', async () => {
    const files: Record<string, string> = { 'note.md': 'before' };
    const app = makeAppDouble();
    const vault = app.vault as unknown as {
      getMarkdownFiles: () => Array<{ path: string; stat: { size: number } }>;
      cachedRead: (file: { path: string }) => Promise<string>;
    };
    const file = { path: 'note.md', stat: { size: 6 } };
    vault.getMarkdownFiles = () => [file];
    vault.cachedRead = async (f) => files[f.path];

    const client = makeClient(async () => {
      files['note.md'] = 'after';
      return result();
    });
    const { view, plugin } = buildView(client, makeRunner(), app);
    await view.onOpen();

    await typeAndSend(view);
    await settle();

    expect(document.body.textContent).toContain('note.md');
    expect(document.body.textContent).toContain('- before');
    expect(document.body.textContent).toContain('+ after');
    expect(runState(view)).toBe('idle');
    expect((plugin.history as unknown as { updateTurn: ReturnType<typeof vi.fn> }).updateTurn).toHaveBeenCalledWith(
      expect.any(Number),
      { changedFiles: ['note.md'] },
    );
  });

  it('does not start a second run while one is active', async () => {
    let release: ((value: ResultLike) => void) | undefined;
    const client = makeClient(() => new Promise<ResultLike>((resolve) => { release = resolve; }));
    const { view } = buildView(client);
    await view.onOpen();

    const first = typeAndSend(view, 'first');
    await settle();
    await typeAndSend(view, 'second');

    expect(client.run).toHaveBeenCalledTimes(1);
    release?.(result());
    await first;
    expect(runState(view)).toBe('idle');
  });
});
