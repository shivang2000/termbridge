# Changelog

## Unreleased

Recognizer screen fixture corpus + drift guard (roadmap P2.1).

- **`packages/core/src/recognizers/__fixtures__/`** — positive-match screen captures per
  recognizer (incl. live Claude Code 2.1.183 permission captures).
- **`corpus.guard.test.ts`** — every `*.txt` fixture must still match its recognizer;
  fails loudly with path + kind on TUI drift. Declarative DSL deferred.

Live cloud `SandboxProvider` (E2B) — `env:"sandbox"` is now selectable end-to-end (roadmap P1.1).

- **New `@termbridge/sandbox-e2b`** package: `E2BSandboxProvider implements SandboxProvider`
  against the E2B SDK. One provider instance provisions/execs/destroys exactly one E2B
  sandbox (one sandbox == one session). `exec` maps the argv to the SDK's `commands.run`,
  shell-quotes each arg, and catches `CommandExitError` so non-zero exits return as data
  (never reject) — matching the `ExecFn` contract. tmux is installed on `ensure` (the
  default `base` template lacks it). Every SDK call is behind an injectable
  `sandboxFactory` so unit tests never touch the cloud.
- **`SessionManager` gains a `sandboxProvider?: SandboxProvider` option.** With it set,
  `env:"sandbox"` selects `SandboxEnvironment`; without it, `env:"sandbox"` throws a
  typed `SandboxProviderNotConfiguredError` (code `sandbox_not_configured`) BEFORE any
  sandbox spawns. Core stays dependency-free (D3) — only the new package imports `e2b`.
- **MCP `open_session` enum** is now `local | docker | sandbox`.
- Smoke: `scripts/smoke-sandbox-e2b.ts` (creds-gated; no-ops without `E2B_API_KEY`).
- **Non-goal:** multi-provider fan-out (E2B first; Daytona/Cloudflare are Phase 3 ports).

Streamable-HTTP MCP transport on the unified server (roadmap P1.2).

- **`@termbridge/server` now speaks MCP over HTTP** at `POST/GET/DELETE /mcp` (the spec's
  streamable-HTTP transport, via the SDK's `WebStandardStreamableHTTPServerTransport`). MCP clients
  (Hermes, Claude Code, Cursor) can connect **directly** to the unified server over HTTP and share its
  single `SessionManager` — so the browser watches *their* sessions natively, with no per-client stdio
  proxy, and remote MCP clients work across a network boundary. Reuses `createServer` from
  `@termbridge/mcp-server`, so the 13-tool surface is identical to stdio and `/api/tool` (no second tool
  definition).
- **Security unchanged:** `/mcp` is token-gated exactly like `/api/tool/:name` (bearer token, constant-time,
  header-or-`?token=`; loopback bind by default). The transport runs stateful (one server+transport pair per
  MCP client session, keyed by the `Mcp-Session-Id` header the SDK mints), supporting SSE streaming + the
  initialize→DELETE lifecycle.
- **stdio stays the zero-infra default** (non-goal: replacing it).
- Smoke: `bun scripts/smoke-mcp-http.ts` (real tmux) — an HTTP MCP client opens a session, drives it, and
  asserts the id is visible in the server's shared registry.
- **Fix:** `startServer` now returns the actual bound port (`server.port`) instead of the requested one,
  so `port: 0` (ephemeral) callers get the real port to reach the server (fixes `scripts/smoke-watch.ts`,
  which built its base URL from the returned port).

## v1.0.6 — 2026-06-24

Browser watch for Hermes-driven sessions.

- **`@termbridge/mcp-server` proxy mode:** with `TERMBRIDGE_SERVER_URL` set, the stdio MCP forwards every
  tool to a running unified server instead of its own SessionManager — so the web bridge and the agent
  share ONE session registry (the browser watches exactly what the agent drives). Unset = unchanged.
- **`@termbridge/server` is now published** (Bun; `bunx @termbridge/server`) with its web client bundled.
- **`setup.sh --watch`** (local mode): starts the host web server, registers the MCP to proxy to it, and
  prints a loopback `http://127.0.0.1:PORT/?token=…` watch URL. The engineer-loop skill posts the
  per-session URL; typing in the browser takes over (the in-session auto-approver pauses).

## v1.0.5 — 2026-06-23

In-session **auto-approver** — Claude never stalls on permission prompts.

- **`open_session({ autoApprove: true })`** (or `TERMBRIDGE_AUTO_APPROVE=1`): termbridge answers the
  session's routine `claude-permission` prompts (tool / trust / bypass) **in-session**, via the existing
  PtyObserver stream + recognizer `suggestedKeys` + the WriteLock-gated `sendControl`. So a driving agent
  (e.g. Hermes) that only polls occasionally never leaves the TUI stuck waiting for input.
- **Human-takeover-aware + login-safe by construction:** the approve key goes through the agent write gate,
  so a human keystroke pauses auto-approve; and login (`paste`/oauth → empty `suggestedKeys`) is never
  auto-answered. Off by default (opt-in), so existing behavior is unchanged.
- skill: the `engineer-loop` opens with `autoApprove: true` (paired with `--permission-mode plan` →
  plan-first, then hands-off execution).

## v1.0.4 — 2026-06-22

Ticket → PR delivery + a safe local (no-docker) run mode.

- **Delivery:** after acceptance passes, the loop has claude create a branch + commit, then open a PR —
  in-session via `gh` when a `GH_TOKEN` is forwarded, else the CLI/host opens it with your `gh` auth. PR is
  **human-gated**: confirm → ready-for-review, otherwise a **draft** (`--pr ask|ready|draft|none`).
  `runEngineerLoop` returns `{ delivery, prUrl, branch }`.
- **local mode:** `--env local` runs claude on the host's tmux `-L termbridge` socket (your **default tmux
  is never touched**) and uses the host's git/gh directly — no bind-mount, no token. `--env docker` stays
  for isolation.
