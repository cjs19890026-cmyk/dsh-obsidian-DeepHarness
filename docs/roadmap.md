# Roadmap — DeepHarness

> **唯一任务与优先级来源。** 状态只写在这里；架构写 [`architecture.md`](architecture.md)，命令写 [`development.md`](development.md)。
> 最后更新：2026-11-26（0.1.8 / 合并基线 `f60d71d` / 294 tests；此后 HEAD 以 git log 为准）。

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
| 分支 | `main`，合并基线 `f60d71d`（28 个提交已合入） |
| 测试 | 294 passed / 2 skipped（14 文件） |
| 已有能力 | 聊天、流式 thinking/tool、停止/超时、历史/恢复、@提及、当前笔记引用、技能、模型/推理/权限、i18n、诊断、更新检查 |
| 已知缺口 | 无 RunController；主链路无替身测试；无变更审阅；无批量；无原生会话续跑；ChatView/DshRunner 偏大 |

## 3. 规划原则

1. **信任优先于功能数量**：一个能撤销的改动，胜过十个炫技功能。
2. **小步可发布**：每个版本有独立用户价值；不做“大爆炸重构”。
3. **真人验证**：UI/生成链路的完成标准是部署后手动走通，不是单测绿。
4. **一个 workstream 一个 agent**：并行可以，但 ChatView 是竞争点，必须串行或先定接口。
5. **不提前承诺**：session 续跑、预写确认这类高不确定项，先 spike 再排期。
6. **每条有验收标准**：没有“完成”的定义就不进 Now。

## 4. Now — 0.1.9「可信运行」

目标：把运行生命周期做成可测试、可恢复的状态机；修掉“准备失败卡 running”这类信任问题。**这个版本可以没有新功能，但必须让后续功能有地基。**

### R1. RunController 显式状态机（P0）

- 新模块：`src/dsh/run-controller.ts`（或 `src/core/run-controller.ts`，二选一，不重复）。
- 状态：`idle / preparing / running / succeeded / failed / cancelled / timedOut`。
- 持有：`AbortController`、超时 timer、`DshClient` 句柄、部分输出、history 元数据。
- 对外：状态事件 + stream/tool 事件 + done；`ChatView` 只订阅渲染。
- 硬性：**任何路径（含 prepare 失败、异常、视图关闭）都必须 cleanup 回 `idle`**。
- 验收：
  - 状态转移单测覆盖所有边（含非法转移）；
  - prepare 失败 → 立即回 idle，按钮回 Send，不再需要用户点 Stop；
  - 取消/超时/非零退出/成功四条路径都有测试；
  - `onClose`/`shutdownForUnload` 后无 DOM 写入。

### R2. 主链路替身测试（P0）

- 给 `ChatView` 增加注入点（`client` / `runner` 或 factory），不改变生产行为。
- 用 `test/obsidian-view-double.ts` + 假 `DshClient`/`DshRunner` 覆盖：
  - prepare → spawn → think/tool 流 → 成功 → history `addTurn`；
  - 失败、取消、超时；
  - 关闭视图 mid-run → partial turn，无异常；
  - DLEVENT 不进入最终答案。
- 验收：新增测试在 CI 稳定；不依赖真实 `dsh` / 网络 / 真实 `~/.dsh`。

### R3. 变更审阅可行性 spike（P0，时间盒 1–2 天）

问题：headless 没有 answerer，**预写确认**很难；先评估**运行后 diff + 撤销**。

要比较的方案：

1. **git 模式**：vault 是 git 仓库时用 `git diff` / `git checkout`；非 git vault 回退。
2. **快照模式**：运行前记录文本文件的 hash/mtime，运行后 diff；撤销需要变更前内容（全量拷贝或按需备份）。
3. **工具事件模式**：从 DSH tool call 捕获写入路径与内容；只能拿到“写后”，不足以撤销。
4. **只读/预演模式**：不写盘，先让 agent 给方案；作为兜底信任手段。

产出：`docs/history/` 下一份决策记录（或 roadmap 决策日志），写清成本、覆盖范围、失败模式、go/no-go。**不要求本版本实现功能。**

### R4. 顺手修（P1）

