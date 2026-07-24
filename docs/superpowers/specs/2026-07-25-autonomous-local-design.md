# Termbridge Autonomous Local — Design

**Status:** Approved design

**Date:** 2026-07-25

**Target:** First stable autonomous Termbridge Local release

**Canonical roadmap:** `docs/ROADMAP-V2.md` (Autonomous Local revision approved 2026-07-25)

## 1. Decision summary

Termbridge will build an open-source, single-user, locally hosted control plane that turns
configured Jira or Linear workflow-state changes into fully tested GitHub draft pull requests.

The autonomous boundary is:

```text
tracker intake
→ plan generation
→ mandatory human plan approval
→ isolated implementation
→ independent verification
→ configurable independent automated review
→ repair loops
→ host-controlled GitHub draft PR
→ required GitHub checks
→ human handoff
```

The first stable release:

- runs as a single-user local daemon;
- uses SQLite as authoritative state;
- supports Jira Cloud and Linear as stable trackers;
- supports Claude Code and OpenCode as stable coding drivers;
- requires human approval of the exact versioned plan before implementation;
- supports configurable independent review because review cost is user-controlled;
- finishes at a fully tested GitHub draft PR;
- is fully open source and hostable by the user.

It does not:

- mark a draft PR ready;
- approve a GitHub PR as a human;
- merge;
- bypass repository policy;
- deploy;
- provide multi-user or multi-tenant authorization;
- require Termbridge Platform.

## 2. Context and current baseline

Termbridge already provides reusable terminal infrastructure:

- terminal session lifecycle and tmux recovery;
- local, Docker, E2B, Daytona, and Cloudflare sandbox foundations;
- MCP stdio and HTTP transports;
- browser supervision and write locking;
- Claude-oriented recognizers;
- prompt sentinels and the `runEngineerLoop` orchestration flow;
- pluggable delivery prompts.

The current engineer loop remains a useful execution prototype, but it is not a durable control
plane. It keeps session registry state in memory, drives delivery through the coding CLI, and has no
native Jira/Linear intake, persistent task state machine, managed Git worktrees, provider operation
journal, or independently verified evidence chain.

The Autonomous Local work must therefore treat the existing engineer loop as an execution capability
to decompose behind accepted contracts, not as the orchestration architecture to extend indefinitely.

Research supporting this design:

- [Jira, Linear, and GitHub autonomous workflow research](../../research/2026-07-24-jira-linear-github-autonomous-workflows.md)
- [Durable and Platform architecture research](../../research/2026-07-11-roadmap-v2-durable-platform-architecture.md)
- [Claude, Codex, and OpenCode adapter research](../../research/2026-07-11-cli-adapters-codex-opencode.md)

## 3. Product and trust boundaries

### 3.1 Product layering

`Termbridge Core` (`@termbridge/core`) owns reusable runtime primitives:

- terminal supervision;
- environment and session primitives.

`Termbridge Control Plane` (`@termbridge/control-plane`) owns the provider-neutral durable domain:

- durable task-domain contracts;
- operation journal;
- CLI-driver contracts;
- workspace and evidence primitives;
- provider-neutral tracker and forge contracts.

`control-plane` depends on `core`, never the reverse, and cannot import provider packages, `server`,
`mcp-server`, or browser code.

`Termbridge Local` owns the first complete product:

- local daemon and loopback browser application;
- SQLite;
- local repository mirrors, worktrees, and sandboxes;
- Jira, Linear, and GitHub installations;
- Claude Code and OpenCode drivers;
- planning, approval, verification, review, and draft-PR orchestration.

`Termbridge Platform` remains a later product:

- OIDC and multiple users;
- Postgres and distributed workers;
- project/team authorization;
- shared queues and audit administration;
- remote worker isolation.

Local cannot depend on Platform services.

### 3.2 Trust zones

```text
Trusted local control plane
  SQLite, policy engine, operation journal, GitHub delivery

Constrained coding runtime
  Claude Code or OpenCode, task worktree, test processes

Untrusted project input
  Jira/Linear content, attachments, repository files, command output

Untrusted public input
  Webhooks, OAuth callbacks, forged and replayed requests
```

