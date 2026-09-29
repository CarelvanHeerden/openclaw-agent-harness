# Operations

Monitor `control_runs`, `control_dispatch_intents`, immutable `control_readiness_attestations`, and `control_engine_merge_intents`. A stale dispatch can be reclaimed only after its lease expires; every completion checks the current fence. A merge retry first inspects provider state and reconciles any prior side effect.

The installed OpenClaw host must deliver the documented `message_received` hook
with authenticated sender, channel/account/conversation/thread, session key,
message ID and timestamp. The harness stores that raw turn without interpreting
its words. OpenClaw performs the natural-language translation and calls the
typed confirm or merge tool in the same session. Missing or mismatched host-turn
metadata leaves authority unavailable.

`control_proposals.proposal_expires_at` governs how long a proposal may wait for
approval. `control_authority_activations.execution_expires_at` governs the
approved autonomous run. The latter is created once, in the same transaction as
confirmation, and must never be rewritten during retry or recovery.

Do not manually edit control state or readiness rows.
