# Human approval through OpenClaw

Humans do not call the harness directly and do not use harness-specific slash commands. They reply in natural language to OpenClaw. OpenClaw interprets the reply and calls `harness_answer`.

## Trust boundary

A human answer is accepted only when all three checks pass:

1. OpenClaw's trusted tool-factory context contains `requesterSenderId`.
2. `requesterSenderId` exactly equals the tool argument `invokedBy`.
3. That sender is listed in `slack.authorised_users`.

Tool arguments such as `invokedBy`, `answeredBy`, owner flags, or copied message metadata cannot create human authority by themselves. Missing or mismatched host provenance fails closed without changing the paused session.

`answeredBy: "human"` means OpenClaw is interpreting the current authenticated requester's natural-language answer. It does not mean the model independently approved the action.

## State binding

OpenClaw should read the current pause with `harness_progress` and submit its `clarificationSeq` and, when present, `clarificationId`. The harness rejects stale sequence or identity values and preserves the existing status guards and atomic answer claim.

For brief confirmation, revision, and budget grants, OpenClaw must wait for the human's reply. Those decisions cannot be delegated to automation.

## Delegated automation

An agent may answer by itself only when `loop.clarification_auto_accept_delegated` is enabled and the answer includes `answeredBy: "automation"` plus bounded review evidence. Brief approval, brief revision, and budget grants remain non-delegable regardless of that setting.
