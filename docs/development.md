# 开发 — DeepHarness

> 面向所有 coding agent 与贡献者。先读 [`../AGENTS.md`](../AGENTS.md) 与
> [`architecture.md`](architecture.md)。任务从哪里选，见 [`roadmap.md`](roadmap.md)。

## 1. 环境

- Node.js **22**（CI 使用 22.x；本地 20+ 通常也能跑，但以 22 为准）
- npm（仓库有 `package-lock.json`）
- Obsidian **1.13+ 桌面端**（插件 `isDesktopOnly: true`）
- 本机安装 `dsh` CLI；凭据通过 DSH 自己的方式配置（`~/.dsh/.credentials.yaml` 或环境变量）
- 可选：本机代理用于 push（见 §7）

首次拉依赖：

```bash
npm ci --cache "$(pwd)/.npm-cache"
```

`node_modules/`、`dist/`、`.npm-cache/` 都不进 git。

## 2. 常用命令

| 命令 | 作用 |
|---|---|
| `npm test` | 全量 Vitest（当前基线 343 passed / 2 skipped，22 文件） |
| `npx tsc --noEmit` | 类型检查 |
| `npm run build` | 生产构建到 `dist/`（main.js + manifest.json + styles.css） |
| `npm run dev` | 非压缩构建（**只构建一次，不是 watch**） |
| `npx eslint "src/**/*.ts"` | lint（基线 0 errors / 9 warnings） |
| `./deploy.sh <vault>` | 构建并复制三件套到 `<vault>/.obsidian/plugins/deepharness/` |
| `./deploy.sh <vault> --dev` | 非压缩构建后部署 |

没有 `npm run lint` / `npm run typecheck` 脚本；用上面的原始命令。新增脚本要同时更新本表与 CI。

## 3. 测试结构

```
src/**/*.test.ts        Vitest，默认 Node 环境
test/obsidian-stub.ts   把 'obsidian' specifier 解析到类型替身
test/obsidian-view-double.ts  ItemView/Leaf/Notice/Menu/MarkdownView 替身
test/setup.ts           Obsidian DOM helpers（Node 下 no-op）
```

- 默认 `environment: 'node'`；需要 DOM 的测试在文件头加 `// @vitest-environment jsdom`（vitest 4 用 docblock，不是 config glob）。
- `vitest.config.ts` 把 `obsidian` alias 到 stub，因为 npm 包是 types-only，Vite 无法解析。
- 纯函数优先：`pure.ts` / `paths.ts` / `dsh-config.ts` 不依赖 Obsidian，直接测。
- 文件系统测试用 `fs.mkdtemp` + 注入 `userDshHome`，**绝不写真实 `~/.dsh`**。
- `ChatView` 测试目前只覆盖生命周期/面板；`test/obsidian-view-double.ts` 已具备 `makeAppDouble` / `makePluginDouble`，但主链路还缺注入点（见 `architecture.md` §9）。

### 加测试的判断标准

- 改纯逻辑：必须有单测覆盖分支（成功/失败/边界）。
- 改 `DshClient`：假 child/stdio，覆盖超时、abort、非零退出、stderr。
- 改路径/迁移：临时目录，覆盖“已在 vault 外”“旧目录迁移”“不可写回退”。
- 改 UI：至少一个 DOM/替身测试；关键交互（发送、停止、历史）再加真人测试。
- 修 bug：先写能复现的失败测试，再修；如果无法单测，必须在 PR/commit 里写清真人复现步骤。

## 4. 每步验证（Definition of Done）

```bash
npm test
npx tsc --noEmit
npm run build
npx eslint "src/**/*.ts"
```

全部通过才算“代码完成”。此外：

- **UI / 生成链路**：`./deploy.sh <vault>`，在 Obsidian 里重载插件，至少走一遍受影响路径。单测绿不等于 UI 可用——过去 4 个真 bug 都是真人测试发现的。
- **安全 / 路径 / 迁移**：必须检查真实文件位置（vault 内 vs `~/.dsh/deepharness/...`），不能只看日志。
- **文档**：行为、命令、架构、路线图有变化时同步更新对应文档；不要新增 HANDOFF。

## 5. 手工测试清单（发版前至少过一遍）

1. **环境检查**：设置页“检查”通过；故意填错 `dsh` 路径能看到具体修复建议。
2. **基本运行**：发送 `用 bash 运行 pwd && ls`；thinking/tool 流式出现；最终答案正确；无 DLEVENT 泄漏。
3. **停止**：长任务中点 Stop；状态变为 cancelled；无残留子进程（活动监视器/任务管理器）。
4. **超时**：把 timeout 设为 5s，发送 `sleep 20`；状态为 timedOut，不是 failed/cancelled。
5. **失败**：断网/清空凭据；错误提示可读，按钮回到 Send。
6. **准备失败**：临时把 `dsh` 路径指向不存在文件；点发送；确认按钮恢复 Send、状态回 idle（stuck-Stop 回归）。
7. **历史**：完成两轮 → 关闭/重开 Obsidian → 历史面板能恢复；pin/rename/note 正常；当前会话不丢。
8. **设置**：改 model / reasoning / permission → 下一次运行生效；`~/.dsh/deepharness/<vaultKey>/settings.yaml` 内容正确。
9. **权限**：切到 full access 必须二次确认；取消后仍是原模式。
10. **引用/提及/技能**：有选区与无选区引用当前笔记；`@` 搜索插入 wikilink；`/` 技能建议可用。
11. **i18n**：切 en/zh，已打开面板即时刷新；命令面板名称也刷新。
12. **关闭面板 mid-run**：不崩溃；重新打开后历史里有 partial turn（若有内容）。
13. **选区动作**：选中一段文字 → 命令 `处理选中文本` → 选改写/总结/解释 → 预览出现；点 Cancel 文件不变；点 Replace/Insert below 才写回，且选区已变化时拒绝写入。
14. **变更审阅**：让 agent 改 2–3 个笔记 → 运行结束出现变更列表；逐文件 Undo 后内容与运行前一致；Undo all 全部恢复；大文件/超限时显示 incomplete 提示。
15. **批量处理**：`批量处理笔记` → 选 2–3 篇 + 一条指令 → 逐项状态推进；中途取消后不再启动新项；结束后一次审阅；历史里出现一个 batch session，逐项有 status/error。

