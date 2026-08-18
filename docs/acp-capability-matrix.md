# ACP capability matrix

Measured 2026-08-03 with `probe/acp-probe.mjs` against live agents. Raw wire
traces and per-run analyses are in `probe/runs/`.

The probe speaks raw newline-delimited JSON-RPC rather than using
`@agentclientprotocol/sdk`, because the question being asked is precisely
*which optional fields does this agent populate on the wire* — a typed SDK can
normalise away exactly what we are trying to measure.

## Versions probed

| Agent | Launch | Version | Protocol |
|---|---|---|---|
| OpenCode | `npx -y opencode-ai@latest acp` | 1.18.11 | v1 |
| Codex | `npx -y @zed-industries/codex-acp` | codex-acp 0.16.0 | v1 |
| Claude Code | `npx -y @zed-industries/claude-code-acp` | claude-code-acp 0.16.2 | v1 |

All three completed a full turn (`stopReason: end_turn`).

## Matrix

| Capability | OpenCode | Codex | Claude Code |
|---|---|---|---|
| `loadSession` | yes | yes | yes |
| `sessionCapabilities` | close, fork, list, resume | close, list, resume | fork, list, resume |
| Model selection over ACP | not advertised | not advertised | **yes** — `default`, `opus`, `opus[1m]`, `haiku` |
| `usage_update` emitted | yes | yes | **no — none at all** |
| `cost` in usage | **yes — real** | no | no |
| `tokensIn` / `tokensOut` | **unavailable — protocol has no in/out split** | same | same |
| Context `used` / `size` | yes | yes | no |
| `ToolCall.kind` | yes | yes | yes |
| `rawInput` on execute | yes | yes | yes |
| `locations[]` | yes | yes | yes |
| `ToolCallContent` type `diff` | no | yes | yes |
| **Asks permission for every tool** | **yes, if configured** | **no** | **no** |
| Permission requests, default config | **0 of 6 calls** | escape only | **0 of 4 calls** |

## The finding that matters most

**Every ACP backend tested runs tools without asking, by default. In all three
cases our `canUseTool` guard would never have been consulted.**

- **OpenCode**, default config: 4 `execute` and 2 `edit` calls, **zero**
  `session/request_permission` requests.
- **Claude Code**, default mode: 2 `execute` and 2 `edit` calls, **zero**
  requests — despite that mode being described as "Standard behavior, prompts
  for dangerous operations".
- **Codex**: prompts only when a command escapes its sandbox.

Nothing errors in any of these cases. The bash whitelist, the denylist tokens
and the path denylist are simply never reached, while still reading as enabled
in `openclaw.json` and in the logs. This is the single most important result of
the probe, and it is why `preflightAcpBackend()` must fail closed.

## Only OpenCode can satisfy our safety model

| Backend | Can the guard see every tool call? |
|---|---|
| OpenCode via ACP | **Yes** — `permission: { "*": "ask" }` in `opencode.json` |
| Codex via ACP | No — sandbox escape only |
| Claude Code via ACP | No — "dangerous" ops only, by its own definition |
| Claude Code via SDK (today) | **Yes** — `canUseTool` fires for every tool |

Setting this in the workspace `opencode.json` changes OpenCode's behaviour
completely:

```json
{ "permission": { "*": "ask", "bash": "ask", "edit": "ask" } }
```

The same run then produced permission requests carrying exactly what the guard
needs: `execute` -> `rawInput: { "command": "echo acp-probe-marker" }`, the
literal string `guardCommand()` tokenises; `edit` -> `{ "filepath": ..., "diff": ... }`
plus `locations[]`, which is what `pathMatchesDenylist()` needs. Options offered
include `reject_once`, so denial is expressible.

**Consequence for the plan:** the source document lists "generate
`opencode.json` from `openclaw.json`" as an *optional single-source
enhancement, skip for v1*. That is wrong. It is a **mandatory,
security-critical requirement**, and it is the only backend configuration that
makes the ACP path as safe as the SDK path it replaces.

### Claude Code over ACP is strictly weaker than Claude Code over the SDK