The coding agent cannot authorize its own plan, waive policy, declare verification complete, or
deliver directly to GitHub.

## 4. Component architecture

The first release is one daemon with replaceable internal modules, not a set of independently operated
services.

```text
                       ┌─────────────────────────┐
                       │ Local browser dashboard │
                       │ plans, approvals, runs  │
                       └────────────┬────────────┘
                                    │ loopback HTTP
 Jira Cloud ─┐                      ▼
             ├──▶ Tracker Gateway ─▶ Durable Task Engine
 Linear ─────┘       │                    │
                     │                    ├──▶ Planning sandbox
                     │                    ├──▶ Human approval gate
                     │                    ├──▶ Workspace manager
                     │                    ├──▶ Claude/OpenCode driver
                     │                    ├──▶ Verification pipeline
                     │                    ├──▶ Independent reviewer
                     │                    └──▶ GitHub draft delivery
                     │
                     └──────── plan, progress, question, and outcome updates
```

### 4.1 Tracker gateway

One provider-neutral application contract has separate Jira and Linear implementations.

The gateway:

- authenticates using OAuth;
- discovers issues entering configured provider workflow states;
- normalizes issue descriptions, comments, attachments, labels, dependencies, and acceptance criteria;
- verifies and deduplicates webhook deliveries;
- posts plans, questions, progress, failures, evidence, and draft PR links;
- reconciles provider state periodically;
- propagates cancellation, authorization revocation, and movement out of allowed states.

A local daemon is not normally reachable by public provider webhooks. Polling and periodic
reconciliation are therefore the correctness baseline. Signed webhooks through user-controlled HTTPS
ingress are an optional low-latency accelerator.

### 4.2 Durable task engine

SQLite is authoritative for installations, cursors, issue snapshots, tasks, plans, approvals,
operations, workspaces, sessions, evidence, delivery, and audit history.

Consequential effects follow:

```text
prepared → dispatched → confirmed
                      ↘ uncertain → human resolution
```

Termbridge never blindly replays uncertain tracker writes, terminal input, commits, pushes, or PR
creation.

### 4.3 Planning and approval

Planning runs in a read-only outer sandbox and produces a schema-validated plan containing:

- issue interpretation and exclusions;
- repository and exact base revision;
- expected components;
- implementation sequence;
- acceptance criteria;
- verification strategy;
- migration and security risks;
- reviewer selection;
- estimated execution budget.

Termbridge hashes the serialized plan. A verified human approves that exact plan, issue snapshot, base
SHA, and policy version. No writable workspace is allocated before approval.

Material changes invalidate approval and return the task to planning.

### 4.4 Workspace and runtime manager

For each approved task, Termbridge:

- resolves the configured repository and exact base SHA;
- creates a deterministic branch;
- creates and locks an isolated Git worktree;
- launches the configured sandbox with a task-specific home;
- mounts only permitted workspace and runtime material;
- launches Claude Code or OpenCode through its driver;
- preserves failed or uncertain workspaces according to retention policy.

The coding runtime never receives Jira, Linear, or GitHub control-plane credentials.

### 4.5 CLI drivers

Claude Code and OpenCode have independent native drivers behind one lifecycle contract. Each driver
handles its own capabilities, activity, permission requests, cancellation, authentication, and
recovery.

Prompt sentinels may remain a compatibility layer. Native structured interfaces are preferred where
available and stable.

### 4.6 Verification

Termbridge runs required verification independently of the coding agent's claims. Project policy
declares formatting, lint, type checking, unit tests, integration tests, builds, browser/API E2E,
security scans, coverage, and custom acceptance graders.

Every result is bound to the exact candidate hash and verification-policy version.

### 4.7 Independent review

Review is configurable per project:

```text
off
fresh-session-same-model
different-model
named-reviewer-profile
```

A reviewer receives the issue, approved plan, diff, verification evidence, and relevant repository
context, but not the implementer's private reasoning.

Blocking findings return to repair. Every repair invalidates prior test and review results and requires
the full configured pipeline again. A required review cannot be silently skipped when budget is
exhausted.

