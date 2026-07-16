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
            "default_base_branch": "main"
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
for GitHub tokens. Placeholders (lower-cased): `{owner}`, `{repo}`, and the
deprecated aliases `{user}` (requester login) / `{org}` (repo owner).

**Default: `github-{owner}`.** The old `github-{user}-{org}` default collapsed
to a duplicated segment for personal repos (`{user}` == `{org}` == owner), so
prefer `{owner}` or `{owner}-{repo}`.

`pat_routing.auth.api_key_env` (default `GH_TOKEN`) is the env-var fallback
used when the vault lookup fails, mirroring `models.auth`. `harness_health`
reports `git_credential_resolvable` (fatal) and, with `{ deep: true }`,
`git_credential_live_ping`. Full guide: `docs/GITHUB_AUTH.md`.


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
