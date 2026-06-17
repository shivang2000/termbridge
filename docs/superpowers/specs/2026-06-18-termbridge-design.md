# termbridge — Design Spec

Date: 2026-06-18
Status: **approved for planning** (brainstorming complete)
Supersedes for v1: the high-level `docs/PLAN.md` (kept as background; this spec is the authority).
Companions: [../../ARCHITECTURE.md](../../ARCHITECTURE.md), [../../RESEARCH.md](../../RESEARCH.md),
[../../DECISIONS.md](../../DECISIONS.md).

---

## 1. Purpose

termbridge is a substrate that lets an automated agent (Hermes, or any open-source/MCP-capable agent)
**pilot an interactive terminal CLI exactly like a human would** — type into the TUI, read the screen,
answer prompts, select options — while a human can simultaneously **watch and intervene** from a browser.

**The driving why:** run coding work on a **Claude Code *subscription*, not metered API pricing.** A
session runs a logged-in `claude` TUI; the agent drives it as a human, so usage bills against the plan.
The same mechanism works for any interactive CLI (`gh`, `vim`, REPLs).

**The vision it enables (built elsewhere):** orchestrators like paperclip/hermes spawn many agents, each
piloting its own Claude Code session to finish coding tasks in parallel — sharing one subscription.

## 2. Goals / Non-goals

### Goals
- Pilot a live TUI like a human: send keystrokes, read the rendered screen, respond to prompts.
- **MCP-first** agent interface; usable by any MCP-capable agent.
- Reliable TUI reading via **expect-style + idle synchronization** (no reading mid-redraw).
- A **pluggable recognizer** layer that detects common interactive states (OAuth login, Claude Code
  permission prompts, generic y/n) and surfaces them as structured events + suggested key responses.
- **Shared subscription auth:** log in once, reuse across all sessions (one subscription → N sessions).
- **Many concurrent isolated sessions** with a lightweight registry; each bindable to a repo/working dir.
- **Human watch + intervene** via a browser `xterm.js` terminal attached to the same session.
- Two user-selectable isolation backends: **Local** (dev) and **Docker-per-session** (fleet default).

### Non-goals (hard)
- **Not an orchestrator.** No task scheduling, no agent loops, no deciding *what* work to run — paperclip
  and hermes already do that well; termbridge will not reinvent it. termbridge only exposes the tool
  surface for spawning and piloting sessions.
- No structured Claude Code SDK/headless path in v1 (we pilot the TUI like a human — deliberate, deferred).
- No pi-interactive-shell-style "Monitor" trigger engine in v1 (idle + expect + recognizer-events suffice).
- No cloud-sandbox backend in v1 (designed-for via the same interface; ported later).
- No multi-user auth/RBAC, billing, or polished product UI in v1.

## 3. Decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | Human↔agent sharing | **tmux shared substrate** |
| D2 | Codebase | **brand-new standalone repo** |
| D3 | Agent interface | **MCP-first** (core lib → MCP → web; Claude Code plugin later) |
| D4 | Isolation | **Local + Docker-per-session, user-selectable**; cloud sandbox later |
| D5 | Agent control of Claude Code | **Pilot the TUI like a human** (send-keys/capture-pane); no SDK/headless v1 |
| D6 | TUI read synchronization | **Expect-style + idle**: `wait_for_text` + `wait_for_idle` |
| D7 | Prompt handling | **Pluggable recognizer registry**; ship oauth-url, claude-permission, generic-yn |
| D8 | Scope boundary | **Primitives + auth + session registry**; orchestration stays in paperclip/hermes |

## 4. Architecture overview

```
 orchestrator (paperclip / hermes)  ──MCP──►  termbridge MCP server
                                                   │  (session primitives + auth + registry)
                                                   ▼
                                            core: SessionManager
                                   ┌───────────────┼───────────────┐
                                   ▼               ▼               ▼
                              Session A        Session B        Session C
                          (tmux + observer + recognizers + workdir, in an Environment)
                                   │                                    ▲
              human ◄── xterm.js ◄── WS ◄── node-pty `tmux attach` ─────┘  (watch + intervene)

       Environment = Local (host tmux) | Docker (tmux in a per-session container)
       Auth: shared ~/.claude credentials volume mounted into every session
```

Each session is a named **tmux** session running inside a pluggable **Environment**. The agent never
attaches; it issues tmux CLI commands. The human attaches via the web bridge. Both see the same live
screen. tmux provides persistence + reconnect.

