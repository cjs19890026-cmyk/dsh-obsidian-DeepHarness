# DeepHarness 渐进式修复与重构交接文档

> 本文档用于给下一个写代码的 agent 做交接。项目路径：
> `/Users/mymac/deepseek workplace/dsh-obsidian-deepharness-new-architecture`
>
> 当前版本：`0.1.6`。目标：在不破坏现有功能的前提下，先修复明确 bug 和发布风险，再补测试保护，最后渐进式拆分结构。
> 本文档不修改代码，只记录问题、目标架构、实施顺序、测试与验收标准。

## 执行原则（非常重要）

1. **不要一上来做大重构**。第一批只做低风险、可验证的小修复。
2. **每一步都必须保持现有 UI 和功能行为不变**，除非本阶段明确要求修复某个 bug。
3. **每个阶段独立可合入**：一次只处理一个小主题，改完立即跑测试、类型检查和构建。
4. **先让项目更安全，再让结构更好**：优先处理超时误报、CI 可复现、版本不一致、模型 fallback、目录越界等明确问题。
5. **AI 执行时禁止“顺手重写”**：不要同时拆 `chat-view.ts` 和 `dsh-runner.ts`；不要把样式、文案、架构迁移混在同一批改动里。

---

## 当前交接重点：第一/二阶段已完成，下面为剩余任务

### 最近交接摘要（本轮收尾：P1-5 / P2-H / P2-I / 发布前必办 完成并已推送，2026-09-03，HEAD 78134a2 与远程同步）
- 本轮会话完成 4 个批次并**全部推送**到 origin/dsh-obsidian-deepharness-new-architecture（`31b06d0..78134a2`，共 9 个提交，经 `git -c http.proxy= -c https.proxy= push`，无 ahead/behind）：
  - P1-5 设置选项 union 化 + loadSettings 非法值回退（`2b039a1`，+6 测试）
  - P2-H linkifyAnswer 缓存 + vault 变更失效（`7d453d3`，frontmatterAliases 抽纯函数 +3 测试）
  - P2-I scanSkills 缓存 + 失效（`8d085b6`）
  - 发布前必办：pin `obsidian` 1.13.1（`6e7f257`）+ Actions v4 / tag↔manifest 版本校验（`dddb738`）
  - 每批附 docs(handoff) 提交；下方各批摘要里的“未推送”为写入时状态，实际均已推送。
