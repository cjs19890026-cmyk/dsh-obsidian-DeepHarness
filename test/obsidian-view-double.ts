/**
 * Minimal Obsidian doubles for view tests (used with `vi.mock('obsidian', …)`).
 *
 * Testing a real view (`ChatView`) needs three things the `obsidian` package
 * cannot provide, since it ships types only:
 *  - an `ItemView` base whose `containerEl` has the real two-child shape
 *    (`children[0]` = title bar, `children[1]` = content container),
 *  - `this.app` pointing at the test's app stub,
 *  - the lifecycle hooks the view calls (registerEvent, addAction, …).
 *
 * `test/setup.ts` already provides the Obsidian DOM helpers
 * (createDiv/createEl/createSvg/…) on the element prototypes; this file only
 * covers the class surface.
 */

interface ViewLike {
  containerEl: HTMLElement;
  app: unknown;
}

/**
 * Fake `ItemView`. The app stub is passed through a mutable slot so the mock
 * factory (which is hoisted above the test body) can be written without
 * capturing test-local variables.
 */
export const appSlot: { current: unknown } = { current: undefined };

export class FakeItemView implements ViewLike {
  containerEl: HTMLElement;
  app: unknown;
  private readonly events: unknown[] = [];

  constructor(_leaf?: unknown) {
    if (typeof document === 'undefined') {
      // Guard the mistake explicitly: this double builds real DOM nodes, so
      // importing it from a Node-environment test fails confusingly otherwise.
      throw new Error(
        'obsidian-view-double needs jsdom: add `// @vitest-environment jsdom` to the test file.',
      );
    }
    const outer = document.createElement('div');
    outer.appendChild(document.createElement('div')); // title bar
    outer.appendChild(document.createElement('div')); // content container
    this.containerEl = outer;
    this.app = appSlot.current;
  }

  addAction(): void {}
  registerEvent(event: unknown): void {
    this.events.push(event);
  }
  registerDomEvent(): void {}
  registerInterval(): number {
    return 0;
  }
  register(): void {}
}

/** `WorkspaceLeaf` stand-in: the view is created by the test, not by Obsidian. */
export class FakeWorkspaceLeaf {}

export class FakeNotice {
  constructor(..._args: unknown[]) {}
}

export class FakeMenu {
  addItem(): this {
    return this;
  }
  showAtMouseEvent(): void {}
}

export class FakeMarkdownView {
  editor = { getSelection: () => '' };
}

/** A workspace/app stub with the surface a view actually touches. */
export function makeAppDouble(vaultRoot = '/tmp/dsh-vault') {
  const vault = {
    configDir: '.obsidian',
    getName: () => 'vault',
    getBasePath: () => vaultRoot,
    adapter: { getBasePath: () => vaultRoot },
    on: () => ({}),
    cachedRead: async () => '',
    getAbstractFileByPath: () => null,
    getMarkdownFiles: () => [],
  };
  const workspace = {
    on: () => ({}),
    onLayoutReady: (cb: () => void) => cb(),
    onActiveLeafChange: () => ({}),
    getActiveFile: () => null,
    getLeavesOfType: () => [],
    getActiveViewOfType: () => null,
    activeLeaf: null,
    setActiveLeaf: () => {},
  };
  return { vault, workspace };
}

/** A plugin stub carrying the fields ChatView reads. */
export function makePluginDouble(app: ReturnType<typeof makeAppDouble>) {
  return {
    app,
    manifest: { version: '0.0.0-test' },
    settings: {
      historyLimit: 20,
      model: 'deepseek-flash',
      provider: 'deepseek-official',
      reasoningEffort: 'high',
      permissionMode: 'workspace-write',
      toolExecutionMode: '',
      customPersona: '',
      extraSkillDirs: '',
      apiKey: '',
      dshBin: '',
      nodeBin: '',
      dshHome: '',
      workdir: '',
      timeoutSec: 600,
      language: 'en',
    },
    history: {
      getSessions: () => [],
      currentSession: () => ({ turns: [] }),
      endSession: async () => {},
    },
    getVaultRoot: () => (app.vault.adapter as { getBasePath: () => string }).getBasePath(),
    registerChatView: () => {},
    unregisterChatView: () => {},
    onSettingsChange: () => () => {},
    onLocaleChange: () => () => {},
  };
}
