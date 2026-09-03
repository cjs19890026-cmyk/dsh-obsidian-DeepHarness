import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { App } from 'obsidian';

// history.ts imports Obsidian runtime classes. The npm `obsidian` package is
// types-only in Node, so stub the classes used at module-evaluation time.
vi.mock('obsidian', () => ({
  App: class {},
  Notice: class {},
}));

import { HistoryStore } from './history';
import type { HistoryTurn, SessionRecord } from './history';

const HISTORY_FILE = 'history.json';

let tmp: string;
let absPath: string;

function makeApp(base: string): App {
  return {
    vault: {
      adapter: {
        getBasePath: () => base,
      },
    },
  } as unknown as App;
}

function makeHistory(limit: number): HistoryStore {
  return new HistoryStore(makeApp(tmp), HISTORY_FILE, limit);
}

function makeTurn(user: string, ts: number): HistoryTurn {
  return {
    ts,
    user,
    answer: `answer for ${user}`,
    durationMs: 1,
  };
}

function makeMeta(): { model: string; effort: string; permission: string } {
  return {
    model: 'model-a',
    effort: 'high',
    permission: 'full',
  };
}

async function addAndEnd(store: HistoryStore, user: string, ts: number): Promise<SessionRecord> {
  await store.addTurn(makeTurn(user, ts), makeMeta());
  await store.endSession();
  const archived = store.getSessions().find((s) => s.turns[0]?.user === user);
  if (!archived) throw new Error(`session not found for ${user}`);
  return archived;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepharness-history-'));
  absPath = path.join(tmp, HISTORY_FILE);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('HistoryStore', () => {
  it('loads an existing history file and archives an interrupted current session', async () => {
    const oldSession: SessionRecord = {
      id: 's1',
      title: 'Finished task',
      startedAt: 1,
      endedAt: 2,
      model: 'model-a',
      effort: 'high',
      permission: 'full',
      turns: [makeTurn('old', 1)],
      pinned: false,
      note: 'old note',
    };
    const interrupted: SessionRecord = {
      id: 'interrupted-1',
      title: 'Interrupted task',
      startedAt: 3,
      endedAt: 3,
      model: 'model-a',
      effort: 'high',
      permission: 'full',
      turns: [makeTurn('interrupted', 3)],
      pinned: false,
      note: '',
    };
    fs.writeFileSync(
      absPath,
      JSON.stringify({ sessions: [oldSession], current: interrupted }, null, 2),
      'utf8',
    );

    const store = makeHistory(10);
    await store.load();

    expect(store.getCurrentSession().turns).toEqual([]);
    const sessions = store.getSessions();
    expect(sessions.map((s) => s.id).sort()).toEqual(['interrupted-1', 's1']);
    expect(sessions.find((s) => s.id === 's1')?.note).toBe('old note');
  });

  it('does not fail when the history file is absent', async () => {
    const store = makeHistory(10);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.getSessions()).toEqual([]);
    expect(store.getCurrentSession().turns).toEqual([]);
  });

  it('addTurn appends to the current session, sets first-turn metadata, and persists', async () => {
    const store = makeHistory(10);
    await store.load();

    const turn = makeTurn('First question', 123456);
    await store.addTurn(turn, { model: 'model-x', effort: 'max', permission: 'workspace-write' });

    const current = store.getCurrentSession();
    expect(current.turns).toEqual([turn]);
    expect(current.title).toBe('First question');
    expect(current.startedAt).toBe(123456);
    expect(current.endedAt).toBe(123456);
    expect(current.model).toBe('model-x');
    expect(current.effort).toBe('max');
    expect(current.permission).toBe('workspace-write');

    const persisted = JSON.parse(fs.readFileSync(absPath, 'utf8')) as { current?: SessionRecord };
    const persistedCurrent = persisted.current!;
    expect(persistedCurrent.turns).toEqual([turn]);
    expect(persistedCurrent).toMatchObject({
      id: current.id,
      title: 'First question',
      model: 'model-x',
      effort: 'max',
      permission: 'workspace-write',
    });
  });

  it('trims non-pinned sessions over the limit and keeps the newest ones', async () => {
    const store = makeHistory(2);
    await store.load();

    const first = await addAndEnd(store, 'first', 1);
    const second = await addAndEnd(store, 'second', 2);
    expect(store.getSessions()).toHaveLength(2);

    // Pin the oldest session, then add a third; the unpinned middle one should
    // be dropped while the pinned oldest one survives the trim.
    await store.togglePin(first.id);
    await addAndEnd(store, 'third', 3);

    const ids = store.getSessions().map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(first.id);
    expect(ids).not.toContain(second.id);
    // A pinned session is kept even when over the non-pinned room.
    expect(ids[0]).toBe(first.id);
  });
});

describe('HistoryStore pin sorting and persistence', () => {
  it('pins sort above newer unpinned sessions and are persisted to disk', async () => {
    const store = makeHistory(10);
    await store.load();

    const first = await addAndEnd(store, 'first', 1);
    const second = await addAndEnd(store, 'second', 2);
    expect(store.getSessions().map((s) => s.id)).toEqual([second.id, first.id]);

    await store.togglePin(first.id);

    const sorted = store.getSessions();
    expect(sorted[0].id).toBe(first.id);
    expect(sorted[0].pinned).toBe(true);
    expect(sorted[1].id).toBe(second.id);

    const persisted = JSON.parse(fs.readFileSync(absPath, 'utf8')) as { sessions: SessionRecord[] };
    const persistedFirst = persisted.sessions.find((s) => s.id === first.id);
    expect(persistedFirst?.pinned).toBe(true);
  });
});

describe('HistoryStore atomic write', () => {
  it('persists without leaving a .tmp file behind', async () => {
    const store = makeHistory(10);
    await store.load();
    await store.addTurn(makeTurn('atomic', 99), makeMeta());
    await store.endSession();

    expect(fs.existsSync(absPath)).toBe(true);
    expect(fs.existsSync(`${absPath}.tmp`)).toBe(false);
    expect(() => JSON.parse(fs.readFileSync(absPath, 'utf8'))).not.toThrow();
  });
});
