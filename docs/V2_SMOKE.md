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

**Status: unverified. Do not promise local models until this passes.**

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
