# Sandbox (cloud) integration — E2B

termbridge's `env:"sandbox"` runs a session's tmux INSIDE a cloud sandbox, behind
the same `Environment` interface as `local`/`docker` (D4). A concrete provider ships
in `@termbridge/sandbox-e2b` (E2B); Daytona/Cloudflare are future ports behind the
same `SandboxProvider` interface.

## Setup

1. Get an E2B API key (`E2B_API_KEY`). The default `base` template is used; tmux is
   installed on first `ensure` (it isn't pre-baked into `base`).

2. Wire the provider into the `SessionManager`:

   ```ts
   import { SessionManager } from "@termbridge/core";
   import { E2BSandboxProvider } from "@termbridge/sandbox-e2b";

   const manager = new SessionManager({
     sandboxProvider: new E2BSandboxProvider({ apiKey: process.env.E2B_API_KEY }),
   });
   const session = await manager.open({ env: "sandbox", cwd: "/root", cmd: "claude" });
   ```

3. Over MCP, `open_session` now accepts `env: "sandbox"`. If the server's manager
   has no `sandboxProvider` configured, it throws `sandbox_not_configured`.

## Live smoke (creds-gated)

```bash
E2B_API_KEY=... bun scripts/smoke-sandbox-e2b.ts
```

Without `E2B_API_KEY` the smoke no-ops and exits 0 (so `bun run test` stays green).
