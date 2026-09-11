import * as fs from 'fs';
import * as path from 'path';

/**
 * Environment-check reporting and the copy-paste repair request.
 *
 * Kept Obsidian-free so all of it can be unit-tested in Node. The settings
 * page renders the report; this module decides what a failure *means*, what
 * text a user can hand to someone (or something) that can fix it, and — see
 * `checkWritableDir` / `checkWritableFile` at the bottom — performs the write
 * probes. Those two used to live in settings.ts, where being tangled up with
 * the settings UI meant they had no tests at all.
 *
 * SECURITY: `DiagnosticContext` deliberately has no API-key field, and
 * `buildRepairPrompt` can only serialise what is in that type. The prompt is
 * shown in a preview before copying, but the structural guarantee is what
 * actually keeps a credential out of it — a preview can be clicked through,
 * a missing field cannot leak.
 */

/** The checkable environment surfaces, in report order. */
export type CheckId = 'dsh' | 'node' | 'generatedDir' | 'pluginHome' | 'settingsYaml';

/** i18n keys for a check's name, and for "what to do about it". */
export const CHECK_LABEL_KEYS: Record<CheckId, string> = {
  dsh: 'settings.check.item.dsh',
  node: 'settings.check.item.node',
  generatedDir: 'settings.check.generatedDir',
  pluginHome: 'settings.check.dshHomeDir',
  settingsYaml: 'settings.check.settingsYaml',
};

/**
 * The remedy shown under a failing check. Only failures carry one — an
 * advisory attached to a passing check is noise.
 */
export const CHECK_HINT_KEYS: Partial<Record<CheckId, string>> = {
  dsh: 'settings.check.hint.dsh',
  node: 'settings.check.hint.node',
  generatedDir: 'settings.check.hint.writeDir',
  pluginHome: 'settings.check.hint.writeDir',
  settingsYaml: 'settings.check.hint.writeFile',
};

/**
 * One check's result.
 *
 * `detail` and `error` are machine values (a path, a version, an errno
 * message) and are never localized: translating an error message would make it
 * unsearchable and, worse, would stop it matching what the user sees in a
 * terminal.
 */
export interface CheckOutcome {
  id: CheckId;
  ok: boolean;
  /** Path or version string — shown verbatim. */
  detail: string;
  /** Raw error text, only when `ok` is false. */
  error?: string;
}

/**
 * Everything the repair prompt is allowed to disclose.
 *
 * Local absolute paths belong here: the user is choosing to hand this text to
 * an assistant, and a diagnosis of a path problem is useless without the path.
 */
export interface DiagnosticContext {
  pluginVersion: string;
  vaultRoot: string;
  configDir: string;
  dshHome: string;
  platform: string;
  arch: string;
  nodeVersion: string;
}

/** True when at least one check failed. */
export function hasFailures(outcomes: readonly CheckOutcome[]): boolean {
  return outcomes.some((o) => !o.ok);
}

/** The failing outcomes, in report order. */
export function failures(outcomes: readonly CheckOutcome[]): CheckOutcome[] {
  return outcomes.filter((o) => !o.ok);
}

/**
 * Build the text a user pastes into an AI assistant or the DSH desktop app.
 *
 * Written to be **self-contained on purpose**: the most common failure is that
 * `dsh` itself is missing, in which case the plugin cannot run and therefore
 * cannot be the thing that fixes it. The prompt must never assume this plugin
 * or DSH works.
 *
 * It asks for a diagnosis and concrete steps rather than "fix it", because
 * several realistic causes are outside anyone's reach from a chat window — a
 * vault inside an iCloud/OneDrive sync folder, an MDM policy, a read-only
 * mount. Over-promising a one-shot repair would just move the frustration one
 * step later.
 */
