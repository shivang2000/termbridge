# M6 — cloud sandbox + Claude Code plugin + wake-on-event (milestone plan)

Authority: spec §11 (M6), D4, D8. Master plan: M1–M6. Built via dynamic Workflow (TDD + adversary).

## Goal
Round out the substrate: a cloud-sandbox `Environment` behind the same interface, a turnkey Claude Code
plugin, and a wake-on-event primitive — without becoming an orchestrator (D8).

## Units (all shipped, mock/unit-tested)

- **`core/src/env/sandbox.ts` — `SandboxEnvironment`** (3rd backend, D4). Runs tmux INSIDE a cloud sandbox
  via a pluggable `SandboxProvider { ensure, exec, destroy }`, pinned to the `-L termbridge` socket. Core
  imports no cloud SDK — any provider (E2B/Daytona/Cloudflare) implements the interface — so core stays
  zero-runtime-dep and the unit is tested with a recording mock provider. `EnvKind` extended with
  `"sandbox"`. **Live cloud is deferred** (needs a provider + creds, e.g. `E2B_API_KEY`); documented, not a
  blocker. A concrete E2B provider is a thin follow-up package implementing `SandboxProvider`.

- **`mcp-server` — `wait_for_event` tool** (12th §6 tool, wake-on-event). `wait_for_event(id, kinds?,
  timeoutMs)` long-polls `session.readEvents` until a recognizer event (optionally of given kinds) appears
  or it times out — so an orchestrator can block until a login/permission/prompt event fires without
  busy-looping. `kinds:[]` matches nothing; omitted matches all. termbridge stays NOT-an-orchestrator.

- **`packages/claude-code-plugin`** — a Claude Code plugin (`.claude-plugin/plugin.json` + `.mcp.json`)
  that registers the termbridge MCP stdio server, so any `claude` instance gains the §6 tools. Credentials
  come from the shared HOME volume, never the plugin. Manifest validated by tests.

## Verification
- Unit gate green (`turbo run test lint typecheck`): `SandboxEnvironment` over a mock provider (argv,
  lifecycle, error paths); `wait_for_event` timing/kinds/cursor; plugin manifest shape.
- Live cloud smoke: deferred to provider creds.

## Notes
- `attachPty` is declared on `Environment` but unused in v1 (the web bridge uses tmux primitives, not a
  PTY — node-pty fails under Bun).