`session/new` advertises five modes: `default`, `acceptEdits`, `plan`,
`dontAsk` ("deny if not pre-approved") and `bypassPermissions`. **None of them
is an ask-for-everything mode.** Today's SDK path invokes `canUseTool` for every
single tool call regardless of `worker_permission_mode`; the ACP path cannot
reproduce that. Routing the worker to Claude Code *via ACP* would therefore be
a safety regression against what we ship today, with no upside — it is the same
vendor and the same model.

### Codex: a different safety model, and a real gap

Codex uses **sandbox-and-escalate**:

- `echo acp-probe-marker` (benign, inside sandbox) -> no permission request.
- `cat /etc/hosts > /tmp/...` (escapes the sandbox) -> permission request with a
  rich payload: `command`, `cwd`, `parsed_cmd`, `proposed_execpolicy_amendment`.

This held under `approval_policy = "untrusted"` + `sandbox_mode = "read-only"`.
The isolated `CODEX_HOME` was confirmed honoured (fully populated with sessions,
logs and state), so this is real behaviour, not an ignored config.

The gap: our `path_denylist` protects files **inside** the workspace — `.env`,
credentials, private keys. Codex's sandbox guards the workspace **boundary**. A
worker running `cat .env` inside the worktree never escapes the sandbox, never
prompts, and so is never guarded.

## Budget ledger impact

**OpenCode on a paid Anthropic provider reports real cost: `0.0396129 USD`.**
An earlier run reported `0.00` because it was on a free provider, not because
cost reporting is broken. So the ledger works on the ACP path.

Remaining caveats:

- `cost` is **cumulative per session**, so per-call cost must be delta-ed.
- `tokensIn` / `tokensOut` are unavailable from **every** agent — ACP carries no
  input/output split, only `used` (context occupancy) and `size` (window).
  `checkPriceDrift()` cannot run on ACP-backed spend and must be skipped
  explicitly rather than fed zeros.
- Claude Code emits **no `usage_update` at all**, so via ACP it yields neither
  cost nor context. Another reason it stays on the SDK.

## `rawInput` shapes are per-agent

There is no common schema. Any adapter needs per-agent normalisation:

| Agent | execute | edit |
|---|---|---|
| OpenCode | `{ command, cwd }` | `{ filepath, diff }` |
| Codex | `{ command, cwd, parsed_cmd, call_id, ... }` | `{ changes: { "<path>": {...} } }` — paths are object **keys** |
| Claude Code | `{ command }` | `{ file_path }` |

Note Codex's edit payload has no path field at all, and OpenCode uses `filepath`
where Claude Code uses `file_path`.

## Timing hazard: `rawInput` is incomplete at `pending`

On OpenCode the first `tool_call` arrives with `status: "pending"` and an
**incomplete** `rawInput` — `{ cwd }` with no `command`, and `{}` for the edit.
The command only appears at `status: "in_progress"`, i.e. at or after the point
the tool starts running.

So the `session/update` stream is **not** a safe place to authorise from. The
only sound hook is `session/request_permission`, which the agent blocks on.
`kind` is also not repeated on every update (`completed` updates carry no
`kind`), so correlate by `toolCallId`.

## Option A vs Option B

**Option B — write our own ACP client.** Confirmed.

The raw protocol gives us everything the guard needs. OpenClaw's `acpx` bridge
is documented as surfacing usage as "approximate, carries no cost data", which
would discard the one real cost signal we just measured, and it abstracts away
both the permission round-trip and the per-agent `rawInput` shapes.

## Conclusion

1. **OpenCode is the only supportable ACP backend**, and only with
   `permission: { "*": "ask" }` enforced by a fail-closed preflight.
2. **Codex is not supportable** without accepting that in-workspace secret
   reads go unguarded.
3. **Claude Code stays on the SDK.** Via ACP it is strictly weaker than what we
   ship today and reports no usage at all.
4. **The budget ledger survives** on OpenCode: real cost, delta-ed per turn.
   Only the token split is lost, and that is a protocol limit affecting every
   agent equally.

## Open items

1. Confirm the A/B model pairing end to end: SDK worker on Sonnet versus
   OpenCode worker on `anthropic/claude-sonnet-4-5`.
2. Measure a local model through OpenCode to quantify the actual cost saving.
