# Response to the external review of `1.0.0-rc.2`

Every finding gets a verdict: **agreed and fixed**, **agreed and deferred** (with the reason), or **disagreed** (with evidence). Nothing is skipped.

Shipped in `1.0.0-rc.3`. Suite at the time of writing: 2219 tests, 2219 pass, 0 fail, 0 cancelled.

Two things up front. First, the review was right about the things that mattered most, and two of its findings turned out to be **worse than reported** once we went looking — §3 has a silent-default bug the review did not mention, and §2's preservation path had a promise it was not keeping. Second, two claims in §2 are **overstated**, and one in §9 is **backwards**; those are argued below rather than quietly accepted.

## Summary

| § | Finding | Verdict |
| --- | --- | --- |
| 1 | Worker "sandbox" is not a sandbox | Agreed — docs corrected, bypasses now tested, OS isolation scoped separately |
| 1a | Git hooks escape the guard | Agreed — documented and tested; not fixable at this layer |
| 1b | `ANTHROPIC_API_KEY` worker-readable | Agreed — documented; scoping the key is the real fix, deferred |
| 2 | Push invariant does not hold | Agreed and **fixed** — unreviewed code no longer pushes at all |
| 2a | `user_abort` pushes unreviewed code | **Disagreed** — it is explicitly excluded, and always was |
| 2b | Non-infra cycle-1 crash pushes | **Disagreed** — it already refused, with a test |
| 3 | Severity downgrade makes a defect auto-mergeable | Agreed and **fixed** — and it was worse than described |
| 4a | 22 subtests `cancelledByParent` | **Could not reproduce** — 0 cancelled on two invocations |
| 4b | Inconsistent test counts in prose | Agreed — corrected, with a test that fails on drift |
| 5.1–5.5 | Concurrency defects in the parallel path | Agreed — **deferred**, with parallelism kept off by default |
| 6 | Vault key stored beside its ciphertext | Agreed — comment corrected, caveat documented; not gated on |
| 7 | Security-boundary test coverage is thin | Agreed and **fixed** |
| 8 | `loop.ts` has outgrown its structure | Agreed on substance — one of the two consolidations done |
| 9a | `store.ts` vs Dockerfile `better-sqlite3` | **Partly disagreed** — `store.ts` was right, the Dockerfile was stale. Fixed |
| 9b | `dist/` committed inflates diffs | Acknowledged — deliberate, CI-verified, keeping it |
| 9c | `pathMatchesDenylist` case-sensitive | Agreed — documented and tested as a bypass class |

---

## §1 — The worker sandbox is not a sandbox. **Agreed.**

Reproduced against the shipped default config. Every one of these is allowed:

```
python3 exfil.py        node exfil.js         make                  env
echo $ANTHROPIC_API_KEY cat .e*               cat .ENV              git show HEAD:.env
echo .env | xargs cat   find . -name .env -exec cat {} +
cat .git/config         echo x > .git/hooks/pre-commit
```

The review's framing is right and the previous documentation was wrong. The bash guard is well-built for what it is, and what it is is a filter on command lines — which cannot constrain a whitelisted interpreter, and `python3`, `node` and `make` are all on the default whitelist. Once one of those is permitted, `path_denylist` and `allow_network_commands` are advisory.

