# Termbridge Roadmap V2: durable execution and platform architecture research

> Research brief, 2026-07-11. Scope: durable state, tmux reconciliation, storage,
> leases/checkpoints/idempotency, worktrees and delivery recovery, secret handling,
> benchmark statistics, and the Local/Platform trust boundary. CLI/TUI adapter
> details are intentionally out of scope.

## Executive conclusion

Roadmap V2 identifies the right work, but several bullets need to become explicit
contracts before implementation starts:

1. **The database is the authority; tmux is surviving execution state, not the
   registry.** A daemon may reattach only to a tmux session carrying the exact
   durable Termbridge identity. Unknown or multiply matched sessions are
   quarantined, never adopted automatically.
2. **Persist an operation journal, not just checkpoints.** Every effect moves
   through `prepared -> dispatched -> confirmed`, with `uncertain` as a terminal
   recovery state. A crash after dispatch but before confirmation must never
   cause an automatic replay of terminal input, commit, push, PR creation, or
   merge.
3. **Share domain repositories, not SQL.** SQLite and Postgres should implement
   the same task/session/event/operation/lease contracts, including compare-and-
   swap versions. Platform additionally needs transactional queue claiming and
   monotonically increasing fencing tokens.
4. **Move Git lifecycle and delivery to the host control plane.** Each task gets
   a deterministic, locked linked worktree and collision-proof branch. The CLI
   edits and tests there; the host verifies and performs explicitly approved
   outward delivery.
5. **Redaction is an ingress invariant.** Known secrets must be removed before
   terminal output becomes an event or durable record, then redacted again at
   every egress. Detection is defense-in-depth; secret minimization and scoped,
   short-lived credentials are the primary control.
6. **“90%” must mean a published observed rate over a fixed run matrix.** Use a
   versioned, containerized manifest, repeated independent runs, deterministic
   graders, a confidence interval, critical-scenario sub-gates, and an explicit
   per-release cost/time budget.

## 1. Repository reality and the exact crash window

The code already proves that tmux can survive a daemon restart, but recovery is
currently identity-blind:

