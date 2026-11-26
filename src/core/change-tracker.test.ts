import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import {
  diffSnapshots,
  renderChangedRegion,
  snapshotVault,
  undoChange,
} from './change-tracker';

interface FakeFile {
  path: string;
  stat: { size: number };
}

function makeApp(initial: Record<string, string>, sizes: Record<string, number> = {}): {
  app: App;
  files: Record<string, string>;
  addFile: (path: string, text: string) => void;
  writes: Array<{ path: string; text: string }>;
  removed: string[];
} {
  const files = { ...initial };
  const writes: Array<{ path: string; text: string }> = [];
  const removed: string[] = [];
  const fileList: FakeFile[] = Object.keys(files).map((path) => ({
    path,
    stat: { size: sizes[path] ?? files[path].length },
  }));
  const addFile = (path: string, text: string): void => {
    files[path] = text;
    fileList.push({ path, stat: { size: text.length } });
  };
  const app = {
    vault: {
      getMarkdownFiles: () => fileList,
      cachedRead: async (file: FakeFile) => files[file.path],
      adapter: {
        list: async (dir: string) => {
          const prefix = dir ? `${dir}/` : '';
          const inDir = Object.keys(files).filter((path) => path.startsWith(prefix));
          const directFiles = inDir.filter((path) => !path.slice(prefix.length).includes('/'));
          const folders = new Set(
            inDir
              .filter((path) => path.slice(prefix.length).includes('/'))
              .map((path) => `${prefix}${path.slice(prefix.length).split('/')[0]}`),
          );
          return { files: directFiles, folders: [...folders] };
        },
        read: async (path: string) => files[path],
        write: async (path: string, text: string) => {
          writes.push({ path, text });
          files[path] = text;
        },
        remove: async (path: string) => {
          removed.push(path);
          delete files[path];
        },
      },
    },
  } as unknown as App;
  return { app, files, addFile, writes, removed };
}

describe('change-tracker', () => {
  it('snapshots markdown and diffs created/modified files', async () => {
    const { app, files, addFile } = makeApp({ 'a.md': 'old', 'b.md': 'keep' });
    const before = await snapshotVault(app);
    expect(before.incomplete).toBe(false);
    expect(before.files.get('a.md')).toBe('old');

    files['a.md'] = 'new';
    addFile('c.md', 'created');
    const after = await snapshotVault(app);
    const changes = diffSnapshots(before, after);
    expect(changes).toEqual([
      { path: 'a.md', before: 'old', after: 'new' },
      { path: 'c.md', before: null, after: 'created' },
    ]);
  });

  it('sees a note created outside the vault index and ignores internal memory', async () => {
    const { app, addFile } = makeApp({ 'a.md': 'old' });
    const before = await snapshotVault(app);
    addFile('new.md', 'created');
    addFile('Harness/memory.md', 'internal');
    const after = await snapshotVault(app);
    expect(diffSnapshots(before, after)).toEqual([
      { path: 'new.md', before: null, after: 'created' },
    ]);
  });

  it('marks oversized files incomplete and skips them', async () => {
    const { app } = makeApp({ 'big.md': 'x'.repeat(10) }, { 'big.md': 11 });
    const snap = await snapshotVault(app, { maxFileBytes: 10 });
    expect(snap.incomplete).toBe(true);
    expect(snap.files.has('big.md')).toBe(false);
  });

  it('undoes a modified file by writing the previous text', async () => {
    const { app, writes } = makeApp({ 'a.md': 'new' });
    await undoChange(app, { path: 'a.md', before: 'old', after: 'new' });
    expect(writes).toEqual([{ path: 'a.md', text: 'old' }]);
  });

  it('undoes a created file by removing it', async () => {
    const { app, removed } = makeApp({ 'a.md': 'new' });
    await undoChange(app, { path: 'a.md', before: null, after: 'new' });
    expect(removed).toEqual(['a.md']);
  });

  it('renders a changed region with context and +/- markers', () => {
    const before = 'one\ntwo\nthree';
    const after = 'one\nTWO\nthree';
    const diff = renderChangedRegion(before, after);
    expect(diff).toContain('  one');
    expect(diff).toContain('- two');
    expect(diff).toContain('+ TWO');
    expect(diff).toContain('  three');
  });

  it('renders all lines for created/deleted files', () => {
    expect(renderChangedRegion(null, 'a\nb')).toBe('+ a\n+ b');
    expect(renderChangedRegion('a\nb', null)).toBe('- a\n- b');
  });
});
