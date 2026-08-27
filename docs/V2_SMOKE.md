# v2.0.0-beta.1 smoke procedure

What CI can prove, what only a real run can prove, and how to run the second
kind. Everything in the first list is already enforced; everything in the second
is a gate a human has to walk through before this leaves beta.

## What CI already covers

These run on every commit and need no OpenCode binary, no API key and no money.

| Property | Where |
| --- | --- |
| The permission round-trip exists in real OpenCode traffic, with a refusable option and a readable command | `tests/v2-acp-replay.test.mjs` |
| The adapter survives a real captured session end to end | `tests/v2-acp-replay.test.mjs` |
| A declined `fs` capability is refused with `-32601`, not falsely reported as success | `tests/v2-acp-replay.test.mjs` |
| The child gets a filtered environment; the vault key and PATs do not reach it | `tests/v2-acp-hardening.test.mjs` |
| The whole process group is reaped on timeout | `tests/v2-acp-hardening.test.mjs` |
| The live capability probe fails closed on every axis | `tests/v2-opencode-preflight.test.mjs` |
| Judgement roles refuse a model below `strong` | `tests/v2-role-config.test.mjs` |
| A provider with no vault key is dropped, not sent an empty `apiKey` | `tests/v2-role-config.test.mjs` |
| The pricing catalogue rejects a malformed or implausible response whole | `tests/v2-pricing-catalogue.test.mjs` |
| Local providers report tokens and no dollars | `tests/v2-pricing-catalogue.test.mjs` |
| All eight roles are routed from the dispatch path, so config is not inert | `tests/v2-backend-wiring.test.mjs` |
| A rejected backend config refuses, rather than falling back to claude-code | `tests/v2-backend-wiring.test.mjs` |
| The agentic roles get the ACP guard, never the SDK's `canUseTool` | `tests/v2-backend-wiring.test.mjs` |
| `tokens-only` is priced; `unavailable` stays unmeasured; `local` is a real zero | `tests/v2-backend-wiring.test.mjs` |
| The permission keys are exactly 1.18.23's, and dead keys stay out | `tests/v2-opencode-preflight.test.mjs` |
| A hostile repo config cannot allow a named permission past us | `tests/v2-opencode-preflight.test.mjs` |
| An agent that writes silently after a refusal fails the probe | `tests/v2-opencode-preflight.test.mjs` |
| A child dying mid-resume fails fast, instead of hanging to the deadline | `tests/v2-acp-hardening.test.mjs` |

The replay tests are the load-bearing ones, and they are worth understanding
before trusting them. Every other ACP test drives `tests/fixtures/fake-acp-agent.mjs`,
a fixture written from the same understanding as the adapter — so the two agree
by construction, and a shared misreading of the protocol survives all of them.
The replay drives `probe/runs/*.jsonl`, real wire transcripts captured from
OpenCode 1.18.11 before the adapter existed. That is how the `fs/write_text_file`
case was found.

## What CI cannot cover

Three things need a real binary, a real endpoint, or real money.

### 1. OpenCode issue #5674 — custom provider options

**Status: VERIFIED PASS on `opencode-ai@1.18.23`, 2026-08-27 (macOS, darwin 25.5.0).**
Re-verify when the pin moves; a pass here does not imply a pass on 1.19.

Method: a listener on `127.0.0.1:1234` that records the request and serves no
model, with `ANTHROPIC_API_KEY` explicitly unset so a fallback would fail loudly
instead of billing quietly. All three options survived the trip:

| Configured | Observed at the endpoint |
| --- | --- |
| `baseURL: http://127.0.0.1:1234/v1` | `POST /v1/chat/completions` arrived |
| `apiKey: sk-probe-5674` | `Authorization: Bearer sk-probe-5674` |
| `model: local/probe-model` | `"model": "probe-model"` |

So the dangerous case — OpenCode ignoring the endpoint and answering from its
own default — did **not** occur, and local models are no longer blocked on this.

**A second finding, which is now the more pressing one.** The probe endpoint
returned a body the OpenAI-compatible shim could not parse, and OpenCode retried
**3503 times in about three and a half minutes** with no ceiling and no visible
backoff. It stopped only when killed. A worker pointed at an endpoint that is
reachable but returning something malformed — a misconfigured local server, a
proxy serving an HTML error page, a provider mid-incident — will therefore hammer
it rather than fail. Against a metered endpoint that is a bill; against a local
one it is a wedged run burning wall clock until the session deadline.

Treat the ACP turn timeout as the only thing bounding this today, and prefer a
short one when pointing a worker at an endpoint you do not control.

The issue reports that a custom OpenAI-compatible provider's `options`
(`baseURL`, `apiKey`) are dropped. If it reproduces on the pinned version, the
local-model goal does not work regardless of anything in this repo, because the
agent will ignore the endpoint we configured and fall back to its own default —
which, worse than failing, would silently bill a cloud provider for a run the
operator believed was local.

To verify:

```bash
# 1. Install the pinned version.
npm install --global opencode-ai@1.18.23

# 2. Point a provider at something you control and can watch.
#    A local llama.cpp/LM Studio/Ollama OpenAI-compatible server is ideal:
#    you can see whether the request arrives.
export OPENCODE_CONFIG_CONTENT='{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:1234/v1", "apiKey": "sk-test" },
      "models": { "your-model": {} }
    }
  },
  "model": "local/your-model"
}'

# 3. Run one turn and WATCH THE SERVER LOG, not the agent output.
opencode run "say hello"
```

Pass: the request arrives at `127.0.0.1:1234`. Fail: it does not, and the agent
either errors or — the dangerous case — answers from a different provider.

