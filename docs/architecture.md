# 架构 — DeepHarness

> 状态：living document，最后核对 **2026-11-26**（0.1.8 / 合并基线 `f60d71d`；此后 HEAD 以 git log 为准）。
> 代码是最终事实源；本文解释**为什么这样分层、哪些不能碰、债在哪里**。
> 任务与优先级见 [`roadmap.md`](roadmap.md)，命令与流程见 [`development.md`](development.md)。

## 1. 设计目标与非目标

**目标**

1. 把 DSH 的完整 agent 能力（bash、文件、web、subagents、skills）带进 Obsidian，而不是做“问答 + RAG”。
2. 插件只做桥接：进程、文件系统准备、流式事件、UI、历史。agent 推理与工具执行全部交给 DSH。
3. 默认安全：文件工具与 bash 都受 DSH 沙箱约束；危险模式必须显式确认。
4. vault 是工作目录；生成的 persona / patch 可读、可改、可随 vault 迁移。
5. 桌面端优先；不伪装成移动端可用。

**非目标**

- 不在插件里实现 agent 循环、工具调用协议、RAG 检索或 prompt 编排。
- 不复制 Claudian 的 JSON action executor；DSH 已经执行工具，插件再解析一遍会分裂事实源。
- 不把 DSH 的全局配置当插件配置；插件只维护自己的隔离 DSH_HOME。
- 不做多用户/云端会话；所有数据在本机。

## 2. 运行时拓扑

```
Obsidian (Electron renderer)
└─ ChatView
   ├─ DshRunner ── 准备：二进制/Node、DSH_HOME、patch、persona、skills、memory
   ├─ DshClient ── spawn：node <dsh bin.js> --profile headless --patch ... "<task>"
   │                 env: DSH_HOME / DSH_PERMISSION_MODE / DSH_TOOLS_MODE / API key
   │                 stdout: 普通行 + DLEVENT\t<json>
   └─ HistoryStore ── 会话归档（vault 外的插件 DSH_HOME）

DSH child process
├─ profile: headless
├─ cwd: vault root 或设置里的 vault 子目录
├─ patch: generated/vault.yml（persona）
│         generated/stream.yml + stream-relay.js（流式事件）
│         generated/skill-dirs.yml（附加技能目录，按需）
└─ 工具：bash / file / web / subagents / skill-filesystem …
```

关键点：**插件不解析工具调用语义**。relay 只把 DSH 的 reasoning / tool 事件编码成 `DLEVENT` 行；插件只做 UI 展示与历史记录。

## 3. 模块图与职责

| 路径 | 职责 | 不该做什么 |
|---|---|---|
| `src/main.ts` | 插件生命周期、命令、设置页、权限二次确认、打开/聚焦 chat view | 不直接 spawn、不拼 DSH 参数 |
| `src/views/chat-view.ts` | 会话 UI、发送/停止、流式渲染、记忆、历史写入、恢复会话 | 不应长期承担 RunController（见 §8） |
| `src/dsh/dsh-runner.ts` | 任务前准备：detect bin/node、DSH_HOME 迁移与写入、workdir、persona、stream relay、obsidian skill、memory seed、skill-dirs patch、task 组装 | 不 spawn、不碰 Obsidian UI |
| `src/dsh/dsh-client.ts` | 唯一 spawn 点：参数/env、stdio 行解析入口、超时、abort、SIGTERM→SIGKILL、进程注册表 | 不做 UI、不读设置页 |
| `src/dsh/pure.ts` | 无 Obsidian 依赖的纯函数：DLEVENT 解析、npm shim 解析、headless 输出清洗、错误码映射 | 不读写文件 |
| `src/dsh/dsh-config.ts` | 用户 `settings.yaml` 的读取/合并、模型导入 | 不决定插件 DSH_HOME 布局 |
| `src/dsh/paths.ts` | 所有路径的单点：vault 内 plugin/generated、vault 外 system DSH_HOME、vaultKey、`isInside` | 不展开业务设置 |
| `src/settings/` | 类型、默认值、校验、设置页 | 不写运行逻辑 |
| `src/core/history.ts` | 会话记录、当前会话、原子持久化、恢复 | 不渲染 |
| `src/core/skills.ts` | 技能扫描/解析/缓存 | 不写 DSH 配置 |
| `src/core/diagnostics.ts` | 环境自检、可复制报告 | 不修改环境 |
| `src/core/updates.ts` | 手动检查 GitHub Release | 不自动下载/安装 |
| `src/i18n/index.ts` | en/zh 文案与 `t()` | 不放业务状态 |
| `src/views/*` | 面板、弹窗、mention、chip editor 等 UI 组件 | 不拥有运行生命周期 |

