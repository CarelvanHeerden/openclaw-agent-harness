# Persistence runbook

`control_runs` is canonical. `control_proposals` stores immutable confirmed inputs and generation metadata. `control_dispatch_intents` stores fenced execution ownership. `control_readiness_attestations` is immutable and content-addressed. `control_engine_merge_intents` records provider reconciliation.

The migration terminalises legacy control records and drops the parallel legacy control tables.
