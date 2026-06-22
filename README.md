# termbridge

> One terminal session that an **AI agent** (via MCP) and a **human** (via a browser) drive at the
> **same time** — so an agent can pilot **Claude Code** (and other interactive CLIs) like a human, on a
> **subscription, not metered API**.

termbridge turns an interactive TUI into something an automated agent can operate: type into it, read the
rendered screen, answer prompts, wait for it to go idle — while a human can watch the *same* session live
in a browser and take over at any moment. It is the substrate, not an orchestrator: it gives you session
primitives + auth + a small registry, and leaves "which agent does what" to whatever drives it.

## Why

Run coding work on a **Claude Code subscription** instead of the metered API. A session runs a logged-in
`claude` TUI; the agent drives it like a human, so usage bills against the plan. Log in once — every
session reuses the shared credentials. An orchestrator (your own, or e.g. Hermes / paperclip) can spawn
many sessions in parallel, each piloting its own `claude`, sharing one subscription.

> ⚠️ **Responsible use.** Automating a subscription CLI may conflict with the provider's terms of service
> and can put your account at risk. termbridge does **not** implement, and will not accept, any
> detection-evasion (humanized keystroke timing, account rotation, fingerprint spoofing). Cap concurrency,
> understand your plan's terms, and use this at your own risk. See [Responsible use](#responsible-use).

## The headline flow — chat a ticket, watch it ship

Drop a Jira ticket in your team channel. An agent picks it up, opens **Claude Code** with a real
engineering prompt, does the work on your **subscription**, auto-approves the routine edits, and streams
progress + the final review back to the **same channel**. You never leave chat.

```
  You ─ "@bot ship PROJ-123" ─▶  Hermes (or any agent)
                                   │  ① fetches the Jira ticket (the agent's Jira tool)
                                   │  ② opens Claude Code via termbridge + a sharp engineering prompt
                                   ▼
                            termbridge ── drives ──▶  claude (subscription) edits your repo
                                   │  ③ auto-approves reads/edits · runs your tests · iterates
                                   ▼
  You ◀── ~25s progress + final review ──  Hermes        (in your channel)
```

1. **Chat the ticket.** Mention the bot with a Jira reference: *"@bot ship PROJ-123."*
2. **Agent opens Claude Code with a badass prompt.** It fetches the ticket, then (via the termbridge
   **`engineer-loop`** skill) opens a `claude` session bound to your repo and hands it the goal +
   acceptance criteria.
3. **It works, auto-approving the routine stuff.** The loop presses through claude's edit/command prompts
   for you (reads + basic edits), runs your tests each round, and keeps going until the criteria pass.
4. **You review in-channel.** A short digest lands every ~25s, then a final summary + the diff — all in the
   same chat. Approve, ask for changes, or take over live in the browser anytime.

**Cheap + safe:** claude runs on your **subscription** (not metered API), and each chat-triggered session
is pinned to a **docker** container (the docker-only guard) so it can never touch the host.

**Shipped vs. wired:** the loop, auto-approval, ~25s digests, and the Hermes `engineer-loop` skill are
built (walkthrough below). *Fetching* the ticket from Jira is the agent's job — give Hermes a Jira
tool/MCP; termbridge pilots Claude, it doesn't pull from Jira. Run it today with no Jira tool by pasting
the ticket text into `scripts/engineer.ts`.

➜ **Set up Hermes for this flow** (install the MCP server + skill, log in, then chat a ticket):
**[docs/integration/hermes.md](docs/integration/hermes.md)**.

## Ways to use it

