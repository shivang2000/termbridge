# M9 — Browser watch for Hermes-driven sessions (design)

## Context

Today a human can't watch the session Hermes is driving: Hermes runs `npx -y @termbridge/mcp-server` over
**stdio**, which builds its **own** in-process `SessionManager` — separate from the unified web server
(`packages/server`) that renders the browser view. So the only ways to follow a run are pinging "status" or
`tmux -L termbridge attach`. Goal: a **localhost browser URL** showing the live pane + activity bar for the
exact sessions Hermes drives, with **watch + intervene** (typing takes over). Proven route (designed +
adversarially reviewed in the 4-direction workflow): **make the stdio MCP a thin proxy to a unified server**
so both share one session registry. User decisions: setup manages the server (turnkey `--watch`); the server
runs on the host via **Bun** (`bunx @termbridge/server`).

## Architecture — the proxy (route b)

`@termbridge/mcp-server` gains a **proxy mode**. When `TERMBRIDGE_SERVER_URL` (+ `TERMBRIDGE_TOKEN`) is set,
its tools forward every call to the unified server's `POST /api/tool/:name?token=…` instead of constructing a
`SessionManager`. The server owns the one registry; the browser (served by the same server) watches it.
- **Reuse, don't reinvent:** the HTTP tool client already exists at `scripts/engineer.ts:73-82` (POST,
  unwrap `{ok,data,error}`); lift it into a new `packages/mcp-server/src/remote.ts`. Reuse `createToolSpecs`
  for the 13 tool name/description/inputSchema — only swap each `spec.handler` to call the remote caller. (Do
  NOT add a `TOOL_DEFS` refactor; there is no drift risk when schemas come from the one `createToolSpecs`.)
- **No SessionManager in proxy mode:** the MCP process must not start tmux/pipeDir/observer — a pure forwarder
  in Hermes' process. Gate on `TERMBRIDGE_SERVER_URL` in `bin.ts`/`stdio.ts`; unset = today's in-process
  behavior (preserves the zero-infra default + all tests).
- **Envelope + error parity:** key only on the **outer** `{ok}` — `send_text` returns
  `{ok:false,error:"human_driving"}` as inner DATA (`tools.ts:80-88`); the server wraps it `{ok:true,data:…}`.
  Throw on outer `!ok` so `formatErrorResponse` yields an identical MCP error (matches `engineer.ts:79-80`).

## Config moves to the server

`startServer()` (`packages/server/src/index.ts`) already builds `new SessionManager()` with zero opts → it
reads ALL `TERMBRIDGE_*` env (allowedEnvs, HOME, forwardEnv incl. GH_TOKEN, **autoApprove**) plus
`PORT`/`HOST`/`TERMBRIDGE_TOKEN`. So in watch mode the session config setup currently passes to the **MCP** is
instead passed to the **server process**; the Hermes MCP gets only `TERMBRIDGE_SERVER_URL` +
`TERMBRIDGE_TOKEN`. No new server config code — just env.

## Distribution — publish `@termbridge/server` (the main effort/risk)

The server is currently `private: true` and Bun-only. Make it `bunx`-able:
- `packages/server/package.json`: `private:false`; `bin` already `termbridge-server` → `src/index.ts` (Bun
  runs TS directly via the `#!/usr/bin/env bun` shebang — no dist for server code). Add a `files` whitelist
  shipping `src/` **and the built client assets**.
- **Client build:** the web UI (vite; `packages/server/client`, served via `clientDir`) must be built and
  included in the tarball, and `startServer`'s default `clientDir` must resolve to the shipped location when
  run from `node_modules`. Add a build step wired into `scripts/publish-npm.ts`.
- Extend `scripts/publish-npm.ts` to also publish `@termbridge/server` (build client first; ship the client
  dist). Include the server in `release.yml`'s publish set.

## `setup.sh --watch`

New flag (local mode):
- Start the server on the host, backgrounded, with the session env: `TERMBRIDGE_ALLOWED_ENVS=local
  TERMBRIDGE_TMUX_SOCKET=termbridge TERMBRIDGE_AUTO_APPROVE=1 [ANTHROPIC_API_KEY] [GH_TOKEN]
  TERMBRIDGE_FORWARD_ENV=ANTHROPIC_API_KEY TERMBRIDGE_TOKEN=<rand> PORT=<free> HOST=127.0.0.1
  bunx @termbridge/server &` — record PID + port + token in `~/.termbridge/watch.json`; on re-run stop the old
  PID + restart. `--watch` makes `bun` a hard prereq.
- Register the Hermes MCP with **only** `TERMBRIDGE_SERVER_URL=http://127.0.0.1:<port>` + `TERMBRIDGE_TOKEN`.
- Print the base watch URL `http://127.0.0.1:<port>/?token=<token>`.
Without `--watch`, setup is exactly as today (in-process MCP, no server).

## Skill

After `open_session`, the engineer-loop posts the **per-session** watch URL
`<TERMBRIDGE_SERVER_URL>/?session=<id>&token=<token>` to the channel ("watch live / take over here") when
`TERMBRIDGE_SERVER_URL` is set (mirrors `engineer.ts:168-170`). Open it to watch the live pane + activity bar
instead of pinging "status"; typing flips the WriteLock → agent writes refused → the in-session auto-approver
pauses → human drives. Watch AND intervene, for free.

## Security

Existing model: loopback bind (`127.0.0.1`) + bearer token + Origin allowlist (`server.ts`/`guard.ts`). One
token shared across server, the MCP proxy, and the URL. Never logged (masked like GH_TOKEN/api-key).

## Critical files
- NEW `packages/mcp-server/src/remote.ts`; edit `packages/mcp-server/src/{server.ts,bin.ts,stdio.ts,index.ts}`.
- `packages/server/package.json`, `scripts/publish-npm.ts`, `.github/workflows/release.yml`, version → **1.0.6**,
  `CHANGELOG.md`.
- `scripts/setup.sh` (`--watch`), `skills/engineer-loop/SKILL.md` (post the URL), `docs/integration/hermes.md`
  + `docs/demo/hermes-demo.md` + `README.md` (the `--watch` path).

## Verification
- **Unit** (mcp-server): proxy caller forwards to a stub server, unwraps `{ok,data}`, throws on outer `!ok`,
  keeps inner `human_driving` as data; proxy mode does NOT construct a SessionManager.
- **e2e smoke**: start the server, point a stdio mcp-server at it via `TERMBRIDGE_SERVER_URL`, drive
  `open_session`/`send_text` over stdio, assert the SAME id in the server's `list_sessions` and a `/ws/:id`
  bridge attaches + paints. (Highest-value test — proves the shared registry.)
- **Publish dry-run:** `npm pack` the server, install clean, `bunx @termbridge/server` boots + serves `/`.
- **Manual:** `setup.sh --mode local --watch --api-key … --gh-token …` → `hermes gateway restart` → DM a
  ticket → click the posted URL → watch + take over (auto-approver pauses).
- `bun run test`/typecheck/lint green; ship as **1.0.6**.

## Out of scope
- Streamable-HTTP MCP transport on the server (route a) — defer until a client speaks HTTP-MCP.
- Pushing to Hermes (impossible over MCP). Cloud/fleet (separate milestone).
