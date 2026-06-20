# M2 — Docker environment (milestone plan)

Authority: spec §4, §5.1 (Environment), §9; decisions D4. Master plan: M1–M6.

## Goal

A second `Environment` backend — `DockerEnvironment` — that runs tmux **inside a per-session Docker
container** via `docker exec`, behind the **same `Environment` interface** as `LocalEnvironment`. The M1
piloting flow (open → sendText → waitForIdle → readScreen → C-c) works unchanged with `env:'docker'`.

## Design (keeps the M1 contract intact)

- **One `DockerEnvironment` instance per session.** `SessionManager.open()` already calls
  `envFactory(kind)` per session, so each docker session gets its own instance bound to one container
  `termbridge-<name>`. `kind = "docker"`.
- **Container lifecycle** (`ensureSession`): `docker run -d --name termbridge-<name> -v <cwd>:<cwd>
  -v <pipeDir>:<pipeDir> -w <cwd> [-e K=V…] termbridge:dev tail -f /dev/null`, then
  `docker exec termbridge-<name> tmux -L termbridge new-session -d -s <name> -x <cols> -y <rows>
  -c <cwd> [cmd]`. On failure, best-effort `docker rm -f` so no orphan container leaks.
- **`tmux(args)`**: `docker exec termbridge-<name> tmux -L termbridge <args>` (still `-L termbridge` inside
  the container — defence in depth).
- **`destroySession(name)`**: `docker rm -f termbridge-<name>` (kills container → kills its tmux).
- **`listSessions()`**: `docker exec … tmux -L termbridge list-sessions -F '#{session_name}'`; non-zero
  exit (container gone / no server) → `[]`, never throws.
- **`attachPty`**: throws "implemented in M5" (M5 uses `docker exec -it … tmux attach`).
- **Observer wiring unchanged:** because the container **bind-mounts the host `pipeDir` at the same path**,
  `pipe-pane`'s `cat >> <pipeDir>/<name>.log` (run via `docker exec`) writes to a host-visible file, so
  `makeFileTailer` (host fs) feeds the observer exactly as for Local. No change to `Session`/`PtyObserver`.
- **Injectable exec** (default `defaultExec` running the `docker` CLI) so unit tests assert exact `docker`
  argv with a mock and spawn no real container.

## Files

- `packages/core/src/env/docker.ts` — `DockerEnvironment` (+ `docker.test.ts`). Constructor opts:
  `{ exec?, image="termbridge:dev", socket="termbridge", containerPrefix="termbridge-", pipeDir }`.
- `packages/core/src/manager.ts` — default `envFactory` gains a `docker` branch; pass `{ pipeDir }` context
  so `DockerEnvironment` can mount it. (Signature `envFactory(kind, ctx)` — existing test factories ignore
  the extra arg, unaffected.)
- `packages/core/src/index.ts` — export `DockerEnvironment`.
- `scripts/smoke-m2.ts` — the M1 piloting flow with `env:'docker'`, run **on the host** (spawns a real
  container; tmux runs inside it — host tmux never touched). Cleans up the container in `finally`.

## Verification

- Unit gate (host-safe, all mocked): `turbo run test lint typecheck` green — `docker.test.ts` asserts the
  `docker run` / `docker exec tmux -L termbridge` / `docker rm -f` argv with a mock exec.
- **M2 smoke (real docker, host):** `bun scripts/smoke-m2.ts` — opens a docker session, echoes a marker,
  waitForIdle, readScreen asserts it, C-c interrupt; asserts the container is gone after close. Requires
  the `termbridge:dev` image (built in M1) + docker daemon.
- Safety: host `tmux ls` still reports no server; only `docker` containers are created/removed.

## Ship

Commit `feat(core): DockerEnvironment` + `chore(test): M2 docker smoke`; push; **pause before M3.**

## Notes / risks
- Bind-mounting `<cwd>` and `<pipeDir>` at identical host paths makes the in-container `pipe-pane` file
  host-visible — the crux that keeps the observer wiring backend-agnostic.
- `docker exec` per tmux call adds latency vs Local; `wait_for_idle` default quietMs (400ms) still applies.
- Orphan-container safety: `ensureSession` cleans up on failure; `close()` always `docker rm -f`.
