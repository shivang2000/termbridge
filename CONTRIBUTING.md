# Contributing to termbridge

## Dev setup

```bash
bun install
bun run test        # turbo: unit tests (all mocked — no tmux/docker/network)
bun run typecheck   # tsc --noEmit across packages
bun run lint        # biome
bun run check       # biome --write (autofix)
```

CI (`.github/workflows/ci.yml`) runs typecheck + lint + test on every push/PR.

## Smokes (manual — need real tmux / Docker / a claude login)

Run on the host; most need the `termbridge:dev` image and creds at `~/.termbridge/home` (see README).

| Script | Proves |
|---|---|
| `bun scripts/smoke-env-guard.ts` | docker-only guard rejects `env:local` over real stdio (no docker/creds needed) |
| `bun scripts/smoke-concurrency.ts` | race-safe concurrency cap + per-session isolation (real docker) |
| `bun --env-file=.env scripts/smoke-sandbox-all.ts` | all cloud providers: E2B + Daytona (create/drive/kill) + Cloudflare (token verify only; no resources) |
| `bun scripts/smoke-sandbox-e2b.ts` | live E2B: open/drive/close (creds-gated — no-ops without `E2B_API_KEY`) |
| `bun scripts/smoke-sandbox-daytona.ts` | live Daytona: ephemeral sandbox open/drive/delete (creds-gated) |
| `bun scripts/smoke-sandbox-cloudflare.ts` | CF token + account check; creates nothing (Containers need Wrangler) |
| `bun scripts/smoke-mcp-http.ts` | streamable-HTTP MCP transport (`/mcp`): a real HTTP MCP client drives a local tmux session + asserts it lands in the server's shared registry (needs tmux) |
| `bun scripts/smoke-engineer-loop.ts` | the engineering loop drives real claude to fix a failing test |
| `bun scripts/accept-final.ts` | full acceptance: agent edits a bound repo via real claude, human co-present |

## Conventions
- TypeScript (NodeNext, strict, `noUncheckedIndexedAccess`). Biome for format + lint (tabs).
- Tests live next to source as `*.test.ts` and are excluded from published `dist`.
- Real tmux/claude work runs in **Docker** on the dedicated `-L termbridge` socket — never the host's
  default tmux socket. Keep the unit suite fully mocked.

## Release runbook

**Automated (preferred):** bump package versions (+ the internal `@termbridge/core` dep), commit, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. `.github/workflows/release.yml` runs the gate, publishes the
npm packages (idempotent — existing versions skipped), and builds + pushes both Docker images
(`<ns>/termbridge` and `<ns>/termbridge-sandbox`, `:X.Y.Z` + `:latest`).

Required repo secrets (Settings → Secrets → Actions, or `gh secret set <NAME>`):
`NPM_TOKEN` (npm **Classic Automation** token — bypasses 2FA), `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`
(a Docker Hub access token with write).

**Manual** (same effect, run locally — for reference):

**npm (libraries: core → mcp-server → orchestrator):**
```bash
# 1) bump versions (already 1.0.0), then for each publishable package:
#    remove "private": true, ensure publishConfig is set.
# 2) build (emits dist without test files):
bun run build
# 3) publish core FIRST (others depend on it), then mcp-server, then orchestrator:
cd packages/core && bun publish --access public && cd -
cd packages/mcp-server && bun publish --access public && cd -
cd packages/orchestrator && bun publish --access public && cd -
```
(`@termbridge/server` is Bun-only and distributed via source/Docker, not npm.)

**Docker image (self-contained server) → Docker Hub:**
```bash
docker login
scripts/publish-image.sh <dockerhub-namespace> 1.0.0   # builds + tags + pushes :1.0.0 and :latest
# users then: docker run --rm -p 8787:8787 -v ~/.termbridge/home:/home/tb/.termbridge/home <ns>/termbridge
```

**Tag the release:** `git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0`.

## Boundary
termbridge pilots a CLI as-is. It has **no** detection/evasion features (humanized timing, account
rotation, fingerprint spoofing) and will not accept them. Fleet-automating a subscription may violate the
provider's terms — use responsibly.
