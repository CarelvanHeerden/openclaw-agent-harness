/**
 * Harness-side observable-side-effect contract inference (beta.8 fix #1, done right).
 *
 * WHY THIS EXISTS
 * ---------------
 * beta.7 added a `SubTaskVerify` contract and a verifier, but nothing ever
 * populated it: the lead SDK prompt didn't emit `verify`, so every real
 * sub-task had `verify === undefined` and the worker silently skipped
 * verification. The guardrail was dead code. Worse, workers are told NOT to
 * push (the loop pushes once, post-review), so a lead that decomposes
 * "push branch" / "open PR" into worker sub-tasks produces sub-tasks the
 * worker structurally cannot perform -- and the worker just returns
 * `end_turn: completed` with a confabulated success narrative.
 *
 * FIX
 * ---
 * The HARNESS infers the verification contract itself from the sub-task's
 * observable-intent signals (title/intent/successCriteria), independent of
 * anything the model says. If a sub-task claims a push/PR/file/commit, the
 * harness will verify that claim against git / the provider API / disk after
 * the worker exits, regardless of the SDK stop reason.
 *
 * This is deliberately conservative: we only INFER a contract when the
 * language strongly implies an observable side effect. A sub-task with an
 * explicit `verify` from the lead always wins (future-proofing).
 *
 * beta.9: extended with 8 precise contract kinds. Inference rules added for:
 *   "write/create/add X"          -> file_written (fs.stat, not git diff)
 *   "commit" (no push)            -> file_committed (if path mentioned) + commit_made
 *   "push branch"                 -> branch_pushed + remote_branch_exists + commit_sha_matches
 *   "verify remote SHA" / pushed  -> remote_branch_exists + commit_sha_matches
 *   "open PR"                     -> pr_opened + pr_state
 *   "end-to-end verification"     -> file_pushed + pr_opened + file_in_pr + pr_state
 *
 * Backward compat: existing `branch_pushed`, `pr_opened`, `commit_made` kinds
 * are KEPT in inference output for sub-tasks that matched them in beta.8.
 * Consumers watching old audit event names will still see them fire.
 */
import type { LeadPlanSubTask, SubTaskVerify } from "./fable5-lead.js";
/**
 * Infer the observable-side-effect contract for a sub-task.
 *
 * Precedence:
 *   1. An explicit `verify` on the sub-task (lead-declared) is authoritative.
 *   2. Otherwise infer from title + intent + successCriteria language.
 *
 * Returns [] when the sub-task has no inferable observable output (pure
 * reasoning / analysis), in which case the SDK signal is trusted.
 */
export declare function inferVerifyContract(subTask: LeadPlanSubTask): SubTaskVerify[];
//# sourceMappingURL=verify-contract.d.ts.map