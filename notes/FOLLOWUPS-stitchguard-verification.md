# Follow-ups: StitchGuard verification pipeline

The `--include=dev` bootstrap fix (rc.8, `src/adapters/git-worktree.ts`) closes
one cause of `env_unavailable` / exit 127: devDependencies were skipped in the
allocated worktree because the harness inherits `NODE_ENV=production` and the
lockfile branch of the bootstrap did not pass `--include=dev`.

**It does not make StitchGuard's verification pipeline pass.** Three further
obstacles were observed during local verification and are deliberately out of
scope for that patch. They are recorded here so the next person does not
re-diagnose them, and so the bootstrap fix is not mistaken for a complete
answer.

## 1. Prisma client generation

Verification needed `prisma generate` to have run. The bootstrap passes
`--ignore-scripts` (beta.69 F4), which is what stops a `postinstall` from
generating the client — and `--ignore-scripts` is load-bearing: it is what kept
puppeteer/native postinstalls from crashing the bootstrap outright in forensic
`1f2e6642`.

So this is a real design question, not an oversight. Options, roughly in order
of how much they concede:

- Let the plan own it. A repo that needs a generated client can declare it
  under `verify.generators`, which since rc.7 has the vocabulary for exactly
  this: a script, its inputs, and the tree it owns. Costs a worker turn.
- Run a declared, allow-listed set of generation scripts after the install.
  Narrower than dropping `--ignore-scripts`, but it is still the harness
  executing repo-authored code at allocation time.
- Drop `--ignore-scripts` for lifecycle scripts only. Cheapest to write, and
  it reopens beta.69 (F4).

Worth checking first whether beta.110's in-worktree cache handling and rc.7's
generator ownership already cover the realistic cases, since a generated Prisma
client is a generated tree like any other.

## 2. Missing `@testing-library/dom` peer

An unmet peer dependency. The bootstrap passes `--legacy-peer-deps` (beta.85,
after session `696226e4` lost its whole install to an ERESOLVE conflict), which
means npm does not install missing peers and does not fail on them either — so
a package that needs `@testing-library/dom` at runtime finds nothing.

This is the cost of beta.85's trade and it was taken knowingly: verification is
CI-only, and the worker needs importable modules for reads more than it needs a
strict peer tree. Whether the trade still holds now that check scripts run in
the worktree is the open question. Before changing the flag, confirm this is a
harness problem at all — a genuinely undeclared peer is the target repo's bug,
and the harness should say so rather than paper over it.

## 3. Node heap size

Verification needed a larger heap than the default. Nothing in the harness sets
`NODE_OPTIONS` for check scripts, so today this can only be fixed on the host.
If it turns out to be common rather than StitchGuard-specific, the question is
whether the harness should raise the ceiling for check scripts it spawns, and
if so whether that is configurable per repo. An OOM is also worth classifying:
it currently looks like an ordinary non-zero exit, which is a finding, when it
is much closer to `env_unavailable`.
