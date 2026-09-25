# OpenClaw Agent Harness

*Status: release candidate* Version `2.0.0-rc.13`

A strict, tool-driven repository change control plane for OpenClaw. The current behavior described here is accurate as of `2.0.0-rc.13`.

## Ordinary workflow

1. `harness_prepare_change` resolves the authenticated repository and immutable base without starting work.
2. `harness_confirm_change` consumes a fresh host-verified attestation and starts autonomous execution.
3. `harness_change_result` returns a safe current or terminal result.
4. `harness_merge_change` consumes a separate host-verified attestation and revalidates exact-head readiness before merge.

Confirmations and merges are minted only from OpenClaw's documented `message_received` hook. A process-local broker accepts a narrow explicit human sentence, binds the authenticated sender, channel/account/conversation/thread, host message ID, timestamp, nonce, operation, and exact pending review/readiness digest, then permits one matching tool call for at most 60 seconds. Tool/model arguments cannot provide attestations. Missing hooks, internal/runtime/subagent events, ambiguity, replay, stale state, identity or conversation mismatch, and material modifiers that do not exactly match the prepared state all fail closed.

Confirmed changes cannot pause for questions or widen budget, time, scope, credentials, security posture, or side effects. Any expansion terminates the change. Readiness requires an open matching PR, the exact published SHA, exact green required CI, determinate runtime and security evidence, no secret exposure, and compliance with the confirmed envelope.

The production adapters include the ACP worker boundary in `src/adapters/acp.ts`; public lifecycle authority remains in `src/control/`.

See `docs/CONTROL-PLANE.md`, `docs/ARCHITECTURE.md`, and `docs/INSTALL.md`.
