/**
 * Auto-link note titles / aliases / paths inside assistant answers BEFORE
 * they are rendered, so mentions of vault notes become clickable internal
 * links even when the model did not write [[wikilinks]] itself.
 *
 * Pure & Obsidian-free: it takes markdown text plus a list of title entries
 * and returns the text with matches wrapped in [[wikilinks]]. Protected
 * regions are never touched: fenced/inline code, existing [[wikilinks]],
 * [markdown links] and images, HTML tags, and bare URLs.
 */

export interface NoteTitleEntry {
  /** Exact substring to match (longest entries win). */
  match: string;
  /** Replacement wikilink body, e.g. [[note]] or [[folder/note|note]]. */
  link: string;
}

export interface NoteInfo {
  /** File basename without extension. */
  name: string;
  /** Vault-relative path WITHOUT the .md extension. */
  path: string;
  /** Frontmatter aliases (optional). */
  aliases?: string[];
}

/** Titles shorter than this are too noisy to auto-link. */
export const MIN_TITLE_LENGTH = 2;
/** Hard cap so the match regex stays sane. */
export const MAX_TITLE_LENGTH = 120;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build deduped, longest-first title entries from vault notes.
 *
 * Each note contributes its basename, its vault-relative path (with and
 * without the .md extension) and its aliases. When several notes share the
 * same match string (duplicate basenames), the entry links through the
 * explicit path so Obsidian resolves deterministically.
 */
export function buildTitleEntries(notes: NoteInfo[]): NoteTitleEntry[] {
  const counts = new Map<string, number>();
  const raw: Array<{ match: string; name: string; path: string; target: string }> = [];

  for (const n of notes) {
    const push = (m: string): void => {
      const t = m.trim();
      if (!t || t.length < MIN_TITLE_LENGTH || t.length > MAX_TITLE_LENGTH) return;
      raw.push({
        match: t,
        name: n.name,
        path: n.path,
        // Path matches (with or without .md) link to the extension-less path;
        // basename/alias matches link to the matched text itself.
        target: t === n.path || t === `${n.path}.md` ? n.path : t,
      });
      counts.set(t, (counts.get(t) ?? 0) + 1);
    };
    push(n.name);
    push(n.path);
    push(`${n.path}.md`);
    for (const a of n.aliases ?? []) push(a);
  }

  const entries: NoteTitleEntry[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (seen.has(r.match)) continue;
    seen.add(r.match);
    const dup = (counts.get(r.match) ?? 0) > 1;
    entries.push({
      match: r.match,
      link: dup ? `[[${r.path}|${r.name}]]` : `[[${r.target}]]`,
    });
  }
  return entries.sort((a, b) => b.match.length - a.match.length);
}

/** Regions inside a line that must never be linkified. */
const PROTECTED =
  /(`[^`\n]*`)|(\[\[[^\]\n]*\]\])|(!?\[[^\]\n]*\]\([^)\n]*\))|(<[^>\n]*>)|(https?:\/\/[^\s)\]}>]+)/g;

/**
 * Wrap title matches in `text` with wikilinks.
 * Returns the input unchanged when there is nothing to link.
 */
export function linkifyNoteTitles(text: string, entries: NoteTitleEntry[]): string {
  if (!text || entries.length === 0) return text;

  const sorted = [...entries].sort((a, b) => b.match.length - a.match.length);
  const linkByMatch = new Map(sorted.map((e) => [e.match, e.link]));
  // Longest-first alternation: at any position the longest matching title wins.
  const regex = new RegExp(sorted.map((e) => escapeRegExp(e.match)).join('|'), 'g');

  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    out.push(inFence ? line : linkifyLine(line, regex, linkByMatch));
  }
  return out.join('\n');
}

function linkifyLine(
  line: string,
  regex: RegExp,
  linkByMatch: Map<string, string>,
): string {
  let result = '';
  let last = 0;
  PROTECTED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROTECTED.exec(line)) !== null) {
    result += linkifyPlain(line.slice(last, m.index), regex, linkByMatch);
    result += m[0];
    last = m.index + m[0].length;
  }
  result += linkifyPlain(line.slice(last), regex, linkByMatch);
  return result;
}

function linkifyPlain(
  plain: string,
  regex: RegExp,
  linkByMatch: Map<string, string>,
): string {
  if (!plain) return '';
  return plain.replace(regex, (matched) => linkByMatch.get(matched) ?? matched);
}
