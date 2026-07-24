# Termbridge: Jira, Linear, and GitHub autonomous workflow research

> Research brief, 2026-07-24. Sources are limited to current first-party
> documentation from Atlassian, Linear, and GitHub. Scope: tracker intake,
> context and approval, forge delivery and policy, failure recovery, security,
> and test environments. This document does not change `ROADMAP-V2.md`.

## Executive conclusion

Termbridge can become an issue-to-reviewed-PR system, but connecting three APIs
is not the hard part. The missing product is a durable control plane that:

1. authenticates as a distinct app in every tenant and repository;
2. verifies, journals, acknowledges, deduplicates, and reconciles webhooks;
3. snapshots issue context and the exact approved plan;
4. leases one task to one fenced worker;
5. runs the task in a managed worktree and sandbox;
6. publishes immutable evidence and a draft PR;
7. observes repository rules rather than bypassing them; and
8. pauses on ambiguity instead of replaying an uncertain side effect.

The best provider order has changed since the original Phase 4 sketch:

- **Linear first, using its native agent model.** OAuth `actor=app`,
  `AgentSessionEvent`, Agent Activities, stop/select signals, session plans, and
  PR external URLs now provide a substantially better native agent experience
  than status/label automation alone. These APIs are still Developer Preview or
  technology preview, so Termbridge must capability-negotiate and retain a
  stable issue/comment fallback.
- **Jira second, using a Termbridge-hosted OAuth 2.0 (3LO) integration.**
  Dynamic, JQL-filtered webhooks can drive intake, but they expire every 30 days
  and OAuth webhook JWT verification, rotating refresh tokens, Jira workflow
  permissions, ADF, and tenant-specific schemas add material operational work.
  Forge is an optional later distribution shell, not the recommended first
  control plane.
- **GitHub first and only as a GitHub App.** Installation tokens are short-lived,
  repository-scoped, and attributable to the app. The app should create a
  branch, checks, and a draft PR, then let human reviews, required checks,
  rulesets, and merge queues decide whether the change lands. A PAT or `gh`
  token inside the coding sandbox is not an acceptable platform architecture.

## 1. Current Termbridge gap

The repository has a useful execution substrate but no tracker or forge control
plane:

- Jira is currently fetched by the driven agent through the user's own MCP;
  Termbridge itself does not ingest or reconcile tracker data
  ([Hermes integration](../integration/hermes.md#5-optional-give-hermes-a-jiratracker-tool)).
- GitHub delivery currently asks the in-session coding agent to use `gh`,
  branch, commit, push, and open a PR
  ([delivery prompt](../../packages/orchestrator/src/prompt.ts)).
- The engineer loop has a backend-neutral `ToolCall`, but its approval and
  completion behavior is CLI-shaped rather than tracker-shaped
  ([orchestrator types](../../packages/orchestrator/src/types.ts)).
- Roadmap V2 correctly names `TrackerAdapter` and `ForgeAdapter`, but it does not
  yet freeze their capabilities, webhook contract, approval identity, provider
  object mappings, or reconciliation behavior.

Therefore Jira/Linear/GitHub integration depends on the durable task, event,
operation, lease, worktree, redaction, and CLI-driver foundations described in
the [durable architecture brief](2026-07-11-roadmap-v2-durable-platform-architecture.md).

## 2. Canonical end-to-end workflow

```text
verified webhook
  -> durable inbox + immediate acknowledgement
  -> normalize provider event
  -> reconcile current issue and policy
  -> acquire task lease/fence
  -> resolve repository + immutable base OID
  -> create read-only planning session
  -> publish versioned plan
  -> record explicit human approval of that exact plan hash
  -> create managed worktree and execution session
  -> implement, test, review, and collect evidence
  -> host-side commit and push with expected OIDs
  -> create/update draft PR and Termbridge check
  -> synchronize tracker result
  -> human/GitHub policy decides merge
```

Every arrow is a recoverable operation. Webhook delivery is a hint, not truth;
the current provider object must be fetched before a state transition. Tracker
status, comments, or labels are projections of the Termbridge task, not its
authoritative state.

## 3. Linear requirements

### 3.1 Authentication and app identity

Linear recommends OAuth 2.0 for integrations. For an autonomous agent,
Termbridge should request `actor=app`; mutations are then attributed to the app
rather than the installing user. A workspace admin must install an app actor.
`app:assignable` and `app:mentionable` allow delegation and mentions, while an
app actor cannot also request `admin`
([OAuth](https://linear.app/developers/oauth-2-0-authentication),
[agent setup](https://linear.app/developers/agents),
[actor authorization](https://linear.app/developers/oauth-actor-authorization)).

Recommended production authorization:

- `actor=app`;
- `read` and the minimum write capabilities needed for issue status plus
  comments/activities;
- `app:assignable` and `app:mentionable`;
- no `admin`, customer, or initiative scopes unless enabled by an explicit
  feature;
- store the per-workspace app-user ID returned by `viewer`, the organization ID,
  granted team access, token metadata, and schema/SDK version.

Linear also supports client-credentials app tokens. They last 30 days and have
no paired refresh token; a 401 requires minting a new token. Changing scopes can
revoke existing app tokens. The authorization-code path and the client-
credentials path therefore need different token lifecycle implementations
([OAuth](https://linear.app/developers/oauth-2-0-authentication)).

### 3.2 Native agent intake is preferable to label polling

Linear's current agent APIs create an `AgentSession` when the app is mentioned
or delegated an issue. A `created` `AgentSessionEvent` includes the issue,
initiating comment, prior comments, guidance, and a formatted `promptContext`.
A `prompted` event carries a subsequent human message. The receiver must respond
within five seconds, and the agent should acknowledge a created session with an
activity or external URL within ten seconds
([agent interaction](https://linear.app/developers/agent-interaction)).

This should be the primary trigger because it preserves human ownership:
`app:assignable` makes the app the issue's **delegate**, not its assignee
([agent setup](https://linear.app/developers/agents)).

Configured status/label intake remains useful for teams that do not opt into the
preview:

- subscribe to `Issue` and `IssueLabel` data-change webhooks;
- detect entry by comparing `data` with `updatedFrom`;
- require a configured conjunction such as
  `status.type in {triage, backlog} AND label == termbridge`;
- fetch the issue after the event and atomically claim
  `(provider, organizationId, issueId, trigger-policy-version)`;
- ignore self-generated mutations and events that no longer satisfy policy.

Do not poll. Linear explicitly recommends webhooks instead
([rate limiting](https://linear.app/developers/rate-limiting)).

### 3.3 Webhook verification and delivery

Linear sends `Linear-Delivery`, `Linear-Event`, `Linear-Signature`, and
`Linear-Timestamp`. Verify an HMAC-SHA256 over the **raw** request body using a
constant-time comparison, check the timestamp (Linear recommends within one
minute), then deduplicate by organization plus delivery ID. The endpoint must
be public HTTPS and return HTTP 200 within five seconds
([webhooks](https://linear.app/developers/webhooks)).

Failed deliveries are retried after approximately one minute, one hour, and six
hours, for at most three retries; a persistently failing endpoint may be
disabled. The receiver must therefore persist the raw verified envelope before
acknowledging and expose a reconciliation job for disabled or missed hooks
([webhooks](https://linear.app/developers/webhooks)).

### 3.4 Context, plans, progress, approval, and stop

The GraphQL API supplies issues, workflow states, labels, comments, documents,
projects, and attachments. Lists use Relay cursor pagination with `first/after`
or `last/before`; 50 items are returned by default
([GraphQL](https://linear.app/developers/graphql),
[pagination](https://linear.app/developers/pagination)).

For a native agent session:

- use `promptContext` as convenient model input, but retain the structured IDs
  and fetch any omitted or security-relevant data;
- publish `thought`, `action`, `elicitation`, `response`, and `error`
  activities; activity inputs are frozen snapshots and are safer than editable
  comments for reconstructing a conversation;
- publish the evolving checklist through the Agent Plan API, while treating it
  as a projection because the API is technology preview;
- attach the Termbridge session and later PR using `externalUrls`;
- map Linear's human `stop` signal to a high-priority durable cancellation and
  perform no new effects after receipt
  ([agent interaction](https://linear.app/developers/agent-interaction),
  [signals](https://linear.app/developers/agent-signals),
  [best practices](https://linear.app/developers/agent-best-practices)).

Linear provides an elicitation plus `select` signal, but the response is still a
free-form user `prompt`. It is suitable UI for “Approve plan / Request changes /
Cancel,” not sufficient durable proof by itself. Termbridge must accept an
approval only when the normalized response resolves to:

```text
tenant + human actor ID + task ID + plan artifact ID + plan hash + decision
```

and the actor is authorized by Termbridge project policy. A later issue edit,
comment edit, changed plan, or new commit does not inherit the old approval.

Linear files are private. Direct uploads require `fileUpload`, a presigned URL,
and a server-side PUT; embedded remote images may be copied into Linear storage
([file upload](https://linear.app/developers/how-to-upload-a-file-to-linear)).
Inbound attachments must be size/type limited, scanned, stored outside the
execution environment, and exposed to the model as untrusted input.

### 3.5 Rate limits and schema risk

OAuth apps receive 5,000 requests per user/app user per hour and a 2,000,000
point budget; a single query may not exceed 10,000 complexity points. Linear may
also impose lower per-query/mutation limits. Rate-limit errors arrive as
GraphQL HTTP 400 responses with `extensions.code == RATELIMITED`, so status-code-
only retry middleware is incorrect
([rate limiting](https://linear.app/developers/rate-limiting)).

Agent APIs are Developer Preview and Agent Plans are technology preview. Pin the
SDK/schema, record a schema hash, contract-test webhook fixtures, and disable
only the unavailable native capability while preserving issue/comment fallback.

## 4. Jira Cloud requirements

### 4.1 App model

For Termbridge's self-hosted control plane, use one centrally registered OAuth
2.0 (3LO) integration. Atlassian recommends 3LO for most external integrations;
basic auth/API tokens are appropriate only for scripts and must not become the
product's install story
([security overview](https://developer.atlassian.com/cloud/jira/platform/security-for-other-integrations/)).

The app acts on behalf of the authorizing user, so effective authorization is
the intersection of OAuth scopes and that user's Jira project, issue-security,
comment, attachment, edit, and transition permissions
([scopes](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/)).
The product must display the principal whose grant powers automation and fail
closed when that principal loses access.

Recommended classic scopes for the first adapter:

- `read:jira-work`;
- `write:jira-work`;
- `manage:jira-webhook`;
- `offline_access`;
- add `read:jira-user` only if identity/profile resolution truly requires it.

Use a resource-level/site-restricted grant where available, bind and store the
selected `cloudid`, and validate OAuth `state`. Atlassian uses rotating refresh
tokens: each successful exchange returns a replacement token; the old token is
disabled, subject to a ten-minute reuse leeway, and inactivity expiry defaults
to 90 days
([OAuth 3LO](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/)).
Refresh-token rotation must be serialized per grant and committed atomically.

Forge offers Atlassian-hosted compute, managed authentication, tenancy isolation,
and development/staging/production environments. It is valuable if Marketplace
distribution or native Jira UI becomes a goal, but splitting the authoritative
workflow between Forge and the Termbridge platform adds another queue, secret,
deployment, and reconciliation boundary
([Forge](https://developer.atlassian.com/platform/forge/),
[environments](https://developer.atlassian.com/platform/forge/environments-and-versions/)).
Start with 3LO; revisit a thin Forge front end after the provider-neutral
contract is proven.

Jira now also documents a much richer Remote Agent integration: a Forge
`agentConnector` can make an externally hosted agent assignable and mentionable,
surface progress, request input, accept cancellation, and retrieve Jira
context. It uses Forge installation lifecycle hooks plus a JSON-RPC/A2A-derived
task protocol; active tasks move through `submitted`, `working`,
`input-required`, or `auth-required` before a terminal result. However,
Atlassian explicitly marks this as EAP: experimental, unsupported, changeable
without notice, and not recommended for production. It also assumes a public
multi-tenant SaaS remote rather than software behind a customer firewall
([Remote Agents in Jira](https://developer.atlassian.com/platform/forge/remote-agents-in-jira/)).
Treat it as an optional experimental UI adapter over the same canonical task,
approval, and event model. Do not replace the GA 3LO/webhook adapter with it.

### 4.2 Status/label intake and webhook lifecycle

OAuth apps can register dynamic issue and comment webhooks using JQL. Status is
a supported JQL field; **labels are not in the documented dynamic-webhook JQL
subset**. For a status trigger, filter server-side by project and status. For a
label trigger, receive project-scoped issue updates and evaluate labels after
fetching the issue
([webhooks](https://developer.atlassian.com/cloud/jira/software/webhooks/)).

Dynamic webhooks have several non-obvious operational requirements:

- maximum five webhooks per app, per user, per tenant;
- expiration 30 days after registration/refresh;
- a scheduled refresh is mandatory;
- the callback base URL must match the app;
- use `X-Atlassian-Webhook-Identifier` plus tenant as the delivery dedupe key;
- retries occur up to five times, with randomized five-to-fifteen-minute
  backoff, for timeouts and 408/409/425/429/5xx responses;
- failed deliveries can be queried through the failed-webhook API;
- primary and cascade/bulk secondary flows have different latency and
  concurrency behavior
  ([webhooks](https://developer.atlassian.com/cloud/jira/software/webhooks/),
  [webhook REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/)).

OAuth webhooks carry a bearer JWT in `Authorization`, signed with the app client
secret. Verify the JWT before persisting or acknowledging. Enqueue quickly:
Atlassian explicitly recommends asynchronous processing
([webhooks](https://developer.atlassian.com/cloud/jira/software/webhooks/)).

### 4.3 Context and output

Jira REST API v3 provides issue fields, changelog, transitions, comments,
attachments, issue links, and issue properties. Multi-line issue fields and
comments use Atlassian Document Format rather than plain Markdown
([REST v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/),
[issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)).

The adapter must:

- fetch only configured fields and expand only required data;
- paginate comments/changelog and preserve stable issue IDs as well as mutable
  keys;
- download attachments only after metadata, size, MIME, and access checks;
- resolve legal transitions with `GET transitions` before attempting a status
  move;
- render Termbridge plan/progress/result comments as ADF;
- use one namespaced issue property to hold a small projection such as task ID,
  current plan hash, PR URL, and last synchronized sequence. Issue properties
  accept a JSON value up to 32,768 characters, but 3LO apps cannot declare them
  searchable in JQL
  ([issue properties](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/),
  [OAuth limitation](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/)).

Jira has no first-party equivalent to Linear's Agent Session approval UI.
Represent approval as a Termbridge-owned comment containing the plan artifact
and one-time approval URL. A Jira status or label may request planning or queue
work, but must not by itself authorize implementation. If comment-based commands
are enabled, accept only an authenticated Jira actor with configured project
authority, bind the decision to the plan hash, and persist the originating
comment ID plus immutable Termbridge decision record. Never rely on editable
comment text as the durable record.

### 4.4 Limits and test environment

Jira Cloud enforces points-based hourly quota, per-endpoint burst limits, and
per-issue write limits. On 429, honor `Retry-After`, use exponential backoff with
jitter, reduce fields/pagination, cache stable metadata, and coalesce frequent
progress updates
([rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)).

Use a dedicated Jira Cloud development site and test projects/users/workflows.
For a future Forge shell, Forge supplies isolated development, staging,
production, and custom development environments. There is no local Jira Cloud
emulator; provider contract tests need recorded/synthetic signed envelopes, and
release tests need a real non-production site.

## 5. GitHub App requirements

### 5.1 Authentication and installation

GitHub Apps are installable on organizations or users, can be limited to
selected repositories, have built-in webhooks, and can act independently of a
human. A private app can only be installed on its owning account
([GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)).

Use an installation access token for autonomous work. Generate it from an app
JWT and installation ID; restrict it again to the single target repository and
minimum permissions. It expires after one hour
([installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)).
Cache it only until shortly before expiry. Store the app private key in a
sign-only KMS/HSM where possible; the key grants access across every
installation
([app security](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)).

Human user tokens are needed only for actions explicitly attributed to a human.
Do not use PATs, do not forward installation tokens to the coding sandbox, and
do not let an issue author select a repository outside the installed/project
allowlist.

### 5.2 Minimum permission profiles

Split permissions by optional capability:

| Capability | Repository permission |
|---|---|
| Read repository/default branch, create branch/commit, push | `Contents: read & write` |
| Create/update/read draft PR and comments/reviews | `Pull requests: read & write` |
| Publish Termbridge check run | `Checks: read & write` |
| Read workflow runs/results | `Actions: read` only if required |
| Read repository metadata | `Metadata: read` (mandatory baseline) |
| Read commit statuses | `Commit statuses: read`; request write only if using statuses instead of Checks |
| Merge a PR | no standing autonomous merge capability in v1; enable only with explicit project policy |

GitHub documents `Pull requests: write` for PR creation and review creation, and
`Checks: write` for check runs
([pull requests](https://docs.github.com/en/rest/pulls/pulls),
[reviews](https://docs.github.com/en/rest/pulls/reviews),
[checks](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks)).

Do **not** request administration or branch-protection write permissions merely
to inspect policy. Termbridge is a contributor, not the repository policy
administrator.

Subscribe minimally to:

- `installation`, `installation_repositories`, and permission changes;
- `pull_request`, `pull_request_review`, and `pull_request_review_thread`;
- `check_run`, `check_suite`, and/or `workflow_run` as actually used;
- `push` for Termbridge task branches;
- `merge_group` if merge queue support is enabled.

### 5.3 Webhook security and recovery

Verify `X-Hub-Signature-256` as HMAC-SHA256 over the raw UTF-8 body with a
constant-time comparison. Deduplicate with app plus `X-GitHub-Delivery`, inspect
`X-GitHub-Event` and payload `action`, persist the envelope, and return 2xx
within ten seconds
([validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries),
[best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)).

Unlike Linear and Jira, GitHub does **not** automatically redeliver failed
webhooks. A scheduled reconciler must list failed app webhook deliveries and
request redelivery, then fetch authoritative PR/check/ref state
([failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)).

### 5.4 Branch, PR, check, review, and merge policy

Host-side delivery must use compare-before-mutate:

1. resolve repository ID, default branch, and base OID;
2. create a deterministic task branch only if absent, or prove it maps to the
   same task and expected OID;
3. create commit objects or push using a repository-scoped installation token;
4. query for an existing PR by head/base before creating one;
5. create the PR as draft and store its immutable node/database ID and number;
6. publish a Termbridge check with test evidence and policy conclusions;
7. mark ready only after Termbridge verification passes;
8. observe review/check/ruleset/merge-queue state through webhooks plus
   reconciliation.

Creating a PR can trigger secondary content rate limits
([pull requests](https://docs.github.com/en/rest/pulls/pulls)).
GitHub App installation REST limits start at 5,000 requests/hour (15,000 for an
Enterprise Cloud organization), with separate secondary concurrency, point,
CPU, and content-generation limits. Honor `Retry-After` or reset headers and use
bounded exponential backoff
([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).

Rulesets and branch protection layer together; the most restrictive rule wins.
Required reviews may include code owners, latest-push approval, dismissed stale
approvals, unresolved requested changes, strict up-to-date branches, and
required checks from a specific app
([rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
[available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)).

Termbridge must never translate “API says mergeable” into “authorized to
merge.” Its merge precondition is:

```text
explicit Termbridge merge policy permits it
AND exact approved head OID is current
AND PR is not draft
AND GitHub reports all applicable rules satisfied
AND no cancellation/stop/revocation is pending
```

The default product outcome should remain a human-reviewed draft PR. Automatic
merge is a separately enabled, separately approved capability and must use
GitHub's normal merge/queue path, never a protection bypass.

## 6. Provider-neutral contracts

### 6.1 Capability matrix

| Capability | Linear | Jira Cloud | Provider-neutral requirement |
|---|---|---|---|
| App identity | OAuth `actor=app`; per-workspace app user | 3LO acts as granting user | expose `actorMode` and effective principal |
| Native agent delegation | Yes, mention/delegate + Agent Session; Developer Preview | Remote Agent via Forge; EAP, not production-ready | optional preview `native_agent_session` |
| Status trigger | Issue webhook + `updatedFrom` | JQL-filtered issue webhook | fetch-and-reconcile entry predicate |
| Label trigger | Issue/IssueLabel webhook | receive broader issue update; label absent from supported dynamic JQL subset | adapter-side policy predicate |
| Immutable user prompt stream | Agent Activities | No; comments editable | normalize into immutable Termbridge input record |
| Plan display | Agent Plan, technology preview | ADF comment/property projection | versioned plan artifact is authoritative |
| Approval UI | elicitation/select prompt | Termbridge link or restricted comment command | signed decision bound to actor and plan hash |
| Stop | native stop signal | configured comment/status action | high-priority cancellation capability |
| Progress | semantic activities | coalesced ADF comment | rate-aware projection |
| Attachments | private file storage/presigned upload | attachment REST resources | quarantined untrusted blob contract |
| PR link | AgentSession `externalUrls` | ADF comment + issue property/remote link | stable delivery projection |
| Webhook auth | raw-body HMAC + timestamp | bearer JWT signed by client secret | provider verifier before durable inbox |
| Delivery retry | 3 retries | up to 5 retries | always dedupe; also reconcile |
| Missed-event recovery | API reconciliation | failed-webhook API + reconciliation | provider cursor/sweep |
| Pagination | Relay cursors | REST pages (`startAt/maxResults`) | resumable page iterator |
| Rate error | GraphQL `RATELIMITED` in HTTP 400 | HTTP 429 + headers | normalized retry budget |
| Git delivery | N/A | N/A | GitHub App installation and policy adapter |

### 6.2 `TrackerAdapter`

```ts
interface TrackerAdapter {
  capabilities(ctx: TenantContext): Promise<TrackerCapabilities>;
  verifyWebhook(req: RawWebhookRequest): Promise<VerifiedTrackerEnvelope>;
  normalizeWebhook(event: VerifiedTrackerEnvelope): Promise<TrackerEvent[]>;
  reconcileIssue(ref: TrackerIssueRef): Promise<IssueSnapshot>;
  listContext(ref: TrackerIssueRef, cursor?: string): Promise<ContextPage>;
  fetchAttachment(ref: AttachmentRef): Promise<QuarantinedBlob>;
  publishPlan(ref: TaskRef, plan: VersionedArtifact): Promise<ProjectionRef>;
  requestDecision(ref: TaskRef, request: DecisionRequest): Promise<ProjectionRef>;
  publishProgress(ref: TaskRef, progress: ProgressProjection): Promise<ProjectionRef>;
  publishOutcome(ref: TaskRef, outcome: OutcomeProjection): Promise<ProjectionRef>;
  transition(ref: TaskRef, transition: TrackerTransition): Promise<ObservedIssueState>;
  renewSubscriptions(now: Instant): Promise<SubscriptionHealth[]>;
  sweep(cursor?: string): Promise<ReconciliationPage>;
}
```

Required normalized identities:

```text
provider, installation/tenant ID, issue immutable ID, issue display key,
event delivery ID, actor immutable ID, provider object version/update time,
provider comment/activity ID, and Termbridge causation ID
```

No adapter method should return “approval: true.” It returns an observed human
input. The policy service validates actor authority and creates the durable
`Approval` bound to the plan hash.

### 6.3 `ForgeAdapter`

```ts
interface ForgeAdapter {
  capabilities(installation: ForgeInstallationRef): Promise<ForgeCapabilities>;
  verifyWebhook(req: RawWebhookRequest): Promise<VerifiedForgeEnvelope>;
  normalizeWebhook(event: VerifiedForgeEnvelope): Promise<ForgeEvent[]>;
  inspectRepository(ref: RepositoryRef): Promise<RepositoryPolicySnapshot>;
  resolveBase(ref: RepositoryRef, base: string): Promise<GitOid>;
  ensureTaskBranch(spec: BranchSpec): Promise<ObservedBranch>;
  pushCommit(op: PushOperation): Promise<ObservedBranch>;
  ensureDraftPullRequest(spec: PullRequestSpec): Promise<PullRequestRef>;
  updatePullRequest(ref: PullRequestRef, patch: PullRequestPatch): Promise<PullRequestState>;
  publishCheck(spec: CheckSpec): Promise<CheckRef>;
  inspectDelivery(ref: PullRequestRef): Promise<DeliveryPolicyState>;
  requestMerge(op: MergeOperation): Promise<MergeObservation>;
  sweep(cursor?: string): Promise<ReconciliationPage>;
}
```

`ensure*` means inspect first and return the existing object only if its
Termbridge identity and canonical input hash match. It does not mean blind retry.
`pushCommit` and `requestMerge` remain operation-journal effects:
`prepared -> dispatched -> confirmed | uncertain`.

## 7. Idempotency, retries, and state synchronization

Providers do not offer one universal idempotency-key header for these workflows.
Termbridge needs application idempotency:

| Operation | Idempotency/recovery rule |
|---|---|
| Webhook intake | unique `(provider, tenant/installation, deliveryId)` |
| Queue task | unique `(provider, tenant, issueId, triggerGeneration)` |
| Tracker comment/activity | durable projection row; inspect provider object ID before retry |
| Tracker transition | refetch issue; no-op if desired state already observed |
| Git branch | deterministic name plus task marker and expected base/head OIDs |
| Commit/push | content OID and expected remote OID; uncertain dispatch pauses |
| PR creation | search exact repository/head/base; bind one PR ID to task |
| Check update | stable external ID/check ID; update, do not create progress spam |
| Merge | exact PR and head OID, explicit policy/approval; never replay uncertain merge |

All provider writes carry a Termbridge causation ID in the local journal and,
where safe, a provider property/body marker. Webhook handlers suppress feedback
loops by actor and causation marker, but still reconcile the provider object.

## 8. Security and operational implications

1. **Tenant isolation.** Key every record and cache by immutable provider tenant,
   installation, repository, and issue IDs. Issue keys, workspace names, org
   slugs, and repository names are display values, not isolation keys.
2. **Credential brokering.** OAuth refresh tokens, Linear tokens, GitHub private
   keys, and webhook secrets belong in a secret provider. Workers request
   single-task, short-lived credentials. Coding sessions receive no tracker or
   forge credential by default.
3. **Prompt injection boundary.** Issue bodies, comments, ADF, links, diffs, and
   attachments are untrusted model input. They cannot change repository
   allowlists, approval policy, sandbox policy, or credential scope.
4. **Approval separation.** Planning approval, runtime permission, credential
   use, push, ready-for-review, and merge are distinct authorities. A tracker
   transition is never an implicit merge approval.
5. **Webhook edge.** Preserve raw bytes until verification, reject oversized
   requests before parsing, apply per-provider timestamp/replay controls, journal
   accepted delivery IDs, and enqueue before provider deadlines.
6. **Outbound protection.** Allowlist provider hosts, block arbitrary URLs from
   issue content, validate redirects, cap attachment size, scan archives, and
   prevent server-side request forgery through link/attachment fetches.
7. **Revocation.** Installation removal, repository removal, Linear permission
   changes, OAuth revocation, and Jira 401/403 must freeze affected tasks and
   revoke cached credentials.
8. **Auditability.** Record policy version, principal, exact plan and code OIDs,
   provider inputs, decisions, operations, test evidence, and projections.
   Redact before persistence and egress.
9. **Backpressure.** Separate webhook admission from task scheduling. Enforce
   tenant/repository/CLI concurrency, API budgets, queue age alerts, webhook
   renewal health, reconciliation lag, and dead-letter review.

Atlassian's cloud-app security requirements explicitly require encrypted secret
storage, TLS 1.2+, HSTS, least privilege, and encryption at rest
([security requirements](https://developer.atlassian.com/platform/marketplace/security-requirements/)).
GitHub likewise recommends minimum permissions, secure private-key/token
storage, webhook secrets, recurring authorization checks, and data deletion
([GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)).

## 9. Complete end-to-end test program

### Local deterministic tests

- canonical provider envelope fixtures, including malformed, oversized,
  wrong-signature, stale timestamp, duplicate, reordered, and unknown-action
  cases;
- OAuth state, token rotation, refresh serialization, revocation, and
  least-privilege capability tests;
- pagination and rate-limit fault injection;
- status/label entry and exit, self-event suppression, and duplicate task claim;
- plan-hash approval, wrong actor, changed plan, edited comment, stop race, and
  stale worker fencing;
- ADF and Linear activity rendering;
- provider contract tests against fake adapters;
- operation-journal crash tests at every dispatch/confirmation boundary.

### Real-provider integration environments

- dedicated Linear development workspace and OAuth app, with native-agent
  preview enabled only for the test installation;
- dedicated Jira Cloud development site with representative company/team
  projects, workflows, permissions, issue security, comments, and attachments;
- private GitHub App owned by a test organization, installed on fixture
  repositories with ruleset variants;
- separate webhook URLs/secrets, OAuth clients, KMS keys, databases, queues, and
  object storage for development, staging, and production.

Linear's documentation recommends a dedicated workspace for managing the OAuth
application, but does not document a separate sandbox product
([OAuth](https://linear.app/developers/oauth-2-0-authentication)).
GitHub private apps are limited to their owning account, which is useful for the
test organization
([GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)).

### Required end-to-end scenarios

1. Linear delegation -> plan -> exact-plan approval -> worktree -> tests ->
   draft PR -> check -> human review -> completion projection.
2. Linear select/request-changes, follow-up prompt, and stop while executing.
3. Linear label fallback and duplicate/reordered delivery.
4. Jira status trigger and Jira label trigger -> ADF plan -> approval link ->
   draft PR.
5. Jira webhook expiry/renewal, failed delivery recovery, rotating refresh
   token, lost transition permission, and attachment quarantine.
6. GitHub installation/repository revoked mid-task.
7. Existing branch/PR after daemon crash, push response lost, and PR-create
   response lost.
8. Required checks, stale approval, code-owner review, strict update branch,
   merge queue, requested changes, and ruleset conflict.
9. Database/queue/worker/sandbox failure at each task phase, including a stale
   fenced worker attempting a provider write.
10. Cross-tenant forged IDs, malicious issue instructions, SSRF links, archive
    bombs, and secret-leak assertions.

Stable release requires zero security, approval, isolation, wrong-repository,
uncertain-replay, or merge-policy violations. Success-rate benchmarks are useful
for model execution quality but cannot average away these invariants.

## 10. Roadmap/design-ready recommendations

1. **Add a provider-control-plane design gate before Phase 4 implementation.**
   Freeze the normalized identities, webhook inbox, projection ledger,
   approval record, adapter capabilities, and recovery semantics.
2. **Make Linear native-agent integration the primary Linear experience, with a
   stable issue/comment fallback.** Explicitly mark Agent Session and Agent Plan
   capabilities preview and fail soft when schemas drift.
3. **Promote Jira from “deferred adapter” to a parallel Phase 4B workstream, not
   the first pilot.** Its OAuth principal model, expiring webhooks, ADF, workflow
   variability, and label-trigger limitation merit a separate live pilot. Keep
   Jira Remote Agents behind an experimental capability flag until Atlassian
   makes the surface production-supported.
4. **Replace in-session GitHub delivery with a GitHub App before claiming
   autonomous platform readiness.** Branch, push, PR, checks, and merge
   inspection must be host-side journaled operations.
5. **Default the product outcome to a draft PR.** Human review and repository
   policy remain authoritative. Ship automatic merge later as an opt-in policy
   with its own security review and fault suite.
6. **Store approval in Termbridge, project it into trackers.** Bind every
   approval to immutable tenant, actor, task, plan ID, and plan hash. Never infer
   implementation authority from status or label alone.
7. **Implement one webhook ingress framework with provider verifiers.** It must
   persist verified raw envelopes, dedupe, acknowledge within provider
   deadlines, enqueue, and reconcile. GitHub needs proactive failed-delivery
   recovery; Jira needs renewal and failed-hook sweeps; Linear needs disabled-
   hook health.
8. **Create three versioned fixture repositories and a policy matrix before the
   first live pilot:** permissive, protected/review-required, and merge-queue/
   strict-check. Exercise both Git REST delivery and normal Git push behavior.
9. **Do not broaden sandbox authority to simplify integration.** The coding CLI
   consumes sanitized context and edits the managed worktree; provider adapters
   alone hold outbound credentials.
10. **Release in four vertical slices:**
    - webhook inbox + Linear native planning/progress;
    - GitHub App draft PR/check delivery;
    - complete Linear-to-GitHub pilot and recovery suite;
    - Jira-to-GitHub pilot, followed only then by opt-in automatic merge.

## Primary-source index

### Linear

- [OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)
- [OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization)
- [Agent setup](https://linear.app/developers/agents)
- [Agent interaction and plans](https://linear.app/developers/agent-interaction)
- [Agent signals](https://linear.app/developers/agent-signals)
- [Agent best practices](https://linear.app/developers/agent-best-practices)
- [Webhooks](https://linear.app/developers/webhooks)
- [Pagination](https://linear.app/developers/pagination)
- [Rate limiting](https://linear.app/developers/rate-limiting)
- [File upload](https://linear.app/developers/how-to-upload-a-file-to-linear)

### Atlassian/Jira

- [OAuth 2.0 (3LO)](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/)
- [Jira OAuth scopes](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/)
- [Jira webhooks](https://developer.atlassian.com/cloud/jira/software/webhooks/)
- [Webhook REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/)
- [Jira REST v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)
- [Issues/transitions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/)
- [Attachments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/)
- [Issue properties](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/)
- [Rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)
- [Forge environments](https://developer.atlassian.com/platform/forge/environments-and-versions/)
- [Remote Agents in Jira (EAP)](https://developer.atlassian.com/platform/forge/remote-agents-in-jira/)
- [Cloud-app security requirements](https://developer.atlassian.com/platform/marketplace/security-requirements/)

### GitHub

- [About GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)
- [GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [Installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- [Failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [Pull request API](https://docs.github.com/en/rest/pulls/pulls)
- [Review API](https://docs.github.com/en/rest/pulls/reviews)
- [Checks API](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks)
- [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
