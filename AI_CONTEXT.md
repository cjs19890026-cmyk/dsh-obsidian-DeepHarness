# AI_CONTEXT.md — 项目稳定上下文

> **给每次新对话的第一份文档**。先读这份 + 本地 `MAINTENANCE.md` 顶部的交接摘要,
> 即可恢复全部上下文,无需重新理解整个项目。
> 本文件只写**稳定信息**;每次修改的日志与交接摘要见本地维护文档(不上线)。

## 一句话定位

**DeepHarness**(插件 id `deepharness`)是一个 Obsidian 插件:spawn `dsh --profile headless`
子进程,把 DeepSeek Harness 的完整 agent 能力(bash、文件工具、web 搜索、子代理)
接入用户的 vault。定位对标 [Claudian](https://github.com/yishentu/claudian)(Claude Code 版),
但执行层下沉到 DSH 运行时,插件只做进程桥接与 UI。

## 项目结构

```
src/main.ts          插件入口:视图注册、ribbon、命令、设置加载、vault 根目录
src/chat-view.ts     聊天 UI:流式渲染、思考/工具块、历史面板、会话恢复、欢迎区
src/chip-editor.ts   富文本输入框(contenteditable):[[路径]] 渲染为可点击 chip,序列化契约见文件头;兼作 @/ / 补全的 SuggestHost
src/dsh-client.ts    子进程桥:spawn node <dsh>/bin.js --profile headless,超时/取消
src/dsh-runner.ts    二进制探测、--patch 覆盖层生成(persona + stream-relay)、隔离 DSH_HOME、obsidian CLI 探测、长期记忆 seed
src/obsidian-skill.ts  内置 obsidian DSH skill(SKILL.md + references/cli.md + conventions.md)及写入
src/history.ts       会话历史:原子落盘、置顶/重命名/备注/恢复
src/context-meter.ts 上下文用量环(按模型各自的上下文窗口估算)
src/mention.ts       @ 提及:输入框 @ 弹 vault 笔记列表,选中生成 [[wikilink]]
src/modals.ts        独立 Modal 组件(NoteCreator / SecurityConfirm 等,自 chat-view 抽出)
src/linkify.ts       回答自动出链:笔记标题/别名/路径 → [[wikilink]](纯函数,可单测)
src/linkify.test.ts  vitest 单测(链接/别名/重名消歧/代码块与既有链接不误链)
src/skills.ts        技能目录扫描(纯函数 + node fs):解析 SKILL.md frontmatter、kebab-case 校验、按源优先级去重
src/skills.test.ts   vitest 单测(frontmatter 解析/校验/去重/扫描)
src/pure.ts          无 Obsidian 依赖的纯函数(可单测,如 parseHeadlessOutput / 错误分类)
src/pure.test.ts     vitest 单元测试
src/settings.ts      设置项 + 设置页 UI
src/i18n/index.ts    en/zh 双语,TranslationKey 类型约束
styles.css           全部样式(类前缀 dsh-)
esbuild.config.mjs   构建脚本(production 压缩)
.github/workflows/release.yml  官方 Actions 发布流:推 tag → 构建 → attestation → 草稿 Release
deploy.sh            构建 + 部署到指定 vault
README.md / readme-ch.md  英文 / 中文双语文档(顶部互链)
docs/publish-checklist.md  发布到社区市场的检查清单与 PR 模板
MAINTENANCE.md       本地维护日志(被 .gitignore 忽略,不上线)
```

## 技术栈

- TypeScript + esbuild(单文件 bundle → `dist/main.js`,CJS)
- Obsidian API(ItemView / Plugin / MarkdownRenderer / Menu / Modal)
- Node.js `child_process` 桥接 DSH CLI;**无任何前端框架**
- vitest(纯函数单元测试,`npm test`);无运行时依赖;nodeBuiltins 全部 external,不打进 bundle

## 重要约定

1. **执行层下沉**:插件绝不自己实现 agent 逻辑,只 spawn `dsh` 并渲染 stdout/事件流
2. **node 直跑 dsh 脚本**:`node <realpath>/bin.js`(绕过 Electron 受限 PATH 的 shebang 问题)
3. **隔离 DSH_HOME**:每任务写 `dsh-home/settings.yaml`(model + reasoningEffort),
   凭据软链复用用户 `~/.dsh`,不污染全局配置
4. **patch 覆盖层**(`generated/` 目录):
   - `vault.yml` = persona(用户可编辑;带版本标记 `deepharness-persona-vN`,升级时旧版备份为 `.bak` 后重新生成)
   - `stream-relay.js` + `stream.yml` = 插件管理的流式中继,stdout 输出 `DLEVENT\t<json>`
     事件(think / tool),headless 本身无流式
5. **内置 obsidian skill**:写入隔离 DSH_HOME 的 `skills/obsidian/`(SKILL.md + references/),
   由 DSH 原生 `skill-filesystem`(rank 400 `<dshHome>/skills`)自动发现,agent 用 `skill` 工具加载;
   用户可在 `<vault>/.dsh/skills/obsidian/`(rank 100)放置同名 skill 覆盖
6. **长期记忆**:`Harness/memory.md`(vault 根),persona/skill 要求 agent 每轮先读、跨会话结论写回
7. **官方 obsidian CLI**(Obsidian 1.12+,`设置→通用→命令行界面`):`detectObsidianCli()` 探测并把其目录注入 PATH;缺失时 agent 降级为文件工具
5. **i18n**:所有用户可见文案必须走 `t()`;新增 key 必须 en + zh 同时加
6. **历史持久化**:原子写(tmp + rename)+ 同步写(`onunload` 是 void,Obsidian 不 await)
7. **显示名 DeepHarness**,插件 id / 文件夹名 `deepharness` 永远不变(路径依赖)

## 常见命令

```bash
npm run build            # production 构建 → dist/
npm run dev              # 开发构建(不压缩,inline sourcemap)
npm test                 # vitest 单元测试(src/pure.test.ts)
npx tsc --noEmit         # 类型检查
./deploy.sh <vault路径>   # 构建 + 复制到 vault 插件目录
# 部署后必须:设置 → 第三方插件 → 禁用再启用该插件(或 Cmd+Q 完全退出 Obsidian)
```

## 不能改的边界(红线)

- 插件 `id` 与文件夹名 `deepharness`:history.json、dsh-home、generated 的绝对路径依赖它
  (注:2026-09-03 起规划把 dsh-home/history 迁出 vault 到系统目录,路径依赖随迁,id/文件夹名仍不变,见下方「已知待填坑」)
- `nodeBuiltins` 与 `obsidian` 必须保持 external,禁止打进 bundle
- **不收集 API Key**:凭据只走用户本地 DSH_HOME / 环境变量,插件无外发网络请求
- `DSH_PERMISSION_MODE`(沙箱模式)≠ `DSH_TOOLS_MODE`(工具后端),勿混淆(曾有历史 bug)
- `onunload()` 必须同步完成,不能 await
- 破坏性操作须先征得用户同意;切到「完全访问」必须先弹确认框
- 欢迎区/输入框保持极简(品牌极简方向),示例卡片已删除,勿加回

## 发布相关

发布到社区市场的完整步骤见 `docs/publish-checklist.md`。要点:tag 不带 `v`、
Release 必须带 main.js/manifest.json/styles.css 三件套、仓库必须 public。

## ⚠️ 已知待填坑(下次升级必读)

**插件 DSH_HOME 建在 vault 内部 = 架构缺陷,待修复**(详见本地 `MAINTENANCE.md` 顶部
2026-09-03 条目)。用户 Issues 实证:Windows + iCloud Drive 下,`pluginHomeDir()`
(`<vault>/.obsidian/plugins/deepharness/dsh-home`,dsh-runner.ts:372)被 dsh 首次运行
自举出整棵 node_modules(几百包/数万文件)→ iCloud 同步卡死。

- **为什么现在没爆**:macOS 上自举条目是 symlink(530 链接/6.9MB);Windows 无开发者模式时
  symlink 失败 → 实体拷贝 → 数万小文件进同步队列
- **修复方向**:把插件专属 DSH_HOME 迁到系统用户目录(如 `~/.dsh/deepharness/<vaultKey>`
  或 Obsidian userData),vault 内只留三件套 + 用户可编辑小文本;spawn 前断言 DSH_HOME
  不在 vaultRoot 下;升级时检测/迁移/清理旧树
- 红线第 1 条("dsh-home 绝对路径依赖 id")在迁出后需同步改写

## 交接机制

每轮对话结束,把「交接摘要」(≤10 条:改了什么/当前状态/下一步)追加到
本地 `MAINTENANCE.md` 顶部。下次新对话:读本文件 + 摘要即可继续。
