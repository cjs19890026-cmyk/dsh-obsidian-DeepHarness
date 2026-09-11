import * as path from 'path';

/**
 * Single source of truth for where the plugin keeps its files on disk.
 *
 * Before this module the layout was spelled out inline in four places
 * (`dsh-runner.ts` ×3, `main.ts` history path, `settings.ts` diagnostics
 * targets). The plugin id folder name is a hard compatibility boundary, so a
 * layout change has to happen in exactly one place — that is what this module
 * is for, and it is the precondition for the planned "move dsh-home out of the
 * vault" work (see AI_CONTEXT.md 「已知待填坑」).
 *
 * **The paths below are fixed.** Both directories are already in use on
 * installed vaults, so this module must not change the resolved path, only
 * centralize how it is built. Moving dsh-home out of the vault is a separate
 * project that has to migrate the old trees.
 *
 * Obsidian-free on purpose: plain `path` only, so it unit-tests without a
 * vault and can be consumed from any layer.
 */
export interface PluginPaths {
  /** `<vault>/<configDir>/plugins/deepharness` */
  readonly pluginDir: string;
  /** Generated `--patch` overlays: persona (`vault.yml`), `stream-relay.js`. */
  readonly generatedDir: string;
  /** The plugin's isolated DSH_HOME (`settings.yaml`, `skills/`, …). */
  readonly dshHomeDir: string;
  /**
   * Absolute path of a file inside {@link generatedDir} — built for use as a
   * `--patch` argument, so it must stay absolute.
   */
  generatedFile(name: string): string;
  /**
   * Absolute path of a file inside {@link dshHomeDir} (e.g. `history.json`,
   * `settings.yaml`).
   */
  dshHomeFile(name: string): string;
}

/** The plugin id. Also the folder name under `<configDir>/plugins/`. */
export const PLUGIN_ID = 'deepharness';

/**
 * Build the plugin's path layout for one vault.
 *
 * @param vaultRoot absolute vault root (`getVaultRoot()`); when it is relative
 *   the result stays relative and resolves against the process cwd, which is
 *   the vault — the same behaviour the previous inline templates had.
 * @param configDir the vault-relative Obsidian config dir (`vault.configDir`,
 *   normally `.obsidian`).
 */
export function pluginPaths(vaultRoot: string, configDir: string): PluginPaths {
  const pluginDir = path.join(vaultRoot, configDir, 'plugins', PLUGIN_ID);
  const generatedDir = path.join(pluginDir, 'generated');
  const dshHomeDir = path.join(pluginDir, 'dsh-home');
  return {
    pluginDir,
    generatedDir,
    dshHomeDir,
    generatedFile: (name) => path.join(generatedDir, name),
    dshHomeFile: (name) => path.join(dshHomeDir, name),
  };
}
