# L1 spike: native session continuity

> Status: research complete, 2026-11-27.
> Recommendation: **no-go for 0.2.0**. Keep the current "memory + transcript restore" behavior and revisit when upstream exposes a supported headless resume path.

## 1. Question

Can DeepHarness run a follow-up task in the same DSH session, so the agent keeps its native conversation history instead of replaying a transcript through the plugin's memory file?

## 2. Evidence

### 2.1 Headless has no resume flag

Installed CLI: `dsh 0.1.1-rc.2` (`/opt/homebrew/bin/dsh`).

```text
$ dsh --profile headless --help
Usage: dsh --profile headless [options] [task...]

Answer one task, print the final assistant message, and exit.

Options:
  -h, --help  show this help
```

`--resume` appears only in the top-level help example:

```text
dsh --profile tui --patch ./extra.yml      boot a custom profile with one extra overlay
dsh --profile tui --resume <session>       arguments after the launcher flags reach the app
```

But the `tui` profile is **not installed** on this machine:

```text
$ dsh --profile tui --help
Error: dsh: profile "tui" does not exist; create it with 'dsh plugin --profile tui add <package>'
```

Installed profiles: `desktop`, `headless`, `web` (plus `node_modules`).

### 2.2 The headless runner always mints a new session

`@deepseek-ai/dsh-headless/lib/index.js` creates a random id on every run:

```js
const { agent } = await agents.create({
  sessionId: SessionId(`session-${randomUUID()}`),
  meta: { cwd: process.cwd() },
  agentOptions: { provider: selection.provider, model: selection.model },
  setup: (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined });
  }
});
```

It then sends one follow-up, waits for idle, flushes the session, and exits. There is no branch that accepts an existing session id, and no `resume` config.

### 2.3 Persistence is already there

Headless composes `@deepseek-ai/dsh-session-persistence-jsonl` with:

```yaml
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')
```

This machine has 111 persisted session artifacts under `~/.dsh/sessions/<project>/<session-id>/session.jsonl.zstd`. Sessions are durable; the missing piece is the entry point, not storage.

### 2.4 Core APIs can resume

`@deepseek-ai/dsh-agent` exposes a real resume path:

```ts
interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId;
  readonly agentOptions?: AgentOptions;
  readonly signal?: AbortSignal;
  readonly setup?: AgentSetup;
}

resume(options: ResumeAgentOptions): Promise<AgentHandle>;
```

`@deepseek-ai/dsh-session-persistence` exposes `prepare(id)` and `list()`; the JSONL backend implements `list()` over stored headers. So a custom headless runner could:

1. list persisted sessions and pick an id;
2. call `agents.resume({ resumeSessionId, agentOptions, setup })`;
3. `followup(task)`, `whenIdle()`, `flush()`, print the final answer.

No unsupported private API is needed for the happy path. The cost is packaging a profile/runner that does this, plus validating replay/repair behavior.

## 3. Options

| Option | What it takes | Risk / cost | Verdict |
|---|---|---|---|
| **A. Wait for upstream** | Track `dsh` releases; use `--resume`/`--session` when the headless bundle exposes it | None today; timeline unknown | **Recommended for 0.2.0** |
| **B. Custom profile + runner bundle** | New `@deepharness/dsh-headless-continue` plugin, profile package installed into the plugin DSH_HOME, `dsh --profile ... --resume` | 5–8 days first version; ongoing DSH version coupling; profile install/pnpm/network support; need replay/repair tests | Not now |
| **C. Sidecar using DSH internal packages** | Node script imports `@deepseek-ai/dsh-*`, constructs AgentRegistry/session services, runs resume | Depends on internal module layout; Electron packaging; highest fragility | No |
| **D. Keep memory + transcript restore** | Current behavior: rebuild memory/transcript, new DSH session | Not native continuity; works today; no new dependency | **Keep** |

## 4. Recommendation

**No-go for 0.2.0.** The native capability exists in DSH's core, but exposing it in the plugin requires shipping and maintaining a custom DSH profile. That is a large jump in support surface for a feature whose user value is still unproven.

Keep the current behavior and its UI wording: "restore context" not "continue the same session". Revisit when one of these is true:

- upstream headless exposes `--resume` / `--session`;
- users repeatedly ask for true continuity and accept the profile-install cost;
- a spike shows option B is small (e.g. `--patch` can load a local runner plugin without a custom profile package).

## 5. If we revisit: acceptance criteria

1. `dsh --profile headless-continue --resume <id> "<task>"` runs non-interactively and exits with the follow-up answer.
2. The session keeps prior turns; a second resume sees the first follow-up.
3. A missing/corrupt session falls back to a new session with a clear message, never a crash.
4. The plugin only offers "continue" for sessions that still exist and whose profile/model is compatible.
5. Four checks pass, plus a real-vault test: run, close Obsidian, reopen, continue, verify the answer references the previous turn.
