# Phase 2 CLI-adapter research: Codex CLI and OpenCode

> Primary-source snapshot: 2026-07-11. This brief covers upstream documentation,
> source, and generated schemas. It does not claim live compatibility until the
> proposed version-pinned spikes and conformance tests have run.

## Executive decision

Phase 2 should not treat terminal-screen recognition as the primary integration
surface for Codex or OpenCode. Both products expose a structured, first-party
control plane:

- Codex has `codex app-server`, a bidirectional JSONL protocol used by Codex
  clients, with typed lifecycle events, approvals, questions, plan updates,
  authentication, and rate-limit state.
- OpenCode's TUI is itself a client of an embedded HTTP server. The server
  publishes an OpenAPI document, an SSE event stream, session state, permission
  and question endpoints, and TUI-control endpoints.

The Termbridge adapter should therefore have two independent axes:

1. A **portable prompt protocol** for task instructions and Termbridge
   sentinels.
2. A **CLI-specific control plane** for lifecycle and interaction, preferring a
   native structured protocol and falling back to TUI capture only where no
   reliable native event exists.

This changes the Phase 2 risk profile. Codex and OpenCode support is still zero
in Termbridge today, but it need not begin by reverse-engineering two terminal
renderers. The highest-risk work becomes protocol/version compatibility,
approval-policy translation, concurrent human attachment, and preserving a
safe outer execution boundary.

## What is Claude-specific in Termbridge today

The existing coupling has two distinct layers:

- **Prompt-injected protocol, mostly portable.**
  [`buildEngineerPrompt`](../../packages/orchestrator/src/prompt.ts) asks the
  model to print `TB_ASK:`, `TB_LOOP_DONE:`, `TB_PR_URL:`, and
  `TB_BRANCH_READY:` markers. [`parseAsk`](../../packages/orchestrator/src/parse.ts)
  then reads those markers from output. An instruction-following CLI can use
  the same protocol, although a structured message or tool event should take
  precedence when available.
- **Terminal interaction, Claude-specific.**
  [`approveIfBlocked`](../../packages/orchestrator/src/approve.ts) waits for
  progress and sends Enter. The
  [`claude-permission` recognizer](../../packages/core/src/recognizers/claude-permission.ts)
  identifies Claude-specific tool, trust-folder, bypass, and paste prompts and
  suggests keystrokes; [`Session.checkAndApprove`](../../packages/core/src/session/session.ts)
  executes the suggestion. These semantics do not port safely to another CLI.

The distinction must be explicit in the Core v2 contract. A prompt marker is
model output; a permission request is a control-plane interaction. Neither an
idle terminal nor an `Enter` key is a valid universal substitute for the
latter.

## Capability matrix

| Capability | Codex | OpenCode | Termbridge consequence |
|---|---|---|---|
| Structured interactive control | App-server JSONL protocol | Embedded HTTP/OpenAPI server plus SSE | Native driver should be canonical |
| Human UI on the same engine | Remote TUI can attach to app-server; Unix socket is supported | TUI already hosts/uses the server; SDK clients can connect to the same fixed endpoint | Prototype concurrent ownership before committing to supervision UX |
| Headless task execution | `codex exec`; JSONL and output-schema options | `opencode run`; JSON event format and `--attach` | Useful for benchmarks, but neither headless path replaces the interactive broker |
| Permission interaction | Structured command/file approval server requests | Structured permission requests and replies | Preserve request IDs and native choice scopes |
| User questions | Structured `request_user_input` item/request | Question service with list/reply/reject and events | Model as a distinct interaction kind |
| Plan mode | Built-in collaboration mode; instruction-level mode should be paired with read-only sandbox | Built-in Plan agent and structured `plan_exit` question | One abstract plan gate, two different transitions |
| Review mode | First-class review start and entered/exited review items | No equivalent first-class reviewed-workflow contract found | Capability-negotiate rather than emulate silently |
| Activity/completion | Thread status, turn status, item lifecycle | Session status and SSE events | Completion must be explicit and separate from idle |
| OS containment | Read-only/workspace-write/danger-full-access sandbox modes | No OS containment was found in the server/tool execution path | OpenCode requires an outer Termbridge sandbox |
| Auth | ChatGPT login or API key; account and rate-limit state in app-server | Provider login/connect flows; local credential store | Auth state belongs in the adapter, secrets do not belong in task events |
| Schema/version handling | Generated schemas; stable/experimental distinction | Runtime OpenAPI document and generated SDK; current routes can move | Pin binary and schema hash; fail closed on unknown capability sets |

