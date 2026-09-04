import { App, Notice } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { t } from './i18n';

/**
 * Session-based history: completed conversations are archived as session
 * records (a session = the turns since the last "clear conversation").
 * The in-progress (current) session is also persisted after every turn, and
 * every write is atomic (tmp file + rename) and serialized through a promise
 * chain, so a crash / quit never loses work or corrupts the file.
 */

export interface HistoryTool {
  name: string;
  args: string;
  ok: boolean;
  summary?: string;
}

export interface HistoryTurn {
  ts: number;
  user: string;
  answer: string;
  thinking?: string;
  tools?: HistoryTool[];
  durationMs: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  model: string;
  effort: string;
  permission: string;
  turns: HistoryTurn[];
  /** Pinned sessions always sort above the rest. */
  pinned: boolean;
  /** User-editable note shown under the title. */
  note: string;
}

function newId(): string {
  return crypto.randomUUID();
}

function titleFromTurn(user: string): string {
  // Local name is not `t` so it never shadows the imported i18n t().
  const title = user.replace(/\s+/g, ' ').trim();
  return title.length > 30 ? `${title.slice(0, 30)}…` : title || t('chat.newSession');
}

export class HistoryStore {
  private sessions: SessionRecord[] = [];
  private current: SessionRecord;
  /** Absolute path to history.json (resolved from the vault root). */
  private absPath: string;

  constructor(
    private app: App,
    private file: string,
    private limit: number,
  ) {
    this.current = this.newSession();
    const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
    const base = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
    this.absPath = path.join(base, this.file);
  }

  /** Archived sessions: pinned first, then newest first. */
  getSessions(): SessionRecord[] {
    return [...this.sessions].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.endedAt - a.endedAt;
    });
  }

  /** The in-memory session still being edited (not archived yet). */
  getCurrentSession(): SessionRecord {
    return this.current;
  }

  setLimit(limit: number): void {
    this.limit = limit;
    this.trim();
    void this.save();
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.absPath, 'utf8');
      const parsed = JSON.parse(raw) as { sessions?: SessionRecord[]; current?: SessionRecord };
      this.sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions.map((s) => ({ ...s, pinned: s.pinned ?? false, note: s.note ?? '' }))
        : [];
      const cur = parsed.current;
      if (cur && Array.isArray(cur.turns) && cur.turns.length > 0) {
        // A previous run was interrupted (quit / crash) before its in-progress
        // session was archived — Obsidian does NOT reliably call onunload() on
        // quit. Archive it now so it shows up in history on this load.
        this.sessions.push({ ...cur, pinned: cur.pinned ?? false, note: cur.note ?? '' });
      }
      this.current = this.newSession();
      this.trim();
      this.save();
    } catch {
      this.sessions = [];
      this.current = this.newSession();
    }
  }

  /** Append one turn to the current session, then persist it. */
  async addTurn(
    turn: HistoryTurn,
    meta: { model: string; effort: string; permission: string },
  ): Promise<void> {
    if (this.current.turns.length === 0) {
      this.current.title = titleFromTurn(turn.user);
      this.current.startedAt = turn.ts;
      this.current.model = meta.model;
      this.current.effort = meta.effort;
      this.current.permission = meta.permission;
    }
    this.current.turns.push(turn);
    this.current.endedAt = turn.ts;
    this.save();
  }

  /** Archive the current session (if it has turns) and start a new one. */
  async endSession(): Promise<void> {
    if (this.current.turns.length === 0) return;
    this.sessions.push(this.current);
    this.trim();
    this.current = this.newSession();
    this.save();
  }

  /**
   * Re-activate an archived session as the current one: future turns are
   * appended back into it. Returns the activated session, or null if missing.
   */
  async activateSession(id: string): Promise<SessionRecord | null> {
    if (this.current.turns.length > 0) {
      this.sessions.push(this.current);
    }
    const idx = this.sessions.findIndex((x) => x.id === id);
    if (idx === -1) {
      this.trim();
      this.save();
      return null;
    }
    const activated = this.sessions[idx];
    this.sessions.splice(idx, 1);
    this.current = activated;
    this.current.endedAt = Date.now();
    this.trim();
    this.save();
    return activated;
  }

  async removeSession(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.save();
  }

  async renameSession(id: string, title: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      s.title = title.trim() || s.title;
      this.save();
    }
  }

  async togglePin(id: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      s.pinned = !s.pinned;
      this.save();
    }
  }

  async setNote(id: string, note: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      s.note = note.trim();
      this.save();
    }
  }

  async clear(): Promise<void> {
    this.sessions = [];
    this.current = this.newSession();
    this.save();
  }

  private newSession(): SessionRecord {
    const now = Date.now();
    return {
      id: newId(),
      title: t('chat.newSession'),
      startedAt: now,
      endedAt: now,
      model: '',
      effort: '',
      permission: '',
      turns: [],
      pinned: false,
      note: '',
    };
  }

  private trim(): void {
    // Pinned sessions are never auto-deleted; only the oldest non-pinned ones
    // are dropped when over the limit (total may exceed `limit` if the user
    // pinned more than the limit).
    const pinned = this.sessions.filter((s) => s.pinned).sort((a, b) => b.endedAt - a.endedAt);
    const others = this.sessions.filter((s) => !s.pinned).sort((a, b) => b.endedAt - a.endedAt);
    const room = Math.max(0, this.limit - pinned.length);
    this.sessions = [...pinned, ...others.slice(0, room)];
  }

  /**
   * Persist sessions + current atomically (tmp file then rename). Writes are
   * synchronous (writeFileSync + renameSync) so they complete inline — this is
   * required for onunload(), which Obsidian declares as void and never awaits.
   * The file is small (tens of KB), so a sync write is well under 1ms.
   */
  private save(): void {
    const payload = JSON.stringify({
      sessions: this.sessions,
      ...(this.current.turns.length > 0 ? { current: this.current } : {}),
    }, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.absPath), { recursive: true });
      const tmp = `${this.absPath}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.absPath);
    } catch (e) {
      new Notice(t('chat.historySaveFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  }
}
