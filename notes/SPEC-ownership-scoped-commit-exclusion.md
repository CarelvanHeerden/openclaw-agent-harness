# SPEC — Ownership-scoped commit exclusion

Author: Cursor · 2026-09-14 · Origin: Carel's question after the StitchGuard OKF conflict (rc.6, PRs #201–#203)

**Status: phase 1 implemented in PR #203.** The rule, the plumbing and the
migration below all shipped; `authorizedGeneratedOutputs` widened the
authorization from the sub-task's declared paths to the whole of what the
authorized script writes, for the reason given under "Plumbing". Phases 2 and 3
remain proposals.

## Motivation

`repos.never_commit_paths` and `verify.generators` are two mechanisms describing
the same files with no shared vocabulary, and every defect in this thread is a
consequence of that.

The chain, in order:

1. **beta.114.** Workers stage with `git add -A`, so a build step that
   regenerates a checked-in bundle as a side effect sweeps the whole tree into
   an unrelated commit — 141 of 154 files on ProjectThanos PR #961, each one an
   out-of-scope write, which is blocking and which no worker can resolve when
   regenerating *was* the sub-task. `never_commit_paths` was added to revert
   them, and it works.
2. **rc.5.** `verify.generators` was added so the harness knows which script
   produces which artifact, and so a worker can be authorized to run it.
3. **rc.6.** The two were pointed at the same tree. The worker is told to run
   the generator and commit what it writes; the exclusion unstages *and
   restores* the result; the contract fails because the artifact was never
   committed; the failure advice is "run the generator". rc.6 refuses that
   combination as a configuration error.
4. **rc.7 (PR #203).** Resolving the rc.6 error makes those files committable,
   at which point they arrive at the final scope check as creep — 1,663 files
   against a 500-file threshold on StitchGuard, which is an abandoned cycle
   rather than a finding.

The one-sentence defect behind all four: **the worker is authorized to run the
generator and instructed to commit what it writes, and then the commit is
reverted by a rule that never consults that authorization.**

## What is wrong with the current resolution

rc.6 tells the operator to narrow the exclusion so it no longer covers the
declared outputs. That is correct advice and a bad long-term answer, because
this pathspec syntax has no negation (`neverCommitCovers` supports `*`, `**`,
`?` and bare prefixes — there is no `!`). "Everything under `okf/` except these
eight trees" therefore has to be written out as the siblings that remain.

On the live StitchGuard config that is eight enumerated patterns replacing one,
computed against one checkout. Any directory added under `okf/` afterwards
matches none of them and is silently committable. The operator has traded a
future-proof rule for a snapshot that rots, and nothing tells them when it has.

## The rule

> A staged path matched by `repos.never_commit_paths` is reverted **unless the
> committing sub-task is authorized to generate that path**.

Per path, not per tree — StitchGuard has eight mappings and a sub-task may own
some and not others. Everything else is unchanged:

| Case | Today | Proposed |
| --- | --- | --- |
| Path excluded, no generator owns it | reverted | reverted |
| Path excluded, owned, committer is authorized | reverted | **committed** |
| Path excluded, owned, committer is not authorized | reverted | reverted |
| Path not excluded | committed | committed |

Only the second row changes, and it changes to what the operator asked for when
they declared the mapping. The anti-sweep protection of beta.114 is untouched:
a worker doing unrelated work is authorized for nothing under `okf/` and is
still reverted, which is the case PR #961 was actually about.

## No new config is required

The sub-task → generator binding already exists and is already per sub-task:

```376:393:src/orchestrator/generated-artifacts.ts
export function authorizedGeneratorsForPaths(
  map: GeneratorMap,
  paths: readonly string[],
): { script: string; paths: string[] }[] {
```

> The caller passes the sub-task's own paths (its verification contract and its
> declared scope), never the whole repo — authorization is per sub-task by
> construction, so no turn can be talked into a speculative repo-wide run.

The worker computes exactly this set today, from the same inference the verifier
uses, and passes it into the system prompt:

```582:593:src/orchestrator/worker.ts
  const generatorMap = resolveGenerators(deps.config.verify?.generators, { neverCommitPaths: deps.config.repos?.never_commit_paths });
  const contractPaths = [
    ...inferVerifyContract(subTask)
      .map((c) => ("path" in c ? c.path : undefined))
      .filter((p): p is string => typeof p === "string" && p.length > 0),
    ...(subTask.filesLikelyTouched ?? []),
  ];
  const systemPrompt = buildWorkerSystemPrompt(
    brief,
    subTask,
    authorizedGeneratorsForPaths(generatorMap, contractPaths),
  );
```

So the authorization that lets a worker **run** the script is the same
authorization that should let it **commit** the output. The proposal is to stop
computing that twice with different answers.

This also inherits beta.70's cost discipline for free: authorization is only
ever granted for a NAMED script producing a NAMED path the sub-task already
owes, never repo-wide.

## Plumbing

Short and localised. The exclusion is applied inside the adapter, which today
knows only the worktree:

```1422:1424:src/adapters/git-worktree.ts
  private async revertNeverCommitPaths(worktreePath: string): Promise<string[]> {
    const globs = (this.opts.neverCommitPaths ?? []).map((g) => g.trim()).filter(Boolean);
    if (globs.length === 0) return [];
```