## 6. 部署

```bash
./deploy.sh /path/to/your/vault
```

脚本会 `npm run build`，然后复制 `dist/main.js dist/manifest.json dist/styles.css` 到
`<vault>/.obsidian/plugins/deepharness/`。在 Obsidian 设置 → 第三方插件里重载/启用。

不要用 `cp -r dist <plugin-dir>`：那会变成 `deepharness/dist/main.js`，Obsidian 找不到入口。

## 7. Git / worktree / 代理

- 当前仓库是 **worktree**：`.git` 是文件，指向工作区外的真实 git 目录。不要删除/移动 `.git`。
- 日常分支 `main`；功能分支从 `main` 切，完成后合回。合并前跑四项验证。
- 提交信息用 conventional commits：`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`。
- 一个 commit 一个主题；不要混入无关格式化。
- push 可能需要本机代理；网络失败先检查代理环境。**不要把代理地址、token、凭据写进仓库或文档。**
- push / tag / Release 前必须问用户（见 `AGENTS.md` §9）。

## 8. 发布流程

发布机械清单见 [`publish-checklist.md`](publish-checklist.md)。核心步骤：

1. 确认 `main` 干净、四项验证通过、手工测试完成。
2. 同步 bump **`package.json` 与 `manifest.json`** 的 version（两者必须一致）；必要时更新 `package-lock.json` 根 version。
3. 提交 `chore: release x.y.z`。
4. 打 tag（**不带 `v` 前缀**）：

   ```bash
   git tag -a 0.2.0 -m 0.2.0
   git push origin 0.2.0
   ```

5. GitHub Actions `release.yml` 会：校验 tag == manifest version → `npm ci` → `npm test` → `npm run build` → 生成 artifact attestation → 创建**草稿** Release（附三件套）。
6. 到 Releases 页补 release notes，手动 Publish。
7. 已发布版本才在 Obsidian 目录生效；日常更新不需要重新提交目录。

常见失败：tag 带 `v`、manifest 与 tag 不一致、Release 缺 `main.js`、仓库 private。

## 9. 调试

- **设置页“检查”**：报告 `dsh`、Node、三个可写路径；失败会给具体修复建议。可复制报告，但**不要**把凭据贴进 issue。
- **插件日志**：Obsidian 开发者工具 Console；`dsh` stderr 会进入错误提示，但不要假设它完整。
- **生成文件**：`<vault>/.obsidian/plugins/deepharness/generated/` 可直接读；`vault.yml` 可改，升级可能重生成（旧版 `.bak`）。
- **插件 DSH_HOME**：`~/.dsh/deepharness/<vaultKey>/`；看 `settings.yaml`、`history.json`、`skills/`。
- **子进程残留**：插件卸载时会 `disposeAll()`；若仍有残留，检查是否有异常路径绕过了 `DshClient`。
- **沙箱错误**：`SANDBOX_UNAVAILABLE` 表示宿主机沙箱不可用，DSH fail-closed；不要为了“能跑”改成 full access。

## 10. 静默失败教训

这些不是理论，是已经发生过的 bug：

| 现象 | 根因 | 规则 |
|---|---|---|
| 工具栏图标点了没反应 | 面板在构造函数里建，`ItemView` 还没有 DOM；异常被 DOM 事件吞掉 | UI 组件只在 `onOpen()` 后建；测试要捕获 unhandled error |
| 恢复会话丢上下文 | 只恢复了 UI，没有重建 memory | 恢复 = transcript + memory，二者都测 |
| 设置页显示旧值 | 打开了旧 settings 快照 | 每次读 `plugin.settings`，或订阅变更 |
| history 写错位置 | onload 捕获了迁移前的路径 | 路径用 resolver，不用字符串 |
| 技能写回 vault 后被忽略 | 扫描根已迁到系统 DSH_HOME | 写入和扫描必须同一个根 |
| skill-dirs 残留 | 删了设置但旧 patch 还在 | 空配置要删除 patch 文件 |
| 技能列表不更新 | 缓存 key 没包含变更 | 缓存失效要覆盖 vault/settings 变化 |
| 卸载时丢当前会话 | `onunload` 异步写被截断 | 关键落盘同步完成 |

共同点：**没有抛错，但状态错了**。所以验证要看真实文件/真实 UI，不要只看“没报错”。

## 11. 文档维护

- 用户安装/功能/设置/安全 → `README.md` + `readme-ch.md`（两份同步）。
- 架构/不变量/安全模型/债 → `docs/architecture.md`。
- 命令/测试/部署/发布/踩坑 → 本文。
- 任务/优先级/验收/决策 → `docs/roadmap.md`。
- 发布机械步骤 → `docs/publish-checklist.md`。
- 历史快照 → `docs/history/`，必须带“历史、非当前任务”横幅。
- **不要新增 HANDOFF / AI_CONTEXT / 状态交接文档**；状态只进 roadmap。
