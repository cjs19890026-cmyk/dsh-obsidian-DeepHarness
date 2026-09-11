// @vitest-environment jsdom
/**
 * Regression tests for the chip editor: [[path]] memo chips inside the
 * contenteditable input, and the serialization contract it must keep
 * (see the header comment in chip-editor.ts).
 *
 * The Obsidian DOM helpers this file used to polyfill by hand now come from
 * the shared src/test-setup.ts (review E-1); jsdom's Selection is a stub, so
 * caret placement is still not asserted here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ChipEditor } from './chip-editor';

const PATH = '09AI教师赋能项目/需求痛点挖掘/车棍儿老师AI备课-评论区态度分析报告';

function makeApp() {
  return { workspace: { openLinkText: vi.fn() } } as unknown as import('obsidian').App;
}

function makeEditor(app: ReturnType<typeof makeApp>): ChipEditor {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new ChipEditor(container, app, { placeholder: '输入任务…' });
}

describe('chip-editor', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('serialization round-trips: chips → [[path]], text as-is', () => {
    const app = makeApp();
    const editor = makeEditor(app);
    editor.setText(`看这个 [[${PATH}]] 然后处理`);
    expect(editor.getText()).toBe(`看这个 [[${PATH}]] 然后处理`);
    expect(editor.el.querySelectorAll('.dsh-chip').length).toBe(1);
  });

  it('chip renders a label with the basename and is non-editable (atomic)', () => {
    const app = makeApp();
    const editor = makeEditor(app);
    editor.setText(`[[${PATH}]]`);
    const chip = editor.el.querySelector('.dsh-chip') as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute('contenteditable')).toBe('false');
    const label = chip.querySelector('.dsh-chip-label') as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.textContent).toBe('车棍儿老师AI备课-评论区态度分析报告');
    expect(chip.getAttribute('title')).toBe(PATH);
  });

  it('mousedown on a chip opens the note without placing a caret', () => {
    const app = makeApp();
    const editor = makeEditor(app);
    editor.setText(`[[${PATH}]]`);
    const chip = editor.el.querySelector('.dsh-chip') as HTMLElement;
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const prevented = !chip.dispatchEvent(evt); // dispatchEvent returns false when defaultPrevented
    expect(prevented).toBe(true);
    expect(app.workspace.openLinkText).toHaveBeenCalledWith(PATH, '');
  });

  it('@ token is visible through textBeforeCaret after typing', () => {
    const app = makeApp();
    const editor = makeEditor(app);
    editor.focus();
    const tn = document.createTextNode('@q');
    editor.el.appendChild(tn);
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(tn, 2);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    expect(editor.textBeforeCaret()).toBe('@q');
  });

  it('replaceRange after a chip keeps the [[path]] serialization', () => {
    const app = makeApp();
    const editor = makeEditor(app);
    editor.setText(`看这个 [[${PATH}]]`);
    editor.replaceRange(editor.textBeforeCaret().length, '@');
    expect(editor.getText()).toBe(`看这个 [[${PATH}]]@`);
  });
});
