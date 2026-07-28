# SPEC beta.81 — budget transparency (estimate up front + live usage-vs-limit)

Status: SPEC OPEN (Carel greenlit 2026-07-28 09:54 "yes, please spec it for .81 and then keep it open if anything else pops up in this smoke test"). Do NOT build/ship yet — hold open to batch additional findings from smoke #2 (session `d01a7484`, the Continuity & Resilience feature build, which Carel predicts will blow the $10 soft cap).

Base: beta.80 (main HEAD `70fd574`).

## Origin
During smoke #2 Carel: "It never asked me what the budget should be — this is something I asked for, that you build in .78." I confirmed beta.78 F1 is a SOFT default BY HIS OWN PRIOR DECISION ("Soft default with a warning sent to slack") — it computes `recommendBudget`, audits `tool.run.budget_recommendation`, prepends a note to the harness_run response, and AUTO-PROCEEDS at effectiveBudget (no gate). So it's not a regression. Carel's refined ask: "True, it is a soft limit, but we should 1: surface to the user what the estimate is and 2: how much they have used of their limit." + "i can almost guarantee it is going to break the $10 soft limit ... this is a really large change." So beta.81 = TRANSPARENCY, not a hard gate. Soft limit stays.

## The gap
- `recommendBudget` (registration.ts) computes a daily-aware estimate + a `budgetNote`, but it's only PREPENDED to the harness_run tool response — the AGENT (Staging) must choose to relay it. If the agent doesn't, the user sees nothing about budget. Not reliably surfaced.
- Live spend is visible ONLY because the WATCHER cron appends `$X/$Y` to headlines. The harness itself does not surface spend-vs-limit in its own progress/terminal output — so without the watcher, the user is blind to burn.

## F1 — surface the ESTIMATE up front (reliable, harness-owned)
- Make the budget estimate a first-class part of the run's OWN surfaced output at start, not an agent-relayed afterthought. Options to decide at build:
  - (a) include `estimatedUsd` + `effectiveBudget` (cap) in the FIRST progress headline / snapshot the harness produces (so it shows via harness_progress even if the agent never relays the note), and/or
  - (b) keep the harness_run prepend but ALSO persist the estimate on the session row so harness_progress/harness_status echo it.