## 5. Components (each an isolated unit)

### 5.1 `core` (framework-agnostic library)

- **`SessionManager`** — *what:* opens/lists/closes sessions, enforces a concurrency cap. *interface:*
  `open(opts) → Session`, `get(id)`, `list()`, `close(id)`. *deps:* `Environment`, `Session`.
- **`Session`** — *what:* one piloted terminal. *interface:* `sendText(text, {enter})`,
  `sendControl(key)`, `readScreen({scrollback})`, `readNewOutput({sinceOffset})`,
  `waitForIdle(quietMs, timeoutMs)`, `waitForText(pattern, timeoutMs)`, `readEvents()`, `resize(c,r)`,
  `close()`. *deps:* `Environment`, `PtyObserver`, `RecognizerPipeline`, `WriteLock`.
- **`Environment`** (pluggable backend) — *interface:* `ensureSession`, `tmux(args)`, `attachPty(name,size)`,
  `destroySession`, `listSessions`. *impls:* `LocalEnvironment`, `DockerEnvironment` (`sandbox` later).
- **`PtyObserver`** — *what:* continuously taps the session's output via `tmux pipe-pane -O -t <s>`,
  maintaining a rolling buffer, a **last-activity clock** (powers `waitForIdle`), and feeding the
  recognizer pipeline. *interface:* `onData`, `lastActivityAt()`, `buffer(sinceOffset)`. *deps:* `Environment`.
- **`RecognizerPipeline` + `Recognizer`** — *what:* runs registered recognizers over screen+recent bytes,
  emits `RecognizedEvent { kind, data, suggestedKeys }`. *interface:* `register(r)`, `process(screen,bytes) → events`.
- **`WriteLock`** — *what:* advisory human/agent arbitration. *interface:* `tryAgentWrite()`,
  `noteHumanActivity()`, `state()` → `agent | human-active`. *behavior:* human keystroke flips to
  `human-active` for a TTL; agent writes rejected with `human_driving` + a `human_took_over` event;
  auto-returns to `agent` after human idle.
- **`AuthProvisioner`** — *what:* ensures the shared subscription credentials are available to a session
  (mount/point `HOME` at the credentials volume); detects logged-out state. *interface:*
  `ensureAuth(env, session)`, `isLoggedIn()`.

### 5.2 `mcp-server`
Maps MCP tools → `core.SessionManager`/`Session`. `@modelcontextprotocol/sdk`, stdio (default) + optional
streamable HTTP. Tool surface in §6.

### 5.3 `web`
- **bridge** (Hono + Bun `createBunWebSocket`) — WS endpoint per session; spawns a `node-pty` running
  `tmux attach -t <s>`; relays JSON (`init`/`stdin`/`resize`/`stdout`/`exit`/`event`); feeds human
  keystrokes into `WriteLock.noteHumanActivity()`. Ported from alertforge `chat-ws.ts` + `pty-runner.ts`
  (upgraded to `node-pty` for live resize).
- **client** — `XtermPanel.tsx`, `SessionTerminal.tsx`, `EventCard.tsx` (renders recognizer events, e.g.
  OAuth login card). Ported from alertforge `xterm-panel.tsx` / `chat-terminal.tsx` / `oauth-card.tsx`.

### 5.4 recognizers (shipped)
- **`oauth-url`** — port `alertforge/.../url-detector.ts` verbatim (+ tests): OAuth URL + device-code →
  event. Enables one-time subscription login from the web.
- **`claude-permission`** — detect Claude Code's tool-permission prompt (suggest `y`/`n`/`a`), the
  bypass-permissions accept, and the paste-code prompt.
- **`generic-yn`** — detect a generic `[y/N]`-style prompt.

## 6. MCP tool surface

| Tool | Args | Returns |
|---|---|---|
| `open_session` | `{ name?, env?: "local"\|"docker", cwd?, repo?, branch?, cmd?, cols?, rows? }` | `{ id, name, env }` |
| `list_sessions` | `{}` | `{ sessions: [{id,name,env,state}] }` |
| `send_text` | `{ id, text, enter?=true }` | `{ ok }` or `{ error:"human_driving" }` |
| `send_control` | `{ id, key }` (e.g. `C-c`, `Escape`, `Up`, `Enter`) | `{ ok }` |
| `read_screen` | `{ id, scrollback? }` | `{ screen }` |
| `read_new_output` | `{ id, sinceOffset? }` | `{ data, nextOffset }` |
| `wait_for_idle` | `{ id, quietMs=400, timeoutMs=30000 }` | `{ idle, waitedMs }` |
| `wait_for_text` | `{ id, pattern, timeoutMs=30000 }` | `{ matched, screen }` |
| `read_events` | `{ id, sinceOffset? }` | `{ events:[{kind,data,suggestedKeys}], nextOffset }` |
| `resize` | `{ id, cols, rows }` | `{ ok }` |
| `close_session` | `{ id }` | `{ ok }` |

