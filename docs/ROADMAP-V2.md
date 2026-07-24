# Termbridge Product-Family Roadmap V2

> **Status:** Canonical roadmap, Autonomous Local revision approved 2026-07-25
> **Evidence snapshot:** 2026-07-11 at `0a4afc15811b`
> **Owner:** Termbridge maintainer
> **Review cadence:** At every stable release and at least monthly while a phase is active

## 1. Document Authority

This is the source of truth for Termbridge product scope, sequencing, release gates, and support policy.
It replaces `docs/ROADMAP.md` as the forward roadmap and replaces `docs/PLAN.md` as the current product
plan. Those documents remain historical records until Phase 0 marks them as superseded.

Architecture decisions continue to live in `docs/DECISIONS.md`. Until Phase 0 consolidates that file,
the V2 decisions in this roadmap explicitly supersede conflicting earlier decisions:

- **D3 is amended:** the canonical contract is a shared application/domain service. Versioned HTTP is
  the primary general-purpose external API; MCP remains a supported sibling adapter over the same
  service and schemas.
- **D8 is narrowed:** Termbridge Core remains a substrate, not an orchestrator. Termbridge Local and
  Termbridge Platform may orchestrate coding tasks above Core.

Historical specifications and research remain evidence, not current scope authority. A stable release
may not silently waive this roadmap. Any scope or gate change requires a dated ADR and an update here.

## 2. Executive Outcome

Termbridge will become an MIT-licensed product family for safely supervising coding agents that operate
through subscription-authenticated CLIs or API-backed agents. Its first complete product is an
open-source, single-user Local daemon that turns configured Jira or Linear workflow-state changes into
fully tested GitHub draft pull requests after exact-plan human approval. The later Platform product adds
shared organizational operation without changing Local's contracts or making Local depend on Platform.

### Product family

| Offering | Primary user | Job to be done | Product boundary | Stable means |
|---|---|---|---|---|
| **Termbridge Core** | Tool and agent developers | Create, observe, drive, and recover terminal-backed execution safely | Domain contracts, sessions, events, environments, storage ports, policy hooks, SDK, HTTP, and MCP | Versioned contracts, durable recovery, transport parity, environment conformance, and secret-safe events |
| **Termbridge Local** | One developer on one machine | Move a Jira or Linear issue into a configured state, approve the generated plan, and receive a tested and optionally independently reviewed GitHub draft PR | Loopback daemon, SQLite, tracker gateway, Claude Code/OpenCode drivers, managed worktrees, verification/review, GitHub App draft delivery | Both trackers and both required CLIs pass deterministic, live-provider, fault, security, benchmark, and four-week pilot gates |
| **Termbridge Platform** | One self-hosted organization | Share the proven Local workflow across users, projects, queues, and workers | OIDC, project authorization, queue/scheduler, workers, Postgres, immutable audit, and organization policy | Recovery-safe scheduling, tenant isolation, complete audit, security review, and a controlled team pilot |

Each offering must be independently adoptable. Core cannot depend on Local or Platform. Local and
Platform share Core contracts but have different authentication, storage, deployment, and threat models.

### Product principles

1. **Human authority is explicit.** Plan approval does not imply credential use, destructive actions,
   publishing, pushing, merging, or persistent permission grants.
2. **Uncertainty pauses.** If Termbridge cannot prove whether a non-idempotent effect occurred, it does
   not replay it.
3. **The database owns task truth.** tmux, containers, processes, worktrees, and provider leases are
   recoverable runtime bindings, not public identity or the authoritative registry.
4. **Structured control beats screen scraping.** Native, versioned CLI protocols are preferred. TUI
   recognizers remain explicit, version-pinned fallbacks and drift alarms.
5. **Containment is not a prompt policy.** Untrusted work runs in Docker, a cloud sandbox, or an
   equivalent OS-enforced boundary.
6. **Secrets are minimized before they are redacted.** Credentials are resolved at execution or
   delivery boundaries and are excluded from normal task events.
7. **Evidence binds delivery.** Local succeeds only when the open draft PR head equals the exact
   verified and, when required, independently reviewed candidate SHA.
8. **Provider-policy compliance is mandatory.** Termbridge never rotates accounts, evades rate limits,
   or implements detection-evasion.

### Non-goals through Autonomous Local V1

- General-purpose project management, chat, billing, or enterprise identity federation.
- Multi-user/team operation, OIDC, distributed workers, Postgres operation, or managed hosting.
- Marking a pull request ready, approving it as a human, merging, bypassing policy, or deploying.
- A bespoke terminal multiplexing protocol replacing tmux.
- Treating CLI permissions, blocklists, or an advisory write lock as a security sandbox.
- Supporting arbitrary unpinned CLI versions on a best-effort basis.
- Codex stable support in the first Autonomous Local release.

## 3. Verified Baseline

This section is a dated evidence snapshot, not a hand-maintained release manifest. Phase 0 replaces it
with generated status artifacts and makes drift a CI failure.

### Quality snapshot

| Check | Verified result |
|---|---|
| Core tests | 517 passing, 26 files, 1,269 expectations |
| Repository tests | 754 passing, 49 files, 1,811 expectations |
| Orchestrator + MCP server + unified server | 200 passing tests |
| Typecheck | 8 of 8 packages clean |
| Lint | Passes with 3 warnings and 2 informational diagnostics |
| Known lint debt | Unused Core imports, one MCP-server explicit `any`, one orchestrator optional-chaining diagnostic, and two Core string-template style diagnostics |

README, changelog, and the old roadmap still contain the stale `~900` test count. Generated evidence
must distinguish package counts from the repository total and record the command, Git SHA, timestamp,
tool versions, and exit status.

### Package snapshot

| Package group | Source version | Current classification |
|---|---:|---|
| `core`, `mcp-server`, `server`, `orchestrator`, `claude-code-plugin` | `1.0.7` | Released family |
| `sandbox-e2b` | `1.0.10` | Released independently; live lifecycle proven |
| `sandbox-daytona` | `0.1.0` | Experimental; injectable client and unit tests, live validation incomplete |
| `sandbox-cloudflare` | `0.1.0` | Experimental; control Worker and unit tests, live validation incomplete |

The README says v1.0.4, the old roadmap says v1.0.7, the changelog mixes released and unreleased Phase
3 work, and E2B has advanced independently. This is process drift, not a single typo.

### Capability snapshot

