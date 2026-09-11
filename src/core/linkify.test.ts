import { describe, expect, it } from 'vitest';
import { buildTitleEntries, linkifyNoteTitles, NoteInfo, NoteTitleEntry } from './linkify';

const NOTES: NoteInfo[] = [
  { name: '被讨厌的勇气', path: 'Library/ReadingNotes/被讨厌的勇气', aliases: ['阿德勒的哲学课'] },
  { name: '苹果', path: '水果/苹果', aliases: [] },
  { name: '苹果派', path: '甜点/苹果派', aliases: [] },
  { name: 'memory', path: 'Harness/memory', aliases: [] },
  { name: '同名笔记', path: 'A/同名笔记', aliases: [] },
  { name: '同名笔记', path: 'B/同名笔记', aliases: [] },
  { name: '书', path: '书', aliases: [] }, // single char: must be skipped
];

const entries = buildTitleEntries(NOTES);

function link(text: string, es: NoteTitleEntry[] = entries): string {
  return linkifyNoteTitles(text, es);
}

describe('buildTitleEntries', () => {
  it('includes basenames and aliases', () => {
    const matches = entries.map((e) => e.match);
    expect(matches).toContain('被讨厌的勇气');
    expect(matches).toContain('阿德勒的哲学课');
  });

  it('skips titles shorter than MIN_TITLE_LENGTH', () => {
    expect(entries.some((e) => e.match === '书')).toBe(false);
  });

  it('dedupes identical matches', () => {
    const matches = entries.map((e) => e.match);
    expect(new Set(matches).size).toBe(matches.length);
  });

  it('disambiguates duplicate basenames via explicit path', () => {
    const dup = entries.find((e) => e.match === '同名笔记');
    expect(dup?.link).toBe('[[A/同名笔记|同名笔记]]');
  });

  it('sorts longest-first', () => {
    const lengths = entries.map((e) => e.match.length);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i - 1]).toBeGreaterThanOrEqual(lengths[i]);
    }
  });
});

describe('linkifyNoteTitles', () => {
  it('wraps a plain title in [[wikilink]]', () => {
    expect(link('参考《被讨厌的勇气》')).toBe('参考《[[被讨厌的勇气]]》');
  });

  it('matches aliases too', () => {
    expect(link('见 阿德勒的哲学课 一书')).toContain('[[阿德勒的哲学课]]');
  });

  it('longest match wins (苹果派 over 苹果)', () => {
    expect(link('苹果派很好吃')).toBe('[[苹果派]]很好吃');
    expect(link('吃苹果')).toBe('吃[[苹果]]');
  });

  it('does not re-link inside an inserted/已有 wikilink', () => {
    expect(link('苹果 [[苹果]]')).toBe('[[苹果]] [[苹果]]');
  });

  it('leaves inline code untouched', () => {
    expect(link('用 `苹果` 命令')).toBe('用 `苹果` 命令');
  });

  it('leaves fenced code blocks untouched', () => {
    const code = '```bash\n苹果\n苹果派\n```';
    expect(link(code)).toBe(code);
  });

  it('leaves markdown links and images untouched', () => {
    expect(link('[苹果](https://example.com)')).toBe('[苹果](https://example.com)');
    expect(link('![苹果](img.png)')).toBe('![苹果](img.png)');
  });

  it('leaves bare URLs untouched (title inside URL is not linked)', () => {
    expect(link('见 https://example.com/苹果')).toBe('见 https://example.com/苹果');
  });

  it('leaves HTML tags untouched', () => {
    expect(link('<span title="苹果">x</span>')).toBe('<span title="苹果">x</span>');
  });

  it('links vault-relative paths with and without .md', () => {
    expect(link('已写入 Harness/memory.md')).toContain('[[Harness/memory]]');
    expect(link('已写入 Harness/memory')).toContain('[[Harness/memory]]');
  });

  it('passes through empty text / no entries', () => {
    expect(link('')).toBe('');
    expect(linkifyNoteTitles('随便说说 苹果', [])).toBe('随便说说 苹果');
  });

  it('links every occurrence', () => {
    expect(link('苹果 和 苹果')).toBe('[[苹果]] 和 [[苹果]]');
  });
});