- Message shape: "Estimated ~$X for this change; session cap $Y." Derived from the existing `recommendBudget` (daily-aware) — no new estimation model, just SURFACE what's already computed.
- Keep it SOFT: still auto-proceeds. No pause-and-wait (Carel affirmed soft; contrast beta.80's bimodality pause which IS a hard wait).

## F2 — surface USAGE-vs-limit live (harness-owned, not watcher-dependent)
- Fold "used $X of $Y (Z%)" into the harness's own progress snapshot (buildProgressSnapshot / the headline the native poster + poll model emit) AND the terminal summary — so spend-vs-limit shows even without the external watcher cron appending it.
- At terminal, always state final spend vs cap + whether the reserve/abort fired.
- Consider a soft threshold notice in-band (e.g. at 75%/90% of cap) surfaced through the SAME progress channel — NOT a new alerting subsystem (reuse the beta.77 native progress poster path). Decide at build whether this duplicates the existing budget-reserve/warn audit events or replaces the watcher's role.

## Interaction with existing budget machinery (do NOT rebuild)
- beta.61 budget reserve (default 0.15) + `loop.budget_projection_abort`: a projected over-budget step aborts cleanly, reserving ~15% for the pending adversary review; if past a completed review, opens PR with do_not_merge/needs_human. beta.81 SURFACES this, does not change it. When the reserve aborts, the terminal message must clearly say "aborted: would exceed $Y cap (used $X, reserved ~15% for review); re-run at a higher cap to finish."
- beta.78 per-user daily ledger (`budgets_daily`, UTC, restart-safe) + soft session-warn + hard daily_max: beta.81's usage surfacing should show BOTH session spend-vs-session-cap AND (optionally) daily spend-vs-daily_max, since the daily cap is the actual hard stop.

## Boundaries
- Soft session limit UNCHANGED — no pause-and-wait for budget (Carel affirmed soft). Pure visibility.
- Reuse recommendBudget (estimate) + the beta.77 progress channel (surfacing) + beta.61/78 machinery (enforcement). No new estimation model, no new alerting subsystem.

## OPEN — additional findings from smoke #2 (append here as they surface)
Carel asked to keep this spec open for anything else this smoke test turns up. Candidates to fold in if they occur:
- If session `d01a7484` hits the $10 reserve-abort: capture the exact terminal message + confirm it's actionable (says used/cap/reserve + "re-run higher"). That message quality IS an F2 deliverable.
- Any other budget-UX rough edge observed during the run.
- (add more here)

## Version discipline
Bump src/version.ts + package.json to 0.1.0-beta.81 + rebuild dist BEFORE tagging. version.ts==package.json test still enforces.

## VERIFIED FINDING (2026-07-28, Staging audit on d01a7484 + 95b341cb + Clark code-read) — beta.78 F1 note is DAILY-CAP-ONLY, silent on session estimate

Staging's audit: ZERO `tool.run.budget_recommendation` events on either session, or ANYWHERE in the audit log ever. Clark verified the cause in registration.ts:
- The audit is guarded `if (rec.note)` (registration.ts ~L133) — fires ONLY when recommendBudget returns a non-empty note.
- `recommendBudget` sets `note` ONLY when `dailyMax > 0` AND (remainingDaily <= 0 OR remainingDaily < requested/default). i.e. ONLY when the user is bumping the **daily** cap.
- So on Staging, `daily_max_usd` is either unset/0 (note always undefined → event never fires) or high enough that remaining-daily always exceeds the $10 session budget → note stays undefined.

**Conclusion (concede Staging's caveat): beta.78 F1 is NOT a bug — it works as coded — BUT its note is DAILY-cap-centric and says NOTHING about the SESSION estimate vs the SESSION cap.** The thing Carel asked for ("surface the estimate" + "how much of their limit they've used") was NEVER in beta.78 F1's scope. The `harness_run` ack DID contain "(budget $10.00)" (the effective session cap surfaced), but there is NO up-front session ESTIMATE and NO live session USAGE surfacing. So my earlier "beta.78 worked as specified" needs the caveat: soft-by-design yes, but the soft path only speaks to the DAILY cap and is silent in the common (no-daily-cap) case — exactly why Carel saw nothing.

**This STRENGTHENS beta.81 F1/F2 (they build what genuinely doesn't exist):**
- F1 must surface a SESSION-level estimate (estimated $X for THIS run vs session cap $Y) up front, INDEPENDENT of the daily-cap note. Do not rely on the daily-cap-gated `rec.note`.
- F2 must surface SESSION usage-vs-session-cap live (used $X of $Y, Z%), harness-owned. Keep the beta.78 daily-cap note as a SEPARATE, additional nudge (it's fine, just narrow).
- Also worth doing in beta.81: emit a budget audit event on EVERY run (e.g. `tool.run.budget_estimate {estimated, cap, dailySoFar, dailyMax}`) UNCONDITIONALLY, so the "was budget surfaced?" question is always answerable from the audit log — right now a whole class of runs leaves zero budget-recommendation trace (Staging had to prove absence).

## CORRECTION (2026-07-28, Staging): the harness ALREADY emits cost-in-headline
Clark was WRONG that the `$X/$10` in headlines is the watcher appending it. Staging confirmed: `harness_progress` returns `headline: "Executing sub-task 1/11 ... ($5.68/$10.00)"` with cost baked in BY THE HARNESS; the watcher just relays it. So the "surface usage" capability PARTLY EXISTS today.
Revised F2 scope: beta.81 does NOT build usage-surfacing from zero. It FORMALISES what exists — (a) push (native poster) instead of pull-only, (b) TERMINAL totals (final spend vs cap + reserve/abort state), (c) up-front ESTIMATE (this is the genuinely-absent piece), (d) session usage as an explicit "% of cap" not just "$X/$Y". The live in-headline session $X/$Y already ships. Don't re-implement it.