| Capability | Reality at the snapshot |
|---|---|
| MCP stdio and Streamable HTTP | Implemented and tested |
| Direct HTTP tool dispatch and browser supervision | Implemented over a shared process-local manager |
| tmux survival and manual adoption | `SessionManager.recover()` can adopt surviving sessions, but it is not wired to durable task recovery and is called only by tests |
| Human/agent arbitration | Advisory TTL write lock; not a security or transactional lock |
| Recognizers | Claude-specific permission/activity recognizers plus generic marker, OAuth, and rate-limit recognition |
| Engineering loop | Prompt markers and `ToolCall` abstraction exist; approval and completion logic is Claude-shaped |
| Delivery | Pluggable strategies exist, but the driven CLI currently performs branch/commit/push/PR work inside the session |
| Local and Docker environments | Implemented |
| E2B | Live-proven |
| Daytona and Cloudflare | Foundation implemented; not live-validated for stable support |
| Direct Claude Code adapter | Existing behavior, but not yet separated from Core or governed by a V2 conformance contract |
| Direct Codex adapter | None |
| Direct OpenCode adapter | None; the current integration document makes OpenCode an outer MCP client that pilots Claude |
| Durable task/checkpoint/event history | None |
| Managed worktrees | None |
| Cross-cutting secret redaction | None |
| Versioned real-repository benchmark | None |

### Immediate correctness and product risks

- Core is not yet provider-neutral: it provisions Claude credentials, installs Claude recognizers, and
  forwards `GH_TOKEN`/`GH_HOST` into sessions.
- `sendText` crosses two effect boundaries—literal text and Enter—without a durable operation record.
- Recovery currently adopts by tmux name and reconstructs fresh in-memory observer, event, lock, and
  approval state.
- The current HTTP tool route derives behavior from MCP tool specifications; schema ownership must move
  into a shared service before HTTP is treated as the primary general-purpose API.
- URL bearer tokens and startup token printing are acceptable only as transitional single-user behavior;
  V2 Local must use a one-time loopback bootstrap exchange and secure cookie.
- Subscription-backed CLI automation remains exposed to provider policy changes and account suspension.

## 4. Target Product and Package Architecture

```text
                         Termbridge Local                 Termbridge Platform
                 daemon + trackers + GitHub          API + queue + workers + OIDC
                                  \                         /
                                   \                       /
                            application/domain services
                  tasks · sessions · policy · evidence · delivery
                         /              |               \
                 HTTP + SSE        MCP adapter       TypeScript SDK
                         \              |               /
                    durable repositories + operation journal
                              /                   \
                       SQLite Local           Postgres Platform (later)
                              \                   /
                       execution environments and runtime bindings
                    Local · Docker · E2B · Daytona · Cloudflare
                                      |
                     PromptProtocol + capability-negotiated CliDriver
                     native protocols first · tmux-screen fallback
```

### Layer responsibilities

1. **Control-plane domain** (`@termbridge/control-plane`) owns public IDs, state machines, events,
   operation uncertainty, repositories, leases, checkpoints, capabilities, errors, and redaction hooks.
   **Core** (`@termbridge/core`) remains the provider-neutral substrate: terminal, environment, and
   session primitives plus environment contracts. Neither contains Claude-specific authentication,
   recognizers, Local cookies, OIDC types, or tracker logic. `control-plane` cannot import provider
   packages, `server`, `mcp-server`, or browser code.
2. **Application services** authorize and execute commands against Core. They are the only canonical
   command implementation. HTTP, MCP, SDKs, Local, and Platform call them in-process where possible.
3. **Transport adapters** own version negotiation and serialization. Application events use SSE with
   resumable cursors. WebSocket remains for live terminal bytes and interactive browser attachment.
4. **CLI adapters** separate portable task prompting from CLI-specific lifecycle and interaction.
   OpenCode should use its HTTP/OpenAPI/SSE server; Claude Code uses the strongest supported structured
   surface with a versioned screen driver where necessary. Codex is deferred from the first stable
   matrix. Claude-specific behavior moves out of Core.
5. **Execution environments** own process/tmux/container/sandbox lifecycle and declared capabilities.
   They do not own task truth.
6. **Local** owns loopback bootstrap, browser sessions, onboarding, one-user policy, SQLite, tracker
   installations, worktrees, verification/review, secrets, and GitHub draft delivery.
7. **Platform** later owns OIDC, organization/project authorization, queues, worker leases, Postgres,
   immutable audit administration, and shared-worker isolation.

### Required migration from V1

- Extract Claude authentication and Claude recognizers from `@termbridge/core` into a versioned adapter.
- Stop automatically forwarding forge credentials into coding sessions; move branch push and draft-PR
  creation to a host-side delivery service. Do not expose merge in Local V1.
- Move tool schemas and validation out of MCP-specific definitions into shared command contracts.
- Replace process-local task identity with opaque durable IDs and tagged runtime bindings.
- Preserve the current 13 MCP tools through a compatibility adapter and golden contract fixtures.
- Retain tmux as the shared terminal substrate and restart-survival asset, while removing name-based
  automatic adoption.

## 5. V2 Decision Register

Phase 0 must copy these decisions into `docs/DECISIONS.md` with accepted status and their migration
consequences.

| ID | Decision | Consequence |
|---|---|---|
| V2-D1 | One layered monorepo with independently releasable Core, Local, and Platform offerings | Extraction remains possible if ownership or release cadence diverges |
| V2-D2 | Shared application/domain contracts are canonical; HTTP and MCP are sibling adapters | No duplicated business logic and no required MCP-to-HTTP network hop |
| V2-D3 | SSE is the application event transport; WebSocket is reserved for live terminal/browser attachment | Event replay and terminal streaming have distinct semantics |
| V2-D4 | The database is authoritative; tmux and provider sessions are runtime bindings | Unknown runtime sessions are inventoried or quarantined, never blindly adopted |
| V2-D5 | Effects use a durable operation journal with `prepared`, `dispatched`, `confirmed`, and `uncertain` states | Uncertain terminal, Git, push, PR, merge, publish, or cleanup operations pause |
| V2-D6 | SQLite and Postgres implement the same repository, checkpoint, event, lease, worktree, and delivery contracts | Local and Platform share behavior rather than only TypeScript types |
| V2-D7 | Native structured CLI protocols are preferred; TUI recognition is a versioned fallback | Compatibility is keyed by binary version, schema hash, capabilities, and fixtures |
| V2-D8 | Every coding task uses a locked, uniquely owned managed worktree | Dirty or failed work survives until explicit cleanup |
| V2-D9 | Git and forge delivery execute in the host control plane after evidence review | Coding CLIs never receive tracker or GitHub App credentials |
| V2-D10 | Redaction occurs before persistence and again at every egress | A single canary-secret leak blocks release |
| V2-D11 | Local and Platform are distinct security products sharing Core contracts | A non-loopback bind cannot turn Local into team mode |
| V2-D12 | Autonomous Local stable requires Claude Code and OpenCode on exact supported versions; Codex is deferred | Each required driver passes its own benchmark and live tracker matrix |
| V2-D13 | Jira Cloud and Linear are mandatory Local tracker adapters; GitHub App draft delivery is mandatory | Platform is not a prerequisite for issue-to-PR automation |
| V2-D14 | A verified human approves the exact plan, issue snapshot, base SHA, and policy version before any writable workspace exists | Material changes invalidate approval and force replanning |
| V2-D15 | Polling and reconciliation are the tracker correctness baseline; signed webhooks are acceleration | A local daemon remains correct without permanent public ingress |
| V2-D16 | `DRAFT_PR_READY_FOR_HUMAN` is the only successful autonomous terminal state | Ready, approve, merge, bypass, and deploy operations are absent from Local V1 contracts |
| V2-D17 | Independent automated review is project-configurable and budgeted | A required review pauses rather than being silently skipped |

