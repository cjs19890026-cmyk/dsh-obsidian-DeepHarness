import * as fs from 'fs';
import * as path from 'path';

/**
 * Skill catalog scanner for the chat UI.
 *
 * Mirrors what DSH's `dsh-skill-filesystem` discovers: one-level bundles
 * (<root>/<name>/SKILL.md) and flat markdown files (<root>/<name>.md) whose
 * frontmatter carries `name` + `description`. Names must be kebab-case and a
 * description is required — DSH silently drops anything else, so the scanner
 * applies the same rules to keep the button in sync with what the agent can
 * actually invoke via `/name`.
 *
 * Pure & Obsidian-free (node fs only) so it can be unit-tested.
 */

export interface SkillEntry {
  /** Kebab-case skill name (the /name token the agent resolves). */
  name: string;
  /** One-line catalog description shown in the panel. */
  description: string;
  /** Where the skill came from (dedupe priority + badge in the UI). */
  source: 'project' | 'extra' | 'plugin';
  /** Absolute directory of the skill (resource base). */
  dir: string;
}

export interface RawSkill {
  name: string;
  description: string;
  dir: string;
  source: SkillEntry['source'];
}

export interface ScanRoot {
  /** Absolute directory to scan (one level deep). */
  dir: string;
  source: SkillEntry['source'];
}

/**
 * Minimal frontmatter extractor for SKILL.md files: reads `name` and
 * `description` scalars, including quoted strings and folded (`>-`/`|`)
 * continuations. Not a full YAML parser — DSH does the authoritative parse;
 * this only feeds the UI list.
 */
export function extractSkillFields(markdown: string): { name: string; description: string } {
  const m = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: '', description: '' };

  let name = '';
  let description = '';
  let collecting = false;

  for (const line of m[1].split(/\r?\n/)) {
    if (collecting) {
      // A key at column 0 ends the description block.
      if (/^[A-Za-z][\w-]*:/.test(line) && !line.startsWith(' ') && !line.startsWith('\t')) {
        collecting = false;
      } else {
        const cont = line.trim();
        if (cont) description += (description ? ' ' : '') + cont;
        continue;
      }
    }
    const nm = line.match(/^name:\s*(.+?)\s*$/);
    if (nm) {
      name = stripQuotes(nm[1]);
      continue;
    }
    const dm = line.match(/^description:\s*(.*)$/);
    if (dm) {
      const rest = dm[1].trim();
      if (rest === '' || rest === '>' || rest === '>-' || rest === '|' || rest === '|-') {
        description = '';
        collecting = true;
      } else {
        description = stripQuotes(rest);
      }
    }
  }
  return { name, description };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate, dedupe and sort raw discovered skills. Rules mirror DSH:
 * kebab-case name + non-empty description required; on duplicate names the
 * higher-priority source wins (project .dsh/.agents > extra dirs > plugin).
 */
export function normalizeSkillEntries(raw: RawSkill[]): SkillEntry[] {
  const priority: Record<SkillEntry['source'], number> = {
    project: 0,
    extra: 1,
    plugin: 2,
  };
  const byName = new Map<string, SkillEntry>();
  for (const r of raw) {
    const name = r.name.trim();
    if (!name || !KEBAB.test(name)) continue;
    const description = r.description.trim();
    if (!description) continue;
    const prev = byName.get(name);
    if (!prev || priority[r.source] < priority[prev.source]) {
      byName.set(name, { name, description, source: r.source, dir: r.dir });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Scan all roots (one level) and return the normalized catalog. */
export function scanSkillRoots(roots: ScanRoot[]): SkillEntry[] {
  const raw: RawSkill[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue; // root doesn't exist: a valid empty state
    }
    for (const e of entries) {
      try {
        if (e.isDirectory()) {
          const f = path.join(root.dir, e.name, 'SKILL.md');
          if (fs.existsSync(f)) collectSkillFile(raw, f, root.source);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          collectSkillFile(raw, path.join(root.dir, e.name), root.source);
        }
      } catch {
        // unreadable entry: skip
      }
    }
  }
  return normalizeSkillEntries(raw);
}

function collectSkillFile(raw: RawSkill[], file: string, source: SkillEntry['source']): void {
  try {
    const { name, description } = extractSkillFields(fs.readFileSync(file, 'utf8'));
    if (name) raw.push({ name, description, dir: path.dirname(file), source });
  } catch {
    // unreadable file: skip
  }
}

/**
 * Case-insensitive contains-match on name or description — used by the
 * `/query` completion popup. An empty query returns the first `max` entries
 * (alphabetical, matching the catalog order).
 */
export function filterSkillEntries(skills: SkillEntry[], query: string, max = 50): SkillEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills.slice(0, max);
  return skills
    .filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    )
    .slice(0, max);
}
