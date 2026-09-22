# Human approvals through a non-agent command

## Boundary

`harness_answer` is an automation-only tool. Tool parameters and a tool factory's
requester identity do not prove that a person explicitly sent the answer. The
`answeredBy: "human"` value is rejected, including when the requester is the owner.
Never emulate the direct command from an agent, shell, or another tool.

The plugin registers the logical command `/harness-answer` through OpenClaw's
`registerCommand` API. The host dispatches this before model execution, supplies
the authenticated sender, checks command authorization, and carries the original
command body. The plugin additionally checks its own allowlist, Slack channel
provider, and session ownership. There is no transcript-search or message-ID
assertion fallback. Without that host surface, approval remains blocked.

This is a tool-interface authority boundary, not a sandbox against arbitrary
host code, database access, or a compromised OpenClaw/plugin process.

## Slack routing is a deployment prerequisite

Registering a plugin command does **not** create a Slack app slash command.
An operator must provide a supported inbound route before enabling the workflow:

- With Slack's configured single-command entry point, use
  `/openclaw /harness-answer <sessionId>` (replace `openclaw` with the configured
  `channels.slack.slashCommand.name`). The host dispatches the inner command.
- Alternatively, configure a matching native Slack slash command and OpenClaw
  native-command support according to the installed host's Slack documentation.

Preserve the existing Slack app/configuration; do not replace the manifest or
widen access. Enabling or changing the entry point is a separate operator action.
A normal natural-language DM to the model is **not** equivalent to either route.

## Operator flow

1. Send the logical `/harness-answer <sessionId>` command through the configured
   non-agent route. The response contains the complete current pending state,
   including brief, limits, plan and any proposal, plus a one-use command.
2. Review the entire response. Send the generated command yourself, replacing
   `<your answer>` with your decision and retaining the same routing prefix.
3. For an initial approval, use `confirm`, optionally with explicit budget/time
   controls. To propose edits, use `revise brief: <correction>`; this does not start
   work. Review a revised proposal via a fresh command, then answer with its exact
   `confirm brief <sha256>` instruction.
4. If the pause changes, the receipt expires, or a command fails, inspect progress
   and obtain a fresh review. Never automatically retry a consumed receipt.

Receipts expire after ten minutes, bind the session/requester/full pending-state
hash, and are atomically consumed in SQLite before dispatch. Consumption survives
restart and remains recorded even on subsequent validation or audit failure.
After any asynchronous validation, state is checked again. A changed, sanitized,
or overlong command body fails closed. Command answers are limited to 3,500 total
argument characters and state previews to 24,000 characters; previews are never
silently truncated for approval.

## Release checks

- Run the adversarial provenance tests and mutation checks against packaged code.
- Verify the actual host command dispatcher rejects an unauthorised sender.
- After reviewed installation, test the real Slack entry point with a disposable
  paused session; prove the command bypasses the model and dispatches at most once.
- Until the real Slack route is tested, report it as unverified. An in-process
  host-dispatcher probe does not prove end-to-end Slack routing.