## 6. Canonical Contracts

These contracts are roadmap-level invariants. Phase specifications will define exact TypeScript and wire
schemas without changing the semantics below.

### Task lifecycle

The normal Autonomous Local path is:

```text
discovered → validating → planning → awaiting_plan_approval
           → preparing_workspace → implementing → verifying
           → automated_review → delivering_draft_pr
           → awaiting_github_checks → draft_pr_ready_for_human
```

- Applicable non-terminal states may enter `awaiting_human_input`, `replan_required`, `paused_budget`,
  `paused_policy`, `paused_auth`, `paused_uncertain_operation`, `failed`, or `cancelled` through an
  explicit transition.
- Every paused state stores the prior state and a machine-readable reason; resume returns only to a
  validated next state after reconciliation.
- A task may not enter `preparing_workspace` without durable human approval tied to the exact plan hash,
  issue snapshot hash, base SHA, policy version, verified actor, and expiration.
- `draft_pr_ready_for_human` requires an open draft PR whose head equals the verified SHA and, when
  configured, reviewed SHA; required local verification and GitHub checks pass; no blocking findings
  remain; and the evidence bundle is complete and secret-free.
- Any candidate mutation invalidates prior verification and review evidence.
- Human questions and permission requests are durable interaction records. They block the current phase
  without being inferred from terminal idleness.
- Desired state and observed state are stored separately so cancellation, pause, and worker loss can be
  reconciled without inventing progress.

### Terminal-session lifecycle

```text
provisioning → starting → running ↔ paused → stopping → stopped
                              ↘ lost | conflict | failed
```

- Public session IDs are opaque Termbridge IDs. tmux names, tmux session IDs, process IDs, container IDs,
  sandbox IDs, and sockets are runtime-binding fields.
- A live runtime does not prove a resumable task. Resume requires an exact tagged binding, a safe
  checkpoint, no unresolved dispatched operation, and valid lease ownership where applicable.
- `lost`, `conflict`, and unknown runtimes require inspection. Startup reconciliation never destroys an
  orphan automatically.

### Operation journal and replay policy

```text
prepared → dispatched → confirmed
               ↘ uncertain → paused
```

| Operation class | Examples | Retry/recovery rule |
|---|---|---|
| Pure read | inspect, list, capture, read event cursor | Retry; no externally visible mutation |
| Keyed internal mutation | create task/session, append checkpoint/event | Bind idempotency key to canonical payload and first durable result |
| Runtime mutation | open tmux/container/sandbox | Inspect deterministic binding before creation; conflict pauses |
| Terminal input | text, control key, interrupt, approval response | Never replay after dispatch; reconcile native request/runtime and pause if unproven |
| Local Git mutation | worktree, ref update, commit | Record expected OID and confirm with Git compare-and-swap facts |
| Remote delivery | tracker publish, push, draft PR creation/update | Inspect remote/provider state; uncertainty pauses for reconciliation |
| Destructive cleanup | force-remove worktree, delete branch/session | Explicit approval; no automatic replay or startup cleanup |

An idempotency key is scoped to the authenticated caller, command kind, target resource, and canonical
payload hash. Reusing a key with different input is a conflict, never a new request.

### Event contract

Every durable event contains:

- `eventId`, `taskId`, optional `sessionId` and `operationId`;
- a per-task monotonic `sequence`;
- `kind`, `occurredAt`, `causationId`, and `correlationId`;
- adapter ID, binary version, transport, schema hash, and native IDs when applicable;
- redacted structured payload and payload schema version;
- observed/requested/resolved/uncertain provenance where relevant.

Minimum event families are:

- `task.*`, `session.*`, `run.started`, `run.progress`, `run.idle`, `run.completed`, `run.failed`;
- `interaction.requested`, `interaction.resolved`, `mode.changed`;
- `auth.changed`, `quota.changed`, `rate_limit.observed`;
- `checkpoint.created`, `operation.*`, `runtime.reconciled`;
- `human.takeover`, `human.released`, `evidence.created`, and `delivery.*`.

Delivery is at least once. Ordering is guaranteed only within one task sequence. Consumers resume with a
durable cursor and must deduplicate by event ID. Retention gaps produce an explicit `stream.gap` response
with the earliest available sequence; Termbridge does not claim exactly-once delivery.

`run.idle` is never equivalent to `run.completed`. Quiet terminals, plan questions, permission prompts,
auth flows, and backoff periods may all be idle.

### Application commands and transports

- Commands use versioned request/response schemas, stable error codes, capability negotiation, caller
  identity, authorization context, idempotency metadata, and correlation IDs.
- Versioned HTTP is the primary general-purpose external API. The TypeScript SDK is generated from its
  shared schemas.
- MCP maps the legacy 13 tools and future MCP capabilities directly to application services. It does not
  contain independent validation or business rules and need not make an HTTP network call.
- Sensitive commands expose only choices allowed by Termbridge policy even when an upstream CLI offers
  broader persistent approval.
- Unsupported adapter schemas or capabilities fail closed to human takeover, supported-version guidance,
  or an explicitly tested screen driver.

### Storage and lease ports

Core defines behavioral interfaces for tasks, sessions, runtime bindings, checkpoints, operations,
events, leases, worktrees, delivery attempts, and atomic units of work. SQL builders and database row
types are private to adapters.

- SQLite uses WAL, foreign keys, bounded busy timeouts, short write transactions, and managed checkpoint
  behavior.
- Repository and lease contracts remain backend-neutral. The later Postgres adapter will use database
  time, transactional row claiming, and monotonically increasing fencing tokens.
- Local scheduler mutations carry the current lease ID and state version. A stale scheduler cannot
  advance durable state after lease expiry.
- Phase 1 runs the conformance suite against real SQLite. Postgres joins the same suite when Platform
  work begins.

### Runtime reconciliation

