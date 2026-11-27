# Roadmap — DeepHarness

> **唯一任务与优先级来源。** 状态只写在这里；架构写 [`architecture.md`](architecture.md)，命令写 [`development.md`](development.md)。
> 最后更新：2026-11-27（F3/F4 代码与自动测试完成，待在真实 vault 手测；339 tests；此后 HEAD 以 git log 为准）。

## 1. 方向：从“聊天面板”到“可信的 vault 工作流 agent”

DeepHarness 已经证明了一件事：DSH 的完整工具链可以在 Obsidian 里跑起来，且能读写真实 vault。下一阶段不再比“谁的聊天框更好看”——DSH 自己的 Web UI 就在做这件事。**Obsidian 侧的差异化只有两个：vault 上下文，和工作流。**

因此方向定为：

> **让用户敢把重要笔记交给 agent，并让 agent 融入“读—改—审—继续”的笔记工作流，而不是一次性聊天。**

三个支柱，按顺序：

1. **可信（Trust）**：用户能看见 agent 改了什么、能撤销、能限制范围。没有这一层，批量/自动化都不敢开。
2. **工作流（Workflow）**：选区动作、批量队列、运行历史；从“打开聊天框”变成“在笔记里直接调用”。
3. **连续性（Continuity）**：跨会话继续任务、记住项目上下文；这是最难、最不确定的一块，放在信任与工作流之后。

**不做什么**：不做通用 RAG、不做云端、不做移动端、不复制 DSH Web 的全部功能、不在插件里重新实现 agent 循环。

## 2. 当前基线

| 项 | 值 |
|---|---|
| 版本 | 0.1.8（`package.json` / `manifest.json`） |
| 分支 | `main`；R1/R2/F1/F2 手测后合入（HEAD 以 git log 为准） |
| 测试 | 339 passed / 2 skipped（22 文件） |
| 已有能力 | 聊天、流式 thinking/tool、停止/超时、历史/恢复、@提及、当前笔记引用、技能、模型/推理/权限、i18n、诊断、更新检查 |
| 已知缺口 | 无批量队列；无原生会话续跑；无预写确认；ChatView 1489 行 / DshRunner 994 行仍偏大 |

## 3. 规划原则

1. **信任优先于功能数量**：一个能撤销的改动，胜过十个炫技功能。
2. **小步可发布**：每个版本有独立用户价值；不做“大爆炸重构”。
3. **真人验证**：UI/生成链路的完成标准是部署后手动走通，不是单测绿。
4. **一个 workstream 一个 agent**：并行可以，但 ChatView 是竞争点，必须串行或先定接口。
5. **不提前承诺**：session 续跑、预写确认这类高不确定项，先 spike 再排期。
6. **每条有验收标准**：没有“完成”的定义就不进 Now。

## 4. Now — 0.1.9「可信运行」

目标：把运行生命周期做成可测试、可恢复的状态机；修掉“准备失败卡 running”这类信任问题。**这个版本可以没有新功能，但必须让后续功能有地基。**

### R1. RunController 显式状态机（P0）— done（2026-11-26，真实 UI 手测通过）

- 实际模块：`src/views/run-controller.ts`（不是 `src/dsh/`）。
- 状态：`idle / preparing / running / succeeded / failed / cancelled / timedOut`。
- 持有：当前状态、`RunHandle`（id + `AbortSignal`）、stale-handle 防护；**不持有** client/超时 timer/输出——超时仍由 `DshClient` 的 `timeoutMs` 执行。
- `start()` 仅 idle；`markRunning()` 仅 preparing；`succeed()` 仅 running；`fail()/cancel()` 任意 active；`timeout()` 仅 running；`finish()` 无条件回 idle。
- 验收（2026-11-26）：
  - 8 个状态转移单测（happy path、二次 start、cancel、preparing 阶段 cancel、prepare fail、timeout、stale handle、dispose）；
  - prepare 失败 → 按钮回 Send，stuck-Stop 回归测试通过；
  - 成功/失败/取消/超时四条主链路测试通过；
  - 关闭视图路径由 `shutdownForUnload` + `savePartialTurn` 覆盖（非 DOM 写入）。