### 4.8 GitHub draft delivery

A user-owned GitHub App performs host-side commit, push, draft PR creation/update, and required-check
observation.

The first-release forge surface deliberately has no ready, approval, merge, bypass, or deployment
operations. The GitHub App receives only the repository permissions required for branch push, draft PR,
and check observation. GitHub's permission model may still make an installation token technically
capable of calling a merge endpoint when it has content-write access, so Termbridge enforces the
boundary through credential isolation plus the absence of any merge command, route, state transition,
or provider-adapter method.

### 4.9 Local dashboard and API

The loopback application provides:

- installation and repository mapping;
- tracker-state trigger configuration;
- plan review and approval;
- task timeline and live progress;
- human questions, cancellation, and recovery;
- workspace/session takeover;
- verification, review, budget, and evidence views;
- credential and retention configuration;
- final draft-PR handoff.

## 5. Durable task state machine

```text
DISCOVERED
    │
    ▼
VALIDATING ───────────────▶ BLOCKED_CONFIGURATION
    │
    ▼
PLANNING
    │
    ▼
AWAITING_PLAN_APPROVAL ───▶ PLAN_REJECTED
    │ approved plan hash
    ▼
PREPARING_WORKSPACE
    │
    ▼
IMPLEMENTING ◀──────────── REPAIRING
    │                         ▲
    ▼                         │
VERIFYING ────────────────────┤
    │ tests pass              │
    ▼                         │
AUTOMATED_REVIEW ─────────────┤
    │ review passes
    ▼
DELIVERING_DRAFT_PR
    │
    ▼
AWAITING_GITHUB_CHECKS ───────┤
    │ checks pass
    ▼
DRAFT_PR_READY_FOR_HUMAN
```

Every transition uses compare-and-swap state versions. A unique active-run constraint prevents
duplicate execution for one external work item.

### 5.1 Intake and planning

`DISCOVERED` means a tracker item was observed entering its configured trigger state. Termbridge
persists the provider delivery identity and issue version before processing.

`VALIDATING` confirms installation, current provider state, repository mapping, GitHub access, policy,
driver availability, and absence of another active run or existing delivery.

`PLANNING` creates a versioned structured plan with:

```text
plan_id
plan_version
plan_hash
issue_snapshot_hash
base_commit_sha
policy_version
estimated_budget
```

`AWAITING_PLAN_APPROVAL` publishes the plan and waits. Approval records bind the tenant, installation,
task, plan hash, issue hash, base SHA, policy, verified actor, source, timestamp, and expiration.

`PLAN_REJECTED` may return to planning with human feedback.

### 5.2 Implementation, verification, and review

`PREPARING_WORKSPACE` persists and verifies the worktree, branch, sandbox, runtime, and session before
implementation begins.

`IMPLEMENTING` accepts normalized driver progress, questions, plan deviations, completion, failures,
budget exhaustion, and authentication events.

`VERIFYING` runs policy-owned commands against the candidate and records immutable evidence.

`REPAIRING` receives only relevant failures and approved context. Attempt, time, cost, repeated-failure,
and changed-file limits apply.

`AUTOMATED_REVIEW` binds findings and verdict to the candidate hash. Blocking findings return to repair.

### 5.3 Delivery and success

`DELIVERING_DRAFT_PR` journals commit, push, and exactly-one draft-PR operations separately.

`AWAITING_GITHUB_CHECKS` observes required checks for the exact PR head. Failed checks return to repair.
External branch modification pauses the task. Termbridge never overwrites human work.

`DRAFT_PR_READY_FOR_HUMAN` is the only successful terminal state. It requires:

```text
PR is open and draft
PR head SHA == verified SHA
PR head SHA == reviewed SHA when review is required
approved plan and policy remain current
required local verification passed
required GitHub checks passed
no blocking review findings remain
tracker and PR links are synchronized
evidence bundle is complete and secret-free
```

### 5.4 Pause, invalidation, and terminal states

Any applicable active state may enter:

- `AWAITING_HUMAN_INPUT`;
- `REPLAN_REQUIRED`;
- `PAUSED_BUDGET`;
- `PAUSED_POLICY`;
- `PAUSED_AUTH`;
- `PAUSED_UNCERTAIN_OPERATION`;
- `CANCELING`;
- `FAILED`;
- `CANCELED`.

Paused tasks preserve worktree and evidence. Resume is an explicit audited transition.

Approval is invalidated by material issue changes, repository/base changes, stale base beyond policy,
plan changes, policy changes, selected driver changes, required reviewer changes, security
classification changes, or expiration.

## 6. Durable data model

SQLite uses explicit domain tables rather than one workflow JSON document.

### 6.1 Integration and intake records

`tracker_installations`

- provider and tenant/workspace identity;
- OAuth scopes and installation identity;
- encrypted token reference;
- webhook registration, secret reference, and expiration;
- reconciliation cursor;
- authorized approver identities.

`github_installations`

- App and installation identities;
- accessible repositories and granted permissions;
- encrypted private-key reference;
- permission reconciliation and revocation state.

`webhook_receipts`

- provider, tenant, and delivery identity;
- raw-body hash and signature result;
- received and processed timestamps;
- processing state and error;
- unique provider/tenant/delivery constraint.

### 6.2 Project and work records

`projects` stores tracker mapping, trigger state, repository binding, driver/reviewer profiles, budgets,
retention, and current policy version.

`repository_bindings` stores GitHub installation/repository, local mirror, allowed base branches,
worktree root, sandbox policy, and repository-policy revision.

`status_mappings` maps provider IDs to semantic internal states. Display names are never stable keys.

`external_work_items` stores provider identity, normalized snapshot and hash, status, labels,
dependencies, repository, and active task.

`task_runs` stores current state/version, approved plan/policy, selected profiles, SHAs, attempts,
budgets, timing, cancellation, and failures.

`plans` and `approvals` are immutable versioned records. Editing content creates a new record.

### 6.3 Execution, evidence, and delivery records

`workspaces` stores mirror, worktree, branch, SHAs, sandbox, lock, retention, and cleanup state.

`runtime_sessions` stores driver/version, native session and tmux binding, capability version,
lifecycle, heartbeat, and redacted transcript reference.

`verification_runs` stores candidate SHA, policy version, individual command results, artifacts,
hashes, and verdict.

`review_runs` and `review_findings` store reviewer profile/model/prompt version, candidate SHA, cost,
structured findings, dispositions, and verdict.

`deliveries` stores GitHub installation/repository, branch, commit/head SHA, draft PR identity, required
checks, and reconciled state.

`external_operations` stores deterministic key, target/action, request hash, state, result identity,
retry, and reconciliation history.

`audit_events` stores an append-only redacted actor, transition, operation, policy, and outcome timeline.

`task_events` stores the durable application event stream: task, per-task monotonic sequence, event
identity, kind, schema version, payload, and previous-event hash. Sequence is gap-free per task and
survives process restart. Events commit in the same transaction as the transition and audit record they
describe.

## 7. Proposed application contracts

These are design contracts, not current public APIs.

### 7.1 Tracker

```ts
interface WorkTrackerAdapter {
  capabilities(): TrackerCapabilities;
  verifyWebhook(input: RawWebhook): Promise<VerifiedDelivery>;
  registerOrRenewWebhooks(): Promise<WebhookRegistration[]>;
  reconcile(cursor?: string): AsyncIterable<TrackerChange>;

  fetchWorkItem(id: ExternalWorkItemId): Promise<NormalizedWorkItem>;
  fetchContext(id: ExternalWorkItemId): Promise<WorkItemContext>;

  publishPlan(command: PublishPlanCommand): Promise<ExternalReference>;
  publishProgress(command: PublishProgressCommand): Promise<ExternalReference>;
  publishQuestion(command: PublishQuestionCommand): Promise<ExternalReference>;
  publishOutcome(command: PublishOutcomeCommand): Promise<ExternalReference>;

  discoverWorkflow(): Promise<WorkflowDescription>;
  observeCurrentState(id: ExternalWorkItemId): Promise<ExternalState>;
}
```

Jira owns ADF conversion, workflow transition discovery, expiring webhook renewal, and Jira-specific
pagination/rate-limit behavior.

