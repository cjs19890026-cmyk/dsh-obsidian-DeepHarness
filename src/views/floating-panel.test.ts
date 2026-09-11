// @vitest-environment jsdom
/**
 * FloatingPanel mechanics, shared by the history and skills popups.
 *
 * These are the behaviours the pre-split chat-view.ts implemented inline, so
 * this file is the regression guard for that extraction (review C-1): anchoring
 * geometry, mutual exclusion, outside-click dismissal that must NOT fire for the
 * anchor itself, and Escape. The DOM helpers come from test/setup.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
  // The panels only use setIcon for decoration; jsdom needs no SVG.
  setIcon: vi.fn(),
}));

import { FloatingPanel } from './floating-panel';
import { HistoryPanel } from './history-panel';
import { SkillPanel } from './skill-panel';
import type { ChatView } from './chat-view';

function makeAnchor(id: string): HTMLElement {
  const btn = document.createElement('button');
  btn.id = id;
  // Deterministic geometry: the panel is positioned from this rect.
  btn.getBoundingClientRect = () => ({ right: 300, top: 500, width: 24, height: 24, left: 276, bottom: 524, x: 276, y: 500, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(btn);
  return btn;
}

function makeView(sessions: unknown[] = [], skills: unknown[] = []): ChatView {
  return {
    plugin: { history: { getSessions: () => sessions } },
    resumeSession: vi.fn(),
    scanSkills: () => skills,
    skillSourceLabel: () => 'plugin',
    insertTextAtCursor: vi.fn(),
    scrollToBottom: vi.fn(),
  } as unknown as ChatView;
}

/** The deferred outside-click listener needs a macrotask to be registered. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('FloatingPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    FloatingPanel.closeAll();
  });

  it('anchors the panel bottom-right against its icon, clamped to 8px', async () => {
    const anchor = makeAnchor('a');
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    const panel = new HistoryPanel(makeView(), anchor);

    panel.open();
    const el = document.querySelector('.dsh-history-panel') as HTMLElement;
    // right: window 400 - icon right 300 = 100
    expect(el.style.right).toBe('100px');
    // bottom: window 600 - icon top 500 + 4 = 104
    expect(el.style.bottom).toBe('104px');
  });

  it('keeps only one panel open at a time', async () => {
    const view = makeView();
    const history = new HistoryPanel(view, makeAnchor('h'));
    const skills = new SkillPanel(view, makeAnchor('s'));

    history.open();
    expect(document.querySelectorAll('.dsh-history-panel')).toHaveLength(1);
    skills.open();
    expect(document.querySelectorAll('.dsh-history-panel')).toHaveLength(1);
    expect(document.querySelector('.dsh-skill-panel')).toBeTruthy();
    expect(history.isOpen).toBe(false);
  });

  it('toggles shut when the same icon is used twice', () => {
    const history = new HistoryPanel(makeView(), makeAnchor('h'));
    history.toggle();
    expect(history.isOpen).toBe(true);
    history.toggle();
    expect(history.isOpen).toBe(false);
    expect(document.querySelector('.dsh-history-panel')).toBeNull();
  });

  it('closes on a click outside, but not on a click inside', async () => {
    const history = new HistoryPanel(makeView(), makeAnchor('h'));
    history.open();
    const el = document.querySelector('.dsh-history-panel') as HTMLElement;
    const inside = document.createElement('span');
    el.appendChild(inside);
    await flush();

    inside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(history.isOpen).toBe(true);

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(history.isOpen).toBe(false);
  });

  it('does not self-close when the anchor itself is clicked', async () => {
    // The dismiss handler must ignore the icon: the click that opens or
    // toggles the panel comes from there, and the old inline handlers had to
    // exempt it too — otherwise the icon's own click kills the panel.
    const anchor = makeAnchor('h');
    const history = new HistoryPanel(makeView(), anchor);
    history.open();
    await flush();

    anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(history.isOpen).toBe(true);
  });

  it('closes on Escape', () => {
    const history = new HistoryPanel(makeView(), makeAnchor('h'));
    history.open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(history.isOpen).toBe(false);
  });

  it('refresh() rebuilds an open panel and leaves a closed one alone', () => {
    const history = new HistoryPanel(makeView(), makeAnchor('h'));
    history.refresh();
    expect(document.querySelector('.dsh-history-panel')).toBeNull();

    history.open();
    history.refresh();
    expect(document.querySelectorAll('.dsh-history-panel')).toHaveLength(1);
  });

  it('closeAll() tears down every open panel (view teardown path)', () => {
    const view = makeView();
    const history = new HistoryPanel(view, makeAnchor('h'));
    const skills = new SkillPanel(view, makeAnchor('s'));
    history.open();
    FloatingPanel.closeAll();
    skills.open();
    FloatingPanel.closeAll();
    expect(document.querySelectorAll('.dsh-history-panel')).toHaveLength(0);
    expect(history.isOpen).toBe(false);
    expect(skills.isOpen).toBe(false);
  });
});

describe('panel contents', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    FloatingPanel.closeAll();
  });

  it('renders the empty state when there is no history', () => {
    const history = new HistoryPanel(makeView(), makeAnchor('h'));
    history.open();
    expect(document.querySelector('.dsh-history-empty')).toBeTruthy();
  });

  it('renders one row per archived session, with pin/rename/delete actions', () => {
    const sessions = [
      { id: 's1', title: 'First', endedAt: 0, pinned: false, note: '' },
      { id: 's2', title: 'Second', endedAt: 0, pinned: true, note: 'note' },
    ];
    const history = new HistoryPanel(makeView(sessions), makeAnchor('h'));
    history.open();
    const items = document.querySelectorAll('.dsh-history-panel-item');
    expect(items).toHaveLength(2);
    expect(items[1].classList.contains('is-pinned')).toBe(true);
    expect(document.querySelectorAll('.dsh-history-act').length).toBe(6); // 3 per row
  });

  it('resumes the session and closes when a row is clicked', () => {
    const view = makeView([{ id: 's1', title: 'First', endedAt: 0, pinned: false, note: '' }]);
    const history = new HistoryPanel(view, makeAnchor('h'));
    history.open();
    (document.querySelector('.dsh-history-panel-item') as HTMLElement).click();
    expect(view.resumeSession).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    expect(history.isOpen).toBe(false);
  });

  it('inserts "/name " and closes when a skill is clicked', () => {
    const view = makeView([], [{ name: 'obsidian', description: 'd', source: 'plugin' }]);
    const skills = new SkillPanel(view, makeAnchor('s'));
    skills.open();
    (document.querySelector('.dsh-skill-item') as HTMLElement).click();
    expect(view.insertTextAtCursor).toHaveBeenCalledWith('/obsidian ');
    expect(view.scrollToBottom).toHaveBeenCalled();
    expect(skills.isOpen).toBe(false);
  });
});
