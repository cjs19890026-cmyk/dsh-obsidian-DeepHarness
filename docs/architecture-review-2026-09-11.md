# DeepHarness 架构审查与优化方案（2026-09-11）

> 审查范围：全部 src/（31 个 TS 文件）、构建/CI 配置、HANDOFF.md / AI_CONTEXT.md。
> 本次审查未改动任何代码。验证基线（实测）：`npm test` = **236 passed / 2 skipped**（12 个测试文件）。
> 总体判断：**工程质量在 Obsidian 插件里属于上乘**（原子写、env 白名单、killReason 区分、双语 i18n、保护测试齐全）。
> 问题不在"烂代码"，而在四类：交接文档漂移、死代码、三个巨型文件持续膨胀、路径约定散落。

---

## A. 文档与事实漂移（最优先修，零风险）

### A-1 HANDOFF.md 已严重过时，正在误导下一个 agent
| HANDOFF.md 声称 | 实际（实测） |
| --- | --- |
| 当前版本 `0.1.6` | `package.json` / `manifest.json` 均为 `0.1.8` |
| 测试基线 121 / 137 passed | **236 passed / 2 skipped** |
| P2-K / P1-3 "本地完成未提交" | git 工作区干净，HEAD `b76c2ab` 与 origin 同步，且中间已有 0.1.7 / 0.1.8 两个版本的提交 |
| 第 10 节提示词模板让下个 agent "先提交上一轮改动" | 没有可提交的改动，照做的 agent 会困惑甚至误操作 |

文件顶部 9 个"最近交接摘要"层层堆叠，最早的有效信息被埋在最下面。
**建议**：每轮收尾时把过期摘要压缩成一行归档（或单独 `docs/handoff-archive.md`），顶部只留"当前版本 / 当前基线 / 下一步"三条。第 10 节提示词模板同步刷新。

### A-2 AI_CONTEXT.md 两处小错
- "重要约定"编号 1–7 之后又出现 5/6/7（编号断裂）。
- 项目结构清单没有列 `dsh-config.ts` / `diagnostics.ts` / `updates.ts` / `modals.ts` / `context-meter.ts`（均为 HANDOFF 之后新增）。

### A-3 仓库根有无关未跟踪目录 `Minecraft AI/`
与插件无关，`git status` 永远显示一条脏记录，干扰"工作区是否干净"的判断。
**建议**：移出仓库，或加入 `.gitignore`。

---

## B. 死代码（5 处，低风险，建议逐个小提交删除）

| # | 位置 | 问题 | 处置 |
| --- | --- | --- | --- |
| B-1 | `main.ts:11,143-145` + `settings.ts:718` | `vaultPatchInvalidated` 标志**只写不读**。persona 失效已由 `ensureVaultPatch` 的内容比对（marker + `customMissing`）实现，这个标志是旧机制的残骸 | 删字段、`invalidateVaultPatch()`、调用点。删之前确认一次：如果当初意图是"customPersona 变更立即重生成"，那它是个没接完的 bug——但现有内容比对已覆盖该场景，删除是安全的 |
| B-2 | `dsh-config.ts:297` `isEmptySnapshot` | 生产代码无调用方，只被自己的测试引用——测试在给死代码续命 | 删函数 + 对应 3 条测试 |
| B-3 | `dsh-client.ts:73` `DshRunResult.killed` | 注释写明"kept for callers of the old shape"，但生产代码已全部改用 `killReason`，只剩测试在断言它 | 删字段，测试改断言 `killReason !== null` |
| B-4 | `dsh-client.ts:312` `isRunning()` | 全仓库无调用 | 删除 |
| B-5 | `chat-view.ts:55` `statusEl` 私有字段 | 只在 `createStatusElement` 里赋值，全类再无读取（各分支都用局部 `statusEl`）——写-only 字段 | 降为局部变量，删字段 |

---

## C. 结构臃肿（HANDOFF 已预告，但三个文件比记录时更大了）

| 文件 | HANDOFF 记录 | 现在 | 增量来源 |
| --- | --- | --- | --- |
| `chat-view.ts` | 1152 行 | **1347 行** | P2-K 生命周期、P1-3 降级渲染、面板逻辑 |
| `settings.ts` | — | **947 行** | 模型列表编辑器、诊断面板、更新检查 |
| `dsh-runner.ts` | 701 行 | **839 行** | PreparationIssue 收集、原子写、userDshConfig |

