# Task 3 Report: Publishable @termbridge/server with Bundled Client

## Status: DONE

**Commit:** `d0fd335`
**Branch:** `m9-browser-watch`

---

## Changes Made

### 1. `clientDir` Fix — `packages/server/src/server.ts`

**Problem:** Line 139 had `opts.clientDir ?? "./packages/server/client/dist"` — a CWD-relative path that resolves correctly when run from the repo root (`bun run src/index.ts`) but breaks completely when installed via `bunx` from `node_modules` (CWD is wherever the user is, not the package directory).

**Fix:** Added `import { fileURLToPath } from "node:url"` and:
```ts
const DEFAULT_CLIENT_DIR = fileURLToPath(new URL("../client/dist", import.meta.url));
```
`import.meta.url` is always the URL of `server.ts` itself (i.e., `<install-path>/src/server.ts`), so `../client/dist` resolves to `<install-path>/client/dist` — correct in both dev (in-repo) and installed (node_modules) contexts. The `clientDir` fallback now uses `DEFAULT_CLIENT_DIR` instead of the CWD-relative string.

### 2. Package Manifest — `packages/server/package.json`

- `"private": false` — makes it publishable
- `"files": ["src", "client/dist"]` — whitelist: ships TS source + built client, excludes test files from published tarball... wait, `npm pack` dry-run showed test files ARE included. The `files` array includes `"src"` which contains test files. This is fine — they're inert at runtime, and the server ships source for Bun. Could be tightened later with explicit file exclusions.
- `"build:client": "cd client && bunx vite build"` — builds the vite app from its own directory. Using `--config` + `--root` flags on the `vite build` CLI was rejected: vite 6 does not support `--root` on the `build` subcommand. `cd client` is the correct approach since vite.config.ts sets `outDir: "dist"` relative to its own location.
- `"prepublishOnly": "bun run build:client"` — ensures client is built before any manual `npm publish` (the publish script runs it explicitly, so this is a safety net).

### 3. Publish Script — `scripts/publish-npm.ts`

Added a new block for `@termbridge/server` after the existing PKGS loop. Key decisions:

**workspace:* rewrite approach:** The existing packages use `publishConfig` to swap `exports`/`bin`/etc. The server has no `publishConfig` (it ships TS directly — no dist swap needed), but it does have `workspace:*` deps (`@termbridge/core`, `@termbridge/mcp-server`). The publish block:
1. Checks npm registry for idempotency (skip if already published)
2. Runs `bun run build:client` in the `packages/server` directory
3. Parses `package.json`, removes `private`, rewrites all `workspace:*` values to `^<version>` across `dependencies`/`devDependencies`/`peerDependencies`
4. Writes the rewritten manifest, calls `npm publish -w @termbridge/server --access public`
5. Restores the original `package.json` in the `finally` block (identical pattern to existing packages)

The version used for rewriting is the package's own version (all `@termbridge/*` packages travel at the same version).

### 4. CI — `.github/workflows/release.yml`

**No changes needed.** The CI workflow already:
- Runs `bun install --frozen-lockfile` (installs vite as a devDep)
- Runs `bun scripts/publish-npm.ts` which now handles the server

The `build:client` step uses `bunx vite build` which resolves to the workspace-local vite installation. No third-party actions added.

---

## Dry-Run Verification

### Commands run:
```bash
# 1. Build client
cd packages/server && bun run build:client
# Output: vite v6.4.3, 8 modules transformed, dist/index.html 1.56kB, dist/assets/*.js 340.5kB

# 2. Verify tarball contents (with workspace:* rewritten)
npm pack -w @termbridge/server --dry-run
```

### Tarball contents (npm pack dry-run):
```
client/dist/assets/index-6GBZ9nXN.css   5.2kB
client/dist/assets/index-BLAfSqOS.js    340.5kB
client/dist/index.html                  1.6kB
package.json
src/bridge.adversary.test.ts ... src/server.ts
```
`client/dist/index.html` confirmed present.

### Install + serve test:
Rewriting `workspace:*` → `^1.0.5` (as the publish script does), packing, installing in a fresh `npm init -y` dir, then running:
```bash
TERMBRIDGE_TOKEN=t PORT=8799 HOST=127.0.0.1 bun run node_modules/@termbridge/server/src/index.ts
```

**Results:**
```
[termbridge] server on http://127.0.0.1:8799  (token: t)
```

```bash
curl -s "http://127.0.0.1:8799/healthz?token=t"
# → {"ok":true,"tools":["open_session","list_sessions","send_text","send_control","read_screen","read_new_output","read_progress","wait_for_idle","wait_for_text","read_events","wait_for_event","resize","close_session"]}

curl -s "http://127.0.0.1:8799/?token=t" | head -c 200
# → <!doctype html><html lang="en">  <head>    <meta charset="utf-8" />    ...
```

Client HTML served at `/`. All 13 tools registered. Health check passes.

Note: `bunx @termbridge/server` itself returns 404 from the registry (package not yet published), which is expected for a dry-run. The installed-package boot via `bun run node_modules/...` proves the runtime behavior is correct.

### Gate:
```
bunx turbo run typecheck lint test --filter=@termbridge/server
# 93 pass, 0 fail — Tasks: 3 successful, 3 total
```

---

---

## Addendum: Publish-setup fixes (branch m9-browser-watch, commit 53bcdd6)

### FIX 1 — Remove double-build

Deleted `"prepublishOnly": "bun run build:client"` from `packages/server/package.json`. The explicit `bun run build:client` call in `scripts/publish-npm.ts` is now the single, deterministic build step. The `build:client` script itself is retained.

### FIX 2 — Exclude test files from tarball

Changed `"files"` from `["src", "client/dist"]` to `["src", "client/dist", "!src/**/*.test.ts"]`. npm honors negation glob patterns in `files`.

### Verification

```
npm pack -w @termbridge/server --dry-run 2>&1 | grep -E "\.test\.ts|client/dist/index\.html"
```

Result: `npm notice 1.6kB client/dist/index.html`

- `client/dist/index.html` — PRESENT
- `.test.ts` entries — NONE

`bunx turbo run typecheck lint test --filter=@termbridge/server` — 3 tasks successful, 93 pass, 0 fail.

---

## Deviations from Spec

1. **`bunx @termbridge/server` vs `bun run node_modules/...`:** The spec's dry-run uses `bunx --bun @termbridge/server` which tries to fetch from npm registry (404 since unpublished). The actual boot test used `bun run node_modules/@termbridge/server/src/index.ts` which tests identical runtime behavior. Once published, `bunx @termbridge/server` will work identically.

2. **Test files in tarball:** `"files": ["src", "client/dist"]` includes test files (`*.test.ts`) since they're in `src/`. They're inert at runtime. Could be tightened with a `.npmignore` excluding `*.test.ts` — deferred as non-blocking.

3. **`prepublishOnly` and `bunx`:** The `build:client` script uses `bunx vite build` (goes to registry if vite not installed). In the publish environment (CI or local after `bun install`), vite is a devDep and is present in `node_modules/.bin/`. `bunx` will prefer the local binary. This is correct.
