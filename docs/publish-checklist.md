# 发布到 Obsidian 社区插件市场 — 检查清单

> 流程依据：[官方提交指南](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin) 与
> [插件提交要求](https://docs.obsidian.md/Community+directory/Submission+requirements+for+plugins)。
> 旧版「fork obsidian-releases 提交 PR」已废弃；现在通过 **community.obsidian.md 目录**网页提交。
> 开发/验证/发布背景见 [`development.md`](development.md)。

## 0. 发布前硬性检查

- [ ] GitHub 仓库 public：`cjs19890026-cmyk/dsh-obsidian-DeepHarness`
- [ ] `manifest.json` 必备字段齐全
- [ ] 插件 id 不含 "obsidian"：`deepharness`
- [ ] id 全局唯一（查 community-plugins.json 无冲突）
- [ ] `description` ≤250 字符、动作式开头、以句号结尾、无 emoji
- [ ] `isDesktopOnly: true`（使用 Node/Electron API）
- [ ] 命令 id 不含插件 id（`open-harness-chat` / `ask-active-note`，Obsidian 自动加前缀）
- [ ] `LICENSE`（MIT）、英文 `README.md` + 中文 `readme-ch.md`
- [ ] `npm run build` production 构建通过，**294 tests 全过**（以当次实测为准）
- [ ] 四项验证通过：`npm test` / `npx tsc --noEmit` / `npm run build` / `npx eslint "src/**/*.ts"`
- [ ] 手工测试清单至少走一遍（[`development.md`](development.md) §5）
- [ ] `package.json`、`manifest.json`、`package-lock.json` 根 version 一致
- [ ] 文档已同步：README 功能/安全/设置、roadmap 状态、release notes

## 1. 创建 GitHub Release（已自动化）

已配置 [`.github/workflows/release.yml`](../.github/workflows/release.yml)：**推 tag → 校验版本 → 测试 → 构建 → artifact attestation → 草稿 Release（三件套）→ 手动发布**。0.1.8 及之前的流程已验证。

发布新版本：

```bash
git tag -a 0.1.9 -m 0.1.9   # tag 必须等于 manifest version，不带 v
git push origin 0.1.9
```

Actions 完成后，到 Releases 页编辑草稿，补 release notes 并 Publish。

- 已发布版本：见 https://github.com/cjs19890026-cmyk/dsh-obsidian-DeepHarness/releases
- 三件套缺一不可：`main.js` / `manifest.json` / `styles.css`

## 2. 首次提交到 Obsidian 社区目录（网页操作）

> 插件若已在目录中，日常发版跳过本节；只需发新 Release。

1. 打开 [community.obsidian.md](https://community.obsidian.md)，用 **Obsidian 账号**登录。
2. 进入 **Community profile** → **GitHub** 区块点 **Connect**，关联拥有仓库的 GitHub 账号（目录需要只读验证）。
3. 左侧 **Plugins** → **New plugin**：
   - 仓库 URL：`https://github.com/cjs19890026-cmyk/dsh-obsidian-DeepHarness`
   - 目录读取默认分支 HEAD 的 `manifest.json`（id `deepharness`、version 与 Release tag 一致）
4. 提交后触发自动审查（含 artifact attestation 校验）：
   - 有错误 → 修仓库 + 发新版本 Release（版本递增）
   - 无错误 → 编辑描述并 **Publish**
5. 发布后，用户在 Obsidian 设置 → 第三方插件 → 浏览 搜索 "DeepHarness" 安装。

## 3. 后续更新（每次发版）

1. bump `package.json` + `manifest.json`（+ lock 根 version），提交推送。
2. 打 tag 并 push：`git tag -a <版本> -m <版本> && git push origin <版本>`。
3. Actions 生成草稿 → Releases 页补 notes → Publish。
4. 用户端自动检测更新；**不需要**重新提交目录。

## 常见被拒/失败原因

| 原因 | 说明 |
|---|---|
| tag 带 `v` 前缀 | 必须与 manifest version 完全一致，如 `0.1.9` |
| Release 缺 `main.js` | 三件套缺一不可 |
| 仓库 private | 目录无法访问 |
| id 含 "obsidian" | 官方硬性规则，已规避（id = `deepharness`） |
| 描述夸大 | 描述会被当作声明与代码核对 |
| version 不一致 | manifest version 必须等于 release tag；lock 根 version 也要同步 |
| 跳过手工测试 | 单测绿但 UI 坏了，会在用户侧暴露 |
