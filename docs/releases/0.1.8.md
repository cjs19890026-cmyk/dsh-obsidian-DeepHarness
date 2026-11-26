# 0.1.8

## 中文

**模型列表由你自己维护**
模型不再写死在插件里。设置页新增可编辑的模型列表，官方发布新模型时直接填 ID 加一行就能用，不用等插件更新。内置的模型也可以删除，另有「从 DSH 导入」按钮可一键导入你 DSH 配置里已有的模型。

**设置页重新分组**
原来 21 项设置挤在一组里，现在分成 7 组：常规 / 模型 / 权限与执行 / 技能 / 人格 / 运行环境与凭据 / 更新与诊断。

**环境检查能告诉你怎么办**
每个失败项都给出具体建议——安装命令、该填哪个路径，或常见原因（vault 在同步目录里、目录只读、权限不足）。检查失败时可以「复制诊断信息」，预览后复制给任意 AI 助手帮你诊断。

**新增更新检查**
设置页可检查是否有新版本。插件不会自己下载安装更新，更新仍由 Obsidian 完成。

**修复**
- 报错提示的样式问题：此前红色背景与文字对比过低，且警告图标会异常放大遮住文字
- 诊断报告预览框文字被弹窗边框截断
- 环境检查重复点击会叠加多份结果

---

## English

**The model list is yours to maintain**
Models are no longer hard-coded. A new editable model list in the settings means a model DeepSeek ships later can be added by typing its id — no plugin update needed. Built-in entries can be deleted too, and **Import from DSH** pulls in the models your own DSH settings already declare.

**Settings regrouped**
21 settings in one group became 7: General / Model / Permissions and execution / Skills / Persona / Runtime and credentials / Updates and diagnostics.

**The environment check now tells you what to do**
Every failure carries a concrete remedy — an install command, which path to fix, or the usual causes (vault inside a sync folder, read-only folder, permissions). A failing check offers **Copy diagnostics**: previewed, then copyable into any assistant.

**New update check**
See whether a newer release exists. The plugin never downloads or installs updates itself — that stays with Obsidian.

**Fixes**
- Error notice styling: the red background left too little contrast, and the warning glyph could balloon and cover the text
- Text in the diagnostic report preview was clipped by the modal border
- Re-running the environment check stacked duplicate reports
