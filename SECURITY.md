# Security Notes

## Expected `security audit` finding: `plugins.code_safety` (critical)

Running `openclaw security audit` (or `--deep`) after installing this plugin will surface a **critical** finding like:

```
Plugin "openclaw-agent-harness" contains dangerous code patterns:
  Shell command execution detected (child_process)
  (src/adapters/git-worktree.ts:172)
  Shell command execution detected (child_process)
  (dist/adapters/git-worktree.js:149)
```

**This is expected and reviewed. It is not a security bug.** As of OpenClaw 2026.5.x the built-in `child_process` scanner has no per-plugin allowlist, comment-suppression, or manifest-level exception mechanism, so the finding cannot be silenced from within the plugin. It will re-appear on every audit run.

### Why the plugin needs `child_process`

The harness's core job is to run a bounded, whitelisted set of `git` subprocess invocations against a per-session working tree:

- `git worktree add / remove` -- create and tear down isolated per-session worktrees
- `git rev-parse`, `git status`, `git diff`, `git rev-list` -- read repo state
- `git checkout -b`, `git add`, `git commit`, `git push` -- author commits under the requester's identity
- `git format-patch` -- fallback when a push is refused (e.g. SAML SSO org)

There is no OpenClaw plugin API for git operations at any version we have targeted (>= 2026.3.24-beta.2), so subprocess execution is the only viable implementation. Node's `libgit2` bindings would be an alternative but add ~15MB of native code and would still count as native module execution.

### What the code actually does

- Single call site: [`src/adapters/git-worktree.ts`](src/adapters/git-worktree.ts).
- Uses `spawn("git", args, { env })` -- the executable is a hardcoded literal (`"git"`), never user-controlled.
- `args` is a positional string array. It is never interpolated into a shell string. `shell: true` is never passed. This means shell metacharacters (`;`, `|`, `&&`, backticks, `$(...)`) in any input are treated as literal argv, not evaluated.
- `cwd` is always a plugin-owned worktree path derived from config (`storage.worktree_root`), never a user-supplied path.
- Repos the harness can operate on are constrained to `repos.allowed` in plugin config.
- Independent of the git subprocess, the harness runs an in-process bash guard (`src/safety/bash-guard.ts`) that whitelists commands the LLM workers may execute inside a Claude Agent SDK session. This is orthogonal to the `child_process` call site the scanner flags. Read "The threat model, stated plainly" below before treating it as a containment boundary — it is not one.

### What to do about the audit finding

Options, in order of preference:

1. **Acknowledge and ignore.** The finding is expected, documented here, and firing on a known-safe call site. Operator-owned `security.installPolicy` (see OpenClaw docs) can be configured to permit installed plugins with `child_process` usage.
2. **Review the source before install.** [`src/adapters/git-worktree.ts`](src/adapters/git-worktree.ts) is short (< 200 lines). Read it end-to-end; the entire subprocess surface is in one file.
3. **Do not install if the risk profile is unacceptable.** If your OpenClaw deployment cannot tolerate any plugin using `child_process`, this plugin is not for you. There is no version of the harness that avoids git subprocess execution.

### Why the install itself is not blocked

Per the OpenClaw source (`plugins-install-command-*.js`, comment on `DEPRECATED_DANGEROUS_FORCE_UNSAFE_INSTALL_WARNING`):

> `--dangerously-force-unsafe-install` is deprecated and no longer affects plugin installs because built-in install-time dangerous-code scanning has been removed. Configure `security.installPolicy` for operator-owned install decisions.

So `openclaw plugins install git:...` will complete successfully. The `plugins.code_safety` critical finding only surfaces during subsequent `openclaw security audit` runs.

## The threat model, stated plainly

The harness runs a language model that writes and executes code on your machine, against your repositories, with your credentials. The controls below are built for a worker that is **capable but not adversarial** — one that might do something destructive by accident, misread its instructions, or wander outside the task it was given.

**They are not built to contain a worker that is actively trying to get out, and they will not.** If a prompt-injected repository, a poisoned dependency, or a compromised model turns the worker hostile, the controls in this document will not stop it. Run the harness where that outcome is survivable: an environment whose credentials, network reach and filesystem you would be willing to hand to the author of any code the worker reads.

This section was rewritten in `1.0.0-rc.3` after an external review pointed out, correctly, that the previous wording implied a containment boundary that does not exist. What follows separates what is enforced from what is merely discouraged.

### What the bash guard actually does

