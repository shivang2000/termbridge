# P1.1 — Live cloud SandboxProvider (E2B) (design)

## Context

The `SandboxProvider` interface and `SandboxEnvironment` class already ship (M6,
`packages/core/src/env/sandbox.ts`, ~30 unit tests passing against a mock provider).
One provider instance == one sandbox == one session; it issues tmux CLI through
`provider.exec` pinned to `-L termbridge`. **But `env: "sandbox"` is not selectable
today**: the default `SessionManager` `envFactory` throws `unknown environment "sandbox"`
(`manager.ts:274`) — there is no provider injection path — and the MCP `open_session`
enum is `z.enum(["local", "docker"])` (`tools.ts:49`). Goal: a concrete
`@termbridge/sandbox-e2b` package implementing `SandboxProvider` against the E2B SDK,
wired so `env: "sandbox"` is selectable end-to-end (SessionManager factory + MCP enum),
with a live cloud smoke (creds-gated). Decision (user-approved): **Approach A** —
`sandboxProvider` option on `SessionManagerOptions`.

## Decision — how the provider reaches the manager (Approach A)

Add `sandboxProvider?: SandboxProvider` to `SessionManagerOptions`. The default
`envFactory` constructs `new SandboxEnvironment({ provider })` for
`kind === "sandbox"`, and throws a new typed `SandboxProviderNotConfiguredError`
(code `sandbox_not_configured`) when `kind === "sandbox"` but no provider was
supplied. This is the turnkey, ROADMAP-aligned path; callers (server, mcp-server,
scripts) supply an `E2BSandboxProvider` from `@termbridge/sandbox-e2b` and pass it
to the manager. Core stays dependency-free (D3) — it only knows the
`SandboxProvider` interface, never imports the `e2b` SDK. Rejected alternatives:
(B) callers write a custom `envFactory` (not "selectable via the factory"; generic
throw); (C) auto-detect from `E2B_API_KEY` inside core (forces an `e2b` import into
core — violates D3).

## `@termbridge/sandbox-e2b` — the provider package

`E2BSandboxProvider implements SandboxProvider`:

```ts
export interface E2BSandboxProviderOptions {
  /** E2B API key. Defaults to E2B_API_KEY env. Required for a real cloud call. */
  apiKey?: string;
  /** E2B sandbox template (must have tmux installed). Defaults to "base". */
  template?: string;
  /** Sandbox lifetime in ms. Defaults to 3_600_000 (1h) — a coding session is long-lived. */
  timeoutMs?: number;
  /** Dedicated tmux socket name passed through to SandboxEnvironment. Defaults to "termbridge". */
  socket?: string;
  /**
   * Injectable sandbox factory (for tests). Defaults to the real E2B Sandbox.create.
   * Tests pass a fake that records calls and returns a mock sandbox — never touches the cloud.
   */
  sandboxFactory?: (opts: SandboxCreateOpts) => Promise<E2BSandboxLike>;
}
```

### `ensure(opts: { name; cwd; image?; env? })`

Provisions one E2B sandbox via `Sandbox.create({ template, envs: opts.env, apiKey,
timeoutMs, metadata: { name: opts.name } })` (the SDK's `Sandbox.create(opts?)` /
`Sandbox.create(template, opts?)`). Stores the live `Sandbox` instance. `image?`
maps to `template` (provider-selection vocabulary). **Note:** the E2B `base`
template does NOT ship tmux; the provider installs it on first `ensure` via
`commands.run("command -v tmux || (apt-get update && apt-get install -y tmux)")`
before `SandboxEnvironment.ensureSession` runs the tmux `new-session`. (A custom
termbridge E2B template with tmux pre-baked is a future optimisation; v1 installs
on demand so the default template works.)

### `exec(args: string[])`

Maps the argv to the SDK's `sandbox.commands.run(shellJoin(args), { timeoutMs })`.
**`commands.run` takes a shell command string, not an argv** — so each arg is
shell-quoted (single-quote-wrap args containing spaces or shell metacharacters;
this is safe for tmux CLI args + cwd paths). The SDK throws `CommandExitError` on
non-zero exit; the provider **catches it and extracts `{ exitCode, stdout, stderr }`**
(since `CommandExitError implements CommandResult`) — so `exec` returns
`{ stdout, stderr, code }` verbatim and **never rejects on non-zero exit**, matching
the `SandboxProvider` / `ExecFn` contract that `DockerEnvironment` and the tmux
helpers already honour. Genuine SDK errors (network, auth) propagate.

