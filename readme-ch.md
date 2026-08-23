# DeepHarness — DeepSeek Harness for Obsidian

<div align="center">
  <h3>让 DeepSeek Harness 住进你的 Obsidian 笔记库 ✨</h3>
  <p><b>真正的 Agent · 完整工具链 · 数据与密钥留在本机</b></p>
  <p>
    <img src="https://img.shields.io/badge/version-0.1.0-4C8DFF?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/Obsidian-1.13.0%2B-7C3AED?style=flat-square&logo=obsidian&logoColor=white" alt="Obsidian">
    <img src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square" alt="License">
    <img src="https://img.shields.io/badge/platform-desktop%20only-8A2BE2?style=flat-square" alt="Desktop only">
  </p>
</div>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./DESIGN.md">设计文档</a> ·
  <a href="https://github.com/cjs19890026-cmyk/dsh-obsidian-DeepHarness">GitHub</a>
</p>

> [!NOTE]
> 本插件是**桌面端插件**：它需要在本机拉起 `dsh` 子进程并直接操作 vault 文件，因此不支持 Obsidian Mobile。

---

<div align="center">
  <img src="docs/images/deepharness-demo.png" alt="DeepHarness 功能展示" width="85%" />
  <br />
  <em>功能展示 — 在侧边栏发送任务，DeepSeek Harness agent 在你的笔记库中自主执行</em>
</div>

---

## 👋 为什么选择 DeepHarness？

市面上的 Obsidian AI 插件大多只做“问答 + RAG”：把笔记切片塞进提示词，或者只能围绕当前文档做补全。**DeepHarness 选择把 DeepSeek Harness（DSH）的完整 Agent 运行时直接搬进 Obsidian**：你在侧边栏发送一个任务，DSH agent 就以 vault 为工作目录自主执行，调用 **bash、文件读写、web 搜索、子代理、技能系统** 等完整工具——真正能读、能搜、能改、能写你的笔记。

这种做法的优势很直接：**能力不缩水**——执行层下沉到 DSH runtime，插件只做进程桥接与 UI（设计参考 Claudian，但避免了在插件里重写 agent），DSH 每升级一次模型、工具或技能，插件自动受益；**边界清晰、可观测**——流式显示思考过程与工具调用日志，可随时停止、超时兜底，并用三级安全模式控制文件权限；**本地优先、不污染配置**——凭据默认复用本机 `~/.dsh`，可选插件专属 API Key，模型/推理设置写入插件专属 DSH_HOME，不影响 DSH 桌面端。

功能上开箱即得：**DeepSeek V4 Flash / V4 Pro 模型切换、off / high / max 推理强度、会话历史（恢复 / 置顶 / 重命名 / 备注）、@ 提及与 `[[wikilink]]` 引用、回答自动出链、长期记忆 `Harness/memory.md`、内置 Obsidian 技能、一键复制 / 存为笔记、中英文界面**。

---

## 📥 安装条件

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Obsidian | **1.13.0 及以上**的桌面版 | Windows / macOS / Linux 均可；移动端不支持 |
| Node.js | **20+（建议 LTS）** | 构建插件与运行 DSH 都需要；若 `dsh` 的 shebang 在 Obsidian 受限 PATH 下失效，插件会直接用 node 运行 DSH 入口脚本 |
| DeepSeek Harness CLI | `npm i -g @deepseek-ai/dsh` | 插件不内置 agent，DSH 才是执行引擎 |
| DeepSeek 凭据 | 任选其一 | ① 在 DSH Web（Models 页）写入 `~/.dsh/.credentials.yaml`；② 导出 `DEEPSEEK_API_KEY` 环境变量；③ 在插件设置中填写「插件专属 API Key」 |

```bash
# 安装 DSH CLI
npm i -g @deepseek-ai/dsh

# 验证 DSH 本身可用（能正常出结果再装插件）
dsh --profile headless "用 bash 运行 pwd 和 ls"
```

