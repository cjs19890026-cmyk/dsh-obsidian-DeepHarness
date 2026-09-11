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
  const doubles = await import('../test/obsidian-view-double');
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
import { appSlot, makeAppDouble, makePluginDouble } from '../test/obsidian-view-double';

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