Record the result in this file with the version tested and the date. A pass on
1.18.23 does not imply a pass on 1.19; re-verify when the pin moves.

### 2. The two-axis A/B matrix

The question v2 exists to answer is not "does OpenCode work" — the tests above
cover that — but "is a cheaper worker worth it". That needs real briefs on real
repositories, and it costs money, so it is a deliberate exercise rather than
something to leave running.

Two axes:

- **Worker backend**: `claude-code` against `opencode`.
- **Worker model**: the current strong worker against a cheaper or local one.

Hold everything else constant. The lead, adversary and crystalliser stay on
their existing models for the whole matrix — they are the judgement roles, and
changing them changes what "converged" means, which would make every cell
incomparable.

Three measurements per cell, and the third is the one that matters:

| Metric | Why |
| --- | --- |
| **Cycles to converge** | A cheaper worker that needs three cycles instead of one is not cheaper. This is the metric a per-token comparison misses entirely. |
| **Cost per merged PR** | Not cost per run. A run that ends `do_not_merge` bought nothing, and averaging it in flatters the cheap configuration. |
| **Verdict distribution** | `pass` / `revise` / `block` per cell. A cheap worker that shifts the distribution toward `revise` is spending the adversary's budget instead of its own. |

Run at least five briefs per cell, of mixed size, and include at least one that
the current configuration is known to find hard. A matrix of easy briefs will
show no difference and prove nothing.

**Stopping rule, decided in advance:** adopt the cheaper worker only if cost per
merged PR improves by more than 25% *and* the verdict distribution does not
shift toward `revise`. Anything less is inside the noise of five runs, and
adopting on a 10% improvement measured this way is how a regression gets shipped
with a number attached to it.

### 3. A real session against a real repository

The probe and the replay both stop at the protocol. Before this leaves beta, one
full session — brief through merged PR — must run with `worker` on OpenCode
against a repository you control. Watch for:

- The startup probe passing against the real binary, not the fixture.
- The guard denying something real, and the run surviving the denial.
- Token and cost figures that are non-zero and plausible (see the cost-leak
  fixes in M8 — the failure mode here is a confident zero).
- The worktree being clean afterwards, and no orphaned `opencode` process.
- **That the role actually ran on OpenCode.** `tests/v2-backend-wiring.test.mjs`
  proves the router routes, but only a real session proves the configured model
  served the turn. This is worth doing explicitly because "complete and inert"
  is the exact failure this milestone existed to fix, and a wire that is present
  but pointed at the wrong thing looks identical from inside the harness.

  Two pieces of evidence, and the per-session one is the one that settles it:

  ```sql
  -- Per session: which engine served the turn, and what it cost.
  SELECT worker_model, cost_usd, sdk_session_id FROM sub_tasks WHERE session_id = ?;
  ```

  An OpenCode row reads `opencode:<provider>/<model>` and carries an ACP
  `sdk_session_id` (`ses_…`); a Claude Code row is a bare model id. Check the
  cost against the provider's own dashboard.

  `backend.routes` and `backend.preflight` are also in `audit_log`, but they are
  written at **boot** with an empty `session_id`, because routing is decided in
  `register()` before any session exists. So query them directly rather than
  through a per-session audit view, which will show nothing:

  ```sql
  SELECT event, payload, created_at FROM audit_log WHERE event LIKE 'backend.%';
  ```

Then repeat the run with one **judgement** role — `adversary` is the useful one
— on OpenCode, because the structured path and the agentic path share almost
nothing: different entry point, different guard, different output contract.
A green worker run says nothing about the other six roles.

### 4. Re-check the permission key list when the pin moves

Not optional, and not a nicety. The harness guard runs only for tool calls
OpenCode routes through `session/request_permission`, and the `permission`
block decides what routes. Because OpenCode evaluates rules last-match-wins by
insertion order, the injected wildcard does **not** cover a key we have not
named: a permission added by a newer OpenCode, named and allowed by a
repository's own `opencode.json`, sorts after our `"*"` and wins.

So the guard's completeness is version-coupled. On every pin bump:

1. Read the tool registry at the new tag (`packages/opencode/src/tool/registry.ts`)
   and grep for `permission: "..."` literals. **Do not** use
   `opencode.ai/config.json` as the source of truth — it sets
   `additionalProperties`, accepts any typo, and still lists the dead `list` key.
2. Reconcile `OPENCODE_PERMISSION_KEYS` and `OPENCODE_TOOL_IDS`. They are
   different lists on purpose; `permission` is keyed by the name a tool asks
   under, which is often not its id (`write` and `apply_patch` both ask under
   `edit`).
3. Update the expected sets in `tests/v2-opencode-preflight.test.mjs`.

The exact-set test is *supposed* to go red on a bump. That failure is the
review prompt, not an inconvenience to be silenced.

## Version policy

The pin is `opencode-ai@1.18.23`, baked into the `Dockerfile` and declared in
`src/adapters/opencode-version.ts`. A mismatch **warns and runs** rather than
refusing, which is a deliberate choice: OpenCode ships often, a strict pin would
break a working setup on a patch release nobody asked for, and the failure a
strict pin protects against is not the one that hurts. The one that hurts is a
version that quietly stops routing tool calls through
`session/request_permission` — and the live probe catches that at startup, by
observation, which is stronger than any version string.

So the probe is the gate and the version check is the diagnostic that makes an
incident answerable without a reproduction.

The captured transcripts in `probe/runs/` are OpenCode **1.18.11**, an earlier
build. They are a compatibility floor, not the pin: a newer pin does not make an
older capture wrong. If you re-capture against a newer build, update
`CAPTURED_OPENCODE_VERSIONS` deliberately — a test asserts they agree.