装好后，在插件设置页点击 **「运行检查」**：插件会自动探测 `dsh` 与 Node.js 路径并显示版本；探测不到时，再在设置里手动填写对应路径。

## 🛠 安装方法

### 方法一：从 Obsidian 插件市场安装（推荐）

1. 打开 Obsidian → **设置 → 第三方插件**。
2. 如果处于安全模式，先关闭安全模式。
3. 点击 **浏览**，搜索 **DeepHarness**。
4. 点击 **安装**，然后 **启用**。
5. 进入 DeepHarness 设置，点击 **运行检查**，确认 `dsh` 可用。

### 方法二：从 GitHub Release 安装

1. 打开本仓库的 [Releases](https://github.com/cjs19890026-cmyk/dsh-obsidian-DeepHarness/releases) 页面，下载最新版本附带的三个文件：`main.js`、`manifest.json`、`styles.css`。
2. 在你的 vault 中创建插件目录：

   ```bash
   mkdir -p "/path/to/你的vault/.obsidian/plugins/deepharness"
   ```

3. 把三个文件复制到该目录，结构如下：

   ```
   <vault>/.obsidian/plugins/deepharness/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```

> 如果 Releases 页面暂时还没有资产（当前仍是开发预览），请直接使用方法三。

### 方法三：从源码构建

```bash
git clone https://github.com/cjs19890026-cmyk/dsh-obsidian-DeepHarness.git
cd dsh-obsidian-DeepHarness
npm install
npm run build
```

构建产物位于 `dist/`。macOS / Linux 可一键部署：

```bash
./deploy.sh /path/to/你的vault
```

或手动复制：

```bash
V="/path/to/你的vault"
mkdir -p "$V/.obsidian/plugins/deepharness"
cp dist/main.js dist/manifest.json dist/styles.css "$V/.obsidian/plugins/deepharness/"
```

Windows PowerShell：

```powershell
$V = "$env:USERPROFILE\Documents\YourVault"
New-Item -ItemType Directory -Force "$V\.obsidian\plugins\deepharness"
Copy-Item dist\main.js, dist\manifest.json, dist\styles.css "$V\.obsidian\plugins\deepharness\"
```

### 启用插件

1. 打开 Obsidian → **设置 → 第三方插件**，确认未处于安全模式。
2. 在「已安装插件」中找到 **DeepHarness**，打开开关。
3. 进入 **设置 → DeepHarness → 运行检查**，确认 `dsh` 和 Node.js 都显示 ✓。
4. 点击左侧 ribbon 的 🤖 图标，或执行命令面板中的 **「打开 DeepHarness」**，开始使用。

---

## 🚀 快速开始

在聊天面板里，像给同事派活一样发送任务：

- “把 `Projects` 里所有带 `#todo` 的笔记汇总成一篇周报，写到 `周报/本周.md`”
- “读一下《会议 2026-08-16》，用中文给出 3 条行动项”
- “用 bash 找出最近 7 天修改过的笔记，按目录统计数量”

三个高频操作：

- **引用当前笔记**：点击输入框上方的 `<` —— 笔记中选中了文字会以引文块插入；没有选区则插入 `[[wikilink]]`。
- **提及笔记**：输入 `@`（或点击 @ 按钮）按标题/路径搜索并插入笔记。
- **调用技能**：点击 🔧 按钮选择技能，或在输入框输入 `/` 弹出技能补全。

---

## ✨ 功能详解

### 💬 对话体验

- **流式任务面板**：发送任务 → 状态指示（启动 / 思考 / 耗时）→ 思考过程与工具调用实时滚动 → Markdown 渲染最终回答。
- **回答自动出链**：回答中提到的笔记标题 / 别名 / 路径，即使没写 `[[]]`，渲染时也会自动变成可点击的内部链接；代码块、已有链接、URL 不会被误链。
- **一键复制 / 存为笔记**；界面文本支持光标选择。
- **上下文用量环**：输入框底部实时估算当前模型上下文窗口占用。

### 🧭 与 Vault 协作

- **引用当前笔记**：有选区时把选中内容以引文块插入（超长自动截断并附来源行）；无选区时插入 `[[wikilink]]`。
- **@ 提及笔记**：按标题 / 路径实时匹配，选中后以 `[[路径]]` 形式插入，范围跟随设置中的「工作目录」。
- **输入框笔记 chips**：输入框中的 `[[wikilink]]` 渲染为可点击的笔记标签，不再是一长串路径。
- **命令**：「让 DeepHarness 处理当前笔记」自动把当前笔记内容（前 20000 字）填入任务。
- **长期记忆** `Harness/memory.md`：agent 每轮任务先读、结束时把跨会话结论写回；用户可自由编辑。
- **自动生成 vault persona**（`.obsidian/plugins/deepharness/generated/vault.yml`）：约束 agent 使用 wikilink、破坏性操作先征得同意；可自行编辑。
- **内置 `obsidian` 技能**：agent 自动获得 Obsidian 约定（frontmatter / wikilink / tag / 日记 / 附件等）与安全红线；用户可放自己的技能到 `<vault>/.dsh/skills/obsidian/` 覆盖。

### 🧠 模型与运行控制

- **模型选择器**：聊天面板顶栏可切换 **DeepSeek V4 Flash / DeepSeek V4 Pro**。
- **推理等级（Thinking）**：顶栏可切换 **off / high / max**。
  - 通过插件专属 DSH_HOME（`dsh-home/` 目录）写入 `agent-default-model` 配置，凭据软链复用 `~/.dsh`，**不污染**全局 DSH 设置。
- **安全模式（Security）**：只读 / 工作区写入 / 完全访问；切入「完全访问」必须二次确认。
- **停止按钮**：SIGTERM 终止运行；**超时兜底**默认 10 分钟。
- **对话记忆**：前几轮要点自动回填到新任务。

### 🕘 会话历史

- 对话按「会话」归档，历史面板支持 **恢复 / 置顶 / 重命名 / 备注 / 删除**。
- 当前会话每轮完成后实时原子落盘；退出 / 崩溃 / 重载后未归档的会话会在下次启动自动补进历史，不丢记录。
- 置顶会话不会被自动清理；条数上限可在设置中调整。

### 🧰 技能系统

- **技能按钮**（🔧）列出 DSH 发现的全部技能（名称 + 描述 + 来源），点击把 `/技能名 ` 插入输入框。
- 输入 `/` 弹出技能补全；DSH 原生识别 `/名称` 斜杠调用并自动注入技能全文。
- 内置 `obsidian` 技能之外，可配置附加技能目录（默认扫描 `Library/Skills`、`.claude/skills`）。

---

## ⚙️ 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| dsh 二进制路径 | 自动探测 | 留空 = PATH；探测顺序：设置值 → PATH → 常见安装目录 |
| Node.js 路径 | 自动探测 | 插件用 node 直接运行 dsh 脚本，绕过 Obsidian 受限 PATH 的 shebang 问题 |
| DSH_HOME | `~/.dsh` | 凭据 / 配置根 |
| 插件专属 API Key | 空 | 仅供插件使用的 DeepSeek API Key（与桌面端分离）；留空 = 复用桌面端凭据 |
| 模型提供方 | DeepSeek 官方 API | deepseek-official = DeepSeek 官方接口；opencode-go = OpenCode Go 订阅（OpenAI 兼容，接口 https://opencode.ai/zen/go/v1） |
| 工作目录 | vault 根 | 可填相对子目录限定 agent 范围；越界路径会安全回退到 vault 根 |
| 任务超时 | 600s | 超时自动停止 |
| 对话记忆 | 开 | 上下文回填 |
| 工具执行模式 | 默认（native） | native / code / both（工具后端，不是文件沙箱开关） |
| 模型（Model） | DeepSeek V4 Flash | 默认模型，顶栏可快速切换 |
| 推理等级（Thinking） | high | off / high / max，顶栏可切换 |
| 安全模式（Security） | 工作区写入 | 只读 / 工作区写入 / 完全访问 |
| 显示思考过程 | 开 | 回答前显示可折叠思考过程 |
| 显示工具调用 | 开 | 执行 bash / 文件等工具时显示调用记录 |
| 历史记录条数 | 50 | 历史面板最多保留的会话数，超出删最旧 |
| 内置 Obsidian 技能 | 开 | 注入 `obsidian` skill（vault 约定 + 长期记忆） |
| 附加技能目录 | `Library/Skills, .claude/skills` | 逗号分隔的 vault 相对目录，注册给 DSH skill 系统 |
| 语言 | auto | 插件界面语言（en / 中文） |
| 自定义 persona | 空 | 追加指令到 agent 系统提示词 |

---

## 🧭 工作原理

```
Obsidian 插件 ──spawn──▶ node <dsh入口脚本> --profile headless --patch <vault.yml> "<任务>"
                            │ cwd = vault 根（或设置的工作目录）
                            │ DSH_HOME = 插件专属目录（凭据软链复用 ~/.dsh）
                            │ DEEPSEEK_API_KEY = 可选插件专属 Key
                            ▼
                    DeepSeek Harness agent
                    bash │ 文件工具 │ web 搜索 │ 子代理 │ skills
```

插件不实现任何 agent 逻辑，只做三件事：**探测并拉起 `dsh` 子进程、注入 vault persona 与流式事件 relay、渲染结果**。

---

## 🔒 安全

- 默认「工作区写入」模式下，`DSH_PERMISSION_MODE` 由 DSH 沙箱策略消费：**bash 与文件工具都只能写 vault 工作区 + 系统临时目录**；「只读」模式拒绝一切文件修改。
- 切入「完全访问」需要显式二次确认：该模式等同你在终端运行 `dsh`，agent 可读写 vault 外文件。
- 沙箱后端不可用时 DSH 会 **fail-closed**（`SANDBOX_UNAVAILABLE`），而不是降级为无沙箱运行。
- 插件自身不发任何网络请求、不收集密钥；凭据默认全部走 DSH 既有配置，可选插件专属 Key 只存在本机插件数据文件，运行时以环境变量注入。
- 卸载 / 重载插件时终止所有 `dsh` 子进程；任务超时自动停止。

---

## 🗺 Roadmap

- **Phase 1 / 2（已完成）**：子进程桥接、环境自检、流式输出、工具调用日志、会话历史持久化、模型 / 推理 / 安全切换、@ 提及、技能系统、长期记忆。
- **Phase 3（进行中）**：文件修改 diff 确认、批量处理 vault 笔记、发布到 Obsidian 社区插件市场。

详见 [`DESIGN.md`](./DESIGN.md)。

---

## 🛠 开发与贡献

```bash
git clone https://github.com/cjs19890026-cmyk/dsh-obsidian-DeepHarness.git
cd dsh-obsidian-DeepHarness

npm install          # 安装依赖
npm run dev          # 开发构建（监听改动）
npm run build        # 生产构建到 dist/
npm test             # 运行测试
./deploy.sh <vault>  # 构建并部署到指定 vault
```

欢迎提交 Issue / PR。功能需求与设计取舍请先阅读 [`DESIGN.md`](./DESIGN.md)。

---

## 🙏 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：本插件的执行引擎。
- [Enigmora/claudian](https://github.com/Enigmora/claudian)：交互与插件架构思路的重要参考。
- [Nagi-ovo/voyager](https://github.com/Nagi-ovo/voyager)：本文档结构参考。

## 许可

MIT