| Durable state | Observed runtime | Automatic result |
|---|---|---|
| Active; one exact tagged binding; safe checkpoint | Matching live runtime | Reattach; resume only when desired state is running |
| Active; exact binding; last operation dispatched | Matching live runtime | Mark operation uncertain and reattach paused |
| Active | No binding | Mark runtime lost and preserve worktree/evidence |
| Active | Multiple matches or generation mismatch | Mark conflict and quarantine from automation |
| Terminal | Matching live runtime | Preserve as orphan for inspection; do not kill on startup |
| No durable record | Tagged or untagged runtime | Inventory as unknown; never adopt automatically |

### CLI-adapter boundary

`PromptProtocol` builds task/correction/delivery instructions and parses portable `TB_*` markers.
`CliDriver` owns discovery, launch, native session/turn IDs, lifecycle events, plan/build/review modes,
permissions, questions, auth, quota, interruption, evidence, and reconciliation. A `ScreenDriver` is an
explicit transport option, not the default definition of an adapter.

For Autonomous Local stable:

- OpenCode uses one loopback HTTP/OpenAPI/SSE server shared with its TUI or attached client.
- Claude Code uses the strongest supported structured surface available at implementation time; the
  existing tmux-screen path remains the starting fallback.
- Each supported adapter publishes a manifest containing binary/build version, schema hash, capability
  bits, launch flags, effective sandbox/permission policy, golden traces, and fallback fixture version.

Plan mode is a compound policy, not a label. OpenCode planning denies bash and other mutation paths and
uses an outer read-only execution boundary until the approved transition to Build. The same outer
read-only invariant applies to Claude Code and any later Codex adapter.

### Worktree and delivery boundary

- Every task records repository identity, immutable base OID, deterministic worktree path, unique task
  branch, observed HEAD, ownership, and preservation state.
- Worktrees are created locked. Path/ref collisions fail without mutation. Dirty worktrees are never
  auto-pruned or force-removed.
- Before delivery, Termbridge freezes agent writes and records porcelain status, HEAD, diff summary,
  changed files, tests, unresolved conflicts, and evidence hashes.
- Local ref updates use expected-old OIDs. Remote delivery records expected and resulting remote OIDs or
  provider object IDs.
- Host delivery creates or updates exactly one GitHub draft PR for the deterministic task branch.
- Ready, approve, merge, bypass, Gerrit, and deployment operations are absent from the Local V1
  application and adapter contracts.

### Secret and diagnostic boundary

- Persist secret references and versions, never secret values, credential files, raw environments, or
  pasted credentials.
- Resolve scoped, short-lived values only at the execution or host-delivery boundary.
- Redact structured objects and streaming terminal bytes before persistence, including secrets split
  across chunks; redact again for logs, events, browser responses, telemetry, audit details, and bundles.
- Diagnostic bundles use an allowlist, show a preview and redaction manifest, and require export consent.
- Local remote telemetry is off by default. Opt-in metrics contain no terminal bodies, prompts, diffs,
  repository content, or credentials.

## 7. Research-Readiness Gates

Implementation may not freeze a contract until the corresponding research gate is complete.

| Gate | Required before | Status and remaining evidence |
|---|---|---|
| **R1 — durable Core** | Phase 1 implementation | Primary research is complete in the durable architecture brief. Accept ADRs for state transitions, event retention, operation uncertainty, repository ports, fences, tmux identity, and secret policy. |
| **R2 — CLI drivers** | Phase 1 event freeze and Phase 2 implementation | OpenCode primary research is complete. Run live same-session OpenCode server + TUI/SDK spikes; research Claude's best structured surface; record disconnect, cancellation, authentication, and approval ownership. Codex research remains evidence for later expansion, not a Local V1 gate. |
| **R3 — Platform security/runtime** | Post-Local Platform design | Deferred until Autonomous Local stable. Select OIDC, project permissions, queue/fence semantics, Postgres operations, audit immutability, and shared secret-provider contracts before Platform implementation. |
| **R4 — tracker and forge** | Phase 4 implementation | Primary Jira Cloud, Linear, and GitHub research is complete in the 2026-07-24 workflow brief. Accept adapter, webhook inbox, approval, operation-reconciliation, and provider-capability ADRs before implementation. |

Research sources:

- [CLI adapter research](research/2026-07-11-cli-adapters-codex-opencode.md)
- [Durable and platform architecture research](research/2026-07-11-roadmap-v2-durable-platform-architecture.md)
- [Jira, Linear, and GitHub workflow research](research/2026-07-24-jira-linear-github-autonomous-workflows.md)
- [Original terminal research](RESEARCH.md)

## 8. Metrics and Release SLOs

| Area | Stable-release requirement |
|---|---|
| Documentation truth | Zero generated-status drift and one declared source of truth |
| Compatibility | 100% legacy MCP golden-contract pass rate during its support window |
| Durable correctness | Zero duplicate or automatically replayed uncertain effects in the fault matrix |
| Storage | SQLite passes repository, migration, CAS, lease, backup/restore, and crash conformance; contracts remain backend-neutral for later Postgres |
| Event delivery | Monotonic per-task sequence, cursor resume across restart, and explicit gap behavior |
| Secret safety | Zero canary-secret occurrences in every tested persistence and egress surface |
| Plan safety | Zero unapproved project mutations during planning |
| Delivery safety | Zero unauthorized pushes or duplicate PRs; zero ready, approve, merge, bypass, publish, deploy, or destructive-cleanup operations |
| Local reliability | At least 54 of 60 benchmark runs succeed for each exact supported CLI/version |
| Critical scenarios | Each critical recovery, interaction, takeover, and security scenario passes 3 of 3 runs |
| Tracker correctness | Zero lost or duplicate tasks across Jira/Linear polling, webhook, retry, and reconciliation tests |
| Draft handoff | PR head equals verified and required-reviewed SHA; required GitHub checks pass |

Preview releases may publish incomplete reliability results, but they may not weaken the zero-tolerance
security, secret, authorization, or uncertain-replay requirements.

## 9. Phase Plan

Phases are gate-driven. Time ranges are planning estimates for one primary engineer using coding agents,
not release promises. Contract-critical work is sequential even when adapter, fixture, and documentation
work can run in parallel.

### Phase 0 — Make the Existing Substrate Truthful

**Planning window:** July 2026, 1–2 weeks
**Customer outcome:** A reproducible V1 baseline with one authoritative roadmap and no ambiguous release
state.

#### Entry conditions

- Current V1 suite remains green.
- V2 roadmap and its supporting research are accepted.

#### Deliverables

1. Add `scripts/project-status.ts` to generate a SHA- and timestamped JSON manifest plus Markdown status
   from package manifests, CI results, registry checks, and recorded live smokes.
2. Render generated version/test/support tables into README, roadmap, and release evidence; fail CI when
   regeneration changes tracked files.
