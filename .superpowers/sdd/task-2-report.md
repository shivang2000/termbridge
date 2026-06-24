# Task 2 Report — smoke-watch.ts

## What was verified against real types

| Item | Verified shape | Source |
|------|---------------|--------|
| `startServer` return | `{ server, manager, port, host, token }` | `packages/server/src/index.ts:43` |
| `server.stop()` | `Bun.Server` — `.stop()` exists (no `?`) | Bun native type |
| `open_session` return data | `{ id, name, env }` | `packages/mcp-server/src/tools.ts:73` |
| `list_sessions` return data | `{ sessions: manager.list() }` — each item has `.id` | `packages/mcp-server/src/tools.ts:81` |
| `SessionManager` options | `{ maxSessions?, pipeDir?, homeDir?, ... }` | `packages/core/src/manager.ts:105-138` |
| HTTP tool API route | `POST /api/tool/:name?token=` → `{ ok, data?, error? }` | `scripts/engineer.ts:74-80` (confirmed pattern) |

**Adjustments from the template:**
- `tool()` return typed as `Promise<unknown>` (not `Promise<any>`) — keeps TypeScript clean.
- `server.stop()` called without `?.` — it is unconditionally present on `Bun.Server`.

## Build result

```
bun build scripts/smoke-watch.ts --target=bun --outfile=/dev/null
Bundled 285 modules in 28ms
  null  0.61 MB  (entry point)
```

Exit code 0. All 285 transitive modules resolved (core, server, and their deps).

## Typecheck

```
bunx turbo run typecheck
```

Exit code 0. No new errors introduced by this file.

## Why the run is deferred

The smoke requires:
1. Docker daemon running
2. A logged-in claude credential at `~/.termbridge/home` (OAuth flow via the shared-subscription model)
3. `env: "docker"` is the explicitly requested environment — it opens a Docker container per session

Neither condition is satisfiable in this CI environment. The script is operator-gated exactly as the existing `smoke-concurrency.ts` and `smoke-engineer-loop.ts` smokes are.

## Commit

`95d82a4` — `test(smoke): watch — proxy shares the server's session registry (operator-gated)`
