# OpenClaw Agent Harness

*Status: unreleased candidate* Version `2.0.0-rc.14`

A strict repository change control plane for OpenClaw. The current behavior described here is accurate as of `2.0.0-rc.14`.

## Ordinary workflow

1. Talk to OpenClaw normally. It translates the request, limits, scope, and restrictions into `harness_prepare_change`.
2. Review the structured proposal in Slack and click **Approve and run**. No confirmation phrase or change ID is required.
3. `harness_change_result` returns a safe current or terminal result.
4. After strict readiness passes, review the PR and click **Approve merge**. Merge authority is separate from execution authority.

Natural language is interpreted only into a non-authorizing proposal. Execution
and merge authority come from OpenClaw's host-native Slack interaction callback,
bound to the authenticated sender, account, conversation/thread, one-time token,
operation, and exact pending review/readiness digest. Model/tool arguments and
phrases cannot provide attestations. Missing interaction support, replay, stale
state, or identity/conversation mismatch fail closed.

Proposal freshness and execution lifetime are separate clocks. The reviewed
active-time duration starts when the execution approval is consumed, is stored
durably, and cannot be renewed by retries or recovery.

Confirmed changes cannot pause for questions or widen budget, time, scope, credentials, security posture, or side effects. Any expansion terminates the change. Readiness requires an open matching PR, the exact published SHA, exact green required CI, determinate runtime and security evidence, no secret exposure, and compliance with the confirmed envelope.

The production adapters include the ACP worker boundary in `src/adapters/acp.ts`; public lifecycle authority remains in `src/control/`.

See `docs/CONTROL-PLANE.md`, `docs/ARCHITECTURE.md`, and `docs/INSTALL.md`.