依赖方向：`views → dsh/core/settings/i18n`，`dsh → core/i18n`，`core → i18n`。已知反向依赖：`dsh-runner.ts` 从 `settings/index.ts` 取类型，`chat-view.ts` 从 `settings/index.ts` 取 option 常量；理想是 `settings/types.ts` + `settings/validate.ts`，见 §8。

## 4. 磁盘布局

### vault 内（随 vault 同步）

```
<vault>/.obsidian/plugins/deepharness/
├─ main.js / manifest.json / styles.css
└─ generated/
   ├─ vault.yml            persona patch（用户可编辑；升级/语言切换可能重生成，旧版 .bak）
   ├─ stream.yml           relay patch
   ├─ stream-relay.js      relay 实现（当前由 TS 模板字符串写入）
   ├─ skill-dirs.yml       仅当设置了额外的 vault 内技能目录
   └─ vault.yml.bak        用户编辑被覆盖前的备份（可能存在）
```

`generated/` 是**唯一允许留在 vault 内的插件运行时目录**：patch 文件小、可读、需要随 vault 走。

### vault 外（插件 DSH_HOME）

```
~/.dsh/deepharness/<vaultKey>/
├─ settings.yaml           插件写入的 agent-default-model（provider/model/reasoningEffort）
├─ .credentials.yaml       指向 ~/.dsh/.credentials.yaml 的 symlink；Windows 无权限时复制
├─ skills/                 内置 obsidian skill（以及用户放进来的技能）
├─ history.json            会话归档
└─ …                       DSH headless profile 自己 bootstrap 的文件
```

`vaultKey = <vault 目录名>-<sha256(绝对路径)[:16]>`。同一 vault 稳定映射；不同 vault 不碰撞。**绝不能把这个目录放回 vault**：DSH 会在这里生成数百个 symlink（Windows 无 symlink 权限时是数万文件），同步盘会卡死——这是迁移的直接原因。

### 其他

- `<vault>/Harness/memory.md`：长期记忆 seed，vault 相对路径稳定，即使 workdir 是子目录也能被 agent 找到。
- 旧版 `<vault>/.obsidian/plugins/deepharness/dsh-home/`：只用于迁移/回滚，正常不再写入。

## 5. 一次运行的完整生命周期

1. **触发**：用户点发送，或命令 “Process current note” 预填输入（`setPendingInput`，仍需用户发送）。
2. **同步门禁**：`running` 为真则拒绝；否则清空编辑器、渲染 user 消息、置 `running=true`、创建 `AbortController`、按钮变 Stop。
3. **准备（`prepareRun`）**：
   - `detectBin()` / `detectNode()` / `resolveDshScript()`；
   - `buildTask()`（memory + 用户消息）；
   - `ensureVaultPatch()`（persona + relay）；
   - `ensureSkillDirsPatch()`；
   - `ensurePluginDshHome()`（迁移、settings.yaml、凭据）；
   - `ensureObsidianSkill()` / `ensureMemoryFile()`；
   - `workdir()`（空 = vault root；越界/不可写则降级并收集 issue）；
   - `isInside(dshHome, vaultRoot)` 守卫。
   - 任一硬失败：渲染 setup error + Notice，**不 spawn**。
   - 准备降级（写失败、回退）：收集 `PreparationIssue[]`，运行前一次性展示。
