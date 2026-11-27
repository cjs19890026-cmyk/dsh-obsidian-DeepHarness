# DeepHarness — DeepSeek Harness for Obsidian

> **[中文版](./readme-ch.md) · English**

A Claudian-style AI assistant plugin for Obsidian: it calls **DeepSeek Harness** directly from the side panel. Send a task and the DSH agent works in your vault as its working directory, using its full toolset (bash, file read/write, web search, subagents, skills, …) autonomously.

<p align="center">
  <img src="docs/images/deepharness-demo.png" alt="DeepHarness feature showcase — DeepSeek Harness running inside Obsidian" width="85%" />
  <br />
  <em>Feature showcase — send a task in the side panel, and the DeepSeek Harness agent works in your vault.</em>
</p>

> Architecture: [`docs/architecture.md`](./docs/architecture.md) ·
> Roadmap: [`docs/roadmap.md`](./docs/roadmap.md) ·
> Development: [`AGENTS.md`](./AGENTS.md) / [`docs/development.md`](./docs/development.md).

## How it works

```
Obsidian plugin ──spawn──▶ dsh --profile headless --patch <vault.yml> "<task>"
                            │ cwd = vault root (or the configured subfolder)
                            │ DSH_HOME = ~/.dsh/deepharness/<vaultKey>
                            ▼
                    DeepSeek Harness agent
                    bash │ file tools │ web_search │ subagents │ skills …
```

The plugin is a bridge, not an agent: it prepares an isolated DSH home, injects a vault-aware persona and a streaming relay, then renders the result. Credentials are reused from your own DSH setup; the global `~/.dsh` settings are never polluted.

## Prerequisites

1. Install the DSH CLI:

   ```bash
   npm i -g @deepseek-ai/dsh
   ```

2. Configure model credentials (either one):
   - DSH web (Models page) writes `~/.dsh/.credentials.yaml`
   - Or export the `DEEPSEEK_API_KEY` environment variable

3. Click **Check** on the plugin settings page to confirm `dsh` is detected.

## Installation

### From the Obsidian community plugin market (recommended)

1. Open Obsidian → **Settings → Community plugins**.
2. Turn off **Restricted mode** if needed.
3. Click **Browse**, search for **DeepHarness**.
4. Click **Install**, then **Enable**.
5. Open **DeepHarness settings** and run **Check** to verify `dsh` is detected.

### From GitHub Release / source (development)

```bash
npm ci
npm run build
./deploy.sh /path/to/your/vault
```

`deploy.sh` copies `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/deepharness/`. Reload the plugin in Obsidian.

## Features

- 💬 **Chat panel**: send a task → status indicator (starting / thinking / elapsed) → Markdown-rendered result
- 🧠 **Model list you own**: the model dropdown is fed by an editable list, so a model DeepSeek ships after this plugin release can be added by typing its id — no plugin update needed. **Import from DSH** pulls in the ids your own DSH settings declare, only when you press it. Defaults to `deepseek-flash`
- ⚙️ **Reasoning effort (Thinking)**: switch **off / high / max** in the toolbar; written to the plugin-owned DSH_HOME, credentials are symlinked from `~/.dsh`
- ⏹ **Stop button** (SIGTERM) and a timeout fallback (default 10 minutes)
- 📝 **Conversation memory**: key points from earlier turns are refilled into new tasks; a resumed session also carries a compressed digest of its earlier turns, even if automatic memory is off
- ✍️ **Selection actions**: select text → **rewrite / summarize / explain / custom**; preview the result, then replace the selection or insert it below — nothing is written until you confirm
- 🔍 **Review & undo**: after a run, see the Markdown files that changed with a compact diff; undo one file or the whole run, no git required
- 🗂 **Batch across notes**: pick multiple notes and run one instruction sequentially — per-item status, cancel anytime, failures don't stop the batch, one review/undo at the end
- 🕘 **Auditable session history**: conversations are archived per session; each run records status, tools, duration, changed files, and errors. The panel supports resume / pin / rename / note, title/note and 7/30-day filters, expandable details, and copy-summary. The current session is atomically persisted after every turn — sessions not archived when Obsidian quit/crashed are restored on next launch
- 📋 **Copy / Save as note** in one click; UI text is selectable
- 🔗 **Reference current note**: the quote icon inserts the note you are reading — with a **text selection**, it inserts the selection as a quoted block (truncated with a source line); without a selection, a bare wikilink
- @ **Mention notes**: type `@` to search and reference any note; inserted as `[[path]]` (scoped by the **Working directory** setting)
- ⚙️ **Command**: "Process current note"
- 🗂 **Generated vault persona** (`.obsidian/plugins/deepharness/generated/vault.yml`) instructs the agent to use wikilinks and ask before destructive operations; freely editable
- 🩺 **Environment check + diagnostics**: reports `dsh`, Node.js and the three paths the plugin must write, with a concrete remedy for each failure. A failing check can produce a copyable report
- 🔄 **Update check**: shows whether a newer release exists. The plugin never downloads or installs updates itself — that stays with Obsidian
- 🌐 **i18n UI** (English / 中文)

