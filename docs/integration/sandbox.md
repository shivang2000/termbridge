# Sandbox (cloud) integration — E2B

termbridge's `env:"sandbox"` runs a session's tmux INSIDE a cloud sandbox, behind
the same `Environment` interface as `local`/`docker` (D4). A concrete provider ships
in `@termbridge/sandbox-e2b` (E2B); Daytona/Cloudflare are future ports behind the
same `SandboxProvider` interface.

## Setup

1. Get an E2B API key (`E2B_API_KEY`). The default `base` template is used; tmux is
   installed on first `ensure` via passwordless `sudo` (E2B `base` user is non-root).

2. **Turnkey (server / MCP):** set `E2B_API_KEY` in the process env. Both
   `bunx @termbridge/server` and `npx @termbridge/mcp-server` auto-wire
   `E2BSandboxProvider` when the key is present — then `open_session({ env: "sandbox" })`
   works with no custom code.

   ```bash
   export E2B_API_KEY=e2b_…
   bunx @termbridge/server
   # or
   TERMBRIDGE_TOKEN=… E2B_API_KEY=… npx -y @termbridge/mcp-server
   ```

3. **Library use:** wire the provider yourself (or use `sandboxProviderFromEnv()`):

   ```ts
   import { SessionManager } from "@termbridge/core";
   import { E2BSandboxProvider, sandboxProviderFromEnv } from "@termbridge/sandbox-e2b";

   const manager = new SessionManager({
     sandboxProvider: sandboxProviderFromEnv() ?? new E2BSandboxProvider({ apiKey: "…" }),
   });
   const session = await manager.open({ env: "sandbox", cwd: "/root", cmd: "claude" });
   ```

4. If `env: "sandbox"` is requested with **no** provider configured, core throws
   `sandbox_not_configured` (code) before any cloud call.

## Live smoke (creds-gated)

```bash
E2B_API_KEY=... bun scripts/smoke-sandbox-e2b.ts
```

Without `E2B_API_KEY` the smoke no-ops and exits 0 (so `bun run test` stays green).
