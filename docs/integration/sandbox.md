# Sandbox providers (cloud)

termbridge runs tmux **inside** a cloud sandbox via the pluggable `SandboxProvider`
interface (D4). Core stays SDK-free; each provider is its own package.

| Package | Backend | Status | Get keys |
|---|---|---|---|
| `@termbridge/sandbox-e2b` | [E2B](https://e2b.dev) | ✅ live smoke proven; auto-wire with `E2B_API_KEY` | [e2b.dev/dashboard](https://e2b.dev/dashboard) |
| `@termbridge/sandbox-daytona` | [Daytona](https://www.daytona.io) | ✅ unit-tested; inject `DaytonaClient` (map your SDK) | [app.daytona.io](https://app.daytona.io) |
| `@termbridge/sandbox-cloudflare` | Cloudflare sandboxes | ✅ unit-tested; inject `CloudflareSandboxClient` | [API tokens](https://dash.cloudflare.com/profile/api-tokens) |

Copy `.env.example` → `.env` and fill keys (`.env` is gitignored).

## Shared contract

```ts
interface SandboxProvider {
  readonly name: string;
  ensure(opts: { name; cwd; image?; env? }): Promise<void>;
  exec(args: string[]): Promise<ExecResult>; // never rejects on non-zero
  destroy(): Promise<void>; // never throws
}
```

Wire into the manager:

```ts
const manager = new SessionManager({
  sandboxProvider: new E2BSandboxProvider({ /* or Daytona / Cloudflare */ }),
});
await manager.open({ env: "sandbox", cwd: "/home/user", cmd: "claude" });
```

## Daytona / Cloudflare clients

Those packages do **not** hard-depend on vendor SDKs (keeps CI green without credentials).
Implement the small client interface with your SDK of choice:

```ts
import { DaytonaSandboxProvider, type DaytonaClient } from "@termbridge/sandbox-daytona";

const client: DaytonaClient = {
  async create({ name, cwd, env }) { /* SDK create workspace */ return { id }; },
  async exec(id, cmd) { /* SDK run shell */ return { exitCode, stdout, stderr }; },
  async destroy(id) { /* SDK delete */ },
};
const provider = new DaytonaSandboxProvider({ client });
```

Same shape for `CloudflareSandboxClient`.

## Live smokes (creds-gated; always destroy)

```bash
# all providers (loads .env)
bun --env-file=.env scripts/smoke-sandbox-all.ts

# individual
bun --env-file=.env scripts/smoke-sandbox-e2b.ts
bun --env-file=.env scripts/smoke-sandbox-daytona.ts
bun --env-file=.env scripts/smoke-sandbox-cloudflare.ts
```

| Smoke | What it proves | Cleanup |
|---|---|---|
| E2B | open + drive + registry + kill | `provider.destroy` + list verify 0 |
| Daytona | open + drive + registry + kill (ephemeral sandbox) | `provider.destroy` → SDK `delete` |
| Cloudflare | full create/exec/destroy via control Worker | `provider.destroy` → Worker `/destroy` |

### Cloudflare Containers setup

1. **Workers Paid plan** (required): https://dash.cloudflare.com/?to=/:account/workers/plans
2. Token: **Edit Cloudflare Workers** (+ Cloudchamber Edit if needed).
3. Docker running.
4. `bun --env-file=.env scripts/deploy-cloudflare-sandbox.ts`
5. `bun --env-file=.env scripts/smoke-sandbox-cloudflare.ts`

Without the relevant env keys each smoke no-ops and exits 0.
