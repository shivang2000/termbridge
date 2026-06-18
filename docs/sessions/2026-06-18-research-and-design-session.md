# Session Log — 2026-06-18 · Research & Design

A record of the session that produced termbridge's research, decisions, and v1 design spec.

---

## 1. Goal (original request)

A `/deep-research` task: *find a way to build a plugin / skill / MCP / library that lets terminals be
run and interacted with via code — so agents (Hermes, Claude Code, other tools) can drive a terminal.*
Inspired by two existing repos: `sentry-fixer-bot` (which already talks to a terminal from a website) and
`paperclip`. The core ask: "in sentry-fixer-bot we interact with a terminal from a website — how do we
generalize that so agents can do it?"

## 2. Method

- **Deep-research workflow** — 110 sub-agents, 6 angles, 27 sources fetched → 133 claims → 25 verified
  with 3-vote adversarial verification → **23 confirmed, 2 refuted**. (Full output → `docs/RESEARCH.md`.)
- **2 Explore agents** over `sentry-fixer-bot` and `paperclip`, then direct source reading.
- **`superpowers:brainstorming`** once the real goal surfaced, to refine the design (decisions D5–D8).

## 3. Research findings (summary)

- Canonical stack = **xterm.js (browser) ↔ node-pty (PTY) ↔ WebSocket**. ttyd/GoTTY are turnkey versions.
- **tmux is the verified shared substrate** for one session shared by a human + an agent: the agent issues
  tmux CLI (`send-keys`/`capture-pane`) and never attaches, so a human `tmux attach` hits the same session.
- MCP terminal-tool taxonomy to copy: DesktopCommander (offset-paginated output), iterm-mcp (3 tools),
  pi-interactive-shell (execution-mode taxonomy + human takeover).
- **Security:** in-process command blocklists are bypassable → real safety needs container/VM isolation.
- Full detail + citations: `docs/RESEARCH.md`.

## 4. Codebase findings

### sentry-fixer-bot (`alertforge`) — the human↔web-terminal half
- Stack: Bun + Hono + tRPC monorepo; web app on React 19 + Vite + `@xterm/xterm` v6.
- Flow: `apps/web/src/components/xterm-panel.tsx` (xterm) → `chat-terminal.tsx` (WS client) →
  `apps/server/src/routes/chat-ws.ts` (Hono+Bun `createBunWebSocket`, JSON protocol) →
  `apps/server/src/chat/pty-runner.ts`.
- **Key trick:** no `node-pty` — it allocates a PTY via **`script(1)`** (`script -q -c "stty cols X rows Y;
  exec <cmd>" /dev/null`) so `claude`/`gh` pass `isatty()`. Downside: no live resize (no SIGWINCH proxy).
- **Gem:** `apps/server/src/chat/url-detector.ts` scrapes OAuth URLs + device codes out of the PTY stream
  to drive `claude auth login` / `gh auth login` / `sentry-cli` logins from the browser. HOME pinned to a
  state volume so creds persist across container restarts.

### paperclip — the agent↔execution-environment half
- An agent-company control plane. **Adapter registry** (`packages/adapters/*`: `acpx_local` [ACP →
  Claude/Codex/custom], `cursor-local`, `opencode-local`) behind a mutable `registerServerAdapter`.
- **Sandbox-provider plugins** (`packages/plugins/sandbox-providers/{e2b,daytona,cloudflare}`) — the
  isolation layer external research lacked.
- **Workspace-runtime** model (`packages/shared/src/types/workspace-runtime.ts`): transports
  `local|ssh|sandbox|plugin`, strategies `project_primary|git_worktree|adapter_managed|cloud_sandbox`,
  lease acquire/resume. Plus its own MCP server (`packages/mcp-server`).

## 5. The real goal (emerged mid-session)

The user clarified the true intent, which reshaped scope:
1. **Drive the TUI exactly like a human** — type, read, answer/select. No SDK/headless.
2. **Why:** use a **Claude Code subscription, not metered API** — pilot a logged-in `claude` TUI so usage
   bills against the plan.
3. **Vision:** a Hermes/paperclip-style tool **spawns many agents, each piloting its own Claude Code
   session to do coding work** in parallel, sharing one subscription.
4. **Hard non-goal:** termbridge is **not an orchestrator** — paperclip/hermes keep that.

## 6. Decision log (D1–D8)

| # | Question | Choice | Rationale |
|---|---|---|---|
| D1 | Human↔agent sharing | tmux shared substrate | verified pattern; free persistence + co-presence |
| D2 | Codebase | brand-new standalone repo | reusable by both products + external agents |
| D3 | First agent interface | core lib + MCP server first | MCP reaches every agent; plugin is a thin wrapper |
| D4 | Isolation | Local + Docker, user-selectable | dev speed + safe self-hosted; cloud sandbox later |
| D5 | Control of Claude Code | pilot the TUI like a human (no SDK) | needed for subscription billing; universal across CLIs |
| D6 | Read synchronization | expect-style + idle (`wait_for_text`/`wait_for_idle`) | don't read mid-redraw; robust TUI reads |
| D7 | Prompt handling | pluggable recognizer registry | detect prompts/login; isolate Claude Code UI churn |
| D8 | Scope | primitives + auth + session registry only | not an orchestrator — don't reinvent paperclip/hermes |

## 7. Design

Full v1 spec: **`docs/superpowers/specs/2026-06-18-termbridge-design.md`**. In brief:
- Per-session = tmux session + PTY observer (`tmux pipe-pane -O`) + recognizers + working dir, inside a
  pluggable `Environment` (Local | Docker; sandbox later).
- Agent drives via MCP tools (`send_text`/`send_control`/`wait_for_idle`/`wait_for_text`/`read_screen`/
  `read_new_output`/`read_events`/`open_session`/`list_sessions`/`close_session`).
- Human watches/intervenes via xterm ↔ WS ↔ `node-pty` running `tmux attach`; advisory write-lock yields
  control to the human on keypress.
- Shared subscription auth via a persisted `~/.claude` volume + one-time OAuth login (recognizer).

## 8. Artifacts produced

- Repo created: `github.com/shivang2000/termbridge` (private).
- Commits: `cc07bb9` (scaffold), `aa7f247` (motivation), `9f85126` (design spec), plus this session log.
- Files: `README.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `docs/RESEARCH.md`, `docs/DECISIONS.md`,
  `docs/superpowers/specs/2026-06-18-termbridge-design.md`, this log.
- Background plan (outside repo): `~/.claude/plans/zesty-honking-snail.md`.

## 9. Status & next step

- Design spec written and committed; **awaiting user review**.
- **Next:** run `superpowers:writing-plans` to produce the implementation plan (M1: `core` + tmux helpers +
  `LocalEnvironment`). No code until that plan is approved.
