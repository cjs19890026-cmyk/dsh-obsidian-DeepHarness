import type { App, TFile } from 'obsidian';

/**
 * Post-run change review.
 *
 * The headless agent has no interactive approval step, so the only honest
 * moment to show what it changed is after the run. We snapshot the vault's
 * Markdown files before spawning and compare afterwards; `undo` writes the
 * previous text back through the vault adapter.
 *
 * Listing goes through `vault.adapter` rather than `vault.getMarkdownFiles()`
 * because DSH writes outside Obsidian: the metadata cache may not have indexed
 * a brand-new note yet when the run ends, and the review would silently miss
 * it. The adapter reads the actual file on disk.
 *
 * This is deliberately Markdown-only: those are the files the plugin's
 * persona/memory workflow touches, and reading binary attachments into memory
 * would be both pointless and dangerous. `Harness/memory.md` is plugin-owned
 * continuity state, not a user note, so it is excluded from the review. The
 * caps keep a huge vault from turning every send into a full-vault read; when
 * the cap is hit the review is marked incomplete instead of silently pretending
 * nothing else changed.
 */
export interface ChangeSnapshot {
  files: Map<string, string>;
  /** Some files were skipped (size/count cap); the diff may be incomplete. */
  incomplete: boolean;
}

export interface VaultChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface SnapshotLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  /** Total bytes kept in memory; a 2,000 × 512 KB vault must not mean 1 GB. */
  maxTotalBytes?: number;
}

const INTERNAL_MEMORY_PATH = 'Harness/memory.md';

function hasHiddenSegment(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

function isReviewable(path: string): boolean {
  return path !== INTERNAL_MEMORY_PATH && !hasHiddenSegment(path);
}

/**
 * Enumerate Markdown paths. Prefer `adapter.list` (sees external writes
 * immediately); test doubles without it fall back to the vault index.
 */
async function listMarkdownPaths(
  app: App,
  maxFiles: number,
): Promise<{ paths: string[]; incomplete: boolean }> {
  const adapter = app.vault.adapter;
  if (typeof adapter.list === 'function') {
    const paths: string[] = [];
    let incomplete = false;
    const walk = async (dir: string): Promise<void> => {
      if (paths.length >= maxFiles) {
        incomplete = true;
        return;
      }
      let listed: { files: string[]; folders: string[] };
      try {
        listed = await adapter.list(dir);
      } catch {
        incomplete = true;
        return;
      }
      for (const file of listed.files) {
        if (!file.toLowerCase().endsWith('.md') || !isReviewable(file)) continue;
        if (paths.length >= maxFiles) {
          incomplete = true;
          return;
        }
        paths.push(file);
      }
      for (const folder of listed.folders) {
        if (hasHiddenSegment(folder)) continue;
        await walk(folder);
        if (paths.length >= maxFiles) {
          incomplete = true;
          return;
        }
      }
    };
    await walk('');
    return { paths, incomplete };
  }

  const all = app.vault.getMarkdownFiles().filter((file) => isReviewable(file.path));
  const paths = all.slice(0, maxFiles).map((file) => file.path);
  return { paths, incomplete: paths.length < all.length };
}

async function readMarkdown(
  app: App,
  path: string,
  file: TFile | undefined,
  maxFileBytes: number,
): Promise<string | null> {
  const adapter = app.vault.adapter;
  let size = file?.stat.size;
  if (size === undefined && typeof adapter.stat === 'function') {
    try {
      size = (await adapter.stat(path))?.size;
    } catch {
      // The file disappeared between listing and reading; treat as missing.
      return null;
    }
  }
  if (size !== undefined && size > maxFileBytes) return null;

  if (typeof adapter.read === 'function') return adapter.read(path);
  if (file && typeof app.vault.read === 'function') return app.vault.read(file);
  if (file) return app.vault.cachedRead(file);
  throw new Error(`Cannot read ${path}`);
}

/**
 * Read every reviewable Markdown file in the vault. Returned paths are
 * vault-relative, exactly the form `vault.adapter.write/remove` expects.
 */
export async function snapshotVault(
  app: App,
  limits: SnapshotLimits = {},
): Promise<ChangeSnapshot> {
  const maxFiles = limits.maxFiles ?? 2000;
  const maxFileBytes = limits.maxFileBytes ?? 512 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 64 * 1024 * 1024;
  const listed = await listMarkdownPaths(app, maxFiles);
  let incomplete = listed.incomplete;
  const byPath = new Map<string, TFile>(
    app.vault.getMarkdownFiles().map((file) => [file.path, file]),
  );

  const files = new Map<string, string>();
  let totalBytes = 0;
  const encoder = new TextEncoder();
  for (const path of listed.paths) {
    if (totalBytes >= maxTotalBytes) {
      incomplete = true;
      break;
    }
    try {
      const text = await readMarkdown(app, path, byPath.get(path), maxFileBytes);
      if (text === null) {
        incomplete = true;
        continue;
      }
      const bytes = encoder.encode(text).byteLength;
      if (totalBytes + bytes > maxTotalBytes) {
        incomplete = true;
        break;
      }
      totalBytes += bytes;
      files.set(path, text);
    } catch {
      incomplete = true;
    }
  }
  return { files, incomplete };
}

/** Compare two snapshots; created/deleted files use a null side. */
export function diffSnapshots(
  before: ChangeSnapshot,
  after: ChangeSnapshot,
): VaultChange[] {
  const changes: VaultChange[] = [];
  for (const [path, oldText] of before.files) {
    const newText = after.files.get(path);
    if (newText === undefined) {
      changes.push({ path, before: oldText, after: null });
    } else if (newText !== oldText) {
      changes.push({ path, before: oldText, after: newText });
    }
  }
  for (const [path, newText] of after.files) {
    if (!before.files.has(path)) {
      changes.push({ path, before: null, after: newText });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Restore one file to its pre-run state. Created files are removed; deleted
 * files are recreated; modified files get their old text back.
 */
export async function undoChange(app: App, change: VaultChange): Promise<void> {
  if (change.before === null) {
    await app.vault.adapter.remove(change.path);
    return;
  }
  await app.vault.adapter.write(change.path, change.before);
}

/**
 * A compact, readable representation of what changed: common prefix/suffix
 * with the changed middle marked `-` / `+`. Not a full Myers diff — the review
 * is meant to make the agent's edits legible, and a single contiguous hunk is
 * enough for the common "rewrote this paragraph" case.
 */
export function renderChangedRegion(before: string | null, after: string | null): string {
  if (before === null) return prefixLines(after ?? '', '+');
  if (after === null) return prefixLines(before, '-');

  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const contextStart = Math.max(0, start - 3);
  const lines: string[] = [];
  for (let i = contextStart; i < start; i++) lines.push(`  ${a[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`- ${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+ ${b[i]}`);
  // The common suffix is identical on both sides; emit it from `a`.
  for (let i = 1; i <= 3 && endA + i < a.length && endB + i < b.length; i++) {
    lines.push(`  ${a[endA + i]}`);
  }
  return lines.slice(0, 400).join('\n');
}

function prefixLines(text: string, marker: '+' | '-'): string {
  return text.split('\n').slice(0, 400).map((line) => `${marker} ${line}`).join('\n');
}
