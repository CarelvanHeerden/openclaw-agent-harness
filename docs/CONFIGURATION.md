# Configuration

All options live under `plugins.entries["openclaw-agent-harness"].config` in `~/.openclaw/openclaw.json`. This is the standard OpenClaw plugin config path (same shape as `openclaw-hybrid-memory`, `okf`, etc.), and it is what the plugin reads at runtime via `api.pluginConfig`.

The surrounding `plugins.entries[<id>]` object also supports an `enabled` boolean and a `hooks` object; those are managed by OpenClaw itself, not the plugin.

## Full reference

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-agent-harness": {
        "enabled": true,
        "config": {
          // Slack surface
          "slack": {
            "channel": "C0XXXXXXXXX",              // required
            "authorised_users": ["U07UT6G8LQ4"],   // required, allow-list
            "reactions": {
              "ship_it":      "rocket",
              "abort":        "x",
              "pause":        "pause_button",
              "budget_bump":  "moneybag"
            }
          },

          // Money guardrails (USD)
          "budgets": {
            "monthly_per_user_usd":      1000,
            "session_default_usd":       50,
            "session_hard_ceiling_usd":  200,
            "daily_warn_usd":            100,
            "monthly_warn_ratio":        0.8    // ping user at 80% of monthly
          },

          // Repos the harness may operate on
          "repos": {
            "allowed": [
              "example-org/example-repo"
            ],
            "can_create":         true,          // may create new repos on request
            "create_org":         "example-org",
            "create_visibility":  "private",     // "private" | "public"
            "default_base_branch": "main",
            // Generated trees a worker may regenerate but must never commit.
            // Empty by default. Set this for any repo with a checked-in
            // generated bundle -- see "Generated trees" below.
            "never_commit_paths": ["okf/**"]
          },

          // Model selection
          "models": {
            "lead":       "claude-fable-5",
            "worker":     "claude-sonnet-5",
            "adversary":  "claude-fable-5",
            "classifier": "claude-haiku-4-5",    // intent classification
            // Anthropic API key for the embedded Claude Agent SDK.
            // Vault-first, then env fallback. REQUIRED for headless/Docker
            // (else the SDK falls back to interactive /login). See docs/AUTH.md.
            "auth": {
              "credential_service": "anthropic-harness",  // vault service (type api_key), preferred
              "api_key_env":        "ANTHROPIC_API_KEY"   // env fallback (default shown)
            }
          },

          // Loop controller
          "loop": {
            "max_cycles":                    3,
            "adversarial_pass_ends_early":   true,
            "worker_timeout_seconds":        600,
            "adversary_timeout_seconds":     600
          },

          // Brief intake and fidelity
          "brief": {
            // Directories harness_run's `requestPath` may read a spec from.
            // EMPTY BY DEFAULT, which DISABLES file reads -- see
            // "Brief fidelity" below. Point it at the calling runtime's
            // upload directory.
            "request_file_roots":      ["/home/node/.openclaw/media/inbound"],
            "request_file_max_bytes":  262144,        // 256 KB
            "confirm_before_spend":    "high_risk",   // "off" | "high_risk" | "always"
            "confirm_min_risk":        "high",        // under "high_risk" mode
            "bimodal_clarify":         true,          // ask when a brief reads two ways
            "ingest_repo_conventions": true
          },

          // Vercel logs bridge (optional)
          "vercel": {
            "enabled":            false,
            "credential_service": "vercel-projectthanos",
            "team_id":            "example-team",
            "project_id":         "project-thanos"
          },

          // Storage
          "storage": {
            "state_db_path":     "~/.openclaw/workspace/openclaw-agent-harness/state.db",
            "worktree_root":     "~/.openclaw/workspace/openclaw-agent-harness/worktrees",
            "audit_retention_days": 90
          },

          // Safety
          "safety": {
            "worker_permission_mode": "acceptEdits",  // "acceptEdits" | "bypassPermissions" | "plan"
            "bash_whitelist": [
              "git", "pnpm", "npm", "ls", "grep", "cat", "node", "jq", "sed", "awk", "head", "tail", "wc"
            ],
            "bash_denylist_tokens": [
              "sudo", "su", "rm", "shred", "mkfs", "dd", "chmod", "chown", "chgrp", "umount", "mount", "iptables", "reboot", "shutdown", "halt", "poweroff", "kill", "killall", "pkill"
            ],
            "path_denylist": [
              ".secrets/", "credentials.db", ".env", "~/.claude/", "memory/credentials"
            ]
          },

          // PAT routing
          "pat_routing": {
            // For each (Slack user, target org) the plugin looks up a vault entry
            // with service name = "github-<slack_user_short>-<target_org_short>".
            // Explicit overrides here take precedence.
            "overrides": {
              "U07UT6G8LQ4": {
                "example-org":     "github-carel-example-org",
                "example-org-alt":      "github-carel-example-org-alt",
                "CarelvanHeerden":   "github-carel-personal"
              }
            },
            "commit_identity": {
              "U07UT6G8LQ4": {
                "name":  "Carel van Heerden",
                "email": "dev@example.com"
              }
            }
          }
        }
      }
    }
  }
}
```

## Minimal working config

The absolute minimum to boot the plugin cleanly is four fields:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-agent-harness": {
        "enabled": true,
        "config": {
          "slack":  { "channel": "C0XXXXXXXXX", "authorised_users": ["U07UT6G8LQ4"] },
          "repos":  { "allowed": ["example-org/example-repo"] },
          "models": { "lead": "claude-fable-5", "worker": "claude-sonnet-5", "adversary": "claude-fable-5", "classifier": "claude-haiku-4-5" }
        }
      }
    }
  }
}
```