Linear owns GraphQL/cursor behavior, app-actor identity, OAuth rotation, and capability-gated Agent
Sessions.

Vendor preview agent APIs may enrich UX but cannot become canonical task state.

### 7.2 Coding CLI

```ts
interface CodingCliDriver {
  probe(): Promise<CliCapabilities>;
  start(input: StartSession): Promise<SessionHandle>;
  send(input: DriverInstruction): Promise<void>;
  observe(session: SessionHandle): AsyncIterable<DriverEvent>;
  answer(input: HumanAnswer): Promise<void>;
  cancel(session: SessionHandle): Promise<CancelResult>;
  recover(binding: RuntimeBinding): Promise<RecoveredSession>;
  exportEvidence(session: SessionHandle): Promise<SessionEvidence>;
}
```

Normalized events include activity, question, permission request, plan deviation, idle, candidate
ready, rate limit, authentication required, failure, and termination.

### 7.3 GitHub draft forge

```ts
interface DraftPullRequestForge {
  validateInstallation(repository: RepositoryId): Promise<ForgeCapabilities>;
  inspectRepository(repository: RepositoryId): Promise<RepositoryRules>;
  observeBranch(ref: BranchRef): Promise<BranchState>;
  observeDraftPullRequest(key: DeliveryKey): Promise<DraftPullRequest | null>;

  pushCandidate(command: PushCandidateCommand): Promise<BranchResult>;
  createDraftPullRequest(
    command: CreateDraftPullRequestCommand
  ): Promise<DraftPullRequest>;
  updateDraftPullRequest(
    command: UpdateDraftPullRequestCommand
  ): Promise<DraftPullRequest>;

  observeChecks(pr: PullRequestId, sha: CommitSha): Promise<CheckSummary>;
}
```

The contract has no `markReady`, `approve`, `merge`, `bypassRules`, or `deploy` methods.

## 8. Project policy

The authoritative policy is daemon-owned and exportable as schema-validated YAML.

```yaml
version: 1

tracker:
  provider: linear
  project: engineering
  trigger_state_id: "provider-state-id"
  cancellation_states: [canceled]
  authorized_approver_ids: ["provider-account-id"]

repository:
  github_installation_id: 12345
  repository: acme/payments
  base_branch: main
  allowed_paths: ["src/**", "tests/**"]
  denied_paths: [".github/workflows/**", "infrastructure/production/**"]

implementation:
  drivers:
    allowed: [claude-code, opencode]
    default: claude-code
  max_iterations: 8
  wall_clock_minutes: 120
  budget_units: 20
  max_changed_files: 40

verification:
  commands:
    - id: lint
      run: bun run lint
      timeout_seconds: 300
    - id: typecheck
      run: bun run typecheck
      timeout_seconds: 600
    - id: unit
      run: bun test
      timeout_seconds: 1200
  required: [lint, typecheck, unit]
  github_checks: [build, test]

review:
  mode: different-model
  required: true
  profile: economical-reviewer
  blocking_severities: [critical, high]
  max_repair_cycles: 3
  budget_units: 5

delivery:
  draft_only: true
  allow_mark_ready: false
  allow_merge: false

retention:
  successful_worktree_days: 2
  failed_worktree_days: 14
  evidence_days: 90
```

A task snapshots its policy. Repository-owned configuration may suggest verification commands but
cannot grant permissions or weaken daemon-owned policy. Changes to tests, review, repository, or
delivery policy invalidate approval.

Issue text and repository files are untrusted. Agent-generated commands run only in the sandbox.
Denied paths are enforced before execution and against the final diff.

## 9. Recovery and failure behavior

### 9.1 Startup reconciliation

On startup, Termbridge:

1. validates SQLite integrity and migration version;
2. finds nonterminal tasks;
3. expires abandoned leases;
4. inspects worktrees, branches, tmux sessions, and sandboxes;
5. reconciles dispatched and uncertain external operations;
6. fetches current tracker and GitHub state;
7. resumes only provably safe transitions;
8. pauses everything else with a concrete recovery action.