- 未做：把 client/stream/history 也并入 controller；当前是刻意轻量实现。
- 2026-11-26 用户真实 UI 手测通过；发送/停止/恢复 Send 正常。

### R2. 主链路替身测试（P0）— done

- `ChatView` 新增 `ChatViewDeps { client?; runner? }`；生产仍构造真实实现，测试注入 fake。
- `src/views/chat-view-run.test.ts`：7 tests（成功、取消、超时、非零退出、prepare 失败恢复 Send、并发拒绝、运行后变更审阅）。
- 使用 `test/obsidian-view-double.ts` + 假 `DshClient`/`DshRunner`；不依赖真实 `dsh` / 网络 / `~/.dsh`，CI 稳定。

### R3. 变更审阅可行性 spike（P0）— decision

- 决策：采用**快照模式**，直接实现为 F2；不再单独做 1–2 天 spike。
- 理由：git 模式只覆盖 git vault；工具事件只能拿到“写后”，不足以撤销；只读/预演不能替代实际撤销。快照模式对所有 vault 一致，成本可控（仅 Markdown + 上限）。
- 遗留：大 vault 的启动延迟、分散编辑的 diff 可读性，列入 §10 架构债。

### R4. 顺手修（P1）— done（`fb062a5`）

- ✅ `prepareRun` 失败路径的 `running` 泄漏已由 RunController + `finally` 修复，并有回归测试。
- ✅ 2026-11-26：`src/settings/types.ts:150-152` 的 HANDOFF 引用已改；`src/dsh/dsh-runner.ts:490-499` 的重复错误注释已删；`ensureObsidianSkill` 的旧技能路径注释已修正。
- ✅ `dsh-runner.ts` / `chat-view.ts` 从 `settings/index` 的反向依赖改到 `types`/`validate`（`fb062a5`）。

## 5. Next — 0.2.0「在笔记里工作」

> F1/F2 已完成并手测通过；F3/F4 代码与自动测试完成，待在真实 vault 手测。已完成条目保留作验收记录。

目标：让用户不打开聊天框也能用 agent，并且改动可见、可撤销。

### F1. 选区动作（P0）— done（2026-11-26，真实 vault 手测通过）

- 命令：`ask-selection`（`DeepHarness: 处理选中文本`；无选区时提示）。
- 动作：改写 / 总结 / 解释 / 自定义指令。
- 流程：选中 → 动作 → **预览**（diff 或并排）→ 应用/取消；取消不动原文件。
- 验收：三种动作在真实 vault 走通；取消后文件字节不变；有 DOM/命令测试。
- 2026-11-26 状态：`src/views/selection-modals.ts` + `ChatView.beginSelectionAction` + `main.ts` 命令已实现；3 个流测试通过；用户真实 vault 手测 Replace/Insert/取消通过。
- 依赖：无（可与 R1 并行，但 ChatView 改动需排队）。

### F2. 变更审阅与撤销（P0）— done（2026-11-26，真实 vault 手测通过）

- 运行前 `snapshotVault()` 只读 Markdown（上限 2000 文件 / 512KB / 64MB，超限提示 incomplete）；运行后 `diffSnapshots()`。
- 有变更时打开 `ChangeReviewModal`：逐文件路径 + created/modified/deleted + 紧凑 `-/+` diff；逐文件撤销 / 全部撤销 / 保留。
- 无 git vault 也工作；二进制/大文件跳过并明确提示；选区运行跳过审阅（避免与预览双 modal）。
- 验收：7 个 tracker 单测 + 4 个 modal 单测 + 1 个 ChatView 集成测试通过；2026-11-26 用户在真实 vault 手测逐文件/全部撤销通过。
- 已知限制：diff 是公共前后缀 + 单块，不覆盖分散多处编辑；运行前全量读 Markdown 的耗时待真实 vault 观察。

