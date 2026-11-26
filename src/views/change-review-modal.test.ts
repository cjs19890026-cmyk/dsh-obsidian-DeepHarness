// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeModal {
    contentEl = document.createElement('div');
    app: unknown;
    constructor(app: unknown) {
      this.app = app;
    }
    open(): void {
      document.body.appendChild(this.contentEl);
      (this as unknown as { onOpen(): void }).onOpen();
    }
    close(): void {
      (this as unknown as { onClose?(): void }).onClose?.();
      this.contentEl.remove();
    }
  }
  class FakeNotice {
    constructor(_message?: string, _timeout?: number) {}
  }
  return { ...actual, Modal: FakeModal, Notice: FakeNotice };
});

import type { App } from 'obsidian';
import { ChangeReviewModal } from './change-review-modal';

const app = {} as App;

describe('ChangeReviewModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('lists changes and does not undo without a click', () => {
    const onUndo = vi.fn(async () => {});
    const modal = new ChangeReviewModal(app, [
      { path: 'a.md', before: 'old', after: 'new' },
      { path: 'b.md', before: null, after: 'created' },
    ], false, onUndo);
    modal.open();

    expect(document.body.textContent).toContain('a.md');
    expect(document.body.textContent).toContain('b.md');
    expect(document.body.textContent).toContain('- old');
    expect(document.body.textContent).toContain('+ new');
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('undoes one file when its button is clicked', async () => {
    const onUndo = vi.fn(async () => {});
    const modal = new ChangeReviewModal(app, [
      { path: 'a.md', before: 'old', after: 'new' },
    ], false, onUndo);
    modal.open();

    const undo = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Undo this file')) as HTMLButtonElement;
    undo.click();
    await Promise.resolve();

    expect(onUndo).toHaveBeenCalledWith({ path: 'a.md', before: 'old', after: 'new' });
  });

  it('refuses to undo when the file changed after the run', async () => {
    const changedApp = {
      vault: { adapter: { read: async () => 'user edited this' } },
    } as unknown as App;
    const onUndo = vi.fn(async () => {});
    const modal = new ChangeReviewModal(changedApp, [
      { path: 'a.md', before: 'old', after: 'new' },
    ], false, onUndo);
    modal.open();

    const undo = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Undo this file')) as HTMLButtonElement;
    undo.click();
    await Promise.resolve();

    expect(onUndo).not.toHaveBeenCalled();
  });

  it('shows the incomplete warning', () => {
    const modal = new ChangeReviewModal(app, [
      { path: 'a.md', before: 'old', after: 'new' },
    ], true, async () => {});
    modal.open();
    expect(document.body.textContent).toContain('may be incomplete');
  });
});