**What changed.** [SECURITY.md](../SECURITY.md#the-threat-model-stated-plainly) now states the threat model plainly — the controls are built for a capable but non-adversarial worker, and will not contain a hostile one — and separates what is *enforced* (`repos.allowed`, PAT scope, git argv safety, authorisation, vault-at-rest) from what is *best-effort* (everything in `safety.*`). The bypass table above is in that document. [docs/CONFIGURATION.md](CONFIGURATION.md) and [docs/ARCHITECTURE.md](ARCHITECTURE.md) had the same overstated claims and now carry the same correction.

**What did not change.** No OS-level isolation ships in `1.0.0-rc.3`. [docs/WORKER_ISOLATION.md](WORKER_ISOLATION.md) scopes what it would take, and the short version is that the harness runs unprivileged inside the OpenClaw gateway container, so seccomp/namespace/`docker-in-docker` approaches all convert "the harness sandboxes its workers" into "the operator deploys the harness a particular way and the harness verifies they did" — a deployment contract to be designed, not a patch. That document also argues the honest ordering: scoping the Anthropic key and an egress proxy buy more than filesystem sandboxing, because a proxy is the one control an interpreter cannot route around.

The most important thing we did *not* do: add more entries to `bash_denylist_tokens` and `path_denylist`. Every one of those, while `python3` is whitelisted, increases apparent safety and changes actual safety by nothing — and someone will rely on it.

### §1a — Git hooks escape the guard. **Agreed.** Documented and tested. `.git/` is deliberately absent from `path_denylist` because workers need git, and the consequence is that `.git/hooks/pre-commit` is writable and runs outside the guard on the next git operation. Adding `.git/` to the denylist would break the worker and not close the hole (`python3` writes the same file). This is now an asserted, commented bypass case in `tests/bash-guard.test.mjs`.

### §1b — `ANTHROPIC_API_KEY` is worker-readable. **Agreed**, and it is deliberate: the embedded Claude Code binary reads it from its environment, and without it the worker falls back to interactive `/login` ([src/adapters/claude-sdk.ts](../src/adapters/claude-sdk.ts)). Stripping it breaks the product. The real mitigation is a scoped or short-lived credential, which is the first item in [WORKER_ISOLATION.md](WORKER_ISOLATION.md#what-is-worth-doing-first-if-this-is-picked-up). For now it is stated in SECURITY.md so operators scope and rotate that key knowingly.

---

## §2 — "Nothing pushes until the adversary passes" does not hold. **Agreed, and fixed.**

Confirmed. Three salvage paths reached `pushBranchAndOpenPr` for sessions where no adversary review had ever run, each by synthesising a placeholder `revise` report: `tryBestEffortVerify` (verify sub-task timed out), `finaliseAbortSalvaging` (budget/daily-cap/wall-clock), and `finaliseReviewCrash` (infra error, which beta.90 let through on cycle 1 by design).

**The rule now**, in one place (`refuseUnreviewedSalvage`, consulted by all three):

- A **prior review exists** → ship as before, stamped `needs_human_review`. Something adversarial did look at this code, and discarding the work has a cost too. This is a defensible trade and we are keeping it.
- **Nothing has ever reviewed it** → do not push. Preserve the worktree, keep the session resumable, audit `loop.salvage_refused_unreviewed`. The commits are not lost; only the push is refused.

Three things came out of implementing that which the review did not reach:

1. **`finaliseFailedPreserveWorktree` did not preserve anything across a restart.** It never set `worktree_preserved = 1`, and `failed` is a terminal status, so `worktree-heal` reaped the directory on the next boot — the function whose name is a promise kept it only until the process restarted. beta.129 fixed exactly this for the abort path and missed this one. Since the new gate routes here, the promise had to be made real. Fixed.
2. **`tryBestEffortVerify` reported failures as `shipped`.** It returned a bare `true` both when it opened a PR and when the push *threw*, and the caller mapped `true` to `{status: "shipped"}` — so a run whose push failed was reported as shipped with an empty `prUrl`. Pre-existing; found because the new refusal path returned through the same channel. The return type now distinguishes the two.
3. **`harness_merge_pr`'s override gate counted only `high`/`critical`.** A `medium` finding — blocking everywhere else in the system — left the PR eligible for the Vercel override. Now reads severity through the same helper as everything else (see §3).

**The `do_not_merge` stamp is now checkable.** The review's point that a stamp is only as good as the human reading it stands. PRs now carry GitHub labels — `do-not-merge`, plus `harness:unreviewed` or `harness:downgraded-pass` to say *why* — applied on both the open and the revise re-push paths, so a repo can require their absence in branch protection. Labelling is best-effort (it needs `issues: write`) and never fails a run whose code has already landed.

[README.md](../README.md) no longer states the invariant unqualified; it links to the precise version in [SECURITY.md](../SECURITY.md#what-the-push-invariant-actually-guarantees).

### §2a — "`user_abort` salvage pushes unreviewed code". **Disagreed.**

`user_abort_reaction` is routed to `finaliseAbortSalvaging`, but salvage-to-PR is gated on `ABORT_REASONS_WORTH_SHIPPING`, which contains `hard_timeout`, `budget_exhausted`, `daily_max_exhausted` and `ship_time_reserved` — and not `user_abort_reaction` ([src/orchestrator/abort-salvage.ts](../src/orchestrator/abort-salvage.ts)). A user abort has always preserved the worktree rather than pushing. The design reasoning is sound and predates this review: a human who pressed `:x:` has said "stop", and answering that with a PR would be the wrong reading of the instruction.

### §2b — "A non-infra cycle-1 crash pushes". **Disagreed.**

`finaliseReviewCrash`'s eligibility required `infra || (cycle >= 2 && priorReview)`, so a non-infra cycle-1 crash was never eligible and went straight to preserve. `tests/beta90-infra-crash-and-stream-slow.test.mjs` has asserted this since beta.90 ("cycle-1 QUALITY crash (non-infra) with green self-verify is NOT eligible"). The *infra* half of that condition was the real hole, and that is what we closed: it now requires a prior review too, waiving only the `cycle >= 2` part.

---

## §3 — The classifier can downgrade a `revise` into an auto-mergeable `pass`. **Agreed, and fixed. It was worse than reported.**

The review identified exact string equality in `isBlockingFinding`. Two things it did not mention:

1. **Every other consumer already normalised case.** `merge-recommendation`, `revise-scope`, `revise-mapping`, `adversary-file-attribution` and the merge tool had each independently written `(f.severity ?? "").toLowerCase()`. The *only* place that did not was the one deciding whether a finding could stop a ship. This was an inconsistency, not an oversight of a uniform convention.
2. **The parse boundary silently defaulted to non-blocking.** `severity: f.severity ?? "low"` in [src/index.ts](../src/index.ts) meant a *missing* severity became `low`. Since `runAdversarySdk` validates only that `verdict`, `findings` and `summary` exist — with `findings: unknown[]`, no schema — an omitted severity is a normal model output, not a crafted attack. That default was the more dangerous half.

**Fixed as recommended.** `normaliseSeverity` in [finding-classify.ts](../src/orchestrator/finding-classify.ts) is now the single place severity is interpreted: trims, lowercases, maps the synonyms models actually emit (`moderate`, `med`, `major`, `crit`, `blocker`, `warning`…), and returns `"unknown"` for anything unreadable. `"unknown"` **counts as blocking** — fail toward review. It is applied at the parse boundary, and `isAtLeastMedium` replaced the ad-hoc lowercase Sets in merge-recommendation and the merge tool, so the ship gate and the merge gate cannot disagree about what blocking means.

**Recommendation (2), "make classifier errors fail toward review", is also done**, in a form worth describing because it is narrower than a blanket rule. The demotion buckets below `diff_addressable` all match keywords on prose, and every one of them demotes — a one-way ratchet toward shipping. Now: `security` dimension, `high`, `critical` and unreadable severities are **not demoted on a keyword**. What we deliberately did *not* do is extend that to `medium`, because the beta.69/70 forensics (PR #870's sole medium, the 1f2e6642 runtime spiral) were exactly about medium-severity demotions, and reopening those loops would trade one failure mode for another. That leaves the hole closed and the convergence work intact — `tests/rc3-severity-normalisation.test.mjs` asserts both directions.

One bucket is exempt from that rule and it is worth saying why: a stale-generated-artifact finding is demoted at **any** severity, because the convention-check phase regenerates the bundle deterministically — the complaint is answered by machinery rather than argued about. It earns the exemption by being narrow, and we made it narrower: **the bare verb `regenerate` was removed from the pattern.** It matched anywhere in the finding text, so "the session token is never rotated — an attacker can replay it; regenerate it on each login" classified as `process` and could not sustain a `revise`. That is the review's own test case, and it was a live bug.

**Recommendation (4), logging.** Downgrades now log at `warn` with the demoted findings named, set `verdictDowngraded` on the report, and put a banner on the PR body — a `pass` the gate manufactured from a `revise` used to look identical to one the adversary gave, while being auto-mergeable.

**Recommendation (3), replacing the regex stack with an adversary-emitted `class` field: deferred, and we think it is the right call for now.** It is the correct end state, and it is a behavioural change to the review contract itself — a new required output field, a validation path for when the model gets it wrong, and a migration for every prompt and fixture. Landing it in the same release as the severity and push-gate changes would make it impossible to attribute any regression in review quality to one of them. The narrower fixes above close the specific hole; the redesign wants its own release and its own smoke.

**Accepted cost:** runs will `revise` slightly more often where a model omits or mis-cases a severity. That is the intended direction.

---

## §4 — Build and test results

### §4a — "22 subtests report `cancelledByParent`". **Could not reproduce.**

Two invocations, both on the `rc.3` tree:

```
npm test                 -> 2219 tests, 2219 pass, 0 fail, 0 cancelled
node --test tests/*.mjs  -> 2219 tests, 2219 pass, 0 fail, 0 cancelled
```

`grep -c cancelledByParent` over the full output: zero matches, both runs. Local Node is v25.6.1; the review reports v22.22, so a runner-version difference in how subtest lifetimes are handled is the most likely explanation. We are not disputing that the review saw it — we cannot see it, so we cannot find the un-awaited subtests to fix. **If you can reproduce it, the Node version and the output are the two things we need.** Flagging as unresolved rather than closed.

### §4b — Inconsistent test counts in prose. **Agreed.** Corrected to 2219 throughout. `tests/readme-version-claims-current.test.mjs` (added in rc.2) already fails the suite when an "as of <version>" claim drifts from `package.json`; the count itself is still hand-maintained, and generating it is a fair ask we have not done.

---

## §5 — Concurrency defects in the parallel-worktree path. **Agreed. Deferred.**

We are not disputing 5.1 through 5.5. The `dependsOn`-before-merge-back race, the session-worktree access seam, `withTimeout` abandoning an uncancellable `runOne`, the `release`-into-a-draining-pool path, and the `acquire` slot leak all read as real on inspection.

They are deferred for the reason the review itself gives: **parallelism ships disabled** (`subtask_concurrency > 1` and `parallel_independent_subtasks` are both off by default), so none of them is reachable in a default install. Fixing them properly means threading an `AbortSignal` through `runOne` and `acquire`, and giving "who may touch the session worktree, when" a single owner — which is §8's second consolidation and a substantial change to the most intricate part of the loop. Doing that in the same release as the push-gate change, on paths no default install executes, would add risk to the code that *is* running in exchange for none of it.

**Commitment:** these are blockers for enabling parallelism by default, not optional hardening. They should be fixed before that flag flips, together, with their own smoke.

---

## §6 — Vault key stored beside its ciphertext. **Agreed on the substance.**

The header comment said the ciphertext "is useless without the key, which lives outside it". True of the *file* and misleading about the *directory*: the default key path is `<dir>/vault.key` next to `<dir>/vault.db`. The review is right that this defends against the narrow threat (a state DB copied off the box takes no secrets with it) and not against anyone who can read the harness data dir.

**Fixed the claim, not the default.** The comment in [credential-vault.ts](../src/adapters/credential-vault.ts) now states exactly what the default does and does not protect against, and the `credentials.key_file` description — which generates into [CONFIGURATION.md](CONFIGURATION.md) — carries the same caveat and points at `$OAH_VAULT_KEY_FILE` / `$OAH_VAULT_KEY`.

**We did not take the "refuse to start" option.** Every existing install has its key in the default location; a version that refuses to open their vault turns a documentation problem into an outage, and an operator who cannot immediately relocate the key would be pushed toward disabling the check rather than fixing the posture. The at-rest gap is real, it is now stated plainly at the point of configuration, and operators who need better have two documented ways to get it.

---

## §7 — Security-boundary test coverage is thin. **Agreed, and fixed.**

Correct on both counts: `tests/bash-guard.test.mjs` only ever asserted the guard's successes, which reads as evidence of containment, and none of the §1 bypass classes were exercised.

Implemented exactly as suggested. The bypass classes are now asserted as **ALLOW**, each with a comment saying why the guard cannot block it, plus a test asserting the SECURITY.md table and the test file agree — so the documentation cannot drift from the behaviour. A test that fails when a bypass is *closed* is deliberate: whoever closes one has to come and read why the class exists, and decide whether the fix is real or is one line above a `python3` that makes it moot.

The `skip` when `dist/` is absent stays. CI builds before testing, so it is never skipped there.

---

## §8 — `loop.ts` has outgrown its structure. **Agreed on substance.**

The measurements are accurate and the diagnosis is fair. It is accretion: failure → narrow guard → rationale comment → nothing consolidated. It bought real robustness and the interactions between patches are where §2 and §3 lived.

**Consolidation (a), the finding classifier, is done** — that is what §3 above describes. Severity now has exactly one interpreter, and the six ad-hoc `(f.severity ?? "").toLowerCase()` call sites are gone.

**Consolidation (b), one owner for session-worktree access, is not** — see §5.

**Extracting the seven `finalise*` terminals is not done, and we partly disagree that it was the prerequisite.** The §2 bug was not that the terminals were hard to find; it was that three of them had independently invented the same "synthesise a placeholder review and push" answer. What made it auditable was giving them a shared gate to consult, which is now one method and one audit event. Moving them into their own module is worth doing and would have helped; it was not what was standing between us and the fix.

---

## §9 — Nits

**§9a — `store.ts` vs the Dockerfile. Partly disagreed; the conclusion was backwards.** `store.ts`'s "ZERO native dependencies" claim is **true**: `better-sqlite3` is not in `dependencies`, `devDependencies`, or the lockfile, and the entire installed tree contains no `.node` binaries and no `binding.gyp`. The Dockerfile was installing `python3 make g++` and setting `npm_config_build_from_source=true` for a package that is not there — dead weight in the build image, not a contradiction. Removed; the comment now records what happened so the next reader does not re-add it.

**§9b — `dist/` committed.** Acknowledged, and keeping it. It is required for git-based plugin install, the "dist matches source" CI step is present and required, and the diff noise is the cost of that distribution model.

**§9c — `pathMatchesDenylist` is case-sensitive.** Agreed, and the review's own framing is right that it is minor given §1. `cat .ENV` is now an asserted bypass case with the reasoning attached. Case-folding the comparison would close it on macOS and change nothing about the interpreter bypass sitting above it.

---

## What we would most like back

1. **The `cancelledByParent` reproduction** (§4a) — Node version and output. It is the one finding we could not act on.
2. **A view on the deferrals.** §5 and the §3 classifier redesign are both "agreed, not now, blocker for X". If either reads as more urgent than that from outside, we would rather hear it before the flag flips than after.