4. **执行（`DshClient.run`）**：传 `task/cwd/dshHome/apiKey/provider/toolsMode/permissionMode/patchPath/timeoutMs/signal/onStdoutLine`；子进程注册；超时/abort 触发 kill。
5. **流式**：stdout 逐行 → `parseDshEventLine` → thinking 累积 / tool 行创建与更新；最终 answer = `parseHeadlessOutput(stdout)`（去掉所有 DLEVENT 行）。
6. **收尾**：按 `killReason` / exitCode / stdout 分四种 UI 结果；成功时写 memory + history；失败/取消/超时也尽量保留可见状态；`finally` 重置 `running`、`abortController`、按钮。
7. **视图销毁**：`onClose` / `shutdownForUnload` 置 `closed=true`、abort、持久化当前会话；之后任何异步回调不得再碰 DOM，只能 `savePartialTurn`。

**已知缺陷**：步骤 3 硬失败时直接 `return`，没有回到 `finally`，会留下 `running=true` 与 Stop 按钮，直到用户再点一次 Stop。这正是需要显式状态机的原因之一。

## 6. 状态机：现状与目标

**现状**：`ChatView` 用四个字段表达生命周期：

- `running: boolean`
- `abortController: AbortController | null`
- `statusTimer: number | null`
- `closed: boolean`（销毁闩锁）

状态是**推导出来的**（按钮文案、status 行、`running`），没有唯一状态变量；准备失败、取消、超时、子进程异常退出之间靠分支约定。后果是容易出现“按钮/状态/子进程不一致”，且无法重放或做集成测试。

**目标（0.1.9）**：引入 `RunController`，显式状态：

```
idle ──prepare──▶ preparing ──spawn──▶ running
  ▲                    │                  ├─▶ succeeded
  │                    │                  ├─▶ failed
  │                    │                  ├─▶ cancelled
  │                    │                  └─▶ timedOut
  └────────────────────┴──────────────────（cleanup 后回 idle）
```

`RunController` 持有：当前状态、`AbortController`、超时 timer、child 句柄（经 `DshClient`）、部分输出、历史写入所需的元数据。它对外发事件（state / stream / tool / done），`ChatView` 只订阅并渲染。硬约束：**任何路径（包括 prepare 失败）都必须经过 cleanup 回到 idle**。

## 7. 事件协议

relay 由 `stream-relay.js` 注入到 DSH，向 stdout 写：

```
DLEVENT\t{"t":"think","text":"..."}
DLEVENT\t{"t":"tool","status":"start","id":"...","name":"bash","args":"...","argsFull":"..."}
DLEVENT\t{"t":"tool","status":"result","id":"...","ok":true,"summary":"..."}
```

- `parseDshEventLine` 对非 DLEVENT、坏 JSON、未知 shape 返回 `null`（静默忽略，不抛）。
- `parseHeadlessOutput` 删除所有 DLEVENT 行，剩余 trim 后就是最终答案。
- 协议是 UI 契约：改 relay 必须同步改解析与测试；`stream.yml` 里的 `name` 必须是 `file://` URL（Windows 裸路径会被 Node ESM loader 拒绝）。

## 8. 安全模型

- **沙箱模式**：`DSH_PERMISSION_MODE` 由 DSH 的 sandbox policy 消费。默认 `workspace-write`：bash 与文件工具只能写 vault 工作区 + 系统临时目录；`read-only` 拒绝写；`danger-full-access` 等同终端运行，可读写 vault 外。
- **二次确认**：`plugin.setPermissionMode()` 是唯一入口；切入 full access 必须经过 `SecurityConfirmModal`，设置页与 chat header 共用。
- **工具后端 ≠ 沙箱**：`DSH_TOOLS_MODE=native|code|both` 只选择工具执行后端；不要把它当权限开关，也不要写 `workspace-write`（v0.1.0 的历史 bug）。
- **凭据**：默认复用用户 `~/.dsh/.credentials.yaml`（symlink，Windows 复制）；可选插件专属 `apiKey` 存插件 `data.json`，运行时注入 `DEEPSEEK_API_KEY` / `OPENCODE_GO_API_KEY`，不写日志、不进诊断报告。
- **网络**：插件自身只在用户点“检查更新”时请求 GitHub Releases；无遥测。
- **写入**：插件写 patch/history/settings 用 temp + rename；history 在 unload 时同步落盘。
- **fail-closed**：DSH 沙箱不可用时返回 `SANDBOX_UNAVAILABLE`，不要降级成无沙箱。

