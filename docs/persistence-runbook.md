# Persistence runbook

Where the harness keeps things, which of those places are allowed to disappear,
and what to do on the morning you find out one of them did.

Written after StitchGuard session `f7c4e585`, 14 September 2026, where a
container restart destroyed nine commits that had never existed anywhere else
and the state database survived intact to describe them. The chronology is in
[the incident section](#the-incident-that-produced-this-document) at the end.

---

## 1. The four stores, and what each one costs you

| Store | Default location | Holds | If it is lost |
|---|---|---|---|
| State database | `storage.state_db_path` | Sessions, sub-tasks, findings, audit log | Everything the harness knows *about* its work. Not the work. |
| Worktrees root | `storage.worktree_root` | One checkout per session | The working tree. Recoverable **only** if the commits exist elsewhere. |
| Bare object cache | `<worktree_root>/.repos/<owner>/<repo>.git` | The git objects **all** worktrees are linked to | Every unpushed commit in every session on this machine. |
| Checkpoint root | `storage.checkpoint_root` | Verified git bundles of completed work | Your last line of defence. |

The third row is the one that surprises people, and it is the reason this
document exists. **The bare object cache lives inside the worktrees root.** They
are not two storage decisions; they are one. A mount that is fine to lose
because "it is only scratch checkouts" is also holding the only copy of every
commit those checkouts have made.

The fourth row is off by default. When `checkpoint_root` is empty the harness
says so at startup (`harness.checkpoint_root_unusable`) rather than letting the
absence pass for health.

---

## 2. Deployment requirements

**Required.**

1. `storage.worktree_root` must be on storage that survives a container restart.
   Not tmpfs, not ramfs, not an anonymous Docker volume that is recreated with
   the container. Check it:

   ```bash
   findmnt -no FSTYPE,SOURCE,TARGET -T "$(jq -r .storage.worktree_root config.json)"
   ```

   `tmpfs` in the first column means every unpushed commit on this machine is one
   `docker restart` from gone. The harness raises
   `harness.worktrees_root_volatile` at startup when it can read
   `/proc/self/mountinfo` and sees this; it cannot always read it, and an
   unreadable mount table is reported as UNKNOWN rather than as fine.

2. `storage.checkpoint_root` must be set, and must **not** be inside
   `storage.worktree_root`. A copy that shares the original's mount is not a
   copy — that is the exact mistake `.repos` makes. The harness refuses such a
   configuration with `harness.checkpoint_root_unusable` and runs without durable
   checkpoints rather than pretending.

3. `storage.state_db_path` should be on durable storage too, but note that it
   surviving *alone* is the failure this document is about. A database that
   outlives the work it describes produces confident, false status.

**Recommended.**

- Put all three on the same durable volume, with the checkpoint root as a
  sibling of the worktrees root rather than a child:

  ```
  /data/harness/state/harness-state.db     # storage.state_db_path
  /data/harness/worktrees/                 # storage.worktree_root
  /data/harness/checkpoints/               # storage.checkpoint_root
  ```

- Back up the state DB (`sqlite3 state.db .backup ...`, see
  [OPERATIONS.md](OPERATIONS.md#backups)) **and** the checkpoint root. Backing up
  only the database is the configuration that produced this incident.

- Prune the checkpoint root on the same schedule as terminal-session retention.
  Bundles are small — they hold one branch's commits — but they are not free.

---

## 3. What a durable checkpoint is, and what it is not

`checkpoint()` in the store is a **database write**. It records the current
cycle, the last attempted sub-task and a timestamp. It has never moved a git
object anywhere. Read `last_checkpoint_at` as "the loop was alive at this time",
never as "the work at this point is safe".

A **durable checkpoint** (`src/state/checkpoint-bundle.ts`) is a `git bundle`
written to `checkpoint_root`, and it is taken:

- after every sub-task that **passes verification**, and
- immediately before the loop blocks on a human gate.

Nothing is recorded as durable until `git bundle verify` passes *and* the sha256
of the bytes on disk matches the manifest. The manifest is published by
`rename()` afterwards, so a manifest's existence means the bundle beside it is
complete. A crash mid-write leaves a `.tmp` file and no manifest, which reads as
"no checkpoint" — the safe direction.

Three things are deliberately **not** durable, and are recorded as such:

- A checkpoint with no commits. It is written as metadata with
  `recoverable: false`, because "we reached a human gate having committed
  nothing" is worth knowing and is not recoverable code.
- A bundle that failed to verify. The failure manifest is kept so that "no
  checkpoint was taken" is answerable later, and it never loads as a checkpoint.
- A bundle whose bytes no longer match. Truncation, corruption and same-size
  substitution all load as `null`.

Uncommitted work is never checkpointed and never will be. A bundle contains
commits. If a worker has edits it has not committed, they exist in one place and
only pushing or committing changes that.

---

## 4. Diagnosing a suspected loss

### 4.1 What startup tells you

On every boot the harness walks **from the session rows that claim live work to
the disk that should be holding it** and writes down what it finds. This is the
reverse of the self-heal, which walks disk-to-database and therefore sees
nothing at all when the disk is empty.

| Audit event | Meaning |
|---|---|
| `harness.storage_reconcile` | The walk ran. `findings: 0` here does mean healthy. |
| `harness.session_storage_missing` | A specific session's work cannot be found. One per session. |
| `harness.worktrees_root_volatile` | The worktrees root is on a filesystem that does not survive a restart. |
| `harness.checkpoint_root_unusable` | Durable checkpointing is OFF, with the reason. |
| `harness.storage_reconcile_failed` | The walk itself failed. Not a clean result. |

`harness.worktrees_preflight` reports `writable: true` alongside `fsType` and
`volatile`. Read the `volatile` field, not the legacy `ok` field:
`volatile: null` means the mount table could not be read, which is UNKNOWN and
not a reassurance.

### 4.2 Asking directly

```sql
SELECT id, status, storage_state, storage_reason,
       datetime(storage_checked_at/1000,'unixepoch') AS checked
  FROM sessions
 WHERE storage_state IS NOT NULL AND storage_state != 'ok';
```

| `storage_state` | Meaning |
|---|---|
| `ok` | Worktree, git directory and every recorded commit were found. |
| `missing_worktree` | The recorded checkout is gone. |
| `missing_objects` | The checkout is there; the git directory it points at is not. |
| `missing_commits` | Both exist; commits the database names are not in the repository. |
| `unknown` | **Not checked, or not checkable.** Never read this as healthy. |
| `NULL` | No reconciliation has ever run for this row. |

`harness_progress` carries the same thing as `storage.state`, and a positive
finding is appended to the headline — including on `done`, which is the status
most likely to stop someone looking.

### 4.3 What the harness will refuse

`harness_resume` and `harness_answer` refuse a session whose **recorded commits
have nowhere left to live**, with `tool.resume_refused_storage` /
`tool.answer_refused_storage`. A missing worktree for a session that committed
nothing is *not* refused — beta.101 allocates a fresh one and carries the
branch forward.

A refusal deletes nothing. The row, the clarification pause and every audit
record stay exactly where they were.

---

## 5. Recovery

Work the cheapest source first. Do not delete anything until you have the work
somewhere else; a wrong cleanup is the one mistake that cannot be undone.

### Step 1 — is it already on the remote?

```bash
git ls-remote https://github.com/<owner>/<repo> 'refs/heads/harness/*'
```

A pushed branch means there was never a loss, only a broken local reference.

### Step 2 — is there a durable checkpoint?

```sql
SELECT last_checkpoint_bundle, last_checkpoint_sha FROM sessions WHERE id = ?;
```

Or look directly: `<checkpoint_root>/checkpoints/<sessionId>/*.json`. Restore it
**to a new directory** — `restoreCheckpoint` refuses to write over anything,
deliberately, because the instinct to put things back where they were is how the
last surviving copy gets overwritten:

```bash
git clone --branch <branch> \
  <checkpoint_root>/checkpoints/<sessionId>/<ts>-<sha>.bundle \
  /tmp/recovered-<sessionId>
git -C /tmp/recovered-<sessionId> log --oneline
```

Verify the tip matches `tip` in the manifest before trusting it.

### Step 3 — is the bare cache still there?

If the worktree is gone but `<worktree_root>/.repos/<owner>/<repo>.git` survived,
the commits are in it and the branch ref probably still points at them:

```bash
git -C <worktree_root>/.repos/<owner>/<repo>.git log --oneline <branch>
git clone --branch <branch> <worktree_root>/.repos/<owner>/<repo>.git /tmp/recovered
```

### Step 4 — reconstruction

If steps 1–3 come up empty, the commits do not exist. There is no fourth source.
What remains in the database is a *description*: the sub-task ledger, the files
each one touched, the worker summaries and the audit trail. That is enough to
re-run the work with the same plan. It is not the work.

Say "reconstructed" and not "recovered" when this is what happened. They are
different claims and only one of them means the commits are the same.

---

## 6. The incident that produced this document

**Session** `f7c4e585`, StitchGuard Client Offboarding, 14 September 2026.

The deployment ran the worktrees root on a tmpfs mount and the state database on
a host-backed virtiofs mount. At roughly 19:42 the container restarted. tmpfs
went with it, taking every worktree *and* `.repos/Stitch-Vercel/StitchGuard.git`,
which is nested inside the worktrees root. The database survived perfectly,
holding a session paused at `awaiting_clarification`, a worktree path, and nine
commit SHAs.

Startup then produced two events, neither of them false:

```
5431  harness.worktrees_preflight  {ok:true, created:false}
5432  harness.worktree_heal        {scanned:0, removed:0, errors:[]}
```

`ok:true` meant "I wrote a probe file here and deleted it". `scanned:0` meant
"the directory I enumerate was empty". The self-heal walks disk-to-database, so
an empty root means its loop body never runs — `scanned:0` was not "nothing to
check", it was "nothing left to check with". Nothing in the harness walked the
other way, and nothing in the status surface knew how to say "I have not
looked".

**Recovery assessment: nothing was recoverable, and nothing was reconstructed.**

- Remote: nothing. The run had not reached its push step, by design — pushing is
  a deliberate late stage.
- Checkpoints: none existed. Durable checkpointing did not exist in rc.8.
- Bare cache: gone, on the same mount.
- The nine commits are unrecoverable, permanently.

This was a smoke test, so the work itself was not worth reconstructing and the
run was simply started again. That is the *only* reason this incident cost
nothing. The same sequence on real work would have lost a day of it, and the
harness would have reported success throughout.

Every requirement in section 2 exists because of one specific thing in the
paragraph above.
