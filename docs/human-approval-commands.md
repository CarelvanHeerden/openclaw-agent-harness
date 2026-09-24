# Trusted change decisions

The ordinary coding workflow has no direct approval command. OpenClaw supplies authenticated actor, conversation, event, and one-use attestation data to the plugin from a later inbound message; none of those values are accepted as tool parameters.

## Implementation decision

1. Prepare with `harness_prepare_change`.
2. Review the complete immutable proposal.
3. From a later authenticated message in the same conversation, call `harness_confirm_change` with only its opaque `changeId`.

Confirmation binds the actor, conversation, repository and immutable base revision, brief and policy digests, budget and time, scope and excluded paths, credential route, security class, proposal generation, expiry, host event, and nonce. It is consumed atomically with the prepared-to-accepted transition and one execution intent.

## Merge decision

After `harness_change_result` reports `pr_ready`, obtain a separate later authenticated decision. `harness_merge_change` accepts only the `changeId`; its trusted attestation binds the exact pull request, current head, published revision, readiness and evidence digests, policy, merge method, expiry, host event, and a fresh nonce.

Implementation confirmation cannot authorize merge. Replayed, expired, wrong-actor, wrong-conversation, stale-base, or stale-head decisions fail closed.
