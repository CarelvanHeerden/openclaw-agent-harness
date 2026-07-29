/**
 * beta.90 (Feature 1): INFRA-CRASH classifier for adversary-review recovery.
 *
 * ROOT CAUSE (session 041bd3d3 — the b89 DR/BCP smoke): all 11 sub-tasks
 * completed clean (self-verify GREEN), but the cycle-1 adversary review CRASHED
 * on `ENOSPC: no space left on device`. `finaliseReviewCrash` gated graceful
 * recovery on `cycle >= 2 && priorReview`, so a CYCLE-1 crash with no prior
 * review => HARD FAIL, no PR — even though every sub-task was self-verified.
 *
 * An INFRA crash (out of disk / out of memory / broken pipe / socket reset)
 * is an ENVIRONMENT failure, NOT a signal about the code under review. It must
 * NOT sink a fully self-verified run. This module classifies such errors so the
 * loop can open a graceful `needs_human_review` PR without a prior review when
 * the crash was infrastructural and self-verify is green.
 *
 * Broader than DISK_EXHAUSTION_RE (src/adapters/git-worktree.ts): that regex is
 * scoped to worktree/npm-install disk faults; this one also covers file-handle
 * exhaustion (EMFILE) and transport faults (ECONNRESET / socket hang up /
 * ETIMEDOUT / EPIPE) that can crash the review SDK stream mid-flight.
 *
 * Pure module: no imports. Do not add side effects here.
 */
/**
 * Matches the message text of an INFRASTRUCTURE crash (disk / memory / IO /
 * file-handle / transport), as distinct from a QUALITY error (e.g. a malformed
 * adversary verdict JSON). Case-insensitive.
 */
export const INFRA_CRASH_RE = /\bENOSPC\b|no space left on device|disk quota exceeded|\bENOMEM\b|cannot allocate memory|\bEIO\b|\bEMFILE\b|too many open files|\bECONNRESET\b|socket hang up|\bETIMEDOUT\b|\bEPIPE\b/i;
/**
 * True when `text` looks like an infrastructure crash (see INFRA_CRASH_RE).
 * Null/undefined/empty => false (an absent message is NOT assumed infra).
 */
export function isInfraCrash(text) {
    return INFRA_CRASH_RE.test(text ?? "");
}
//# sourceMappingURL=infra-crash.js.map