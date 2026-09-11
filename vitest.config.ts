import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // The published `obsidian` package is types-only (`"main": ""`), so Vite
      // cannot resolve the specifier at all: importing any module that does
      // `import … from 'obsidian'` fails in import analysis, before
      // vi.mock('obsidian', …) can apply. Tests still mock it themselves.
      obsidian: fileURLToPath(new URL('./test/obsidian-stub.ts', import.meta.url)),
    },
  },
  test: {
    // Node is the default environment: nearly every test file is pure-function
    // or fs work. The single DOM test (src/chip-editor.test.ts) opts in with a
    // `// @vitest-environment jsdom` docblock — in vitest 4 that docblock, not
    // a config glob, is what selects jsdom (environmentMatchGlobs is gone):
    // verified by removing it, which turns those 5 tests into failures.
    environment: 'node',
    // Shared Obsidian DOM helpers for any DOM-backed test (review E-1); a
    // no-op under the Node environment. It lives in test/ rather than src/:
    // it is test-only infrastructure that never ships, and inside src/ the
    // Obsidian plugin ruleset would flag it for defining the very helpers it
    // provides (obsidianmd/prefer-create-el).
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