| You are… | You do… | Where |
|---|---|---|
| **In chat (the headline)** | Drop a ticket to an agent (Hermes) that has termbridge + the `engineer-loop` skill — it pilots Claude Code and streams the review back to your channel. | [headline flow](#the-headline-flow--chat-a-ticket-watch-it-ship) · [hermes.md](docs/integration/hermes.md) |
| **A dev on a laptop** | `docker run … shivang2000/termbridge` → log in at `/login` → `bun scripts/engineer.ts --goal "PROJ-123: …"`. Watch in the browser. | [Walkthrough](#walkthrough--set-it-up-on-your-laptop-and-hand-off-a-ticket) |
| **A Claude Code / MCP-agent user** | `claude mcp add termbridge …` — your agent gains 13 tools to pilot a *second* `claude` (parallel / sandboxed work). | [Usage A](#a-give-claude-code-or-any-mcp-client-the-tools--stdio) |
| **Building an orchestrator** | Use `@termbridge/orchestrator`'s `runEngineerLoop`, or the raw tools over a `ToolCall`, to build your own fleet. | [Usage D](#d-autonomous-engineering-loop-iterate-until-done--live-progress) |
| **Watching / reviewing** | Open the web UI on any session — live pane + activity feed; type to take over (`WriteLock`), review the diff. | [Usage B](#b-watch--intervene-from-a-browser--the-unified-server) |
| **Running it for a team** | Host the unified server (token + loopback + Origin allowlist); pin untrusted callers with `TERMBRIDGE_ALLOWED_ENVS=docker`; cap with `TERMBRIDGE_MAX_SESSIONS`. | [Security](#security) |

All of these pilot `claude` on your **subscription** (not metered API), one shared login.

## How it works

```
            ┌──────────── agent (MCP / HTTP) ────────────┐
            │   open_session · send_text · read_screen    │
            ▼                                             │
   ┌───────────────────┐    drives (send-keys/capture)    │   one shared
   │   SessionManager   │ ───────────────┐                │   tmux session
   │  (registry + cap)  │                ▼                │   (-L termbridge
   └───────────────────┘        ┌──────────────┐         │    socket)
            ▲                    │  tmux pane   │◀────────┘
            │  WriteLock         │  (claude …)  │
            │  arbitrates        └──────────────┘
            ▼                            ▲
   ┌───────────────────┐   WS bridge     │  capture-pane / pipe-pane
   │   human (browser)  │ ───────────────┘
   │   xterm.js + cards │   types in, watches live
   └───────────────────┘
```

- A **session** is a named `tmux` session inside a pluggable **environment** — local host, a Docker
  container per session, or a cloud sandbox — all behind one `Environment` interface.
- The agent never *attaches*; it shells out to tmux (`send-keys`, `capture-pane`, `pipe-pane`). A
  per-session `PtyObserver` tails `pipe-pane -O` so `wait_for_idle` / `wait_for_text` are reliable.
- The human's browser `xterm.js` connects over a WebSocket bridge that streams the same pane and types
  into it. A `WriteLock` arbitrates: when the human types, the agent's `send_text` is refused
  (`human_driving`) and auto-resumes after the human goes idle.
- A pluggable **recognizer** registry surfaces interactive prompts as structured events: `oauth-url`
  (login links), `claude-permission` (edit/permission prompts), `generic-yn`, `rate_limited`.

## Packages

| Package | Role |
|---|---|
| `packages/core` | Framework-agnostic library: `SessionManager`, `Session`, `Environment` (`Local`/`Docker`/`Sandbox`), `PtyObserver`, `WriteLock`, recognizers, `AuthProvisioner` |
| `packages/mcp-server` | MCP **stdio** server exposing the 13-tool surface over core (the canonical agent interface) |
| `packages/server` | Unified Bun+Hono server: web WS bridge (watch + intervene) **and** an HTTP tool API, over one shared `SessionManager` |
| `packages/orchestrator` | Reusable iterate-until-done **engineering loop** (`runEngineerLoop`) over the tool surface — agent-agnostic, consumer-side (D8: not in core) |
| `packages/claude-code-plugin` | Turnkey Claude Code plugin that registers the termbridge MCP server |

## Status — v1.0.4

**M1–M7 complete; stable.** An agent piloted a real logged-in `claude` TUI through the tool
surface to edit a bound git repo while a human watched live — subscription auth, no API key. Proven
end-to-end through a third-party runtime (Hermes): single drive, a real repo edit, a parallel fleet each
piloting its own `claude`, the concurrency cap, and the **autonomous engineering loop** (claude fixed a
failing test, host-verified). ~900 unit tests; real tmux / Docker / MCP / web (Playwright) / auth /
concurrency / engineer-loop / docker-only-guard / Hermes smokes all green; CI gates typecheck+lint+test.
Published image: `shivang2000/termbridge:1.0.1` (+ `:latest`). See [CHANGELOG](CHANGELOG.md).

Optional/not-yet-shipped: a concrete cloud sandbox provider (E2B — needs creds), and a streamable-HTTP MCP
transport on `packages/server` (today it speaks the custom `/api/tool` HTTP API; MCP clients use the stdio
server).

## Requirements

- **bun** ≥ 1.3 (package manager + workspaces + test runner)
- **tmux** ≥ 3.0
- **docker** (recommended for real sessions / fleet / auth; required on macOS — see note)
- **claude** CLI (for piloting Claude Code) — and a Claude subscription to log in once
- **node** ≥ 20 only if you build the web client bundle

> **macOS note.** macOS `claude` stores credentials in the Keychain, not a file, so the shared
> file-credentials volume only takes effect inside the **Linux container**. On macOS, run real `claude`
> sessions with `env: "docker"`.

## Install

```bash
git clone https://github.com/shivang2000/termbridge.git
cd termbridge
bun install
bun run test       # ~900 unit tests (all mocked — spawns no tmux/docker)
bun run typecheck  # tsc --noEmit across packages
bun run lint       # biome
```

Build the Docker reference image (bun + tmux + node + claude + git) for real sessions:

```bash
docker build -t termbridge:dev -f docker/Dockerfile .
```

> **Safety.** termbridge pins a dedicated `-L termbridge` tmux socket, so it can never see or kill your
> personal tmux sessions. Real-tmux/real-claude work is intended to run in Docker; unit tests touch
> neither.

## One-time subscription login

Credentials persist on a volume that every session reuses:

```bash
mkdir -p ~/.termbridge/home
docker run -it --rm -v ~/.termbridge/home:/creds -e HOME=/creds termbridge:dev claude
# choose "Claude account with subscription", open the printed URL, paste the code.
# A second container with the same -v reuses the login — no re-auth.
```

## Usage

### Quickest — run the server image (no clone, no build)

A self-contained image runs the unified server (web UI + HTTP tool API); sessions run `claude` inside the
container (`env:"local"`), so there's nothing to build:

```bash
mkdir -p ~/.termbridge/home          # persistent creds volume — your claude login is saved here
docker run --rm -p 127.0.0.1:8787:8787 \
  -v ~/.termbridge/home:/home/tb/.termbridge/home \
  -e TERMBRIDGE_TOKEN=choose-a-secret \
  shivang2000/termbridge
```

**Log in to Claude *through* termbridge (one-time).** Open in your browser:

```
http://127.0.0.1:8787/login?token=choose-a-secret
```

termbridge starts a `claude` session and the page shows a **"Sign in" card**: click the link, authorize
in your browser, then paste the code back into the card. The login is saved to the creds volume and
**reused by every future session** — you never log in again (and the same volume works for the stdio MCP
path below). Then watch/type at `…/?session=<id>&token=…`, or drive it from an agent via
`POST /api/tool/<name>?token=…`.

Build/publish the image yourself with `scripts/publish-image.sh <namespace> 1.0.0` (see
`docker/Dockerfile.server`).

### A) Give Claude Code (or any MCP client) the tools — stdio

```bash
claude mcp add termbridge -- npx -y @termbridge/mcp-server
```

Pass config through the server's environment:

```bash
claude mcp add termbridge \
  -e TERMBRIDGE_HOME=$HOME/.termbridge/home \
  -e TERMBRIDGE_ALLOWED_ENVS=docker \
  -- npx -y @termbridge/mcp-server
```

The agent then calls `open_session`, `send_text`, `wait_for_idle`, `read_screen`, … (full list below).

### B) Watch + intervene from a browser — the unified server

```bash
TERMBRIDGE_HOME=~/.termbridge/home bun packages/server/src/index.ts
# prints:  [termbridge] server on http://127.0.0.1:8787  (token: <TOKEN>)
```

- **Human UI:** `http://127.0.0.1:8787/?session=<id>&token=<TOKEN>` — live pane + event cards; type to
  take over (the agent pauses, then auto-resumes when you go idle).
- **Agent control:** `POST http://127.0.0.1:8787/api/tool/<name>?token=<TOKEN>` with JSON args.

The browser can only watch sessions owned by **this** server's `SessionManager` (i.e. opened through its
`/api/tool` API) — that shared registry is what lets `WriteLock` arbitrate agent-vs-human on one pane.

### C) Drive it from another agent runtime (Hermes example)

Register termbridge as an MCP server in the runtime, then prompt the agent to use the tools. A headless
one-shot that has the agent pilot `claude` in a bound repo:

```bash
hermes mcp test termbridge      # confirm connection + 13 tools
hermes -z "$(cat scripts/hermes-task-prompt.txt)"   # agent opens a docker claude session, does the task
```

See [`docs/integration/`](docs/integration/) for per-runtime guides (`claude`, `hermes`, `paperclip`,
`opencode`) and `scripts/hermes-*.txt` for ready-made delegation prompts (single drive, concurrency,
parallel fleet).

### D) Autonomous engineering loop (iterate-until-done + live progress)

`@termbridge/orchestrator`'s `runEngineerLoop` drives a session to deliver a goal against acceptance
criteria: it sends a structured prompt, streams a progress digest each ~25s tick (`onDigest`),
auto-approves edit prompts, gates "done" on the repo's tests (a `TB_LOOP_DONE: PASS` marker), and asks
for verification steps when none are given. Backend-agnostic — pass any `ToolCall` (stdio MCP, the
server's `/api/tool`, or in-process specs). Runnable example: `bun scripts/smoke-engineer-loop.ts`. For a
chat-driven version, see the Hermes `engineer-loop` skill in [`docs/integration/hermes.md`](docs/integration/hermes.md)
(pin `TERMBRIDGE_ALLOWED_ENVS=docker` for that untrusted path).

## Walkthrough — set it up on your laptop and hand off a ticket

The real workflow: get termbridge running, log in to Claude once, then delegate a ticket and watch it work.

**1 · Run the server + bind the repo you want worked on.** Mount your project so the in-container `claude`
can edit it:

```bash
mkdir -p ~/.termbridge/home
docker run --rm -p 127.0.0.1:8787:8787 \
  -v ~/.termbridge/home:/home/tb/.termbridge/home \
  -v /path/to/your/repo:/work \
  -e TERMBRIDGE_TOKEN=choose-a-secret \
  shivang2000/termbridge
```

**2 · Log in to Claude through the app (one-time).** Open
`http://127.0.0.1:8787/login?token=choose-a-secret`, click the **Sign in** card, authorize, paste the
code back. Saved to the creds volume; reused forever.

**3 · Hand off the ticket.** From a checkout of this repo — **zero-infra** (no server to start), it runs the
session in-process:

```bash
bun scripts/engineer.ts \
  --repo ~/dev/portal \
  --goal "PROJ-123: <ticket title> — <paste description>" \
  --accept "<acceptance criterion 1>" --accept "<criterion 2>" \
  --verify "npm test" \
  --env local --pr ask
```

(Add `--server http://127.0.0.1:8787 --token <t>` to drive a running server instead, so you can watch in the
browser.)

The loop sends claude the ticket, **auto-approves its edits**, runs `--verify` each round, and stops when
the acceptance criteria pass (or asks you for verification steps if you gave none). Then it commits a
branch and **opens a PR** — asking you first (`--pr ask`; `ready`/`draft`/`none` also work). `--env local`
runs on the host (your default tmux is untouched, uses your `gh`); `--env docker` isolates per session.
Watch it live at
`http://127.0.0.1:8787/?session=<id>&token=…` and review the diff in your repo when it finishes.

> No clone? The same loop is the Hermes **`engineer-loop`** skill — DM an agent the ticket and it drives
> termbridge for you. An agent with a Jira tool (e.g. Hermes + a Jira MCP) can fetch the ticket itself and
> hand it to the loop; termbridge stays the substrate (it doesn't pull from Jira). See
> [docs/integration/hermes.md](docs/integration/hermes.md).

## MCP tool surface (13 tools)

| Tool | Purpose |
|---|---|
| `open_session` | Open a session (`env`, `cwd`, `cmd`, `cols`, `rows`) → `{ id, name, env }` |
| `list_sessions` | List registered sessions + state |
| `send_text` | Type text as the agent (optional Enter); `{ ok:false, error:"human_driving" }` when a human holds the lock |
| `send_control` | Send a control/named key (`C-c`, `Up`, `Enter`, …) |
| `read_screen` | Capture the visible pane (optional scrollback / ANSI escapes) |
| `read_new_output` | Bytes appended to the rolling buffer since an offset |
| `read_progress` | One-shot poll for a driving loop → `{ delta, nextOffset, events, phase, awaitingInput, idle, lastActivityAt }` |
| `wait_for_idle` | Resolve once quiet for `quietMs`, or time out (never hangs) |
| `wait_for_text` | Poll the screen until a string/regex matches, or time out |
| `read_events` | Newly-recognized interactive events (oauth-url, permission, needs_login, …) |
| `wait_for_event` | Block until a recognizer event (optionally of given kinds) fires, or time out |
| `resize` | Resize the tmux window to `cols × rows` |
| `close_session` | Close + deregister a session, tearing down its tmux/container |

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `TERMBRIDGE_HOME` | unset | Shared credentials volume → becomes each session's `HOME` (subscription auth) |
| `TERMBRIDGE_PIPE_DIR` | a fresh temp dir | Where per-session `pipe-pane` files live (Docker bind-mounts it) |
| `TERMBRIDGE_TMUX_SOCKET` | `termbridge` | Dedicated tmux socket name (`-L`) — isolation from your tmux |
| `TERMBRIDGE_MAX_SESSIONS` | `4` | Hard cap on concurrent sessions; the `(N+1)`th `open` is rejected |
| `TERMBRIDGE_ALLOWED_ENVS` | unset (all) | Comma-separated env allowlist (`local`,`docker`,`sandbox`). See below |
| `TERMBRIDGE_TOKEN` | generated | Bearer token for the unified server's WS + tool API |
| `HOST` | `127.0.0.1` | Bind address for the unified server (loopback by default) |

### Locking an untrusted caller to containers

`open_session` defaults to `env: "local"` — i.e. the **host**. When the control plane is reachable by an
untrusted caller (a chat/Discord gateway agent, a shared bot), pin it to container isolation:

```bash
TERMBRIDGE_ALLOWED_ENVS=docker bun packages/mcp-server/src/stdio.ts
```

With a policy set, an **explicit** `env:"local"` is rejected with a typed `EnvNotAllowedError`
(`code: "env_not_allowed"`) *before* anything spawns, and an **omitted** env is coerced to the first
allowed env (here `docker`). So a session can never run on the host, even if the caller asks for it. The
same option exists programmatically: `new SessionManager({ allowedEnvs: ["docker"] })`.

## Security

The unified server is a session-piloting control plane (`send_text` ≈ remote command execution), so it:

- binds **loopback** by default (`HOST` to opt out),
- requires a **bearer token** (`TERMBRIDGE_TOKEN` or a generated one, constant-time checked) on the WS +
  tool API,
- enforces an **Origin allowlist** on the WS upgrade (CSWSH defence).

Run it behind your own auth/TLS before exposing it. For untrusted callers, also set
`TERMBRIDGE_ALLOWED_ENVS=docker` (above) and a low `TERMBRIDGE_MAX_SESSIONS`.

## Responsible use

- **Subscription terms / account risk.** Driving a subscription CLI with automation may violate the
  provider's terms and can lead to rate-limiting or account suspension. This is on you — understand your
  plan, cap concurrency, and don't run a large fleet against a single account expecting it to be allowed.
- **No evasion.** termbridge intentionally has no humanized-timing, account-rotation, or
  fingerprint-spoofing features, and contributions adding them will be declined. It pilots a CLI as-is.
- **Code execution.** Every session is a real shell/TUI. Treat the tool API and the web token as
  credentials, keep the server on loopback, and prefer `env:"docker"` for any non-trusted driver.

## Development

```bash
bun run test        # typecheck + lint + unit tests
bun run typecheck
bun run lint
bun run smoke:concurrency   # real-docker: N concurrent sessions, cap + isolation (needs docker + termbridge:dev)
```

Stack: Bun + Turbo + Biome + TypeScript (NodeNext, strict). Tests mock `child_process`, so the unit suite
spawns no tmux/docker; real-tmux/claude smokes run in Docker.

## Docs

- `docs/superpowers/specs/2026-06-18-termbridge-design.md` — the design spec (decisions D1–D8).
- `docs/superpowers/plans/` — per-milestone implementation plans (M1–M6).
- `docs/integration/` — per-runtime integration guides.

## License

MIT — see [LICENSE](LICENSE).
