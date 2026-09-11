/**
 * Shared vitest setup (see vitest.config.ts).
 *
 * jsdom implements the DOM but not Obsidian's DOM sugar, which the plugin's
 * UI code calls on plain elements (`container.createDiv({ cls, text })`,
 * `el.empty()`, `el.toggleClass()`, …). Any test that exercises a view —
 * chip-editor today, the panels and renderers after the phase-2 split —
 * needs these on `HTMLElement.prototype`.
 *
 * Only the handful of helpers the source actually calls is implemented, and
 * the class/attr contract mirrors Obsidian's:
 *   - `cls` accepts a space-separated string (that is how the source uses it)
 *   - `text` sets textContent, so it stays inert markup
 *   - `attr` sets attributes
 *   - `createEl`/`createDiv`/`createSpan` append to the receiver
 *
 * It also installs the detached-element `createDiv` / `createSpan` globals on
 * the window, because the plugin calls those bare (`chip-editor.ts`).
 *
 * Everything is defined once here instead of being copy-pasted into each DOM
 * test file (review E-1).
 *
 * This is test-only infrastructure — nothing in `src/` imports it — so it sits
 * outside the plugin source tree: inside `src/` the Obsidian ruleset flags the
 * file for building elements with the native DOM API, which is exactly its job
 * (obsidianmd/prefer-create-el, and `obsidianmd/*` cannot be disabled at all:
 * it is listed in eslint-comments/no-restricted-disable).
 *
 * The whole body is a no-op outside a DOM environment. Node is the default
 * environment and most test files are pure functions and fs work; patching a
 * jsdom that a later test file will get would be wrong anyway.
 */

export interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
}

/**
 * Apply Obsidian's element options.
 */
function applyInfo(el: HTMLElement, info?: DomElementInfo): void {
  if (!info) return;
  if (info.cls) {
    const classes = Array.isArray(info.cls) ? info.cls : [info.cls];
    el.className = classes.join(' ');
  }
  if (info.text !== undefined) {
    if (typeof info.text === 'string') el.textContent = info.text;
    else el.appendChild(info.text);
  }
  if (info.attr) {
    for (const [key, value] of Object.entries(info.attr)) {
      if (value === null) continue;
      el.setAttribute(key, String(value));
    }
  }
}

function installObsidianDomHelpers(): void {
  /** Obsidian installs its helpers on the HTML *and* SVG element prototypes
   *  (an SVG element created by createSvg has to be able to createSvg in turn),
   *  so every helper is defined on both. */
  const define = (name: string, value: unknown): void => {
    for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
      if (name in proto) continue;
      Object.defineProperty(proto, name, {
        value,
        writable: true,
        configurable: true,
      });
    }
  };

  define('createEl', function createEl(
    this: HTMLElement,
    tag: string,
    info?: DomElementInfo,
  ): HTMLElement {
    const el = document.createElement(tag);
    applyInfo(el, info);
    this.appendChild(el);
    return el;
  });

  /** SVG variant: jsdom needs createElementNS, and the element must land in
   *  the SVG namespace or it renders as an unknown HTML element. */
  define('createSvg', function createSvg(
    this: HTMLElement,
    tag: string,
    info?: DomElementInfo,
  ): SVGElement {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    applyInfo(el as unknown as HTMLElement, info);
    this.appendChild(el);
    return el;
  });

  define('createDiv', function createDiv(
    this: HTMLElement,
    info?: DomElementInfo,
  ): HTMLElement {
    const el = document.createElement('div');
    applyInfo(el, info);
    this.appendChild(el);
    return el;
  });

  define('createSpan', function createSpan(
    this: HTMLElement,
    info?: DomElementInfo,
  ): HTMLElement {
    const el = document.createElement('span');
    applyInfo(el, info);
    this.appendChild(el);
    return el;
  });

  define('empty', function empty(this: HTMLElement): void {
    this.innerHTML = '';
  });

  define('setText', function setText(this: HTMLElement, text: string): void {
    this.textContent = text;
  });

  define('addClass', function addClass(this: HTMLElement, ...classes: string[]): void {
    this.classList.add(...classes);
  });

  define('removeClass', function removeClass(this: HTMLElement, ...classes: string[]): void {
    this.classList.remove(...classes);
  });

  define('toggleClass', function toggleClass(
    this: HTMLElement,
    cls: string,
    on: boolean,
  ): void {
    this.classList.toggle(cls, on);
  });

  define('setAttr', function setAttr(this: HTMLElement, key: string, value: string): void {
    this.setAttribute(key, value);
  });

  // Obsidian also exposes detached-element factories as *globals*, and the
  // plugin source calls them bare (`chip-editor.ts`: `createSpan({ cls })`), so
  // the sandbox has to provide them. They hang off the window, matching how
  // Obsidian actually installs them.
  const win = window as unknown as Record<string, unknown>;
  if (typeof win.createDiv !== 'function') {
    win.createDiv = (info?: DomElementInfo): HTMLElement => {
      const el = document.createElement('div');
      applyInfo(el, info);
      return el;
    };
  }
  if (typeof win.createSpan !== 'function') {
    win.createSpan = (info?: DomElementInfo): HTMLElement => {
      const el = document.createElement('span');
      applyInfo(el, info);
      return el;
    };
  }
}

// `typeof` guards rather than bare references: this module is also loaded for
// Node-environment test files, where neither global exists.
if (typeof HTMLElement !== 'undefined' && typeof window !== 'undefined') {
  installObsidianDomHelpers();
}