export function buildRepairPrompt(
  outcomes: readonly CheckOutcome[],
  ctx: DiagnosticContext,
): string {
  const bad = failures(outcomes);
  const lines: string[] = [];

  lines.push('[DeepHarness environment check — please help me diagnose this]');
  lines.push('');
  lines.push('## What this is');
  lines.push('DeepHarness is an Obsidian plugin that drives the DeepSeek Harness CLI (`dsh`).');
  lines.push('Its built-in environment check reports the problems listed below.');
  lines.push('Please tell me the likely cause of each failure and the exact steps to fix it.');
  lines.push('If a cause is not fixable from a chat window, say so plainly instead of guessing.');
  lines.push('');
  lines.push('## Failing checks');
  if (bad.length === 0) {
    lines.push('(none — all checks passed; this report was copied anyway)');
  } else {
    for (const o of bad) {
      lines.push(`- ${o.id}: ${o.detail}`);
      if (o.error) lines.push(`  error: ${o.error}`);
    }
  }
  lines.push('');
  lines.push('## All checks');
  for (const o of outcomes) {
    lines.push(`- [${o.ok ? 'ok' : 'FAIL'}] ${o.id}: ${o.detail}${o.error ? ` — ${o.error}` : ''}`);
  }
  lines.push('');
  lines.push('## Environment');
  lines.push(`- plugin version: ${ctx.pluginVersion}`);
  lines.push(`- OS / arch: ${ctx.platform} / ${ctx.arch}`);
  lines.push(`- Node.js: ${ctx.nodeVersion}`);
  lines.push(`- Obsidian config dir (vault-relative): ${ctx.configDir}`);
  lines.push(`- vault root: ${ctx.vaultRoot}`);
  lines.push(`- configured DSH_HOME: ${ctx.dshHome}`);
  lines.push('- checks are: dsh binary present, Node.js present, and whether the plugin');
  lines.push('  can write the three paths it generates inside the vault.');
  lines.push('');
  lines.push('## What I have already tried');
  lines.push('(add anything you tried here)');

  return lines.join('\n');
}

/** What `DshRunner.diagnose()` reports, narrowed to what the checks consume. */
export interface DshProbe {
  found: boolean;
  bin: string;
  version: string | null;
  error: string | null;
  nodeBin: string | null;
}

/** One write probe: `error` is null when the path is writable. */
export interface WriteProbe {
  id: Extract<CheckId, 'generatedDir' | 'pluginHome' | 'settingsYaml'>;
  path: string;
  error: string | null;
}

/**
 * Turn raw probes into the reported outcomes.
 *
 * Extracted from the settings page so the branching is testable: a binary that
 * exists but cannot run is a failure, not a pass, and that distinction is the
 * difference between "your dsh is fine" and "your dsh is there but broken" —
 * which are very different instructions to give a user.
 */
export function buildCheckOutcomes(
  dsh: DshProbe,
  writes: readonly WriteProbe[],
  labels: { missingDsh: string; missingNode: string },
): CheckOutcome[] {
  const dshOutcome: CheckOutcome = !dsh.found
    ? { id: 'dsh', ok: false, detail: '', error: labels.missingDsh }
    : dsh.version
      // `dsh --version` succeeding is the cheapest proof the binary is
      // actually runnable, which is what this check is really asking.
      ? { id: 'dsh', ok: true, detail: `${dsh.bin} · ${dsh.version}` }
      : { id: 'dsh', ok: false, detail: dsh.bin, error: dsh.error ?? '' };

  const nodeOutcome: CheckOutcome = dsh.nodeBin
    ? { id: 'node', ok: true, detail: dsh.nodeBin }
    : { id: 'node', ok: false, detail: '', error: labels.missingNode };

  return [
    dshOutcome,
    nodeOutcome,
    ...writes.map((w): CheckOutcome => ({
      id: w.id,
      ok: w.error === null,
      detail: w.path,
      ...(w.error === null ? {} : { error: w.error }),
    })),
  ];
}

/** Return an error message when a directory cannot be created/written. */
export function checkWritableDir(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.deepharness-write-test-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Return an error message when an existing file cannot be opened for writing.
 *  A missing settings.yaml is allowed if its parent directory is writable. */
export function checkWritableFile(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return checkWritableDir(path.dirname(file));
    const fd = fs.openSync(file, 'r+');
    fs.closeSync(fd);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