Canonical piloting loop: `send_text` → `wait_for_idle`/`wait_for_text` → `read_events` (handle prompts via
`send_text`/`send_control`) → `read_screen`.

## 7. Auth model (subscription, not API)

- A persistent **credentials volume** holds `~/.claude/.credentials.json` (and `.config/gh`, etc.).
- Every session's `HOME` points at it (`AuthProvisioner`) — so all sessions share one logged-in plan.
- **One-time login:** open a session, run `claude auth login`; the `oauth-url` recognizer surfaces the
  URL to the human web UI; the pasted code is forwarded to stdin (alertforge's proven flow).
- **Concurrency cap** per subscription in `SessionManager` to respect plan limits.
- **Risk (documented):** automated fleet use of a subscription CLI may hit plan rate limits and should be
  checked against Claude's usage terms. Mitigation: cap concurrency, surface rate-limit recognizer events,
  fail sessions gracefully.

## 8. Data flow (piloting + intervene)

- **Agent acts:** MCP `send_text` → `WriteLock.tryAgentWrite()` → `Environment.tmux(["send-keys",…])`.
- **Agent reads:** `wait_for_idle` (PtyObserver activity clock) → `read_events`/`read_screen`.
- **Human watches/types:** xterm onData → WS `stdin` → node-pty (`tmux attach`) → shell; shell stdout →
  node-pty → WS `stdout` → xterm. Human keystroke → `WriteLock.noteHumanActivity()` → agent writes paused.
- **Recognizer events** fan out to both the agent (`read_events`) and the human (`EventCard`).

## 9. Error handling

- `send_text` while `human-active` → `{error:"human_driving"}` + emit `human_took_over` event (not a throw).
- `wait_for_*` timeout → `{matched:false}`/`{idle:false}` with the last screen, never hang.
- Environment/tmux failure → session marked `failed`, surfaced in `list_sessions`, `close_session` cleans up
  (for Docker, `docker rm -f`).
- Logged-out detection → emit a `needs_login` event; piloting tools return a clear error.

## 10. Testing / verification

1. **Unit:** tmux helpers (mock child_process); ported `url-detector` tests; `WriteLock` state machine;
   `wait_for_idle` against a scripted output stream.
2. **MCP integration:** `open_session` → `send_text "echo hi"` → `wait_for_idle` → `read_screen` asserts
   `hi`; `send_control C-c` interrupts a `sleep`. Run on **both** Local and Docker.
3. **TUI piloting (headline):** drive a real `claude` session via MCP — `wait_for_text` on the permission
   prompt, `read_events` yields a `claude-permission` event, `send_text "y"` proceeds.
4. **Auth:** one-time `claude auth login` via web; second session reuses creds without re-login.
5. **Web + intervene:** human attaches; agent + human both reflected in one pane; human typing pauses the
   agent (`human_took_over`), auto-resumes on idle.
6. **Concurrency:** open N sessions to the cap; N+1 rejected cleanly.

## 11. Milestones

1. **M1 core + Local:** `Environment`/`Session`/`SessionManager`/`PtyObserver`/`WriteLock` + tmux helpers + unit tests.
2. **M2 Docker:** `DockerEnvironment` + reference image (tmux+node+node-pty); same suite green.
3. **M3 MCP server:** full tool surface (§6); verify with MCP Inspector + `claude mcp add`.
4. **M4 recognizers + auth:** pipeline + `oauth-url`/`claude-permission`/`generic-yn`; `AuthProvisioner` + credentials volume; one-time login flow.
5. **M5 web:** xterm + WS bridge (port alertforge) + `EventCard`; human watch + intervene; multiplexing proof.
6. **M6 (later):** cloud-sandbox `Environment`; Claude Code plugin wrapper + wake-on-event.

## 12. Open items
- Product/repo **name** (`termbridge` placeholder).
- License.
- `claude-permission` recognizer must track Claude Code UI across versions (isolated in its plugin, by design).
- Exact `wait_for_idle` default `quietMs` (start 400ms; tune against Claude Code's redraw cadence).
