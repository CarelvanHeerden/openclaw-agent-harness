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
 */

import type { LeadPlanSubTask, SubTaskVerify } from "./fable5-lead.js";

const PUSH_RE = /\b(push(ed|es|ing)?|push to (origin|remote)|remote sha|ls-remote)\b/i;
const PR_RE = /\b(pull request|open (a )?pr|draft pr|merge request|\bpr\b|\bmr\b)\b/i;
const COMMIT_RE = /\b(commit(ted|s|ting)?)\b/i;
// file write is inferred from an explicit path in filesLikelyTouched OR
// "write/create/add <path>" language mentioning a file with an extension.
const FILE_WRITE_RE = /\b(write|create|add|update|edit|modify)\b.*\b[\w./-]+\.[a-z0-9]{1,6}\b/i;
const E2E_RE = /\b(end.to.end|e2e|verify (the )?(remote|observable) side.?effects?|final (check|verification))\b/i;

/** Extract a path token that looks like a file (has an extension). */
function firstFilePath(subTask: LeadPlanSubTask): string | undefined {
  const fromList = subTask.filesLikelyTouched?.find((f) => /\.[a-z0-9]{1,6}$/i.test(f));
  if (fromList) return fromList;
  const text = `${subTask.title} ${subTask.intent}`;
  const m = text.match(/\b([\w./-]+\.[a-z0-9]{1,6})\b/i);
  return m?.[1];
}

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
export function inferVerifyContract(subTask: LeadPlanSubTask): SubTaskVerify[] {
  if (subTask.verify && subTask.verify.length > 0) return subTask.verify;

  const haystack = [
    subTask.title,
    subTask.intent,
    ...(subTask.successCriteria ?? []),
  ]
    .filter(Boolean)
    .join(" \n ");

  const contract: SubTaskVerify[] = [];

  // Order matters for readability of diagnostics, not for correctness.
  if (PUSH_RE.test(haystack) || E2E_RE.test(haystack)) {
    contract.push({ kind: "branch_pushed" });
  }
  if (PR_RE.test(haystack) || E2E_RE.test(haystack)) {
    contract.push({ kind: "pr_opened" });
  }
  if (COMMIT_RE.test(haystack) && !contract.some((c) => c.kind === "branch_pushed")) {
    // A pure "commit" sub-task (no push) verifies a local commit exists.
    contract.push({ kind: "commit_made" });
  }
  const filePath = firstFilePath(subTask);
  if (filePath && FILE_WRITE_RE.test(haystack)) {
    contract.push({ kind: "file_written", path: filePath });
  }

  return contract;
}