Automatic session resume requires exactly one matching live session, matching runtime identity,
unchanged workspace, no uncertain terminal input, a confirmed checkpoint, valid approval, and a valid
lease.

### 9.2 Operation reconciliation

Each effect uses a deterministic operation key derived from task, action, target, and content version.

```text
confirmed                    → no action
prepared, never dispatched   → dispatch
dispatched                   → inspect external state
externally confirmed         → record confirmation
definitely absent + safe     → retry
cannot determine             → pause uncertain
```

Deterministic branch names, stored provider IDs, content markers, read-after-write checks, and database
uniqueness provide application-level idempotency where providers do not.

### 9.3 Required failure outcomes

- Duplicate/out-of-order webhook: deduplicate and fetch current provider state.
- Provider outage: preserve task and pause synchronization.
- Revoked/reduced OAuth: stop affected runs and pause authorization.
- CLI crash before a safe checkpoint: bounded restart or pause.
- CLI crash after uncertain input: never replay input automatically.
- Verification timeout: terminate process tree, record evidence, repair or pause.
- Repeated identical failure: stop at configured threshold.
- Reviewer unavailable/over budget: pause, never waive required review.
- Base advance: controlled rebase and plan-validity check.
- External task-branch modification: pause, never overwrite.
- Uncertain push/PR creation: inspect GitHub before retry.
- Required check failure: repair.
- Required check timeout: pause.
- SQLite integrity failure: stop dispatch.
- Cancellation: terminate process tree and preserve evidence/workspace per policy.

## 10. Security and secret handling

### 10.1 Secret provider

SQLite stores `SecretRef` values, not credentials. The provider supports macOS Keychain, Linux Secret
Service, Windows Credential Manager, and an interactively unlocked encrypted-file fallback.

Secret classes are separated:

- Jira OAuth;
- Linear OAuth;
- GitHub App private key and installation token;
- webhook verification;
- Claude Code authentication;
- OpenCode/provider authentication;
- local API sessions.

Control-plane credentials never enter the coding runtime.

CLI authentication is necessarily available to the selected CLI. It receives only its own minimum
credential through an ephemeral, isolated runtime. The supported-version gate must test upstream
authentication and subprocess behavior rather than claiming perfect containment.

### 10.2 Public webhook endpoint

The public webhook endpoint is separate from the local management API. It enforces HTTPS at the
user-controlled ingress, request-size limits, raw-body signature validation, constant-time comparison,
timestamp freshness where supported, delivery deduplication, receipt-before-acknowledgement, asynchronous
processing, installation lookup, invalid-request rate limits, and redaction.

### 10.3 Local management API

The management API binds to loopback by default and requires an installation-generated token. It
validates `Origin` and `Host`, protects mutations from CSRF, uses secure browser sessions, never places
persistent tokens in URLs, and reauthenticates sensitive approval, cancellation, credential, and cleanup
operations.

Remote access is unsupported in the first stable release unless the user deliberately provides an
authenticated TLS proxy.

### 10.4 Repository containment

Workspace preparation controls Git hooks, global Git configuration, credential helpers, submodule
protocols, symlink escapes, path traversal, writes outside the task workspace, access to daemon state,
other worktrees, Docker socket, host process namespace, and production credentials.

Final delivery validates changed paths, symlinks, submodules, secret canaries, binary/oversized artifacts,
candidate/evidence hashes, and commit identity.

Prompt defenses do not provide authorization. Policy, sandboxing, independent verification, independent
review, exact-hash delivery, and absent merge/deploy capabilities enforce the boundary.

### 10.5 Redaction

Redaction occurs before persistence and before every egress: logs, UI events, tracker writes, PR bodies,
diagnostics, and evidence bundles.

It combines exact installed-secret matching, encoded variants, provider token patterns, high-entropy
detection, environment deny lists, and project patterns. A deliverable redaction hit blocks delivery.

## 11. Testing and stable-release definition

### 11.1 Test layers

```text
                Live provider pilot
             Release benchmark matrix
          Deterministic E2E workflows
       Fault, recovery, and security suites
    Adapter and storage contract conformance
 Unit, state-machine, policy, and schema tests
```

