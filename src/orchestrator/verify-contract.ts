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

const PUSH_RE = /\b(push(ed|es|ing)?|push to (origin|remote)|remote sha|ls-remote)\b/i;
const VERIFY_REMOTE_RE = /\b(verify (remote|pushed)|verify remote sha|ls-remote|confirm push)\b/i;
const PR_RE = /\b(pull request|open (a )?pr|draft pr|merge request|\bpr\b|\bmr\b)\b/i;
const PR_DRAFT_RE = /\bdraft\b/i;
const COMMIT_RE = /\b(commit(ted|s|ting)?)\b/i;
const STAGE_RE = /\b(stage|git add)\b/i;
// file write is inferred from an explicit path in filesLikelyTouched OR
// "write/create/add <path>" language mentioning a file with an extension.
const FILE_WRITE_RE = /\b(write|create|add|update|edit|modify)\b.*\b[\w./-]+\.[a-z0-9]{1,6}\b/i;
const E2E_RE = /\b(end.to.end|e2e|verify (the )?(remote|observable) side.?effects?|final (check|verification))\b/i;
const SHA_MATCH_RE = /\b(verify remote sha|sha match(es)?|confirm sha|push.*sha|sha.*push)\b/i;

/**
 * beta.12 fix: negation-aware matching.
 *
 * The original regex tests match on the PRESENCE of push/PR/commit words
 * regardless of whether they're prefixed by a negation cue. On a sub-task
 * whose intent explicitly says "do NOT push, do NOT open a PR", the naive
 * `.test()` matches and infers positive contract kinds. Result: verifier
 * demanded a push+PR that the sub-task itself said should not happen.
 *
 * Fix: find each match position and reject matches whose immediately
 * preceding ~30-char window contains a negation cue (do not / don't / no /
 * without / never / avoid / skip / no need to / stop after / not to).
 *
 * We keep this deliberately narrow: we only strip a match when the negation
 * cue is nearby AND applies to the same clause (roughly, no sentence break
 * in between). This misses some ambiguous cases ("push X; do not push Y")
 * but errs on the side of NOT stripping when unsure. Safety: false-negative
 * inference (missing a positive check) is worse than false-positive on a
 * happy-path smoke; the contract inference layer is a HINT, not a source
 * of truth. But we're already false-positive on "don't" cases which is
 * the worst-of-both: adds bogus checks that then fail the sub-task.
 */
const NEGATION_CUE_RE = /\b(do(es)? not|don't|doesn't|didn't|didn't|shouldn't|shall not|must not|no need to|without|never|avoid|skip|stop after|not to|instead of|rather than|no)\b/i;

function hasPositiveMatch(text: string, re: RegExp): boolean {
  // Anchor a global variant of the pattern so we can iterate matches.
  const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(text)) !== null) {
    const idx = m.index;
    // Look at up to 40 chars before the match; if a negation cue is present
    // in that window AND there is no sentence break between them, the match
    // is negated.
    const windowStart = Math.max(0, idx - 40);
    const preceding = text.slice(windowStart, idx);
    // Sentence boundary: '.', ';', '\n', or newline.
    const lastSentenceBreak = Math.max(
      preceding.lastIndexOf("."),
      preceding.lastIndexOf(";"),
      preceding.lastIndexOf("\n"),
    );
    const clauseWindow = lastSentenceBreak >= 0 ? preceding.slice(lastSentenceBreak + 1) : preceding;
    if (NEGATION_CUE_RE.test(clauseWindow)) {
      // Reset lastIndex to prevent infinite loop on zero-length matches, and
      // check the NEXT match instead of returning true for this negated one.
      if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
      continue;
    }
    return true; // Positive match found.
  }
  return false;
}

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

  // beta.12: use negation-aware match helper everywhere. A sub-task whose
  // intent explicitly says "do NOT push" must not have `branch_pushed`
  // inferred.
  const hasPush = hasPositiveMatch(haystack, PUSH_RE);
  const hasE2E = hasPositiveMatch(haystack, E2E_RE);
  const hasVerifyRemote = hasPositiveMatch(haystack, VERIFY_REMOTE_RE);
  const hasShaMatch = hasPositiveMatch(haystack, SHA_MATCH_RE);
  const hasPr = hasPositiveMatch(haystack, PR_RE);
  const hasCommit = hasPositiveMatch(haystack, COMMIT_RE);
  const hasStage = hasPositiveMatch(haystack, STAGE_RE);
  const hasFileWrite = hasPositiveMatch(haystack, FILE_WRITE_RE);

  // ---------- PUSH / REMOTE-BRANCH ----------
  if (hasPush || hasE2E) {
    // Keep backward-compat `branch_pushed` kind for consumers watching old events.
    contract.push({ kind: "branch_pushed" });
    // beta.9: also add richer remote_branch_exists + commit_sha_matches.
    contract.push({ kind: "remote_branch_exists" });
    contract.push({ kind: "commit_sha_matches" });
  } else if (hasVerifyRemote || hasShaMatch) {
    // "verify remote SHA" without an explicit push mention: remote_branch_exists + commit_sha_matches.
    contract.push({ kind: "remote_branch_exists" });
    contract.push({ kind: "commit_sha_matches" });
  }

  // ---------- PR ----------
  if (hasPr) {
    // Explicit PR-opening language: infer state as well.
    // (PR_DRAFT_RE is a modifier; only relevant if we're already inferring a PR check.)
    const draft = PR_DRAFT_RE.test(haystack);
    contract.push({ kind: "pr_opened", draft });
    // beta.9: infer expected state when opening a PR.
    contract.push({ kind: "pr_state", state: draft ? "draft" : "open" });
  } else if (hasE2E) {
    // End-to-end verification: PR must exist but state is not specified
    // (could be draft or open depending on earlier sub-tasks).
    contract.push({ kind: "pr_opened" });
  }

  // ---------- COMMIT ----------
  if (hasCommit || hasStage) {
    const hasPushInContract = contract.some((c) => c.kind === "branch_pushed" || c.kind === "remote_branch_exists");
    if (!hasPushInContract) {
      // Pure "commit" sub-task (no push): keep backward-compat `commit_made` + add `file_committed` if path known.
      contract.push({ kind: "commit_made" });
      const filePath = firstFilePath(subTask);
      if (filePath) {
        contract.push({ kind: "file_committed", path: filePath });
      }
    }
  }

  // ---------- FILE WRITE ----------
  const filePath = firstFilePath(subTask);
  if (filePath && hasFileWrite) {
    // beta.9: file_written now uses fs.stat (includes untracked files).
    contract.push({ kind: "file_written", path: filePath });
  }

  // ---------- END-TO-END: composite ----------
  if (hasE2E) {
    // Add file_pushed and file_in_pr for end-to-end verification sub-tasks.
    if (filePath) {
      contract.push({ kind: "file_pushed", path: filePath });
      contract.push({ kind: "file_in_pr", path: filePath });
    }
  }

  // Deduplicate by kind+path (in case of redundant overlaps from regex hits).
  return dedupe(contract);
}

/** Remove exact-duplicate contracts (same kind + same path, if applicable). */
function dedupe(contracts: SubTaskVerify[]): SubTaskVerify[] {
  const seen = new Set<string>();
  return contracts.filter((c) => {
    const key = c.kind + ("path" in c ? `:${c.path}` : "") + ("state" in c ? `:${c.state}` : "") + ("branch" in c ? `:${c.branch ?? ""}` : "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
