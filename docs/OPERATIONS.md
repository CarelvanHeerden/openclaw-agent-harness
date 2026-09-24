# Operations

Monitor `control_runs`, `control_dispatch_intents`, immutable `control_readiness_attestations`, and `control_engine_merge_intents`. A stale dispatch can be reclaimed only after its lease expires; every completion checks the current fence. A merge retry first inspects provider state and reconciles any prior side effect.

Do not manually edit control state or readiness rows.
