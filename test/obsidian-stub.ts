/**
 * Bundler stub for the `obsidian` package.
 *
 * The published `obsidian` package is types-only (`"main": ""`), so Vite cannot
 * resolve `import … from 'obsidian'` at all: a test that imports any module
 * doing so fails in import analysis *before* `vi.mock('obsidian', …)` can take
 * effect. vitest.config.ts aliases the specifier here so resolution succeeds;
 * each test that exercises such a module still mocks `obsidian` itself (see
 * src/floating-panel.test.ts).
 *
 * Deliberately minimal: these are placeholders for imports that are expected to
 * be mocked, not a DOM/Obsidian implementation. A test that forgets to mock
 * fails loudly rather than quietly asserting against a fake plugin API.
 */

function notImplemented(name: string): never {
  throw new Error(
    `obsidian.${name} is not available in tests — mock 'obsidian' in this test file.`,
  );
}

export class Notice {
  constructor(..._args: unknown[]) {
    notImplemented('Notice');
  }
}

export class Modal {
  constructor(..._args: unknown[]) {
    notImplemented('Modal');
  }
}

export class FuzzySuggestModal {
  constructor(..._args: unknown[]) {
    notImplemented('FuzzySuggestModal');
  }
}

export class ItemView {
  constructor(..._args: unknown[]) {
    notImplemented('ItemView');
  }
}

export class Plugin {
  constructor(..._args: unknown[]) {
    notImplemented('Plugin');
  }
}

export class PluginSettingTab {
  constructor(..._args: unknown[]) {
    notImplemented('PluginSettingTab');
  }
}

export class Setting {
  constructor(..._args: unknown[]) {
    notImplemented('Setting');
  }
}

export class Menu {
  constructor(..._args: unknown[]) {
    notImplemented('Menu');
  }
}

export class MarkdownView {
  constructor(..._args: unknown[]) {
    notImplemented('MarkdownView');
  }
}

export class TFile {
  constructor(..._args: unknown[]) {
    notImplemented('TFile');
  }
}

export class TFolder {
  constructor(..._args: unknown[]) {
    notImplemented('TFolder');
  }
}

export const Platform = {
  isMacOS: false,
  isWin: false,
  isLinux: true,
};

export const Keymap = {
  isModEvent: (): boolean => false,
};

export const MarkdownRenderer = {
  render: async (): Promise<void> => undefined,
};

export const requestUrl = async (): Promise<never> => notImplemented('requestUrl');

export const setIcon = (): void => undefined;
