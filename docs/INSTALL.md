# Installation

Prerequisites:

- OpenClaw >= 2026.6.x running in a Node 20+ environment.
- An Anthropic API key exposed to the OpenClaw container as `ANTHROPIC_API_KEY`.
- `pnpm` available inside the container (or wherever you run the plugin).
- GitHub personal access tokens stored in the OpenClaw credential vault, one per (user, org). See [`CONFIGURATION.md`](CONFIGURATION.md#pat-routing) for naming.

## 1. Install the Claude Agent SDK

The harness embeds `@anthropic-ai/claude-agent-sdk`. Install into your OpenClaw container image via a Dockerfile addition:

```dockerfile
# after the existing OpenClaw install steps, before USER node:

RUN npm install -g @anthropic-ai/claude-agent-sdk \
 && mkdir -p /home/node/.claude \
 && chown -R 1001:1001 /home/node/.claude
```

If you also want the interactive CLI available for debugging:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code
```

Persistent session directory (mount as a volume):

```yaml
# docker-compose or Unraid template
volumes:
  - /mnt/user/appdata/openclaw/claude:/home/node/.claude
```

## 2. Clone the plugin

Into your OpenClaw plugins directory:

```bash
git clone https://github.com/CarelvanHeerden/openclaw-agent-harness \
  ~/.openclaw/plugins/openclaw-agent-harness
cd ~/.openclaw/plugins/openclaw-agent-harness
pnpm install
pnpm build
```

## 3. Configure

Edit `~/.openclaw/openclaw.json` (or use `openclaw config patch`) and add the plugin config. Minimal example:

```json
{
  "plugins": {
    "openclaw-agent-harness": {
      "slack": {
        "channel": "C0XXXXXXXXX",
        "authorised_users": ["U07UT6G8LQ4"]
      },
      "budgets": {
        "monthly_per_user_usd": 1000,
        "session_default_usd": 50,
        "session_hard_ceiling_usd": 200
      },
      "repos": {
        "allowed": ["example-org/example-repo"]
      },
      "models": {
        "lead": "claude-fable-5",
        "worker": "claude-sonnet-5",
        "adversary": "claude-fable-5"
      }
    }
  }
}
```

See [`CONFIGURATION.md`](CONFIGURATION.md) for all options.

## 4. Store the GitHub PATs in the vault

Using OpenClaw's credential vault, add one entry per (user, org):

```bash
# example naming convention
openclaw memory credential-store --service github-carel-example-org   --type token --value 'ghp_...'
openclaw memory credential-store --service github-carel-personal        --type token --value 'ghp_...'
openclaw memory credential-store --service github-francois-example-org --type token --value 'ghp_...'
```

Do NOT run these commands with the gateway live; add them via a maintenance window, or use the plugin `credential_store` tool from a session.

## 5. Restart the gateway

```bash
docker restart openclaw-gateway
```

Or via OpenClaw's `gateway restart` tool.

## 6. Smoke test

Post the following in your configured Slack channel:

```
harness: add a comment to README.md saying hello from the agent harness
```

Expected behaviour:

1. The harness starts a thread.
2. It asks 1-2 clarifying questions (or accepts the prompt as-is if it deems it clear).
3. Fable-5 lead plans a single Sonnet worker sub-task.
4. Worker edits `README.md`, commits to a new branch.
5. Adversarial reviewer signs off.
6. Draft PR opens under your GitHub identity.
7. Slack thread posts the PR link + cost summary.

## Troubleshooting

- **`claude --version` fails inside container.** Rebuild the image with the Dockerfile changes in step 1.
- **`ANTHROPIC_API_KEY missing`.** Set it in the container env; the SDK inherits from `process.env`.
- **GitHub PAT 401.** Confirm the token has `repo` scope. For org-level SAML SSO enforcement, authorise the token via the org's PAT settings page.
- **Session stuck.** Check `~/.openclaw/workspace/openclaw-agent-harness/state.db`, table `sessions`, for the row's status. If `interrupted`, use the plugin's `harness_resume` tool.
- **Costs unexpectedly high.** Inspect `audit_log` and `sub_tasks` for the offending session. Consider lowering `session_default_usd` in config.