每轮"低风险小修复"都在往这三个文件里添砖——拆分越晚越贵。

### C-1 chat-view.ts：先拆最肥的两块，不用等 RunController
- **历史面板 + 技能面板（约 1104–1315 行，~240 行）**：两者共享同一套"浮动面板"机制——锚点定位、`onPanelOutside`、`onPanelKeydown`、互斥开关。抽一个 `FloatingPanel` 基类（约 60 行），`HistoryPanel` / `SkillPanel` 各自独立文件。这是全文件里边界最清晰、最不容易出行为回归的部分，**建议作为拆分第一刀**。
- **sendMessage（408–672 行，~265 行）**：准备阶段（探测 bin/node、patch、DSH_HOME、workdir、降级渲染）与流式渲染、结果分支处理混在一起。可先把"准备阶段"整段抽成 `prepareRun()` 私有方法（返回 `{bin, nodeBin, dshScript, workdir, dshHome, patchPaths}` 或 null），行为零变化，单方法立省 ~70 行，也为以后的 RunController 铺好形状。
- `resumeSession` 与 `sendMessage` 里的 memory 重建逻辑（`answer.split('\n')[0].slice(0, 200)`、slice(-20)）重复，抽一个小函数。

### C-2 settings.ts：三种职责混在一个文件
1. **设置类型 + 校验纯逻辑**（`normalizeStoredSettings` / `mergeModelIds` / option 常量，~380 行）——已经是可单测的形状，留在 `settings.ts` 或挪 `settings-model.ts`。
2. **设置页 UI**（`getSettingDefinitions` 一个方法 ~550 行）——模型列表编辑器、诊断面板、更新检查三块各自独立，可拆成 `settings-tab/` 下三个 render 函数文件。
3. **同步 fs 可写性探测**（`checkWritableDir` / `checkWritableFile`）——这是 I/O，不属于设置页，且 `diagnostics.ts` 的定位就是"环境检查报告"，应迁过去（顺带获得单测）。

另有一个隐患：UI 闭包捕获的是 `const s = this.plugin.settings` 快照，而 `loadSettings` 会**整体替换** `this.settings` 对象。目前只有插件 reload 才会触发，但属于"改了一个不再被读的对象"型 bug 的温床——拆分时应让 render 函数每次从 `this.plugin.settings` 现取。

### C-3 dsh-runner.ts
- `STREAM_RELAY_SRC`（147–217 行）：70 行 JS 以模板字符串内嵌。HANDOFF 已列待办。esbuild 侧可行做法：独立 `src/stream-relay/stream-relay.js` 资源文件，构建时复制到 dist，`ensureVaultPatch` 改为从 bundle 旁读取后写入 generated/。**注意红线**：写入 generated 的内容字节不能变（DLEVENT 协议），迁移后用 diff 验证生成物一致。
- `OPENCODE_GO_PROVIDER_FALLBACK`：YAML 字符串数组，与 `MODEL_OPTIONS` 靠测试防漂移——可接受，但同样适合挪到资源/数据文件。
- `renderLegacyPersonaYaml`：v2 时代的迁移比对代码。现在 `PERSONA_VERSION = 5`，任何无 v5 marker 的文件都会触发重生成，legacy 比对的唯一作用是"避免给旧默认文件留 .bak"。三代之前的默认值不值得继续背——**评估删除**（删了的行为差异：极少数 v2 老用户会多一个无害的 `.bak`）。

---

## D. 约定散落与一致性破口

### D-1 插件路径约定硬编码在 4 处
`plugins/deepharness/generated`、`plugins/deepharness/dsh-home` 散落在：
- `dsh-runner.ts`（`pluginHomeDir` + `ensureSkillDirsPatch` + `ensureVaultPatch` 内联拼路径）
- `main.ts:27`（historyFile 手写模板串）
- `settings.ts:874-876`（诊断 targets 手写拼路径，**没用** `pluginHomeDir()`）

AI_CONTEXT.md 已预告"计划把 dsh-home 迁出 vault 到系统目录"——到那时这 4 处全部要改，漏一处就是生产事故。
**建议**：建 `src/paths.ts`（或给 DshRunner 补 `generatedDir()`），所有消费方单点取路径。这也是迁出 vault 那个大坑的前置条件，优先级应高于 C 类拆分。

