# termbridge — Detailed Implementation Plan

Status: **planning**. This document is the source of truth for what we are building and in what order.
Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md), [RESEARCH.md](RESEARCH.md), [DECISIONS.md](DECISIONS.md).

---

## 1. Context

We want a reusable component that lets AI agents **run and interact with a real terminal via code**, and
lets a human **watch and type into the same session from a website**.

This generalizes what `sentry-fixer-bot` (`alertforge`) already does — stream an interactive PTY
(`claude`/`bash`) to a browser over WebSocket, even driving OAuth logins through the page — into a
standalone product that *any* agent (Claude Code, Cursor, Codex, a custom **Hermes** agent) can drive,
with the human and the agent sharing **one** live session.

A 110-agent deep-research pass (see [RESEARCH.md](RESEARCH.md)) confirmed that no existing tool
integrates both halves, and that the canonical answer to "how do a human and an agent share one
terminal" is **tmux as a shared substrate**. That is the foundation of this design.

## 2. Goals / Non-goals

**Goals**
- A framework-agnostic **core library** to create/drive/observe terminal sessions over a pluggable
  execution environment.
- An **MCP server** so any MCP-capable agent can open and interact with sessions programmatically.
- A **web UI** (`xterm.js` + WebSocket bridge) for a human to attach to the *same* session live.
- **Human + agent co-presence** on one session (tmux substrate), with session **persistence** and
  **reconnect** for free.
- Two interchangeable, **user-selectable** isolation backends from day one: **Local host** and
  **Docker-per-session**.
- Carry over `alertforge`'s **OAuth-URL bridging** so logins (`claude`/`gh`/`sentry-cli`) work from the web.

**Non-goals (for v1)**
- A bespoke multiplexing/locking protocol (research shows none exist in the wild; tmux co-presence +
  optional advisory lock is enough).
- Cloud-sandbox isolation (E2B/Daytona/Cloudflare) — designed-for via the same interface, **ported later**.
- The Claude Code plugin wrapper + wake-on-event — **later**, once core + MCP + web work.
- Multi-user auth/RBAC, billing, and a polished product UI.

## 3. Decisions (locked) — see [DECISIONS.md](DECISIONS.md) for rationale

| # | Decision | Choice |
|---|---|---|
| D1 | Human↔agent sharing | **tmux shared substrate** |
| D2 | Codebase | **brand-new standalone repo** (this one) |
| D3 | Packaging / first interface | **core lib + MCP server first**; Claude Code plugin + event-wake later |
| D4 | Isolation | **Local host AND Docker-per-session — both first-class, user-selectable at runtime**; cloud-sandbox later via the same `TerminalEnvironment` interface |

## 4. Tech stack