## Codex CLI

### Interactive safety model

Codex separates the approval policy from the execution sandbox. The current
[CLI reference](https://developers.openai.com/codex/cli/reference) documents
approval modes including `untrusted`, `on-request`, and `never`, and sandbox
modes including `read-only`, `workspace-write`, and `danger-full-access`.
OpenAI's [approval and security guidance](https://learn.chatgpt.com/docs/agent-approvals-security)
recommends combining policy and sandbox rather than treating either as a full
security decision. The [sandbox documentation](https://learn.chatgpt.com/docs/sandboxing)
describes OS-enforced local containment and notes that network access is off by
default in the constrained modes.

For Termbridge, the safe post-plan default is approximately
`workspace-write + on-request`, with a managed worktree as the writable root.
The full-bypass option must never be inferred from a user approving a plan; it
disables both approval checks and the Codex sandbox and is intended only when a
separate hardened environment already supplies containment.

### Plan, review, and mode transitions

Codex has a built-in Plan collaboration mode. Its upstream
[Plan template](https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/plan.md)
instructs the agent to investigate and propose a plan without implementing it,
and to return a delimited proposed plan. That is a behavioral instruction, not
an OS security boundary. Termbridge should launch or switch to Plan with a
`read-only` sandbox and should not grant `workspace-write` until the user has
approved the plan.

Review is also a native operation. The
[app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
defines review start plus entered/exited review items, while the TUI exposes the
same concept through `/review`. An adapter should expose `review` as a
capability and preserve the native review lifecycle instead of trying to infer
it from prose.

### Preferred machine interface: app-server

The [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
and upstream [protocol README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
describe a bidirectional, JSON-RPC-style protocol transported as one JSON value
per line over stdio. A Unix socket is also available; WebSocket transport is
experimental and should not be a Phase 2 dependency.

The protocol has the primitives Termbridge needs:

- Threads, turns, and items carry stable native identifiers.
- `turn/started`, item lifecycle notifications, and `turn/completed` distinguish
  execution from terminal silence. Completion has completed, interrupted, and
  failed outcomes.
- Thread status distinguishes active, idle, not-loaded, and error states.
- Command and file-change approvals arrive as server-initiated requests. The
  response vocabulary retains choices such as accept once, accept for the
  session, decline, cancel, and command amendments.
- User questions, permission requests, and MCP elicitations are structured
  interactions rather than terminal prompts.
- Plan updates, account changes, and rate-limit updates are events.

The protocol can generate TypeScript and JSON schemas for the installed Codex
version. It also distinguishes stable from experimental fields and rejects
experimental calls unless a client opts in. Termbridge should use the stable
subset for its launch gate and store the generated schema hash in its adapter
compatibility manifest.

The CLI supports attaching a TUI to a remote app-server. A Phase 2 spike should
test a Unix-socket topology in which Termbridge owns the structured connection
and a human attaches the regular Codex UI to the same server. The protocol
supports multiple subscribers, but the spike must establish which client owns
an outstanding approval, what happens when either disconnects, and whether
events remain totally ordered for reconciliation.

### Headless interface

[`codex exec`](https://developers.openai.com/codex/noninteractive) supports
non-interactive execution, JSONL output, resumable sessions, and an output JSON
schema. It is valuable for benchmark fixtures and evidence capture. It is not
the preferred Local supervision path: its current
[`exec` implementation](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs)
defaults to an approval policy that cannot conduct an interactive approval
round trip. A task that needs plan approval, a permission decision, or a user
answer belongs on app-server.

### Authentication and quota state

Codex supports both ChatGPT subscription login and API-key login. The official
[authentication guide](https://developers.openai.com/codex/auth) covers browser
and device-code flows. App-server exposes login start/cancel state, account
updates, plan type, and rate-limit reads/notifications. That supports a real
`auth.changed` and `quota.changed` adapter event without scraping a banner.

Credentials and browser-login artifacts must remain outside persisted task
events and diagnostic bundles. Termbridge should persist only a redacted auth
state such as `signed_out`, `pending`, `signed_in`, or `expired`, plus provider
and plan metadata that the upstream protocol explicitly marks safe to expose.

### Codex drift risks

- App-server is a more appropriate integration contract than the TUI, but the
  whole surface is not promised immutable. Termbridge must distinguish the
  documented stable subset from experimental methods and fields.
- Schemas are generated for a particular binary. Compatibility should be
  keyed by Codex version plus schema hash, not by a handwritten set of regexes.
- Plan behavior is partly prompt-defined. A Codex update can change the plan
  template without changing terminal chrome; golden protocol traces should
  include the plan transition and attempted-write denial.
- Remote TUI attachment and multi-client approval ownership require live proof
  before they become a product guarantee.

## OpenCode

### Architecture: the TUI already has a server

OpenCode's official [server documentation](https://opencode.ai/docs/server/)
states that the TUI runs a client and server and that the server supports
multiple clients. `opencode serve` runs the same server headlessly, publishes an
OpenAPI 3.1 document at `/doc`, and exposes an SSE stream at `/event`. The
official [SDK](https://opencode.ai/docs/sdk/) is generated from that OpenAPI
surface.

This makes the native topology straightforward, with one important detail:
starting a separate `opencode serve` process next to a TUI creates a separate
server. For a human and Termbridge to share a session, Phase 2 should either:

1. start the TUI with a fixed loopback host and port and connect the SDK to that
   embedded server, or
2. start the server once and use `opencode attach` for the human UI.

The server defaults to loopback. If exposed beyond a private execution
namespace it must use the documented HTTP Basic authentication environment
variables, and Termbridge must treat that password as a secret. Non-loopback
exposure is unnecessary for Local.

The HTTP API already includes session creation/status, synchronous and
asynchronous prompts, abort, agent selection, permission replies, pending
questions, question reply/reject, SSE events, and TUI-control endpoints. The
adapter should use these rather than typing into the TUI.

### Permission model is not an OS sandbox

OpenCode permissions are rules with `allow`, `ask`, and `deny` outcomes. The
official [permissions documentation](https://opencode.ai/docs/permissions/)
describes granular tool/pattern rules and user choices such as approving once,
approving matching work for the session, or rejecting. The upstream
[`Permission` service](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/permission/index.ts)
assigns request IDs, emits request/reply events, and waits for a response.

No OS-level containment was found in the corresponding execution path. In
particular, the upstream
[`bash` tool](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/bash.ts)
checks the application permission rules and then spawns a shell with the host
working directory and environment. This is an inference from the current
source, not a claim that OpenCode can never add containment later. For the
current Phase 2 design, OpenCode permissions are policy gating, not a security
boundary. Local must run it inside Termbridge's Docker/cloud sandbox or another
explicit outer containment layer.

### Plan is a workflow mode, not guaranteed read-only execution

OpenCode's [agents documentation](https://opencode.ai/docs/agents/) describes
the built-in Build and Plan agents and switching between them. Current upstream
[`agent.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/agent/agent.ts)
denies edit tools for Plan except its plan artifact, but it does not deny bash.
Because the default permission baseline permits tools unless overridden, a
shell command can still mutate files while Plan is active.

This corrects the shorthand that OpenCode Plan is simply "read-only." To make
the Termbridge plan gate real, the adapter must combine all of the following:

- select the native `plan` agent;
- apply an effective permission override that denies bash and other mutation
  escape hatches during planning; and
- keep the outer worktree/environment read-only until approval.

The mode transition itself is unusually useful. Upstream
[`plan_exit`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/plan.ts)
raises a structured question asking whether to switch to Build. A Yes response
injects the Build-agent continuation. The
[`Question` service](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/question/index.ts)
publishes asked/replied/rejected events, and the
[`question` routes](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/question.ts)
allow a client to list and resolve pending questions. Termbridge should map
this specific structured interaction to `plan_approval`; it should not detect a
banner and press Tab.

### Headless and standardized alternatives

The official [CLI documentation](https://opencode.ai/docs/cli/) exposes
`opencode run --format json`, agent selection, session continuation, and
`--attach`. This is useful for deterministic event capture. The current
[`run` implementation](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts)
rejects permission requests automatically unless auto-approval is enabled, in
which case it approves individual requests. It does not provide the same
question-broker loop. A native Plan-to-Build question can therefore stall or
be mishandled in a pure `run` integration. Use the server/SDK for supervised
Local tasks.

OpenCode also implements [ACP](https://opencode.ai/docs/acp/), a JSON-RPC stdio
protocol intended for editor/agent integrations and covering agents and
permissions. ACP is worth retaining as a portability fallback and possible
future common driver. The native HTTP/SSE path is the Phase 2 preference because
it exposes OpenCode's exact question, session, and co-present TUI behavior.

### Authentication

The [provider documentation](https://opencode.ai/docs/providers) documents the
interactive `/connect` flow, `opencode auth login`, browser OAuth for supported
providers, and ChatGPT Plus/Pro access for the OpenAI provider. Credentials are
stored in the user's OpenCode data directory. Termbridge should invoke and
observe the native auth flow, record only redacted state, and explicitly omit
credential files and environment values from checkpoints and diagnostics.

### OpenCode drift risks

- The public server exposes its running version and live `/doc` schema, while
  upstream SDK types track the evolving implementation. A checked-in client
  alone is not evidence that an arbitrary installed binary is compatible.
- Event names and payloads can change across versions. The adapter should bind
  to the runtime OpenAPI schema and keep golden SSE traces for each supported
  binary range.
- There is no stable/experimental negotiation as explicit as Codex's. Unknown
  schema hashes should fail closed for permission automation and fall back to
  human control or a supported binary.
- Auto-approval changes permission handling but does not constitute sandboxing
  and does not resolve the distinct question/plan-approval channel.

## Proposed Termbridge adapter boundary

`CliAdapter` should be a capability-negotiated agent adapter, not a collection
of recognizer regexes. The prompt and driver contracts should be independently
replaceable:

```ts
interface PromptProtocol {
  buildTaskPrompt(input: TaskInput): string;
  parsePortableMarker(output: OutputChunk): PromptMarker | undefined;
}

interface CliDriver {
  readonly id: "claude-code" | "codex" | "opencode";
  discover(): Promise<AdapterFingerprint>;
  launch(input: LaunchInput): Promise<NativeSession>;
  attach(session: NativeSession): AsyncIterable<AdapterEvent>;
  sendPrompt(session: NativeSession, prompt: string): Promise<NativeTurnId>;
  respond(session: NativeSession, request: InteractionResponse): Promise<void>;
  setMode(session: NativeSession, mode: "plan" | "build" | "review"): Promise<void>;
  interrupt(session: NativeSession): Promise<void>;
  reconcile(checkpoint: AdapterCheckpoint): Promise<ReconcileResult>;
}

interface AdapterFingerprint {
  binaryVersion: string;
  transport: "jsonl" | "http-sse" | "acp" | "tmux-screen";
  schemaHash?: string;
  supportedRange: string;
  capabilities: AdapterCapabilities;
}
```

The current screen recognizers remain useful as a `tmux-screen` fallback,
bootstrap aid, and drift alarm. They should not silently take control when a
native driver reports an unsupported schema. Unsupported structured protocols
must degrade to explicit human takeover or a separately tested screen-driver
version.

## Canonical event and interaction mapping

Core v2 needs a richer contract than the current roadmap's broad `prompt`,
`takeover`, and `rate-limit` labels.

| Termbridge event | Codex source | OpenCode source |
|---|---|---|
| `run.started` | turn started | session/message start |
| `run.progress` | item started/delta/completed | message-part and session events |
| `run.idle` | thread status idle | session status/idle |
| `run.completed` | turn completed with completed outcome | assistant/session completion event plus verified terminal state |
| `run.failed` | failed/interrupted turn outcome | session error/abort event |
| `interaction.requested` | server approval, question, or permission request | permission or question asked event |
| `interaction.resolved` | request response/resolved event | permission/question reply or reject event |
| `mode.changed` | collaboration/review transition | selected agent and plan-exit transition |
| `auth.changed` | account/login update | auth/provider state observed through supported flow |
| `quota.changed` | native rate-limit update | capability absent unless a provider exposes reliable state |

Every mapped event should include:

- Termbridge task/session/event IDs and a monotonic Termbridge sequence;
- native session, turn, item, and request IDs where present;
- adapter ID, binary version, transport, and schema hash;
- a normalized kind and state;
- an optional redacted native payload for diagnostics; and
- checkpoint/replay metadata that says whether the event is observed,
  requested, resolved, or uncertain.

`idle` is not `completed`. A permission request, plan question, retry backoff,
auth flow, or network wait can all produce a quiet terminal or an idle-like
state without completing the task.

Interactions should retain native semantics:

```ts
interface InteractionRequest {
  id: string;
  nativeRequestId: string;
  kind: "permission" | "question" | "plan_approval" | "auth" | "rate_limit";
  scopeOptions: Array<"once" | "session" | "persistent">;
  choices: Array<{ id: string; label: string }>;
  commandAmendmentSupported?: boolean;
  expiresAt?: string;
}
```

Termbridge policy may narrow the available choices, but the adapter must not
invent equivalence. Codex's session approval, OpenCode's matching-rule approval,
and a persistent provider permission can have different reach. An unresolved
interaction must never be recovered by replaying Enter.

## Plan-approval flows

### Codex

1. Launch app-server with a version/schema combination in the compatibility
   manifest.
2. Start the task in Plan collaboration mode and a read-only sandbox.
3. Stream plan/item events and portable task markers.
4. Present the proposed plan to the user and persist the exact native turn/item
   references.
5. On explicit approval, checkpoint the decision, change to Default/build mode,
   and start a new turn with `workspace-write + on-request` in the managed
   worktree.
6. Never replay the mode/permission transition if its outcome is uncertain;
   reconcile native thread and turn state first.

### OpenCode

1. Launch one fixed loopback server/TUI endpoint and verify its version and
   `/doc` schema.
2. Select the Plan agent, deny bash/mutation tools, and enforce an outer
   read-only environment.
3. Observe the structured `plan_exit` question and associate its request ID
   with the plan artifact/message.
4. Present the plan. On explicit approval, checkpoint the decision and reply Yes
   to that exact question, allowing OpenCode's native transition to Build.
5. Make the worktree writable and apply the post-plan permission policy.
6. On rejection, reply No or reject the exact question and keep the task in a
   planning/revision state; never press Tab as a substitute.

## Security consequences

- Bind native control servers to loopback or a private sandbox namespace.
- Use Unix sockets for Codex Local where the live spike validates them; use
  authenticated loopback HTTP for OpenCode.
- Treat native event payloads as untrusted and potentially secret-bearing.
  Redaction must occur before persistence, logs, SSE fan-out, telemetry, and
  diagnostic capture.
- Never persist auth tokens, provider credential files, raw process
  environments, or pasted secrets. Persist only minimal auth/capability state.
- Keep the Termbridge managed worktree as the only intended writable project
  root. Codex should additionally use its OS sandbox. OpenCode must use an outer
  Docker/cloud/OS sandbox because its permission engine is not containment.
- Sensitive actions remain Termbridge policy decisions even if the CLI offers
  an `always` or `acceptForSession` response. The adapter may reduce upstream
  authority; it may not broaden the user's Termbridge grant.

## Compatibility and benchmark gate

For each supported CLI release, generate an adapter manifest containing:

- CLI binary and build version;
- native transport and schema/OpenAPI hash;
- supported Termbridge adapter version;
- stable and experimental capability bits;
- required launch flags and effective sandbox/permission policy;
- golden lifecycle, permission, question, plan, interruption, auth-expiry, and
  rate-limit traces; and
- fallback screen-fixture version, if a fallback is supported.

Use a canary lane for the latest upstream release, but do not auto-expand the
supported version range because a screen fixture still looks similar. Unknown
schemas should disable autonomous approvals and present an actionable upgrade,
downgrade, or takeover path.

The Phase 2 stable-release gate should measure the native and fallback paths
separately. For each supported CLI/version/environment combination, run each
benchmark task multiple times and report:

- task completion and acceptance-test success;
- correct plan gate and rejection behavior;
- zero unapproved mutations during Plan;
- permission/question resolution by exact native request ID;
- restart reconciliation without replay of uncertain actions;
- human attach/takeover and return-to-agent behavior;
- evidence completeness; and
- protocol drift or fallback activation.

A single aggregate 90% number can hide a broken security invariant. Completion
rate may use the roadmap's threshold, but plan-gate bypass, unauthorized writes,
wrong-request approval, secret leakage, and uncertain-action replay must be
zero-tolerance failures.

## Roadmap-ready recommendations

1. **Expand the Phase 1 event contract before freezing it.** Add distinct
   lifecycle, interaction, mode, auth, and quota events; retain native IDs,
   adapter fingerprints, and uncertain-recovery state.
2. **Split `PromptProtocol` from `CliDriver`.** Keep `TB_*` markers as a portable
   compatibility protocol, while making native structured events authoritative
   for permission, question, plan, activity, completion, auth, and rate limits.
3. **Make structured drivers the launch path.** Use Codex app-server over
   stdio/Unix socket and OpenCode HTTP/OpenAPI/SSE. Keep tmux recognizers as a
   separately versioned fallback, not the adapter definition.
4. **Make Plan an enforced compound policy.** Codex Plan must pair with
   read-only sandboxing. OpenCode Plan must deny bash/mutation tools and run in
   an outer read-only sandbox until approval.
5. **Add two pre-contract live spikes.** Validate Codex app-server plus remote
   TUI multi-client ownership, and OpenCode embedded-server plus TUI/SDK
   co-presence. Record disconnect, outstanding-request, ordering, and resume
   behavior.
6. **Version the protocol, not only the screen.** Store binary version plus
   schema hash and capability bits; generate clients/fixtures from the exact
   supported release and fail closed on drift.
7. **Use headless modes for benchmarks, not as the universal Local driver.**
   `codex exec` and `opencode run` are useful evidence paths but have different
   or incomplete approval/question behavior.
8. **Strengthen the release gate.** Measure N runs per fixture/CLI/version with
   cost and time budgets, but make security invariants zero-tolerance rather
   than averaging them into the 90% completion target.

## Primary sources

### Codex

- [CLI reference](https://developers.openai.com/codex/cli/reference)
- [Authentication](https://developers.openai.com/codex/auth)
- [Non-interactive execution](https://developers.openai.com/codex/noninteractive)
- [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [Sandboxing](https://learn.chatgpt.com/docs/sandboxing)
- [App-server documentation](https://learn.chatgpt.com/docs/app-server)
- [App-server protocol source documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)
- [Plan collaboration-mode template](https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/plan.md)
- [`codex exec` source](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs)
- [TUI chat-widget source](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget.rs)

### OpenCode

- [Server](https://opencode.ai/docs/server/)
- [CLI](https://opencode.ai/docs/cli/)
- [Permissions](https://opencode.ai/docs/permissions/)
- [Agents](https://opencode.ai/docs/agents/)
- [SDK](https://opencode.ai/docs/sdk/)
- [ACP](https://opencode.ai/docs/acp/)
- [Providers and authentication](https://opencode.ai/docs/providers)
- [Built-in agent definitions](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/agent/agent.ts)
- [Plan-exit tool](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/plan.ts)
- [Permission service](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/permission/index.ts)
- [Question service](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/question/index.ts)
- [Question routes](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/question.ts)
- [Bash tool](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/bash.ts)
- [Generated SDK types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts)
- [`opencode run` source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts)
