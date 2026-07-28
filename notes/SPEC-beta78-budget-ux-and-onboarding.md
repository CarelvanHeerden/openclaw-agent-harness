# SPEC — beta.78: budget UX + coherence + per-user daily ledger + onboarding

Carel's four feature requests (#openclaw-staging, 2026-07-28). Greenlit: "ok cool lets build these features then into .78 please".

## F1 — budget recommend on a new prompt (SOFT default + Slack warn)
- `recommendBudget(user, requested?)` in `registration.ts`: daily-aware recommendation, clamped by session_hard_ceiling AND remaining daily. Returns a `note` when remaining daily is low.
- `startSessionFromBrief` computes it, audits `tool.run.budget_recommendation`, and `harness_run` prepends the note to its response so the agent relays it. Run auto-proceeds at `effectiveBudget` (soft default — no hard gate, per Carel).

## F2 — session budget SOFT (warn), daily_max HARD (stop)
- Persistent per-user daily ledger already existed (`budgets_daily`, keyed `(day_utc, user)`, written by `recordSpend`). Added `BudgetEnforcer.getDailySpend(user)` — restart-safe, resets on UTC day rollover.
- Loop: session-budget breach now WARNS once (`loop.session_budget_warn` + `warnSessionBudgetSoft` daily-aware Slack post) and CONTINUES. The hard abort moved to the per-user daily cap: pre-subtask gate + review gate + next-cycle gate all key off `daily_max_usd` (with the beta.61 reserve preserved). New terminal reason `daily_max_exhausted`; audits `loop.daily_max_abort`. `:moneybag:` (budgetBump) still overrides.
- Defensive: `dailyMaxUsd()` (0 = no daily gate, back-compat) + `safeDailySpend()` (0 if the enforcer double lacks getDailySpend). A missing `budgets` config never throws.

## F3 — budget coherence validation
- `assessBudgetCoherence(budgets)` pure helper in `config.ts`: warns on daily_max > monthly, session_hard_ceiling > daily_max / > monthly, daily_warn > daily_max, non-positive values. Expected order: session_default ≤ session_hard_ceiling ≤ daily_max ≤ monthly.
- Wired into `bootstrapHarnessAsync`: loud `api.logger.warn` per incoherence + `harness.budget_incoherent` audit. Non-fatal (the truly nonsensical invariants still throw in normaliseConfig).

## F4 — per-user onboarding (`harness_onboard`, DM flow)
- New `src/slack/onboarding.ts`: `OnboardingSlack` (openDm/postDm/deleteOwnMessage via injected fetch, best-effort never-throws), `resolveOnboardVaultService`, `validateGitToken` (GET /user).
- New `harness_onboard` tool: authorised-user gated; `action:"start"` opens a DM with paste instructions; `action:"submit"` validates (GET /user) + stores via `credential_store` as `git-pat:<userid>` (pattern `pat_routing.onboard_service_pattern`), deletes the bot's own prompt, confirms in DM, asks the user to delete their token message (a bot token can't delete a user's message).
- DM flow chosen over a modal (Carel 2026-07-28): raw Slack modal submission isn't exposed to plugins. Slash-command `/harness-onboard` needs a one-time Slack-app-manifest add + reinstall; the handler then calls `harness_onboard`. Documented in README.

## Tests / gates
905 → 923 (+18 `beta78-budget-ux-and-onboarding.test.mjs`). Updated 4 superseded budget-abort tests (session-budget → daily-cap). typecheck 0 + build 0 + 923/923 + smoke (16 tools incl. harness_onboard). New config key `onboard_service_pattern` declared in `config.schema.json` (additionalProperties:false).