## Settings

| Setting | Default | Description |
|---|---|---|
| dsh binary path | auto-detect | Empty = PATH |
| Node.js path | auto-detect | The plugin runs the dsh script with node directly (bypasses the shebang issue under Obsidian's restricted PATH) |
| DSH_HOME | `~/.dsh` | Your DSH credentials/config root. The plugin keeps its own isolated home at `~/.dsh/deepharness/<vaultKey>/` |
| Plugin API key | empty | DeepSeek API key used ONLY by this plugin; empty = reuse desktop credentials |
| Model provider | DeepSeek official API | deepseek-official = DeepSeek official API; opencode-go = OpenCode Go subscription |
| Working directory | vault root | Relative subfolder to scope the agent |
| Task timeout | 600s | Auto-stops the run when exceeded |
| Conversation memory | on | Context refill |
| Tool execution mode | default (native) | native / code / both (tool backend, not a file sandbox) |
| Model | `deepseek-flash` | Selected from the editable **Model list**; add any model id |
| Model list | 4 built-in ids | The models offered in the dropdowns; **Import from DSH** appends ids on demand |
| Reasoning effort | high | off / high / max; switchable from the toolbar |
| Security mode | workspace write | read-only / workspace write / full access |
| Show thinking | on | Collapsible thinking block before the answer |
| Show tool calls | on | Shows tool invocations as they run |
| History entries | 50 | Max sessions kept; oldest removed first |
| Custom persona | empty | Extra instructions appended to the agent system prompt |

## Security

- **Sandbox by default**: `DSH_PERMISSION_MODE` is consumed by DSH's sandbox policy. In **workspace write**, bash and file tools can only write inside the vault workspace + the system temp directory; **read-only** rejects writes. **Full access** is equivalent to running `dsh` in your terminal and requires an explicit second confirmation.
- If the host sandbox is unavailable, DSH **fails closed** (`SANDBOX_UNAVAILABLE`) rather than silently running unsandboxed.
- Credentials go through existing DSH configuration by default. Optionally, a plugin-only API key is stored in the local plugin data file and injected as an environment variable at run time — never shared with the desktop app.
- All child processes are terminated when the plugin unloads.
- The only request the plugin makes on its own behalf is the update check, and only when you press it: it asks the public GitHub releases API for this repository's latest version. No telemetry, and the diagnostic report contains no credentials.

## Roadmap

- **0.2.0 — Work in the note**: selection actions, post-run review + undo, auditable run history, and batch processing across notes.
- **Later**: native session continuity, custom DSH profiles, skill editing UX, recipes.

Full priorities and acceptance criteria: [`docs/roadmap.md`](./docs/roadmap.md).

## Development

```bash
npm ci
npm test
npx tsc --noEmit
npm run build
npx eslint "src/**/*.ts"
./deploy.sh /path/to/your/vault
```

Read [`AGENTS.md`](./AGENTS.md) first; it routes to architecture, roadmap and development docs.

## License

MIT