- 验证基线：npm test = 121 passed / 2 skipped；npx tsc --noEmit、npm run build、npx eslint src/*.ts（0 errors）全部通过。
- 剩余任务：第 1 节（发布前必办）与第 2 节（低风险修复）已清零；剩 **P2-K（运行生命周期，中等风险，建议单独一轮）** 与 **P1-3（降级失败 UI 可见）**；之后才进结构拆分阶段（RunController / 拆分 DshRunner / ChatView 等）。
- 给下一个 agent 的提示词模板见文末第 10 节（已随本轮刷新）。

### 最近交接摘要（发布前必办：obsidian 版本固定 + Actions v4 + tag/manifest 校验，2026-09-03，已提交 6e7f257 / dddb738，未推送）
- 已完成：**剩余任务第 1 节「发布前必须完成」全部 3 条**。
- 改动：
  - package.json：`"obsidian": "latest"` 固定为精确 `"1.13.1"`（与 node_modules / lock 内 `node_modules/obsidian` 1.13.1 一致；typings 继续支持 1.13 声明式设置 API，manifest minAppVersion 1.13.0）。
  - package-lock.json：root devDependencies spec 同步为 `"1.13.1"`（`npm install --package-lock-only --offline` 生成；`npm ci --dry-run` 通过）。提交 hash：`6e7f257`。
  - .github/workflows/release.yml：checkout/setup-node v3→v4；新增「Assert tag matches manifest version」步骤（`GITHUB_REF#refs/tags/` 去 v 后须等于 manifest.json.version，不等则 ::error:: + exit 1）。
  - .github/workflows/ci.yml：checkout/setup-node v3→v4。提交 hash：`dddb738`。
- 验证基线：npm test = 121 passed / 2 skipped，npx tsc --noEmit、npm run build、npx eslint src/*.ts（0 errors）全部通过；tag 比对脚本本地模拟通过。
- 均未推送。无 DLEVENT / 生成路径 / dsh-home 约定改动；无 UI / i18n 改动。

### 最近交接摘要（P2-I scanSkills 缓存 + 失效，2026-09-03，已提交 8d085b6，未推送）
- 已完成：**P2-I scanSkills 缓存**（剩余任务「下一批低风险代码修复」）。
- 改动文件：
  - src/chat-view.ts：`scanSkills()` 按 `vaultRoot + extraSkillDirs` 键缓存结果（新字段 `skillCache`），拆出 `scanRoots(vaultRoot)`；缓存被以下事件置脏：vault create/delete/rename/modify（与 P2-H 的 linkify 缓存共用 onOpen 里同一个 `invalidateCaches` 处理器）+ 任意设置保存（extraSkillDirs 变更时 `onSettingsChange` 清空）。
- 效果：🔧 技能面板与 `/` 建议弹出不再每次同步 `readdirSync`/`readFileSync` 扫盘；vault/设置实际变更后下一次打开自动重建。行为/文案零变化。
- 验证基线：npm test = 121 passed / 2 skipped，npx tsc --noEmit、npm run build、npx eslint src/*.ts（0 errors）全部通过。
- 已提交（hash：`8d085b6`），尚未推送。
- 无 DLEVENT / 生成文件路径 / dsh-home 约定改动；未拆 chat-view.ts / dsh-runner.ts。

### 最近交接摘要（P2-H linkifyAnswer 缓存 + vault 变更失效，2026-09-03，已提交 7d453d3，未推送）
- 已完成：**P2-H linkifyAnswer 缓存**（剩余任务「下一批低风险代码修复」）。
- 改动文件：
  - src/pure.ts：新增纯函数 `frontmatterAliases(raw)`（数组 / 逗号分隔字符串 / 垃圾值 → string[]），从 chat-view 的别名解析抽出。
  - src/pure.test.ts：+3 测试（数组含非字符串元素 / 逗号串去空 / 非数组非字符串垃圾）。
  - src/chat-view.ts：新增 `linkifyEntries: NoteTitleEntry[] | null` 缓存 + `collectNoteInfos()`；`linkifyAnswer` 仅在缓存为空时全库扫描；`onOpen` 里 `registerEvent(vault.on create/delete/rename/modify)` 置脏缓存（视图卸载自动解绑）。
- 效果：单条回答、会话恢复渲染多条历史消息时不再每条全库 `getMarkdownFiles()` + 读 metadataCache；vault 实际变更后下一次回答自动重建索引。行为/文案零变化。
- 验证基线：npm test = 121 passed / 2 skipped（原 118 + 3），npx tsc --noEmit、npm run build、npx eslint src/*.ts（0 errors）全部通过。
- 已提交（hash：`7d453d3`），尚未推送。
- 无 DLEVENT / 生成文件路径 / dsh-home 约定改动；未拆 chat-view.ts / dsh-runner.ts。

### 最近交接摘要（P1-5 设置选项 union 化 + 加载时非法值回退，2026-09-03，已提交 2b039a1，未推送）
- 已完成：**P1-5 `DshSettings` 选项字段收窄 + `loadSettings` 非法值回退**（剩余任务「运行生命周期与降级可见化」首条）。
- 改动文件：
  - src/settings.ts：新增 option 推导 union（`ProviderId` / `ModelId` / `ReasoningEffort` / `PermissionMode` / `ToolExecutionMode`，含 `TOOL_EXECUTION_MODES` 常量），`DshSettings` 的 provider / model / reasoningEffort / permissionMode / toolExecutionMode 由 string 收窄；toolMode 下拉改遍历 `TOOL_EXECUTION_MODES`（文案不变）；新增 `normalizeStoredSettings(raw)` —— 选项字段非法/非字符串值时回退 `DEFAULT_SETTINGS`，返回被修正字段列表。
  - src/main.ts：`loadSettings` 改走 `normalizeStoredSettings`；有修正时愈合 data.json（保存一次）并在 applyLocale 后弹一次 Notice（新 i18n key `settings.storedOptionReset`）；旧 toolsMode 迁移逻辑保留且合并为单次保存；`setPermissionMode(mode: PermissionMode)` 收窄。
  - src/chat-view.ts：`applyPermissionMode` 参数收窄为 `PermissionMode`。
  - src/i18n/index.ts：新增 `settings.storedOptionReset`，en/zh 成对。
  - src/settings.test.ts（新）：+6 测试（合法值保留 / 各字段非法回退 / 非字符串类型回退 / 未存储字段不报 / 非对象数据 / 结果均在选项集内）。
- 验证基线：npm test = 118 passed / 2 skipped（原 112 + 6），npx tsc --noEmit、npm run build、npx eslint src/*.ts（0 errors）全部通过。
- 已提交（hash：`2b039a1`），尚未推送。
- 无 DLEVENT / 生成文件路径 / dsh-home 约定改动；未拆 chat-view.ts / dsh-runner.ts；无既有 key 文案改动。

### 最近交接摘要（HistoryStore 默认标题走 i18n，2026-09-03，已提交 84596f0，未推送）
- 已完成：**HistoryStore 默认标题 i18n**（P2-J / 剩余任务“下一批低风险代码修复”）。
- 改动文件：
  - src/history.ts：titleFromTurn 兜底 '新会话' → t('chat.newSession')；顺带把局部变量 t 改名 title，消除对 i18n t() 的遮蔽（这是该函数之前硬编码中文的根因）。
  - src/history.test.ts：+1 测试——首条消息为空白时，会话标题取 t('chat.newSession')（测试 locale 默认 en → New session），并断言不是硬编码 新会话。
- 验证基线：npm test = 112 passed / 2 skipped（原 111 + 1），npx tsc --noEmit、npm run build、npx eslint src/*.ts（0 errors）全部通过。
- 已提交（hash：`84596f0`），尚未推送。
- 本批低风险修复（env 白名单 → P2-D → 原子写 → HistoryStore i18n）告一段落：`bf9915d` / `ad61a92` / `c68aa17` / `84596f0` 均已本地提交、未推送；后续开发交给下一个 agent，模板见文末第 10 节。

### 最近交接摘要（生成文件原子写，2026-09-03，已提交 c68aa17，未推送）
- 已完成：**生成文件原子写**（P2-G / 剩余任务“下一批低风险代码修复”）。
- 改动文件：
  - src/dsh-runner.ts：新增模块级 `writeFileAtomicSync(file, content)`（同目录 tmp + rename，参考 `HistoryStore.save`），并把以下写点全部改为原子写：
    - `ensurePluginDshHome`：dsh-home/settings.yaml
    - `ensureVaultPatch`：generated/vault.yml（创建与重新生成两处）、vault.yml.bak、stream-relay.js、stream.yml
    - `ensureSkillDirsPatch`：generated/skill-dirs.yml
  - src/dsh-runner.test.ts：+3 测试（三个 ensure* 函数各自写入后目录内无 *.tmp 残留，且目标文件内容正确）。
- 说明：`ensureMemoryFile` / obsidian-skill 写入不在本批范围（任务只列三个 ensure*）；父目录 mkdir/chmod 逻辑未动；无用户可见文案、无协议/路径约定改动。
- 验证基线：npm test = 111 passed / 2 skipped（原 108 + 3），npx tsc --noEmit、npm run build、npx eslint src/*.ts（0 errors）全部通过。
- 已提交（hash：`c68aa17`），尚未推送。

### 最近交接摘要（P2-D API Key 明文存储风险提示，2026-09-03，已提交 ad61a92，未推送）
- 已完成：**P2-D 设置页 API Key 明文存储风险提示**（不做 keychain——见下方评估结论）。
- 改动文件：
  - src/i18n/index.ts：新增 `settings.apiKey.warning` key，en/zh 成对。
  - src/settings.ts：API Key 设置项在其 desc 下按需显示 `.dsh-setting-warning` 警告行（有 key 才显示；输入时实时显隐，不清空则不打扰）。
  - styles.css：新增 `.dsh-setting-warning`（颜色 `var(--text-warning, #d29922)`）。
- keychain 评估结论：当前不改用 keychain。原因：Obsidian 插件（Electron 渲染进程）无法直接调系统钥匙串，需 spawn `security`（macOS）/ Credential Manager（Windows）/ libsecret（Linux）等外部工具，三平台行为与失败模式不同，且 key 会随 vault/插件 data.json 同步，迁移成本高、收益有限；本轮按 P2-D 原方案落地「设置描述 + 风险提示」。
- 验证基线：npm test = 108 passed / 2 skipped，npx tsc --noEmit、npm run build、npx eslint src/*.ts（0 errors）全部通过。
- 已提交（hash：`ad61a92`），尚未推送。

### 最近交接摘要（子进程 env 白名单，2026-09-03，已提交 bf9915d，未推送）
- 已完成：**子进程环境变量白名单**（P2-C / 剩余任务“下一批低风险代码修复”第 2 条）。
- 改动文件：
  - src/dsh-client.ts：新增导出 DSH_ENV_ALLOWLIST（继承白名单）+ buildDshEnv(opts, sourceEnv)（分层：白名单继承 → opts.env 显式注入 → 插件注入项 DSH_HOME / API key / DSH_TOOLS_MODE / DSH_PERMISSION_MODE → nodeBin 目录前置 PATH）。DshClient.run 不再把整个 process.env 传给 dsh 子进程，只构造白名单 + 注入项；顺带修正了 spawnFn / startedAt 的缩进。
  - src/dsh-client.test.ts：+8 测试 = buildDshEnv 纯函数 7 条（白名单继承 / 空 env / opts.env 合并 / 默认 provider 的 DEEPSEEK_API_KEY / 插件项覆盖 / 带 source PATH 的 nodeBin PATH 前置 / 无 source PATH 时的 fallback）+ fake spawn env 隔离 1 条（断言 spawn env 只含白名单 ∪ 插件注入项，不泄漏非白名单 process.env 键）。
- 验证基线：npm test = 108 passed / 2 skipped（原 100 + 8），npx tsc --noEmit、npm run build、npx eslint src/*.ts（0 errors）全部通过。
- 已提交（hash：`bf9915d`），尚未推送。
- 无 i18n 文案、无 DLEVENT / 生成路径 / dsh-home 约定改动；未拆 chat-view.ts / dsh-runner.ts。

### 最近交接摘要（2026-09-03 已推送）
- 已完成并推送：`0427336 feat(dsh-client): inject spawn/timer dependencies and add fake spawn tests`
- 该提交包含：
  - `DshClient` 依赖注入 `spawn` / `setTimeout` / `clearTimeout`
  - fake spawn / fake timer 测试
  - 移除测试中的 `window` shim
  - 设置页环境检查缩进/空行清理
  - i18n 新 key 缩进对齐
- 下一个建议任务：**子进程环境变量白名单**（不再把整个 `process.env` 传给 dsh 子进程，只保留必要项和插件注入项；补 env 测试）
- 当前验证基线：`npm test` = 100 passed / 2 skipped，`tsc`、`build`、`eslint 0 errors` 通过。


### 已完成（下一轮不需要再做）

- [x] 5.1 `package-lock.json` 与 `package.json` / `manifest.json` 版本同步为 `0.1.6`
- [x] 5.2 GitHub Actions：Node 22、`npm ci`、release 前 `npm test` + `npm run build`
- [x] 5.3 `DshRunResult` 增加 `killReason: 'timeout' | 'user' | null`，UI 区分“任务超时”和“已停止”
- [x] 5.4 `OPENCODE_GO_PROVIDER_FALLBACK` 补齐 vision-exp，并有 `provider-fallback.test.ts` 保护
- [x] 5.5 `extraSkillDirs` 只能指向 vault 内相对目录，`scanSkills` 与 `ensureSkillDirsPatch` 共用 `resolveVaultRelativeDir`，并有测试
- [x] 保护测试：`dsh-client.test.ts`、`dsh-runner.test.ts`、`history.test.ts`、`provider-fallback.test.ts`、`pure.test.ts` 扩展
- [x] 已提前完成：`parseDshEventLine` 从 ChatView 抽到 `pure.ts` 并单测
- [x] 已提前完成：普通分支 CI `.github/workflows/ci.yml`
- [x] 已提前完成：设置页“环境检查”增加 generated / DSH_HOME / settings.yaml 可写性检查（提交 hash：`201e11fb10dce96f84417301072429c75d57e729`；后续清理提交 `e5fb41f9b36f3d1f02537e56d92df122a4082cf0`）
- [x] 已提前完成：`FolderSuggestModal` + `extraSkillDirs` 选择文件夹按钮，默认值改为空

### 剩余任务（按建议顺序）

#### 1. 发布前必须完成（风险低，不改 UI 行为）
- [x] 固定 `package.json` 中 `"obsidian": "latest"` 为精确 Obsidian API 版本，并重新生成/同步 `package-lock.json`（提交 hash：`6e7f257`，未推送）
- [x] 更新 `.github/workflows/release.yml` 使用 `actions/checkout@v4`、`actions/setup-node@v4`（可选但推荐）；`.github/workflows/ci.yml` 同步升级（提交 hash：`dddb738`，未推送）
- [x] release 流程校验 tag 与 `manifest.json` 版本一致（防发错版本）（提交 hash：`dddb738`，未推送）

#### 2. 下一批低风险代码修复（小步做，每步跑 npm test / tsc / build）
- [x] `DshClient` 依赖注入 `spawn` / `setTimeout` / `clearTimeout`，替代当前测试里的 `window` shim，并补 fake spawn 参数/env/error 测试（提交 hash：`0427336`）
- [x] 子进程环境变量白名单：不再把整个 `process.env` 传给 dsh 子进程，只保留必要项和插件注入项（提交 hash：`bf9915d`；未推送）
- [x] P2-D：设置页补 API Key 明文存储风险提示；keychain 经评估暂不引入（settings.apiKey.warning + .dsh-setting-warning）
- [x] 生成文件原子写：`ensurePluginDshHome` / `ensureVaultPatch` / `ensureSkillDirsPatch` 改为 tmp + rename，参考 `HistoryStore.save`（提交 hash：`c68aa17`；未推送）
- [x] `HistoryStore.titleFromTurn` 默认标题走 `t('chat.newSession')`，去掉硬编码中文 `'新会话'`（提交 hash：`84596f0`；未推送）
- [x] `linkifyAnswer` 缓存 vault 文件/别名列表，并监听 vault 变更失效，避免每次回答全库扫描（提交 hash：`7d453d3`，未推送）
- [x] `scanSkills` 缓存或异步化，避免每次打开面板/触发建议时同步读盘（提交 hash：`8d085b6`，未推送）
- [x] `settings.ts` 中 E 项新增代码的缩进/空行整理（功能正常，可读性一般）；i18n 新 key 缩进已对齐

#### 3. 运行生命周期与降级可见化（中等风险，建议单独做，仍不拆大结构）
- [ ] P2-K：运行中关闭面板/插件卸载时，`killReason` 与部分轮次处理完整，避免 promise settle 后仍操作 DOM
- [ ] P1-3：让 DSH_HOME / patch / workdir 降级失败在 UI 可见（统一警告收集 + 消息内提示 + Notice）
- [x] P1-5：`DshSettings` 的 `model` / `reasoningEffort` / `permissionMode` / `toolExecutionMode` 改为从 option 常量推导的 union，并在 `loadSettings` 做非法值回退

#### 4. 结构拆分（高风险，最后单独安排，不混入前几批）
- [ ] 引入 `RunController` 显式状态机
- [ ] 拆分 `DshRunner`：`DshResolver` / `DshHomePreparer` / `VaultPatchWriter` / `SkillMemorySeeder` / `TaskBuilder`
- [ ] 将 stream relay JS 移出 TS 模板字符串，改为独立资源文件
- [ ] 拆分 `ChatView`：`HistoryPanel` / `SkillPanel` / `MessageListRenderer` / `ComposerController`
- [ ] 为 `ChatView -> RunController -> DshClient -> HistoryStore` 主链路补替身测试
- [ ] 上线前合并主线 / push / PR 由用户决定

## 执行环境备注（保留）

- 分支与 git：
  - 当前分支 `dsh-obsidian-deepharness-new-architecture` 已推送到远程同名分支。
  - 最近提交：`84596f0 fix(history): use t('chat.newSession') for the default session title`（bf9915d / ad61a92 / c68aa17 / 84596f0 均未推送）
  - 若需要合并主线 / PR / push，由用户决定。
- 本地验证：
  - `npm test`、`npx tsc --noEmit`、`npm run build` 应全部通过。
  - 本机 `~/.npm` 可能有 root 属主问题，可用 `npm ci --cache "$(pwd)/.npm-cache"`。
- 本机 git 代理可能不在线；推送需 `git -c http.proxy= -c https.proxy= push …`。
- Obsidian 设置页使用 1.13 声明式新 API，不要改回 `display()`。
- 测试中 `obsidian` 包 main 为空，需 `vi.mock('obsidian', …)`。
- 当前 `DshClient` 已支持注入 `spawn` / `setTimeout` / `clearTimeout`；测试不再依赖 `window` shim。
- `dist/` 被 `.gitignore` 忽略，不在源码仓库中提交；CI/Release 会自行构建。
- 真实 vault 已部署到 `Knowledge_Inbox1/.obsidian/plugins/deepharness/`；后续 UI 改动后需重新构建覆盖安装。

---

## 0. 背景与总体判断

上一轮已通读核心源码、测试与 CI 配置。用户提出的 7 个问题全部成立，并额外发现了若干用户可见的 bug 与工程化问题。

最关键的两个用户可见错误：

1. **超时被显示为“用户停止”**：`DshClient` 的 timeout 和用户 abort 都设置 `killed = true`，`ChatView` 把所有 `killed` 都渲染为 `chat.cancelled`。
2. **降级失败完全静默**：DSH_HOME 准备失败、persona/stream patch 失败、workdir 回退等都不通知用户。

---

## 1. 已确认问题清单

### P1-1 ChatView 职责过重
- 文件：`src/chat-view.ts`，1152 行。
- 同时承担 UI 创建、输入、菜单、运行状态、DSH 调用、流式解析、工具渲染、历史面板、技能面板、笔记引用。
- 高风险区域：`sendMessage`（339-574 行）、历史/技能面板（924-1151 行）。

### P1-2 DshRunner 职责过重
- 文件：`src/dsh-runner.ts`，701 行。
- 同时做二进制/Node 探测、provider fallback、DSH_HOME 准备、persona patch、stream relay JS 内嵌（125-195 行）、skill dirs patch、memory 初始化、task 组装。
- 内嵌 `STREAM_RELAY_SRC` 模板字符串维护成本高。

### P1-3 降级失败太安静
- `ensurePluginDshHome` 失败 `catch { return null; }`（dsh-runner 430-432 行），调用处 `pluginHome ?? this.runner.dshHome()`（chat-view 394 行）无提示。
- `ensureVaultPatch` 失败返回 `{ persona: null, think: null }`（dsh-runner 571-572 行），调用处 `filter` 后继续运行（chat-view 384 行）。
- `ensureSkillDirsPatch` / `ensureObsidianSkill` / `ensureMemoryFile` 返回值在 chat-view 386-387 行被忽略。
- `workdir` 越界或创建失败静默回退 vaultRoot（dsh-runner 447-455 行）。

### P1-4 状态机是隐式的
- 状态散落在 `running`、`abortController`、`statusTimer`、局部 `toolRows`/`toolsHistory`/`thinkBlock` 中。
- 取消、超时、失败、关闭面板、语言切换交织后容易出边缘问题。

### P1-5 配置类型偏松
- `src/settings.ts` 中 `toolExecutionMode`、`model`、`reasoningEffort`、`permissionMode` 都是 `string`。
- option 常量已用 `as const`，但未推导 union 类型。
- `permissionLabel`、`DshClient.run` 参数、`setPermissionMode`、`DshRunner.ensurePluginDshHome` 等仍接收 `string`。

### P1-6 测试覆盖避开最复杂部分（状态：保护测试已大幅补齐，主链路仍未覆盖）
- 原先只有 `pure.test.ts`、`linkify.test.ts`、`skills.test.ts`、`chip-repro.test.ts`。
- 已新增 `dsh-client.test.ts`、`dsh-runner.test.ts`、`history.test.ts`、`provider-fallback.test.ts`。
- 仍未覆盖：`ChatView -> DshRunner -> DshClient -> HistoryStore` 完整主链路；`DshClient` 尚未做依赖注入。

### P1-7 发布可复现性不稳（状态：CI 部分已修复，剩余 obsidian 固定版本）
- [x] `.github/workflows/release.yml` 已改为 Node 22 + `npm ci` + release 前 `npm test` + `npm run build`。
- [x] `package-lock.json` 根 version 已同步为 `0.1.6`。
- [ ] `package.json` 中 `"obsidian": "latest"` 仍待固定为精确 Obsidian API 版本。

---

## 2. 额外发现的问题（上一轮未列出）

### P2-A 超时误报为“用户停止”（状态：已完成）
- [x] `DshRunResult` 已增加 `killReason: 'timeout' | 'user' | null`。
- [x] ChatView 已分别处理 `killReason === 'user'` 与 `killReason === 'timeout'`。
- [x] `dsh-client.test.ts` 已覆盖 timeout / user / 正常退出。

### P2-B DshClient 与运行环境耦合，难以测试
- 使用 `window.setTimeout` / `window.clearTimeout`（dsh-client 193、197、251 行）。
- 直接 `spawn` 真实子进程。
- 修复：构造函数或 `run` 参数注入 `spawn`、`setTimeout`、`clearTimeout`，默认取 `globalThis`。

### P2-C 子进程继承完整 `process.env`（状态：已完成）
- [x] `DshClient.run` 原来整份透传 `process.env`。
- [x] 修复：`buildDshEnv` 白名单继承（`DSH_ENV_ALLOWLIST`）+ `opts.env` 显式注入 + 插件注入项；提交 hash：`bf9915d`，未推送。

### P2-D API key 明文存储（状态：已完成）
- [x] `settings.apiKey` 明文存在插件 `data.json`（vault 内，随 vault 同步/备份）。
- [x] 设置页在 API Key 项下方显示明文存储风险提示（`settings.apiKey.warning`，en/zh；有 key 时显示，输入时实时显隐）。
- [x] keychain 评估：暂不引入。Obsidian 插件（Electron 渲染进程）不能直接调系统钥匙串，需 spawn security / Credential Manager / libsecret 等平台工具，行为与失败模式三平台各异，且 key 随 data.json 同步迁移成本高；维持「描述 + 风险提示」，留空即复用桌面 ~/.dsh 凭据。提交 hash：`ad61a92`，未推送。

### P2-E opencode-go fallback 缺少 vision-exp 模型定义（状态：已完成）
- [x] `OPENCODE_GO_PROVIDER_FALLBACK` 已补齐 `deepseek-v4-flash-vision-exp`。
- [x] `provider-fallback.test.ts` 保证 fallback 与 `MODEL_OPTIONS` 一致。

### P2-F extraSkillDirs 绝对路径可逃逸 vault（状态：已完成）
- [x] `pure.ts` 新增 `resolveVaultRelativeDir`，`scanSkills` 与 `ensureSkillDirsPatch` 共用同一校验。
- [x] 绝对路径 / `../` 越界项会被拒绝。
- [x] 设置页新增 `FolderSuggestModal`，降低用户手输越界路径概率。

### P2-G 生成文件写入非原子（状态：已完成）
- [x] `ensureVaultPatch`、`ensureSkillDirsPatch`、`ensurePluginDshHome` 原来直接 `fs.writeFileSync`。
- [x] 修复：dsh-runner.ts 新增 `writeFileAtomicSync`（同目录 tmp + rename），settings.yaml / vault.yml / vault.yml.bak / stream-relay.js / stream.yml / skill-dirs.yml 全部改原子写；提交 hash：`c68aa17`，未推送。

### P2-H linkifyAnswer 每次扫描全库
- `chat-view.ts` 686-708 行每次回答都 `getMarkdownFiles()` 并读 metadataCache。
- 修复：缓存文件列表 + aliases，监听 vault 变更失效。

### P2-I scanSkills 在 UI 线程同步扫描
- 打开技能面板或 `/` 建议时同步 `readdirSync` + `readFileSync`。
- 修复：缓存 + 失效，或异步化。

### P2-J 历史默认标题硬编码中文（状态：已完成）
- [x] `HistoryStore.titleFromTurn` 原来兜底 `'新会话'` 未走 i18n（局部变量 t 遮蔽了 i18n t()）。
- [x] 修复：局部变量改名 `title`，兜底改 `t('chat.newSession')`；提交 hash：`84596f0`，未推送。

### P2-K 运行中关闭视图/插件卸载的状态不完整
- `onClose` 会 `client.dispose()`，但 `sendMessage` 的 promise 稍后 settle 仍可能操作 DOM、写历史。
- 运行中那一轮不会作为部分记录保存。
- 修复：`RunController` 生命周期与视图关闭/插件卸载联动；决定是否保存部分轮次。

### P2-L 设置页诊断不检查可写性（状态：已完成）
- [x] 设置页“环境检查”已增加 generated / 插件 DSH_HOME / settings.yaml 可写性检查。
- [x] i18n en/zh 已同步。
- [x] 提交 hash：`201e11fb10dce96f84417301072429c75d57e729`（清理提交 `e5fb41f9b36f3d1f02537e56d92df122a4082cf0`）

---

## 3. 目标架构

```
UI 层（Obsidian 相关）
  ChatView / ComposerController / MessageListRenderer / HistoryPanel / SkillPanel / Modals

应用层（Obsidian-free，可测试）
  RunController         显式状态机，持有 abort/timer
  ChatSession           memory、history 协调
  StreamEventParser     纯函数，解析 DLEVENT
  WarningCollector      收集准备阶段降级/失败

领域服务层
  DshResolver           dsh / node / script 探测
  DshHomePreparer       plugin DSH_HOME 准备
  VaultPatchWriter      persona / stream-relay / skill-dirs patch
  SkillMemorySeeder     obsidian skill + memory.md
  TaskBuilder           组装 prompt

基础设施层
  DshClient             注入 spawn/timer
  HistoryStore          注入存储路径
  SkillScanner          缓存/异步
```

### 建议新增/拆分文件（示例，可调整命名）

- `src/run/run-controller.ts`
- `src/run/run-state.ts`
- `src/run/stream-event.ts`
- `src/run/warning.ts`
- `src/dsh/dsh-resolver.ts`
- `src/dsh/dsh-home.ts`
- `src/dsh/vault-patch-writer.ts`
- `src/dsh/task-builder.ts`
- `src/stream-relay/stream-relay.js`（从 TS 中迁出）
- `src/views/history-panel.ts`
- `src/views/skill-panel.ts`
- `src/views/message-list.ts`
- `src/views/composer.ts`

---

## 4. 关键设计约定

### 4.1 DshStreamEvent 纯解析
把 `chat-view.ts` 434-500 行的手写解析抽成纯函数：

```ts
type DshStreamEvent =
  | { t: 'think'; text: string }
  | { t: 'tool'; status: 'start'; id: string; name: string; args: string; argsFull?: string }
  | { t: 'tool'; status: 'result'; id?: string; ok: boolean; summary?: string };

function parseDshEventLine(line: string): DshStreamEvent | null;
```

### 4.2 RunState 状态机

```ts
type RunState =
  | { status: 'idle' }
  | { status: 'preparing' }
  | { status: 'running' }
  | { status: 'succeeded' }
  | { status: 'failed'; message: string }
  | { status: 'cancelled' }
  | { status: 'timedOut' };
```

`RunController` 负责：
- 持有 `AbortController`
- 持有超时定时器
- 状态流转
- 对外发出 `onStateChange` / `onStreamEvent` / `onWarning`
- 视图关闭和插件卸载时能安全中止并停止后续 UI/历史写入

### 4.3 DshRunResult 区分终止原因

```ts
interface DshRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  killReason: 'user' | 'timeout' | null;
}
```

### 4.4 降级警告统一结构

```ts
interface PreparationIssue {
  level: 'warning' | 'error';
  code: string;
  message: string; // 已经 i18n 后的字符串
}

interface StepResult<T> {
  ok: boolean;
  value?: T;
  silentOk?: boolean;   // true 表示合法空状态，不需要警告
  issue?: PreparationIssue;
}
```

所有准备步骤返回 `StepResult`，`RunController` 收集 issues，ChatView 在消息流中渲染系统提示 + `new Notice`。

### 4.5 类型推导

```ts
export type ModelId = typeof MODEL_OPTIONS[number]['id'];
export type ReasoningEffort = typeof REASONING_OPTIONS[number]['id'];
export type PermissionMode = typeof PERMISSION_OPTIONS[number]['id'];
export type ToolExecutionMode = '' | 'native' | 'code' | 'both';
```

`DshSettings` 使用这些 union。`loadSettings` 对 `loadData()` 读出的 unknown 做校验和迁移，非法值回退默认并提示。

### 4.6 依赖注入
`DshClient` 允许注入 `spawn`、`setTimeout`、`clearTimeout`。`DshRunner` 允许注入 `execFile`、`whichCmd` 或相关探测函数，便于测试。

---

## 5. 实施顺序：先修明确 bug，再补保护测试，最后拆结构

### 第一阶段（本次执行）：低风险修复与保护

> 本阶段只做低风险修复，不拆 `chat-view.ts` / `dsh-runner.ts`，不改变现有 UI 和功能。
> 每完成一小步都运行：`npm test`、`npx tsc --noEmit`、`npm run build`。
> 如果某一步风险较高，先停下来说明，不要硬改。

- [x] 5.1 同步 `package-lock.json` 版本到 `0.1.6`，与 `package.json`、`manifest.json` 一致。
- [x] 5.2 调整 GitHub Actions：
  - [x] 使用 Node 22
  - [x] 使用 `npm ci`
  - [x] release 前运行 `npm test`
  - [x] release 前运行 `npm run build`
- [x] 5.3 修复 DSH 运行超时与用户手动停止无法区分的问题：
  - [x] `DshRunResult` 增加 `killReason: 'timeout' | 'user' | null`，不要只返回 `killed: true`
  - [x] UI 中分别提示“任务超时”和“已停止”
  - [x] 保持 DLEVENT 协议与结果解析逻辑不变
- [x] 5.4 检查并修复 `OPENCODE_GO_PROVIDER_FALLBACK` 模型列表与 `MODEL_OPTIONS` 不一致的问题（当前缺少 `deepseek-v4-flash-vision-exp`）
  - [x] 补一个轻量单测，防止模型选项与 fallback 再次不同步
- [x] 5.5 检查并修复 `extraSkillDirs` 越界问题：
  - [x] `scanSkills` 和 `ensureSkillDirsPatch` 两处都只接受 vault 内部相对目录
  - [x] 绝对路径或 `../` 逃出 vault 的输入被拒绝或安全截断
  - [x] 补轻量单测覆盖越界输入

> 完成记录（历史）：5.1–5.5 全部完成并通过验证。新增测试文件：`dsh-client.test.ts`（killReason timeout/user/正常退出）、`provider-fallback.test.ts`（fallback 与 MODEL_OPTIONS 一致性）、`dsh-runner.test.ts`（extraSkillDirs patch 越界拒绝）；`pure.test.ts` 新增 `resolveVaultRelativeDir` 边界用例。说明：dsh-client 测试在 Node 下用 window timer shim（生产代码仍用 `window.setTimeout`）；`extraSkillDirs` 采用“拒绝并跳过越界项”策略，两处消费点（scanSkills / ensureSkillDirsPatch）共用 `resolveVaultRelativeDir`。

### 第二阶段（保护测试，状态更新：前 3 项已在上一轮随第一阶段提前完成）

第一阶段完成后，先为已经修改和风险最高的小模块补测试，不拆大结构：

- [x] `DshClient` 的 timeout vs abort 测试 —— 已在上一轮完成（`dsh-client.test.ts`；实现方式与计划略有出入：真实短命 node 子进程 + 测试内 `window` timer shim，而非 fake spawn + fake timer；未改生产代码结构）
- [x] `extraSkillDirs` 边界校验测试 —— 已提前完成（`pure.test.ts` 的 `resolveVaultRelativeDir` 用例 + `dsh-runner.test.ts` 集成用例）
- [x] provider fallback 与 `MODEL_OPTIONS` 一致性测试 —— 已提前完成（`provider-fallback.test.ts`）
- [x] `HistoryStore` 基础测试（tmpdir：load / addTurn / trim / pin / atomic write）——`src/history.test.ts`
- [x] `DshRunner.buildTask` 与 `workdir` 边界测试——`src/dsh-runner.test.ts`

> 只有这些保护测试通过后，才允许进入第三阶段的结构拆分。

### 第三阶段及以后（结构拆分 / 剩余项；部分已完成）

- [x] 抽取 `parseDshEventLine` 纯函数并单测 —— 已完成（`src/pure.ts` + `src/pure.test.ts`）
- [x] `DshClient` 依赖注入 `spawn` / timer —— 已完成（`src/dsh-client.ts` + `src/dsh-client.test.ts`，提交 hash：`0427336`）
- [ ] 引入 `RunController` 状态机
- [ ] 拆分 `DshRunner`（`DshResolver` / `DshHomePreparer` / `VaultPatchWriter` / `SkillMemorySeeder` / `TaskBuilder`）
- [ ] 拆分 `ChatView`（`HistoryPanel` / `SkillPanel` / `MessageListRenderer` / `ComposerController`）
- [x] CI 增加普通 push 的 test + build 流程 —— 已完成（`.github/workflows/ci.yml`）
- [x] 诊断页增加可写性检查 —— 已完成（`src/settings.ts` + i18n）
- [ ] 生成文件原子写、linkify / scanSkills 缓存等后续优化

---

## 6. 测试计划

### 已有测试保留
`pure.test.ts`、`linkify.test.ts`、`skills.test.ts`、`chip-repro.test.ts` 继续保留并扩展。

### 已完成保护测试
- 5.4 的 provider fallback 与 `MODEL_OPTIONS` 一致性单测（`provider-fallback.test.ts`）
- 5.5 的 `extraSkillDirs` 边界校验单测（`pure.test.ts` + `dsh-runner.test.ts`）
- 5.3 的 `killReason` 区分测试（`dsh-client.test.ts`）
- `HistoryStore` 基础测试（`history.test.ts`）
- `DshRunner.buildTask` 与 `workdir` 边界测试（`dsh-runner.test.ts`）

### 后续测试计划（按剩余任务阶段补）
| 模块 | 测试方式 | 覆盖点 |
| --- | --- | --- |
| `DshClient` | fake spawn + fake timer（依赖注入后） | 参数拼装、env 注入、stdout 行聚合、error、timeout vs abort |
| `DshResolver` | 注入 execFile + 临时文件 | PATH/显式/候选探测、Windows shim、symlink |
| `DshHomePreparer` | 临时目录 | settings.yaml 内容、fallback、credentials symlink/copy |
| `VaultPatchWriter` | 临时目录 | persona marker 重生成、.bak、stream relay 文件、skill-dirs patch |
| `RunController` | fakes | 成功/失败/取消/超时/关闭面板/警告渲染 |
| `HistoryStore` | tmpdir | activate/rename/remove/clear 等剩余分支 |
| `scanSkills` | 临时目录 | 去重优先级、kebab 校验、缓存失效 |

---

## 7. 当前状态与剩余验收

### 已完成（当前应通过）
1. `npm ci && npm test && npm run build` 可通过，`npx tsc --noEmit` 可通过。
2. `package-lock.json` 版本与 `package.json` / `manifest.json` 一致（`0.1.6`）。
3. GitHub Actions 使用 Node 22、`npm ci`，release 前运行 `npm test` 与 `npm run build`。
4. 超时与用户停止已区分，`DshRunResult` 带 `killReason`。
5. opencode-go fallback 模型列表与 `MODEL_OPTIONS` 一致，并有测试。
6. `extraSkillDirs` 不能通过绝对路径或 `../` 逃出 vault，并有测试。

### 剩余验收（按上一节剩余任务逐项完成）
1. [x] `package.json` 固定 `obsidian` 版本并同步 lockfile（`1.13.1`，提交 `6e7f257`，未推送）。
2. [x] `DshClient` 可注入 `spawn` / timer，测试不再依赖 `window` shim。（提交 hash：`0427336`）
3. [x] 子进程 env 白名单化（`src/dsh-client.ts` 的 `DSH_ENV_ALLOWLIST` + `buildDshEnv`，+8 测试）。
4. [x] API Key 存储风险有提示（P2-D：settings.apiKey.warning 风险提示；提交 hash：`ad61a92`）。
5. [x] 生成文件统一原子写（`writeFileAtomicSync`，settings.yaml / vault.yml(.bak) / stream-relay.js / stream.yml / skill-dirs.yml；提交 hash：`c68aa17`）。
6. [x] `HistoryStore` 默认标题走 i18n（`titleFromTurn` 兜底用 `t('chat.newSession')`；提交 hash：`84596f0`）。
7. [x] linkifyAnswer 有缓存（P2-H，提交 `7d453d3`，未推送）；scanSkills 有缓存（P2-I，提交 `8d085b6`，未推送）。
8. 运行中关闭面板/卸载时状态与部分轮次处理完整。
9. DSH_HOME / patch / workdir 降级失败在 UI 可见。
10. [x] `DshSettings` 相关字段改为 union 类型并做加载校验。
11. 再往后才是 `RunController`、拆分 `DshRunner` / `ChatView` 等结构级目标。

---

## 8. 当前相关文件指引

| 文件 | 当前角色 / 剩余关注点 |
| --- | --- |
| `src/chat-view.ts` | 仍是大文件；已使用 `parseDshEventLine`；后续才拆结构 |
| `src/dsh-runner.ts` | 仍是大文件；已加入 `resolveVaultRelativeDir`、opencode fallback、`writeFileAtomicSync` 原子写；后续才拆结构 |
| `src/dsh-client.ts` | `killReason`、依赖注入、子进程 env 白名单（`DSH_ENV_ALLOWLIST` + `buildDshEnv` + `opts.env`）均已完成 |
| `src/pure.ts` | 已有 `parseDshEventLine`、`resolveVaultRelativeDir` 等纯函数 |
| `src/settings.ts` | 已增加可写性诊断、文件夹选择器、API Key 明文存储风险提示（`settings.apiKey.warning`）；剩余 string→union 收紧 |
| `src/history.ts` | 已有原子写与基础测试；默认标题已走 `t('chat.newSession')`（P2-J） |
| `package.json` | 剩余固定 `obsidian: latest` |
| `package-lock.json` | 已同步为 `0.1.6` |
| `.github/workflows/release.yml` | 已使用 Node 22 + `npm ci` + test + build；可再升级 actions 到 v4 |
| `.github/workflows/ci.yml` | 已新增普通分支 test + build |
| `src/dsh-client.test.ts` | killReason + fake spawn/timer + env 白名单（buildDshEnv 纯函数 + fake spawn env 隔离）测试已完成，不再依赖 `window` shim |
| `src/dsh-runner.test.ts` / `history.test.ts` / `provider-fallback.test.ts` / `pure.test.ts` | 保护测试已完成 |

---

## 9. 注意事项（给下一个 agent）

1. **不要改变 DLEVENT 线协议**：它同时被 `parseHeadlessOutput`、stream relay JS、ChatView 使用。若改格式，三处同步改并补测试。
2. **保持生成文件路径稳定**：`vault/.obsidian/plugins/deepharness/generated/*` 和 `dsh-home/` 已被现有用户使用，迁移时要兼容旧路径。
3. **保持 i18n 机制**：所有新增用户可见字符串走 `t()`，新增 key 同时补 `en` / `zh`。
4. **`onunload` 不能依赖异步**：Obsidian 不等待异步 unload。历史保存必须继续使用同步写，或确保关键数据在运行过程中已同步落盘。
5. **桌面端 Electron 主进程**：可用 Node 内置模块，但不要引入浏览器专用 API（测试环境也要避免直接 `window`）。
6. **每个 phase 独立可合入**：避免一次性大爆炸式重构。
7. **改完跑完整测试和构建**：`npm test` 和 `npm run build` 都要通过。


---

## 10. 给下一个 Agent 的提示词模板（2026-09-03 更新：P1-5 / P2-H / P2-I / 发布前必办 完成并推送后使用）

> 把下面这段发给下一个写代码的 agent：

"""
请继续维护 Obsidian 插件 DeepHarness（版本 0.1.6）。

项目路径：
/Users/mymac/deepseek workplace/dsh-obsidian-deepharness-new-architecture

先阅读：
1. HANDOFF.md（重点看顶部“最近交接摘要”与“剩余任务”）
2. AI_CONTEXT.md（稳定项目上下文）
3. 如本地有 MAINTENANCE.md，再看其顶部维护摘要

当前状态：
- 分支 dsh-obsidian-deepharness-new-architecture 已与远程同步（HEAD `78134a2`；本轮 9 个提交均已 push）。push 仍需绕代理：git -c http.proxy= -c https.proxy= push origin dsh-obsidian-deepharness-new-architecture；提交与 push 前都先让用户确认。
- 已完成并推送：P1-5 设置选项 union 化 + 加载回退（`2b039a1`）；P2-H linkifyAnswer 缓存（`7d453d3`）；P2-I scanSkills 缓存（`8d085b6`）；发布前必办（pin obsidian `1.13.1` `6e7f257`、Actions v4 + tag↔manifest 校验 `dddb738`）。剩余任务第 1、2 节已清零。验证基线：npm test = 121 passed / 2 skipped，tsc / build / eslint 0 errors。
- 下一步（按剩余任务建议顺序，小步做，每步跑验证；仍不拆大结构）：
  1. P2-K（中等风险，建议单独一轮做）：运行中关闭面板/插件卸载时 killReason 与部分轮次处理完整，避免 promise settle 后仍操作 DOM
  2. P1-3：让 DSH_HOME / patch / workdir 降级失败在 UI 可见（统一警告收集 + 消息内提示 + Notice）
  3. 结构级工作（RunController 状态机 / 拆分 DshRunner、ChatView / stream-relay.js 移出 TS 模板串）风险高，另行安排
- 若用户要发布 v0.1.6：打 tag `0.1.6`（不带 v）并 push → release.yml 会先校验 tag 与 manifest.json 版本一致，再构建 draft release。

红线与约定（务必遵守）：
- 不改 DLEVENT 线协议；不改生成文件路径与 dsh-home 约定（vault/.obsidian/plugins/deepharness/generated/*、dsh-home/ 已被真实用户使用）。
- 新增用户可见文案一律走 t()，en/zh 成对添加；不要改动既有 key 的文案。
- 生成文件继续用 dsh-runner 的 writeFileAtomicSync（tmp + rename），不要直接 writeFileSync 目标文件。
- DshClient 子进程 env 只允许 buildDshEnv（DSH_ENV_ALLOWLIST + opts.env + 插件注入项），禁止整份透传 process.env。
- Obsidian 设置页是 1.13 声明式 API，不要改回 display()；onunload() 必须同步完成。
- 测试不要 window shim；obsidian 包 main 为空需 vi.mock。
- 本仓库是 git worktree：.git 在 /Users/mymac/deepseek workplace/dsh-obsidian/.git（位于会话工作区之外，git 写操作如被沙箱拒绝可用 full access 执行；提交前仍须用户确认）。

每完成一小步必须跑：
- npm test
- npx tsc --noEmit
- npm run build
- npx eslint src/*.ts
当前基线：121 passed / 2 skipped，eslint 0 errors（obsidian typings 固定为 1.13.1）。

本机注意：
- npm ci 若 EPERM：npm ci --cache "$(pwd)/.npm-cache"
- package.json 中 obsidian 已固定为 1.13.1（勿改回 latest；改 typings 版本须过 tsc，设置页依赖 1.13 声明式 API）
- 真实 vault 部署：Knowledge_Inbox1/.obsidian/plugins/deepharness/（UI/生成逻辑改动后需重新构建覆盖，并在 Obsidian 里禁用再启用插件）
- 提交与 push 前先让用户确认；push 用：git -c http.proxy= -c https.proxy= push origin dsh-obsidian-deepharness-new-architecture
"""
