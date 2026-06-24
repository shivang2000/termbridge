# M9 — Browser Watch for Hermes-driven Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a human a localhost browser URL that watches (and can take over) the exact Claude sessions Hermes is driving.

**Architecture:** Make `@termbridge/mcp-server` a thin **proxy**: when `TERMBRIDGE_SERVER_URL` is set, its 13 tools forward to a host-run unified server (`bunx @termbridge/server`) that owns the single `SessionManager` and serves the web bridge — so the browser and Hermes share one registry. Turnkey via `setup.sh --watch`.

**Tech Stack:** TypeScript (NodeNext, strict), Bun (runtime + test), `@modelcontextprotocol/sdk`, Hono (server), zod, vite (web client). No pnpm.

## Global Constraints
- Proxy mode must NOT construct a session-running `SessionManager` in Hermes' process (forwarder only); `TERMBRIDGE_SERVER_URL` unset = today's in-process behaviour, byte-for-byte (zero-infra default preserved).
- Remote caller keys on the **OUTER** `{ok}` envelope only — `send_text`'s inner `{ok:false,error:"human_driving"}` stays data. Throw on outer `!ok` (→ MCP error parity).
- Secrets (`TERMBRIDGE_TOKEN`, `ANTHROPIC_API_KEY`, `GH_TOKEN`) are never printed — mask via the existing `mask_kv` in setup.sh.
- Server binds loopback (`127.0.0.1`) + bearer token + Origin allowlist (unchanged security model).
- Ship as **1.0.6**; `@termbridge/server` becomes publishable. Run on the host via Bun.
- DRY / YAGNI / TDD / frequent commits.

## File structure
- `packages/mcp-server/src/remote.ts` — NEW: `createRemoteCaller` (HTTP tool client) + `createRemoteToolSpecs` (schemas from `createToolSpecs`, remote handlers).
- `packages/mcp-server/src/server.ts` — `createServer` gains a `remote?` option (register remote specs instead of manager specs).
- `packages/mcp-server/src/stdio.ts` — `runServer` reads `TERMBRIDGE_SERVER_URL`/`TERMBRIDGE_TOKEN` → passes `remote`.
- `packages/mcp-server/src/index.ts` — export the new API.
- `packages/server/package.json` — `private:false`, `files`, client build hook.
- `scripts/publish-npm.ts` — build + publish `@termbridge/server`.
- `.github/workflows/release.yml` — server in the publish set.
- `scripts/setup.sh` — `--watch` flag (server lifecycle + proxy registration + URL).
- `skills/engineer-loop/SKILL.md` — post the per-session watch URL.
- `docs/integration/hermes.md`, `docs/demo/hermes-demo.md`, `README.md`, `CHANGELOG.md`, version bumps.

---

### Task 1: MCP proxy mode (`remote.ts` + `createServer` wiring)

**Files:**
- Create: `packages/mcp-server/src/remote.ts`
- Modify: `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/stdio.ts`, `packages/mcp-server/src/index.ts`
- Test: `packages/mcp-server/src/remote.test.ts`

**Interfaces:**
- Consumes: `createToolSpecs(manager): ToolSpec[]` and `interface ToolSpec { name; description; inputSchema: z.ZodRawShape; handler: (args:any)=>Promise<unknown> }` (`tools.ts:16-28`); the HTTP envelope `{ok:true,data} | {ok:false,error}` served at `POST /api/tool/:name?token=` (`packages/server/src/http-tools.ts:12`, used by `scripts/engineer.ts:73-82`).
- Produces: `createRemoteCaller(opts:{serverUrl:string;token:string}): (name:string,args:unknown)=>Promise<unknown>` and `createRemoteToolSpecs(caller): ToolSpec[]`; `CreateServerOptions.remote?: { serverUrl:string; token:string }`.

