# Operations

Day-to-day and maintenance work for a running harness.

## Retention pruning

The audit log is append-only. Prune once a day.

### Programmatic

```ts
import { pruneRetention } from "openclaw-agent-harness/dist/state/retention.js";
import { openStateStore } from "openclaw-agent-harness/dist/state/store.js";

const store = await openStateStore("~/.openclaw/workspace/openclaw-agent-harness/state.db");
const result = pruneRetention(store, {
  auditRetentionDays: 90,
  pruneTerminalSessions: false,
});
console.log(result);
store.close();
```

### As an OpenClaw cron

Add to `openclaw.json`:

```json
{
  "crons": {
    "openclaw-agent-harness.retention": {
      "schedule": "5 3 * * *",
      "prompt": "Run harness retention prune. Invoke the harness_retention_prune tool with { auditRetentionDays: 90 } and post the result to the audit log.",
      "model": "sonnet",
      "channel": null
    }
  }
}
```

## Backups

The state DB is small (KB-MB range). Backup with `sqlite3 state.db .backup /path/to/backup.db` daily. If you use OpenClaw's memory backup cron, add this file to the manifest.

## Session recovery

If the container is restarted mid-session:

1. On next boot, the harness scans `sessions` for non-terminal rows:
   `crystallising`, `planning`, `executing`, `reviewing` and `resumable`.
2. **Fresh sessions are auto-resumed.** In tool-driven mode there is no reaction
   poller and no Slack listener, so nothing would ever act on a "resume?" prompt —
   a session parked awaiting confirmation would simply go quiet forever. Recovery
   therefore re-drives the loop itself rather than asking.
3. Only **stale** sessions — past the heartbeat threshold — are marked
   `interrupted` and surfaced for a human. Resume those deliberately with
   `harness_resume`.
4. Resuming uses `sessions.last_worker_sdk_session` (written at every checkpoint)
   to continue the last worker via the SDK's `resume()`.
5. If no per-worker session exists (interrupted during planning), the harness
   resumes from the crystallised prompt with the lead replay path.

## Recovering a PR whose session failed

A session writes `pr_number` on the ship path only. A run that pushed its work,
opened a pull request and *then* failed holds neither the number nor the URL, so
`harness_revise` refuses it ("has no PR/branch to revise") and the PR is
unreachable by the one workflow built to change it.

`harness_link_pr` records the association after the fact. It is deliberately
two-phase and read-only by default.

**1. Dry run.** Writes nothing.

```
harness_link_pr {
  sessionId:  "112673df-68e0-4846-ae97-30121ea2c02d",
  repo:       "Stitch-Vercel/StitchGuard",
  prNumber:   1168,
  invokedBy:  "U…"            // must be in slack.authorised_users
}
```

It reports the proposed association, the evidence, and any blockers. Read the
evidence rather than the verdict: the check that matters is the commit-lineage
line, because everything else can be true of a PR that is not this session's.

**2. Apply.** Requires the head sha the dry run reported.

```
harness_link_pr { …as above…, apply: true, expectedHeadSha: "1410e98d…" }
```

The apply re-reads the PR and re-runs the whole verification. If the head moved
in between — someone pushed, or the branch was force-pushed — it refuses, because
the evidence you approved is no longer the evidence in front of it.

### What it verifies

`repo` is required and must match the repository the session ran against: a PR
number is only unique *within* a repository. Beyond that it checks the head
repository (a fork is refused, since the harness cannot push a revision to one),
the head branch, the base branch, that the PR is open and unmerged, and — the
one that carries the weight — that commit shas the session's own sub-task ledger
recorded are actually present on the PR.

A matching branch name is explicitly **not** sufficient. Harness branches embed
the session id, so name-matching would appear to work while accepting a branch
that had been force-pushed over unrelated work.

### Failure messages, and what each means

| Blocker | What happened | What to do |
| --- | --- | --- |
| `repo_mismatch` | The request names a different repository than the session ran against. | Check the session id; nothing about the PR can resolve this. |
| `head_repo_mismatch` | The PR's head is a fork, or the head repository was deleted. | Not recoverable. A revision cannot push to a fork head. |
| `branch_mismatch` | The PR's head branch is not the branch the session pushed. | Confirm you have the right PR. |
| `base_mismatch` | The PR targets a base other than `repos.default_base_branch`. | Retarget the PR, or accept that a revision would be reviewed against the wrong base. |
| `not_open` / `merged` | The PR is closed, or already merged. | Reopen it first. The harness will not reopen a PR for you, and a merged PR has nothing to revise. |
| `no_session_commits` | The session's ledger records no commit shas at all. | Not recoverable: there is no evidence tying the session to any PR. |
| `lineage_mismatch` | None of the session's recorded commits are on the PR. | Usually a force-push, or the wrong PR. Check the branch history. |
| `base_sha_mismatch` | The PR forks from a different commit than the session planned against. | The PR was built on a different base; confirm it is the right one. |
| `conflicting_link` | The session already points at another PR, or this PR is already recovered onto another session. | Deliberately not overridable. Unlinking is not offered. |
| `head_moved` | The PR head changed between the dry run and the apply. | Re-run the dry run and read the evidence again. |

A provider error (404, 503, an expired token) is reported as *"no evidence to
link on"* rather than as a mismatch. Absence of evidence is never treated as
permission.

