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
- Independent of the git subprocess, the harness runs an in-process bash guard (`src/safety/bash-guard.ts`) that whitelists commands the LLM workers may execute inside a Claude Agent SDK session. This is orthogonal to the `child_process` call site the scanner flags, but relevant to the overall security posture. See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md#safety) for details.

### What to do about the audit finding

Options, in order of preference:

1. **Acknowledge and ignore.** The finding is expected, documented here, and firing on a known-safe call site. Operator-owned `security.installPolicy` (see OpenClaw docs) can be configured to permit installed plugins with `child_process` usage.
2. **Review the source before install.** [`src/adapters/git-worktree.ts`](src/adapters/git-worktree.ts) is short (< 200 lines). Read it end-to-end; the entire subprocess surface is in one file.
3. **Do not install if the risk profile is unacceptable.** If your OpenClaw deployment cannot tolerate any plugin using `child_process`, this plugin is not for you. There is no version of the harness that avoids git subprocess execution.

### Why the install itself is not blocked

Per the OpenClaw source (`plugins-install-command-*.js`, comment on `DEPRECATED_DANGEROUS_FORCE_UNSAFE_INSTALL_WARNING`):

> `--dangerously-force-unsafe-install` is deprecated and no longer affects plugin installs because built-in install-time dangerous-code scanning has been removed. Configure `security.installPolicy` for operator-owned install decisions.

So `openclaw plugins install git:...` will complete successfully. The `plugins.code_safety` critical finding only surfaces during subsequent `openclaw security audit` runs.

## Other security-relevant surfaces

- **Bash guard for LLM workers.** `src/safety/bash-guard.ts`. Every command a worker attempts to run through the Claude Agent SDK is tokenised (POSIX-ish, not regex-on-a-string), each pipe segment validated independently, base command matched against `safety.bash_whitelist`, `bash_denylist_tokens` refuse-list checked, command-substitution and `/dev/tcp|udp` redirects hard-refused.
- **Read/write path denylist.** `safety.path_denylist` blocks worker reads and writes to secret-bearing paths (`.env`, `.secrets/`, `credentials.db`, `~/.claude/`).
- **PAT handling.** GitHub PATs are fetched from OpenClaw's credential vault at session start, cached in-process for the session lifetime only, and never written to `.git/config` or process argv (git operations use short-lived `x-access-token` URLs). See [`docs/OPERATIONS.md`](docs/OPERATIONS.md#pat-cache-lifecycle) for the full lifecycle.
- **Authorisation.** Session-starting Slack messages, `harness_upload_logs`, and (optionally, via `invokedBy`) `harness_cancel` and `harness_resume` all validate against `slack.authorised_users`.

Full security architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#security-model).
