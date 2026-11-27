// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeModal {
    contentEl = document.createElement('div');
    titleEl = document.createElement('h2');
    app: unknown;
    constructor(_app: unknown) {
      this.app = _app;
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
  return { ...actual, Modal: FakeModal, Notice: FakeNotice, setIcon: vi.fn() };
});

import type { App } from 'obsidian';
import { BatchNotesModal, BatchProgressModal } from './batch-modal';
import type { BatchItem } from '../core/batch-controller';

const app = {
  vault: {
    getMarkdownFiles: () => [{ path: 'a.md' }, { path: 'b.md' }],
  },
} as unknown as App;

function buttons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('BatchNotesModal', () => {
  it('submits selected notes and the instruction', () => {
    const onSubmit = vi.fn();
    new BatchNotesModal(app, onSubmit).open();

    const boxes = Array.from(document.querySelectorAll('.dsh-batch-note input')) as HTMLInputElement[];
    boxes[0].click();
    boxes[1].click();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'add tags';
    textarea.dispatchEvent(new Event('input'));
    buttons().find((b) => b.textContent === 'Start batch')!.click();

    expect(onSubmit).toHaveBeenCalledWith(['a.md', 'b.md'], 'add tags');
  });

  it('refuses to start with no selection', () => {
    const onSubmit = vi.fn();
    new BatchNotesModal(app, onSubmit).open();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'do things';
    textarea.dispatchEvent(new Event('input'));
    buttons().find((b) => b.textContent === 'Start batch')!.click();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('BatchProgressModal', () => {
  const items: BatchItem[] = [
    { path: 'a.md', status: 'succeeded', answer: 'ok', durationMs: 3 },
    { path: 'b.md', status: 'failed', error: 'boom', durationMs: 1 },
  ];

  it('renders item states and finishes without cancelling', () => {
    const onCancel = vi.fn();
    const modal = new BatchProgressModal(app, onCancel);
    modal.open();
    modal.update(items);
    expect(document.body.textContent).toContain('a.md');
    expect(document.body.textContent).toContain('boom');

    modal.finish({ items, cancelled: false }, 2);
    expect(document.body.textContent).toContain('Batch finished');
    buttons().find((b) => b.textContent === 'Close')!.click();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels when the dialog is closed while running', () => {
    const onCancel = vi.fn();
    const modal = new BatchProgressModal(app, onCancel);
    modal.open();
    modal.close();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