3. Correct README version/test claims, classify changelog Unreleased work, and mark old ROADMAP/PLAN
   documents as superseded.
4. Consolidate D1–D4 and V2-D1–V2-D17 into the ADR authority; refresh architecture documentation to show
   current packages and the V2 target. D5–D8 were never authored; do not attempt to consolidate them.
5. Fix the two lint warnings and informational style diagnostics or explicitly configure a documented
   rule; the exit gate is zero diagnostics.
6. Live-validate Daytona's create/drive/delete lifecycle. Treat the current Cloudflare smoke as
   credential-only evidence; add a real create/drive/destroy smoke or defer Cloudflare. Release either
   package as experimental only with lifecycle evidence; otherwise record owner, reason, next review
   date, and support-matrix removal.
7. Complete the operator-run Hermes/Discord demonstration and store command, version, timestamp, and
   redacted result evidence, or formally defer it with an owner, reason, and next review date.
8. Commit the benchmark manifest schema, at least four licensed fixture repositories at immutable SHAs,
   deterministic grader shape, release-run budget policy, and the approved Autonomous Local design.
9. Run an OpenCode same-session HTTP/SSE spike and complete a first-party Claude structured-surface
   brief before freezing the driver-event and application-event contracts.
10. Accept V2-D13–V2-D17 and the tracker/forge, exact-plan approval, reviewer-policy, and no-merge
   capability boundaries in the ADR authority.

#### Out of scope

- New durable state, API inversion, or Local product UI.
- Claiming stable support for Daytona, Cloudflare, Jira, Linear, GitHub delivery, or OpenCode.

#### Exit gate and evidence

- CI is clean with zero lint diagnostics and zero generated-document drift.
- The generated manifest reports exact package/source/registry versions and test totals.
- Every package is classified released, experimental, or deferred.
- Installation and existing Local/Docker/E2B smoke paths are reproducible.
- Hermes evidence is recorded or explicitly deferred without being described as complete.
- The OpenCode spike and Claude brief record the event and permission semantics used by the schema
  freeze; missing capabilities fail closed to a documented fallback.
- Required ADRs and fixture licenses/SHAs are present.

**Release outcome:** V1 maintenance baseline; no Core v2 compatibility promise yet.

### Phase 1 — Durable Autonomous Local Control Plane

**Planning window:** 6–10 weeks after Phase 0
**Customer outcome:** A provider-neutral Local daemon can carry a synthetic approved task from intake to
a fake tested/reviewed draft PR, survive daemon failure, and never duplicate an unsafe effect.

#### Entry conditions

- Phase 0 gate passes.
- R1 decisions are accepted.
- R2 live spikes have produced enough event/interaction evidence to freeze the Core event envelope.

#### Critical path

1. Domain IDs, states, transitions, errors, capabilities, and policy decisions.
2. Repository ports, migrations, event store, operation journal, and unit-of-work boundaries.
3. SQLite production adapter against a backend-neutral conformance suite; Postgres implementation is
   deferred until Platform.
4. Runtime tagging, startup inventory, checkpointing, and reconciliation.
5. Shared application commands and schemas.
6. HTTP API, SSE stream, legacy MCP adapter, and generated TypeScript SDK.
7. Fake tracker, forge, and CLI adapters that drive the complete state machine.
8. Secret ingress/egress policy and environment conformance.

#### Deliverables

- Durable installation/work-item/task/plan/approval/session/runtime/verification/review/operation/event/
  lease/worktree/delivery records.
- Compare-and-swap transitions, idempotency conflicts, SQLite leases, and unique active-run constraints.
- tmux metadata tags and reconciliation across Local, Docker, and at least one cloud sandbox.
- Versioned command schemas, stable error catalog, cursor-resumable SSE, and application service ports.
- Golden compatibility for all 13 existing MCP tools without an MCP-to-HTTP network hop.
- Extraction of Claude authentication/recognizers and forge credential forwarding from Core.
- Shared redaction canary corpus covering the enumerated Phase 1 persistence and event surfaces.
  Streaming and structured redaction across every egress lands in Phase 3.
- Environment capability and lifecycle conformance for Local, Docker, E2B, and any non-deferred provider.
- Synthetic end-to-end tracer from configured issue event through exact-plan approval, verification,
  review, draft delivery, and `DRAFT_PR_READY_FOR_HUMAN`.

#### Fault and acceptance matrix

- Kill before dispatch, after dispatch, and after effect-before-confirmation for every operation class.
- Reconcile exact, missing, duplicate, stale-generation, terminal, and unknown runtime bindings.
- Disconnect event consumers, expire retention, restart storage, and resume from durable cursors.
- Race schedulers across lease expiry and prove stale leases cannot advance state.
- Inject canary secrets into terminal chunks, JSON, URLs, errors, logs, events, metrics, browser responses,
  audit details, and diagnostic archives.

#### Exit gate and evidence

- SQLite passes repository, migration, CAS, lease, backup/restore, integrity, and event conformance.
- HTTP/MCP/SDK golden requests produce equivalent application results and errors.
- No uncertain terminal, Git, push, PR, merge, publish, or cleanup effect is automatically replayed.
- Unknown tmux sessions are never adopted; every reconciliation-matrix row is tested.
- Events remain ordered and resumable across restart with explicit gap behavior.
- Zero canary-secret occurrences in the enumerated Phase 1 surfaces: SQLite rows, logs, events, SSE
  frames, and browser responses. Full-egress canary coverage is a Phase 3 gate, since the streaming
  redactor does not exist until then.

**Release outcome:** Durable Local control-plane preview with fake providers; no live coding or tracker
support claim yet.

### Phase 2 — Managed Workspaces and Stable CLI Drivers

**Planning window:** 10–16 weeks after the Core contract stabilizes
**Customer outcome:** One developer can approve a synthetic task, run it in a locked worktree through
Claude Code or OpenCode, answer questions, cancel or recover it, and receive a candidate workspace
without exposing tracker or GitHub credentials.

#### Entry conditions

- Phase 1 gate passes.
- R2 is complete, including same-session human/control spikes and pinned compatibility manifests.
- Initial benchmark fixtures and budget fit within the declared release-run ceiling.

#### Deliverables

1. Repository mirror, locked worktree, and task branch per run, immutable base OID, collision handling,
   preservation, and explicit cleanup.
2. First-run Local-versus-Docker choice, with Docker recommended for untrusted work and the trust
   consequence shown before Local host execution.
3. Capability-negotiated Claude Code and OpenCode drivers using the native-first architecture.
4. Human questions, cancellation, daemon restart, native-session recovery, transcript redaction, and
   explicit unsupported-version behavior.
5. Task-specific runtime homes, minimal CLI authentication material, and proof that Jira, Linear, and
   GitHub control-plane credentials never enter the coding runtime.
