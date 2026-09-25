# Control-plane product contract

Status: executable target for the control-plane rewrite  
Contract date: 2026-09-24  
Applies to: the ordinary-user OpenClaw catalog and every change created through it

This document defines the public product boundary. It is normative: the acceptance tests in `tests/control-plane-contract.test.mjs` pin this contract, and implementation details must not weaken it.

## 1. Product promise

An ordinary user performs one bounded change through four operations only:

1. `harness_prepare_change` — turn a request into a reviewable, immutable proposal without starting implementation.
2. `harness_confirm_change` — authorize that exact proposal once through a trusted host attestation and start it.
3. `harness_change_result` — read a stable, user-safe status or terminal result; the caller never polls internal phases.
4. `harness_merge_change` — authorize and perform one merge through a new, separate trusted host attestation.

No direct command or interactive session-management operation is present in the ordinary-user catalog.

Administrative diagnostics and migration controls may exist only on an explicitly privileged host surface. They are not aliases for the four user operations and must not be discoverable in an ordinary-user tool catalog.

## 2. Exact user flow

### 2.1 Prepare

The user asks for a repository change. The host supplies the authenticated actor and conversation; neither is accepted as a caller-controlled argument.

`harness_prepare_change` validates the repository, request, policy, budget, time, path/scope, credentials, and security envelope before creating a proposal. Preparation may use read-only discovery but must not create a branch, mutate a worktree, invoke implementation/review agents, push, open or update a PR, or incur material execution spend.

Success returns a single review object:

```json
{
  "ok": true,
  "changeId": "chg_…",
  "state": "prepared",
  "summary": "…",
  "brief": {
    "title": "…",
    "motivation": "…",
    "acceptanceCriteria": ["…"],
    "filesLikelyTouched": ["src/**", "tests/**"],
    "outOfScope": ["secrets/**"],
    "repoHint": "owner/name",
    "branchHint": "existing-feature-branch",
    "riskLevel": "medium",
    "relevantConcepts": [
      {
        "id": "services/retry",
        "path": "src/retry.ts",
        "summary": "Retry policy and invariants",
        "tags": ["reliability"],
        "content": "Optional bounded reference text"
      }
    ]
  },
  "repository": "owner/name",
  "baseRef": "main",
  "baseRevision": "0123456789abcdef…",
  "scope": ["src/**", "tests/**"],
  "excludedScope": ["secrets/**"],
  "allowedActions": ["implement", "retry", "repair", "test", "commit", "push_feature_branch", "open_pull_request", "update_pull_request", "deploy"],
  "budget": { "currency": "USD", "maximum": "12.00" },
  "timeLimitSeconds": 3600,
  "limits": { "cycles": 3, "retries": 10 },
  "risk": "medium",
  "assumptions": [],
  "contract": { "policyVersion": "control-plane-contract/v2", "minimumRuntimeVersion": "2.0.0-rc.13" },
  "confirmation": {
    "expiresAt": "2026-09-24T08:33:00.000Z",
    "reviewDigest": "0123456789abcdef…"
  }
}
```

The persisted and reviewed brief schema is exactly:

- `title`: required non-empty string.
- `motivation`: required non-empty string.
- `acceptanceCriteria`: required non-empty array of non-empty strings.
- `filesLikelyTouched`: required array of non-empty repository-relative path strings. Either it or an explicit `scope` argument must contain at least one path; preparation never widens an empty scope to `**/*`.
- `outOfScope`: required array of non-empty repository-relative path strings; the array may be empty.
- `repoHint`: canonical authenticated `owner/name` repository identity.
- `branchHint`: optional non-empty string naming an existing branch to continue.
- `riskLevel`: required `low`, `medium`, or `high`.
- `relevantConcepts`: optional array. Every entry requires a non-empty `id`; optional `path`, `summary`, and `content` are non-empty strings, and optional `tags` is an array of non-empty strings.

Malformed arrays or entries refuse preparation deterministically; they are never coerced, filtered, or treated as empty. `branchHint` and the complete `relevantConcepts` entries are persisted in `brief_json`, displayed for review, included in the canonical brief digest, and therefore bound by `confirmation.reviewDigest`.

