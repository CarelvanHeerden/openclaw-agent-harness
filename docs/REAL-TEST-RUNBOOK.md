# Real-test runbook

Getting `openclaw-agent-harness` to a first live run against a real repo,
a real Slack channel, and (optionally) a real Vercel project.

## 0. Prerequisites

- OpenClaw runtime that supports the plugin SDK shape used by
  `memory-hybrid` (mirrored here). Node 24+.
- A private Slack channel for dev requests. Recommended: `#infosecbot_dev`.
- A GitHub PAT scoped to the target repos with `repo, workflow` (and
  `contents:write` for org-owned repos). Store in the hybrid-memory
  credential vault as e.g. `github-<user>-<org>`.
- A Slack bot token with `chat:write, reactions:read, reactions:write,
  channels:history, groups:history`. Store in the vault as e.g.
  `slack-openclaw-agent-harness`.
- (Optional) A Vercel token if you want the adversary to see real
  preview-deploy logs. Vault service e.g. `vercel-openclaw-agent-harness`.

## 1. Config

Add the plugin block to `~/.openclaw/openclaw.json` under `plugins.entries["openclaw-agent-harness"].config`. This is the standard OpenClaw plugin config path (same shape as `openclaw-hybrid-memory`, `okf`, etc.); the plugin reads it at runtime via `api.pluginConfig`.

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-agent-harness": {
        "enabled": true,
        "config": {
          "slack": {
            "channel": "C0INFOSECBOTDEV",
            "authorised_users": ["U07UT6G8LQ4"],
            "credential_service": "slack-openclaw-agent-harness",
            "reactions_poll_ms": 15000
          },
          "budgets": {
            "monthly_per_user_usd": 1000,
            "session_default_usd": 50,
            "session_hard_ceiling_usd": 200
          },
          "repos": {
            "allowed": [
              "CarelvanHeerden/openclaw-agent-harness",
              "example-org/example-repo"
            ],
            "default_base_branch": "main"
          },
          "models": {
            "lead": "claude-fable-5",
            "worker": "claude-sonnet-5",
            "adversary": "claude-fable-5",
            "classifier": "claude-haiku-4-5"
          },
          "loop": {
            "max_cycles": 3,
            "worker_timeout_seconds": 1800,
            "adversary_timeout_seconds": 900,
            "session_hard_timeout_seconds": 7200
          },
          "pat_routing": {
            "default_service_pattern": "github-{user}-{org}",
            "overrides": {
              "U07UT6G8LQ4": {
                "CarelvanHeerden/openclaw-agent-harness": "github-carel-personal",
                "example-org": "github-carel-example"
              }
            },
            "commit_identity": {
              "U07UT6G8LQ4": { "name": "Carel van Heerden", "email": "dev@example.com" }
            }
          },
          "storage": {
            "state_db_path": "~/.openclaw/workspace/openclaw-agent-harness/state.db",
            "worktree_root": "~/.openclaw/workspace/openclaw-agent-harness/worktrees",
            "audit_retention_days": 90,
            "prune_terminal_sessions": 365
          },
          "safety": {
            "worker_permission_mode": "acceptEdits"
          },
          "vercel": {
            "enabled": false,
            "credential_service": "vercel-openclaw-agent-harness",
            "project_id": "prj_...",
            "preview_wait_seconds": 300
          }
        }
      }
    }
  }
}
```

## 2. Start-of-day checks

Before opening the channel to teammates:

1. `openclaw config validate` -- confirms
   `plugins.entries["openclaw-agent-harness"].config` parses without
   throwing. If it screams `slack.channel is required`, the block
   isn't loaded (check for typos in `plugins.entries` vs `plugins`).
2. `openclaw plugins list | grep openclaw-agent-harness` -- confirm
   the runtime picked up the plugin.
3. Post `:eyes:` on any test message you send. The harness reacts
   with `:eyes:` to acknowledge every `start_new_session`. No reaction
   = the Slack listener isn't wired.

## 3. First live request

Post in the channel (top-level, not in a thread):

```
Add a /hello endpoint to openclaw-agent-harness that returns "hi".
```

Expected trail of Slack messages:

1. `:eyes:` reaction on your message (instant)
2. `:brain: Understood: *Add /hello endpoint*` with acceptance criteria
3. `:memo: Planning...`
4. `:hammer: Executing cycle 1...`
5. `:mag: Adversarial review of cycle 1...`
6. Either:
   - `:tada: PR opened: <url>` (happy path), or
   - `:x: Session failed: <reason>` (with details), or
   - `:octagonal_sign: Session aborted: <reason>`

## 4. Reactions cheat sheet

Drop the emoji on any bot-authored message in the thread:

- `:rocket:` (`ship_it`): ship the current cycle's diff even if the
  adversary said "revise". Only counts during `reviewing`.
- `:x:` (`abort`): kill the session at the next checkpoint.
- `:pause_button:` (`pause`): (planned) pause the session; not wired
  in Phase 1.
- `:moneybag:` (`budget_bump`): allow the session to blow through
  its session budget cap. Still capped by the monthly per-user cap.

Only reactions from `slack.authorised_users` count.

## 5. Troubleshooting

**`plugins.entries["openclaw-agent-harness"]` not loading at all.**
Check `openclaw config get plugins.entries` -- if the harness key is
missing, verify (a) `plugins.entries["openclaw-agent-harness"].enabled`
is `true`, and (b) you edited `~/.openclaw/openclaw.json` (not a
workspace-local file that OpenClaw doesn't read). A common mistake is
putting the block at the top level (`harness: { ... }`) or one level up
(`plugins."openclaw-agent-harness"`) instead of under
`plugins.entries."openclaw-agent-harness".config`.

**Session stuck in `crystallising`.** The classifier or crystalliser call
failed. Check `harness_session_get { sessionId }` for the last audit
event. Common cause: SDK API key not set in the OpenClaw runtime env.

**Session stuck in `planning`.** The lead model returned a plan that
failed validation. Look at `audit_log` for `loop.plan_failed`. Common
causes: repo not in `repos.allowed`; branch didn't start with
`harness/`; sub-task count > 20.

**No reactions ever picked up.** `slack.credential_service` not set, or
the vault credential missing. Poller logs "reactions poller not started"
on bootstrap when this happens.

**Adversary always flags "no runtime data".** This is intentional if
`vercel.enabled: false`. When enabled, look for `[vercel]` warnings in
the log; usually a bad `project_id` or missing team scope on the token.

## 6. Kill switch

`harness_retention_prune { forceAbortInFlight: true }` will abort every
non-terminal session. Not a normal operation -- use only when a runaway
session is burning budget and you can't drop a `:x:` reaction fast enough.

## 7. Post-run housekeeping

After a run:

1. Confirm the PR looks sane before merging. Non-pass adversary
   verdicts open as *draft* so nothing merges on autopilot.
2. If the PR gets merged, the harness does NOT delete the worktree
   automatically. Run `harness_retention_prune {}` to clean up terminal
   sessions older than `storage.prune_terminal_sessions` days.
3. Check `budgets_monthly` for the current month:
   `SELECT * FROM budgets_monthly WHERE user = 'U...';`

## 8. Known Phase-1 limitations

- Sub-task recovery on container restart is coarse: any stale in-flight
  session is marked `interrupted`, not resumed automatically. Manual
  resume path lands in Phase 2.
- No parallel sub-task execution yet; sub-tasks run sequentially. Fine
  for < 8 sub-tasks per cycle.
- Slack messages are sent through `api.sendMessage`; if the OpenClaw
  runtime doesn't wire it, they no-op. Use `harness_session_get` to
  inspect state instead.
- Cost tracking uses estimator-derived numbers from the SDK's `result`
  message. Real Anthropic invoicing may differ by a few percent.
