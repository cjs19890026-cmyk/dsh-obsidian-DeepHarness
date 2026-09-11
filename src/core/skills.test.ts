import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractSkillFields, filterSkillEntries, normalizeSkillEntries, scanSkillRoots, RawSkill } from './skills';

describe('extractSkillFields', () => {
  it('reads plain name/description', () => {
    const f = extractSkillFields('---\nname: tear-down-book\ndescription: 拆书成读书笔记\n---\n正文');
    expect(f).toEqual({ name: 'tear-down-book', description: '拆书成读书笔记' });
  });

  it('strips quotes from name/description', () => {
    const f = extractSkillFields('---\nname: "quoted-name"\ndescription: "带 空格 的描述"\n---');
    expect(f.name).toBe('quoted-name');
    expect(f.description).toBe('带 空格 的描述');
  });

  it('collects folded ( >- ) description lines', () => {
    const f = extractSkillFields('---\nname: fold\ndescription: >-\n  第一行\n  第二行\n---\n');
    expect(f.description).toBe('第一行 第二行');
  });

  it('returns empty name without frontmatter', () => {
    expect(extractSkillFields('# 标题\n正文').name).toBe('');
  });
});

describe('normalizeSkillEntries', () => {
  const raw: RawSkill[] = [
    { name: 'good-skill', description: 'd', dir: '/a', source: 'plugin' },
    { name: 'Bad Name', description: 'd', dir: '/a', source: 'plugin' },
    { name: 'no-desc', description: '   ', dir: '/a', source: 'plugin' },
    { name: 'dup', description: 'from project', dir: '/p', source: 'project' },
    { name: 'dup', description: 'from plugin', dir: '/pl', source: 'plugin' },
  ];

  it('drops non-kebab names and empty descriptions (mirrors DSH)', () => {
    const names = normalizeSkillEntries(raw).map((e) => e.name);
    expect(names).not.toContain('Bad Name');
    expect(names).not.toContain('no-desc');
  });

  it('higher-priority source wins duplicate names', () => {
    const out = normalizeSkillEntries(raw);
    expect(out.find((e) => e.name === 'dup')?.description).toBe('from project');
  });

  it('sorts by name', () => {
    const out = normalizeSkillEntries(raw).map((e) => e.name);
    expect(out).toEqual([...out].sort());
  });
});

describe('scanSkillRoots', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds dir bundles and flat .md files, skipping invalid ones', () => {
    fs.mkdirSync(path.join(tmp, 'bundle'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'bundle', 'SKILL.md'),
      '---\nname: bundle-skill\ndescription: 一个目录技能\n---\n',
    );
    fs.writeFileSync(path.join(tmp, 'flat.md'), '---\nname: flat-skill\ndescription: 一个扁平技能\n---\n');
    fs.writeFileSync(path.join(tmp, 'invalid.md'), '---\nname: 中文名\ndescription: 会被跳过\n---\n');

    const out = scanSkillRoots([{ dir: tmp, source: 'project' }]);
    expect(out.map((e) => e.name)).toEqual(['bundle-skill', 'flat-skill']);
  });

  it('treats missing roots as an empty state', () => {
    expect(scanSkillRoots([{ dir: path.join(tmp, 'nope'), source: 'extra' }])).toEqual([]);
  });
});

describe('filterSkillEntries', () => {
  const skills = [
    { name: 'weekly-review', description: '每周执行一次的信息系统维护仪式', source: 'extra' as const, dir: '/x' },
    { name: 'para-system', description: '信息应该放哪里的分类体系', source: 'extra' as const, dir: '/x' },
    { name: 'obsidian', description: 'Obsidian vault 操作约定与官方 CLI 用法', source: 'plugin' as const, dir: '/x' },
  ];

  it('matches by name (case-insensitive)', () => {
    expect(filterSkillEntries(skills, 'WEEKLY').map((s) => s.name)).toEqual(['weekly-review']);
  });

  it('matches by description', () => {
    expect(filterSkillEntries(skills, '分类').map((s) => s.name)).toEqual(['para-system']);
  });

  it('empty query returns the catalog order capped at max', () => {
    expect(filterSkillEntries(skills, '').length).toBe(3);
    expect(filterSkillEntries(skills, '', 2).length).toBe(2);
  });

  it('no match returns empty', () => {
    expect(filterSkillEntries(skills, '不存在xyz')).toEqual([]);
  });
});