The returned `brief` is the exact canonical brief persisted and executed. Model-produced properties outside the documented brief schema are stripped before persistence, digesting, and display. The response contains no internal prompt, session/subtask identifier, clarification identifier, polling direction, or harness command.

OpenClaw resolves ordinary ambiguity before returning this object. It chooses the smallest reversible repository change, prefers code plus deterministic tests over documentation or one-off live operations, performs no live external side effect during preparation, and treats the authenticated `repository` argument as authoritative. A legacy model response containing competing readings is reduced deterministically to its first ranked bounded repository interpretation and those internal fields are discarded.

Validation failure is terminal for that prepare attempt. It is reserved for a non-change request, a genuine safety refusal, invalid configuration, or an unavailable authenticated repository binding. It returns one stable error code and a user-remediable summary; ambiguity never creates a harness pause.

### 2.2 Confirm

The user confirms the proposal in normal conversational language in the same authenticated conversation; examples include `Confirm Smoke`, `yes, run that README smoke`, and `looks good, go ahead`. The plugin observes OpenClaw's typed `message_received` hook and independently recognizes a bounded positive authorization phrase after normalizing harmless Markdown. A process-local broker resolves exactly one pending change, binds the host-observed sender, channel/account/conversation/thread, message ID, timestamp, operation, nonce, and current review digest, and permits one matching tool call for at most 60 seconds. The tool call must carry the same host event ID as the raw inbound message, so an agent cannot reuse an older approval or invent approval in model/tool arguments. The public tool input carries only `changeId`; users never need to type it. Missing hooks/events, nested/runtime/subagent messages, questions, ambiguous or negated prose, stale state, replay, identity/event/conversation mismatch, and unknown material modifiers fail closed.

A confirmation attestation binds all of the following values exactly:

- operation kind: `confirm_change`;
- actor identity;
- conversation identity, including channel/workspace or equivalent tenant boundary;
- `changeId`;
- repository identity and immutable base revision;
- canonical brief digest;
- effective policy digest;
- exact budget and time envelope;
- allowed and excluded scope/path digest;
- credential route identity without secret material;
- security/risk classification;
- proposal generation/version;
- expiry;
- unique host event/message identity and one-use nonce.

`confirmation.reviewDigest` binds the complete immutable proposal, including the displayed brief, scope, exclusions, actions, limits, risk, assumptions, repository/base revision, policy/runtime contract, credential-route digest, generation, and expiry. At hook time the broker recomputes that digest from current state and combines it with independently authenticated event metadata to create the attestation `bindingDigest`. If the message includes budget, time, scope, or excluded-scope modifiers, each must exactly equal the prepared state; otherwise no broker record is minted.

Both digests are domain-separated and versioned:

```text
reviewDigest = SHA-256("control-plane-confirm/v2\n" + canonical-json(immutableProposal))
bindingDigest = SHA-256("control-plane-confirm/v2\n" + canonical-json({
  reviewDigest,
  attestation: { version, provenance, operation, actorIdentity, conversationIdentity,
                 hostEventId, nonce, issuedAt, expiresAt }
}))
```

Canonical JSON uses UTF-8, sorted object keys, preserved array order, integers for time values, decimal strings for money, normalized repository/base identities, and no omitted-vs-null ambiguity.

Confirmation is an atomic compare-and-swap from `prepared` to the internal autonomous execution state, exposed publicly as `running`. The attestation is consumed in the same transaction as the state transition and durable execution intent. A replay, expired receipt, changed proposal, changed base revision, wrong actor, wrong conversation, wrong repository, wrong operation, or already-consumed nonce fails closed and starts no work.

A successful response is concise:

```json
{
  "ok": true,
  "changeId": "chg_…",
  "state": "running",
  "summary": "Change confirmed and running autonomously."
}
```

There is no post-confirmation `awaiting_clarification` path. Confirmation is the final human decision before a terminal result.

### 2.3 Result

`harness_change_result` is idempotent and safe to call at any time. It returns one of these product states:

