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

## Published, approved, and unpublished

These are three different things, and until rc.5 the harness could report the
third as the first.

**Published** means a commit is on the remote branch, proven by reading the
branch tip back after the push. **Approved** means a human decided to merge it;
the harness never claims this. **Unpublished** means the run's commits exist
only in its worktree — the run is *not* shipped, whatever else succeeded.

### What went wrong before rc.5

Stitch-Vercel/StitchGuard PR #1168. Two revision sessions built 24 and 11
commits, ended with review verdict `revise`, and were recorded as shipped.
GitHub received neither history, and both worktrees were then released — so the
only copy of 35 commits was deleted, and the next revision started again from
the stale remote implementation.

Every step succeeded. Preview verification was enabled; the preview push runs
only for a `pass` verdict, so a `revise` pushed nothing; finalisation
nevertheless chose the PR-only callback *because preview was enabled*; that
callback found the revision's existing pull request and posted the review
comment; and finalisation read the resolved callback as publication, polled CI
on the local worktree HEAD, found no checks on a commit GitHub had never seen,
and shipped. A config flag, a resolved callback, a real PR URL, a posted comment
and a local branch name were all true while nothing had been published.

### What the harness does now

The candidate SHA is resolved *after* every commit-producing finalisation step,
including the CI-workflow authoring the harness does itself. It is pushed unless
that exact commit is already proven to be on the remote, and the remote branch
tip is then read back (`git ls-remote`, through the requester's own credentials)
before anything is called published. CI is polled on the published SHA, so an
absence of checks can no longer be collected from a commit the provider has
never seen.

Evidence names a SHA, never a boolean. A commit made after a push — the authored
CI workflow is the common case — does not inherit the earlier commit's proof;
the run audits `loop.publication_evidence_invalidated` and publishes again.

Publishing a non-passing candidate is unchanged policy: it goes up for review
with its blocking findings and its do-not-merge recommendation intact. Published
is not approved. Where policy prohibits publication — an abort or stall salvage
that never got an adversary review, for instance — the run reports an explicit
unpublished outcome and keeps the work.

### Reading the outcome

| Signal | Meaning |
| --- | --- |
| `loop.shipped` with `publicationVerified: true` | The remote branch tip was read and equals `publishedSha`. |
| `loop.unpublished` | The call resolved and the remote still does not hold the candidate. Terminal, worktree preserved. |
| `loop.publication_evidence_invalidated` | HEAD moved after a push; the new candidate is being published on its own merits. |
| `loop.publication_reused_push` | The candidate was already on the remote, so the PR was opened without a second push. |
| `loop.ci_polled_unverified_sha` | CI was polled on a commit whose publication could not be verified. Treat any green with suspicion. |
| `sessions.published_sha` / `published_at` | The durable record. NULL means never verified — it does **not** mean verified-absent. |

`loop.unpublished` carries a `failureKind`:

| Kind | What happened | What to do |
| --- | --- | --- |
| `remote_missing` | The branch does not exist on the remote. | Nothing from the run reached it. Push the preserved worktree by hand. |
| `remote_mismatch` | The branch tip is a commit the harness did not publish. | Likely concurrent work. The harness will never force-push over it; reconcile the two histories yourself. |
| `verification_unavailable` | The remote could not be read (credentials, network). | Publication is *unknown*, not absent. Fix access, then read the branch before deciding whether to push. |
| `candidate_unknown` | No candidate SHA could be resolved. | There is nothing to verify or publish; inspect the worktree. |

### Recovering unpublished work

The terminal message names the branch, the candidate SHA and the worktree, which
is deliberately *not* released on this path. To recover:

```
git -C <worktree> log --oneline origin/<branch>..HEAD   # what never left
git -C <worktree> push origin <branch>                  # publish it
```

Then use `harness_link_pr` (above) if the session needs its PR association back,
and `harness_revise` to continue.

### Sessions that shipped before rc.5

`published_sha` is NULL for every session that predates this change, including
ones that genuinely published. That is intentional: the column records a read of
the remote, and no such read was ever performed for those runs. The harness does
not backfill them, and it does not push historical divergent tips. If you need
to know whether an old session's work is on the remote, read the branch.

### Tuning

Verification re-reads the branch tip up to `ci.publication_verify_attempts`
times (default 4) with `ci.publication_verify_delay_ms` between reads (default
1500). This exists for one observed phenomenon: GitHub's PR metadata can briefly
lag a successful push, which is exactly what we saw during the #1168 recovery.
It is not a retry for a failed push — the harness never re-pushes during
verification — so raising these buys patience, never a greener answer.

## Approving a brief, and the limits that actually apply

`brief.confirm_before_spend` pauses each crystallised brief for an operator, and
the reply is answered with `harness_answer`. The reply does two jobs at once: it
says yes, and it may adjust the budget or the wall clock. Ordinary shorthand
works — `Confirm, $60, 10 hours`, `yes, budget $60 and a 10 hour budget`, `ok —
10 hrs` — in any order, and with or without the word "budget" attached to each
number.

**Bare numbers count only in a reply that is otherwise pure agreement.** If
removing the numbers leaves something that still reads as a plain yes, they are
read as limits. If it leaves an instruction — `confirm, but the price threshold
should be $60`, `confirm but set the retry limit to 3` — the whole reply is a
correction to the brief, the `$60` belongs to the feature, and nothing is
applied to the session's limits. This is the line that lets you write `$60`
without a cue word while keeping a sentence about prices from silently becoming
the run's cap.

**A control the harness cannot read stops the run.** If the reply clearly aims
at the budget or the clock but the amount is unusable — `budget -$50`, `time
budget of 400 hours`, `budget $40 and cap $60` — the session stays paused and
you get a narrow question naming the control and quoting your words back. It
does not start at the default and it does not fold your words into the
acceptance criteria. Answer again with a readable figure and the run starts.

Before rc.6 both of those cases started the run anyway: the unreadable control
was silently dropped, the default limit applied, and the control text was
carried into the brief as a requirement. #1184 is what that looks like from the
outside — an operator who approved `$60` got a $50 cap they never chose, and the
run was later refused a CI repair for crossing it.

**Every approval returns a receipt.** The response states the budget and
wall-clock limit that were actually persisted, read back out of the session row
rather than echoed from the request, and says so explicitly when a figure was
clamped by the configured ceiling. If the write did not land, the answer fails
with the controls it could not persist and the session stays resumable — it is
never flipped to `planning` on limits nobody stored.

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

## What the harness reads from a failing check

Check output is captured twice, for two different consumers:

- **The display tail** — the last 4,000 characters. This is what goes into
  prompts, terminal messages and the audit log, and it is bounded so a noisy
  build cannot crowd out the rest of a model's context.
- **The analysis capture** — up to 2 MB. This is what the harness parses. When a
  run exceeds even that, the result carries an explicit truncation flag rather
  than quietly shortening.

The distinction matters because a failing `tsc` routinely prints far more than
4,000 characters, and the errors it prints first — often in the files a sub-task
actually touched — are the ones a tail drops. Before rc.6 both consumers read
the same tail, so the harness's picture of a broken branch was whatever happened
to fall at the end of the stream.

A typecheck finding now reports the full count, samples errors across the
affected files rather than taking the first few from one file, summarises the
per-file counts on one line, and lists every affected file so the whole break is
routed to a single worker. A finding that named only one file of three produced
a fix that could not compile, and the same finding came back next cycle.

## Who regenerates derived artifacts

If your repo commits generated files — an OKF bundle, a codegen client, a
generated docs section — you must tell the harness which script produces them.
Nothing is inferred.

```jsonc
"verify": {
  "generators": [
    { "script": "okf", "produces": ["okf/bundle.json"], "inputs": ["okf/src/"] },
    { "script": "codegen", "produces": ["src/generated/"], "inputs": ["openapi.yaml"] }
  ]
}
```

A `produces` entry ending in `/` owns everything beneath it; anything else is an
exact file. Paths must stay inside the repository, and a path claimed by two
scripts is refused as ambiguous — neither script is authorized for it.

`inputs` is optional and follows the same file-or-directory rule. It is what the
harness reads to decide whether a committed artifact has gone stale; see the
freshness table below. Without it, an artifact that nobody touched is accepted,
because there is no evidence either way.

**`produces` may not overlap `repos.never_commit_paths`.** That list does not
merely discourage committing a path — `revertNeverCommitPaths` unstages *and
restores* every match before each commit. A generator told to produce a path on
that list is given a contract it cannot satisfy on any cycle: the worker
regenerates the file, the pre-commit step puts it back, the contract fails, and
the failure advice ("run the generator") is advice that cannot work. The harness
now rejects this combination when it resolves the config, naming both the script
and the path, rather than letting a run discover it one cycle at a time.

**What a mapping does.** When a sub-task's contract or declared scope names a
mapped path, the worker is told to run that specific script and commit what it
writes. That is the only exception to the standing "do not run repo-wide
generators" rule, and it is scoped to the named script and the named paths, so
no turn can be talked into a speculative whole-repo regeneration.

**What it does not do.** It never authorizes the harness to run anything. The
harness reads your mapping and reports on it; the worker executes. This keeps
the beta.81 line intact: commands that decide pass/fail belong to CI, and
commands that produce a committed deliverable belong to the worker.

**What happens without a mapping.** A generated path with no mapping is treated
as an ordinary file. Nothing regenerates it, and it gets no exemption either —
the contract on it is enforced normally, and a reviewer finding that the bundle
is stale keeps whatever weight the reviewer gave it. That is deliberate: with no
declared owner there is no machinery to answer the complaint, so it stands.

**Reading the failures.** These are distinct and all name the cause directly:

| Report | What happened |
| --- | --- |
| `... is a GENERATED artifact -- the generator that owns it (npm run X) did not run` | The script exists; the worker did not run it, or it wrote nothing. |
| `MISSING TOOLING: verify.generators maps it to X, but package.json declares no such script` | Your mapping names a script the repo does not have. Nothing can produce the file until you fix one or the other. |
| `... is stale: <input> changed on this branch ...` | A path you declared in `inputs` moved on this branch and the artifact derived from it did not. The message names the input, so the claim is checkable. |

**How freshness is decided.** A generated path a contract names lands in exactly
one of four states:

| State | Outcome |
| --- | --- |
| Regenerated in this window | Passes. The worker ran the script and committed the result. |
| Absent from the branch | Fails. A generator that never produced its artifact is not a no-op. |
| Present, and a declared `inputs` path changed on this branch | Fails as stale, naming the input that moved. |
| Present, unchanged, no `inputs` evidence | Passes. |

That last row changed in rc.6. Before it, an untouched artifact was reported
stale on the assertion that "its sources moved" — which nothing had checked, so
a sub-task that legitimately did not touch the bundle failed a contract it had
already satisfied. The harness never runs generators (see above), so it cannot
tell an up-to-date artifact from a stale one by content; declaring `inputs` is
how you turn that undecidable case back into a real check.

None of these are path mismatches, and the harness will not ask you to relocate
a generated file: its location is something you declared, not something the
planner guessed.

**A note on earlier releases.** Before rc.5 the worker was told "do NOT run
regenerators yourself ... the harness regenerates derived artifacts for you",
the reviewer was told not to flag a stale bundle for the same reason, and
verification then required the generated file to be committed. The phase all
three cited runs check scripts, commits nothing, and has been off by default
since beta.81. If you are reading logs from before rc.5, a "contract path
mismatch" on a generated file is that defect, not a misplaced file.

## Troubleshooting

- **A contract failed on a generated file**: read the message rather than the path. If it says the generator did not run, the worker was not authorized for that path — add it to `verify.generators`. If it says MISSING TOOLING, the mapped script is not in the repo's `package.json`. If it says stale, it names the declared input that moved, and the artifact must be regenerated from it. See "Who regenerates derived artifacts" above.
- **The config is refused because a generator targets a never-commit path**: the two settings contradict each other, and the harness stops rather than starting a run whose contract can never pass. Either drop the path from `repos.never_commit_paths` (if the artifact is genuinely meant to be committed) or from the generator's `produces` (if it is not). See "Who regenerates derived artifacts" above.
- **An approval came back as a question instead of starting the run**: the reply named the budget or the clock with an amount the harness could not use, so it stopped rather than starting at a default you did not choose. The question quotes the words it could not read. See "Approving a brief, and the limits that actually apply" above.
- **A typecheck finding keeps coming back**: check whether it names every file. Findings raised before rc.6 were built from a 4,000-character tail, so a break spanning several files could be handed over as one, fixed partially, and re-raised. See "What the harness reads from a failing check" above.
- **The run says NOT PUBLISHED**: the push (or PR call) resolved and the remote still does not hold this run's commits. The work is preserved in the named worktree and the terminal message gives both SHAs — see "Published, approved, and unpublished" above for the `failureKind` table and the recovery commands. Do not force-push; on `remote_mismatch` the branch tip is somebody else's commit.
- **A session reads as shipped but the PR looks unchanged**: check `sessions.published_sha` against the PR head. If it is NULL and the session predates rc.5, publication was never verified for that run — read the branch rather than trusting the status.
- **The adversary timed out before its first token**: the review failed closed and nothing shipped — this is not a review that passed, and the session keeps its worktree. Raise `loop.sdk_first_token_timeout_seconds` (see above) if the backend is merely slow to start; if it never opened its stream, check the backend's launch and credentials instead. The harness will not retry a timeout as a formatting problem, so repeated identical timeouts mean the backend, not the prompt.
- **PAT push rejected with 403 (SAML)**: the org enforces SAML SSO. Authorise the PAT in the org's PAT settings, then retry. Alternative: emit `git format-patch` to a workspace directory and apply locally (see MEMORY.md).
- **Vercel logs empty**: preview deploy has not landed yet. Adversary receives an explicit "NO RUNTIME DATA" banner and will not sign off on runtime concerns. Wait or increase `previewWaitSeconds`.
- **Session stuck in `crystallising`**: user never replied. Manually mark `aborted` in `sessions` or let the harness time out (default 24h).
- **Budget refuses new session**: check `budgets_monthly` for the user. Override with a `moneybag` reaction (audit-logged) or bump the config cap.
