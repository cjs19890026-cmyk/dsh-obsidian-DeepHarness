# deepharness — Obsidian 插件设计文档

> 在 Obsidian 中直接调用 **DeepSeek Harness (DSH)** 完整能力的插件设计。
> 本文档基于对 [Enigmora/claudian](https://github.com/Enigmora/claudian) 源码的深度分析,
> 以及对本机 DSH 运行时 (`@deepseek-ai/dsh@0.1.0-rc.6`) 的实际验证。

---

## 0. 结论摘要

| 项目 | 结论 |
|---|---|
| 插件名 | `deepharness`(显示名 "DeepHarness") |
| 集成方式 | 插件通过 `child_process.spawn` 启动 `dsh --profile headless` 子进程,`cwd` = 当前 vault 根目录 |
| 能力边界 | headless profile 挂载 DSH base 完整工具集:bash、文件读写/编辑/glob/grep、web 搜索、子代理等;受 DSH 自身文件沙箱管控 |
| 已验证 | 本机真实运行 `dsh --profile headless "用 bash 运行 pwd 和 ls..."` → agent 执行工具并返回正确结果,exit 0 |
| 关键差异 | Claudian 是"模型输出 JSON 指令,插件本地执行";本插件是"DSH agent 在运行时内自主用工具执行,插件只负责调用与 UI" |
| 依赖 | 用户机器需安装 DSH(`npm i -g @deepseek-ai/dsh`)并配置好凭据(`~/.dsh/.credentials.yaml` 或 `DEEPSEEK_API_KEY` 环境变量) |
| 平台 | `isDesktopOnly: true`(需要 Node child_process) |

---

## 1. 背景:Claudian 源码架构分析

对 `claudian` 仓库的逐文件分析,提炼出值得借鉴/需要规避的部分:

### 1.1 模块结构

```
src/
├── main.ts                  # Plugin 入口:初始化服务、注册视图/命令/设置页
├── chat-view.ts             # ItemView 聊天面板(流式渲染、Agent 开关、Agentic Loop)
├── claude-client.ts         # Anthropic SDK 封装(流式、错误分级、上下文摘要)
├── agent-mode.ts            # Agent 协议:解析模型返回的 JSON {thinking, actions, message, awaitResults}
├── vault-actions.ts         # 52 种 vault 操作执行器 + 进度回调 + 破坏性操作确认
├── model-orchestrator.ts    # Haiku 分类任务复杂度 → 路由到 Haiku/Sonnet/Opus
├── settings.ts              # 设置面板(i18n、API Key、执行模式、上下文阈值)
├── context-*.ts             # 会话上下文管理(阈值触顶自动摘要、临时文件清理)
├── token-tracker.ts         # Token 用量追踪与历史
├── i18n/                    # 类型安全的多语言系统(en/es/zh/de/fr/ja)
└── ...(truncation/robustness/task-planner 等增强模块)
```

### 1.2 核心交互模式

**Chat 模式**:`ChatView.sendMessage()` → `ClaudeClient.sendMessageStream()` → Anthropic 流式接口 → `MarkdownRenderer.render()` 增量渲染 → 完成后附带"复制 / 存为笔记"按钮。

**Agent 模式**(核心借鉴点):

```
用户消息 → Claude(agent system prompt) → 返回 JSON:
  { "thinking": "...", "actions": [{action, params}...],
    "message": "...", "awaitResults": bool }
→ 插件 VaultActionExecutor 逐个执行(进度条、破坏性操作弹确认框)
→ 结果格式化回传 Claude → 循环(最多 5 轮)→ 最终文本
```

**模型编排**:Haiku 先以极小 token 开销把任务分类为 simple/moderate/complex/deep,再按执行模式(automatic/economic/maximum_quality)路由模型。

**上下文管理**:消息数超过阈值 → 自动生成摘要、把旧消息离线存储,控制 API 成本。

### 1.3 值得借鉴的设计

1. **Agent 响应协议化** — JSON 指令 + 插件执行 + 结果回传的闭环
2. **破坏性操作确认** — `ConfirmationModal` 列出将删除/覆盖的文件,用户确认后才执行
3. **受保护文件夹** — `protectedFolders` 防止误删 templates 等目录
4. **设置面板 UX** — 分组(dropdown/toggle/slider)、即时保存、i18n
5. **欢迎屏 + 个性化示例** — 基于 vault 实际内容生成示例 prompt
6. **错误分级** — 401/429/quota/网络分别给用户可理解的中文提示
7. **Token 追踪 UI** — 会话成本可见

### 1.4 需要规避/重构的

1. **模型即执行者** — Claude 只能输出"意图 JSON",真正操作由插件写 1642 行 `vault-actions.ts` 执行,维护成本高、覆盖面有限
2. **动作集封闭** — 52 个动作写死,新增能力(如"web 搜索")要改插件代码
3. **前后端耦合** — `chat-view.ts` 1400+ 行,流式/回环/鲁棒性逻辑全挤在一个视图类里
4. **会话记忆在插件侧** — 上下文摘要逻辑在插件里重复实现

> **本插件的关键洞察**:DSH 本身就是完整的"agent 运行时 + 工具执行器 + 文件沙箱 + 会话管理"。把执行层交给 DSH,插件只做**桥接 + UI**,即可获得比 Claudian 更广的能力面(任何工具都是"天然动作集"),同时把复杂度移出插件。

---

## 2. 目标与设计原则

### 2.1 目标

1. 在 Obsidian 侧边栏提供聊天界面,消息直接交给 DSH agent 处理
2. agent 以 vault 目录为工作区,可用全部 DSH 工具(vault 文件读写、bash、web 搜索、批量/子代理)
3. 运行过程可视化:状态机(启动/思考/调用工具/完成)、实时文本流、工具调用日志
4. 会话可延续:同一会话内 agent 记住前文
5. 安全默认值:DSH 文件沙箱兜底,插件提供显式确认界面
6. 全部用户可见文案 i18n(en/zh)

### 2.2 设计原则

- **执行层下沉**:所有"做事"的能力由 DSH agent 自主完成;插件不实现任何 vault 操作执行器
- **薄桥接层**:`DshClient` 只负责进程生命周期、输出解析、信号转发
- **可降级**:流式不可用时退回"运行中 → 结果一次输出"
- **尊重 DSH 配置**:沿用用户 `~/.dsh` 的凭据与模型配置,不重复收集 API Key

---

## 3. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ Obsidian (Electron, 桌面端)                                │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ deepharness 插件                                     │  │
│  │                                                      │  │
│  │  ChatView (ItemView) ──── 消息渲染 / 状态机 / 日志    │  │
│  │       │                                              │  │
│  │  DshClient ──── child_process.spawn 管理 / 输出解析  │  │
│  │       │                                              │  │
│  │  DshRunner ──── 命令构造 / patch 层 / 环境变量       │  │
│  │  Settings ──── 路径 / 超时 / 工作区 / 安全选项       │  │
│  └───────┬──────────────────────────────────────────────┘  │
└──────────┼─────────────────────────────────────────────────┘
           │  spawn:
           │    dsh --profile headless --patch <gen>/vault.yml "<任务>"
           │    cwd      = vault 根目录
           │    DSH_HOME = ~/.dsh(或用户指定)
           │    DSH_PERMISSION_MODE = workspace-write(默认)
           ▼
┌────────────────────────────────────────────────────────────┐
│ DeepSeek Harness 运行时(headless bundle)                   │
│                                                            │
│  Agent(deepseek 模型,读 ~/.dsh 凭据与模型配置)            │
│    ├─ 工具: bash │ read/write/edit/glob/grep │ web_search  │
│    │           │ subagent │ job 管理 │ …(与 web 同源)     │
│    ├─ 文件沙箱:默认只写 workspace(= vault)                │
│    └─ session:本次运行的事件流(含工具调用明细)            │
└────────────────────────────────────────────────────────────┘
```

### 3.1 为什么选 headless profile

| 候选方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **headless 子进程** | 零服务、零端口、真实工具集、读用户既有凭据、已验证 | 每次新 agent、默认无流式 | ✅ 主方案 |
| web profile 的 HTTP API | 常驻、有流式 | 内部 Typert RPC 协议,非公开稳定 API,跨进程握手复杂 | ❌ |
| 插件内嵌 SDK 直连模型 | 无 DSH 依赖 | 丢失全部工具能力,等于重造 DSH | ❌ |

### 3.2 环境与前置条件(插件启动时检测并引导)

| 检查项 | 处理 |
|---|---|
| `dsh` 可执行(设置指定路径或 PATH 探测) | 缺失 → 设置页提示 `npm i -g @deepseek-ai/dsh` |
| 凭据可用(`~/.dsh/.credentials.yaml` 或 `DEEPSEEK_API_KEY`) | 缺失 → 提示用户在 DSH web 的 Models 页配置 |
| `dsh --profile headless --help` 可打印 | 说明 profile 可引导,插件可后台预热 |
| vault 路径可作为 cwd | 插件用 `app.vault.adapter.getBasePath()` 获取 |

---

## 4. DSH 集成协议(核心)

### 4.1 进程调用

```ts
// DshRunner 构造的命令(示意)
dsh --profile headless --patch <vaultPatch> "<taskText>"
```

- `taskText`:包含 vault 上下文摘要 + 用户消息 + 会话记忆(见 4.4)
- `--patch <vaultPatch>`:插件生成的一次性覆盖层,注入 vault 专属 persona(见 4.3)
- **退出码语义**(DSH 保证):`0` = turn 正常完成;`1` = 出错(错误信息在 stderr)
- 超时:插件侧 `SIGTERM` 兜底(默认 10 分钟可配)

### 4.2 输出协议

headless runner 的语义(已读源码确认):

- **stdout**:最后一条非空 assistant 文本(所有文本块拼接)+ `\n`
- **stderr**:空 = 成功;`dsh: <CODE>: <message>` = 失败原因
- 进程不监听端口,无守护进程残留

**Phase 2 流式增强**(设计,未在 headless 内置):用 `--patch` 注入一个"事件中继"插件,
在 agent 的 session 事件流上监听 `assistant/message`(文本增量)与工具调用事件,按 **JSON Lines**
协议写到 stdout;插件按行解析实时渲染。补丁示例:

```yaml
# generated/vault-stream.yml (插件生成)
- insert:
    - id: obsidian-stream-relay
      name: '@deepseek-ai/deepharness/stream-relay'
      inject: [loader]
      config: {}
```

(stream-relay 为插件随附的自定义 DSH 插件,~50 行,见 Phase 2 路线图)

### 4.3 vault 专属 persona 覆盖(patch 示例)

```yaml
# generated/vault.yml —— 插件首次使用时生成,可被用户编辑
- id: system-prompt
  config:
    persona: >-
      你是运行在 Obsidian vault 里的 DeepSeek Harness 助手。
      你的工作目录是 {{cwd}},这就是用户的 vault。
      规则:
      1. 新建笔记用 Markdown + YAML frontmatter;笔记间用 [[wikilink]] 互链。
      2. 需要修改 vault 内文件时直接用文件工具完成,不要只给代码。
      3. 破坏性操作(删除/覆盖/移动)前先向用户说明并征得同意。
      4. 回答用用户消息的语言。
```

### 4.4 会话记忆策略

headless 每次新建 agent(随机 sessionId)。为在插件里维持"同一会话"的体验:

| 方案 | 说明 | 阶段 |
|---|---|---|
| **A. 上下文回填** | 插件把会话历史(压缩为要点列表)拼进 taskText 前缀:`[会话记忆] 1. 用户要求… 2. 已创建文件…` | Phase 1(默认) |
| **B. 持久会话 runner** | 自定义 patch:runner 复用 `--session <id>` 恢复既有 session(基于 DSH 的 sessions 存储,`dsh-session` 已是常驻服务) | Phase 2 |
| **C. vault 内记忆文件** | 把长期事实写入 vault 内 `Harness/memory.md`,由 agent 自主读写(利用工具能力,天然可迁移) | Phase 2(可选) |

方案 A 实现零风险、立即可用;方案 B 需要自定义 DSH runner 插件(注入 `dsh-session` 的 load/resume),列入路线图。

### 4.5 运行状态机

```
IDLE ──用户发送──▶ SPAWNING ──进程起来──▶ RUNNING
                                          │
                  ┌───────────────────────┤
                  ▼                       ▼
             (Phase2 流式)          (Phase1 无流式)
           文本增量/工具事件 ──▶   「思考中…」占位
                  │                       │
                  ▼                       ▼
              COMPLETED ◀── stdout 全量文本 ──┘
              FAILED    ◀── stderr 错误 / 非零退出
              CANCELLED ◀── 用户点停止(SIGTERM)
```

---

## 5. 模块设计

### 5.1 `src/main.ts`(Plugin 入口)

- `onload()`:加载设置 → 应用 locale → 初始化 HistoryStore → 注册 ChatView、ribbon 图标、命令、设置页
- 命令:
  - `open-harness-chat` — 打开聊天面板
  - `ask-active-note` — 把当前笔记全文作为任务发给 agent
- `onunload()`:kill 所有存活 dsh 子进程(`DshClient.disposeAll()`)+ 归档当前会话到历史

### 5.2 `src/dsh-client.ts`(薄桥接层,核心)

```ts
interface DshRunResult {
  exitCode: number;
  stdout: string;          // 最终回答(Phase1)
  stderr: string;
  durationMs: number;
}

class DshClient {
  async run(task: string, opts: {
    cwd: string;           // vault 根
    dshBin: string;
    dshHome: string;
    timeoutMs: number;
    patchPath?: string;
    onStdoutLine?: (line: string) => void;   // Phase2 流式
    signal?: AbortSignal;
  }): Promise<DshRunResult>;
}
```

- 用 `child_process.spawn(bin, args, { cwd, env: {...process.env, DSH_HOME, DSH_TOOLS_MODE} })`
- 合并 stdout/stderr 缓冲;超时发 `SIGTERM` 再 `SIGKILL`
- 记录每次运行的 duration 供 UI 展示

### 5.3 `src/dsh-runner.ts`(命令与环境)

- 探测 `dsh`:设置显式路径 > PATH(`which dsh`/`where dsh`)> 常见安装位置
- `--profile headless` 预热:首次运行前执行一次 `--help`(引导 profile 目录)
- 生成/管理 `generated/vault.yml` patch(4.3)
- 任务文本组装:会话记忆 + 上下文(可选附注内容)+ 用户消息

### 5.4 `src/chat-view.ts`(UI)

借鉴 Claudian 的 `ChatView` 骨架,但显著简化:

```
┌──────────────────────────────┐
│ DeepHarness             [⏹] │  ← 停止按钮(运行中)/ 清空
│ ┌──────────────────────────┐ │
│ │ 用户: 把 Projects 里所有  │ │
│ │       #todo 笔记汇总成    │ │
│ │       一份周报            │ │
│ ├──────────────────────────┤ │
│ │ [运行中 23s]              │ │
│ │ ⚙ bash: find Projects …  │ │  ← 工具调用日志(Phase2)
│ │ ⚙ write: 周报.md          │ │
│ │ …                        │ │
│ │ ── 回答(流式/一次渲染)──  │ │
│ │ 已完成,生成了…            │ │
│ │ [复制] [存为笔记]         │ │
│ └──────────────────────────┘ │
│ [输入框…                ] ➤  │
└──────────────────────────────┘
```

- 消息渲染:`MarkdownRenderer.render`(与 Claudian 相同)
- 消息操作按钮:复制 / 存为笔记(借鉴 `note-creator.ts` 的 modal,简化版)
- 运行指示:计时器 + 阶段文案(「启动运行时…」「agent 正在思考…」)
- 停止:`DshClient` 的 AbortSignal → SIGTERM

### 5.5 `src/settings.ts`

| 设置 | 默认 | 说明 |
|---|---|---|
| dsh 二进制路径 | 自动探测 | 留空 = PATH |
| DSH_HOME | `~/.dsh` | 凭据/配置根 |
| 工作目录 | vault 根 | 可限定到 vault 子文件夹 |
| 任务超时(秒) | 600 | SIGTERM 兜底 |
| 会话记忆 | 开 | 方案 A 上下文回填 |
| 显示工具日志 | 开 | Phase2 |
| 语言 | auto | en/zh |
| 自定义 persona | 空 | 追加到 vault.yml |

### 5.6 `src/i18n/`(轻量版)

只保留 Claudian i18n 的核心:类型安全 key、参数插值、`en`/`zh` 两个 locale。不引入 6 语言。

### 5.7 `styles.css`

沿用 Obsidian CSS 变量 + `dsh-` 前缀类名(避免与 claudian 冲突)。

---

## 6. 安全模型

> **实测结论(基于本机 `@deepseek-ai/dsh@0.1.0-rc.6` 源码核查,取代旧版「headless 无沙箱」结论)**:headless profile 的 base bundle **确实挂载了文件沙箱**,`DSH_PERMISSION_MODE` 被 `dsh-sandbox-policy` 消费为「文件效果策略」。bash 与文件工具在 `read-only` / `workspace-write` 下都受到**操作系统级**约束,`danger-full-access` 才关闭约束。插件透传 `DSH_PERMISSION_MODE` 的做法正确。

| 层 | 机制 | 状态 |
|---|---|---|
| 沙箱策略 | `dsh-sandbox-policy` 读 `DSH_PERMISSION_MODE`(默认 `workspace-write`),为每次调用 resolve 出 `mode` + `workspaceRoot`(= session cwd = vault 根) | ✅ 源码已证 |
| bash 工具 | `dsh-bash-sandbox` 用 `ctx.sandbox`(LocalSandboxProvider)包裹 `bash -c`:macOS 走 Seatbelt(`sandbox-exec`)、Linux 走 bwrap/Landlock、Windows 走 ACL 受限令牌;`workspace-write` 只允许写 `workspaceRoot` + `/tmp` + 用户临时目录;无可用后端时 fail-closed(`SANDBOX_UNAVAILABLE`) | ✅ 源码已证 |
| 文件工具 | `dsh-fs-sandbox` 进程内栅栏:`read-only` 拒绝一切变更;`workspace-write` 只允许 canonical 后落在 `writableRoots` 内;与 Seatbelt 共用同一 `writableRoots` 源,bash 与 fs 不会漂移 | ✅ 源码已证 |
| 完全访问 | `danger-full-access` → bash 不包裹、fs 不设栅栏、approval 策略 = `never`;等同终端权限 | ⚠️ 需谨慎 |
| 越权升级 | `sandbox_permissions` 严格更宽阶梯(read-only→workspace-write→danger-full-access),走 approval 通道;headless 无 answerer 时 fail-closed | ✅ 源码已证 |
| 凭据 | 插件不收集任何 API Key;全部走 DSH 既有凭据服务(`~/.dsh`) | ✅ |
| 进程 | 运行超时强制终止;插件卸载时 kill 全部子进程 | ✅ |
| 工具执行模式 | `DSH_TOOLS_MODE` 只接受 `native \| code \| both`(工具后端),**不是**文件沙箱开关;文件沙箱由 `DSH_PERMISSION_MODE` 控制 | ✅ 已修正 |

**注意 1**:`workspace-write` 的写边界 = session cwd(= 插件 `workdir` 解析后的路径)。若 `workdir` 被配置到 vault 之外(如 `..` 或绝对路径),沙箱边界也随之移到那里,所以 `workdir` 必须校验为 vault 内(见审核清单)。

**注意 2(macOS)**:darwin 链只有 `seatbelt` 一个候选且**不探测**直接选用。若宿主 `sandbox-exec` 无法应用 profile(新版 macOS 或受限制环境),bash 会 **fail-closed**(`SANDBOX_UNAVAILABLE`)而非无沙箱运行——即「安全但不可用」。上机前需在目标机器的干净终端里验证 Seatbelt 可用(见测试建议 T0)。

---

## 7. 与 Claudian 的能力对比

| 维度 | Claudian | deepharness |
|---|---|---|
| 执行层 | 插件内置 52 个 vault 动作 | DSH agent 自主工具调用(vault + bash + web + 子代理) |
| 能力扩展 | 改插件代码 | 无感:DSH 新工具即新能力 |
| 模型 | Claude(需 Anthropic Key) | DeepSeek(用 DSH 既有凭据) |
| 会话管理 | 插件内摘要/离线 | DSH session + 插件上下文回填 |
| 安全 | 确认弹窗 + 保护文件夹 | DSH 沙箱 + persona 规则 + (Phase2)diff 确认 |
| UI | 流式 Markdown、Agent 开关 | 流式 Markdown(Phase2 工具日志) |
| 复杂度 | 高(30+ 源文件) | 低(6~8 个源文件) |

---

## 8. 实施路线图

### Phase 1 — MVP(本次脚手架覆盖)
- [x] DshClient 子进程桥接(含超时/取消/错误分级)
- [x] ChatView:发送 → 运行中状态 → 结果渲染 → 复制/存为笔记
- [x] Settings + 环境自检引导
- [x] i18n(en/zh)
- [ ] 用户机器验证:装插件 → 装 DSH → 开聊

### Phase 2 — 流式与可视化
- [ ] `stream-relay` DSH 插件(JSON Lines 事件流)+ patch 注入
- [ ] 工具调用日志 UI(⚙ bash … / ⚙ write …)
- [ ] 文件修改 diff 预览 + 确认(基于会话事件)
- [ ] 会话持久化 runner(`--session <id>`)

### Phase 3 — 深度集成
- [ ] 命令:`ask-selection`(把选中文本作为任务)/ 批量处理 vault 笔记
- [ ] vault 内 `Harness/memory.md` 长期记忆
- [ ] 自定义 profile 生成(替换 --patch,支持用户编辑)
- [ ] 运行历史(复用 DSH sessions 存储,展示历史会话)
- [ ] 概念地图/周报模板等 Claudian 特色功能的 DSH 化实现

### Phase 4 — 云同步 vault 兼容(填坑,见 §10)
- [ ] 插件专属 DSH_HOME 迁出 vault → `~/.dsh/deepharness/<vaultKey>` 或 Obsidian userData
- [ ] spawn 前防线断言:DSH_HOME 绝不在 vaultRoot 之下
- [ ] 升级迁移:检测旧 `<vault>/.obsidian/plugins/deepharness/dsh-home`,复制用户数据 + 异步删旧树
- [ ] 清理/改写 AI_CONTEXT 红线第 1 条(dsh-home 路径依赖)与 DESIGN §3 的 DSH_HOME 示意

---

## 9. 已验证事实清单(本机实测)

1. `dsh --profile headless --help` 正常输出(在可写 DSH_HOME 下)
2. `dsh --profile headless "用 bash 运行 pwd 和 ls…"` 端到端成功:
   agent 真实调用 bash 工具、返回正确中文回答、exit 0
3. headless runner 源码确认:stdout = 最终文本;stderr = 错误;随机 sessionId;
   `cwd: process.cwd()`;无监听端口
4. 凭据读取路径:`~/.dsh/.credentials.yaml`(web Models 页写入),headless 复用同一 DSH_HOME 即可
5. `--patch` 覆盖层机制确认(base bundle 行按 id 覆盖,user layer 最后生效)—— Phase 2 流式/会话方案基于此
6. web profile 的 HTTP 通道是内部 Typert RPC,不适合第三方 → 已排除

## 10. 已知限制与对策

| 限制 | 对策 |
|---|---|
| headless 单次任务、无内置流式 | Phase 1 显示运行状态;Phase 2 用 patch 注入流式 |
| 会话不跨进程 | Phase 1 上下文回填;Phase 2 持久 runner |
| 需要用户预装 DSH 与凭据 | 插件设置页给出明确引导步骤(检测 + 文案) |
| 移动端不支持 | `isDesktopOnly: true` |
| 每次启动有模型推理延迟(冷启动) | 预热 profile;状态机明确展示「启动中」 |
| **⚠️ 插件专属 DSH_HOME 建在 vault 内(`<vault>/.obsidian/plugins/deepharness/dsh-home`)**:dsh 首次运行在该 home 下自举 `profiles/node_modules` 依赖树(几百包/数万文件)。macOS 为 symlink 农场(530 链接,无害);Windows 无开发者模式时退回实体拷贝 → 数万小文件进入 iCloud/OneDrive 同步队列 → 云同步卡死(用户 Issues 实证) | **待修(架构层)**:DSH_HOME 迁出 vault 到系统用户目录(`~/.dsh/deepharness/<vaultKey>` 或 Obsidian userData),vault 内只留三件套 + 用户可编辑小文本;spawn 前断言 DSH_HOME 不在 vaultRoot 下;升级时检测/迁移/清理旧树。详见 MAINTENANCE.md 2026-09-03 条目 |
