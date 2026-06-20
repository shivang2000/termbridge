# termbridge

> One terminal session that an **AI agent** (via MCP) and a **human** (via a browser) drive at the
> **same time** — so an agent can pilot **Claude Code** (and other interactive CLIs) like a human, on a
> **subscription, not metered API**.

A session is a named **tmux** session inside a pluggable **environment** (local host, a Docker container,
or a cloud sandbox). The agent drives it through MCP tools that shell out to tmux (`send-keys`,
`capture-pane`, `pipe-pane`) and never holds the attachment. The human opens a browser `xterm.js` whose
WebSocket bridge streams the same pane and types into it. Because both target one tmux session, they are
co-present and live; a `WriteLock` arbitrates so the human can take over and the agent auto-resumes.

The point: run coding work on a **Claude Code subscription** — log in once, and every session reuses the
shared credentials, so usage bills against the plan instead of the API.

## Status — v0.1.0

Milestones **M1–M6 complete**, plus the **final acceptance**: an agent piloted a real logged-in `claude`
TUI through the MCP tool surface to edit a file in a bound git repo (`Hello, World!` → `Hello, termbridge!`)
while a human watched live — on subscription auth, no API key. ~500 unit tests; real-tmux / Docker / MCP /
web / auth / acceptance smokes all green.

## Packages

| Package | Role |
|---|---|
| `packages/core` | Framework-agnostic library: `SessionManager`, `Session`, `Environment` (`Local`/`Docker`/`Sandbox`), `PtyObserver`, `WriteLock`, recognizers (`oauth-url`, `claude-permission`, `generic-yn`), `AuthProvisioner` |
| `packages/mcp-server` | MCP **stdio** server exposing the §6 tool surface (12 tools) over core |
| `packages/server` | Unified Bun+Hono server: web WS bridge (watch + intervene) + HTTP tool API, one shared `SessionManager` |
| `packages/claude-code-plugin` | Turnkey Claude Code plugin that registers the termbridge MCP server |

## Quickstart

Prereqs: **bun ≥1.3**, **tmux ≥3.0**, **docker** (for the fleet/auth), **claude** CLI.

```bash
bun install
bun run test            # turbo: typecheck + lint + unit tests (all mocked; spawns nothing)
```

**Run real sessions in Docker** (host tmux is never touched; termbridge pins a dedicated `-L termbridge`
socket and binds loopback):

```bash
docker build -t termbridge:dev -f docker/Dockerfile .   # bun + tmux + node + claude + git
```

**One-time subscription login** (creds persist on a volume, shared by every session):

```bash
mkdir -p ~/.termbridge/home
docker run -it --rm -v ~/.termbridge/home:/creds -e HOME=/creds termbridge:dev claude
# choose "Claude account with subscription", open the printed URL, paste the code.
# A second container with the same -v reuses the login — no re-auth.
```

**Give an agent the tools** (MCP, stdio):

```bash
claude mcp add termbridge -- bun /ABS/PATH/termbridge/packages/mcp-server/src/stdio.ts
```

**Run the unified server** (agent HTTP tool API + human web UI, one shared session registry):

```bash
TERMBRIDGE_HOME=~/.termbridge/home bun packages/server/src/index.ts
# prints:  [termbridge] server on http://127.0.0.1:8787  (token: <TOKEN>)
# human UI:  http://127.0.0.1:8787/?session=<id>&token=<TOKEN>
# agent:     POST http://127.0.0.1:8787/api/tool/<name>?token=<TOKEN>  {json args}
```

## Security

The server is a session-piloting control plane (`send_text` ≈ remote command execution), so it: binds
**loopback** by default (`HOST` to opt out), requires a **bearer token** (`TERMBRIDGE_TOKEN` or a generated
one, constant-time checked) on the WS + tool API, and enforces an **Origin allowlist** on the WS upgrade
(CSWSH defence). Run it behind your own auth/TLS before exposing it.

## Docs

- `docs/superpowers/specs/2026-06-18-termbridge-design.md` — the design spec (decisions D1–D8).
- `docs/superpowers/plans/` — per-milestone implementation plans (M1–M6).

## License

MIT.