- `prepared` — waiting for the one confirmation;
- `running` — confirmation is durably committed and implementation/review/publication is queued or active;
- `pr_ready` — terminal success, PR proven ready under section 6;
- `merging` — the separately authorized merge is being durably reconciled;
- `failed` — terminal failure with no hidden question or resumable user decision;
- `merged` — terminal merge success;
- `merge_failed` — terminal merge failure.

The ordinary-user result surface is a read, not a progress protocol. It may provide a coarse state, short summary, timestamps, safe spend totals, PR link, and readiness/merge outcome. It must not expose internal phases, plans, prompts, subtask identities, clarification identities, attempts/retries, worker/model routing, polling instructions, command syntax, database/worktree paths, raw logs, credentials, or stack traces.

The host may deliver lifecycle notifications. Correctness cannot depend on a user or agent polling.

### 2.4 Merge

`pr_ready` does not merge automatically. The user makes a second decision after seeing the PR-ready result. The host mints a new attestation for operation kind `merge_change`.

The merge attestation is distinct from the confirmation attestation and binds:

- actor and conversation identities;
- `changeId`, repository, PR number, and merge method;
- exact current PR head SHA;
- exact published SHA from the readiness record;
- readiness record digest and policy version;
- required CI/runtime evidence digests;
- expiry, host event/message identity, and a fresh one-use nonce.

A prepare/confirmation receipt can never authorize merge. A merge receipt can never authorize execution. Merge revalidates the current PR head and every readiness predicate immediately before mutation. The nonce is consumed atomically with merge intent. Concurrent or repeated merge calls produce at most one provider merge request and then return the already-known outcome.

## 3. Authority envelope

### 3.1 Trusted values

Only the host may attest actor, tenant/workspace, conversation, authorization, message/event identity, and receipt authenticity. Public parameters such as `invokedBy`, `requester`, `trustedHuman`, `senderIsOwner`, `channel`, or raw command text are not authority.

The control plane verifies that the attesting host is configured and trusted for this installation. Missing host provenance fails closed.

### 3.2 Change authority

One confirmation authorizes exactly one immutable change envelope. It does not authorize:

- a different repository, base, brief, policy, budget, time limit, scope, or credential route;
- a scope expansion discovered after confirmation;
- destructive, privileged, security-sensitive, or credential-affecting work not present in the proposal;
- an interactive clarification, workaround, retry with broader permissions, or policy exception;
- merge.

Any required expansion creates a terminal `failed` result. The user may prepare a new change from a newly stated request; the old confirmation is never amended or reinterpreted.

### 3.3 Internal authority

Workers receive least privilege and only the confirmed envelope. They cannot push, merge, alter policy/budget, obtain additional credentials, broaden paths, answer approval questions, or create user-facing control decisions. The controller is the sole state-transition writer and uses durable compare-and-swap transitions.

## 4. State machine

```text
                  prepare validation error
              +-----------------------------> failed
              |
request -> preparing -> prepared
                         |   |
          expiry/cancel  |   | trusted confirmation + CAS
                         |   v
                         +----------> running
                                          |  |
                     any terminal fault   |  | readiness predicates all true
                                          v  v
                                        failed  pr_ready
                                                   |  |
                             merge refusal/fault   |  | trusted merge attestation + CAS
                                                   v  v
                                            merge_failed  merged
```

Normative transition table:

| From | Event | Preconditions | To | Side effect |
|---|---|---|---|---|
| none | prepare | validation succeeds | prepared | persist immutable proposal |
| none/preparing | validation failure | any envelope check fails | failed | persist safe failure |
| prepared | confirm | trusted, exact, fresh, unused attestation; CAS wins | running | persist consumed nonce and durable execution intent atomically; dispatch is recovered from that intent |
| prepared | expire/cancel | CAS wins | failed | no execution |
| running | readiness success | every section 6 predicate is true | pr_ready | persist immutable readiness record |
| running | any bounded fault/escalation | predicate fails or envelope exhausted | failed | stop; preserve recovery evidence |
| pr_ready | merge | separate trusted attestation; readiness revalidated; CAS wins | merged | at most one provider merge |
| pr_ready | merge refusal/failure | stale head, bad attestation, failed gate/provider | merge_failed | no retry requiring user clarification |

There are no transitions from `running` back to `prepared`, and none to `awaiting_clarification`, `paused`, `resumable`, or `needs_input`.

