# Real-test runbook

Use a disposable allowed repository and non-production credentials. Never paste tokens into chat, config, logs, fixtures, or command history. Configure credentials through the OpenClaw credential workflow.

## Configuration

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-agent-harness": {
        "enabled": true,
        "config": {
          "slack": {
            "channel": "C0CONTROL",
            "authorised_users": ["U000001"]
          },
          "repos": {
            "allowed": ["example-org/disposable-control-test"],
            "default_base_branch": "main"
          },
          "budgets": {
            "session_default_usd": 2,
            "session_hard_ceiling_usd": 5
          },
          "loop": {
            "session_hard_timeout_seconds": 900
          },
          "safety": {
            "allow_git_push": true
          }
        }
      }
    }
  }
}
```

## Test sequence

1. Call `harness_prepare_change` for one bounded change and verify no branch, commit, or PR exists yet.
2. Confirm through the authenticated host flow. Verify exactly one durable dispatch intent and one autonomous execution.
3. Poll `harness_change_result`. The only successful pre-merge terminal state is `pr_ready`; failures must expose only a stable code and safe summary.
4. Verify the PR repository, base, open state, head SHA, required CI, runtime/security evidence, scope, credential route, elapsed time, and spend all match the confirmed proposal.
5. Call `harness_merge_change` through a separate authenticated host decision. Verify the provider received the attested head SHA and the run reaches `merged` only after provider readback.
6. Repeat merge after a simulated ambiguous provider response. The service must reconcile provider state rather than issuing an unsafe second merge.

Do not install or restart the production gateway as part of this repository test.
