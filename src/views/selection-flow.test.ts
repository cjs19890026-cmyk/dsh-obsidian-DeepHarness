// @vitest-environment jsdom
/**
 * Selection action flow: command payload -> prompt -> preview -> explicit apply.
 *
 * The command itself lives in `main.ts` (editor range capture); this test
 * covers the view half: the run request, the preview gating, and the fact that
 * nothing is applied until the user presses Replace / Insert below.
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

function result(overrides: Record<string, unknown> = {}) {
  return { exitCode: 0, stdout: 'REWRITTEN TEXT', stderr: '', durationMs: 1, killReason: null, ...overrides };
}

function makeRunner() {
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
  };
}

function buildView(run: (task: string) => Promise<unknown>) {
  const app = makeAppDouble();
  appSlot.current = app;
  const plugin = makePluginDouble(app);
  (plugin.history as unknown as Record<string, unknown>).addTurn = vi.fn(async () => {});
  const client = { run: vi.fn(run), stop: vi.fn(), dispose: vi.fn() };
  const view = new ChatView({} as never, plugin as never, {
    client: client as unknown as ChatViewDeps['client'],
    runner: makeRunner() as unknown as ChatViewDeps['runner'],
  });
  return { view, client };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('selection action preview', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    appSlot.current = undefined;
  });

  it('sends the selected text, then applies only after Replace is clicked', async () => {
    const apply = vi.fn(() => true);
    const { view, client } = buildView(async () => result());
    await view.onOpen();

    view.beginSelectionAction({
      action: 'rewrite',
      original: 'ORIGINAL_SELECTION',
      apply,
    });
    await settle();

    const task = client.run.mock.calls[0][0] as string;
    expect(task).toContain('ORIGINAL_SELECTION');
    expect(task).toContain('Rewrite the selected text');

    // The preview is open, but nothing has been written yet.
    const resultPre = document.querySelector('.dsh-selection-preview-result');
    expect(resultPre?.textContent).toBe('REWRITTEN TEXT');
    expect(apply).not.toHaveBeenCalled();

    const replace = document.querySelector('.dsh-modal-buttons .mod-cta') as HTMLButtonElement;
    replace.click();

    expect(apply).toHaveBeenCalledWith('REWRITTEN TEXT', 'replace');
    expect(document.querySelector('.dsh-selection-preview-result')).toBeNull();
  });

  it('does not open a preview when the run fails', async () => {
    const apply = vi.fn(() => true);
    const { view } = buildView(async () => result({ exitCode: 1, stderr: 'boom' }));
    await view.onOpen();

    view.beginSelectionAction({
      action: 'summarize',
      original: 'ORIGINAL_SELECTION',
      apply,
    });
    await settle();

    expect(document.querySelector('.dsh-selection-preview-result')).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it('strips a single outer code fence from the model answer', async () => {
    const apply = vi.fn(() => true);
    const { view } = buildView(async () => result({ stdout: '```markdown\nCLEAN RESULT\n```' }));
    await view.onOpen();

    view.beginSelectionAction({ action: 'explain', original: 'X', apply });
    await settle();

    expect(document.querySelector('.dsh-selection-preview-result')?.textContent).toBe('CLEAN RESULT');
  });
});
