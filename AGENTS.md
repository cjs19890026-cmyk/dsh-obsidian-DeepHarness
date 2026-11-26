# AGENTS.md — DeepHarness 开发入口

> 这是所有 coding agent 的**唯一入口**。先读完本文件，再按顺序读三份文档：
>
> 1. [`docs/architecture.md`](docs/architecture.md) — 当前架构、不变量、安全模型、架构债
> 2. [`docs/roadmap.md`](docs/roadmap.md) — 唯一任务/优先级来源
> 3. [`docs/development.md`](docs/development.md) — 命令、测试、部署、git/发布、踩坑
>
> `README.md` / `readme-ch.md` 面向用户，不是开发任务书。**不要新建 HANDOFF / AI_CONTEXT / 状态交接文档**；状态写进 roadmap，架构写进 architecture。

## 1. 项目是什么

DeepHarness 是 Obsidian 桌面插件（id `deepharness`），把 **DeepSeek Harness (DSH)** 的 headless agent 拉进 vault：

- 插件不做 agent 推理，只做四件事：探测/拉起 `dsh` 进程、准备隔离的 DSH_HOME 与 vault persona、把 `DLEVENT` 流转成 UI、渲染结果与历史。
- 每次任务固定执行 `dsh --profile headless --patch <vault.yml> "<task>"`，cwd = vault（或设置里的子目录）。
- DSH 的完整工具链（bash、文件读写、web、subagents、skills）都可用；安全边界由 DSH 的 `DSH_PERMISSION_MODE` 沙箱策略决定，默认 `workspace-write`。

## 2. 当前基线（2026-11-26，合并 main 后）

| 项 | 值 |
|---|---|
| 默认分支 | `main`；2026-11-26 R1/R2/F1/F2 手测后合入（HEAD 以 git log 为准） |
| 版本 | `package.json` / `manifest.json` = `0.1.8` |
| 测试 | `npm test` → **323 passed / 2 skipped**（19 个测试文件） |
| 类型 | `npx tsc --noEmit` 通过 |
| 构建 | `npm run build` 通过（`dist/main.js` ≈149 KB） |
| Lint | `npx eslint "src/**/*.ts"` → 0 errors / 9 warnings（已知基线，不要新增） |
| 运行时 | Node 22（CI），Obsidian 1.13+，桌面端 only |

这些数字是**基线，不是永久真理**。改代码后以你刚跑出的结果为准；如果基线变了，同步更新 `docs/development.md` 和本节。

## 3. 目录与职责

```
src/
  main.ts                插件生命周期、命令、设置页、权限二次确认
  i18n/index.ts          en/zh 文案表 + t()
  settings/              DshSettings 类型/默认值/校验、设置页
  dsh/
    paths.ts             所有路径解析的单点（vault 内/外、DSH_HOME）
    dsh-runner.ts        任务前准备：DSH_HOME、vault patch、persona、skills
    dsh-client.ts        真正的 spawn/stdio/超时/abort/进程注册表
    pure.ts              DLEVENT 解析、shim 解析等无 Obsidian 依赖的纯函数
    dsh-config.ts        settings.yaml 的读写与模型合并
  core/                  历史、诊断、技能、上下文计量、更新检查、linkify
  views/                 ChatView、面板、弹窗、mention、技能选择
test/                    Node/jsdom 替身（obsidian stub、view double）
docs/                    架构/开发/路线图/发布清单/历史
```

`ChatView` 目前仍是编排中心（UI + 会话状态 + 历史写入），`DshRunner` 仍偏大；这是已知架构债，见 `docs/architecture.md`，不要在无关任务里顺手大拆。

## 4. 每步必须跑的验证

```bash
npm test
npx tsc --noEmit
npm run build
npx eslint "src/**/*.ts"
```

- 只改文档/注释也要跑 `tsc`（防止注释块破坏语法）。
- 改 UI/生成链路后，仅单测不够：用 `./deploy.sh <vault>` 部署到真实 vault，重载插件，至少手工走一遍受影响路径（发送、流式、停止、历史、设置）。
- 不要在 `npm test` 失败时继续叠改动；先判断是基线问题还是你的改动。

首次安装依赖：

```bash
npm ci --cache "$(pwd)/.npm-cache"
```

## 5. 不可协商的约束（红线）

