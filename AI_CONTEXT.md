# AI_CONTEXT.md — 项目稳定上下文

> **给每次新对话的第一份文档**。读这份恢复稳定上下文;当前任务与验收标准
> 以 `HANDOFF.md` + `docs/architecture-review-2026-09-11.md` 为准。
> 本文件只写**稳定信息**;任务进度写在 HANDOFF.md,本地维护日志见 `MAINTENANCE.md`(不上线)。

## 一句话定位

**DeepHarness**(插件 id `deepharness`)是一个 Obsidian 插件:spawn `dsh --profile headless`
子进程,把 DeepSeek Harness 的完整 agent 能力(bash、文件工具、web 搜索、子代理)
接入用户的 vault。定位对标 [Claudian](https://github.com/yishentu/claudian)(Claude Code 版),
但执行层下沉到 DSH 运行时,插件只做进程桥接与 UI。

## 项目结构

```
src/main.ts              插件入口:视图注册、ribbon、命令、设置加载、vault 根目录、P2-K 视图注册表

src/views/               界面层(Obsidian 相关)
  chat-view.ts           聊天 UI:流式渲染、思考/工具块、会话恢复、降级提示(1248 行,后续可再拆)
  floating-panel.ts      浮动面板基类:锚点定位、外点关闭、Escape、互斥(两面板共用)
  history-panel.ts       会话历史面板(行渲染 + 重命名/置顶/删除/备注/恢复)
  skill-panel.ts         技能面板(复用 view 的缓存扫描)
  chip-editor.ts         富文本输入框(contenteditable):[[路径]] 渲染为可点击 chip,序列化契约见文件头;兼作 @/ / 补全的 SuggestHost
  mention.ts             @ 提及:输入框 @ 弹 vault 笔记列表,选中生成 [[wikilink]]
  skill-suggest.ts       / 斜杠技能补全
  modals.ts              独立 Modal 组件(NoteCreator / SecurityConfirm / DiagnosticPrompt / FolderSuggest 等)

src/dsh/                 与 DSH 运行时打交道的层
  dsh-client.ts          子进程桥:spawn node <dsh>/bin.js --profile headless,超时/取消(killReason)、env 白名单、依赖注入
  dsh-runner.ts          二进制/Node 探测、--patch 覆盖层生成(persona + stream-relay)、隔离 DSH_HOME、降级收集(862 行,后续可再拆)
  dsh-config.ts          窄口径读取用户 ~/.dsh/settings.yaml(模型目录 + provider 路由);isSafeModelId/isSafeProviderId(YAML 注入防线)
  paths.ts               插件磁盘布局的唯一取址处(vault 内 generated/ + 系统侧 dsh-home/ + 路径包含判断)
  pure.ts                无 Obsidian 依赖的纯函数(parseHeadlessOutput / parseDshEventLine / resolveVaultRelativeDir 等)

src/core/                领域服务与基础设施
  history.ts             会话历史:原子落盘、置顶/重命名/备注/恢复
  skills.ts              技能目录扫描(纯函数 + node fs):解析 SKILL.md frontmatter、kebab-case 校验、按源优先级去重
  obsidian-skill.ts      内置 obsidian DSH skill(SKILL.md + references/cli.md + conventions.md)及写入
  context-meter.ts       上下文用量环(按模型各自的上下文窗口估算)
  linkify.ts             回答自动出链:笔记标题/别名/路径 → [[wikilink]](纯函数,可单测)
  diagnostics.ts         环境检查报告与修复请求文本 + 可写性探测(Obsidian-free,可单测)
  updates.ts             插件更新检查(GitHub release 比对,Obsidian-free,可单测)

src/settings/            设置
  index.ts               设置页 UI(1.13 声明式 API)+ 向后兼容 re-export
  types.ts               设置数据结构与选项表(无 Obsidian 依赖、无 I/O)
  validate.ts            读取/校验/修复存储值(纯逻辑,可单测)

src/i18n/index.ts        en/zh 双语,TranslationKey 类型约束
test/setup.ts            vitest 共享 Obsidian DOM polyfill(Node 环境 no-op)
test/obsidian-stub.ts    让 import 'obsidian' 的模块在测试里可解析(包是纯类型)
test/obsidian-view-double.ts  视图测试用的 ItemView / app / plugin 替身
src/**/*.test.ts         vitest 单测(14 个测试文件,274 passed / 2 skipped)
styles.css               全部样式(类前缀 dsh-)
esbuild.config.mjs       构建脚本(production 压缩)
vitest.config.ts         测试配置(node 环境 + 共享 setup + obsidian alias)
.github/workflows/release.yml  官方 Actions 发布流:推 tag → 校验版本 → 构建 → attestation → 草稿 Release
.github/workflows/ci.yml       普通分支 test + build
deploy.sh                构建 + 部署到指定 vault
README.md / readme-ch.md  英文 / 中文双语文档(顶部互链)
docs/publish-checklist.md  发布到社区市场的检查清单与 PR 模板
docs/architecture-review-2026-09-11.md  架构审查报告:后续任务的唯一来源(问题清单 + 四阶段路线图)
HANDOFF.md               交接文档:红线、设计约定、任务清单与验收标准
MAINTENANCE.md           本地维护日志(被 .gitignore 忽略,不上线)
```

## 技术栈

- TypeScript + esbuild(单文件 bundle → `dist/main.js`,CJS)
- Obsidian API(ItemView / Plugin / MarkdownRenderer / Menu / Modal)
- Node.js `child_process` 桥接 DSH CLI;**无任何前端框架**
- vitest(纯函数单元测试,`npm test`);无运行时依赖;nodeBuiltins 全部 external,不打进 bundle

## 重要约定

1. **执行层下沉**:插件绝不自己实现 agent 逻辑,只 spawn `dsh` 并渲染 stdout/事件流
2. **node 直跑 dsh 脚本**:`node <realpath>/bin.js`(绕过 Electron 受限 PATH 的 shebang 问题)
3. **隔离 DSH_HOME**:每任务写 `~/.dsh/deepharness/<vaultKey>/settings.yaml`(model + reasoningEffort),
   凭据软链复用用户 `~/.dsh`,不污染全局配置,**且全程不在 vault 内**(2026-09-11 起)
4. **patch 覆盖层**(`generated/` 目录):
   - `vault.yml` = persona(用户可编辑;带版本标记 `deepharness-persona-vN`,升级时旧版备份为 `.bak` 后重新生成)
   - `stream-relay.js` + `stream.yml` = 插件管理的流式中继,stdout 输出 `DLEVENT\t<json>`
     事件(think / tool),headless 本身无流式
5. **技能只有一个家**:`~/.dsh/deepharness/<vaultKey>/skills/`(**在 vault 之外**)——本知识库的技能与内置
   obsidian skill 都在这里;vault 内的 `.dsh/skills`、`.agents/skills` **不再扫描**(2026-09-13 起)。
   面板来源徽章:内置 / 本知识库 / 自定义目录(设置里注册的外部目录)。
6. **内置 obsidian skill**:写入隔离 DSH_HOME(即上面那个 `skills/obsidian/`)的 SKILL.md + references/,
   由 DSH 原生 `skill-filesystem`(rank 400 `<dshHome>/skills`)自动发现,agent 用 `skill` 工具加载;
   用户可在 `<vault>/.dsh/skills/obsidian/`(rank 100)放置同名 skill 覆盖
6. **长期记忆**:`Harness/memory.md`(vault 根),persona/skill 要求 agent 每轮先读、跨会话结论写回
7. **官方 obsidian CLI**(Obsidian 1.12+,`设置→通用→命令行界面`):`detectObsidianCli()` 探测并把其目录注入 PATH;缺失时 agent 降级为文件工具
8. **i18n**:所有用户可见文案必须走 `t()`;新增 key 必须 en + zh 同时加
9. **历史持久化**:原子写(tmp + rename)+ 同步写(`onunload` 是 void,Obsidian 不 await)
10. **显示名 DeepHarness**,插件 id / 文件夹名 `deepharness` 永远不变(路径依赖)
11. **dsh 是无状态子进程**:每轮只看到 `buildTask` 组装的文本 + persona + `Harness/memory.md`。会话内上下文**只能**靠 `MEMORY_CONTEXT`(chat-view)那份记忆传递,`history.json` 里的完整轮次 agent 是读不到的——新增上下文来源请复用它,别另起一套截断
12. **设置页不要捕获 `settings` 快照**:`loadSettings()` 会整体替换 `plugin.settings`,渲染回调必须现取 `this.plugin.settings`(写进旧对象 = 改了没人读的东西,且不报错)
13. **插件磁盘路径只能从 `src/dsh/paths.ts` 取**(`generated/`、`dsh-home/`),不要再内联拼字符串

## 常见命令

```bash
npm run build            # production 构建 → dist/
npm run dev              # 开发构建(不压缩,inline sourcemap)
npm test                 # vitest 单元测试(src/**/*.test.ts,14 个文件)
npx tsc --noEmit         # 类型检查
./deploy.sh <vault路径>   # 构建 + 复制到 vault 插件目录
# 部署后必须:设置 → 第三方插件 → 禁用再启用该插件(或 Cmd+Q 完全退出 Obsidian)
```

## 不能改的边界(红线)

- 插件 `id` 与文件夹名 `deepharness`:它决定 vault 内 `plugins/deepharness/`(`generated/`)与系统侧
  `~/.dsh/deepharness/<vaultKey>/` 的绝对路径,永远不变。**取址一律走 `src/dsh/paths.ts`。**
- `nodeBuiltins` 与 `obsidian` 必须保持 external,禁止打进 bundle
- **不收集 API Key**:凭据只走用户本地 DSH_HOME / 环境变量,插件无外发网络请求
- `DSH_PERMISSION_MODE`(沙箱模式)≠ `DSH_TOOLS_MODE`(工具后端),勿混淆(曾有历史 bug)
- `onunload()` 必须同步完成,不能 await
- 破坏性操作须先征得用户同意;切到「完全访问」必须先弹确认框
- 欢迎区/输入框保持极简(品牌极简方向),示例卡片已删除,勿加回

## 发布相关

发布到社区市场的完整步骤见 `docs/publish-checklist.md`。要点:tag 不带 `v`、
Release 必须带 main.js/manifest.json/styles.css 三件套、仓库必须 public。

## 已填的坑 / 仍待注意

### ✅ 插件 DSH_HOME 建在 vault 内部(架构缺陷,2026-09-11 已修)

**曾经的症状**:Windows + iCloud Drive 下,插件 DSH_HOME 在 vault 内,dsh 首次运行会在那里
自举整棵 node_modules(macOS 上是 400+ 软链,Windows 无开发者模式时是**数万实体文件**),
iCloud 把它们排进同步队列 → 同步卡死。

**现在的位置**:
- `generated/`(persona、stream-relay、skill-dirs 补丁)= **仍在 vault 内**,小而可读、应随 vault 走
- **DSH_HOME = `~/.dsh/deepharness/<vaultKey>`**(vault 绝对路径的 sha256 前 16 位;同 vault 稳定)
- `history.json` 跟着 DSH_HOME 走,所以它也在系统目录里;vault 内**不再有** `dsh-home/`

**迁移**:老用户第一次跑任务时自动迁移(只拷 `history.json` / `settings.yaml` /
`.anonymous-user-id` / `sessions/` / `skills/`);`profiles/` 故意不拷(是缓存,dsh 会重建);
旧目录**只拷不删**(回滚路径,失败则回退到它并给提示);`.migrated` 标记防止二次覆盖。

**留下的护栏**:`prepareRun()` 会断言 DSH_HOME 不在 vault 内并上报。**别把 DSH_HOME 挪回 vault。**

⚠️ **教训(写代码时最容易再犯)**:凡是"路径可能在插件生命周期中途变化"的地方,都要
**现解析而不是在构造时捕获**。`HistoryStore` 就踩过:它在 `onload()` 建好、早于第一次任务
触发的迁移,于是迁移后整场对话仍写旧目录、新位置静默停更(`a3b2383` 修)。同类盲区还有
用户在设置里改 `dshHome`。

## 交接机制

- 当前任务与进度:`HANDOFF.md`(任务清单勾选 + 每轮刷新「当前状态」一节)。
- **本轮起工作流**:每完成一小步 → 跑四项验证(`npm test` / `tsc` / `build` / `eslint "src/**/*.ts"`)→
  用 `bash deploy.sh <vault>` 部署到真实 vault → **交用户真人实测**。真人测试是发现静默失败的唯一手段:
  2026-09-11 一天内,四个真 bug(面板点击无反应、恢复会话丢上下文、设置页快照、迁移后历史写错位置)
  **全部由真人测试发现**,而当时自动化测试 289 条全绿。
- 每轮对话结束,把「交接摘要」(≤10 条:改了什么/当前状态/下一步)追加到
  本地 `MAINTENANCE.md` 顶部。
- 下次新对话:读本文件 + HANDOFF.md「当前状态」+ 审查报告路线图即可继续。