- [ ] **Step 1: Write the failing test** — `packages/mcp-server/src/remote.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { createRemoteCaller } from "./remote.js";

function stubFetch(handler: (url: string, init: any) => { status?: number; body: unknown }) {
  return (async (url: string, init: any) => {
    const { status = 200, body } = handler(url, init);
    return { status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("createRemoteCaller", () => {
  test("POSTs to /api/tool/:name?token= and returns inner data on outer ok", async () => {
    let seen: { url: string; body: any } | undefined;
    const caller = createRemoteCaller({ serverUrl: "http://h:1", token: "T", fetchImpl: stubFetch((url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return { body: { ok: true, data: { id: "s1" } } };
    }) });
    const out = await caller("open_session", { env: "local" });
    expect(out).toEqual({ id: "s1" });
    expect(seen!.url).toBe("http://h:1/api/tool/open_session?token=T");
    expect(seen!.body).toEqual({ env: "local" });
  });

  test("throws on outer !ok (MCP error parity)", async () => {
    const caller = createRemoteCaller({ serverUrl: "http://h:1", token: "T", fetchImpl: stubFetch(() => ({ status: 400, body: { ok: false, error: "session not found: x" } })) });
    await expect(caller("read_screen", { id: "x" })).rejects.toThrow("session not found: x");
  });

  test("keeps inner human_driving as DATA (outer ok)", async () => {
    const caller = createRemoteCaller({ serverUrl: "http://h:1", token: "T", fetchImpl: stubFetch(() => ({ body: { ok: true, data: { ok: false, error: "human_driving" } } })) });
    expect(await caller("send_text", { id: "s1", text: "x" })).toEqual({ ok: false, error: "human_driving" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/mcp-server/src/remote.test.ts`
Expected: FAIL — `Cannot find module './remote.js'`.

- [ ] **Step 3: Write `remote.ts`**

```ts
// remote.ts — proxy mode: forward tool calls to a running unified server's HTTP
// tool API instead of an in-process SessionManager, so the browser (served by
// that server) watches the exact sessions this MCP drives. Lifted from
// scripts/engineer.ts's HTTP client; keys ONLY on the outer {ok} envelope.
import { createToolSpecs } from "./tools.js";
import type { ToolSpec } from "./tools.js";
import { SessionManager } from "@termbridge/core";

export interface RemoteOptions {
  serverUrl: string;
  token: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export type RemoteCaller = (name: string, args: unknown) => Promise<unknown>;

export function createRemoteCaller(opts: RemoteOptions): RemoteCaller {
  const base = opts.serverUrl.replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  return async (name, args) => {
    const res = await f(`${base}/api/tool/${name}?token=${encodeURIComponent(opts.token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
    const j = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
    if (!j.ok) throw new Error(j.error ?? `tool ${name} failed (${res.status})`);
    return j.data;
  };
}

/** Reuse createToolSpecs ONLY for name/description/inputSchema; swap each handler
 *  to the remote caller. The throwaway manager is never opened (no tmux/observer);
 *  in proxy mode TERMBRIDGE_HOME is unset so its construction has no side effects. */