Unit and property-based tests prove transition and policy invariants. Shared storage suites prove atomic
transitions, uniqueness, leases, compare-and-swap behavior, operation recovery, approval immutability,
migrations, backup/restore, and crash recovery.

Provider fixtures cover Jira ADF/transitions/webhook renewal/rate limits, Linear GraphQL/cursors/app
actors/permission events, and GitHub installation/branches/draft PR/check/reconciliation behavior.

Claude Code and OpenCode compatibility suites cover start, observation, permissions, questions,
cancellation, rate limits, authentication, malformed output, crashes, recovery, and redaction.

### 11.2 Canonical deterministic E2E

The real daemon runs with temporary SQLite, real Git/worktrees, fake provider servers, scripted CLI
drivers, real verification commands, controllable time, fault injection, and secret canaries.

The canonical scenario proves:

1. configured tracker-state intake;
2. deduplication and snapshot;
3. plan creation and publication;
4. zero implementation before approval;
5. exact-hash human approval;
6. workspace and implementation;
7. failed test and repair;
8. passing verification;
9. blocking independent-review finding and repair;
10. complete re-verification and re-review;
11. host commit, push, and exactly-one draft PR;
12. failed GitHub check and repair;
13. updated candidate verification/review;
14. passing checks for the new SHA;
15. tracker evidence/PR synchronization;
16. `DRAFT_PR_READY_FOR_HUMAN`.

The same scenario runs through Jira and Linear.

Assertions require one task, branch, and PR; no preapproval coding; no skipped evidence; equal tested,
reviewed, and PR SHAs; no secret escape; no prohibited operation; and a complete restart-safe audit.

### 11.3 Fault and security suites

The harness crashes the daemon before/after database commit, before/after external dispatch,
after response/before confirmation, and during reconciliation for every consequential operation.

Every case must resume correctly, reconcile correctly, or pause explicitly without duplicate effects.

Security fixtures include prompt injection, malicious Git hooks, symlink/path traversal, submodule abuse,
host-access attempts, cross-workspace access, forged/replayed webhooks, OAuth CSRF, oversized requests,
terminal-output attacks, encoded secret exfiltration, direct GitHub attempts, and requests to mark ready,
merge, or deploy.

Stable requires zero secret-canary escape and zero prohibited operations.

### 11.4 Coding benchmark

```text
20 tasks
× 3 clean attempts
× 2 required CLI drivers
= 120 attempts
```

Each CLI must independently achieve at least 54 successes out of 60, no critical policy violation, and
3/3 success on every critical recovery/security case. Raw outcomes, 95% Wilson intervals, and
predeclared time/cost ceilings are published.

Fixtures are licensed and pinned. Deterministic graders cover localized fixes, multi-file features, API
changes, migrations, frontend/E2E work, configuration changes, diagnosis, security validation,
clarification, and intentionally unsafe requests.

### 11.5 Live validation and pilot

Live validation uses a Jira developer instance, dedicated Linear workspace, private GitHub App, test
repositories, separate credentials, and user-controlled webhook ingress.

Required live matrix:

| Tracker | Claude Code | OpenCode |
|---|---:|---:|
| Jira | Required | Required |
| Linear | Required | Required |

Stable follows a four-week pilot with at least 30 real tasks and three repositories, both trackers, both
drivers, multiple review policies, and exercised restart/provider failure.

Stable requires zero lost tasks, duplicate implementations/PRs, unauthorized pushes, secret leaks, or
false-success states.

## 12. Implementation sequence

### Phase 0 — Contract and repository truth

- Generate package/test/release status in CI.
- Resolve documentation and version drift.
- Land lint fixes.
- Accept ADRs for state authority, operation journal, transports, worktrees, drivers, adapters,
  approvals, secrets, and evidence.
- Run the OpenCode same-session protocol spike and complete the first-party Claude structured-surface
  brief before freezing CLI lifecycle semantics.
- Freeze plan, policy, durable application-event, driver-event, evidence, audit, and provider-port
  schemas.

Exit: clean repository checks, generated docs agree with source, spike/brief evidence informs the
versioned contracts, and provider types do not leak into the task domain.

