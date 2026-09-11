import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

/**
 * Single source of truth for where the plugin keeps its files on disk.
 *
 * Two locations matter:
 *
 * 1. **In the vault** — `<vault>/<configDir>/plugins/deepharness/`, holding the
 *    generated `--patch` overlays (persona, stream relay, skill dirs). Small
 *    text files the user may want to read or edit, and they must travel with
 *    the vault.
 * 2. **Outside the vault** — the plugin's DSH_HOME, under the user's own DSH
 *    directory (see `systemDshHomeDir`). It used to live inside the vault next
 *    to the plugin, which made DSH bootstrap 400+ symlinks (or, on Windows
 *    without symlink privileges, tens of thousands of real files) *inside a
 *    synced folder* — the iCloud/Windows hang users reported.
 *
 * Obsidian-free on purpose: plain `path`/`os`/`crypto` only, so it unit-tests
 * without a vault and can be consumed from any layer.
 */
export interface PluginPaths {
  /** `<vault>/<configDir>/plugins/deepharness` */
  readonly pluginDir: string;
  /** Generated `--patch` overlays: persona (`vault.yml`), `stream-relay.js`. */
  readonly generatedDir: string;
  /**
   * Absolute path of a file inside {@link generatedDir} — built for use as a
   * `--patch` argument, so it must stay absolute.
   */
  generatedFile(name: string): string;
  /**
   * The **legacy** in-vault DSH_HOME. Nothing writes here any more except the
   * one-time migration and the fallback used when the system location cannot be
   * prepared (see DshRunner.ensurePluginDshHome); it stays defined so old trees
   * can be found, migrated and rolled back to.
   */
  readonly dshHomeDir: string;
  /** Absolute path of a file inside the legacy in-vault DSH_HOME. */
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

/**
 * Stable per-vault folder name for the system DSH_HOME.
 *
 * Derived from the vault's absolute path so the same vault always maps to the
 * same directory (and two vaults never collide), with the basename kept as a
 * readable prefix for anyone browsing `~/.dsh/deepharness`. A hash rather than
 * the path itself because vault paths contain separators, spaces and non-ASCII
 * characters, and because DSH writes this directory into places that dislike
 * both.
 */
export function vaultKey(vaultRoot: string): string {
  const normalised = path.resolve(vaultRoot);
  const digest = crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16);
  // Sanitise the readable half: it is only a label, but it must not reintroduce
  // separators into the folder name.
  const label = path.basename(normalised).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'vault';
  return `${label}-${digest}`;
}

/**
 * The plugin's DSH_HOME, **outside the vault**: `~/.dsh/deepharness/<vaultKey>`.
 *
 * Living under the user's own DSH root means it is never inside a synced vault
 * folder, so DSH's bootstrap of the headless profile (400+ symlinks on macOS;
 * tens of thousands of real files on Windows without symlink privileges) cannot
 * be picked up by iCloud/OneDrive and stall the vault — the failure this whole
 * move exists to fix.
 *
 * @param userDshHome the user's real DSH root, i.e. `DshRunner.dshHome()`.
 */
export function systemDshHomeDir(vaultRoot: string, userDshHome: string): string {
  return path.join(userDshHome, PLUGIN_ID, vaultKey(vaultRoot));
}

/** Absolute path of a file inside {@link systemDshHomeDir}. */
export function systemDshHomeFile(vaultRoot: string, userDshHome: string, name: string): string {
  return path.join(systemDshHomeDir(vaultRoot, userDshHome), name);
}

/**
 * Resolve the user's real DSH root, expanding `~` and applying the default.
 *
 * Moved here from DshRunner so the plugin (which needs the same root to place
 * the history file) does not keep a second copy of this rule. An empty setting
 * means "the default `~/.dsh`".
 */
export function resolveUserDshHome(configured: string): string {
  const home = configured.trim() || '~/.dsh';
  if (home === '~/.dsh') return path.join(os.homedir(), '.dsh');
  return home.startsWith('~/') ? path.join(os.homedir(), home.slice(2)) : home;
}

/**
 * True when `child` is inside `parent` (or is `parent` itself).
 *
 * Compares resolved paths segment-wise, so `/vault-2` is not treated as being
 * inside `/vault`. Used as a guardrail: the plugin's DSH_HOME must never end up
 * inside the vault, because DSH bootstraps its profile there and a synced vault
 * would pick up hundreds (Windows without symlink support: tens of thousands) of
 * files.
 */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