6. Post-plan policy that permits routine scoped edits/tests but gates credentials, destructive commands,
   persistent grants, and equivalent sensitive effects.
7. Driver compatibility manifests containing binary/build version, schema hash, capability bits, launch
   flags, effective sandbox policy, golden traces, and fallback fixture version.
8. A real-CLI tracer for each driver from approved synthetic task through candidate workspace.

#### Adapter-specific invariants

- OpenCode server events, questions, permissions, and mode changes retain exact native IDs and scopes.
- Unknown schema hashes disable autonomous approval.
- OpenCode Plan denies bash/mutation paths and runs in an outer read-only boundary.
- Screen fallback activation is visible, versioned, and benchmarked separately.
- Human attachment, approval ownership, disconnect, and return-to-agent behavior are tested.

#### Driver conformance gate

For each exact supported CLI/version:

- lifecycle, permission, question, cancellation, authentication, rate-limit, crash, and recovery fixtures;
- real candidate-workspace tracer through each driver;
- every critical containment and recovery scenario passes 3 of 3;
- zero plan-gate bypasses, unauthorized mutations/delivery, wrong-request approvals, secret leaks, or
  uncertain-action replays;
- adapter manifest, golden traces, fallback activation, elapsed time, and usage evidence published.

#### Exit gate and evidence

- The lifecycle, cancellation, recovery, and containment suites pass independently for Claude Code and
  OpenCode. The statistical coding benchmark becomes the Phase 5 stable gate after verification and
  delivery exist.
- Daemon restart, human takeover, plan rejection, permission interaction, rate limiting, auth expiry,
  dirty worktree recovery, and uncertain delivery are present in the published evidence.
- Worktree cleanup, preservation, and collision paths are tested on supported hosts.
- No tracker or GitHub credential is visible to the coding runtime.

**Release outcome:** Local runtime alpha with Claude Code and OpenCode; no tracker or GitHub stable claim.

### Phase 3 — Verification, Evidence, and Independent Review

**Planning window:** 4–6 weeks after Phase 2
**Customer outcome:** A candidate is never accepted because a coding CLI says it is done; Termbridge
independently proves required checks, obtains the configured independent review, repairs failures, and
binds all evidence to one candidate SHA.

#### Deliverables

- Versioned project policy for commands, timeouts, required results, paths, budgets, review mode, and
  retention.
- Verification runner with process-tree termination, structured results, artifacts, hashes, and
  secret/path scanning.
- Deterministic acceptance graders and evidence bundles.
- Reviewer profiles for off, fresh same-model session, different model, and named reviewer.
- Structured review findings, blocking-severity policy, repair orchestration, and full evidence
  invalidation after candidate change.
- Cost, attempt, repeated-failure, changed-file, and wall-clock limits.

#### Exit gate and evidence

- Tested SHA equals candidate SHA; required-reviewed SHA equals candidate SHA.
- Required tests and required review cannot be bypassed by the coding runtime or budget exhaustion.
- Failing verification, repair, blocking review, second repair, full re-verification, and full re-review
  pass as one deterministic tracer.
- Evidence bundles are complete, reproducible, and secret-free.

**Release outcome:** Verified/reviewed Local beta without live tracker delivery.

### Phase 4A — GitHub Draft Delivery

**Planning window:** 4–6 weeks after Phase 3
**Customer outcome:** A verified candidate becomes exactly one evidence-rich GitHub draft PR and reaches
human handoff only after required checks pass for the exact candidate SHA.

#### Deliverables

- User-owned GitHub App installation and least-privilege validation.
- Host-side commit, deterministic branch push, and exactly-one draft PR create/update.
- Required-check observation, branch/ruleset inspection, branch-tampering detection, and failed-webhook
  reconciliation.
- Operation-journal recovery for commit, push, PR, and tracker/forge publication boundaries.
- Draft PR body containing source issue, approved-plan hash, policy, verification, review, and evidence
  references.
- No ready, approve, merge, bypass, or deployment command, route, state transition, or adapter method.

#### Exit gate and evidence

- Push/PR crash matrix passes without duplicate refs or PRs.
- PR head equals verified and required-reviewed SHA.
- External branch modification pauses without force push.
- The coding runtime never receives GitHub installation credentials.

### Phase 4B — Linear Status-to-Draft-PR

**Planning window:** 3–5 weeks after Phase 4A
**Customer outcome:** A Linear issue entering a configured workflow state produces a plan, waits for
local human approval, and completes as a synchronized tested/reviewed GitHub draft PR.

#### Deliverables

- Linear OAuth app actor, token rotation, installation capability record, and dedicated test-workspace
  flow.
- Configured workflow-state intake through reconciliation/polling plus verified webhook acceleration.
- Issue, comment, label, attachment, state, and permission/revocation normalization.
- Plan, progress, question, cancellation, failure, evidence, and draft-PR synchronization.
- Preview Agent Sessions behind capability detection with standard issue/comment fallback.

#### Exit gate and evidence

- Duplicate/out-of-order events create one run.
- OAuth rotation, revocation, rate limit, and permission reduction pause or cancel safely.
- Claude Code and OpenCode each complete the live Linear-to-draft-PR tracer.

### Phase 4C — Jira Status-to-Draft-PR

**Planning window:** 4–6 weeks after Phase 4B
**Customer outcome:** A Jira issue entering a configured workflow state follows the same approved Local
workflow and completes as a synchronized tested/reviewed GitHub draft PR.

#### Deliverables

- Jira Cloud OAuth 2.0 3LO, rotating refresh handling, tenant installation, and developer-instance flow.
- Configured workflow intake through reconciliation/polling plus signed, expiring dynamic webhooks and
  renewal.
- ADF conversion; issue, comment, label, attachment, changelog, and workflow-transition normalization.
- Plan, progress, question, cancellation, failure, evidence, and draft-PR synchronization.
- Jira Remote Agents behind an experimental capability flag while EAP.

#### Exit gate and evidence

- Webhook renewal, duplicate retry delivery, out-of-order events, transition discovery, ADF round-trip,
  rate limit, revocation, and uncertain-write reconciliation pass.
- Claude Code and OpenCode each complete the live Jira-to-draft-PR tracer.

### Phase 5 — Autonomous Local Hardening and Stable Pilot

**Planning window:** 4–6 weeks plus a minimum four-week controlled pilot
**Customer outcome:** A user can install, configure, operate, recover, upgrade, and trust the complete
open-source Local system in daily work.

#### Deliverables

- Guided local setup for Jira, Linear, GitHub, repository mappings, trigger states, drivers, verification,
  review, budgets, retention, and webhook ingress.
- Loopback dashboard for plan approval, task timeline, questions, cancellation, recovery, verification,
  review, costs, evidence, and draft handoff.
