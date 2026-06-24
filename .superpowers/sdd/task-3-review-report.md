# Task 3 Review — @termbridge/server publishable + bunx-runnable

**Reviewer:** automated  
**Branch:** m9-browser-watch  
**Commit:** d0fd335

---

## Verdicts

**SPEC: ✅** — All five spec requirements are implemented correctly.

**QUALITY: approved** — One important finding, one minor finding. No criticals.

---

## Findings

### Important

**`publish-npm.ts` double-builds client if `prepublishOnly` fires (lines 100–103 + package.json:19)**

`publish-npm.ts` explicitly calls `bun run build:client` (line 100–103) before writing the modified manifest and calling `npm publish`. `npm publish` then fires `prepublishOnly` (package.json line 19), which runs `bun run build:client` a second time. The second build is a no-op in practice (vite `emptyOutDir: true` just overwrites the same output), but it adds unnecessary CI time and is confusing — the explicit pre-build step implies the hook is redundant. Fix: either remove `prepublishOnly` from `package.json` (the script already guarantees build order) or remove the explicit `execFileSync("bun", ["run", "build:client"], …)` call from `publish-npm.ts` and rely solely on `prepublishOnly`. The current state is not broken but is redundant.

### Minor

**`files` whitelist includes `src` which ships `*.test.ts` files (`packages/server/package.json` line 8)**

`"files": ["src", "client/dist"]` publishes all of `src/`, including any `*.test.ts` files that live alongside source. This inflates the tarball and exposes test internals to consumers. The implementer already flagged this. Fix: add `"!src/**/*.test.ts"` to the `files` array (npm supports negation patterns), or move tests out of `src/`. Low severity — no functional or security impact, just unnecessary tarball bloat.

---

## High-risk items verified (no issues found)

- **Client built before publish:** `execFileSync("bun", ["run", "build:client"], …)` at `publish-npm.ts:100–103` runs before `writeFileSync(pkgPath, …)` (line 119) and `npm publish` (line 122). Order is correct.
- **Both workspace:* deps rewritten:** Loop at lines 108–117 iterates `dependencies`, `devDependencies`, and `peerDependencies`. `@termbridge/core` and `@termbridge/mcp-server` are in `dependencies`; both match `workspace:*` and are rewritten to `^${version}`. Correct.
- **Manifest restored on publish failure:** `writeFileSync(pkgPath, orig)` is inside `finally` (lines 126–128). If `npm publish` throws, the original is restored before the exception propagates. Correct.
- **Idempotency guard covers server:** Separate `npm view @termbridge/server@${version}` check at lines 87–94; skips with a log message if already published. Correct.
- **`clientDir` fix:** `fileURLToPath(new URL("../client/dist", import.meta.url))` at `server.ts:76` resolves relative to the compiled source file location. In-repo: `packages/server/src/server.ts` → `packages/server/client/dist`. In node_modules: `node_modules/@termbridge/server/src/server.ts` → `node_modules/@termbridge/server/client/dist`. Both correct.
- **CI bun installed before publish:** `release.yml` installs bun at lines 17–19, then `bun install --frozen-lockfile` (line 20) brings in vite (devDep). `bun scripts/publish-npm.ts` runs at line 27. Order is correct; vite is available when `build:client` runs.
- **`private: false`:** Confirmed in `packages/server/package.json` line 4. Additionally, `publish-npm.ts` line 107 does `delete published.private` before publish (belt-and-suspenders, fine).
- **`files` ships `client/dist`:** `"files": ["src", "client/dist"]` — `client/dist` will be included in the tarball, so the server can serve the UI when installed via bunx. Correct.
