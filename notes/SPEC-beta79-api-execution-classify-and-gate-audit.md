# SPEC beta.79 — API-execution AC classification + loop.gate_decision audit

Base: beta.78 (`9467897`, origin/main). Greenlit by Carel 2026-07-28 ("yes, greenlight. this should go in to 79, as 78 is already build").

Origin: the beta.77 DR/BCP smoke (session `95b341cb`, PR #881, do_not_merge, 3 cycles). Staging's forensic (`reports/beta77-cycle-analysis-95b341cb.md`) proved: (a) the beta.69 convergence gate is HEALTHY on prose — each cycle produced a genuinely new spec-fidelity medium+ finding, not recycled churn; (b) the REAL defect is that the lead SILENTLY PIVOTED an API-execution task to markdown docs. The DR/BCP prompt's 9 ACs ALL describe external-API side-effects against a live GRC system (`POST /api/grc/evidence`, `DELETE /api/grc/policies/...`, `{ok:true}` returns, HTTP status contracts against project-thanos.vercel.app). Every "you assert this happened when nothing shows it happened" finding is downstream of that pivot — the run only produced docs ABOUT the procedure.

Code confirmation: the classifier (claude-sdk.ts:712) only chooses `dev_task|clarify|not_dev|unsafe` with an explicit weak-clarify bias; task modes (fable5-lead.ts) are `observe|mutate|mixed` — all repo-file ops. There is NO "execute-against-external-API" mode and no "this isn't repo work" reject path. So handed an API-execution brief, the lead's only trained move is to make files.

## F1 — API-execution AC detection → clarify (the real fix)

New PURE detector `src/crystallise/api-execution-detect.ts`:
- `detectApiExecutionBrief(brief)` scans `acceptanceCriteria` (primary), `title`, `motivation` for external-API-execution signals:
  - HTTP verbs against URL-ish endpoints: `POST /`, `GET /`, `DELETE /`, `PUT /`, `PATCH /` (path-shaped),
  - explicit live URLs (`https?://.../api/...`, `*.vercel.app`, host + `/api/`),
  - HTTP status / return-value contracts (`{ ok: true }`, `returns 201`, `HTTP 200`, `Authorization: Bearer`, `Content-Type:`),
  - "against a live/external system" phrasing.
- Returns `{ isApiExecution: boolean, matchedCriteria: string[], ratio: number, reason: string }`.
- HEURISTIC to fire: `matchedCriteria.length >= 2` AND ratio (`matched / total ACs`) >= 0.4 (dominant, not a single incidental "the endpoint returns 200" note). Tunable via config `crystallise.api_execution_min_criteria` (default 2) + `crystallise.api_execution_min_ratio` (default 0.4). `crystallise.api_execution_detection` boolean master switch (default true).
- Repo-file work that merely MENTIONS an endpoint in one AC (e.g. "add a test asserting the handler returns 201") must NOT trip it — that's why the dominance ratio + ≥2 gate matters, and why the detector requires the endpoint to be the OUTCOME (a side-effect to perform), not a thing being coded. Bias false-NEGATIVE (let a borderline repo task through) over false-positive (blocking a real code task).

Wiring in `prompt-refiner.ts` `crystallisePrompt`, AFTER `callCrystalliser` produces the brief, BEFORE `validateBrief`:
- if detection enabled AND `detectApiExecutionBrief(brief).isApiExecution` → return `{ kind: "clarify", question }` where the question names the signal and asks the ONE decision: "These acceptance criteria describe API side-effects against a live external system (<matched examples>). This harness generates/reviews REPO CODE + opens a PR — it does not execute calls against a live API. Do you want me to (a) write repo code/tests for this behaviour, or (b) is this an operational task to run against the live system (out of scope for the code harness)?"
- The existing `clarify` return path already surfaces to the user via registration.ts (`needsClarification`), so NO new resume plumbing. This reuses the beta.55 human-in-loop entry — the user answers, and a re-run with a clarified brief either proceeds as real code work or is redirected.
- Audit: emit `crystallise.api_execution_clarify` via a logger line (prompt-refiner has logger, not the audit sink) — registration already audits `tool.run` outcomes; the clarify surfaces as `needsClarification`.

## F2 — loop.gate_decision audit per cycle (the cheap observability nit)

Staging's nit: this analysis was a python re-implementation of the classifier. A per-cycle `{newBlocking, recycled, downgraded}` audit event makes it a one-query answer.

- Extend `gateVerdict` (finding-classify.ts) return with `recycled: ReviewFinding[]` (the findings that WERE recycled — currently only `newBlocking` + `downgraded` are returned). Backward compatible (additive field).
- Thread the gate breakdown out of `runAdversary` (fable5-adversary.ts) onto the returned `ReviewReport` via NEW optional fields `gateNewBlocking?: number`, `gateRecycled?: number`, `gateDowngraded?: boolean` (additive; ReviewReport is the loop's `report`).
- In loop.ts, where the review is consumed (next to the existing `loop.review` audit ~line 2056), emit `loop.gate_decision { sessionId, cycle, newBlocking, recycled, downgraded }` from the report's gate fields (guarded — only when the fields are present, so an injected test double without them is a no-op).

## Boundaries / non-goals
- Does NOT touch the convergence gate logic itself (it's healthy). F2 only makes it OBSERVABLE.
- Does NOT add a new "execute-against-API" task mode. The harness stays a code-gen + PR tool; the fix is to DETECT + CLARIFY, not to grow API-execution capability.
- Reuses the existing `clarify` path — no new resume/answer plumbing.

## Tests (target ~+14)
`tests/beta79-api-execution-classify-and-gate-audit.test.mjs`:
- F1 detector: the exact DR/BCP ACs → isApiExecution true; a normal repo task ("refactor the handler, add a test asserting 201") → false (single incidental endpoint mention, below ratio); a pure-docs task → false; ≥2 + ratio gate boundary cases; master switch off → always false; config thresholds honoured.
- F1 wiring: crystallisePrompt returns `kind:"clarify"` on an API-execution brief (injected callClassifier=dev_task + callCrystalliser=API-execution brief); returns `kind:"brief"` on a normal brief; detection-off passes through.
- F2: gateVerdict returns recycled set; behavioural — a revise with 1 new blocking + 1 recycled → recycled.length===1, downgraded false; a revise with only recycled → downgraded true, recycled populated. loop emits loop.gate_decision from report gate fields (source-assert + behavioural via a real OrchestratorLoop review with the fields set).
- Config + manifest declare the 3 new crystallise keys.

## Version discipline (beta.77 miss lesson)
BUMP `src/version.ts` pluginVersion to 0.1.0-beta.79 AND rebuild so dist/version.js matches package.json BEFORE tagging. Add to the ship checklist: `grep pluginVersion src/version.ts` must equal `package.json` version.