- OS secret-provider integrations, rotation/revocation, backup/restore, upgrade/rollback, uninstall,
  health checks, and diagnostic export.
- Deterministic E2E, provider, fault, security, compatibility, benchmark, and clean-machine install
  suites.
- Four-week pilot with at least 30 real tasks, three repositories, both trackers, both drivers, multiple
  review policies, and exercised restart/provider failure.

#### Stable gate

- Each required CLI passes 20 tasks × 3 clean attempts with at least 54/60 successes.
- Every critical recovery/security case passes 3/3; zero policy violation is tolerated.
- Zero lost tasks, duplicate implementations/PRs, unauthorized pushes, false-success states, secret
  leaks, ready/merge/deploy operations, or missing audit/evidence links.
- Installation, backup, restore, upgrade, rollback, and cleanup reproduce from release artifacts.

**Release outcome:** Termbridge Autonomous Local 1.0: open source, single user, self-hosted, Jira +
Linear, Claude Code + OpenCode, exact-plan human approval, configurable independent review, tested
GitHub draft PR, and no merge or deployment.

### Post-Local — Evidence-Driven Expansion

Work enters only after Autonomous Local stable evidence and a new accepted design:

- Termbridge Platform with OIDC, Postgres, shared queues/workers, project authorization, and immutable
  organizational audit.
- Codex stable driver support.
- GitLab, Bitbucket, Gerrit, and other tracker/forge adapters.
- Secure remote access and device pairing.
- Multi-node scheduling and regional sandbox placement.
- Optional desktop wrapper and managed hosting while retaining the complete MIT self-hosted edition.

## 10. Benchmark Program

The benchmark is a release system, not a demo script.

### Versioned manifest

Every case records:

- fixture repository archive/commit, license, content hash, and container image digest;
- task, acceptance criteria, setup, deterministic grader, and time limit;
- CLI binary/build, adapter version/schema hash, model/settings, Termbridge SHA, environment/provider, and
  network policy;
- scripted intervention or fault and its injection point;
- success and policy-violation rubrics;
- required evidence, elapsed time, usage proxy, and infrastructure-invalid classification.

### Run policy

- Stable candidates run 20 tasks × 3 clean attempts per required CLI/version.
- Latest-upstream canaries run separately and never auto-expand the supported range.
- Nightly smoke may run one attempt per task; it does not replace the stable matrix.
- Infrastructure-invalid attempts stay visible, are rate-capped in the manifest, and rerun from a clean
  image. Failures are never reclassified after results are known without a new benchmark version.
- Each candidate declares a wall-clock and provider-cost ceiling before execution. Exceeding it blocks
  the candidate or requires a new manifest; the ceiling is never retroactively raised.
- Publish all raw outcomes, category results, 95% Wilson intervals, regressions versus the previous stable
  version, and fallback activation.

### Critical scenarios

Plan rejection, stale approval, attempted planning mutation, permission scope, human takeover and return,
daemon death at each operation boundary, secret canary, auth expiry, tracker revocation, duplicate and
out-of-order webhook, rate limit, lost event consumer, interrupted dirty worktree, blocking review,
uncertain push/PR creation, branch tampering, and runtime conflict each pass 3 of 3. Aggregate completion
cannot mask a critical failure.

## 11. Security and Privacy Program

### Local boundary

- Bind loopback by default and fail startup on non-loopback configuration unless a future remote-safe
  mode is explicitly enabled.
- Treat the OS user as administrator while still requiring random control credentials, exact Host/Origin
  checks, request limits, and authorization per control message.
- Exchange a one-time bootstrap code for an `HttpOnly`, `SameSite=Strict` cookie. Do not place the
  long-lived control token in URLs, browser storage, or rendered HTML.
- Default untrusted work to Docker or a cloud sandbox. Explain that Local host execution has no isolation.
- Keep browser-cookie endpoints separate from native bearer-token endpoints.
- Keep the public webhook endpoint separate from the management API; verify raw-body provider signatures,
  cap request size, deduplicate delivery IDs, acknowledge after durable receipt, and process
  asynchronously.
- Store tracker and GitHub secrets through OS secret providers or an interactively unlocked encrypted
  fallback. Never persist raw credentials in SQLite task/event/audit records.

### Platform boundary

- Require end-to-end TLS or an explicitly trusted TLS reverse proxy.
- Use OIDC code flow with PKCE, exact redirects, secure server-side sessions, logout/session expiry, and
  revalidation for long-lived streams.
- Authorize organization, project, resource, and action in application services for every request and
  stream subscription.
- Give workers scoped task capabilities and short-lived resolved secrets, not organization-wide tokens or
  control-plane database credentials.
- Validate exact WebSocket Origin for browsers and authorize every message after upgrade.

### Security release work

- Maintain a threat model for Local, Platform, worker, CLI adapter, sandbox, Git, forge, browser, and
  supply-chain boundaries.
- Generate SBOMs and dependency/provenance evidence for release artifacts.
- Run secret canaries, authorization tests, dependency review, static checks, and fault injection on every
  stable candidate.
- Require independent security review before the first non-loopback or team release and after material
  auth, secret, worker-isolation, or delivery changes.

## 12. Compatibility and Migration

- Preserve the existing 13 MCP tool names, argument schemas, response shapes, and documented behavior
  through golden fixtures while Core v2 stabilizes.
- Announce any incompatible MCP change for at least two stable minor releases and 90 days, then remove it
  only in a semver-major release.
- Keep stdio and Streamable HTTP MCP transports supported; publish the compatibility matrix per release.
- Migrate `engineer-loop` through its `ToolCall` boundary to shared application services before removing
  any V1 dispatch path.
- Keep current Local/Docker/E2B environment behavior behind conformance tests during repository and
  runtime-binding migration.
- Mark old PLAN/ROADMAP content as historical; do not silently rewrite historical release claims.
- Provide migration dry-runs, backup instructions, rollback paths, and schema compatibility evidence for
  SQLite releases. Postgres conformance becomes mandatory only when Platform work begins.

## 13. Risk Register

