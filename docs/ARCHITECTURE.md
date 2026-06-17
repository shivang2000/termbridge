# termbridge — Architecture

Companion to [PLAN.md](PLAN.md). This doc explains *how* the pieces fit and *what we reuse* from the two
inspiration repos.

## 1. The core idea: tmux as a shared substrate

The hard requirement is letting **one** terminal session be driven by an automated agent **and** watched
/typed by a human at the same time. Instead of inventing a multiplexing protocol, we let **tmux** own the
session. Two independent clients talk to the same tmux server:

```
            ┌──────────────── agent side ────────────────┐   ┌──── human side ────┐
  Hermes /  │  MCP tools: open_session, send_text,        │   │  Browser xterm.js  │
  Claude    │  read_screen, read_new_output, send_control │   │        ↕ WebSocket │
  Code /    │            ↓ (child_process)                │   │  PTY: tmux attach  │
  Cursor  → │   tmux send-keys / capture-pane -pt <s>     │   │        -t <s>      │
            └─────────────────────┬───────────────────────┘   └─────────┬──────────┘
                                  ↓                                      ↓
                       ┌──────────────────────  tmux server  ──────────────────────┐
                       │  session <s>  (the ONE shared terminal — both see it live) │
                       └───────────────────────────────────────────────────────────┘
                          runs inside ↓ (user-selectable TerminalEnvironment)
                       ┌─────────────────┬──────────────────┬──────────────────────┐
                       │  Local host     │  Docker per-sess. │  Cloud sandbox (later)│
                       └─────────────────┴──────────────────┴──────────────────────┘
```

Why this works (verified — see [RESEARCH.md](RESEARCH.md)): the agent control layer **never holds the
attachment**; it only issues tmux CLI commands. So any human `tmux attach` reaches the identical
server-side session. tmux provides persistence + reconnect natively.

## 2. Layers

1. **`core`** — framework-agnostic. Knows tmux + environments; knows nothing about MCP or HTTP.
   - `TerminalEnvironment` (pluggable backend) + `Session` (per-session ops) + `tmux` helpers +
     `output-buffer` (offset reader) + `lock` (advisory).
2. **`mcp-server`** — translates MCP tool calls → `core`. The primary agent interface.
3. **`web`** — `xterm.js` client + Hono/Bun WebSocket bridge whose PTY runs `tmux attach`. The human
   interface. Includes the OAuth-URL detector.
4. **`claude-code-plugin`** *(later)* — packaging + wake-on-terminal-event for Claude Code.

Each layer depends only downward. `mcp-server` and `web` are independent siblings on top of `core`,
which is why a human and an agent can act on the same session without knowing about each other.

## 3. Data flows

**Agent issues a command**
```
agent → MCP send_text{name,text} → core.Session.sendKeys → env.tmux(["send-keys","-t",name,"--",text,"Enter"])
      → tmux delivers keystrokes to the shell in session <name>
```
**Agent reads output**
```
agent → MCP read_new_output{name,sinceOffset} → core.output-buffer (diff vs capture-pane) → {data,nextOffset}
```
**Human watches/types**
```
browser xterm onData → WS {stdin} → bridge → pty.write → `tmux attach` stdin → shell
shell stdout → `tmux attach` stdout → pty.onData → WS {stdout} → xterm.write
```
Both paths hit the **same** tmux session, so the agent's `send_text` output appears in the human's xterm
and the human's keystrokes are visible to the agent's `read_screen`.

## 4. Reuse map (don't reinvent)

### From `sentry-fixer-bot` / `alertforge` — the human↔web-terminal half

| Source file | Reuse |
|---|---|
| `apps/web/src/components/xterm-panel.tsx` | xterm React component (fit + web-links addons) — reuse ~as-is as `web/client/XtermPanel.tsx`. |
| `apps/web/src/components/chat-terminal.tsx` | WS client + per-keystroke `stdin` forwarding + message switch — reuse the protocol as `SessionTerminal.tsx`. |
| `apps/server/src/routes/chat-ws.ts` | Hono+Bun `createBunWebSocket` handler; JSON protocol (`init`/`stdin`/`resize`/`stdout`/`exit`/`oauth_url`). Generalize: spawned command becomes `tmux attach -t <name>`. |
| `apps/server/src/chat/pty-runner.ts` | PTY spawn. **Upgrade**: replace the `script(1)` trick with `node-pty` so live resize (SIGWINCH) works — the file's own comments call out script(1)'s fixed-cols limitation. |
| `apps/server/src/chat/url-detector.ts` (+ `url-detector.test.ts`) | OAuth/device-code scraper — **port verbatim** (+ tests). This is the "drive logins through the website" magic. |
| `apps/web/src/components/inline-login-session.tsx` + `oauth-card.tsx` | Login flow UI → `OAuthCard.tsx`. |

Notable detail to preserve: alertforge spawns a **wide** PTY (500 cols) so login URLs don't hard-wrap,
which keeps `url-detector` reliable. tmux lets us set window width explicitly via `new-session -x`.

### From `paperclip` — the agent↔execution-environment half

| Source | Mirror as |
|---|---|
| `packages/adapter-utils/src/types.ts` (`ServerAdapterModule`) + `sandbox-managed-runtime.ts` (`SandboxRemoteExecutionSpec`, `SandboxManagedRuntimeClient`) | Shape of our `TerminalEnvironment` / provider interface. |
| `packages/plugins/sandbox-providers/{e2b,daytona,cloudflare}` | Port as `SandboxEnvironment` backends (M6). |
| `packages/shared/src/types/workspace-runtime.ts` | Transport enum (`local`\|`ssh`\|`sandbox`\|`plugin`) + lease acquire/resume lifecycle for cloud sessions. |
| `packages/mcp-server/src/{stdio,tools,client}.ts` | MCP server file layout (`@modelcontextprotocol/sdk`, stdio bin). |

### From the deep-research corpus — patterns

- **tmux substrate** (gotty's tmux workaround; tmux-mcp's `child_process` + `capture-pane -p`).
- **MCP tool taxonomy** (DesktopCommander `read_process_output` offset pagination; iterm-mcp 3-tool
  minimalism; pi-interactive-shell execution-mode taxonomy + takeover keys).
- **node-pty** as the PTY backend (or `zigpty` as a no-node-gyp fallback).

## 5. Environments compared

| | Local | Docker (default for untrusted) | Cloud sandbox (later) |
|---|---|---|---|
| Isolation | none (full host) | strong (shared kernel) | strongest (microVM, e.g. E2B/Firecracker) |
| Start latency | ~0 | ~100–500ms | ~150ms–few s |
| Persistence | host tmux | container + volume / tmux | provider snapshots/leases |
| Ops / cost | none | self-host, manage images + reap | per-hour $, third-party, data egress |
| Use when | trusted / dev | trusted-internal default | untrusted / multi-tenant / scale |

`tmux` runs *inside* whichever environment, so the human bridge and agent control layer are identical
across all three — the backend is a runtime swap, not a rewrite.

## 6. Known design tensions

- **Resize while two clients are attached** — tmux sizes a session window to the *smallest* attached
  client by default. We may pin window size (`new-session -x/-y` + `setw -g aggressive-resize`/`window-size`)
  so the agent's `capture-pane` width is stable regardless of the human's browser size.
- **`run_command` completion detection** — wrap commands with sentinel echo markers around `$?`
  (tmux-mcp's approach) to know when a one-shot finishes and to read its exit code.
- **Contention** — optional advisory write-lock; otherwise manual human interrupt, as every reviewed tool does.