### D-2 `diagnose()` 整份透传 process.env
`dsh-runner.ts:286` 跑 `dsh --version` 时 `env: { ...process.env, DSH_HOME }`——项目刚做完子进程 env 白名单（P2-C），这里又开了一个整份透传的口子。虽然只用于诊断，但原则一旦破例就会被复制。
**建议**：复用 `buildDshEnv`（或传最小 env）。

### D-3 DshClient 默认 timer 仍取 `window.*`
依赖注入已做（好），但默认值 `window.setTimeout`（`dsh-client.ts:188-189`）把 window 耦合留在生产代码里——Node 环境下 `new DshClient()` 直接 ReferenceError。
**建议**：默认取 `globalThis.setTimeout`（Electron 渲染进程里同一个函数）。

### D-4 `getChatView()` 只取第一个 leaf，与多视图注册表不一致
`main.ts` 用 `Set<ChatView>` 注册表支持多视图（P2-K），但 `getChatView()` 返回 `leaves[0]`，"问当前笔记"命令只填第一个面板。
**建议**：二选一——要么明确单视图（ribbon/命令复用现有 leaf，注册表仅用于 unload 遍历），要么命令遍历所有视图。现在的状态是"实现支持多开、命令假装单开"。

---

## E. 测试与工程化

| # | 问题 | 建议 |
| --- | --- | --- |
| E-1 | `chip-repro.test.ts` 名字是临时 repro 遗留，且自带一份 Obsidian DOM polyfill | 改名 `chip-editor.test.ts`；polyfill 抽到 `src/test-setup.ts`（vitest `setupFiles`），后续任何 DOM 测试复用 |
| E-2 | 主链路 `ChatView → DshRunner → DshClient → HistoryStore` 仍无测试（HANDOFF 已列） | 等 C-1 拆分后用替身补，不要在现在的 god object 上硬写 |
| E-3 | `styles.css` 1534 行单文件 | 可接受；继续涨再按面板拆（esbuild 单入口 CSS 需调整，不急） |
| E-4 | `i18n/index.ts` 427 行 en/zh 同文件 | 可接受；key 数翻倍后拆 `i18n/en.ts` / `i18n/zh.ts` |

---

## 优化路线图（按风险分层，每层独立可合入）

**阶段 0 — 零风险（文档与卫生）**，每项一个小提交：
1. 刷新 HANDOFF.md（版本、基线、压缩过期摘要、更新第 10 节模板）
2. 修 AI_CONTEXT.md 编号 + 补新文件清单
3. 处理 `Minecraft AI/` 目录（移出或 gitignore）
4. 删死代码 B-1 ~ B-5（每个单独提交，删完跑 `npm test && npx tsc --noEmit && npm run build`）

**阶段 1 — 低风险（一致性收口）**：
5. `src/paths.ts` 单点化插件路径（D-1）——**这是 dsh-home 迁出 vault 的前置，优先级最高**
6. `diagnose()` env 收敛（D-2）、DshClient 默认 timer 改 globalThis（D-3）
7. `chip-repro.test.ts` 改名 + 测试 setup 抽取（E-1）
8. 明确单视图/多视图语义（D-4）

**阶段 2 — 中风险（结构拆分，不动行为）**：
9. 抽 `FloatingPanel` → `HistoryPanel` / `SkillPanel` 独立文件（chat-view 预计 −300 行）
10. `sendMessage` 抽 `prepareRun()`（为 RunController 铺形状）
11. settings.ts 拆三（纯逻辑 / UI / 可写性探测并入 diagnostics）
12. `src/` 引入子目录（`views/` `settings/` `dsh/`），纯文件移动，单独一个提交

**阶段 3 — 高风险（HANDOFF 原定项，最后做）**：
13. stream-relay.js 移出 TS 模板串（diff 验证生成物字节一致）
14. RunController 显式状态机
15. DshRunner 拆分（Resolver / HomePreparer / PatchWriter / Seeder / TaskBuilder）
16. 主链路替身测试
17. （独立专项）dsh-home 迁出 vault——依赖阶段 1 的路径单点化

**执行纪律（沿用 HANDOFF 原则）**：一个提交只碰一个主题；每步跑 `npm test && npx tsc --noEmit && npm run build && npx eslint src/*.ts`；不动 DLEVENT 协议、生成路径、dsh-home 约定、既有 i18n key 文案。