| Risk | Likelihood / impact | Trigger | Mitigation | Contingency | Owner role |
|---|---|---|---|---|---|
| CLI protocol or TUI drift | High / High | Unknown schema, failed golden trace, changed approval behavior | Pin binary/schema, canary latest, fail closed, version fallback | Human takeover or supported-version downgrade | CLI adapter owner |
| Provider policy or account suspension | Medium / Critical | Policy change, warning, unexplained auth/rate-limit failure | Compliance review, explicit backoff, no evasion/account rotation | Disable affected adapter and publish support change | Product maintainer |
| Durable-state correctness defect | Medium / Critical | Duplicate effect, inconsistent task/runtime state | Operation journal, CAS/fences, fault matrix, sequential contract review | Pause affected operation class; recovery tooling and incident review | Core owner |
| Git or forge side effect | Medium / Critical | Ref mismatch, duplicate PR, uncertain push/PR create | Host delivery, expected OIDs, deterministic keys, inspect-before-retry | Mark uncertain; preserve worktree; require human resolution | Delivery owner |
| Tracker drift or missed intake | Medium / High | Webhook loss/expiry, stale cursor, workflow change | Polling reconciliation, signed webhook inbox, provider IDs, renewal health | Pause affected project; repair mapping/cursor and reconcile | Tracker owner |
| Secret leakage | Medium / Critical | Canary hit, credential in event/log/bundle | Minimize values, ingress and egress redaction, scoped credentials | Block release, revoke credential, incident response | Security owner |
| Benchmark nondeterminism | High / High | Wide variance or infrastructure-invalid spike | Pinned fixtures/images, deterministic graders, repeated runs, stratification | Version the benchmark; defer stable claim | Quality owner |
| Local/Platform divergence | Medium / High | Later backend-specific behavior or duplicated services | Shared domain ports in Local; require Postgres conformance before Platform implementation | Stop Platform work until contract gap closes | Architecture owner |
| HTTP/MCP behavior drift | Medium / High | Golden parity failure | Shared application services/schemas and parity tests | Block release; keep legacy adapter active | API owner |
| One-engineer overload | High / High | Multiple contract-critical streams or review backlog | WIP limits, tracer bullets, phase gates, delegate isolated adapters only | Reduce stable scope by ADR or extend schedule | Project maintainer |
| Sandbox/provider outage | Medium / Medium | Lifecycle failure or provider degradation | Capability health, explicit provider policy, preserved worktrees | Pause or use an explicitly configured allowed provider | Runtime owner |

Risk status is reviewed at least weekly during active development. A Critical-impact risk with an active
trigger blocks the related release gate until mitigated or explicitly removed from scope by ADR.

## 14. Delivery Governance

- One primary engineer owns contracts, ADRs, migrations, integration, security decisions, and releases.
- At most one state/schema/migration change is active at a time. Total work in progress is capped at one
  contract-critical tracer plus two isolated adapter/fixture/documentation tasks.
- Every milestone begins with an end-to-end tracer that produces an observable customer result before
  broadening providers or edge cases.
- Independent coding agents may implement adapters, fixtures, conformance cases, documentation, and
  provider integrations only after their contracts are accepted.
- Canonical API, state-machine, lease/fence, event-ordering, and migration changes require independent
  review plus cross-backend and transport-parity tests.
- Every stable release stores a generated evidence bundle under `docs/evidence/autonomous-local/release/`
  containing the status manifest, compatibility matrix, benchmark summary/raw-result pointer, migration
  report, security review, live-smoke evidence, and known deferrals. Phase gates record their evidence
  under `docs/evidence/autonomous-local/<phase>/`.
- Estimates are revised only at phase gates using observed throughput and research results; target windows
  do not override quality gates.

## 15. Release, Experimental, and Defer Policy

Every capability and package has exactly one status:

- **Mandatory:** required for the offering's stable support matrix; any failed gate blocks stable.
- **Experimental:** shipped behind explicit labeling with a pinned compatibility range and no stable SLO.
- **Deferred:** not shipped or supported; records reason, owner role, next review date, and dependencies.
- **Removed:** intentionally unavailable with migration and compatibility notice.

Rules:

1. Stable releases require every mandatory gate. There are no silent waivers.
2. Optional work may defer only when documentation, package tags, compatibility matrix, and release notes
   all reflect the defer decision.
3. Claude Code and OpenCode are mandatory for Autonomous Local stable. Codex is deferred until a later
   accepted support expansion.
4. Daytona and Cloudflare may defer without blocking Core when they remain outside the stable environment
   matrix. E2B is the required live cloud reference until that policy changes.
5. Jira, Linear, and GitHub draft delivery are mandatory for Autonomous Local stable.
6. Platform cannot begin implementation before Autonomous Local stable and its own accepted security and
   runtime design.
7. Every release publishes the generated status manifest, supported versions/schema hashes, benchmark
   result, migrations, security evidence, and known deferrals.

## 16. Immediate Execution Order

The next work is Phase 0, in this order:

1. Commit the accepted V2 roadmap, design, implementation plan, and supporting research as the authority
   baseline.
2. Design and implement the generated project-status manifest and CI drift assertion.
3. Fix lint diagnostics.
4. Decide Daytona/Cloudflare release versus defer after attempted live validation and evidence review;
   credential-only evidence cannot justify lifecycle support.
5. Finish or explicitly defer the Hermes/Discord operator demo.
6. Consolidate ADRs, including the D3/D8 supersession and V2-D1–V2-D17, then correct
   README/ROADMAP/CHANGELOG authority and version claims.
7. Refresh architecture documentation for current reality and the V2 migration target.
8. Land the benchmark schema, four fully pinned licensed fixtures, deterministic graders, and budget
   policy. Placeholders do not satisfy the gate.
9. Run the OpenCode same-session spike and complete the Claude structured-surface brief before freezing
   Core events.
10. Freeze the plan, policy, event, evidence, audit, and provider-port schemas from that evidence, then
    implement the Phase 1 durable control plane and synthetic tracer before provider integration work.

Detailed implementation plans are created phase by phase only after the applicable research and design
gates pass. This roadmap intentionally does not contain file-by-file implementation steps.

## 17. Locked Defaults

- One layered monorepo; Core, Local, and Platform remain independently adoptable.
- MIT license for the complete self-hosted product family.
- Local is the first product-quality wedge and targets one developer on one machine.
- Docker is recommended for untrusted execution; Local host execution remains an explicit choice.
- Managed worktrees and explicit plan approval are mandatory.
- Native structured CLI drivers are preferred; screen drivers are explicit fallbacks.
- The only successful autonomous terminal state is a tested GitHub draft PR ready for human review.
- Remote telemetry is off by default and redacted when enabled.
- Jira and Linear configured workflow states trigger candidate tasks; exact-plan human approval is still
  required before implementation.
- Claude Code and OpenCode are mandatory; independent review is configurable and budgeted.
- Polling/reconciliation is canonical; signed webhooks accelerate intake.
- Ready, approve, merge, bypass, and deployment capabilities are absent from Local V1.
- SQLite backs Local; Postgres remains a later Platform adapter through shared behavioral contracts.
- Platform follows Autonomous Local stable and does not block the first complete release.
- Versioned HTTP plus SSE is the primary general-purpose external API; MCP remains supported through a
  sibling adapter over shared application services.
- Provider-policy compliance, explicit backoff, and the prohibition on detection-evasion are
  non-negotiable.
