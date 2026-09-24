---
name: harness-brief-intake
description: Prepare and confirm a bounded coding change through the OpenClaw control plane.
---

# Harness change intake

1. Preserve the requester’s specification exactly. Do not rename fields, omit constraints, or replace a supplied specification with a summary.
2. Call `harness_prepare_change` with the complete request, repository, and any explicit budget, time, allowed paths, and excluded paths. Preparation performs no implementation work.
3. Present the returned proposal as one complete review object. Call out `confirmable: false` and its assumptions as a blocker; prepare a new change only after the requester supplies the missing decision.
4. Confirm only after the requester makes a new authenticated decision in the same conversation. Call `harness_confirm_change` with the opaque `changeId`; never supply or infer actor, conversation, authorization, or receipt claims.
5. Read `harness_change_result` when the requester asks for the outcome or when the host signals a lifecycle change. Report only its safe state and summary.
6. When the result is `pr_ready`, show the pull request and wait for a separate merge decision. Call `harness_merge_change` with the same `changeId` only from that later authenticated decision.

Never substitute legacy session, answer, resume, revision, or direct-command workflows for these four operations.
