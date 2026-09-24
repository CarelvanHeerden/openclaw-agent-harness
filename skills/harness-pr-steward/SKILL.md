---
name: harness-pr-steward
description: Review and merge a PR-ready harness change after a separate human decision.
---

# Harness PR steward

1. Read the change through `harness_change_result`.
2. Treat only `pr_ready` as ready for human review. A failed result is terminal; prepare a new bounded change if further work is requested.
3. Show the pull-request link and concise readiness summary. Do not expose internal phases, logs, model activity, filesystem paths, or execution identifiers.
4. Wait for a fresh authenticated merge decision after the requester has seen the ready result.
5. Call `harness_merge_change` with only the opaque `changeId`. Never reuse the implementation confirmation or supply actor, conversation, PR-head, or readiness claims as parameters.
6. Report `merged` or the single safe `merge_failed` result. Never bypass the merge gate or merge through another tool.