### F3. 运行历史/审计（P1）— in progress（代码+自动测试完成，真实 vault 手测待）

- `HistoryTurn` 已增加 `status/model/effort/permission/changedFiles/exitCode/killReason/error`；成功/失败/取消/超时/中断都落历史；工具记录不再受 `showTools` 显示开关影响。
- 历史面板已支持按标题/备注筛选、7/30 天范围、展开详情（turns/耗时/工具/文件/错误/逐轮状态）和复制摘要。
- 验收：一次真实运行后，历史里能看到工具与文件；重开 Obsidian 仍在。
- 2026-11-27 状态：`src/core/history.ts` + `src/views/chat-view.ts` + `src/views/history-panel.ts` 已完成；9 个 history 单测、7 个主链路测试、14 个面板测试通过。

### F4. 批量队列（P1）— in progress（代码+自动测试完成，真实 vault 手测待）

- 入口：先做**多选笔记**（`batch-notes` 命令 + 搜索/全选/清空），文件夹/搜索结果后放。
- 行为：顺序执行、逐项状态（pending/running/succeeded/failed/cancelled）、可取消、单项失败不终止整批；整批一次快照、一次结束审阅；整批一个 history session。
- 验收：10 个笔记的批次可跑完；取消后不再启动新项；每项都有历史记录；ChatView 在批量期间拒绝新运行。
- 2026-11-27 状态：`src/core/batch-controller.ts` + `src/dsh/batch-runner.ts` + `src/views/batch-modal.ts` + `main.ts` 编排已实现；4 个队列测试、4 个执行器测试、4 个弹窗测试通过。

## 6. Later — 0.3+

这些方向有价值，但**先 spike / 先等用户信号**，不放进近期承诺。

### L1. 原生会话连续性（研究）

- 现状：`dsh --profile headless` 没有 `--session`；`dsh --profile tui --resume <id>` 存在。
- 要回答：能否用自定义 profile / runner 在 headless 下恢复 session？成本、稳定性、与历史/记忆的关系？
- 产出：spike 报告 + go/no-go；go 才排期。**在完成前，UI 不得承诺“继续上次会话”。**

### L2. 自定义 DSH profile

- 让高级用户选择/编辑 profile（工具集、persona、插件），而不是固定 headless。
- 风险：配置兼容、错误提示、支持成本；先做只读选择，不做在线编辑。

### L3. 技能编辑 UX

- 目前技能是文件系统 + `/` 调用；用户明确暂缓“对话内创建技能”。
- 可做：技能列表、打开文件、校验、启用/禁用；不做可视化编程。

### L4. Recipes（内容，不是核心）

- 周报、概念地图、文献综述等模板/技能包；以文档/示例为主，避免把产品做成固定流程工具。

## 7. 非目标 / 明确暂缓

- 大拆 `DshRunner` / `ChatView`（先 RunController；其余按需）。
- stream-relay 资源化（除非正在改 relay；否则低收益）。
- `styles.css` / `i18n` 拆分（纯整理，无用户价值）。
- 移动端、自动更新、云端同步、多用户。
- 对话内创建/编辑技能（用户已明确暂缓）。
- 通用 RAG / 向量库（DSH 的上下文能力优先）。

## 8. 并行 agent 工作流

新 agent 入场时，先读 `AGENTS.md`，再认领一个 workstream。**不要两个 agent 同时改 `src/views/chat-view.ts`。**

| Workstream |  ownership | 适合并行度 | 备注 |
|---|---|---|---|
| Runtime | `src/views/run-controller.ts`、`src/dsh/batch-runner.ts`、`src/dsh/dsh-client.ts`、`src/dsh/dsh-runner.ts`、对应测试 | 1 agent | R1/R2/R4 已完成；F3/F4 待手测；下一步性能收敛 |
| Workflow UX | `src/views/*`（chat-view、面板、modal）、i18n | 1 agent | F1/F2/F3/F4 已接入；待真实 vault 手测；ChatView 串行 |
| Release/Docs | `docs/*`、README、workflows | 可与上面并行 | 不碰 src；发布前统一验证 |
| Research | 无生产代码 | 1 agent | R3 已决策；剩 L1 会话连续性 spike |