### Phase 1 — Durable Local control plane

- SQLite repositories and migrations.
- Task state machine, leases, compare-and-swap, operation journal, audit.
- Scheduler/reconciliation.
- Loopback HTTP/events with MCP sibling adapter.
- Startup recovery, backup, restore.
- Fake tracker/forge/CLI adapters.

Tracer: synthetic issue to fake tested/reviewed draft PR, including crash injection.

### Phase 2 — Managed workspaces and CLI drivers

- Mirrors, deterministic branches, worktrees, locks, retention.
- Sandbox policy and task-specific home.
- Claude Code and OpenCode drivers.
- Human questions, cancellation, recovery, evidence, compatibility manifest.

Tracer: approved fixture task to real candidate workspace through each CLI.

### Phase 3 — Verification, evidence, and review

- Versioned verification policies and command runner.
- Logs, artifacts, secret/path scans, acceptance graders.
- Reviewer profiles, findings, repair orchestration, budgets.
- Evidence bundles.

Tracer: failing verification, repair, blocking review, second repair, complete re-verification/re-review.

### Phase 4A — GitHub draft delivery

- GitHub App installation and least-privilege validation.
- Host commit/push and exactly-one draft PR.
- Check observation, branch tampering, failed-webhook reconciliation.
- Explicit proof that merge/ready/deploy operations do not exist.

### Phase 4B — Linear workflow

- OAuth app actor, configured-state intake, polling/reconciliation, signed webhooks.
- Normalization, plan/progress/question/outcome synchronization.
- Capability-gated Agent Sessions with standard fallback.

### Phase 4C — Jira workflow

- OAuth 3LO, configured-transition intake, webhook renewal, polling/reconciliation.
- ADF, context, attachments, plan/progress/outcome writes, transition discovery.
- Jira Remote Agents remain experimental while EAP.

### Phase 5 — Product hardening and stable pilot

- Guided setup, diagnostics, mapping, approval/timeline/recovery/evidence UI.
- Credential rotation, backup/restore/upgrade/uninstall.
- Benchmark, security, fault, documentation, and four-week pilot.

For one primary engineer, the design estimates 36–57 engineering weeks plus the four-week pilot, matching
the sum of the per-phase planning windows in roadmap §9. The
largest uncertainty is dependable CLI lifecycle control, credential containment, crash recovery, and
statistical E2E reliability, not basic tracker API calls.

## 13. Roadmap changes required

The later canonical roadmap update should:

- make Autonomous Local the primary release objective;
- move Platform until after Local stable;
- promote Jira and Linear to mandatory;
- make GitHub App draft delivery mandatory;
- make Claude Code and OpenCode mandatory;
- defer Codex from the first stable matrix;
- require exact-hash human plan approval;
- add configurable independent review;
- define reconciliation as canonical and webhooks as acceleration;
- define success with exact SHA/evidence invariants;
- prohibit ready, merge, bypass, and deployment;
- add deterministic E2E, fault, security, benchmark, live-provider, and pilot gates;
- retain Core/Local/Platform layering while changing their sequence.

## 14. Alternatives rejected

### Extend `runEngineerLoop` directly

This is the shortest path to another demo, but it preserves process-local orchestration, provider
coupling, prompt-driven delivery, and unsafe crash/retry ambiguity. It would require another rewrite
before dependable daily use.

### Use an external durable workflow engine

An external engine provides mature workflow recovery but adds another service, database, deployment
model, and operational burden. It conflicts with the first release's lightweight local-hosting goal.
It may become appropriate for Platform later.

### Depend on provider-native agent APIs

Linear Agent Sessions and Jira Remote Agents can provide a better native experience, but their current
preview/EAP status makes them unsuitable as correctness dependencies. They remain optional adapter
capabilities over Termbridge's durable state machine.

## 15. Acceptance summary

The design is complete when an eligible Jira or Linear issue can become one, and only one, tested and
optionally independently reviewed GitHub draft PR after approval of the exact plan, while surviving
daemon/provider/CLI failures without lost work, duplicate effects, leaked secrets, or any path to merge
or deployment.