- `prepareRun` 失败路径的 `running` 泄漏（R1 会覆盖，但可先加回归测试）。
- ✅ 2026-11-26：`src/settings/types.ts:150-152` 的 HANDOFF 引用已改；`src/dsh/dsh-runner.ts:490-499` 的重复错误注释已删；`ensureObsidianSkill` 的旧技能路径注释已修正。
- `dsh-runner.ts` / `chat-view.ts` 从 `settings/index` 的反向依赖改到 `types`/`validate`（低风险，单独 commit）。

## 5. Next — 0.2.0「在笔记里工作」

目标：让用户不打开聊天框也能用 agent，并且改动可见、可撤销。

### F1. 选区动作（P0）

- 命令：`DeepHarness: 处理选中文本`（无选区时禁用）。
- 动作：改写 / 总结 / 解释 / 自定义指令。
- 流程：选中 → 动作 → **预览**（diff 或并排）→ 应用/取消；取消不动原文件。
- 验收：三种动作在真实 vault 走通；取消后文件字节不变；有 DOM/命令测试。
- 依赖：无（可与 R1 并行，但 ChatView 改动需排队）。

### F2. 变更审阅与撤销（P0，取决于 R3）

- 运行后展示：改了哪些文件、每个文件的 diff、新增/删除行数。
- 撤销：一键恢复本次运行前的状态（按 R3 选定的方案）。
- 无 git vault 也要工作；大文件/二进制跳过并明确提示。
- 验收：在临时 vault 上改 3 个文件 → 审阅列表正确 → 撤销后内容与运行前一致；失败时给出手动恢复路径。

### F3. 运行历史/审计（P1）

- 历史记录增加：工具调用、改动文件、耗时、模型/权限、成功/失败原因。
- UI：按会话/时间筛选；不显示凭据；可复制单次运行摘要。
- 验收：一次真实运行后，历史里能看到工具与文件；重开 Obsidian 仍在。

### F4. 批量队列（P1）

- 入口：多选笔记 / 文件夹 / 当前搜索结果（先做一种，别一次全做）。
- 行为：顺序执行、逐项状态（等待/运行/成功/失败/跳过）、可取消、单项失败不终止整批。
- 验收：10 个笔记的批次可跑完；取消后不再启动新项；每项都有历史记录。

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
| Runtime | `src/dsh/run-controller.ts`、`dsh-client.ts`、`dsh-runner.ts`、对应测试 | 1 agent | R1/R2 先做；ChatView 只加注入点，UI 改动交给 UX |
| Workflow UX | `src/views/*`（chat-view、面板、modal）、i18n | 1 agent | 等 R1 接口稳定后再动 ChatView；选区/审阅/批量 |
| Release/Docs | `docs/*`、README、workflows | 可与上面并行 | 不碰 src；发布前统一验证 |
| Research | 无生产代码 | 1 agent | R3/L1 spike，产出决策记录 |

协作规则：

1. 认领时在 roadmap 条目标 `owner` + `in progress`；完成/阻塞时更新。
2. 跨 workstream 的接口先写进 architecture（事件/类型），再各自实现。
3. 合并前由集成者跑四项验证 + 看最终 diff；不要只信子 agent 的“测试通过”。
4. 一个 PR/commit 只做一个主题；冲突时后合并者负责 rebase + 重跑。

## 9. 待用户决策

这些问题会影响排期，先记录，不阻塞 0.1.9：

1. **0.1.9 是否只做可靠性**（RunController + 测试 + 审阅 spike），还是必须带一个用户可见功能？
   - 建议：只做可靠性；0.2.0 再上选区/审阅，避免把地基和功能混在一起。
2. **变更审阅的信任模型**：接受“运行后 diff + 撤销”，还是必须“写前确认”？
   - 建议：先做运行后审阅；写前确认若 DSH 不支持 answerer，成本可能过高。
3. **批量范围**：先做“文件夹批处理”，还是“多选笔记”？
   - 建议：先多选笔记（可控、易验收），文件夹批次放后面。
4. **会话连续性**：愿意为原生 session 投入自定义 runner/profile 吗？
   - 建议：先 spike，不预先承诺；如果成本高，保持“记忆 + transcript 恢复”。

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
