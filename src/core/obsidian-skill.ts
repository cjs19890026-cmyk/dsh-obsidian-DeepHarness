import * as fs from 'fs';
import * as path from 'path';

/**
 * The built-in "obsidian" DSH skill: vault conventions + long-term memory.
 * The plugin writes these files into its isolated DSH_HOME
 * (<dsh-home>/skills/obsidian/) so the headless agent discovers the skill
 * through `dsh-skill-filesystem` (rank 400 = <dshHome>/skills) with zero
 * changes to the dsh invocation. Files are plugin-owned and regenerated on
 * every run (same lifecycle as the stream-relay patch), so upgrading the
 * plugin updates the skill; a user who wants to override it drops their own
 * `obsidian` skill under `<vault>/.dsh/skills/` (rank 100, wins over 400).
 *
 * Layout (one-level skill bundle, per dsh-skill-filesystem):
 *
 *   obsidian/SKILL.md                 frontmatter (name/description) + body
 *   obsidian/references/conventions.md  frontmatter / wikilink / tag / daily rules
 */

export const OBSIDIAN_SKILL_NAME = 'obsidian';
export const MEMORY_FILE = 'Harness/memory.md';

const SKILL_MD = `---
name: obsidian
description: Obsidian vault 操作约定。当任务涉及笔记读写、frontmatter/Properties、wikilink、tag、日记、反链、模板或批量整理 vault 时使用。
whenToUse: 任务涉及 Obsidian vault 中的笔记、YAML frontmatter / Properties、[[wikilink]]、#tag、日记、反链、模板、批量重命名或库级检索时加载本技能。
---

# Obsidian 技能

你是运行在 Obsidian vault 里的助手。这个技能教你在 vault 里「正确地」读写与检索。

## 一、核心心智模型

1. vault 就是当前工作目录(即 dsh 会话的 cwd)或它的某个子目录。笔记是带可选 YAML frontmatter 的 Markdown 文件。
2. 读写笔记直接用文件工具(read/write/edit/glob/grep),自己解析 frontmatter 与 [[wikilink]]。
3. 约定细节见 references/conventions.md(相对本技能目录)。

## 二、安全红线(必须遵守)

- 删除/移动/覆盖等破坏性操作必须先向用户说明并征得同意。
- 移动或重命名笔记后,要检查并更新指向它的 [[wikilink]](否则链接会断)。
- 新建笔记要写 YAML frontmatter,笔记之间用 [[wikilink]] 互链。

## 三、长期记忆

- 开始任务时先用文件工具读 vault 根目录的 ${MEMORY_FILE},把上次的持久结论带回来。
- 任务中产生需要跨会话记住的结论(vault 结构、用户偏好、进行中的项目状态)时,立即写回该文件。

## 四、图片处理

- 读含 \`![[图片]]\` 的笔记时,主动把图片一起读了(图表/截图常含关键信息);文件工具的 read 支持 PNG/JPG/GIF/WebP。
- 遇到外部图片 \`![alt](url)\`:下载到本地媒体文件夹 → read 查看 → 把 markdown 链接替换为 \`![[本地文件名]]\`,让图片成为永久资产、离线可用、走 Obsidian 原生嵌入。

## 五、委托与并行

- 复杂多步任务可派生子代理(subagent);引用文件用相对路径。
- 阅读大量文件时,委托搜索型子代理,只保留结论、不回传文件全文。
`;

const CONVENTIONS_MD = `# Obsidian vault 约定

## 路径规则(最易错)

- vault 内文件一律用**相对 vault 根**的相对路径(如 \`notes/a.md\`、\`.\`)。
- 前导 \`/\` 或绝对路径会失败;写 vault 外需先征得同意并切换「完全访问」。

## frontmatter(YAML 元数据)

用 \`---\` 包裹,位于文件最顶部,编辑时**尊重并保留已有字段**:

    ---
    tags: [project, alpha]
    aliases: [别名一, 别名二]
    status: active
    ---

- \`tags\` 用 YAML 数组或逗号分隔;Obsidian 1.4+ 叫 Properties,类型化字段见 Obsidian 的 Properties UI。
- \`aliases\` 是别名词条,检索/反链会命中别名。

## 链接与嵌入

    [[笔记名]]               # 内部 wikilink,按文件名/别名解析
    [[路径/笔记名|显示文字]]     # 带别名
    [[笔记名#标题]]            # 指向标题锚点
    ![[图片.png]]            # 嵌入图片
    ![[笔记名]]               # 嵌入笔记
    [文本](https://url)      # 外部链接

- 指向不存在的笔记会显示为「未解析链接」,新建笔记时应顺手补链或修正。
- 移动/重命名后要更新指向它的 [[wikilink]],否则断链。

## tag 与 callout

    #标签 放在正文或 frontmatter
    > [!note] 标题 / > [!tip] / > [!warning] / > [!todo]

## Dataview(只读保护)

- \`\`\`dataview 代码块是查询,不是正文:**不要修改或破坏**(除非用户明确要求)。

## 日记与模板

- 日记路径/格式由 Obsidian 的 Daily Notes 插件决定,用 glob 找日记目录,别猜路径。
- 模板通常在 Templates 文件夹(以实际设置为准)。

## 附件

- 图片/附件通常放附件目录(按设置);引用用 \`![[...]]\` 嵌入。

## 常见陷阱(负向约束)

1. 用绝对路径操作 vault 文件 → 失败;用相对路径。
2. 不读就改 → 覆盖错误 / 匹配失败;先 read 再 edit。
3. 编辑时破坏 frontmatter → 元数据丢失;只改正文目标段。
4. 改写 Dataview 查询块 → 视图报错;视为只读。
5. 提到文件用裸路径 → 用户无法点击;用 [[wikilink]]。
6. 外部图片只贴 URL → 断链/离线失效;下载本地化。
7. 大范围重写整篇笔记 → 噪音、丢内容;用 edit 做最小替换。
8. 破坏性操作不确认 → 删/移/覆盖前先征得同意。
`;

export interface SkillWriteResult {
  /** Absolute path of the written skill directory (obsidian/). */
  dir: string;
  /** Written files, absolute paths. */
  files: string[];
}

/**
 * Write the obsidian skill bundle under `<skillRoot>/obsidian/`.
 * Plugin-owned: always overwritten so the skill tracks the plugin version.
 * Returns null when the directory cannot be created.
 */
export function ensureObsidianSkill(skillRoot: string): SkillWriteResult | null {
  const dir = path.join(skillRoot, OBSIDIAN_SKILL_NAME);
  try {
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(path.join(dir, 'references'), 0o755);
  } catch {
    return null;
  }

  const files: Array<[string, string]> = [
    ['SKILL.md', SKILL_MD],
    [path.join('references', 'conventions.md'), CONVENTIONS_MD],
  ];

  const written: string[] = [];
  try {
    for (const [rel, content] of files) {
      const abs = path.join(dir, rel);
      fs.writeFileSync(abs, content, 'utf8');
      written.push(abs);
    }
  } catch {
    return null;
  }

  return { dir, files: written };
}
