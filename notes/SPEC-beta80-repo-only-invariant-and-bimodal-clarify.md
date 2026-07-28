# SPEC beta.80 — repo-only invariant + planning-time bimodality clarify (hard pause-and-wait)

Base: beta.78 (main HEAD `3a28b5c` = the revert of beta.79). Greenlit by Carel 2026-07-28. beta.79 was reverted in full first; this is built clean, NOT layered on it.

Origin: the beta.77 DR/BCP smoke (session `95b341cb`, PR #881). The prompt "build a section in Project Thanos that receives DR/BCP evidence uploads" was BIMODAL — defensibly readable as (a) build the upload-receiver feature, (b) run a one-off live migration, (c) write a runbook. The crystalliser confidently GUESSED (invented 9 API-execution ACs) and picked a third reading (docs), never asking. Carel: "Why am I never asked to clarify? Not once, in 77 betas." + "this is a DEV harness. it should be working in repos and NOT make api calls to the systems that it is building, unless it is to test" + decision "**hard pause-and-wait** for your answer; assumptions cause delays."

Root causes (confirmed in code):
- Classifier prompt (claude-sdk.ts:714) has an EXPLICIT thumb against clarify: "keep the bias toward dev_task; clarify is the exception... not the default." + only clarifies on MISSING info (which repo/branch/file), never on a misread INTENT.
- Crystalliser has NO clarify path — its job is resolve-ambiguity-and-proceed; it invents ACs to make a vague ask actionable.
- beta.55 `awaiting_clarification`/`harness_answer` only fires MID-RUN on a worker refusal, never at PLANNING time.
- Net: in 77 betas, nothing ever routed into clarify on an ambiguous/bimodal brief.

## F1 — HARD repo-only invariant (prompt hardening)

The harness produces REPO CODE + tests and opens a PR. It NEVER performs live API calls against the systems it builds AS A DELIVERABLE — live calls are legitimate ONLY as test/verify steps against code it just wrote (integration test / smoke check against a preview deploy).

- Crystalliser prompt (runCrystalliserSdk, claude-sdk.ts): new REPO-ONLY rule. An acceptance criterion that describes an external-system side-effect as the OUTCOME ("POST /api/x returns 201", "the row exists in the live DB", "DELETE returns {ok:true}") must be REFRAMED to repo work: "add/modify the code that performs/handles this" + "add a test that asserts it". If the brief is ONLY a sequence of live side-effects with no buildable repo surface (a pure one-off ops migration), that is NOT valid harness work → set the clarify/interpretations signal (F2), do not invent a docs brief.
- Classifier prompt (runClassifierSdk): rebalance — `clarify` is a FIRST-CLASS outcome, not the suppressed exception. Keep dev_task for genuinely unambiguous asks, but choose `clarify` when the ask is materially BIMODAL (≥2 readings → different diffs) OR reads as an out-of-repo ops task. Remove the "keep the bias toward dev_task; clarify is the exception... not the default" thumb; replace with balanced guidance (clarify when a wrong guess would change WHAT gets built or WASTE a run; still don't clarify trivial/complete asks).

## F2 — planning-time bimodality self-report → hard pause-and-wait (the mechanism)

The crystalliser (the model that today guesses) SELF-REPORTS competing readings instead of picking one. Extend its structured output (optional/additive):
- `interpretations?: { reading: string; whatDiffers: string }[]` — DISTINCT valid readings of the brief that would produce MATERIALLY DIFFERENT diffs. Empty/absent when the brief is unambiguous.
- `clarificationNeeded?: { question: string; options: string[] }` — when `interpretations.length >= 2` (or an assumption that changes WHAT is built), the crystalliser MUST populate this with the fork as an explicit multiple-choice question rather than choosing.
- Crystalliser prompt instructs BOTH: reframe live-side-effect ACs to repo work (F1), and when ≥2 buildable readings remain, emit `clarificationNeeded` — DO NOT pick one.

Wiring in `prompt-refiner.crystallisePrompt`, AFTER callCrystalliser (and after concept back-fill), BEFORE validateBrief:
- if `config.brief.bimodal_clarify !== false` AND (`brief.clarificationNeeded?.question` present OR `brief.interpretations.length >= 2`) → return `{ kind: "clarify", question }` where question renders the fork + options. This starts NO session (registration.ts already returns `needsClarification` with no session started) = HARD pause-and-wait: nothing proceeds until the human answers by re-invoking with a disambiguated request. NO best-guess, NO stop-window (Carel's explicit call).
- Audit/log: `deps.logger.info("[crystalliser] bimodal brief -> clarify", {interpretations, question})`.

New `CrystallisedBrief` optional fields `interpretations?`, `clarificationNeeded?` (additive; the SDK crystalliser is the only producer; ignored downstream if the run proceeds — but on a bimodal brief we never proceed).

## Config (BriefConfig + DEFAULTS + manifest additionalProperties:false)
- `brief.repo_only_invariant: boolean` (default true) — gates the F1 crystalliser reframe rule text (off = pre-beta.80 prompt).
- `brief.bimodal_clarify: boolean` (default true) — gates the F2 planning-time pause.
- `brief.bimodal_min_interpretations: number` (default 2) — how many distinct readings force a clarify.

## Boundaries / non-goals
- Hard pause-and-wait ONLY (Carel's decision). No best-guess-with-window.
- Does NOT resurrect beta.79's regex API-execution detector — the crystalliser self-reports (model judgement on "does this have ≥2 buildable readings"), which is the right axis (bimodality), not "URLs in ACs".
- Does NOT add a live-API-execution capability. Repo work + tests only.
- Reuses the existing crystallise-time `clarify` return (no session started) — no new resume plumbing. (beta.55 mid-run awaiting_clarification is untouched.)

## Tests (target ~+16)
`tests/beta80-repo-only-and-bimodal-clarify.test.mjs`:
- crystallisePrompt returns `kind:"clarify"` when the crystalliser emits `clarificationNeeded` (injected callCrystalliser) — renders question + options.
- returns `clarify` when `interpretations.length >= 2` even without an explicit clarificationNeeded.
- returns `brief` (proceeds) when interpretations empty/1 and no clarificationNeeded.
- `bimodal_clarify:false` → proceeds even with interpretations (escape hatch).
- `bimodal_min_interpretations:3` honoured (2 readings no longer trips).
- partial/absent config.brief → defaults on, does not throw.
- the exact DR/BCP fork (build-receiver vs migration vs docs) → clarify with a 2-3 option question.
- source-asserts: crystalliser prompt carries the REPO-ONLY reframe rule + the bimodal self-report instruction; classifier prompt no longer contains the "clarify is the exception... not the default" thumb and DOES contain balanced clarify-is-first-class guidance; prompt-refiner routes clarificationNeeded/interpretations before validateBrief.
- config defaults + manifest declare the 3 new keys.
- version.ts pluginVersion == package.json (beta.77 miss guard, keep the test).

## Version discipline
Bump src/version.ts + package.json to 0.1.0-beta.80 + rebuild dist BEFORE tagging.