### `destroy()`

Best-effort: `Sandbox.kill(this.sandbox?.sandboxId)` (static), wrapped in
try/catch so destroy never throws (mirrors `SandboxEnvironment.destroySession`).

## SessionManager wiring

`SessionManagerOptions` gains:
```ts
/** A configured SandboxProvider. When set, env:"sandbox" selects SandboxEnvironment;
 *  when omitted, env:"sandbox" throws SandboxProviderNotConfiguredError. */
sandboxProvider?: SandboxProvider;
```
The default `envFactory`:
```ts
if (kind === "sandbox") {
  if (!sandboxProvider) throw new SandboxProviderNotConfiguredError();
  return new SandboxEnvironment({ provider: sandboxProvider, ...(socket ? { socket } : {}) });
}
```
`SandboxProviderNotConfiguredError` (code `sandbox_not_configured`) mirrors
`EnvNotAllowedError` — a typed, actionable error thrown **before** any slot is
reserved or sandbox spawned. Exported from `@termbridge/core`.

## MCP wiring

`open_session` enum: `z.enum(["local", "docker", "sandbox"])` (was
`z.enum(["local", "docker"])`). Description updated to mention the sandbox backend
requires a configured provider (the manager throws `sandbox_not_configured` if not).
The handler already echoes the ACTUAL env the manager selected (`tools.ts:72-73`), so
an env policy that coerces a sandbox request to docker (or vice versa) is reported
correctly — no handler change beyond the enum + description.

## Test strategy (all mocked — `bun run test` stays green with no creds)

- **`e2b-provider.test.ts`** (in `@termbridge/sandbox-e2b`): inject a fake
  `sandboxFactory` returning a mock sandbox that records `commands.run` calls and
  returns configurable `{ exitCode, stdout, stderr }`. Assert: `name === "e2b"`;
  `ensure` calls `Sandbox.create` with the right template/envs/apiKey; `exec`
  shell-joins + shell-quotes the argv; `exec` returns non-zero **as data, not a
  throw** (catches `CommandExitError`); `destroy` calls `Sandbox.kill` and swallows
  errors; `destroy` before `ensure` is a no-op (no sandbox yet).
- **`manager.test.ts`** additions: `env:"sandbox"` + configured `sandboxProvider` →
  `SandboxEnvironment` selected (kind reported back via `list()`); `env:"sandbox"` +
  no provider → `SandboxProviderNotConfiguredError` (code `sandbox_not_configured`)
  thrown **before** any slot is reserved (cap unaffected).
- **`tools.test.ts`**: `open_session` advertises the 3-value enum; `env:"sandbox"`
  round-trips through the (mock) manager. Verify no existing test asserts the old
  2-value enum exactly — update if found.
- **`scripts/smoke-sandbox-e2b.ts`**: the **live** cloud smoke — **creds-gated**:
  no-ops with a clear `"set E2B_API_KEY to run the live sandbox smoke"` message +
  exit 0 when `E2B_API_KEY` is unset (so CI / `bun run test` stays green without
  creds). When set: an MCP client opens a sandbox session, sends text, waits idle,
  reads the screen, closes it, and asserts the id lands in the manager's shared
  registry (mirrors `smoke-mcp-http.ts`).

## Docs

- `CHANGELOG.md` — Unreleased entry (sandbox provider + manager option + MCP enum).
- `docs/ROADMAP.md` — P1.1 → ✅ code / 🟡 live-cloud-smoke pending creds.
- `README.md` + `CONTRIBUTING.md` — smoke-table row for `smoke-sandbox-e2b.ts`.
- `docs/integration/sandbox.md` — provider selection + `E2B_API_KEY` setup (short).

## Non-goals (reaffirmed per ROADMAP)

- No multi-provider fan-out in v1 (E2B first; Daytona/Cloudflare are Phase 3 ports
  behind the same `SandboxProvider` interface).
- No `e2b` import in `@termbridge/core` (D3 — core stays dependency-free).
- `stdio` stays the zero-infra default; sandbox is opt-in.
