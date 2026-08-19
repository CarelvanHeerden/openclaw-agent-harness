# Release process

How a change gets from a branch to a tag, and what the version number is
allowed to mean at each step.

This exists because we got it wrong once in a way that was expensive to unpick:
two threads independently decided they owned `beta.110`, one branched off an
unpushed local `main`, and a squash merge folded two unrelated changes into a
single commit whose message described only one of them. Everything below is
either a direct consequence of that, or a rule that would have prevented it.

## The one rule

**A branch never carries a version number.** A branch cannot know which release
it will land in — that is decided when it merges, not when it is created. Every
time the number appears in a branch name it is a guess, and two threads can make
the same guess.

The version appears in exactly two places:

- one commit, the release commit, which touches `package.json`,
  `src/version.ts` and `CHANGELOG.md`
- the tag on that commit

Nowhere else. Not in branch names, not in test filenames.

## Branch naming

| Prefix | Holds | Example |
| --- | --- | --- |
| `harness/<topic>` | Ordinary work, found by reading or planning | `harness/credential-vault` |
| `smoke/<yyyy-mm-dd>-<target>` | Fixes found by a specific smoke run, merged as the next release | `smoke/2026-08-19-okf` |

The `smoke/` prefix is not decoration. It records that the fixes came from
*running* the harness rather than reasoning about it, and that distinction has
been worth more than any other signal we have — beta.112 found four defects in
half an hour that way, and beta.114 found that 141 of 154 files in a real PR
were a regenerated documentation bundle. Being able to list `smoke/*` and see
which releases came from real runs is worth one path segment.

If one run produces fixes spanning more than one release, as beta.112 and
beta.113 did, cut both releases off the same branch. The date and target stay
stable; the release numbers are assigned at merge as usual.

## Test file names

Name a test after the release it shipped in *only once that release exists*.
Work that slips a release ends up with a filename that lies, and worse, two
files can claim the same number: `beta110-credential-vault.test.mjs` and
`beta110-scope-blowout.test.mjs` were unrelated changes, and only one of them
was really beta.110.

For work in flight, name it after what it tests — `credential-vault.test.mjs`.
Rename at land time if you want the number, or leave it.

## Unreleased work

Work that is prepped but deliberately not shipping yet:

- **no version bump.** Leave `package.json` and `src/version.ts` at whatever
  `main` says.
- **`## Unreleased` at the top of `CHANGELOG.md`.** The number is filled in when
  it lands.

This costs nothing and it means a long-lived branch cannot collide with a
release cut by somebody else while it waits.

## Version progression

```
0.1.0-beta.N   ->   1.0.0-rc.N   ->   1.0.0   ->   1.1.0 / 2.0.0
```

Semver orders `beta` before `rc` before the release, so the chain is monotonic
and nothing needs a `--force` anywhere. The install path clones a git tag rather
than resolving from npm, so prerelease dist-tag behaviour is not a concern.

**Cutting `1.0.0-rc.1`.** The first smoke that passes clean earns the RC — but
the RC has to *be* the tree that passed, not the tree plus whatever landed
afterwards. Otherwise the release candidate contains changes no smoke has seen,
which is the one thing an RC is supposed to rule out.

So: take the exact commit that passed the smoke, add a **version-only commit**
on top of it — the bump and the changelog heading, no functional change of any
kind — and tag that. `package.json` stays honest, and the tag is one provable
no-op away from a tree that went green.

The same applies to `1.0.0` itself. Tag a tree that already passed a smoke as an
RC. If you change one more thing after the green run, you have shipped something
untested and the smoke bought you nothing.

**After 1.0.0.** Additive work is a minor; anything that forces an operator to
act is a major. Concretely, of the two branches waiting right now: the ACP
worker backend sits behind a flag and leaves the SDK path untouched when the
flag is off, so it is a `1.1.0`. The credential vault is a hard cutover that
removes the `credential_get` tool path and starts empty, so every operator must
re-enter every credential and keep a key file backed up — that is a `2.0.0`, and
it needs a migration note.

## Before you commit, on a shared checkout

More than one agent works in this repository at a time, and a git checkout has
exactly one `HEAD`. A branch you created earlier may not be the branch you are
standing on now.

- **Check the branch immediately before `git add -A`**, not just after
  `git checkout -b`. The gap between those two moments is where the beta.110
  commit went astray.
- **Prefer a linked worktree** (`git worktree add <path> -b <branch> origin/main`)
  for anything that will take more than one sitting. Two worktrees cannot pull
  `HEAD` out from under each other.
- **`git checkout -b <name> origin/main` sets the new branch's upstream to
  `origin/main`.** A later bare `git push` then targets main. Either push
  explicitly (`git push origin <branch>:<branch>`) or fix the upstream first.
- **Before branching off local `main`, compare it to `origin/main`.** If it is
  ahead, find out why before you build on it.

## Releasing

1. Merge the work by PR. Branch protection requires it, and the squash message
   is what the changelog will be read against — make it describe everything in
   the merge, not just the part you wrote.
2. Cut the release commit: bump `package.json` and `src/version.ts`, promote
   `## Unreleased` to the number.
3. Tag `v<version>` and push the tag.
4. Deploy that tag and smoke it.
5. If it passes clean and you are at the RC boundary, see above.