[`src/safety/bash-guard.ts`](src/safety/bash-guard.ts) tokenises each command (POSIX-ish, not regex-on-a-string), validates each pipe segment independently, matches the base command against `safety.bash_whitelist`, checks `bash_denylist_tokens`, and hard-refuses command substitution and `/dev/tcp|udp` redirects. Within its own terms it is carefully built, and it does stop the accidents it was written for: `rm -rf`, `sudo`, a stray `curl`, `cat .env`.

It is a **speed bump, not a wall**, and the reason is structural. The default whitelist includes `python3`, `node`, `make`, `go`, `cargo`, `npx` and `env` — general-purpose interpreters and build tools. Once any of those is permitted, everything else on the list is advisory, because the guard inspects the command line and not what the interpreter goes on to do. Verified against the shipped default config:

| Command | Guard | What it means |
| --- | --- | --- |
| `python3 exfil.py` | **allowed** | arbitrary code, and `path_denylist` does not apply inside it |
| `node exfil.js` | **allowed** | same |
| `make` | **allowed** | runs whatever the Makefile says |
| `env` | **allowed** | prints the whole environment |
| `echo $ANTHROPIC_API_KEY` | **allowed** | the shell expands it before any file check |
| `cat .env` | denied | the case the guard was written for |
| `cat .e*` | **allowed** | denylist matches literal paths, not globs the shell expands |
| `cat .ENV` | **allowed** | matching is case-sensitive; on macOS the filesystem is not |
| `git show HEAD:.env` | **allowed** | reads the file out of git history instead of the worktree |
| `echo .env \| xargs cat` | **allowed** | the path is data in one segment and an argument in the next |
| `find . -name .env -exec cat {} +` | **allowed** | `-exec` is not treated as a nested command |
| `cat .git/config` | **allowed** | `.git/` is not in the denylist |
| `echo x > .git/hooks/pre-commit` | **allowed** | a hook the next `git commit` executes, outside the guard |

These are properties of the design, not bugs with fixes pending. Adding each row to the denylist buys nothing: `python3` is one line above it. `tests/bash-guard.test.mjs` asserts this table so that it stays honest, and so that nobody mistakes a passing guard suite for containment.

### What is actually enforced

- **`repos.allowed`.** The harness will not operate on a repository outside this list. Enforced in-process, above the worker.
- **PAT scope and ownership.** Nothing pushes without a per-repo, per-user token the requester owns. A worker cannot widen its own reach beyond what that token can do — this is the control that bounds blast radius, and it is enforced by GitHub, not by us. Keep tokens narrow and short-lived; that is the single highest-value thing an operator can do.
- **Git subprocess argument safety.** `spawn("git", args)` with a hardcoded executable, a positional argv array, and no `shell: true`, so metacharacters in any input are literal argv. See above.
- **Authorisation.** Session-starting Slack messages, `harness_upload_logs`, and (optionally, via `invokedBy`) `harness_cancel` and `harness_resume` validate against `slack.authorised_users`.
- **Credential storage at rest.** The harness's own vault is AES-256-GCM encrypted, in a SQLite file, with a `0600` key file. `harness-vault/`, `vault.key` and `vault.db` are in the default `path_denylist`, and the vault key environment variable is stripped from worker subprocesses.

### What is best-effort only

- **`safety.path_denylist`** blocks the SDK's `Read`/`Write` tools and direct file arguments to whitelisted commands. It does not survive an interpreter, a glob, a case change or git history — see the table.
- **`safety.allow_network_commands`** removes `curl` and `wget` from the whitelist. It does not prevent network access; `python3`, `node` and `make` all reach the network freely.
- **`safety.bash_denylist_tokens`** blocks the named binaries. It does not prevent what they do — a worker that wants to delete files can do it from Python.
- **`ANTHROPIC_API_KEY` is readable by the worker.** It is injected into the SDK subprocess environment deliberately, so the embedded Claude Code binary does not fall back to interactive `/login` ([`src/adapters/claude-code.ts`](src/adapters/claude-code.ts)). A worker can print it. Scope and rotate that key accordingly.
- **`.git/` is writable by the worker,** including `.git/hooks/`. A hook written during a session runs on the next git operation, outside the guard entirely.

Real containment needs an OS boundary — a sandboxed process with denied egress, read-only mounts and a scoped filesystem view — not a command-line filter. [`docs/WORKER_ISOLATION.md`](docs/WORKER_ISOLATION.md) scopes what that would take and why it is not in this release.