协作规则：

1. 认领时在 roadmap 条目标 `owner` + `in progress`；完成/阻塞时更新。
2. 跨 workstream 的接口先写进 architecture（事件/类型），再各自实现。
3. 合并前由集成者跑四项验证 + 看最终 diff；不要只信子 agent 的“测试通过”。
4. 一个 PR/commit 只做一个主题；冲突时后合并者负责 rebase + 重跑。

## 9. 待用户决策 / 已决

已决（2026-11-26）：

1. **0.1.9 不发布**：R1/R2/F1/F2 作为内部里程碑，合并后随 0.2.0 发布；不 bump manifest、不打 tag。
2. **变更审阅**：采用“运行后快照 diff + 显式撤销”；预写确认暂不做（headless 无 answerer）。
3. **并行方式**：Runtime 先做 R1/R2；Workflow UX 后动 ChatView；Research 只做 spike。
4. **F1/F2 验收**：2026-11-26 用户真实 vault 手测通过（选区 Replace/Insert/取消、逐文件/全部撤销）。
5. **F3/F4 范围**：F3 先补审计与历史详情；F4 先做多选笔记、批量结束一次审阅；0.1.9 不发布。

仍待用户决定：

1. **批量范围**：先做“文件夹批处理”，还是“多选笔记”？
   - 建议：先多选笔记（可控、易验收），文件夹批次放后面。
2. **会话连续性**：愿意为原生 session 投入自定义 runner/profile 吗？
   - 建议：先 spike，不预先承诺；如果成本高，保持“记忆 + transcript 恢复”。
3. **大 vault 的审阅成本**：是否加设置开关/按 workdir 缩小快照范围？
   - 建议：先观察真实耗时，再决定；默认保留 2000 文件/512KB/64MB 上限。

## 10. 状态与更新规则

- 状态：`todo` / `in progress` / `done` / `blocked` / `decision`。
- 只有**四项验证 + 真人测试**通过才能标 `done`；否则写回 `todo` 并注明阻塞。
- 每次发布后更新 §2 基线；方向变化写 §9 决策日志（日期 + 结论 + 理由）。
- 不在本文堆历史细节；已完成的大段过程放 `docs/history/`。

### 决策日志

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-11-26 | 28 个提交 fast-forward 合并到 `main`，0.1.9 从 main 切 | 长期分支债；main 是祖先，0 冲突；文档/CI 回到事实源 |
| 2026-11-26 | 文档收敛为 AGENTS + architecture + development + roadmap | 旧 HANDOFF/AI_CONTEXT/DESIGN 重复且过期；agent 入口必须唯一 |
| 2026-11-26 | 方向定为“可信的 vault 工作流 agent” | 聊天本身打不过 DSH Web；Obsidian 的差异化是 vault 上下文 + 工作流 |
| 2026-11-26 | 变更审阅先做运行后 diff + 撤销，预写确认另评估 | headless 无 answerer；先解决“敢用”，不追求一步到位 |
| 2026-11-26 | 0.1.9 不发布；R1/R2/F1/F2 合并后随 0.2.0 发布 | 用户决定暂不发版；先把可靠性/工作流做完再给用户可见版本 |
| 2026-11-26 | RunController 放 `src/views/`，只持有状态 + AbortSignal | 不扩大改动面；client/stream/history 仍由 ChatView 编排，先修 stuck-Stop |
| 2026-11-26 | 变更审阅采用运行前后 Markdown 快照，直接实现为 F2 | git 模式只覆盖 git vault；工具事件拿不到写前内容；只读模式不能替代撤销 |
| 2026-11-26 | `feat/trusted-run-and-selection` 手测通过后合入 `main` | R1/R2/F1/F2 四项验证 + 真人测试通过；0.2.0 从 main 继续 |