Everything else takes sensible defaults from `src/config.schema.json`.

## Key sections

### Model auth (Anthropic API key)

`models.auth` controls how the embedded `@anthropic-ai/claude-agent-sdk`
authenticates. Resolution is **vault-first, then env**:

- `credential_service` — vault credential name (type `api_key`). Preferred.
- `api_key_env` — env-var name used as fallback (default `ANTHROPIC_API_KEY`).

Without a resolvable key the SDK falls back to interactive `/login`, which
fails in a headless container (`Not logged in · Please run /login`).
`harness_health` surfaces this as a fatal `model_auth_resolvable` check;
`harness_health { deep: true }` additionally verifies the key authenticates.
Full guide: `docs/AUTH.md`.

### PAT routing (GitHub auth)

`pat_routing.default_service_pattern` builds the vault credential service name
for git tokens. Placeholders (lower-cased): `{owner}`, `{repo}`, `{provider}`,
`{userid}` (NOT lower-cased — see below), and the deprecated aliases `{user}`
(requester login) / `{org}` (repo owner).

**Keep it consistent with `onboard_service_pattern`.** `harness_onboard` writes
the vault entry from `onboard_service_pattern` (default `git-pat:{userid}`),
while sessions read via `default_service_pattern` (default `{provider}-{owner}`).
`{userid}` — the requester's raw Slack id — is the only placeholder both
understand, so it is the one to use if you want per-user tokens. It is not
lower-cased on either side, because Slack ids are upper-case and the two spellings
must match byte for byte. With the two defaults left alone the names cannot
agree; since beta.133 onboarding refuses in that case rather than storing a
token that no session will ever look up.

**Default: `{provider}-{owner}`.** The old `github-{user}-{org}` default
collapsed to a duplicated segment for personal repos (`{user}` == `{org}` ==
owner), so prefer `{owner}` or `{owner}-{repo}`. The prefix was itself hard-coded
to `github-` until it was noticed that one person's GitHub and GitLab tokens for
a same-named org land on a single name, where the second overwrites the first.
`{provider}` expands to `github` on GitHub repos, so the new default reads
identically to the old one on a single-provider GitHub deployment — it only
differs where the old name was wrong.

For per-org credentials, prefer `harness_onboard` (see below), which does not use
this pattern at all: it keys each entry on provider, org and person together.

**Multi-user:** map Slack ids to provider logins in `pat_routing.user_identities`
and use `{requester}` (or `{provider}-{requester}`) in the template so each
requester resolves their own token. **Multi-provider:** `default_provider`
(github|gitlab), `provider_by_owner`, and per-provider `providers.<p>.api_base`
+ `providers.<p>.api_key_env` (`GH_TOKEN` / `GITLAB_TOKEN`). The requesting
user's Slack id is threaded from the session into resolution.

`harness_health` reports `git_credential_resolvable` (fatal) and, with
`{ deep: true }`, a provider-aware `git_credential_live_ping`. Full guide:
`docs/GITHUB_AUTH.md`.


Every commit and PR is attributed to the requesting user, using their own PAT for the target org. The harness resolves the token in this order:

1. Explicit override in `pat_routing.overrides[<slack_user>][<target_org>]`.
2. Convention-based lookup: `github-<slack_user_short>-<target_org_short>`.
3. Fail the session with a clear error listing the expected service name.

Tokens are fetched from the OpenClaw credential vault at session start and used through a short-lived `x-access-token` URL. They are never written to `.git/config` or the process argv.

### Budgets

- **Per session:** each session reserves `session_default_usd` at start. On overrun up to `session_hard_ceiling_usd`, the harness posts a warning and continues. Beyond the ceiling, the session is killed.
- **Per user per day:** at `daily_warn_usd` the requester gets a DM.
- **Per user per month:** at `monthly_warn_ratio * monthly_per_user_usd` the requester gets a DM. New sessions past `monthly_per_user_usd` are refused unless the requester explicitly overrides with an audit-logged reaction.

