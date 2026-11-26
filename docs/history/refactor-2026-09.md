# 2026-09 重构与迁移：时间线

> **历史快照，不是任务清单。** 记录 2026-09 到 2026-11 的重构、迁移、静默 bug 与合并，
> 用于解释当前架构的由来。当前事实见 [`../architecture.md`](../architecture.md)。

## 起点

- `main` 停在 `b76c2ab`，版本 0.1.8，测试基线 236 passed / 2 skipped。
- 插件 DSH_HOME 在 vault 内（`<vault>/.obsidian/plugins/deepharness/dsh-home/`），DSH 会在同步盘里 bootstrap 数百个 symlink（Windows 无权限时数万文件），导致 iCloud/OneDrive 卡死。
- `ChatView` 同时承担 UI、发送编排、流式渲染、记忆、历史写入；`DshRunner` 承担 6 类职责；路径散落。
- 交接靠 `HANDOFF.md` + `AI_CONTEXT.md`，内容层层堆叠且过期。

## 阶段 0–2（已完成）

1. **路径单点化**：`src/dsh/paths.ts` 成为 vault 内/外路径的唯一来源；引入 `vaultKey`、`isInside`。
2. **DSH_HOME 迁出 vault**：插件专属目录移到 `~/.dsh/deepharness/<vaultKey>/`；vault 内只保留 `generated/` patch。
3. **设置拆分**：`settings.ts` 拆为类型/默认值/校验 + 设置页 + 可写性探测。
4. **面板抽取**：`FloatingPanel` → `HistoryPanel` / `SkillPanel`；修掉“工具栏图标点了没反应”。
5. **`prepareRun()`**：把发送前的二进制探测、patch、DSH_HOME、技能、memory、workdir 从 `sendMessage` 抽出，为 RunController 铺路。
6. **源码分层**：`src/{views,dsh,core,settings}`；测试迁到 `test/` 替身。
7. **删除旧 persona 迁移**：`1526d7d` 移除 `renderLegacyPersonaYaml`。
8. **DSH_HOME 迁移落地**：`4fec616` + `a3b2383`，包含旧目录检测、迁移、回退与 issue 上报。

测试从 236 → 289（HANDOFF 记录）→ 294（合并前实测）。

## 七个静默 bug（都已修）

这些 bug 的共同点：**没有抛错，单测也绿，但真实 UI/文件状态错了**。

1. **工具栏图标无反应**：面板在 `ChatView` 构造函数里创建，`ItemView` 尚无 DOM，锚点 `undefined`；异常被 DOM click handler 吞掉。
2. **恢复会话丢上下文**：只恢复了 transcript/UI，没有重建 memory，下一轮 agent 不知道前文。
3. **设置页显示旧值**：设置页缓存了旧 settings 快照，保存后 UI 不刷新。
4. **history 写错位置**：`onload` 时捕获了迁移前的路径字符串，迁移后仍写旧目录。
5. **内置技能写回 vault**：`ensureObsidianSkill` 默认参数指向 legacy in-vault 路径，每次运行重建 `dsh-home/`，而扫描器只看系统 DSH_HOME。
6. **skill-dirs 残留**：清空 `extraSkillDirs` 后旧 `skill-dirs.yml` 仍在，DSH 继续扫描已移除的目录。
7. **技能缓存不失效**：缓存 key 没覆盖 vault/settings 变化，面板显示过期列表。

另有两个边界修复：关闭视图 mid-run 不得再写 DOM（`closed` 闩锁 + partial turn）；`onunload` 必须同步落盘（Obsidian 不 await）。

## 合并到 main

- 2026-11-26：功能分支 `dsh-obsidian-deepharness-new-architecture` 领先 main 28 commits、47 files、+3304/−987。
- 合并前四项验证：`npm test` 294 passed / 2 skipped、`tsc` 通过、`build` 通过、eslint 0 errors / 9 warnings。
- `git merge --ff-only f60d71d` 快进，0 冲突；push 到 origin main。
- 功能分支保留在同一提交；当前工作区切到 main 继续开发。

## 文档收敛（2026-11-26）

- 删除/归档 `HANDOFF.md`、`AI_CONTEXT.md`、`DESIGN.md`、`README_EN.md`；历史审查与 release notes 移入 `docs/history/`、`docs/releases/`。
- 新入口：`AGENTS.md`；架构 `docs/architecture.md`；开发 `docs/development.md`；任务 `docs/roadmap.md`。
- 原因：四份文档重复且互相矛盾；新 agent 无法判断哪份是事实源。

## 教训

1. **路径必须在用的时候解析**，不要在 `onload` 捕获字符串。
2. **写入根和扫描根必须是同一个**；迁移后最容易在这里静默分裂。
3. **UI 组件只在 `onOpen()` 后创建**；构造函数里拿不到锚点。
4. **恢复会话 = transcript + memory**，只恢复一半等于没恢复。
5. **单测绿不等于 UI 可用**；关键路径必须部署真人走。
6. **不要用“再加一份交接文档”解决文档漂移**；单一事实源 + 状态进 roadmap。