1. **类型**：不用 `any` / `as any` 绕过类型；用 `unknown` + 类型守卫。测试里的替身也应尽量有类型。
2. **XSS**：模型/用户内容不得拼进 `innerHTML`；Markdown 用 `MarkdownRenderer.render`，纯文本用 `textContent`。
3. **异步**：不要 floating promise；要么 `await`，要么显式 `void` 并注释原因。`onunload()` 必须同步完成关键收尾（Obsidian 不会 await）。
4. **i18n**：所有用户可见文案进 `src/i18n/index.ts`，en/zh 两份都要有；不要硬编码中文/英文到视图。
5. **进程**：只有 `DshClient` 能 spawn；它负责 child 注册表、超时、abort、SIGTERM→SIGKILL。别在别处 `child_process.spawn`。
6. **路径**：一律走 `src/dsh/paths.ts`；不要硬编码 `~`、home、`.obsidian`。设置里的 `dshHome` 只在这里展开。
7. **写入**：磁盘写入用 temp + rename 原子替换；历史在卸载时同步落盘。不要直接覆盖用户文件。
8. **取消**：每次运行有 `AbortController`；取消/超时必须杀子进程，并保留已生成的部分答案。
9. **DSH_HOME**：插件专属目录在 `~/.dsh/deepharness/<vaultKey>/`（vault 外）；vault 内只允许 `generated/`。绝不把凭据写进 vault。
10. **技能扫描**：只扫插件专属 DSH_HOME 的 `skills/`，加上设置里明确登记的 `extraSkillDirs`（vault 相对目录）；不要恢复扫描 vault 的 `.dsh` / `.agents`。
11. **设置快照**：视图打开时不要缓存 `this.plugin.settings` 的旧对象；每次运行/渲染从 `plugin.settings` 读当前值，或订阅变更。
12. **协议**：`DLEVENT\t<json>` 是流式 UI 的契约；改 relay/解析必须同步测试，且保证最终 answer 不含 DLEVENT 行。
13. **完全访问**：切入 `danger-full-access` 必须二次确认；不能从某个 UI 绕过 `plugin.setPermissionMode()`。
14. **文档**：不新增状态交接文档；任务状态只改 `docs/roadmap.md`，架构变化只改 `docs/architecture.md`。

## 6. 工作方式

1. 读 `docs/roadmap.md`，选一个**有验收标准**的条目；不要同时开多个无关改动。
2. 先写/改测试（核心逻辑），再实现；UI 改动至少加一个组件/替身测试。
3. 跑四项验证；UI/生成链路再部署真人测试。
4. 一个主题一个 commit；提交信息用 conventional commits（`feat:` / `fix:` / `refactor:` / `docs:` / `test:`）。
5. 只有**验证通过并真人测试过**，才把 roadmap 条目标为完成；没做完的写回 `Next` 并注明阻塞。
6. 需要产品取舍时，把选项和代价写进 roadmap 的「待决策」，问用户，不要自行改方向。

## 7. 常见坑（都真实踩过）

- **静默失败**：`void promise` 没有 catch；面板点击失效；history 写到了错误路径；技能写回 vault 又被下一次扫描忽略；设置页拿旧快照。改完必须看真实 UI/文件，不要只看单测绿。
- **路径在 onload 就被捕获**：DSH_HOME 迁移发生在首次任务；history 路径要用 resolver（`() => ...`），不要存字符串。
- **多面板**：插件命令只 targeting 一个 chat view；用户手动开多个是独立视图。不要假设 `getLeavesOfType()[0]`。
- **Windows**：路径分隔符、npm shim（`.cmd`/`.ps1`）解析、`file://` relay URL；不要写死 `/`。
- **Node/Electron**：Obsidian 渲染进程有 `window`，单测 Node 没有；定时器/`globalThis` 要兼容。
- **esbuild**：Node builtins 必须 external；新增依赖先确认能在 Electron 渲染进程运行。
- **历史/会话**：当前没有原生 `--session` 续跑；恢复会话是“重建记忆 + transcript”，不是恢复 DSH 进程。别在 UI 上承诺后者。

## 8. Git / 环境

- 当前仓库是 worktree；`.git` 指向工作区外。`git status` 必须干净再开始。
- 分支：日常在 `main`；功能分支从 `main` 切，完成后合回。合并前跑四项验证。
- push 走本机代理；网络失败时先检查代理环境，不要把代理地址写进仓库。
- **push / 发 Release / 改 tag 前问用户**；不要自行发布。
- 发布机械步骤见 [`docs/publish-checklist.md`](docs/publish-checklist.md)，流程说明见 [`docs/development.md`](docs/development.md)。

## 9. 什么时候必须问用户

- 要 push 到远端、打 tag、发 Release、改 Obsidian 目录提交信息。
- 要删除/移动用户 vault 里的文件，或做不可逆操作。
- 要新增运行时依赖、改默认权限、改产品方向/范围。
- 验收标准冲突，或实现需要牺牲已有红线。

其余实现细节自行决定，并在 commit / roadmap 里记录理由。