### What linking does not do

It does not start a run, push a commit, create or merge a PR, or touch any other
session. It leaves `status`, the review findings, the spend and the cycle count
exactly as the failure left them, and it does not write a merge recommendation —
so a recovered PR still reads as `do_not_merge` at the merge gate.

A recovered session becomes visible to `harness_list_revisable` (with
`status: "failed"`, `linkState: "recovered"` and `reviewed: false`) and can be
revised in the normal way. The revision checks out the existing branch at its
tip and updates the same PR.

If the session never got as far as a review, the revise brief says the PR is
**unreviewed** rather than reporting zero findings, and a full adversary review
runs at the end of the cycle. An unreviewed PR is not an approved one.

### Revise the linked PR before deleting its branch

The link is verified against the PR as it stands when you apply it, and an open
PR guarantees its head branch exists at that moment. The revise, which may come
later, checks out `origin/<branch>`; if the branch has been deleted in between,
the checkout falls back to the base branch and the revise builds from there
instead of from the PR head. That fallback is recorded as `reset_to_base` in the
worktree decision log — if you see it on a revise you expected to continue a PR,
stop and check whether the branch still exists rather than letting the run push.

## Cost forensics

To investigate a cost spike:

```sql
-- Top 20 most expensive sessions this month
SELECT id, requester, repo, cost_usd, cycles_ran, created_at
FROM sessions
WHERE created_at > strftime('%s','now','start of month') * 1000
ORDER BY cost_usd DESC
LIMIT 20;

-- Per-user monthly spend
SELECT month, user, spent_usd FROM budgets_monthly ORDER BY month DESC, spent_usd DESC;

-- Audit log for a session
SELECT event, payload, datetime(created_at/1000, 'unixepoch') AS ts
FROM audit_log WHERE session_id = ? ORDER BY id ASC;
```

## PAT cache lifecycle

At session start the harness fetches each required PAT from its own credential vault (`CredentialVault`, via `CredentialAdapter`) and caches it in-process (a plain `Map`, per-runtime, not persisted). Cached tokens live for the lifetime of the session and are dropped by `teardown()` when the session terminates.

Implication for long-running sessions: **there is no TTL**. If a PAT is rotated in the vault mid-session, the cached value continues to be used until the session ends. For rotations that must take effect on an active session, either:

- End the session (`harness_cancel`) so `teardown()` purges the cache, then start a new one; or
- Call `creds.drop(<service>)` programmatically from the runtime to force a re-fetch on next use.

Tokens are never persisted to disk by the credentials adapter, never written to `.git/config`, and never appear in the process argv (git operations use short-lived `x-access-token` URLs).

## Tuning the reviewer's start-up deadline

The three watchdogs around a model turn measure different things and are tuned
separately. Raising the wrong one changes nothing, which is worth knowing before
you start.

| Setting | Bounds | Fires when |
| --- | --- | --- |
| `loop.sdk_stream_open_timeout_seconds` | 10–600, default 120 | the backend was launched but never opened its stream |
| `loop.sdk_first_token_timeout_seconds` | 10–1800, default 30 | the stream opened but no token arrived |
| `loop.adversary_timeout_seconds` | default 900 | the whole review exceeded its budget |

The overall budget is the hard limit. The two phase deadlines sit inside it and
cannot extend it, so setting a first-token window larger than the overall one
just means the overall one fires first.

**Which to raise.** Read the failure message; as of rc.4 it names the phase and
the deadline it was actually given. "The backend opened its stream but produced
no token within 30s" is the first-token window. "The backend never opened its
stream" is the stream-open window, which is usually a launch or credentials
problem rather than a slow model. A structured role running on the Claude Code
SDK has no first-token phase at all — text arrives only when the turn completes
— so for those roles the first-token setting does nothing and stream-open is the
one to raise.

Changes take effect on the next run; no restart is needed beyond the harness
picking up its configuration. Nothing needs to be re-linked or resumed.

**One caveat if you are reading old logs.** Before rc.4 this setting reached the
worker roles but not the six structured ones, so a reviewer on an ACP backend
always used a hard-coded 30 seconds no matter what the config said. A log line
reporting a 30-second first-token timeout from before rc.4 is not evidence about
your configured value, because your configured value was never consulted.

## Troubleshooting

- **The adversary timed out before its first token**: the review failed closed and nothing shipped — this is not a review that passed, and the session keeps its worktree. Raise `loop.sdk_first_token_timeout_seconds` (see above) if the backend is merely slow to start; if it never opened its stream, check the backend's launch and credentials instead. The harness will not retry a timeout as a formatting problem, so repeated identical timeouts mean the backend, not the prompt.
- **PAT push rejected with 403 (SAML)**: the org enforces SAML SSO. Authorise the PAT in the org's PAT settings, then retry. Alternative: emit `git format-patch` to a workspace directory and apply locally (see MEMORY.md).
- **Vercel logs empty**: preview deploy has not landed yet. Adversary receives an explicit "NO RUNTIME DATA" banner and will not sign off on runtime concerns. Wait or increase `previewWaitSeconds`.
- **Session stuck in `crystallising`**: user never replied. Manually mark `aborted` in `sessions` or let the harness time out (default 24h).
- **Budget refuses new session**: check `budgets_monthly` for the user. Override with a `moneybag` reaction (audit-logged) or bump the config cap.