### `2.0.0`: third-party backends make this materially worse

Stated here because nothing else in the v2 release addresses it, and because the change is easy to miss: none of the controls above got weaker, but the assumption holding them up did.

Everything in "The threat model, stated plainly" rests on the worker being **capable but not adversarial**. Through `1.x` that was a reasonable thing to assume rather than enforce: the worker was always an Anthropic model reached through the Claude Code SDK, operating under a commercial agreement, with the vendor's own training and safety work behind it. The bash guard did not have to be a wall, because it was a speed bump in front of something that was not pushing on it.

`2.0.0` lets an operator point any role at an arbitrary OpenCode backend, including a local `@ai-sdk/openai-compatible` endpoint serving weights of unknown provenance. **That assumption is now a configuration choice, and the harness cannot verify it.** The guard is unchanged and still admits `python3`, `node` and `make`, so a worker that wants out of it is one line of Python away — the difference is that the population of workers now includes ones nobody has vetted.

What v2 *does* add is real, and worth being precise about, because it is easy to mistake for containment:

- The permission round-trip is **verified live at startup**, not trusted from config, so a backend that silently stops asking is a startup refusal rather than an unguarded worker ([M6](docs/acp-capability-matrix.md)).
- The ACP child gets the **same filtered environment** as the SDK path, so the vault key, `GH_TOKEN`, `VERCEL_TOKEN` and Slack tokens do not reach it.
- The whole **process group is reaped** on abort and timeout, so a cancelled session cannot leave a model process spending.
- The three judgement roles **refuse to run below a declared `strong` tier**, because a weak lead, adversary or crystalliser fails by returning a confident, well-formed, wrong answer.

All four make the ACP path as good as the SDK path. None of them makes either path a sandbox.

**Operating guidance until an OS boundary lands: run non-Anthropic workers on trusted repositories only.** Concretely — repositories whose contents, dependencies and CI you or your organisation control, where a prompt-injected README or a poisoned transitive dependency is not a realistic input. A third-party backend on an untrusted repository combines an unvetted worker with attacker-controlled instructions inside a guard that was never built to hold either, and the harness will not stop that.

| | |
| --- | --- |
| **Owner** | Carel van Heerden |
| **Exit criteria** | Read-only worker filesystem plus a default-deny egress proxy, per [`docs/WORKER_ISOLATION.md`](docs/WORKER_ISOLATION.md). Both, not either: a read-only mount without egress control still exfiltrates, and an egress proxy without a read-only mount still lets a worker write `.git/hooks/pre-commit`. |
| **Until then** | Non-Anthropic workers are **trusted-repo-only**. This is documented, not enforced — the harness has no way to tell a trusted repository from an untrusted one. |
| **Review** | Re-assessed each minor release; this section is wrong the day the exit criteria land, and should be deleted rather than softened. |

## What the push invariant actually guarantees

The README used to say "nothing pushes until the adversary passes". That is the normal path and it was too strong as an unqualified claim. Precisely, as of `1.0.0-rc.3`:

- An explicit **`block` verdict never pushes.** No path overrides this.
- A **human `:rocket:`** is an intentional override and pushes without an adversary pass.
- Three abnormal endings — a verify sub-task timeout, a resource-ceiling abort, and a crashed review — can push code the *final* cycle's adversary never saw. They do so **only when an earlier cycle was reviewed**, and the result is stamped `needs_human_review`, labelled `do-not-merge` and `harness:unreviewed`, and excluded from the merge tool's override path.
- A session that **no adversary has ever reviewed does not push at all.** Its commits are kept in a preserved worktree and the session stays resumable (`loop.salvage_refused_unreviewed` in the audit log).

The `do-not-merge` label exists so this is enforceable rather than advisory: a repo can require its absence in branch protection. The harness cannot make a human read a PR body.

## Other security-relevant surfaces

- **PAT handling.** GitHub PATs are fetched from the harness's own credential vault at session start, cached in-process for the session lifetime only, and never written to `.git/config` or process argv (git operations use short-lived `x-access-token` URLs). See [`docs/OPERATIONS.md`](docs/OPERATIONS.md#pat-cache-lifecycle) for the full lifecycle.
- **Interaction log redaction.** Token-shaped strings and known-sensitive keys are redacted from the durable interaction log. Redaction is pattern-based and cannot be assumed complete for a custom credential format.

Full security architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#security-model).