`prepared`, `running`, `failed`, `pr_ready`, `merged`, and `merge_failed` are durable across process restart. `running` is recovered from durable intent/lease records, not from in-memory promises.

## 5. Failure and escalation rules

After confirmation, every inability to stay within the confirmed envelope is terminal. The following become `failed`, never a question:

- budget would be exceeded or additional budget is desired;
- time limit is reached or more time is desired;
- requested work requires broader file/path/repository scope;
- a security boundary, policy, protected path, or destructive action blocks work;
- a new or stronger credential, token, org route, permission, or login is required;
- an agent refuses, stalls, crashes, produces ambiguous output, or requests human judgment;
- required CI/runtime evidence is unavailable;
- branch/PR/base/head state becomes stale or conflicting;
- recovery cannot prove exactly-once continuation.

The terminal result states what failed, whether any PR/branch exists, whether remote publication was proven, safe spend totals, and the next user action at product level (for example, “prepare a new change with a larger scope”). It never instructs the user to call an internal tool or command.

## 6. PR-ready predicate

`pr_ready` is minted only when one immutable readiness record proves all conditions simultaneously:

1. Final adversarial verdict is exactly `pass`.
2. Open blocking findings count is exactly zero under the effective policy; no `revise`, `block`, `needs_human_review`, unknown, or missing verdict qualifies.
3. The candidate commit SHA is known.
4. Remote publication was read back and proves that exact candidate SHA.
5. The PR is open, belongs to the confirmed repository/base/head branch, and its current head SHA exactly equals the published candidate SHA.
6. Every required CI check for that exact SHA is present and successful. Pending, absent, neutral when success is required, skipped when required, stale, unreadable, or unknown evidence fails closed.
7. Required runtime/deployment evidence exists, is successful, belongs to the exact SHA/environment, and is fresh under policy. If policy declares no runtime evidence required, the readiness record says so explicitly.
8. Total spend is at or below the confirmed session budget and all applicable user/daily ceilings.
9. Elapsed active time is within the confirmed time envelope.
10. Changed paths and performed operations remain within confirmed scope and security policy.
11. Credential usage matches the confirmed credential route and no secret exposure is detected.
12. The readiness record itself is versioned, content-addressed, and stored atomically with `pr_ready`.

Any uncertainty is non-readiness. A recommendation, existing PR URL, local commit, successful push call, stale CI result, or human willingness to merge is not a substitute for evidence.

Immediately before merge, all mutable predicates—especially current PR head, PR open state, required CI, runtime evidence freshness, and policy—are re-read. A changed head invalidates readiness and yields `merge_failed`; it is never silently accepted.

## 7. Restart, concurrency, and exactly-once behavior

- **Restart after prepare:** the same proposal and digest remain confirmable until expiry. No new proposal is inferred.
- **Restart after confirmation commit:** durable execution intent is claimed once; confirmation is not requested again.
- **Crash before confirmation commit:** no execution intent exists; the receipt remains unused or expires according to the transaction outcome.
- **Crash after nonce consumption but before dispatch:** the atomic transaction includes execution intent, so restart dispatches it once.
- **Concurrent confirmations:** one compare-and-swap wins; all others return `already_confirmed` or `attestation_consumed` and start no duplicate work.
- **Stale confirmation:** any bound-state mismatch returns `stale_confirmation`; state remains unchanged.
- **Lease loss during execution:** a new controller may resume only from a verified durable checkpoint whose change/envelope digest matches. Otherwise the change fails terminally.
- **Restart at PR-ready:** the readiness record survives; merge still requires a fresh merge attestation and live revalidation.
- **Concurrent/double merge:** one merge-intent CAS wins and at most one provider mutation occurs. Later calls return the persisted merged result or a stable in-progress outcome.
- **Provider ambiguity:** if the merge request outcome is unknown after a crash/timeout, recovery reads provider state by repository, PR, expected head, and idempotency record before retrying. It never blindly sends a second merge.

All state-changing operations carry a monotonically increasing generation or equivalent row version. Updates name the expected state and generation. A zero-row update is a conflict, not success.

## 8. Recovery

Recovery is automatic and bounded; it is not exposed as a normal user operation.