- **Language:** TypeScript. **Runtime:** Bun (server/bridge) + Node-compatible (matches both source repos).
- **Monorepo:** pnpm workspaces + Turbo. **Lint/format:** Biome.
- **Frontend:** `xterm.js` (`@xterm/xterm` v6) + `@xterm/addon-fit` + `@xterm/addon-web-links` + React 19.
- **PTY:** `node-pty` (live SIGWINCH resize — an improvement over `alertforge`'s `script(1)` approach).
- **Web transport:** Hono + Bun WebSockets (`createBunWebSocket` from `hono/bun`).
- **MCP:** `@modelcontextprotocol/sdk` (stdio + optional streamable HTTP).
- **Substrate:** `tmux` (must be present in every environment image/host).

## 5. Repo layout (target)

```
termbridge/
├─ docs/                      # this plan + architecture + research + decisions
├─ packages/
│  ├─ core/                   # framework-agnostic session/environment library
│  │  ├─ src/
│  │  │  ├─ environment.ts        # TerminalEnvironment interface + registry
│  │  │  ├─ environments/local.ts # LocalEnvironment (host tmux)
│  │  │  ├─ environments/docker.ts# DockerEnvironment (tmux via `docker exec`)
│  │  │  ├─ tmux.ts               # send-keys / capture-pane / list / new / kill helpers
│  │  │  ├─ session.ts            # Session: open/sendKeys/readScreen/readNewOutput/resize/close
│  │  │  ├─ output-buffer.ts      # incremental output w/ offset (bounded agent context)
│  │  │  └─ lock.ts               # optional advisory write-lock + read-only observer
│  ├─ mcp-server/             # MCP server over core (built first, after core)
│  │  ├─ src/{stdio.ts,http.ts,tools.ts,format.ts,config.ts}
│  ├─ web/                    # xterm.js frontend + WebSocket bridge
│  │  ├─ server/{bridge-ws.ts,pty-runner.ts,url-detector.ts}
│  │  └─ client/{XtermPanel.tsx,SessionTerminal.tsx,OAuthCard.tsx}
│  └─ claude-code-plugin/     # (later) .mcp.json + skill + wake-on-event
├─ docker/                    # reference image: tmux + node + node-pty preinstalled
└─ package.json / pnpm-workspace.yaml / turbo.json / biome.json
```

## 6. Core interfaces (design)

### 6.1 `TerminalEnvironment` (the pluggable isolation backend)

```ts
export type EnvironmentKind = "local" | "docker"; // "sandbox" added later

export interface TerminalEnvironment {
  readonly kind: EnvironmentKind;
  /** Ensure a tmux server + named session exist; idempotent. */
  ensureSession(name: string, opts?: { cwd?: string; cmd?: string; cols?: number; rows?: number }): Promise<void>;
  /** Run a tmux subcommand inside this environment, return stdout. */
  tmux(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
  /** Open a PTY that runs `tmux attach -t <name>` for the human bridge. */
  attachPty(name: string, size: { cols: number; rows: number }): PtyStream;
  /** Tear down the session (and, for docker, the container). */
  destroySession(name: string): Promise<void>;
  listSessions(): Promise<string[]>;
}

export interface PtyStream {
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  write(data: string): void;          // raw keystrokes from the browser
  resize(cols: number, rows: number): void;
  kill(): void;
}
```

- **`LocalEnvironment`** — `tmux(args)` = `child_process` `tmux <args>` on the host; `attachPty` =
  `node-pty.spawn("tmux", ["attach","-t",name])`. **No isolation** — flag-gated, surfaced in UI/MCP.
- **`DockerEnvironment`** — one container per session (tmux runs inside). `tmux(args)` =
  `docker exec <cid> tmux <args>`; `attachPty` = `node-pty.spawn("docker", ["exec","-it",cid,"tmux","attach","-t",name])`.
  Lifecycle: create container on `ensureSession`, `docker rm -f` on `destroySession`.

### 6.2 tmux command mapping (how core talks to the substrate)

| Operation | tmux command |
|---|---|
| create session | `new-session -d -s <name> [-x cols -y rows] [cmd]` |
| send text + Enter | `send-keys -t <name> -- "<text>" Enter` |
| send control char | `send-keys -t <name> C-c` / `C-z` / etc. |
| read full screen | `capture-pane -p -t <name>` |
| read with scrollback | `capture-pane -p -S -<n> -t <name>` |
| list sessions | `list-sessions -F "#{session_name}"` |
| resize (window) | handled by the attached PTY (SIGWINCH via node-pty) |
| kill session | `kill-session -t <name>` |

The agent layer never `attach`es — it only issues these CLI commands, so any human `tmux attach`
(through the web bridge) reaches the identical session. This is the verified tmux-mcp pattern.

## 7. MCP tool surface (`packages/mcp-server`)

Tool taxonomy adapted from DesktopCommander + iterm-mcp + pi-interactive-shell (see RESEARCH.md).

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `open_session` | `{ name?, env?: "local"\|"docker", cwd?, cmd?, cols?, rows? }` | `{ name, env }` | Creates tmux session in the chosen environment. `env` defaults to server config. |
| `list_sessions` | `{}` | `{ sessions: string[] }` | |
| `send_text` | `{ name, text, enter?: boolean }` | `{ ok }` | `send-keys ... Enter` when `enter` (default true). |
| `send_control` | `{ name, key }` | `{ ok }` | e.g. `C-c`, `C-z`, `C-d`. |
| `read_screen` | `{ name, scrollback?: number }` | `{ screen: string }` | `capture-pane -p`. |
| `read_new_output` | `{ name, sinceOffset?: number }` | `{ data, nextOffset }` | **Incremental**, offset-paginated to bound agent context (DesktopCommander pattern). |
| `resize` | `{ name, cols, rows }` | `{ ok }` | |
| `run_command` | `{ name, command, timeoutMs? }` | `{ output, exitCode? }` | Convenience one-shot: send + wait + capture. |
| `close_session` | `{ name }` | `{ ok }` | `destroySession`. |

- Transports: **stdio** (default, for `claude mcp add` / Cursor / Codex) and **streamable HTTP** (optional).
- Output safety: agents should prefer `read_new_output` over `read_screen` to avoid context blow-up.

## 8. Web bridge protocol (`packages/web`)

Ported from `alertforge`'s `chat-ws.ts`. JSON over WebSocket; the PTY runs `tmux attach`.

- **Client → server:** `{type:"init", name, cols, rows}` · `{type:"stdin", data}` ·
  `{type:"resize", cols, rows}` · `{type:"oauth_response", code}`
- **Server → client:** `{type:"ready", name}` · `{type:"stdout", data}` ·
  `{type:"oauth_url", url}` · `{type:"device_code", code}` · `{type:"exit", code}` · `{type:"error", message}`

`resize` is honored live via `node-pty.resize()` (improvement over `alertforge`, which couldn't resize
because it used `script(1)`).

### OAuth-URL bridging (port verbatim from alertforge)

`url-detector.ts` scans the PTY byte stream (after stripping ANSI/OSC) for OAuth hint phrases + an
`https://` URL and for device codes, emitting `oauth_url` / `device_code` messages. The web UI shows an
`OAuthCard`; the pasted code is forwarded to the child's stdin with careful `\r` handling. This is what
lets `claude auth login` / `gh auth login` / `sentry-cli login` complete from the browser.

## 9. Milestones & task checklists

### M0 — Repo scaffold *(this commit)*
- [x] Create repo, `docs/`, detailed plan, README, `.gitignore`.
- [ ] Add `pnpm-workspace.yaml`, root `package.json`, `turbo.json`, `biome.json`, base `tsconfig`.

### M1 — `core` + LocalEnvironment
- [ ] `TerminalEnvironment` interface + registry.
- [ ] `tmux.ts` helpers (send-keys/capture-pane/list/new/kill) over `child_process`.
- [ ] `LocalEnvironment` + `Session` (open/sendKeys/readScreen/readNewOutput/resize/close).
- [ ] `output-buffer.ts` offset reader; `lock.ts` advisory lock.
- [ ] Unit tests (mock `child_process`).

### M2 — DockerEnvironment (so both backends selectable from first working version — D4)
- [ ] Container-per-session lifecycle (`docker run -d` → `docker exec tmux …` → `docker rm -f`).
- [ ] `docker/` reference image (tmux + node + node-pty).
- [ ] Same test suite green against Docker backend.

### M3 — `mcp-server`
- [ ] Implement the tool surface (§7) over `core`; `env` arg selects Local/Docker.
- [ ] stdio transport; verify with MCP Inspector and `claude mcp add`.
- [ ] Integration test: `open_session` → `send_text "echo hi"` → `read_screen` asserts `hi`; `send_control C-c` interrupts a `sleep`.

### M4 — `web` bridge + xterm
- [ ] Port `XtermPanel.tsx`, `SessionTerminal.tsx` from alertforge.
- [ ] Hono+Bun WS bridge; PTY runs `tmux attach`; live resize via node-pty.
- [ ] Verify: human attaches; human typing **and** agent `send_text` both appear in the same pane (multiplexing proof).

### M5 — OAuth bridging
- [ ] Port `url-detector.ts` (+ tests) and `OAuthCard.tsx`.
- [ ] E2E: run `claude` in a session, drive via MCP, watch via web; trigger a login and assert the OAuth card surfaces.

### M6 — *(later)* cloud sandbox + Claude Code plugin
- [ ] Port a paperclip sandbox provider as `SandboxEnvironment`.
- [ ] `claude-code-plugin`: `.mcp.json` + skill + wake-on-terminal-event (pi-interactive-shell `triggerTurn` style).

## 10. Security

- **No blocklists for safety** — research-confirmed bypassable (symlinks, command substitution, absolute
  paths). Isolation is the backend's job.
- **Local backend = no isolation.** The UI and MCP `open_session` must surface this explicitly when
  `env: "local"` is selected (agent has full host access). Steer untrusted/multi-tenant use to Docker
  (or the later cloud-sandbox backend).
- **Contention:** optional advisory write-lock + read-only observer attach; document manual interrupt as
  the practical fallback (no tool does true arbitration).
- **Output volume:** agents read via `read_new_output` (offset) to bound context.
- **node-pty native build:** ship prebuilt in the Docker image; consider `zigpty` (no node-gyp) as a fallback.

## 11. Verification (end-to-end)

1. Unit: tmux helpers (mocked), `url-detector` (ported tests).
2. MCP: open/drive/read on **both** Local and Docker backends.
3. Web: human attach to same session; human + agent co-presence on one pane.
4. TUI + OAuth: run `claude`, drive via MCP, watch via web, login card surfaces.
5. Isolation: full suite green against Docker (`docker exec`).

## 12. Open questions (tracked)

- Repo/product **name** (`termbridge` is a placeholder).
- License.
- Exact `run_command` completion-detection heuristic (sentinel echo markers vs prompt detection — see
  tmux-mcp's echo-marker approach in RESEARCH.md).
- Whether to expose the advisory lock in v1 or defer.
