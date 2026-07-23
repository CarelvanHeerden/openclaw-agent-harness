# beta.67 scope-creep removal — CONCURRENT WRITER CONFLICT

Clark asked (2026-07-23 ~19:00 UTC) to remove the `enforce_worker_context` /
Fable revise-spec ("fable-in-the-loop") feature from the beta.67 build, keeping
ONLY the three P0s (A external stall-sweep, B adversary plan_base_sha diff-base,
C verifier effectiveTaskMode).

## Status
- Removal is CORRECT and was VERIFIED clean at least twice:
  tsc clean, build exit 0, `npm test` 766/766 pass fail=0, smoke OK 3 services.
- fable5-lead.ts and claude-sdk.ts restored to e4e0c8a (0-line diff).
- config.ts / index.ts / loop.ts / openclaw.plugin.json de-scoped (stall_sweep
  key + all three P0s kept). CHANGELOG/DEV_LOG already describe only A/B/C.

## BLOCKER
Another active session/agent is CONCURRENTLY developing the fable-in-the-loop
feature IN THIS SAME WORKING TREE. Evidence:
- notes/SPEC-fable-in-the-loop.md (untracked, staged by the peer, not by me).
- A peer test file tests/beta67-fable-in-loop.test.mjs kept re-appearing
  (created 19:05:42, after my edits).
- After every removal I made, the scope creep was re-injected into
  fable5-lead.ts + claude-sdk.ts within ~30-60s (mtimes 19:05-19:08),
  sometimes mid-build (tsc --noEmit passed, then build's tsc failed on a
  freshly re-added enforce_worker_context reference).
- Files were being `git add`-ed to the index by the peer (I never staged).

I stopped reverting to avoid an infinite write-war and to avoid corrupting the
peer's in-flight work. The three P0s (A/B/C) are intact; the removal is proven
correct in the clean windows. RESOLUTION NEEDED: coordinate so the peer session
pauses (or moves its fable-in-the-loop work to a separate branch/worktree),
then a single final de-scope + verify + (Clark) ships beta.67.
