# M4 — recognizers + auth (milestone plan)

Authority: spec §5.1 (AuthProvisioner), §5.4 (recognizers), §7 (auth model), §9. Master plan: M1–M6.

## Goal

1. Two more recognizers in the pipeline: `claude-permission` and `generic-yn`.
2. `AuthProvisioner` + a **persisted credentials volume** so one `claude` subscription login is reused by
   every session (subscription, not API — the whole point). One-time `claude auth login` surfaced through
   the existing `oauth-url` recognizer.

Smoke: log in once; a second session reuses creds **without re-login**.

## Recognizers (core/src/recognizers/)

- `generic-yn.ts` — `Recognizer` kind `"generic-yn"`. Matches a trailing `[y/N]` / `(y/n)` / `[Y/n]`
  prompt; `data:{ prompt, default }`, `suggestedKeys:["y"]` (or the capitalised default).
- `claude-permission.ts` — `Recognizer` kind `"claude-permission"`. Detects Claude Code's tool-permission
  prompt (numbered "❯ 1. Yes / 2. Yes, and don't ask again / 3. No"), the **Bypass Permissions** accept,
  and the login **paste-code** prompt. `data:{ kind:"tool"|"bypass"|"paste", question, options? }`,
  `suggestedKeys` heuristic (`["1"]` yes / accept; `[]` for paste). **Version-fragile by design** (spec
  §12) — patterns isolated here, unit-tested on fixtures, then tuned against the live TUI during the
  login smoke.
- Register both in `SessionManager` alongside `oauth-url`.

## Auth (core/src/auth/provisioner.ts)

`AuthProvisioner`:
- constructor `{ homeDir, fs? }` — `homeDir` = the persistent credentials volume (`TERMBRIDGE_HOME`,
  default `~/.termbridge/home`). A **dedicated** home, not the user's real `~`.
- `ensureReady()` — `mkdir -p homeDir/.claude`.
- `isLoggedIn()` — `homeDir/.claude/.credentials.json` exists and is non-empty.
- `homeEnv()` → `{ HOME: homeDir }` to inject into every session's env.

`SessionManager`: build an `AuthProvisioner` from `TERMBRIDGE_HOME` (when set), call `ensureReady()`, and
merge `homeEnv()` into each session's `env` on `open()`. Emit a `needs_login` event when piloting starts
and `isLoggedIn()` is false (via the pipeline / readEvents).

## HOME delivery (the mechanism that makes shared auth work)

`HOME` must reach the session's processes:
- **Local:** `tmux new-session -e HOME=<dir>` — tmux per-session env (reliable; `update-environment`
  does NOT carry HOME, so the current `opts.env`-on-the-client path is insufficient). Change `newSession`
  to emit `-e KEY=VALUE` for each env entry; update the two M1 tests that assert the old behaviour.
- **Docker:** already `docker run -e HOME=<dir>`; additionally **bind-mount `homeDir` at the same path**
  so creds persist on the host and are shared across containers (mirrors the pipeDir mount). Add the mount
  in `DockerEnvironment.ensureSession` when `opts.env.HOME` is an absolute path.

## Files

- `core/src/recognizers/{generic-yn,claude-permission}.ts` (+ tests).
- `core/src/auth/provisioner.ts` (+ test).
- `core/src/tmux/helpers.ts` — `newSession` `-e` env flags (+ test updates in `helpers.test.ts`,
  `env/local.test.ts`).
- `core/src/manager.ts` — register the two recognizers; wire `AuthProvisioner` (HOME env + ensureReady +
  needs_login).
- `core/src/env/docker.ts` — bind-mount the HOME dir (+ test).
- `scripts/smoke-m4-auth.ts` — the live login + reuse smoke (Local).

## Verification

- Unit gate (host-safe, mocked): `turbo run test lint typecheck` green — recognizers on fixtures;
  `AuthProvisioner` with a temp dir (isLoggedIn false→true after writing a creds file); `newSession -e`
  argv; Docker HOME mount argv.
- **Live auth smoke (needs the user — real OAuth):** drive `claude auth login` in a termbridge session
  (Local, dedicated TERMBRIDGE_HOME); `oauth-url` recognizer surfaces the URL; user authenticates, returns
  the code; agent `send_text`s it; `claude` logs in → creds written to `TERMBRIDGE_HOME/.claude`. Then open
  a SECOND session running `claude` → already logged in (no login prompt). Capture real prompt screens to
  tune `claude-permission`.

## Ship

Commit recognizers / AuthProvisioner / HOME-delivery / integration / smoke as logical units; push;
**pause before M5.**

## Notes / risks
- `claude-permission` strings depend on Claude Code 2.1.183 — tune against the live TUI; keep isolated.
- Live login runs real `claude` on the subscription (host, on the `-L termbridge` socket) — never touches
  the user's real `~/.claude` (dedicated TERMBRIDGE_HOME).
- Concurrency cap already enforced (TERMBRIDGE_MAX_SESSIONS) to respect plan limits (spec §7).