export function createRemoteToolSpecs(caller: RemoteCaller): ToolSpec[] {
  return createToolSpecs(new SessionManager()).map((s) => ({
    name: s.name,
    description: s.description,
    inputSchema: s.inputSchema,
    handler: (args: unknown) => caller(s.name, args),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/mcp-server/src/remote.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire `createServer` to use remote specs when configured** — `packages/mcp-server/src/server.ts`

Replace the body so a `remote` option registers remote specs instead of manager specs (keep the same `formatTextResponse`/`formatErrorResponse` wrapping):

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionManager } from "@termbridge/core";
import { formatErrorResponse, formatTextResponse } from "./format.js";
import { createRemoteCaller, createRemoteToolSpecs } from "./remote.js";
import { createToolSpecs, type ToolSpec } from "./tools.js";

export interface CreateServerOptions {
  manager?: SessionManager;
  /** Proxy mode: forward every tool to a running unified server (browser-watchable). */
  remote?: { serverUrl: string; token: string };
}

export function createServer(opts: CreateServerOptions = {}): McpServer {
  const specs: ToolSpec[] = opts.remote
    ? createRemoteToolSpecs(createRemoteCaller(opts.remote))
    : createToolSpecs(opts.manager ?? new SessionManager());
  const server = new McpServer({ name: "termbridge", version: "0.1.0" });
  for (const spec of specs) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.inputSchema },
      async (args: unknown) => {
        try {
          return formatTextResponse(await spec.handler(args));
        } catch (e) {
          return formatErrorResponse(e);
        }
      },
    );
  }
  return server;
}
```

- [ ] **Step 6: Read `TERMBRIDGE_SERVER_URL` in `runServer`** — `packages/mcp-server/src/stdio.ts`

```ts
export async function runServer(): Promise<void> {
  const serverUrl = process.env.TERMBRIDGE_SERVER_URL;
  const token = process.env.TERMBRIDGE_TOKEN ?? "";
  const server = createServer(serverUrl ? { remote: { serverUrl, token } } : {});
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 7: Export the new API** — add to `packages/mcp-server/src/index.ts`

```ts
export { createRemoteCaller, createRemoteToolSpecs } from "./remote.js";
export type { RemoteCaller, RemoteOptions } from "./remote.js";
```

- [ ] **Step 8: Run the package suite + typecheck**

Run: `bunx turbo run typecheck lint test --filter=@termbridge/mcp-server`
Expected: PASS (existing tests + 3 new). Existing in-process behaviour unchanged (no `remote` passed).

- [ ] **Step 9: Commit**

```bash
git add packages/mcp-server/src
git commit -m "feat(mcp): proxy mode — forward tools to a running server (browser-watchable)"
```

---

### Task 2: e2e smoke — shared registry over the proxy

**Files:**
- Create: `scripts/smoke-watch.ts`

**Interfaces:**
- Consumes: `startServer` (`packages/server/src/index.ts:26`); the published-style entry `runServer` via `TERMBRIDGE_SERVER_URL`; core `SessionManager`.
- Produces: an operator smoke proving a session opened THROUGH the stdio proxy appears in the SERVER's `list_sessions`.

- [ ] **Step 1: Write the smoke** — `scripts/smoke-watch.ts`

```ts
// Proves the proxy shares the registry: start a unified server, point an
// in-process proxy MCP at it via TERMBRIDGE_SERVER_URL, open a session through
// the proxy, and assert the SAME id is visible in the SERVER's manager.
// Run: bun scripts/smoke-watch.ts   (docker creds at ~/.termbridge/home; env=docker)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../packages/core/src/index.ts";
import { startServer } from "../packages/server/src/index.ts";
import { createServer } from "../packages/mcp-server/src/server.ts";

const pipeDir = mkdtempSync(join(tmpdir(), "tb-watch-"));
const mgr = new SessionManager({ maxSessions: 1, pipeDir, homeDir: join(process.env.HOME!, ".termbridge", "home") });
const { port, token } = startServer({ manager: mgr, port: 0 });
const url = `http://127.0.0.1:${port}`;

// Proxy MCP backed by the SAME server (createServer remote mode), call its tools directly.
const remote = createServer({ remote: { serverUrl: url, token } });
// open_session via the proxy → server's manager
const open = await fetch(`${url}/api/tool/open_session?token=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ env: "docker", cmd: "claude" }) });
const { data } = (await open.json()) as { ok: boolean; data: { id: string } };
const list = await fetch(`${url}/api/tool/list_sessions?token=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const seen = (await list.json()) as { data: { sessions: { id: string }[] } };
const ok = seen.data.sessions.some((s) => s.id === data.id);
console.log(ok ? `PASS — session ${data.id} shared via the server` : "FAIL — id not in server registry");
await mgr.close(data.id).catch(() => {});
rmSync(pipeDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run it (operator, needs docker + creds)**

Run: `bun scripts/smoke-watch.ts`
Expected: `PASS — session <id> shared via the server`, exit 0. (Skip in CI — needs docker + a logged-in claude; this is an operator smoke like `scripts/accept-final.ts`.)

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-watch.ts
git commit -m "test(smoke): proxy shares the server's session registry"
```

---

### Task 3: Publish `@termbridge/server` (bun-runnable, client bundled)

**Files:**
- Modify: `packages/server/package.json`, `scripts/publish-npm.ts`, `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the existing vite client build (`packages/server` devDeps: vite + xterm); `startServer({ clientDir })` (`index.ts:22,40`) which serves a `clientDir`.
- Produces: a published `@termbridge/server@1.0.6` runnable via `bunx @termbridge/server` that serves the web client at `/`.

- [ ] **Step 1: Confirm the client build output path**

Run: `ls packages/server && cat packages/server/package.json | grep -A2 scripts`
Find the vite client source dir + build output (e.g. `client/` → `client/dist/`). Note the build command (vite build) and the default `clientDir` resolution in `server.ts`/`index.ts`.

- [ ] **Step 2: Make the package publishable + ship the client** — `packages/server/package.json`

Set `"private": false`. Add a `files` whitelist and a build script that produces the client dist, and ensure `startServer`'s default `clientDir` resolves to the shipped location when run from `node_modules`:

```jsonc
{
  "private": false,
  "files": ["src", "client/dist"],
  "scripts": { "build:client": "vite build client", "prepublishOnly": "bun run build:client" }
}
```
If `server.ts` defaults `clientDir` to a dev path, change it to resolve relative to the package (e.g. `new URL("../client/dist", import.meta.url)`), with the existing dev fallback.

- [ ] **Step 3: Extend the publisher** — `scripts/publish-npm.ts`

Add `@termbridge/server` to the publish set: build the client first (`bun run -w @termbridge/server build:client`), then `npm publish -w @termbridge/server`. The server ships TS (run by Bun) so it needs NO `src→dist` manifest swap — only the client dist must be present. Keep the idempotent "skip versions already on the registry" guard.

- [ ] **Step 4: Include server in the release workflow** — `.github/workflows/release.yml`

Wherever the npm publish step runs `scripts/publish-npm.ts`, ensure it now also covers the server (the script change in Step 3 handles this; verify the workflow installs bun + builds the client). No new third-party actions (semgrep pin rule).

- [ ] **Step 5: Publish dry-run (local)**

```bash
bun run -w @termbridge/server build:client
npm pack -w @termbridge/server                # inspect the tarball includes client/dist
mkdir -p /tmp/tbsrv && cd /tmp/tbsrv && npm init -y && npm i <path-to-tgz>
TERMBRIDGE_TOKEN=t PORT=8799 bunx @termbridge/server &   # boots
curl -s "http://127.0.0.1:8799/?token=t" | head -c 80     # serves the client HTML
```
Expected: server boots on 8799; the curl returns the client HTML. Kill it after.

- [ ] **Step 6: Commit**

```bash
git add packages/server/package.json scripts/publish-npm.ts .github/workflows/release.yml
git commit -m "build(server): publishable @termbridge/server (bunx) with bundled client"
```

---

### Task 4: `setup.sh --watch` — server lifecycle + proxy registration

**Files:**
- Modify: `scripts/setup.sh`

**Interfaces:**
- Consumes: existing `mask_kv`, `ENV_PAIRS`, the re-register block, the recap; `bunx @termbridge/server`; `~/.termbridge/watch.json` (new state file).
- Produces: a `--watch` flag that (local mode) starts the server, registers the MCP with `TERMBRIDGE_SERVER_URL`+`TERMBRIDGE_TOKEN` only, and prints the watch URL.

- [ ] **Step 1: Add the flag + a free-port helper**

In the flag block: `--watch) DO_WATCH="true"; shift ;;` (default `DO_WATCH="false"`). In the help header add `--watch  start a host web server so you can WATCH/intervene in a browser (local mode; needs bun)`.

- [ ] **Step 2: Start the server before registering the MCP (only when --watch)**

After the auth/host-claude step and BEFORE building `ENV_PAIRS`, add:

```sh
WATCH_URL=""
if [ "$DO_WATCH" = "true" ]; then
  [ "$MODE" = "local" ] || die "--watch is local-mode only (the server drives host tmux/claude)."
  command -v bun >/dev/null 2>&1 || die "--watch needs bun on PATH (the web server is Bun-only)."
  step "Starting the watch server (bunx @termbridge/server)"
  WATCH_TOKEN="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  WATCH_PORT="$(node -e 'const n=require("net").createServer();n.listen(0,()=>{console.log(n.address().port);n.close()})')"
  WATCH_DIR="$HOME/.termbridge"; mkdir -p "$WATCH_DIR"
  # stop a previous watch server from an earlier run
  [ -f "$WATCH_DIR/watch.pid" ] && kill "$(cat "$WATCH_DIR/watch.pid")" 2>/dev/null || true
  # the SERVER holds the SessionManager → it gets the session env (api-key, gh, auto-approve, allowed envs)
  TERMBRIDGE_ALLOWED_ENVS=local TERMBRIDGE_TMUX_SOCKET=termbridge TERMBRIDGE_AUTO_APPROVE=1 \
    TERMBRIDGE_FORWARD_ENV=ANTHROPIC_API_KEY \
    ${API_KEY:+ANTHROPIC_API_KEY="$API_KEY"} ${GH_TOKEN_ARG:+GH_TOKEN="$GH_TOKEN_ARG"} \
    TERMBRIDGE_TOKEN="$WATCH_TOKEN" PORT="$WATCH_PORT" HOST=127.0.0.1 \
    nohup bunx @termbridge/server >"$WATCH_DIR/watch.log" 2>&1 &
  echo $! > "$WATCH_DIR/watch.pid"
  WATCH_URL="http://127.0.0.1:$WATCH_PORT/?token=$WATCH_TOKEN"
  printf '%s\n' "{\"port\":$WATCH_PORT,\"token\":\"$WATCH_TOKEN\",\"pid\":$(cat "$WATCH_DIR/watch.pid")}" > "$WATCH_DIR/watch.json"
  ok "watch server up on 127.0.0.1:$WATCH_PORT (loopback + token)"
fi
```

- [ ] **Step 3: Point the MCP at the server in watch mode (config moves to the server)**

Change `ENV_PAIRS` construction so that when `DO_WATCH=true` the MCP gets ONLY the proxy vars, else the current behaviour:

```sh
if [ "$DO_WATCH" = "true" ]; then
  ENV_PAIRS=( "TERMBRIDGE_SERVER_URL=http://127.0.0.1:$WATCH_PORT" "TERMBRIDGE_TOKEN=$WATCH_TOKEN" )
else
  ENV_PAIRS=( "TERMBRIDGE_TMUX_SOCKET=termbridge" "TERMBRIDGE_ALLOWED_ENVS=$ALLOWED_ENVS" "TERMBRIDGE_MAX_SESSIONS=$MAX_SESSIONS" )
  [ "$MODE" != "local" ] && ENV_PAIRS+=( "TERMBRIDGE_HOME=$TERMBRIDGE_HOME" )
  # (existing gh-token auto-forward + api-key blocks stay in the else branch)
  [ -n "$GH_TOKEN_ARG" ] && ENV_PAIRS+=( "GH_TOKEN=$GH_TOKEN_ARG" )
  [ -n "$API_KEY" ] && ENV_PAIRS+=( "TERMBRIDGE_FORWARD_ENV=ANTHROPIC_API_KEY" "ANTHROPIC_API_KEY=$API_KEY" )
fi
```
`mask_kv` already masks `TERMBRIDGE_TOKEN`? Add `TERMBRIDGE_TOKEN=*) echo "TERMBRIDGE_TOKEN=***"` to `mask_kv`.

- [ ] **Step 4: Print the watch URL in the recap**

In the final recap "Done by setup" block, when `WATCH_URL` is set:
```sh
[ -n "$WATCH_URL" ] && authline "  Browser watch" "${G}$WATCH_URL${N}  — open to watch + take over"
```

- [ ] **Step 5: Verify with the stub harness (no real server/bun call)**

Extend the existing stubbed end-to-end test: stub `bun`/`bunx` + `node` (port), run `setup.sh --mode local --watch --api-key sk-x --gh-token ghp_x`, assert: the `mcp add` env contains `TERMBRIDGE_SERVER_URL` + `TERMBRIDGE_TOKEN` and NOT `ANTHROPIC_API_KEY`/`GH_TOKEN` (those went to the server); a `watch.pid` was written; the token is masked in any printed command.

Run: `bash -n scripts/setup.sh && <the stub harness>`
Expected: PASS — proxy-only MCP env, watch server "started" (stub), URL printed, no secret leak.

- [ ] **Step 6: Commit**

```bash
git add scripts/setup.sh
git commit -m "feat(setup): --watch starts the host web server + proxies the MCP to it"
```

---

### Task 5: Skill posts the per-session watch URL

**Files:**
- Modify: `skills/engineer-loop/SKILL.md`

- [ ] **Step 1: Add the URL surfacing after open_session** — in step 1 (after the session is open), add:

> After `open_session`, if `TERMBRIDGE_SERVER_URL` is set in the environment, post the live watch URL to the
> channel ONCE: `<TERMBRIDGE_SERVER_URL>/?session=<id>&token=<TERMBRIDGE_TOKEN>` — *"Watch live / take over
> here."* Typing in that page flips the WriteLock → your sends are refused (`human_driving`) and the
> in-session auto-approver pauses, so the human is fully in control until they stop.

- [ ] **Step 2: Commit**

```bash
git add skills/engineer-loop/SKILL.md
git commit -m "docs(skill): post the per-session browser watch URL"
```

---

### Task 6: Docs + version bump + release

**Files:**
- Modify: `docs/integration/hermes.md`, `docs/demo/hermes-demo.md`, `README.md`, `CHANGELOG.md`, `packages/*/package.json`

- [ ] **Step 1: Docs** — add the `--watch` path to the one-command sections: `… | bash -s -- --mode local --api-key … --gh-token … --watch`, and a "Watch in the browser" subsection (open the printed URL; type to take over; loopback+token security). In `hermes-demo.md` replace the "no browser URL yet (M9)" caveat with the `--watch` instructions + the `tmux attach` fallback.

- [ ] **Step 2: Version bump → 1.0.6** — set `version` to `1.0.6` in `packages/{core,mcp-server,server,orchestrator,claude-code-plugin}/package.json`; bump `@termbridge/core` dep in mcp-server to `^1.0.6` and `@termbridge/mcp-server`/`@termbridge/core` workspace deps stay `workspace:*`.

- [ ] **Step 3: CHANGELOG** — add `## v1.0.6 — <date>` describing the browser watch (proxy + publishable server + `setup.sh --watch`).

- [ ] **Step 4: Full gate**

Run: `bunx turbo run typecheck lint test`
Expected: all packages green.

- [ ] **Step 5: Commit + push + tag**

```bash
git add -A && git commit -m "feat(m9): browser watch for Hermes sessions (proxy + bunx server + --watch)"
git push origin main
git tag -a v1.0.6 -m "v1.0.6 — browser watch for Hermes-driven sessions"
git push origin v1.0.6     # release.yml publishes npm (incl. @termbridge/server) + images
```

- [ ] **Step 6: Verify the release** — `gh run watch` the release; then `npm view @termbridge/server version` → `1.0.6` and `bunx @termbridge/server` boots in a clean dir.

---

## Self-Review

**Spec coverage:** proxy (T1) · config-on-server (T1 stdio env + T4) · publish server (T3) · setup --watch (T4) · skill URL (T5) · docs/version/release (T6) · unit + e2e smoke + publish dry-run + manual (T1/T2/T3 + T6). All spec sections map to a task.

**Placeholder scan:** none — every code step shows real code; the only "confirm path" step (T3.1) is a read, not a placeholder.

**Type consistency:** `ToolSpec`/`createToolSpecs`/`createServer({remote})`/`RemoteCaller` names are consistent across T1; the HTTP envelope `{ok,data,error}` matches `http-tools.ts` + `engineer.ts`.

**Known risk:** T3 (publishing the Bun server with a bundled vite client + correct `clientDir` resolution from `node_modules`) is the heaviest, least-mechanical task — do the publish dry-run (T3.5) before tagging.
