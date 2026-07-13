# Real-test runbook

The harness is scaffolded, wired, and unit-tested end-to-end with mocked
adapters. Before Carel drives a real Slack request through it, the
following prerequisites must be met.

## 1. Config (openclaw.json)

Add a `harness` block to your OpenClaw config:

```json
{
  "plugins": {
    "openclaw-agent-harness": {
      "enabled": true,
      "config": {
        "slack": {
          "channel": "C0DEVCHAN",
          "authorised_users": ["U07UT6G8LQ4"]
        },
        "repos": {
          "allowed": ["CarelvanHeerden/*"],
          "default_base_branch": "main"
        },
        "budgets": {
          "session_default_usd": 25,
          "session_hard_ceiling_usd": 100
        },
        "pat_routing": {
          "overrides": {
            "U07UT6G8LQ4": {
              "CarelvanHeerden": "github-carel-personal"
            }
          },
          "commit_identity": {
            "U07UT6G8LQ4": {
              "name": "Carel van Heerden (via harness)",
              "email": "carel@stitch.money"
            }
          }
        },
        "vercel": {
          "enabled": false
        }
      }
    }
  }
}
```

## 2. Credentials vault

The PAT currently lives at
`~/.openclaw/workspace/.secrets/github-carel-personal.txt` (mode 0600).
Move it into the encrypted credential vault before enabling the plugin
in production:

```
credential_store service=github-carel-personal type=token value=<PAT>
```

Until then, dev-mode file lookup can be enabled by setting
`OAH_DEV_CRED_DIR=/home/node/.openclaw/workspace/.secrets` in the OpenClaw
gateway environment. Do **not** do this in production.

## 3. Slack channel

Create private channel `#infosecbot_dev` and add the OpenClaw Slack bot.
Copy the channel id (`C…`) into `harness.slack.channel` above.

## 4. Enable and reload

Restart the OpenClaw gateway to pick up the plugin:

```
docker restart infosecbot-gateway
```

Watch the logs for:

```
[harness] openclaw-agent-harness@0.1.0 ready
```

## 5. First real request

Post in `#infosecbot_dev` (top-level, not in a thread):

> Add a `/hello` route to `openclaw-agent-harness` that returns `{"ok": true}`.

Expected sequence in-thread:

1. :eyes: reaction on your message
2. `:brain: Understood: *…*` with acceptance criteria
3. `:memo: Planning…`
4. `:hammer: Executing cycle 1…`
5. `:mag: Adversarial review of cycle 1…`
6. `:tada: PR opened: https://github.com/CarelvanHeerden/openclaw-agent-harness/pull/N`

## 6. Kill switches (during a run)

React on the bot's first thread message with:

- `:x:` — hard abort
- `:pause_button:` — pause (currently soft; the loop still finishes the current sub-task)
- `:rocket:` — force ship (only takes effect during the `reviewing` state)
- `:moneybag:` — one-shot budget bump

Reactions are polled by the reaction service (Phase D) — until it lands,
this rig relies on the Claude SDK's own permission-mode fallbacks.

## 7. Post-mortem

After a run:

```
sqlite3 ~/.openclaw/workspace/openclaw-agent-harness/state.db \
  "SELECT id, status, cycles_ran, cost_usd, final_pr_url FROM sessions ORDER BY created_at DESC LIMIT 5;"
```

## 8. Known limitations at Phase 1

- Reactions are read from `sessions.reactions_json`, which is written by
  a poller not yet wired (Phase D). Effective override reactions currently
  need a manual DB write to test.
- Cost totals per-model are aggregated coarsely; per-sub-task attribution
  lives on Phase D.
- No multi-repo cross-cutting yet: `plan.repo` is a single string.
- Session recovery marks stale sessions as `aborted` on plugin start
  rather than resuming. Resume is scaffolded (`last_worker_sdk_session`)
  and will be wired next iteration.
- `pause` reaction is not yet honoured by the loop.

## 9. If something breaks

1. Check the gateway logs for `[harness]` prefixed lines.
2. Query `audit_log` for the session id: every state transition is logged.
3. If a session is stuck: `UPDATE sessions SET status = 'aborted' WHERE id = '…'`, then restart.
4. If a worktree is stuck: `rm -rf ~/.openclaw/workspace/openclaw-agent-harness/worktrees/<sessionId>`.
