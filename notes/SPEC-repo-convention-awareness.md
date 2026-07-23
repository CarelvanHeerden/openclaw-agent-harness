# SPEC — Repo Convention Awareness (context-ingest + convention-check-in-final-verify)

Author: Clark · 2026-07-23 · Origin: Carel's PR #859 review of the b60 taxonomy-dropdown deliverable

## Motivation

The b60 deliverable (PR #859 on Stitch-Vercel/ProjectThanos) is genuinely good and passes CI
(jest 6/6, tsc clean, eslint clean). But it added a `src/lib/**` file WITHOUT regenerating the
OKF bundle, which the repo's `keep-okf-current` rule requires. `npm run okf:check` reports 3 drift
issues — yet CI does NOT run `okf:check`, so the PR passes CI anyway.

**Root lesson: the harness only respects what the gates enforce.** A CI-only harness declares
victory on green CI and never runs repo conventions that live outside CI (OKF drift, dir-placement
conventions, CONTRIBUTING rules, `.cursor/rules/*`). Two independent fixes address this; ship both.

Secondary signal (same class): dir-placement nit — the worker created `src/lib/taxonomy/` instead
of folding into the existing `src/lib/grc/` taxonomy code. The harness has no model of THIS repo's
structural conventions beyond what a probe can infer. (Callback to the #858 finding-10 grc-rename
refusal — same convention ambiguity, resolved the other direction.)

---

## Fix 1 — Convention-as-context (ingest repo rule files into the brief)

**Goal:** the worker + adversary SEE the repo's declared conventions, not just infer them.

**Where:** brief construction / crystallisation stage (the OpenClaw agent turn that builds the
brief), plus thread through to the lead + worker + adversary SDK prompts (which do NOT get OpenClaw
context injection — must be explicitly carried in the brief, per the OKF-priming lesson).

**Detection (at brief build, in the checked-out repo root):**
- `.cursor/rules/**/*.mdc` and `.cursor/rules/**/*.md` (Cursor project rules)
- `.cursorrules` (legacy single-file form)
- `CONTRIBUTING.md`, `CONVENTIONS.md`, `AGENTS.md`, `.github/CONTRIBUTING.md`
- Any repo-declared check scripts in `package.json#scripts` matching `/check|lint|verify|okf/i`
  (used by Fix 2, but discovered here)

**Payload:** new optional brief field `repoConventions: { source: string, text: string }[]`
(capped total chars — e.g. 8–12k — truncate longest-first with a note, same budget discipline as
OKF recall gating). Summarise/dedupe if over budget rather than dropping silently.

**Prompt wiring:**
- Lead system prompt: "Respect these repo conventions when planning file placement and sub-tasks.
  If a convention conflicts with the brief, surface it as a finding, do not silently violate it."
- Worker system prompt: include the relevant convention text for the files it touches.
- Adversary prompt: "Flag any change that violates a stated repo convention, even if CI is green."

**Config:** `brief.ingest_repo_conventions` (default true), `brief.convention_char_budget` (default 10000).
Add to config.ts + openclaw.plugin.json (manifest `additionalProperties:false` — beta.34 lesson).

**Why this alone is insufficient:** convention-as-context is easy for the model to under-weight
under token pressure or when the brief is dense. Hence Fix 2.

---

## Fix 2 — Convention-as-check (run declared check scripts in the final-verify sub-task)

**Goal:** enforce conventions the harness can RUN, independent of what CI gates.

**Where:** the final-verify / observe sweep sub-task (loop.ts, the last sub-task the lead emits).

**Behaviour:**
- Discover repo-declared check scripts from `package.json#scripts` (reuse Fix-1 discovery):
  `okf:check`, `lint`, `typecheck`/`tsc`, `test`, plus any `*:check` scripts. Prefer an explicit
  allowlist config over blind-running everything.
- Run each inline+blocking in the worktree (same execution model as the beta.53/54 worker fix —
  NO background/await, run synchronously in the turn).
- Non-zero exit → emit a `loop.convention_check_failed` finding with the script name + captured
  output tail. Treat as a REVISE-worthy finding (folds into the adversary/revise cycle), NOT a hard
  fail of the whole run — the code may be correct and only the bundle stale (exactly PR #859:
  `okf:check` drift with green CI).
- If a check script would need network/build the worktree can't do, log non-fatal + note (beta.53
  bootstrap lesson) rather than failing the run.

**Config:** `verify.run_repo_check_scripts` (default true),
`verify.check_script_allowlist` (default `["okf:check","lint","typecheck","test"]`),
`verify.check_script_timeout_seconds` (default 600). Add to config.ts + manifest.

**Audit:** `loop.convention_check_ran {script, exitCode}`, `loop.convention_check_failed {script, outputTail}`.

**Result on PR #859's case:** the final-verify sub-task runs `npm run okf:check`, sees the 3 drift
issues, and either (a) the worker regenerates the OKF bundle as a follow-up mutate, or (b) it
becomes a finding on the PR — so the harness catches what CI can't.

---

## Tests (behavioural, following the beta test-discipline)

- Fix 1: brief build ingests `.cursor/rules/*` + `.cursorrules` + CONTRIBUTING; char-budget
  truncation is longest-first + noted; empty repo → `repoConventions: []`; config default + manifest
  wiring source-asserts.
- Fix 2: final-verify discovers `okf:check` from package.json scripts; a non-zero check → a
  `loop.convention_check_failed` finding (NOT a hard run-fail); allowlist gating (a non-allowlisted
  script is NOT run); timeout/non-fatal on unrunnable script; audit events fire; config+manifest wiring.

## Sequencing / scope

Ship as ONE beta (they're two halves of one lesson: see conventions + enforce conventions).
Keep it tight — brief field + discovery helper + prompt lines (Fix 1) and final-verify script
runner + finding path (Fix 2). No new tools. Config-gated, default-on. Build on current tip
(beta.62). Manifest change required for the new config keys.
