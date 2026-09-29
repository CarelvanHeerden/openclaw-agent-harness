# Operations

Monitor `control_runs`, `control_dispatch_intents`, immutable `control_readiness_attestations`, and `control_engine_merge_intents`. A stale dispatch can be reclaimed only after its lease expires; every completion checks the current fence. A merge retry first inspects provider state and reconciles any prior side effect.

The installed OpenClaw host must expose `registerInteractiveHandler` for Slack
and must deliver Block Kit interactions to plugin handlers. The existing Slack
app must have interactivity enabled at its current callback/socket route. Do not
replace the app manifest or widen its authorized users implicitly. If either
`registerInteractiveHandler` or interactive message delivery is unavailable,
proposal preparation may succeed but execution and merge remain fail-closed.
The harness emits OpenClaw `MessagePresentation` buttons; provider-native Slack
`blocks` are renderer output and are not part of the harness-host contract.

`control_proposals.proposal_expires_at` governs how long a proposal may wait for
approval. `control_authority_activations.execution_expires_at` governs the
approved autonomous run. The latter is created once, in the same transaction as
confirmation, and must never be rewritten during retry or recovery.

Do not manually edit control state or readiness rows.