- **core:** `SessionManager` forwards an allowlisted set of host env vars into a session (`forwardEnv` /
  `TERMBRIDGE_FORWARD_ENV`, incl. `GH_TOKEN`/`GH_HOST`) so in-session `gh` can push + PR.
- **tmux safety:** a guard test locks that every `LocalEnvironment` verb runs on `-L termbridge` (no
  default-socket escape); operator rule documented (never broad `pkill`/`kill-server`).
- **sandbox image:** now ships `gh` + a default git identity + `safe.directory '*'` for in-container PRs.

## v1.0.3 — 2026-06-21

CI/CD: tag-triggered release pipeline (`.github/workflows/release.yml`) publishes the npm packages +
both Docker images on every `vX.Y.Z` tag. First release cut through the pipeline. No code changes.

## v1.0.2 — 2026-06-21

Fixed the published npm manifest (1.0.1 shipped `exports` pointing at unshipped `src`; npm ignores
`publishConfig`). Publish now swaps top-level fields to `dist` for the tarball (`scripts/publish-npm.ts`)
and keeps `src` for dev. Added the per-session sandbox image `…/termbridge-sandbox`. 1.0.1 deprecated.

## v1.0.1 — 2026-06-21

Usability: log in to Claude **through** termbridge, and hand off a ticket in one command.

- **`GET /login`** (unified server, token-gated): opens a `claude` session and redirects to the watch UI,
  where the oauth-url card lets a human sign in. Login persists on the creds volume and is reused by every
  later session — the one-time "log in to Claude via termbridge" entry point.
- **`scripts/engineer.ts`** CLI: hand a coding task (e.g. a Jira ticket) to a running server's engineering
  loop over the HTTP tool API and stream progress.
- README: a "set it up on your laptop and hand off a ticket" walkthrough; Quickest section leads with
  `/login`. Published image `shivang2000/termbridge:1.0.1` (+ `:latest`).

## v1.0.0 — 2026-06-21

First stable release. An automated agent can pilot a real logged-in `claude` TUI to do coding work on a
**subscription** (not metered API) while a human watches and intervenes from a browser — proven
end-to-end, including through a third-party agent runtime (Hermes) and an autonomous engineering loop.

### Packages
- **@termbridge/core** — `SessionManager`, `Session`, `Environment` (`Local` / `Docker` / `Sandbox`
  interface), `PtyObserver` (bounded rolling buffer), `WriteLock` (human/agent arbitration), recognizers
  (`oauth-url`, `claude-permission`, `generic-yn`, `rate_limited`, **`claude-activity`**),
  `AuthProvisioner`. Race-safe concurrency cap; **docker-only env guard** (`allowedEnvs` /
  `TERMBRIDGE_ALLOWED_ENVS`) so an untrusted caller can never run on the host.
- **@termbridge/mcp-server** — 13-tool stdio MCP surface (adds **`read_progress`** for driving loops).
- **@termbridge/server** — unified Bun+Hono server: web WS bridge (watch + intervene, **live activity
  bar**) + HTTP tool API; bearer token + loopback bind + Origin allowlist.
- **@termbridge/orchestrator** — **`runEngineerLoop`**: backend-agnostic iterate-until-done engineering
  loop with live progress digests and test-gated completion (consumer-side; D8).
- **@termbridge/claude-code-plugin** — registers the termbridge MCP server in Claude Code.
- **skills/engineer-loop** — Hermes skill for the chat-driven loop.

### Verification
~900 unit tests (all mocked) + real smokes: tmux, Docker, MCP (stdio), web (Playwright), auth reuse,
concurrency cap, the engineering loop (claude fixed a failing test, host-verified), the docker-only guard
(over real stdio), and live Hermes drives (single, parallel fleet, concurrency). CI gates
typecheck/lint/test on push/PR.

### Known limitations / not in v1.0
- No concrete cloud `SandboxProvider` yet (E2B interface ships + is unit-tested; needs `E2B_API_KEY`).
  The `sandbox` kind is therefore not selectable over the default factory / MCP enum yet.
- The unified server is Bun-only (web bridge) and is distributed via source / Docker, not npm.
- Recognizer patterns track the Claude Code 2.1.x TUI and are version-fragile by design (isolated per
  module; re-tune on claude upgrades).