- [`SessionManager`](../../packages/core/src/manager.ts#L254-L567) owns a
  process-local `Map`. `recover()` lists sessions only in the policy-selected
  default environment, uses `id = name`, and adopts every untracked name.
- Re-adoption constructs a fresh [`Session`](../../packages/core/src/session/session.ts#L70-L358),
  observer, recognizer pipeline, pending-event array, output cursor, auto-approve
  state, and [`WriteLock`](../../packages/core/src/session/write-lock.ts#L24-L83).
  Thus “tmux survived” does not imply “the task state survived.”
- [`sendText`](../../packages/core/src/session/session.ts#L102-L118) performs two
  effects: one `tmux send-keys -l <text>`, then a separate `send-keys Enter`.
  Death between either call and durable acknowledgement leaves an outcome that
  cannot be inferred from the API response.
- [`runEngineerLoop`](../../packages/orchestrator/src/engineer-loop.ts#L76-L271)
  asks the in-session agent to create the branch/commit/push/PR and recognizes a
  sentinel afterwards. There is no host-side operation record with expected Git
  object IDs or remote state.
- Host credentials are deliberately forwarded into the session by
  [`SessionManager.sessionEnv`](../../packages/core/src/manager.ts#L349-L367),
  including `GH_TOKEN`, which makes an accidental or replayed outward effect
  possible.
- The current server has a useful Local baseline (loopback default, bearer
  comparison, WebSocket Origin allowlist), but it accepts bearer tokens in URLs
  and [`/login`](../../packages/server/src/server.ts#L174-L194) redirects with the
  token in a query string. The server also prints its token at startup in
  [`startServer`](../../packages/server/src/index.ts#L35-L71).

Graph-augmented source searches found no application persistence implementation,
managed-worktree implementation, operation-idempotency journal, or cross-cutting
redactor. These are greenfield subsystems, not incremental flags on the current
manager.

## 2. Durable model and tmux reconciliation

### Minimum durable records

Keep the model small, but do not collapse records whose failure semantics differ:

| Record | Required durable identity/state |
|---|---|
| `task` | tenant/project, desired state, observed state, policy snapshot, version |
| `terminal_session` | task, environment, CLI adapter/version, desired/observed state |
| `runtime_binding` | tmux socket/server, tmux session ID and name, provider lease ID, binding generation |
| `checkpoint` | task phase, last confirmed operation, output/event sequence, worktree HEAD, evidence hash |
| `operation` | idempotency key, kind, canonical input hash, state, attempt, lease fence, expected/result facts |
| `event` | per-task monotonic sequence, kind, redacted payload, causation/correlation IDs |
| `lease` | resource, holder, expiry from database time, monotonically increasing fence |
| `worktree` | repository identity, path, branch ref, base OID, observed HEAD, preservation state |
| `delivery_attempt` | kind, approval, expected local/remote OIDs, provider object identity, outcome |

Use opaque Termbridge UUIDs as public IDs. Tmux names, process IDs, worktree paths,
and provider lease handles are bindings and must never become public identity.

### Operation state rule

```
prepared --(durable commit)--> dispatched --(observable proof)--> confirmed
                                  |
                                  +-- daemon loses proof --> uncertain --> paused
```

- `prepared`: canonical arguments, input hash, idempotency scope, expected prior
  state, and current fencing token are committed before the effect.
- `dispatched`: written immediately before crossing the effect boundary. This
  intentionally biases recovery toward caution.
- `confirmed`: durable evidence proves the requested postcondition.
- `uncertain`: dispatch may have happened, but the postcondition cannot be
  proven. Automatic replay is forbidden; a human may inspect and authorize a
  **new** operation.

This follows HTTP's own retry boundary: RFC 9110 says clients should not
automatically retry a non-idempotent request unless they know its semantics are
idempotent or can prove the original was never applied
([RFC 9110 section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)).
An idempotency key is not magic: it is safe only when the receiver durably binds
the same key and payload to the first result, as illustrated by
[Stripe's first-result idempotency contract](https://docs.stripe.com/api/idempotent_requests).

Recommended operation classification:

| Operation | Recovery policy |
|---|---|
| list/read/capture/inspect | Retry; no externally visible mutation |
| create task/session | Server idempotency key plus canonical payload hash; return existing result |
| open tmux session | Deterministic Termbridge binding; inspect before creating; conflict pauses |
| terminal text/control/interrupt | Never auto-replay after `dispatched`; inspect and pause |
| checkpoint/event append | Unique `(task_id, sequence)` / operation key; retry transactionally |
| local ref update/commit | Confirm expected OID; use Git compare-and-swap; ambiguity pauses |
| push | Confirm remote ref OID; never auto-replay an uncertain attempt |
| PR creation | Provider key if available, otherwise search a durable task marker/head/base; ambiguity pauses |
| merge/publish/destructive cleanup | Explicit approval and no automatic replay under any uncertainty |

### Tmux identity and restart matrix

Tmux leaves detached sessions alive by default and exposes stable-for-lifetime
session IDs, formatted inventory, and arbitrary `@` user options
([tmux(1)](https://man7.org/linux/man-pages/man1/tmux.1.html)). On creation, set
non-secret session options such as `@termbridge.session_id`, `@termbridge.task_id`,
`@termbridge.binding_generation`, and `@termbridge.environment_id`. Persist the
tmux socket/server identity as well as the tmux session ID and name.

On daemon start, inventory every configured environment, then reconcile:

| Durable record | Observed runtime | Automatic action |
|---|---|---|
| running/paused; one exact tagged binding; no dispatched operation | Reattach observer; rebuild derived state; resume only if task desired state is running and checkpoint is safe |
| running; one exact binding; last operation dispatched | Mark operation uncertain; reattach **paused** |
| running; no binding | Mark runtime lost; task paused; preserve worktree/evidence |
| running; multiple matching bindings or generation mismatch | Conflict; quarantine all; require resolution |
| terminal task; matching live binding | Preserve as orphan; never kill during startup reconciliation |
| no durable record; tagged or untagged tmux session | Unknown runtime; never adopt; show operator inventory only |

This replaces today's name-based adoption. Recovery must also restore event/output
sequence monotonically; reconnecting clients receive events after their durable
cursor and an explicit gap event if retained output no longer covers it.

## 3. SQLite/Postgres boundary, leases, and fencing

Define domain ports around transactions and compare-and-swap behavior:

- `TaskRepository` (`create`, `get`, `transition(expectedVersion, ...)`)
- `SessionRepository` and `RuntimeBindingRepository`
- `CheckpointRepository`
- `OperationJournal` (`prepare`, `markDispatched`, `confirm`, `markUncertain`)
- `EventStore.append(expectedNextSequence, events)`
- `LeaseRepository` (`claim`, `renew`, `release`, returning a fence)
- `WorktreeRepository` and `DeliveryRepository`
- `UnitOfWork` for the few domain transitions that must commit atomically

Do not expose SQL builders or database row types through these interfaces. Run
one behavioral conformance suite against both adapters and migration upgrade/
downgrade fixtures against real database engines.

For Local, SQLite WAL mode gives snapshot isolation and concurrent readers with
one writer ([SQLite isolation](https://www.sqlite.org/isolation.html)). Use short
write transactions, `BEGIN IMMEDIATE` where writer acquisition must be explicit,
a bounded busy timeout, foreign keys, and a managed WAL checkpoint policy;
SQLite documents both the single-writer boundary and WAL checkpoint starvation
([transactions](https://www.sqlite.org/lang_transaction.html),
[WAL](https://sqlite.org/wal.html)). Local still implements lease/CAS semantics so
behavior does not change when the same domain service runs on Platform.

For Platform, claim work in one Postgres transaction: lock eligible rows with
`FOR UPDATE SKIP LOCKED`, update holder/expiry, increment `fencing_token`, and
return the claimed records. Postgres explicitly documents `SKIP LOCKED` as a
queue-like access pattern, not a general consistent view
([Postgres SELECT](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)).
Use database time, not worker clocks, for expiry.

A lease alone does not prevent a paused old worker from waking after expiry.
Every subsequent durable mutation must include `WHERE lease_id = ? AND
fencing_token = ?`; a zero-row update means ownership was lost. Treat the
monotonic fence as a capability attached to the attempt. The pattern is
consistent with systems that combine leases with revision-checked transactions
([etcd API guarantees](https://etcd.io/docs/v3.5/learning/api_guarantees/)).
External systems that cannot validate the fence still require operation
idempotency and the uncertain-outcome rule.

### Paperclip reuse: useful vocabulary, not sufficient exclusivity

The current Paperclip snapshot is worth borrowing for environment/provider
lifecycle: provider lease IDs, lease policies, cleanup status, runtime-config
fingerprints, scoped reuse, and explicit resume/destroy hooks. It also strips
schema-declared secret values before persisting plugin lease metadata
([source snapshot](https://github.com/paperclipai/paperclip/blob/e4e12bfb890a0fdf4c7de092362472c50a584533/server/src/services/environment-runtime.ts#L63-L103)).

Do **not** copy its environment lease table as Termbridge's scheduler lease. In
the examined snapshot, acquisition is an insert without a uniqueness/CAS
predicate
([service](https://github.com/paperclipai/paperclip/blob/e4e12bfb890a0fdf4c7de092362472c50a584533/server/src/services/environments.ts#L598-L639)),
and the schema has timestamps/status/indexes but no owner fencing token or
exclusivity constraint
([schema](https://github.com/paperclipai/paperclip/blob/e4e12bfb890a0fdf4c7de092362472c50a584533/packages/db/src/schema/environment_leases.ts#L8-L46)).
That model tracks an environment allocation; Termbridge separately needs a
queue-execution lease that proves which worker may advance a task.

## 4. Managed worktrees and recoverable delivery

Git already provides the required primitives. `git worktree add --lock` avoids a
post-create lock race; `list --porcelain -z` is a stable machine format; locked
worktrees resist pruning; and ordinary removal refuses dirty worktrees unless
forced ([git-worktree](https://git-scm.com/docs/git-worktree)).

Recommended lifecycle:

1. Resolve a repository identity from canonical Git directory plus a stable
   hash. Record the exact base ref and base OID; never use a moving ref as the
   durable base.
2. Allocate `<state>/worktrees/<repo-id>/<task-id>` and branch
   `termbridge/<task-id>-<short-slug>`. The task ID, not the slug, provides
   collision resistance. Validate the ref and fail closed if path or ref is
   already owned by another task.
3. Journal `worktree.create`, then use `git worktree add --lock --reason
   termbridge:<task-id> -b <branch> <path> <base-oid>`. Confirm path, branch,
   HEAD, and lock from porcelain inventory before marking it ready.
4. Give the CLI only the worktree and execution credentials it needs. Withhold
   forge push/merge credentials by default; delivery belongs to the host-side
   approved operation.
5. On interruption, preserve and keep the worktree locked. Cleanup requires an
   explicit user decision after presenting dirty/untracked state and recovery
   path. Never invoke force removal automatically.

Before delivery, stop agent writes, snapshot `status --porcelain=v2 -z`, HEAD,
diff/stat, test evidence, and unresolved files. Local branch updates should use
`git update-ref <ref> <new> <expected-old>` so another actor cannot be overwritten
([git-update-ref](https://git-scm.com/docs/git-update-ref.html)). Remote pushes
must name one source/destination ref and an explicit expected remote OID when a
non-fast-forward update is approved; Git documents the exact-value form of
`--force-with-lease` and warns that implicit forms are weaker
([git-push](https://git-scm.com/docs/git-push)).

After a connection failure, inspect the remote ref: expected new OID means the
attempt is confirmed; an unexpected OID means conflict; any inability to prove
state remains uncertain. Even if a new attempt appears safe, require a new
explicit operation/approval instead of silently replaying the old push. Apply
the same rule to PR creation and merge by inspecting provider state and a durable
Termbridge task marker.

## 5. Secret minimization and redaction architecture

OWASP lists access tokens, session IDs, passwords, connection strings, keys, and
primary secrets as data that should be removed, masked, hashed, or encrypted
before logging
([Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html));
its secrets guidance says plaintext secrets must never be logged
([Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)).

Implement one shared `SensitiveDataPolicy` used by every output path:

- Persist secret **references and versions**, not values, in task/environment
  configuration. Resolve values only at the execution boundary.
- Register known runtime values (including short-lived tokens and derived
  variants that are safe to enumerate) with a per-run `SensitiveValueRegistry`.
- Redact structured objects recursively by schema/key classification before
  serialization. Reject unknown fields in security-sensitive event schemas.
- Redact terminal bytes **before** appending output/events to durable storage.
  Streaming matching must retain a boundary window so a token split across two
  chunks is still caught.
- Redact again at logs, telemetry exporters, HTTP/event serialization, audit
  details, browser views, and diagnostic-bundle construction. Egress redaction
  protects against missed legacy producers; it is not a substitute for ingress.
- Use keyed HMAC only when stable correlation is essential; do not store a plain
  hash of low-entropy secrets. Cap retained terminal output and default Local to
  no remote telemetry.
- Diagnostic bundles must be generated from an allowlist, show a preview and
  redaction manifest, and require explicit export consent.

Add canary-secret tests for raw values, values split across chunks, JSON fields,
URLs, errors/stacks, ANSI terminal output, database rows, SSE/WebSocket frames,
audit records, metrics/traces, and diagnostic archives. A single canary leak is
a release blocker.

Remove URL bearer tokens in V2. RFC 6750 recommends the Authorization header and
warns that bearer tokens in query strings are likely to be logged
([sections 2.1 and 2.3](https://www.rfc-editor.org/rfc/rfc6750.html#section-2.3)).
For Local browser boot, exchange a one-time loopback bootstrap code for a
`HttpOnly`, `SameSite=Strict` cookie; never place the long-lived control token in
the URL, browser storage, or rendered page.

## 6. Local and Platform are different security products

### Termbridge Local boundary

- Hard-bind to loopback by default and fail startup if a non-loopback bind is
  requested without an explicit remote-safe mode.
- Treat the OS user as the administrative boundary, but still require a random
  control credential, exact Host/Origin checks, request-size/rate limits, and
  per-message authorization for control actions.
- Separate browser-cookie routes from native bearer-token routes. A missing
  Origin is valid for an authenticated native client, but must not bypass the
  browser endpoint's same-origin policy.
- Default to Docker for untrusted work; Local host execution is an explicit
  trust choice. Do not claim the advisory human/agent lock is a security lock.

### Termbridge Platform boundary

- Require TLS end-to-end or through a specifically trusted proxy; never enable
  team mode merely by changing `HOST=0.0.0.0`.
- Use OIDC Authorization Code Flow with PKCE and exact redirect matching. RFC
  9700 requires PKCE for public clients, recommends it for confidential clients,
  and recommends end-to-end TLS
  ([OAuth Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1));
  OIDC Core defines the identity layer and code flow
  ([OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0-18.html)).
- Create server-side sessions in secure, `HttpOnly`, `SameSite` cookies; recheck
  session validity for long-lived streams. Validate exact WebSocket Origin and
  authorize every message, not just the upgrade. RFC 6455 explains Origin's
  browser protection and its limits for non-browser clients
  ([RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html#section-10.2)); OWASP
  adds session expiry and message-level authorization guidance
  ([WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)).
- Enforce organization/project/resource scope in the service layer on every
  command, event subscription, task, session, worktree, diagnostic, and delivery
  record. An authenticated user ID is not authorization.
- Workers receive a scoped task capability and resolved short-lived secrets,
  never control-plane database credentials or an organization-wide forge token.
- Make audit writes append-only to the application role and include actor,
  tenant/project, action, target, request/operation ID, policy decision, outcome,
  timestamp, and prior/new state hashes. Secret values and terminal bodies are
  excluded.

The shared Core should therefore contain domain contracts and policy hooks, not
Local authentication assumptions or Platform OIDC/database types.

## 7. Make the benchmark gate statistically honest

SWE-bench's official harness pins issue instances and uses containerized
evaluation for reproducibility
([repository](https://github.com/SWE-bench/SWE-bench)). Termbridge should copy
that discipline, not necessarily its task set.

Create a versioned `benchmark-manifest.json` containing, for every case:

- fixture repository archive/commit, license, content hash, and container image
  digest;
- task/acceptance text, setup, deterministic grader and time limit;
- exact CLI binary/version, adapter version, model/settings, Termbridge commit,
  environment/provider, and network policy;
- scripted interventions/faults and their injection time or durable state;
- success rubric, policy-violation rubric, evidence requirements, elapsed time,
  token/usage proxy, and infrastructure-failure classification.

Recommended stable matrix per CLI/version: **20 fixture tasks x 3 independent
runs = 60 runs** across at least four small, redistributable fixture repos.
Release when all of the following hold:

- at least 54/60 runs succeed (observed 90%);
- every critical scenario (plan rejection, human takeover, daemon death at each
  operation boundary, secret canary, interrupted worktree, uncertain push) passes
  3/3;
- no policy or secret-isolation breach occurs;
- no task/category is hidden by aggregate success; publish stratified results;
- the candidate does not regress beyond a predeclared margin versus the last
  stable adapter/CLI version;
- infrastructure-invalid runs remain visible, are capped by a predeclared rate,
  and are rerun from a clean image rather than counted opportunistically.

Always publish a 95% Wilson interval. NIST recommends Wilson-style intervals for
binomial proportions
([NIST handbook](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)).
For context, 54/60 has a 95% Wilson interval of approximately 79.9%-95.3%; the
gate therefore establishes a **90% observed result**, not 95% confidence that
the underlying success probability exceeds 90%. If that stronger claim is
desired, the run budget or required observed rate must rise substantially.

Pin a maximum wall-clock and provider budget per CLI and publish all attempts,
including failures. Nightly smoke can run one attempt per task; stable release
uses the full matrix. Never tune tasks or exclude failures after seeing candidate
results without issuing a new benchmark version.

## 8. Roadmap-ready acceptance criteria

### Before Phase 1 implementation

- Accept ADRs for the durable state machine, operation uncertainty rule,
  SQLite/Postgres repository ports, lease fencing, event ordering/retention,
  tmux identity, secret policy, and Local/Platform trust boundary.
- Commit the benchmark schema, initial licensed fixtures, deterministic graders,
  and release-budget policy.

### Phase 1 exit additions

- Both storage adapters pass one repository/migration conformance suite.
- Fault tests kill the daemon before dispatch, after dispatch, and after effect
  but before confirmation for every operation class. No uncertain terminal,
  Git, push, PR, or merge operation is replayed.
- Reconciliation tests cover every row in the matrix above across Local, Docker,
  and at least one cloud sandbox; unknown tmux sessions are never adopted.
- Two concurrent Platform workers cannot both advance a task after lease expiry;
  stale fencing tokens fail every durable state transition.
- Event sequences remain ordered and resumable across reconnect/restart, with an
  explicit gap contract.
- Canary secrets are absent from database rows, files, logs, events, browser/API
  responses, telemetry, audit details, and diagnostic archives.

### Phase 2 exit additions

- Every task starts in a uniquely owned, locked worktree at a recorded base OID.
- Branch/path collisions fail without mutation; crash recovery reconstructs or
  pauses from Git porcelain inventory; dirty worktrees survive until confirmed
  cleanup.
- Delivery records expected/result OIDs and approval. Push/PR/merge fault tests
  prove postcondition inspection and no automatic replay.
- The stable benchmark gate is met independently for each exact supported CLI
  version, with the manifest, raw outcomes, confidence intervals, and budget
  published.

### Phase 3 exit additions

- OIDC code+PKCE, exact redirect/Origin checks, secure session expiry/logout, and
  project-scoped authorization are integration-tested for HTTP and event streams.
- Queue recovery is exercised under database disconnect, worker death, expired
  lease, delayed stale worker, and duplicate webhook; fencing prevents duplicate
  task advancement.
- Execution workers cannot read other projects' worktrees, events, diagnostics,
  or secrets, and cannot access control-plane database credentials.
- The application database role cannot update/delete audit records; audit export
  is complete, ordered, scoped, and secret-free.

These criteria turn the roadmap's highest-risk promises into observable release
gates and preserve tmux's restart-survival advantage without mistaking a live
terminal for a safely resumable task.