## 9. 测试缝

| 层 | 现状 | 适合怎么测 |
|---|---|---|
| 纯函数 (`pure.ts`, `paths.ts`, `dsh-config.ts`) | 已有单测 | Node 直接测，不需要 Obsidian |
| `DshClient` | 已有注入/替身测试 | 假 child、假 stdout、超时/abort |
| `DshRunner` | 文件系统测试 + temp home | 注入 `userDshHome`，不要写真实 `~/.dsh` |
| `ChatView` | 仅生命周期/面板测试；`test/obsidian-view-double.ts` 已备 | 需要注入 `client` / `runner` 才能测主链路 |
| 真实 DSH | 只能真人部署测试 | 发送、流式、停止、超时、历史恢复 |

主链路测试的目标不是“渲染像素”，而是：prepare → spawn（替身）→ 流事件 → 成功/失败/取消/超时 → history 写入 → 状态回 idle。当前 `ChatView` 在构造函数里直接 `new DshClient()` / `new DshRunner()`，没有注入点，是这项测试的第一道障碍。

## 10. 已知架构债

| # | 债 | 影响 | 处理 |
|---|---|---|---|
| 1 | 无 `RunController`；prepare 失败会卡 running | 状态不一致、难测试、取消/超时边界易错 | 0.1.9 必做 |
| 2 | 主链路无替身测试 | 4 个真 bug 都靠真人发现 | 0.1.9 必做，和 #1 一起 |
| 3 | `ChatView` 1313 行，UI + 编排 + 记忆 + 持久化 | 改动冲突面大，多 agent 难并行 | 先抽 RunController；再评估 MessageList/Composer |
| 4 | `DshRunner` 994 行，6 类职责 | 单测 setup 成本高 | 按需拆 service；不在 0.1.9 大拆 |
| 5 | stream relay 是 `dsh-runner.ts:254` 模板字符串 | 无法 lint/独立测试，改错只能靠生成后比对 | 低风险时抽成 asset + 字节快照测试 |
| 6 | `dsh-runner.ts:8` / `chat-view.ts:10` 从 `settings/index` 反向取类型/常量 | 分层不纯，循环依赖风险 | 改从 `settings/types` / `validate` 导入 |
| 7 | 没有原生会话续跑 | “恢复会话”只是重建记忆 + transcript | 先 spike `dsh --profile tui --resume`；不承诺 |
| 8 | 没有变更审阅 | 用户只能看聊天记录，无法确认/撤销文件改动 | 0.2 做运行后 diff + undo；预写确认另评估 |
| 9 | `DshRunner` 构造时捕获 settings 对象引用 | 当前 `loadSettings` 只在 onload 替换一次，暂安全；未来热重载会失效 | 改成 getter 或每次运行新建 |

## 11. 修改架构时的规则

1. 先改 [`roadmap.md`](roadmap.md) 的决策记录，再动代码；不要用新文档记录状态。
2. 任何跨模块边界的变化，必须同步更新本文的模块表/生命周期/债表。
3. 新增 spawn、路径、写入、网络请求，先检查是否已有单点；没有就建单点，不要复制。
4. 不为了“更干净”做大爆炸重构；每次只抽一个可验证的缝，保持测试绿。
5. 安全相关改动（权限、凭据、沙箱、路径越界）必须有测试 + 真人验证，不能只靠 review。