At startup the controller:

1. validates schema and control-plane contract version;
2. reconciles nonterminal changes with durable intents, leases, checkpoints, repository state, publication evidence, PR state, and provider idempotency records;
3. resumes only work whose exact envelope and checkpoint integrity can be proven;
4. marks every ambiguous, out-of-envelope, or unrecoverable change `failed` with a safe recovery reason;
5. re-emits user lifecycle notifications when necessary without duplicating state transitions.

There is no ordinary-user `resume`. Preparing a new change is the only way to authorize a materially different attempt.

## 9. Migration

Migration from rc.13 is one-way and fail-closed.

- New tables/records use an explicit control-plane schema and contract version.
- Existing rc.13 sessions remain readable through a privileged legacy diagnostic surface, but are never made confirmable or mergeable through the new four-operation API merely by mapping status names.
- An unstarted rc.13 proposal may be imported only as a new `prepared` change after recomputing the full binding envelope; it requires a new host confirmation attestation.
- A running, paused, resumable, or `awaiting_clarification` rc.13 session is terminalized as legacy/non-authorizable for the new surface. It cannot inherit a prior answer receipt.
- An rc.13 PR may become a new prepared merge candidate only after the controller rebuilds all readiness evidence against the current PR head; merge still requires a fresh merge attestation.
- Legacy `a new prepared change`, progress, resume, revise, and list-revisable entry points are removed from the ordinary catalog before the new catalog is enabled.
- Migration is transactional, restart-safe, idempotent, and records source identifiers only in privileged audit data.
- Rollback must not reactivate consumed attestations or expose both old and new authority paths concurrently.

## 10. Privacy and user-safe reporting

### 10.1 Ordinary-user surface

Allowed fields are limited to product identifiers, coarse state, concise summary, repository/base, confirmed envelope summary, safe timestamps, aggregate spend, PR URL/number, exact published/head SHA when useful, readiness checks summarized by category, and stable error code.

The following are forbidden from ordinary tool schemas, descriptions, content, details, notifications, and errors:

- system/developer/agent prompts or prompt fragments;
- raw model messages, chain-of-thought, plans, or hidden reasoning;
- clarification IDs/questions, internal session IDs, subtask IDs/titles, worker identities, or model routes;
- retries, attempt counters, watchdog internals, polling intervals/instructions, or harness command/tool names;
- local worktree, database, log, credential-service, vault, or secret paths;
- tokens, credentials, authorization headers, environment values, or raw provider responses;
- stack traces and unredacted logs.

`changeId` is the only ordinary correlation identifier. PR identifiers are allowed once they exist.

### 10.2 Privileged audit surface

Privileged audit records may retain internal correlation identifiers and structured evidence required for incident response, subject to retention policy and access control. They still never store secret values, raw authorization headers, or unnecessary prompt bodies. User-visible redaction happens by constructing a separate allow-listed representation, not by best-effort removal from an internal object.

## 11. Stable error codes

The four operations use stable product codes, including:

- `invalid_request`, `repository_not_allowed`, `policy_rejected`, `scope_rejected`, `credential_unavailable`;
- `confirmation_required`, `confirmation_expired`, `confirmation_replayed`, `wrong_actor`, `wrong_conversation`, `stale_confirmation`;
- `budget_exceeded`, `time_exceeded`, `scope_escalation`, `path_violation`, `security_escalation`, `credential_escalation`;
- `execution_failed`, `verification_failed`, `publication_unproven`, `ci_not_ready`, `runtime_evidence_missing`;
- `not_pr_ready`, `stale_pr_head`, `merge_attestation_required`, `merge_attestation_replayed`, `merge_failed`;
- `already_confirmed`, `already_merged`, `conflict`.

Errors are safe, concise, and deterministic. Internal exception strings are logged only on the privileged surface.

## 12. Acceptance boundary

The rewrite is acceptable only when the black-box contract tests pass against the packaged registration and source contract, existing tests are reconciled to the new authority model, and no compatibility shim re-exposes the retired ordinary-user operations. Production implementation, manifest changes, generated `dist`, installation, restart, and smoke verification are deliberately outside the documentation/test-only change that introduced this contract.