### Repos allow-list

Sessions may only operate on repos listed in `repos.allowed` unless the user explicitly asks the harness to create a new repo. In that case:

- New repos are created under `repos.create_org` with visibility `repos.create_visibility`.
- The new repo is added to the running config's allow-list for the remainder of the session.
- On session end, the newly created repo is either persisted in the config (if the user confirms) or left in the ad-hoc allow-list for future sessions.

### Generated trees (`repos.never_commit_paths`)

Set this for any allow-listed repo that keeps a **generated bundle checked in** —
generated API docs, a regenerated schema index, snapshot fixtures. Glob patterns,
matched against paths relative to the repo root:

```
"never_commit_paths": ["okf/**", "docs/generated/**"]
```

Workers stage with `git add -A`, so a build step that regenerates such a tree as
a side effect sweeps the whole thing into the commit. In the run that produced
[PR #961](https://github.com/Stitch-Vercel/ProjectThanos/pull/961), 141 of 154
committed files were a regenerated documentation bundle. The cost is not only a
noisy diff: every review cycle then has hundreds of unrelated files to find new
problems in, and the deterministic final-scope check counts each one as an
out-of-scope write, which is a `medium` finding and therefore blocking. A run
can spend its whole cycle budget on a finding no worker is able to resolve,
because regenerating is exactly what the sub-task was asked to do.

The list runs **after** staging and reverts, not before and ignores. Both halves
matter: unstaging alone leaves the files dirty and the next sub-task's `add -A`
stages them straight back. A commit left holding nothing but excluded paths is
dropped rather than committed empty.

**Empty by default, and never inferred.** A generated tree is indistinguishable
from hand-written code by inspection — `okf/**` is ordinary markdown — so a
harness that guessed would eventually discard someone's real work. Nothing warns
you if you omit it; an unconfigured repo behaves exactly as it did before.

### Brief fidelity (`brief.request_file_roots`)

When a person's specification exists as a file, the calling agent should pass
`harness_run({ requestPath })` and let the harness read the bytes itself, rather
than retyping the spec into `request`. That removes the one hop where a brief
can be paraphrased in transit. If both are supplied the **file wins**, and the
harness records how far the text drifted from it.

This matters more than it sounds. Two beta.119 smokes spent roughly $18 and two
hours each building a feature whose brief had been reworded upstream —
`performedAt` had become `scheduledAt`. The error was obvious on sight; nothing
showed it to anyone. `requestPath` is the mechanism that stops it.

**`request_file_roots` is empty by default, and empty means `requestPath` is
refused** with `code: "disabled"`. The caller's only remaining option is to pass
the spec inline, which is exactly the hop the feature exists to remove. So the
safeguard is off until you name the directory:

```
"request_file_roots": ["/home/node/.openclaw/media/inbound"]
```

Point it at wherever the calling runtime stores user uploads. For OpenClaw in
Docker that is `~/.openclaw/media/inbound`. `~` is expanded, and a configured
root that does not exist simply matches nothing — so a typo fails the same way
as no configuration at all, just with a different code. Verify with a real file
rather than assuming.

The default is empty on purpose. The harness holds GitHub tokens, and a brief's
contents reach model prompts and PR bodies, so an operator has to name the safe
directories rather than have the harness guess. Reads are constrained
accordingly: the path must be absolute, symlinks are resolved *before* the root
check so a link planted inside an allowed root cannot escape it, credential-shaped
filenames are refused by basename, content with NUL bytes is rejected as binary,
and anything over `request_file_max_bytes` (256 KB) is refused rather than
truncated.

### Safety

- **`worker_permission_mode`.** The Claude Agent SDK permission mode used for workers. `acceptEdits` is a sensible default: file edits happen without a prompt, bash commands go through the whitelist / denylist.
- **`bash_whitelist` / `bash_denylist_tokens`.** Enforced by an SDK permission callback, not just prompt discipline. `bash_denylist_tokens` is a list of exact command tokens (e.g. `rm`, `sudo`); a command is rejected if any pipe segment's base command (after env-var prefix stripping) matches a listed token.
- **`path_denylist`.** Directories and files that workers may not read or write. Enforced by hooking into the SDK's tool interface. The lead orchestrator itself is NOT constrained by this list.

### Vercel bridge

When enabled, after each execute cycle the adversarial reviewer receives:

- the latest preview deployment URL for the current branch,
- the last 200 log lines from that deployment,
- any deployment errors or build failures.

The harness never triggers deploys; it only observes.