1. `GitAdapter.commit(worktreePath, message, identity)` gains an optional
   fourth argument — the paths this commit is authorized to write despite the
   exclusion list. Optional and defaulting to none, so every existing caller
   keeps today's behaviour and the change cannot leak into the harness's own
   commits.
2. `revertNeverCommitPaths` subtracts those paths from `matched` before
   restoring, and reports them separately in its existing log line, so "spared
   because owned" is never confused with "the exclusion stopped running".
3. `worker.ts` already holds the authorized set; pass it to both `gitCommit`
   call sites (the worker commit and the harness commit).
4. Audit the spare, naming the owning script, the sub-task and the count.

Deliberately **not** threaded into `ciAuthorWorkflow` or any other
harness-authored commit. Those are not sub-tasks and own nothing.

## Migration

The interesting part: **StitchGuard needs no config change at all.** The
configuration rc.6 rejects is the one the operator actually wants, and the
harness was wrong to demand it be edited.

1. Implement the rule above.
2. **Relax the rc.6 overlap error.** Its justification is that the pairing
   yields a contract no worker can satisfy — that stops being true, because the
   owning sub-task can satisfy it. The check should be removed rather than
   downgraded; a warning about a now-correct configuration is noise.
   - `resolveGenerators`'s `neverCommitPaths` option and the
     `neverCommitCovers` rejection go away, along with their mutations and the
     rc.6 tests that pin them.
   - Keep `neverCommitCovers` itself: the preflight and the revert both need it.
3. **Repurpose the preflight** (`scripts/generator-config-preflight.mjs`). It
   stops proposing a narrowing, which is no longer the fix, and instead reports
   ownership coverage: which excluded paths are owned, by which script, and —
   the one thing worth flagging — which excluded-and-owned paths **no sub-task
   is ever likely to claim**, since those are the artifacts that will now go
   stale rather than be committed by the wrong turn.
4. **PR #203 stays as it is.** It is the fail-closed half: a declared artifact
   is in scope for the check, and a mapping the harness rejected authorizes
   nothing. With the rc.6 rejection gone, its `ownerOf`-is-null tests need
   re-pointing at ambiguous ownership (two scripts, one tree), which is the
   remaining rejection path.
5. No `never_commit_paths` edits for any deployment. Existing configs keep
   working; the only behaviour change is that a sub-task contracted to produce
   an artifact can now deliver it.

### Naming

`never_commit_paths` becomes wrong once it means "not by you". The honest
options are a rename with an alias for the old key, or leaving it and carrying
the caveat in the docs. Given this codebase's stance on names that overstate
(the rc.6 "target" vs "cap" work), a rename is probably right, but it is a
separate change and should not ride along with the semantics.

## What this does not solve

- **Review cost.** A legitimate 1,663-file regeneration still reaches the
  adversary. It is chunked and aggregated past `DIFF_SINGLE_CHUNK_BYTES` rather
  than dropped, so the cost is time and money, not a silent death — but
  isolating generated output in its own commit helps a human reading the PR more
  than it helps the reviewer. Whether generated files should be *summarised*
  for review rather than included verbatim is a separate question.
- **Ordering.** If the owning sub-task runs mid-plan and a later one changes a
  declared input, the bundle is stale at PR time. The freshness check catches
  it and fails, which is correct but late. The owner should run last.
- **The unclaimed case.** If no sub-task declares any `okf/` path, nobody
  commits the bundle and it goes stale. That is strictly better than today
  (where it also does not get committed, and the contract additionally fails),
  but it is not *good*, which is what phase 2 is for.

## Phase 2 — the dedicated owner

Carel's original suggestion. Once ownership carries authority, give the bundle a
standing owner rather than relying on some sub-task happening to declare one of
its paths: append a generation sub-task to the plan whose declared scope is the
generator's `produces`.

Two constraints shape it:

- **It must be a sub-task, not the orchestrator.** `verify.generators`
  "authorizes worker-side execution only; the harness never runs these scripts
  itself" (`src/config.ts:325`). Assigning the work to the main thread would
  reverse that decision; appending a sub-task gets the same outcome — one owner,
  one commit, one known point in the plan — without touching it.
- **It must be conditional.** Appending it to every run costs money for nothing
  most of the time, and beta.70 already paid for that lesson once (a 19-minute
  speculative `npm run okf` across 1,436 files for a zero diff). rc.6's
  `inputs` is exactly the trigger: append the sub-task only when a declared
  input actually changed. The evidence is already computed by
  `changedGeneratorInputs`.

It should run **last**, for the ordering reason above.

## Sequencing

| Phase | Change | Unblocks |
| --- | --- | --- |
| 1 ✅ | Ownership-scoped revert; retire the rc.6 overlap error; repurpose the preflight | StitchGuard runs with its existing config, unedited |
| 2 | Conditional generation sub-task, appended last, triggered by changed `inputs` | The bundle has a standing owner instead of an accidental one |
| 3 | Generated-output handling in review (summarise rather than diff verbatim) | The cost of owning a 1,663-file bundle |

Phase 1 is the whole of the fix for the reported problem. Phases 2 and 3 are
improvements, not prerequisites.
