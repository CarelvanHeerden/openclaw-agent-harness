/**
 * Orchestrator loop.
 *
 * The core state machine. Given a session id (already row-inserted with a
 * crystallised prompt + brief), it walks:
 *
 *   crystallising -> planning -> executing -> reviewing -> {done|revise}
 *
 * Up to `config.loop.max_cycles` cycles of executing+reviewing. Early exits:
 *   - Adversary verdict "pass"
 *   - User ship-it reaction
 *   - User abort reaction
 *   - Session budget breached
 *   - Session hard timeout
 *
 * The loop is deliberately structured as pure decision helpers + an outer
 * driver, so `advance()` can be unit-tested standalone.
 */

import type { HarnessConfig } from "../config.js";
import type { BudgetEnforcer } from "../budgets/enforcer.js";
import type { PatRouter } from "../auth/pat-router.js";
import type { StateStore } from "../state/store.js";
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";
import type { LeadPlan, LeadPlanSubTask, SubTaskVerify } from "./fable5-lead.js";
import { elideFinalScopeSubTask } from "./fable5-lead.js";
import type { ReviewReport, ReviewFinding } from "./fable5-adversary.js";
import type { WorkerResult } from "./sonnet-worker.js";
import type { RuntimeSnapshot } from "../vercel/logs.js";
import { estimateSubTaskCost } from "../adapters/claude-sdk.js";
import { deriveMergeRecommendation } from "./merge-recommendation.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * beta.64 (P0-3): parse the file paths out of a `git diff --stat base..HEAD`
 * output. Each stat line looks like ` path/to/file.ts | 12 ++--`. The trailing
 * ` N files changed, ...` summary line is skipped. Pure/deterministic.
 */
export function parseDiffStatPaths(diffStat: string): string[] {
  const out: string[] = [];
  for (const raw of (diffStat ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || !line.includes("|")) continue;
    const path = line.split("|")[0]!.trim();
    if (!path || /\bfiles?\s+changed\b/.test(path)) continue;
    // Handle rename form `old => new` -> keep the new path.
    const renamed = /=>\s*(.+?)\}?$/.exec(path);
    out.push(renamed ? renamed[1]!.replace(/[{}]/g, "").trim() : path);
  }
  return out;
}

/**
 * beta.64 (P0-3): collect the union of `filesLikelyTouched` across all of a
 * plan's sub-tasks -- the "expected files" set for the best-effort clean-diff
 * check. Pure/deterministic.
 */
export function collectExpectedFiles(plan: LeadPlan): string[] {
  const set = new Set<string>();
  for (const st of plan.subTasks ?? []) {
    for (const f of st.filesLikelyTouched ?? []) if (f) set.add(f);
  }
  return [...set];
}

/**
 * beta.94 (Feature 1b): the UNION of every sub-task's DECLARED file scope --
 * the concrete file paths carried on each sub-task's verify probes
 * (file_written / file_committed / file_pushed / file_in_pr) PLUS its
 * `filesLikelyTouched`. This is the authoritative "in-scope" set the
 * deterministic final-scope check compares committed files against. A committed
 * file OUTSIDE this union is out-of-scope. Pure/deterministic.
 */
export function collectDeclaredScopeFiles(plan: LeadPlan): string[] {
  const set = new Set<string>();
  for (const st of plan.subTasks ?? []) {
    for (const f of st.filesLikelyTouched ?? []) if (f) set.add(f);
    for (const v of st.verify ?? []) {
      const p = (v as { path?: string }).path;
      if (typeof p === "string" && p) set.add(p);
    }
  }
  return [...set];
}

/**
 * beta.113: the phase-2 (stream-open -> first-token) window for one attempt.
 *
 * Escalating, because the DR/BCP run proved a fixed one does not survive a slow
 * start: sub-task 3 timed out at 30s, the b64 retry fired, and attempt 2 timed
 * out at 30s again. Exported so the escalation is testable without an SDK.
 */
export function firstTokenWindowForAttempt(
  attempt: number,
  baseSeconds: number,
  multiplier: number,
  capSeconds: number,
): number {
  const base = Math.max(1, baseSeconds);
  const mult = Math.max(1, multiplier);
  const cap = Math.max(base, capSeconds);
  return Math.min(cap, Math.round(base * Math.pow(mult, Math.max(0, attempt - 1))));
}

/**
 * beta.113: does a declared scope entry cover this committed file?
 *
 * The DR/BCP run declared `prisma/migrations` and then committed
 * `prisma/migrations/20260807102822_continuity_resilience/migration.sql`. That
 * was reported out-of-scope in both cycles, because the matcher compares two
 * file paths and a directory is not one. The file was the entire point of the
 * sub-task, and the spec demanded it -- `prisma migrate dev --name
 * continuity_resilience` -- so nothing could have declared its real name in
 * advance: migrate stamps a timestamp at generation time.
 *
 * A false out-of-scope entry is not cosmetic. b110 made a large enough count
 * abort the cycle outright, and every entry here is noise in the diff the
 * adversary reads.
 *
 * A declared entry is treated as a directory when it ends in a slash or glob,
 * or when its last segment carries no extension. `prisma/migrations` covers
 * files beneath it; `src/app/api/foo/route.ts` still only covers itself.
 */
export function declaredCovers(committedFile: string, declared: string): boolean {
  if (pathMatches(committedFile, declared)) return true;
  const d = declared.trim().replace(/\/+$/, "").replace(/\/\*+$/, "").replace(/^\.\//, "");
  if (!d) return false;
  const last = d.slice(d.lastIndexOf("/") + 1);
  const looksLikeDir = !last.includes(".") || declared.trim().endsWith("/") || /\/\*+$/.test(declared.trim());
  if (!looksLikeDir) return false;
  const f = committedFile.trim().replace(/^\.\//, "");
  return f.startsWith(`${d}/`);
}

/** beta.34: extract the PR number from a GitHub PR URL (.../pull/846). */
function parsePrNumber(prUrl: string): number | undefined {
  const m = /\/pull\/(\d+)/.exec(prUrl) ?? /\/merge_requests\/(\d+)/.exec(prUrl);
  return m ? Number(m[1]) : undefined;
}
import type { BranchAllocationDecision } from "../adapters/git-worktree.js";
import { inferVerifyContract } from "./verify-contract.js";
import { rederiveContractPath, reconcileTestContractPaths } from "./contract-rederive.js";
import { pathMatches, resolveContractPath } from "./path-match.js";
import { autoResolveContract, buildContractClarification } from "./contract-clarify.js";
import { parseTscErrors, errorsInChangedFiles, buildTypecheckFinding } from "./typecheck-gate.js";
import { buildLedgerIntegrityReport, describeLedgerIntegrityFailure, mergeLedgerCommits, type LedgerCommit } from "./ledger-integrity.js";
import { extractStatedReason } from "./worker-reason.js";
import { findSuspectPlanPaths, describeSuspectPlanPaths, type SuspectPlanPath } from "./plan-path-validate.js";
import { applyPathCorrections, describePathCorrections, type PathCorrection } from "./plan-path-writeback.js";
import { proposeBasenameRescue, repoDirsFromFiles, describeBasenameRescue } from "./basename-rescue.js";
import { verifySubTaskOutput, type VerifyProbes, type VerifyOutcome } from "./verify.js";
import type { InteractionLog, InteractionPhase } from "../state/interaction-log.js";
import { ingestRepoConventions, discoverCheckScripts, runCheckScripts, type CheckScriptResult, type CheckScript } from "./repo-conventions.js";
import { classifyFinding, isBlockingFinding } from "./finding-classify.js";
import { isInfraCrash } from "./infra-crash.js";
import { computeReviseScope } from "./revise-scope.js";
import {
  mapFindingsToSubTasks,
  buildScopedReviseHint,
  type ReviseMappingResult,
  type SubTaskAssignment,
  type MapSubTask,
  type MapFinding,
} from "./revise-mapping.js";
import { detectWorkerConfab } from "./worker-confab-detect.js";
import { selectWorkerModel } from "./worker-model-select.js";
import { canDispatchConcurrently, resolveEffectiveConcurrency } from "./parallel-safety.js";
import { WorktreePool, type PooledWorktree } from "./worktree-pool.js";
import { Mutex, mergeBackSubTask } from "./merge-back.js";

export type LoopStatus =
  | "crystallising"
  | "planning"
  | "executing"
  | "reviewing"
  | "done"
  | "failed"
  | "aborted"
  // beta.55 (B2): a RESUMABLE pause. The loop hit a genuinely-blocking
  // ambiguity (or a worker refused/confabulated a sub-task even after the
  // beta.54 retry) and, rather than hard-fail, it persisted the question +
  // the paused sub-task index and stopped. A human answers via harness_answer
  // and the loop re-drives from the paused seq. NOT terminal: recovery treats
  // it like `resumable`, and worktree-heal must NOT reap its worktree.
  | "awaiting_clarification";

export type LoopOutcome =
  | { status: "shipped"; sessionId: string; prUrl: string; cycles: number; totalCostUsd: number }
  | { status: "failed"; sessionId: string; reason: string; cycles: number; totalCostUsd: number }
  | { status: "aborted"; sessionId: string; reason: string; cycles: number; totalCostUsd: number }
  // beta.38: a re-entrant run() call for a session whose loop is ALREADY
  // running in this process (see runningSessions guard below). Returned
  // instead of starting a second concurrent loop.
  | { status: "skipped_already_running"; sessionId: string; reason: string; cycles: number; totalCostUsd: number }
  // beta.55 (B2): the loop paused resumably for a human decision. NOT a
  // failure -- the worktree is preserved and harness_answer re-drives it.
  | { status: "awaiting_clarification"; sessionId: string; question: string; seq: number; cycles: number; totalCostUsd: number };

/**
 * beta.38: module-level set of session ids whose loop is CURRENTLY running in
 * THIS process. The single source of truth for "is this session's loop alive?"
 *
 * WHY: `recoverSessions` runs on every plugin bootstrap. A plugin RE-REGISTER
 * (e.g. the OKF bundle-reindex churn) triggers bootstrap WITHOUT the process
 * dying -- so the previous generation's `loop.run()` may still be executing in
 * the background. Recovery, seeing a still-`executing` session, would assume
 * the process died and re-drive `loop.run()` -- spawning a SECOND concurrent
 * loop for the same session. That second loop's `git worktree add` then
 * collides with the first loop's still-live worktree (Staging ProjectThanos
 * smoke, session 36f53c40: `fatal: '<branch>' is already checked out at
 * '<pending-...>'` -> loop.plan_failed -> whole run killed after sub-task 1).
 *
 * This module-level set answers the question precisely: within one process
 * lifetime it tracks every live loop, so recovery can skip a session that is
 * still running. On a REAL process restart the module is re-instantiated fresh
 * (empty set), so recovery correctly auto-resumes genuinely-dead sessions.
 * It lives at module scope (not on the runtime instance) so it survives a
 * plugin re-register the same way `runtime-registry` does.
 */
const runningSessions = new Set<string>();

/**
 * beta.52/53: detect a worker that ended its turn WAITING for a mid-turn event
 * that does not exist in the one-shot harness protocol. Two observed cases:
 *   beta.51 seq-3 (session fc64d8ea): "I'll await the Monitor event signaling
 *     tsc is ready rather than polling further." (one clause)
 *   beta.52 seq-5 (session 8464f8ae): "npm ci is still running. The Monitor
 *     will notify me when eslint is installed. Waiting for that event."
 *     (split across TWO sentences -- the beta.52 regex REQUIRED the wait-verb,
 *     the monitor/tool noun, and "event" within ONE clause ([^.\n] stops at the
 *     period) so it FALSE-NEGATIVED this variant, mis-tagging it as a generic
 *     refusal.)
 *
 * beta.53 (P1a) FIX: match on the DISTINCTIVE phrasings independently, then
 * require an environment/tool word ANYWHERE in the message. `PART_RE` catches
 * either half of the seq-5 split ("the Monitor will notify me", "waiting for
 * that event", "await ... event", "Monitor event"); `ENV_RE` confirms it is an
 * environment-wait hallucination (not some unrelated use of "event"). Both must
 * be present. `matchesEnvWaitHallucination` is the exported predicate; the bare
 * regex export is kept for backward-compat with the beta.52 test.
 */
const WORKER_ENV_WAIT_PART_RE =
  /\b(monitor|observer|watcher|sentinel)\s+(event|will\s+notify|notif)|will\s+notify\s+me|await(ing)?\s+(the\s+)?[^.\n]{0,40}\bevent\b|waiting\s+for\s+(that|the|an?)\s+[^.\n]{0,20}\b(event|signal|install|build|completion)\b|poll(ing)?\s+for\s+[^.\n]{0,40}\b(event|signal|ready)\b/i;
const WORKER_ENV_WAIT_ENV_RE =
  /\b(install(ing|ed)?|npm|npm\s+ci|yarn|pnpm|node_modules|tsc|typecheck|eslint|lint|build|compil)/i;
/** beta.53: true when the worker awaited a non-existent env/monitor event. */
export function matchesEnvWaitHallucination(text: string): boolean {
  const t = (text ?? "").replace(/\s+/g, " ");
  return WORKER_ENV_WAIT_PART_RE.test(t) && WORKER_ENV_WAIT_ENV_RE.test(t);
}

/**
 * beta.54: BROADENED async-coordination-confabulation detector. beta.53's
 * `matchesEnvWaitHallucination` AND-gated on an install/build word, on the
 * (now-disproven) premise that this hallucination is triggered by a missing
 * environment. Staging beta.53 #858 seq-3 refuted that: on a plain TypeScript
 * mutate sub-task with NO install path, the worker still ended its turn with
 *   "I'll wait for the completion notification from the background watcher
 *    before running the test suite."
 * -- confabulating an async coordination primitive (a "background watcher" /
 * "completion notification") and yielding its turn instead of running the
 * command inline. The env word ('test suite' is not in ENV_RE) was absent, and
 * the phrase used 'wait for' (not 'waiting for'), so beta.53 missed it twice.
 *
 * This predicate captures the CLASS: the worker says it will wait/await for
 * some notification/event/signal/callback from an imagined watcher/monitor/
 * background process, WITHOUT requiring any env/install context. It is the
 * gate for the retry-with-context path (still restricted to no-side-effect
 * verification kinds, so a confabulated push/PR is never retried).
 *
 * Two independent shapes, either suffices:
 *  (A) an explicit coordination NOUN the harness does not provide
 *      (monitor/observer/watcher/sentinel/daemon/background process/
 *       completion notification/callback/webhook) paired with a wait/await/
 *       notify/resume verb; OR
 *  (B) a wait/await/poll verb pointed at an event/signal/notification/
 *      callback/completion the worker expects to ARRIVE (passive coordination).
 */
const ASYNC_COORD_NOUN_RE =
  /\b(monitor|observer|watcher|sentinel|daemon|background\s+(process|task|job|watcher|runner)|completion\s+(notification|signal|event|message)|async\s+(runner|process)|callback|webhook)\b/i;
const ASYNC_COORD_WAIT_VERB_RE =
  /\b(wait(ing|s)?\s+for|await(ing|s)?|poll(ing|s)?\s+for|listen(ing)?\s+for|expect(ing)?\s+(a|an|the)?)\b/i;
const ASYNC_COORD_ARRIVAL_RE =
  /\b(event|signal|notification|notify|callback|completion|ready\s+message|message\s+from|to\s+(complete|finish|be\s+(ready|done|installed|built)))\b/i;
/** beta.54: true when the worker confabulated an async coordination primitive. */
export function matchesAsyncCoordConfabulation(text: string): boolean {
  const t = (text ?? "").replace(/\s+/g, " ");
  if (!t) return false;
  // Shape A: a coordination NOUN the harness never provides, near a wait verb.
  const hasNoun = ASYNC_COORD_NOUN_RE.test(t);
  const hasWaitVerb = ASYNC_COORD_WAIT_VERB_RE.test(t);
  if (hasNoun && hasWaitVerb) return true;
  // Shape B: a wait/await/poll verb aimed at an arriving event/signal/notif.
  if (hasWaitVerb && ASYNC_COORD_ARRIVAL_RE.test(t)) return true;
  // Backward-compat: the original env-wait shape is a strict subset.
  return matchesEnvWaitHallucination(t);
}
/**
 * beta.53 (P1b): verification kinds that are eligible for an env-wait retry.
 * These are the "no observable change" kinds -- a worker that hallucinated a
 * wait produced no commit/no committed-file/wrote-but-didnt-commit. We NEVER
 * retry a confabulated push/PR (branch_pushed, pr_opened, ...): those aren't
 * env-wait shapes and retrying could mask a real confabulation.
 */
const ENV_WAIT_RETRYABLE_KINDS = new Set(["commit_made", "file_committed", "file_written"]);

/**
 * beta.58 (Bug B): distinguish a GOOD-FAITH premise-contradicted skip from a
 * bad-faith refusal. `loop.worker_refusal` conflated two opposite semantics:
 *  - beta.53 seq-3: worker hallucinated a background watcher, wrote nothing
 *    (bad-faith, genuine refusal).
 *  - beta.54/55 seq-2: worker correctly determined a CONDITIONAL PREMISE was
 *    contradicted per the brief's own rules and produced structured evidence
 *    (good-faith, a correct no-op).
 * Both produced identical `loop.worker_refusal` events. The discriminator
 * (Staging's pipe marker): the worker's explanation references a contradicted
 * premise / invalid finding. This is DIAGNOSTIC ONLY -- it does not change
 * pass/fail (the escalation-to-clarification path is unchanged); it just emits
 * a distinct, greppable audit event so operators can tell the two apart.
 */
const INVALID_PREMISE_RE =
  /\b(premise\s+(is\s+)?contradict|contradict\w*\s+(the\s+)?premise|premise\s+(is\s+)?(false|invalid|not\s+met|does\s+not\s+hold)|finding\s+(is\s+)?invalid|invalid\s*[:\-]?\s*premise|premise\s+not\s+satisfied|conditional\s+premise)/i;
export function matchesInvalidPremiseSkip(text: string): boolean {
  const t = (text ?? "").replace(/\s+/g, " ");
  if (!t) return false;
  return INVALID_PREMISE_RE.test(t);
}

/**
 * beta.55 (B3): detect that a worker PASSED verification but deviated from the
 * literal sub-task wording -- a judgment call it made and documented (the #858
 * sub-task-2 grc case: "I left the non-empty grc/ dirs in place because deleting
 * them would destroy unrelated code"). This is guess-and-document, which is
 * defensible for an async harness ONLY if it's VISIBLE. We surface it as a
 * first-class `loop.worker_deviation` audit event instead of burying it in the
 * finalMessage prose. Does NOT change pass/fail (the sub-task passed).
 */
const WORKER_DEVIATION_RE =
  /\b(instead of|rather than|chose (not )?to|decided (not )?to|opted (not )?to|I (did not|didn't|left|kept|skipped|avoided)|deviat|as opposed to|in lieu of|preserv\w* (both|the existing)|took a different approach)\b/i;
export function matchesWorkerDeviation(text: string): boolean {
  const t = (text ?? "").replace(/\s+/g, " ");
  if (!t) return false;
  return WORKER_DEVIATION_RE.test(t);
}
/** @deprecated beta.52 single-clause regex; kept for backward-compat tests. */
const WORKER_PROTOCOL_ASSUMPTION_RE =
  /\b(await|wait(ing)?\s+for|poll(ing)?\s+for)\b[^.\n]{0,80}\b(monitor|harness|install|build|tsc|ready|completion|background)\b[^.\n]{0,40}\b(event|signal|ready|notif|callback|complet)/i;
void WORKER_PROTOCOL_ASSUMPTION_RE;

/**
 * beta.56 (P0-1): render the previous cycle's adversary review as a corrective
 * dispatch hint for revise-cycle workers.
 *
 * ROOT CAUSE this fixes: on an `adversary_revise` verdict the loop re-ran the
 * SAME sub-task prompts verbatim -- `runWorker({brief, subTask, plan})` carried
 * no findings, so cycle 2 was cycle 1 replayed and the loop structurally could
 * not converge (the immortal-finding treadmill beta.44-49 patched around, the
 * beta.35 "revise no-op" carve-out, and the refusal spiral all trace here).
 * The worker on a revise cycle now sees verdict, summary, and the concrete
 * findings, scoped with an explicit "if none apply to your sub-task, change
 * nothing" instruction so the beta.35 legal-no-op path still works.
 */
export function buildReviseDispatchHint(review: ReviewReport): string {
  const all = review.findings ?? [];
  const actionable = all.filter((f) => f.severity !== "info");
  const shown = (actionable.length > 0 ? actionable : all).slice(0, 12);
  const lines = shown.map((f) => {
    const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
    return `- [${f.severity}/${f.dimension}] ${f.title}${loc}: ${f.detail}`.slice(0, 600);
  });
  return [
    `REVISION CYCLE: an adversarial reviewer examined the previous cycle's diff and returned verdict "${review.verdict}".`,
    `Reviewer summary: ${(review.summary ?? "").slice(0, 800)}`,
    lines.length > 0 ? `Outstanding findings:` : `(The reviewer returned no itemised findings.)`,
    ...lines,
    ``,
    `Address the findings that fall inside THIS sub-task's files/scope. If none of them apply to this sub-task, make NO changes and end your turn -- do not redo work that is already correct.`,
  ].join("\n");
}

/**
 * beta.42: active stall-watchdog timers, keyed by sessionId. When the
 * re-entrancy guard SKIPS a re-entry (`loop.run_skipped_already_running`), it
 * arms a timer here. beta.40's reclaim was PASSIVE -- it only re-evaluated
 * staleness when something re-called run(); a loop that wedged with no
 * subsequent re-register was never re-checked (Staging beta.40 smoke: session
 * 18a3f0a1 wedged ~5h30m, staleMs read 10 at skip time because updated_at had
 * just been written, and nothing ever re-called run() to notice it go stale).
 * The watchdog fixes that: it re-checks `updated_at` after a delay and, if the
 * tracked loop has made no progress, force-deregisters the stale handle so the
 * next recovery/run can reclaim it, and emits `loop.wedge_detected`.
 */
const stallWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

/** Test/diagnostic helper: clear any armed watchdog for a session. */
export function clearStallWatchdog(sessionId: string): void {
  const t = stallWatchdogs.get(sessionId);
  if (t) { clearTimeout(t); stallWatchdogs.delete(sessionId); }
}

/** True if a loop for this session is currently running in this process. */
export function isSessionLoopRunning(sessionId: string): boolean {
  return runningSessions.has(sessionId);
}

/** Test/diagnostic helper: snapshot of currently-running session ids. */
export function runningSessionIds(): string[] {
  return [...runningSessions];
}

/**
 * beta.42: bound a promise by a timeout. The worker SDK call was previously
 * awaited with NO timeout (loop.ts runOne), so a hung worker (SDK socket
 * stall, or the runtime torn down under the await by a plugin re-register)
 * left the `await` unresolved forever -> the loop froze, `updated_at` stopped,
 * and the hard-deadline check (only evaluated BETWEEN sub-tasks) never ran.
 * That was the true root cause of the ~5h30m silent wedge on the beta.39 +
 * beta.40 ProjectThanos smokes. Racing the worker against a rejecting timeout
 * converts an infinite hang into a bounded, catchable failure that the loop's
 * existing try/catch already handles (marks the sub_task failed, sets
 * failed.err, returns). Returns a tuple so the caller can clear the timer.
 */
/**
 * beta.110: the committed tree bears no resemblance to what the plan declared,
 * so there is nothing worth reviewing. Thrown by runFinalScopeCheck.
 *
 * Distinct from ordinary scope creep, which stays a `medium` review finding.
 * This is the 12,423-out-of-scope-files case from PR #932 session `9217236c`.
 */
export class ScopeBlowoutError extends Error {
  constructor(
    readonly outOfScopeCount: number,
    readonly threshold: number,
    readonly sample: string[],
  ) {
    super(
      `scope_blowout: ${outOfScopeCount} committed file(s) fall outside every sub-task's declared scope ` +
        `(threshold ${threshold}). This is almost always a tool cache or build output written into the ` +
        `worktree, not project work. Review was skipped because a diff this size cannot be reviewed; the ` +
        `worktree is preserved so any good commits can be recovered. First paths: ${sample.slice(0, 5).join(", ")}`,
    );
    this.name = "ScopeBlowoutError";
  }
}

export class WorkerTimeoutError extends Error {
  /**
   * beta.106: `limit` names the knob that actually fired.
   *
   * This helper bounds the worker, the lead and the adversary, but the message
   * hardcoded "worker_timeout_seconds" for all three. On the b105 smoke a LEAD
   * timeout at 900s was reported as "worker exceeded worker_timeout_seconds
   * (900s)" while `worker_timeout_seconds` was set to 1800 -- a number that
   * appeared nowhere in the config, sending the diagnosis to the wrong phase.
   * Defaults to the old text so existing callers and their assertions are
   * unchanged.
   */
  constructor(public readonly seconds: number, public readonly limit = "worker_timeout_seconds") {
    super(`worker exceeded ${limit} (${seconds}s) with no result`);
    this.name = "WorkerTimeoutError";
  }
}

export async function withTimeout<T>(p: Promise<T>, seconds: number, limit?: string): Promise<T> {
  if (!(seconds > 0)) return p; // 0/undefined disables the bound (defensive)
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WorkerTimeoutError(seconds, limit)), seconds * 1000);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface OrchestratorDeps {
  config: HarnessConfig;
  state: StateStore;
  budget: BudgetEnforcer;
  pat: PatRouter;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };

  /**
   * beta.63 (Part B): durable interaction log. Optional for back-compat with
   * test doubles that don't exercise it; when present, EVERY state transition,
   * verify probe, refusal/env-wait/deviation, and stall/recovery event is
   * mirrored into a JSONL file OUTSIDE the worktree (the SDK adapters log their
   * own sdk_request/sdk_response events via the same instance). Never throws.
   */
  interactionLog?: InteractionLog;

  /**
   * Injected work-doers. Real impls in src/adapters + src/vercel.
   *
   * `requester` is the session's Slack user id, threaded through so PAT
   * resolution can select THAT user's token (multi-user auth), rather than
   * defaulting to the first authorised user. Optional for back-compat with
   * test doubles that ignore it.
   */
  runLead: (
    brief: CrystallisedBrief,
    ctx?: {
      requester?: string;
      /**
       * beta.105: the session the plan belongs to, so worktree allocation can
       * audit which checkout path it took against that session. Optional for
       * back-compat with test doubles.
       */
      sessionId?: string;
      /**
       * beta.105: called when allocation chooses its checkout path. The loop
       * turns it into `loop.branch_allocation`, because the b103 smoke could
       * not tell from the trail whether a resume preserved the branch or reset
       * it off eight of its own commits.
       */
      onBranchDecision?: (d: BranchAllocationDecision) => void;
    },
  ) => Promise<LeadPlan>;
  /**
   * beta.67 (P0b): the Fable revise-spec turn. On an adversary `revise`
   * verdict, runs ONCE at the top of the revise cycle: Fable reads findings +
   * plan, investigates, and returns REFRESHED sub-tasks whose workerContext
   * carries a resolved changeSpec. Fed to cycle-2 workers via beta.66's warm
   * render path -- workers never see raw findings (the beta.63/64 no-op
   * regression). Optional: unwired OR throws -> fall back to
   * buildReviseDispatchHint (never worse than beta.66).
   */
  runLeadReviseSpec?: (params: {
    brief: CrystallisedBrief;
    plan: LeadPlan;
    review: ReviewReport;
    requester?: string;
  }) => Promise<{ subTasks: LeadPlanSubTask[] }>;
  runWorker: (params: {
    brief: CrystallisedBrief;
    subTask: LeadPlanSubTask;
    plan: LeadPlan;
    /**
     * beta.117: the checkout this worker must actually work in.
     *
     * Before b117 the worker derived it from `plan.worktreePath`, because there
     * was only ever one. Under parallelism that is the integration checkout,
     * and a worker editing it would defeat the isolation entirely -- so the
     * loop now states the worktree explicitly and the implementation must
     * honour THIS value, not the plan's. Optional only so pre-b117 stubs keep
     * compiling; callers fall back to `plan.worktreePath` when it is absent.
     */
    worktreePath?: string;
    resumeSessionId?: string;
    requester?: string;
    /** beta.53 (P1b): corrective dispatch context appended on a retry. */
    dispatchHint?: string;
    /**
     * beta.91 (Fix 3): per-sub-task worker model override. When set, the SDK
     * call uses this model instead of config.models.worker (mechanical
     * scaffolding sub-tasks -> cheaper/faster model). Absent = config.models.worker.
     */
    modelOverride?: string;
    /**
     * beta.90 (Feature 2): stream-slow liveness callback. Invoked when the
     * worker SDK stream opens then goes idle (no token/activity delta) past
     * the configured threshold. OBSERVABILITY ONLY -- never aborts.
     */
    onStreamSlow?: (info: { idleMs: number; elapsedMs: number; tokensOut: number; label: string }) => void;
    /** beta.113: per-attempt phase-2 watchdog widening; see runWorkerCallWithRetry. */
    firstTokenTimeoutSecondsOverride?: number;
  }) => Promise<WorkerResult>;
  runAdversary: (params: {
    brief: CrystallisedBrief;
    plan: LeadPlan;
    runtime?: RuntimeSnapshot;
    requester?: string;
    /**
     * beta.67 (Bug B): the persisted branch fork-point sha to diff the review
     * against (`git diff <baseSha>..HEAD`). When set, the adversary sees ONLY
     * the branch's own commits; when omitted, the implementation falls back to
     * the default base branch name (prior behaviour).
     */
    baseSha?: string;
    /**
     * beta.69 (F3): the prior cycle's review, so the adversary is told which
     * findings the worker already attempted (prompt) and the verdict gate can
     * treat recycled findings as non-new (they cannot sustain a `revise`).
     */
    priorFindings?: ReviewFinding[];
  }) => Promise<ReviewReport>;
  fetchRuntime?: (params: { plan: LeadPlan; sessionId: string }) => Promise<RuntimeSnapshot | undefined>;
  pushBranchAndOpenPr: (params: {
    plan: LeadPlan;
    brief: CrystallisedBrief;
    reviewReport: ReviewReport;
    requester?: string;
  }) => Promise<string>;

  /** Signal source: user Slack reactions on our messages. */
  readReactions: (sessionId: string) => Promise<{ shipIt: boolean; abort: boolean; pause: boolean; budgetBump: boolean }>;
  reportProgress?: (sessionId: string, status: LoopStatus, meta?: unknown) => Promise<void>;
  /**
   * beta.77: harness-native OUTBOUND progress/terminal delivery. Fired from
   * `setStatus` on EVERY phase + terminal transition (the single choke point).
   * The implementation (index.ts) best-effort direct-posts the current
   * `harness_progress` headline to Slack via a vault-resolved bot token WHEN the
   * session has a real Slack binding -- an INDEPENDENT path from the wedge-prone
   * agent `api.sendMessage` turn. Fire-and-forget; the loop stays Slack-agnostic
   * (no Slack import here) and a throw here can NEVER escape `setStatus`.
   * Clarifications/inbound stay agent-mediated (`harness_answer`) -- unchanged.
   */
  deliverProgress?: (sessionId: string, status: LoopStatus) => void;

  /**
   * beta.78 (Feature 1+2): harness-native OUTBOUND ad-hoc warning delivery.
   * Same independent direct-post channel as `deliverProgress` (vault bot token,
   * gated on a real Slack binding), but for an arbitrary one-line warning
   * (soft session-budget breach; daily-cap hit). Fire-and-forget, best-effort,
   * never throws. Loop stays Slack-agnostic (no Slack import); a no-op when
   * there is no poster or no real binding (agent-orchestrated runs).
   */
  postWarning?: (sessionId: string, text: string) => void;

  /**
   * beta.8 fix #1 (done right): HARNESS-SIDE observable-side-effect probes.
   * The loop builds a VerifyProbes for a given plan/branch/worktree and runs
   * the inferred contract AFTER each sub-task, independent of the worker's
   * SDK stop reason. This is what actually catches a confabulated "I pushed"
   * / "I opened a PR" -- the harness hits git / the provider API itself.
   *
   * Optional so existing test doubles that don't exercise verification keep
   * working; when absent, verification is skipped (SDK signal trusted).
   */
  buildVerifyProbes?: (params: { plan: LeadPlan; requester: string; worktreePath: string; baseSha: string }) => VerifyProbes;

  /**
   * beta.63 (convention-awareness Fix 2): injectable check-script runner used by
   * the final-verify convention-check pass. Defaults to `npm run <name>`
   * (spawnSync) inside the worktree. Injected in tests so no real npm process
   * spawns. When absent, {@link runCheckScripts}'s built-in runner is used.
   */
  runCheckScript?: (name: string, cwd: string, timeoutMs: number) => { status: number | null; stdout: string; stderr: string; error?: unknown; timedOut?: boolean };

  /**
   * beta.115: run the TypeScript compiler WITHOUT the repo's npm script, for
   * when `npm run typecheck` is unrunnable (exit 127) but the compiler itself
   * is reachable -- the b114 state, where CI typechecked the same tree fine
   * via `npx tsc --noEmit`. Returns null when no route exists, which the gate
   * must report as unavailable rather than clean.
   */
  runTypecheckDirect?: (worktree: string, timeoutMs: number) => { via: string; status: number | null; stdout: string; stderr: string; timedOut?: boolean } | null;

  /** beta.115: evidence about why a check script could not execute, for the audit. */
  diagnoseCheckEnv?: (worktree: string) => Record<string, unknown>;

  /** Read the current HEAD sha of a worktree (for commit_made verification). */
  worktreeHeadSha?: (worktreePath: string) => Promise<string>;

  /**
   * beta.67 (Bug B): compute the branch FORK-POINT sha -- the merge-base of the
   * default base branch and HEAD in the worktree. Captured once at plan_ready
   * and persisted on the session (sessions.plan_base_sha) so the adversary
   * review diffs `git diff <plan_base_sha>..HEAD` (branch-only commits) instead
   * of against main-at-review-time (which accumulates unrelated history and
   * caused beta.66 smoke #4's false-positive revise). Optional; when absent the
   * fork-point is not captured and the adversary falls back to the base-branch
   * name (prior behaviour).
   */
  worktreeMergeBase?: (worktreePath: string, baseBranch: string) => Promise<string>;

  /**
   * beta.67 (Bug B): count commits in `<base>..HEAD` in the worktree, used only
   * for the cheap loop.adversary_diff_base sanity log (warn when the branch
   * has suspiciously many commits vs the plan's sub-task count). Optional.
   */
  worktreeCommitCount?: (worktreePath: string, base: string) => Promise<number>;

  /**
   * beta.101: of `shas`, which are NOT reachable from `from`? Powers the
   * ledger-reachability guard that refuses to review or ship a branch which has
   * lost commits this run already recorded (see ./ledger-integrity.ts).
   * Optional; when absent the guard is skipped (fails open).
   */
  unreachableCommits?: (worktreePath: string, from: string, shas: string[]) => Promise<string[]>;

  /**
   * beta.101: list the repo's tracked files in the worktree, for plan-time
   * detection of paths the lead invented (see ./plan-path-validate.ts).
   * Optional; when absent the check is skipped.
   */
  listRepoFiles?: (worktreePath: string) => Promise<string[]>;

  /**
   * beta.64 (P0-3/P0-4): `git diff --stat <base>..HEAD` in the worktree, for the
   * best-effort-verify clean-diff check and the scripted-verifier fallback's
   * informational diff. Optional; when absent the clean-diff check treats the
   * diff as unavailable (best-effort verify then declines, conservatively).
   */
  gitDiffStat?: (worktreePath: string, base: string) => Promise<string>;

  /**
   * beta.94 (Feature 1b): files COMMITTED in `<base>..HEAD` in the worktree
   * (`git log <base>..HEAD --name-only`). Wraps GitAdapter.listCommittedFiles.
   * Used by the deterministic final-scope check to compare committed files
   * against the union of declared per-sub-task scopes. Optional; when absent the
   * scope check is skipped (no finding). Injected in tests.
   */
  worktreeCommittedFiles?: (worktreePath: string, base: string) => Promise<string[]>;

  /**
   * beta.64 (P0-4): run `npx tsc --noEmit` in the worktree for the scripted
   * verifier fallback. Returns `{ ok, output }` (ok=true means exit 0). Optional;
   * when absent (or the repo has no tsconfig), the tsc step is skipped and the
   * fallback verdict rests on the allowlisted repo check scripts alone. Injected
   * in tests so no real tsc process spawns.
   */
  runScriptedTsc?: (worktreePath: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }>;

  /**
   * beta.81 (Track B / B2): read the COMBINED GitHub CI status for a pushed
   * commit SHA -- "success" | "failure" | "pending" | "none" (no checks). Wraps
   * getCombinedStatus (github.ts). The post-push CI wait-state polls this until
   * it is not `pending` (or ci.wait_timeout_seconds elapses). Optional; when
   * absent the CI wait is SKIPPED (pre-beta.81 behaviour) and the run ships on
   * the review verdict alone. Injected in tests with a fake status sequence.
   */
  ciCombinedStatus?: (input: { repoFullName: string; sha: string; requester: string }) => Promise<"success" | "failure" | "pending" | "none">;

  /**
   * beta.81 (Track B / B2): on CI `failure`, fetch a short excerpt of the
   * failing check-run logs so they can be surfaced as the revise finding
   * source. Optional; when absent the failure is surfaced without log detail.
   */
  ciFailingLogs?: (input: { repoFullName: string; sha: string; requester: string }) => Promise<string>;

  /**
   * beta.81 (Track B / B3): when a repo has NO CI (`ciCombinedStatus === "none"`),
   * AUTHOR a `.github/workflows/*.yml` running the repo's declared check
   * scripts (detected from package.json: typecheck/lint/test/build) in the
   * worktree so CI runs on GitHub. Returns the workflow path written (relative)
   * or null if nothing to author (no package.json / no runnable scripts).
   * Carel: no local fallback ever -- build the CI instead. Optional; when
   * absent B3 is skipped. Injected in tests (no real fs write).
   */
  ciAuthorWorkflow?: (input: { worktreePath: string }) => Promise<{ path: string; scripts: string[] } | null>;

  /**
   * beta.16 fix #3 + beta.17 correctness: release the per-session git
   * worktree on terminal transitions (`loop.shipped`, `loop.aborted`, hard
   * failure). Prior to beta.16 the worktree stayed live until the PR
   * closed/merged (via the pr-watcher).
   *
   * beta.17 change: now returns `{ok, path, error?}` and takes an explicit
   * `worktreePath` (looked up from the sessions row) rather than relying
   * on `sessionId` reconstruction. Beta.16's `git.release(sessionId, repo)`
   * silently no-op'd because the allocator uses `pending-<Date.now()>` on-
   * disk ids, not DB session UUIDs. Callers must pass `worktreePath`.
   *
   * Optional for back-compat with tests that stub the orchestrator; when
   * absent the pr-watcher's release-on-close remains as a safety net.
   */
  releaseWorktree?: (params: {
    sessionId: string;
    repoFullName: string;
    worktreePath: string;
    reason: "shipped" | "aborted" | "failed";
  }) => Promise<{ ok: boolean; path?: string; error?: string }>;

  /**
   * beta.117: lifecycle for one parallel-worker slot checkout.
   *
   * Only consulted when effective concurrency exceeds 1, so a serial run --
   * still the default -- never allocates a slot and behaves exactly as it did
   * before b117. Optional so the many tests that stub the orchestrator do not
   * all have to grow a git implementation.
   */
  allocatePooledWorktree?: (params: {
    sessionId: string;
    repoFullName: string;
    sessionBranch: string;
    slotBranch: string;
    slot: number;
  }) => Promise<string>;
  resetPooledWorktree?: (worktreePath: string, sha: string) => Promise<void>;
  releasePooledWorktree?: (params: {
    repoFullName: string;
    worktreePath: string;
    slotBranch: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** `git -C <cwd> <args>`, rejecting on non-zero exit. Used for merge-back. */
  gitRun?: (cwd: string, args: string[]) => Promise<string>;
}

/**
 * beta.97 (Fix #7): is the adversary finding count CONVERGING across cycles?
 *
 * Convergence = the run was making real progress toward a clean pass but ran
 * out of cycle budget, so an operator should be TOLD it's worth extending
 * (re-run harness_revise) rather than shown a bare do_not_merge. We require
 * BOTH: (a) at least two cycles of signal, and (b) a NET downward trend from
 * the first cycle to the last (last < first). A late bump (e.g. 13 -> 8 -> 12,
 * where cycle-3 fixes added new review surface) still counts as converging so
 * long as the run ended below where it started -- that late bump is exactly the
 * "new code introduced new findings" case where one more cycle plausibly clears
 * it. A flat or net-rising arc (e.g. 8 -> 9 -> 11) is NOT converging: extending
 * would likely just churn, so the plain do_not_merge stands.
 *
 * Pure + unit-tested. Empty/single-cycle input returns false (no signal).
 */
export function isConvergingFindingTrend(counts: number[] | undefined): boolean {
  if (!counts || counts.length < 2) return false;
  const first = counts[0]!;
  const last = counts[counts.length - 1]!;
  if (first <= 0) return false; // no findings to converge from
  // Net improvement from start to finish is the core signal.
  if (last >= first) return false;
  // Guard against a single lucky dip masquerading as a trend: require the run
  // minimum to be meaningfully below the start too (it will be, given last<first,
  // but this makes the intent explicit and robust to future edits).
  const min = Math.min(...counts);
  return min < first;
}

export class OrchestratorLoop {
  /**
   * beta.117: serialises merge-back into the session worktree. One per loop
   * instance, which is one per process -- the only worktree it guards.
   */
  private readonly mergeBackMutex = new Mutex();

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Pure state-transition rule (unit-tested).
   */
  static advance(input: {
    currentStatus: LoopStatus;
    verdict?: "pass" | "revise" | "block";
    cyclesRan: number;
    maxCycles: number;
    /** beta.97 (Fix #7): per-cycle adversary finding counts, in cycle order. */
    findingCountsByCycle?: number[];
    reactions: { shipIt: boolean; abort: boolean; pause: boolean };
    budgetExhausted: boolean;
    hardTimeout: boolean;
    /**
     * beta.109: findings in this review that are diff-addressable AND at medium
     * severity or above, per isBlockingFinding. Undefined disables the gate.
     */
    blockingFindings?: number;
    /** beta.109: `loop.ship_when_no_blocking_findings`, default on. */
    shipWhenNoBlockingFindings?: boolean;
  }): { nextStatus: LoopStatus; reason: string } {
    if (input.reactions.abort) return { nextStatus: "aborted", reason: "user_abort_reaction" };
    if (input.budgetExhausted) return { nextStatus: "aborted", reason: "budget_exhausted" };
    if (input.hardTimeout) return { nextStatus: "aborted", reason: "hard_timeout" };
    if (input.reactions.shipIt && input.currentStatus === "reviewing") {
      return { nextStatus: "done", reason: "user_ship_it_reaction" };
    }
    switch (input.currentStatus) {
      case "crystallising": return { nextStatus: "planning", reason: "crystallise_ok" };
      case "planning":      return { nextStatus: "executing", reason: "plan_ready" };
      case "executing":     return { nextStatus: "reviewing", reason: "subtasks_complete" };
      case "reviewing":
        if (input.verdict === "pass") return { nextStatus: "done", reason: "adversary_pass" };
        if (input.verdict === "block") return { nextStatus: "failed", reason: "adversary_block" };
        // beta.109: a `revise` carrying nothing blocking has nothing left for
        // another cycle to do that would change the answer.
        //
        // The adversary writes `revise` while ANY finding is open, including
        // informational ones it emits to record that a PRIOR finding was fixed.
        // So a run converges towards a floor it can never cross: ProjectThanos
        // PR #932 went 18 -> 15 -> 17 across three cycles and finished with ten
        // low, six informational and one low convention finding, none at medium
        // or above. Each cycle closed a few nits and opened a few more on the
        // files it had just touched. Two earlier revises on the same PR ended
        // the same way. That is not convergence failing, it is a loop with no
        // exit condition for "good enough".
        //
        // Medium and above still cycles, so this cannot ship real defects. The
        // remaining lows are not lost either -- they go on the PR body and
        // `harness_revise` will pick them up if asked.
        if (
          input.verdict === "revise" &&
          input.shipWhenNoBlockingFindings !== false &&
          input.blockingFindings === 0
        ) {
          return { nextStatus: "done", reason: "shipped_no_blocking_findings" };
        }
        // beta.57 (P3): was `>= maxCycles - 1`, which shipped one cycle EARLY
        // (max_cycles: 3 ran only 2 execute/review cycles -- the check fired at
        // the END of cycle 2 with cyclesRan=2 >= 3-1). A config that promises N
        // cycles now runs N.
        if (input.cyclesRan >= input.maxCycles) {
          // beta.35 fix #3: cycles exhausted with a `revise` (NOT `block`)
          // verdict. `revise` means "improvable", not "broken" -- and on a
          // repo with no in-loop preview-deploy the adversary structurally
          // cannot reach `pass` on a UI change (it will always want runtime
          // evidence it can't get). Rather than throwing away a correct fix
          // (the old `max_cycles_reached` -> failed path), SHIP the PR with
          // an honest "shipped without a clean pass" annotation in the body
          // (renderPrBody #3). The post-ship merge recommendation is derived
          // from `reachedCleanPass=false`, so it comes out `do_not_merge`
          // (beta.34 hard gate): the PR exists, but a HUMAN must approve the
          // merge (via harness_merge_pr, which will refuse and point to the
          // GitHub UI, or via the UI directly) -- which is exactly the
          // "you review, then tell me to merge and verify the deploy" flow.
          // A `block` verdict never reaches here (returned above): a genuine
          // blocking defect still hard-fails and ships nothing.
          //
          // beta.97 (Fix #7): distinguish CONVERGING from stuck. If the finding
          // count was trending DOWN across cycles (net drop from first to last,
          // AND the last cycle is at/below the run minimum-ish), a clean pass
          // was plausibly one more cycle away -- ship do_not_merge as before,
          // but with a DISTINCT reason so the terminal headline + PR body can
          // SURFACE an ask-to-extend ("converging but incomplete -- re-run
          // harness_revise to continue?") instead of a bare do_not_merge. The
          // merge gate is unchanged (still do_not_merge); this is purely an
          // observability signal so the operator can make an informed call.
          if (isConvergingFindingTrend(input.findingCountsByCycle)) {
            return { nextStatus: "done", reason: "shipped_max_cycles_revise_converging" };
          }
          return { nextStatus: "done", reason: "shipped_max_cycles_revise" };
        }
        return { nextStatus: "executing", reason: "adversary_revise" };
      case "done":
      case "failed":
      case "aborted":
        return { nextStatus: input.currentStatus, reason: "terminal" };
      // beta.55 (B2): a resting pause. advance() never drives INTO or OUT of
      // this state (finaliseAwaitingClarification sets it directly; harness_
      // answer re-drives via loop.run from `planning`), but the switch must be
      // exhaustive -- staying put is the correct no-op.
      case "awaiting_clarification":
        return { nextStatus: input.currentStatus, reason: "awaiting_clarification" };
    }
  }

  private setStatus(sessionId: string, status: LoopStatus): void {
    // beta.63 (Part A): bump the session-level liveness heartbeat on EVERY
    // state transition. This is the single column the stall watchdog reads to
    // tell a legit long phase from a wedge. Cheap (one extra column write).
    const now = Date.now();
    this.deps.state.db
      .prepare(`UPDATE sessions SET status = ?, updated_at = ?, last_progress_at = ? WHERE id = ?`)
      .run(status, now, now, sessionId);
    // beta.63 (Part B): mirror the transition into the durable interaction log
    // (external to the worktree) so a stall's frozen phase + last event ts is
    // recoverable after a worktree release / container restart.
    this.deps.interactionLog?.log(sessionId, {
      event: "state_transition",
      phase: mapPhase(status),
      status,
    });
    // beta.77: harness-native outbound progress/terminal delivery. Fired on
    // every phase + terminal transition through this single choke point.
    // Fire-and-forget + guarded so it can never throw out of the sync hot path
    // (a failed/absent progress post must never disturb the loop).
    try {
      this.deps.deliverProgress?.(sessionId, status);
    } catch {
      /* best-effort: progress delivery never affects loop control flow */
    }
  }

  /**
   * beta.63 (Part A): mark forward progress WITHOUT a status change (e.g. a
   * sub-task started/completed, review started, push done). Bumps
   * last_progress_at so the watchdog sees liveness inside a long phase, and
   * logs a progress breadcrumb to the interaction log.
   */
  private markProgress(sessionId: string, marker: string, phase: InteractionPhase, detail?: Record<string, unknown>): void {
    const now = Date.now();
    this.deps.state.db
      .prepare(`UPDATE sessions SET last_progress_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, sessionId);
    this.deps.interactionLog?.log(sessionId, { event: "progress", marker, phase, ...(detail ?? {}) });
  }

  /**
   * beta.90 (Feature 2): build the stream-slow liveness callback for a worker
   * dispatch. When the SDK stream opens then goes idle past the threshold, this
   * (1) emits `loop.worker_stream_slow` for the audit trail and (2) bumps the
   * session liveness heartbeat (last_progress_at, the beta.63 column the stall
   * watchdog reads) so harness_progress surfaces "worker stream idle Ns" rather
   * than the phase looking wedged. Best-effort + throw-guarded: this is pure
   * observability and must NEVER disturb the worker call.
   */
  private makeStreamSlowCallback(
    sessionId: string,
    seq: number,
    cycle: number,
    // beta.94 (Feature 2): optional idle-no-work wiring. When supplied, the
    // callback ALSO tracks the b93 seq-12 idle conjunction and (per config)
    // emits loop.worker_idle_no_work / triggers a narrow abort. `plan` is the
    // worktree source for the "did this sub-task touch files" probe; onIdleAbort
    // (when set) is invoked to abort the sub-task via the WorkerTimeoutError
    // path. Absent = pure beta.90 observability (unchanged).
    idle?: { plan: LeadPlan; baseSha: string; onIdleAbort?: () => void },
  ) {
    // beta.94 (Feature 2): per-dispatch conjunction state. Consecutive
    // stream-slow ticks that ALL had tokensOut===0. Reset on any tick with
    // tokensOut>0 (the worker resumed producing tokens -> not idle).
    let consecutiveSlowZeroTokens = 0;
    let idleFired = false; // emit loop.worker_idle_no_work at most once per dispatch
    return (info: { idleMs: number; elapsedMs: number; tokensOut: number; label: string }) => {
      try {
        const idleSec = Math.round(info.idleMs / 1000);
        this.deps.state.audit(
          "loop.worker_stream_slow",
          { sessionId, seq, cycle, idleMs: info.idleMs, elapsedMs: info.elapsedMs, tokensOut: info.tokensOut },
          sessionId,
        );
        // Reuse the beta.63 last_progress_at heartbeat mechanism so the stall
        // watchdog sees liveness inside a long-but-alive worker stream.
        const now = Date.now();
        this.deps.state.db
          .prepare(`UPDATE sessions SET last_progress_at = ?, updated_at = ? WHERE id = ?`)
          .run(now, now, sessionId);
        this.deps.interactionLog?.log(sessionId, {
          event: "progress",
          marker: `worker stream idle ${idleSec}s`,
          phase: "worker",
          seq,
          cycle,
          idleMs: info.idleMs,
        });

        // beta.94 (Feature 2): idle-no-work conjunction. Track CONSECUTIVE
        // stream-slow ticks with tokensOut===0. When (>= threshold consecutive)
        // AND (cumulative elapsed > floor), verify the sub-task has produced NO
        // worktree writes and, if so, emit loop.worker_idle_no_work (log-only by
        // default) and optionally abort via the existing timeout-class path.
        if (idle) {
          if (info.tokensOut === 0) consecutiveSlowZeroTokens += 1;
          else consecutiveSlowZeroTokens = 0;
          const threshold = this.deps.config.loop.worker_idle_consecutive_slow ?? 3;
          const elapsedFloorMs = (this.deps.config.loop.worker_idle_min_elapsed_seconds ?? 900) * 1000;
          if (
            !idleFired &&
            consecutiveSlowZeroTokens >= threshold &&
            info.tokensOut === 0 &&
            info.elapsedMs > elapsedFloorMs
          ) {
            idleFired = true; // guard re-entry while the async no-writes probe runs
            // The no-writes probe is async; run it fire-and-forget. If writes DID
            // occur, re-arm (clear idleFired) so a later genuinely-idle window
            // can still fire.
            void this.handleWorkerIdleNoWork({
              sessionId, seq, cycle,
              consecutiveSlow: consecutiveSlowZeroTokens,
              elapsedMs: info.elapsedMs,
              idle,
              rearm: () => { idleFired = false; },
            });
          }
        }
      } catch {
        /* best-effort: stream-slow surfacing never affects the worker call */
      }
    };
  }

  /**
   * beta.94 (Feature 2): the idle-no-work conjunction handler. Confirms the
   * sub-task produced NO worktree writes (committed OR working-tree changes)
   * since the sub-task base, then emits `loop.worker_idle_no_work`
   * (LOG-ONLY by default). When loop.worker_idle_abort_enabled is true it ALSO
   * calls onIdleAbort() to abort the sub-task via the existing
   * WorkerTimeoutError / {outcome:'timeout'} terminal path (worktree preserved).
   * Never throws.
   */
  private async handleWorkerIdleNoWork(p: {
    sessionId: string; seq: number; cycle: number; consecutiveSlow: number; elapsedMs: number;
    idle: { plan: LeadPlan; baseSha: string; onIdleAbort?: () => void };
    rearm: () => void;
  }): Promise<void> {
    const { sessionId, seq, cycle, consecutiveSlow, elapsedMs, idle, rearm } = p;
    try {
      const worktree = idle.plan.worktreePath;
      // "Did this sub-task touch files" signal: committed files in
      // <subTaskBase>..HEAD plus any uncommitted working-tree changes. If EITHER
      // is non-empty the worker is producing work (just slowly) -> not idle;
      // re-arm and bail (no event, no abort).
      let touched = false;
      if (worktree) {
        if (this.deps.worktreeCommittedFiles && idle.baseSha) {
          const committed = await this.deps.worktreeCommittedFiles(worktree, idle.baseSha).catch(() => [] as string[]);
          if (committed.length > 0) touched = true;
        }
        if (!touched && this.deps.gitDiffStat && idle.baseSha) {
          const stat = await this.deps.gitDiffStat(worktree, idle.baseSha).catch(() => "");
          if (stat && stat.trim().length > 0) touched = true;
        }
      }
      if (touched) {
        // Work exists -> this is a slow-but-alive worker, not the idle-no-work
        // failure mode. Do NOT emit the event or abort; allow re-arming.
        rearm();
        return;
      }

      // Conjunction confirmed: consecutive zero-token slow ticks past the
      // elapsed floor with NO worktree writes. This is the b93 seq-12 signature.
      const abortEnabled = this.deps.config.loop.worker_idle_abort_enabled === true;
      this.deps.state.audit(
        "loop.worker_idle_no_work",
        { sessionId, seq, cycle, consecutiveSlow, elapsedMs, abortEnabled },
        sessionId,
      );
      this.deps.interactionLog?.log(sessionId, {
        event: "worker_idle_no_work", phase: "worker", seq, cycle, consecutiveSlow, elapsedMs, abortEnabled,
      });
      this.deps.logger.warn("[loop] beta.94: worker idle with no work (zero tokens, no writes) past the idle floor", {
        sessionId, seq, cycle, consecutiveSlow, elapsedMs, abortEnabled,
      });

      // LOG-ONLY unless the abort flag is set. When set, abort via the SAME
      // timeout-class path (WorkerTimeoutError) so the worktree is preserved and
      // the sub-task terminates as {outcome:'timeout'} -- NO new terminal path.
      if (abortEnabled && idle.onIdleAbort) {
        this.deps.state.audit("loop.worker_idle_abort", { sessionId, seq, cycle, consecutiveSlow, elapsedMs }, sessionId);
        idle.onIdleAbort();
      }
    } catch {
      /* best-effort: idle detection never disturbs the worker call by throwing */
    }
  }

  private checkpoint(sessionId: string, cycle: number, lastSubTask?: string, sdkSessionId?: string): void {
    this.deps.state.db
      .prepare(
        `UPDATE sessions
         SET current_cycle = ?,
             last_completed_sub_task = COALESCE(?, last_completed_sub_task),
             last_worker_sdk_session = COALESCE(?, last_worker_sdk_session),
             last_checkpoint_at = ?,
             last_progress_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(cycle, lastSubTask ?? null, sdkSessionId ?? null, Date.now(), Date.now(), Date.now(), sessionId);
  }

  private addCost(sessionId: string, amount: number): void {
    this.deps.state.db
      .prepare(`UPDATE sessions SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?`)
      .run(amount, Date.now(), sessionId);
  }

  private saveReview(sessionId: string, cycle: number, report: ReviewReport): void {
    this.deps.state.db
      .prepare(
        `INSERT INTO reviews (id, session_id, cycle, verdict, findings, summary, cost_usd, sdk_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${sessionId}-r${cycle}`,
        sessionId,
        cycle,
        report.verdict,
        JSON.stringify(report.findings),
        report.summary,
        report.costUsd,
        report.sdkSessionId ?? null,
        Date.now(),
      );
  }

  /**
   * beta.38: re-entrancy guard. If a loop for this session is already running
   * in this process (plugin re-register mid-run), do NOT start a second one --
   * that races the live loop's worktree and kills the run. Return a distinct
   * `skipped_already_running` outcome so callers (recovery) can log-and-move-on.
   * The guard is registered/cleared here so EVERY entry path (fresh run and
   * recovery auto-resume both call `run()`) is covered and can't be forgotten.
   */
  /**
   * beta.117: bring one parallel worker's commits onto the session branch.
   *
   * Serialised across the whole loop instance by {@link mergeBackMutex}: git
   * will not take two concurrent index operations in one worktree, and a lock
   * turns that race into a queue.
   *
   * A conflict here is the mechanism working, not a bug. Two workers writing
   * the same file that neither declared used to corrupt each other invisibly in
   * the shared worktree; now it surfaces as a named conflict against a specific
   * sub-task. The sub-task is marked failed so the cycle's own machinery
   * re-runs it -- by which point the other worker's change is already on the
   * branch, so the retry sees it and adapts.
   */
  private async mergeBackSlot(args: {
    sessionId: string;
    cycle: number;
    st: LeadPlanSubTask;
    lease: PooledWorktree;
    baseSha: string;
    plan: { worktreePath: string };
    failed: { seq: number; err: unknown };
  }): Promise<void> {
    const { sessionId, cycle, st, lease, baseSha, plan, failed } = args;
    const gitRun = this.deps.gitRun;
    if (!gitRun) return;
    const git = {
      run: gitRun,
      headSha: async (cwd: string) => (await gitRun(cwd, ["rev-parse", "HEAD"])).trim(),
    };

    const res = await this.mergeBackMutex.run(() =>
      mergeBackSubTask(git, {
        sessionWorktree: plan.worktreePath,
        workerWorktree: lease.path,
        workerBranch: lease.branch,
        baseSha,
        seq: st.seq,
      }),
    );

    if (res.ok) {
      if (res.landed.length > 0) {
        this.deps.state.audit(
          "loop.parallel_merge_back",
          { sessionId, cycle, seq: st.seq, slot: lease.slot, commits: res.landed.length, fastForward: res.fastForward, headSha: res.headSha },
          sessionId,
        );
      }
      return;
    }

    this.deps.state.audit(
      "loop.parallel_merge_back_conflict",
      { sessionId, cycle, seq: st.seq, slot: lease.slot, reason: res.reason, conflictedPaths: res.conflictedPaths, detail: res.detail },
      sessionId,
    );
    this.deps.logger.error("[loop] a parallel sub-task could not be merged back; its work is NOT on the branch", {
      sessionId, cycle, seq: st.seq, reason: res.reason, conflictedPaths: res.conflictedPaths,
    });
    this.deps.interactionLog?.log(sessionId, {
      event: "parallel_merge_back_conflict", phase: "worker", seq: st.seq, cycle, conflictedPaths: res.conflictedPaths,
    });
    this.deps.state.db
      .prepare(`UPDATE sub_tasks SET status = 'failed', summary = ?, updated_at = ? WHERE session_id = ? AND cycle = ? AND seq = ?`)
      .run(`parallel merge-back ${res.reason}: ${res.detail}`, Date.now(), sessionId, cycle, st.seq);
    if (!failed.err) {
      failed.err = `parallel_merge_back_${res.reason} (seq ${st.seq}): ${res.detail}`;
      failed.seq = st.seq;
    }
  }

  async run(sessionId: string, brief: CrystallisedBrief): Promise<LoopOutcome> {
    if (runningSessions.has(sessionId)) {
      // beta.40: the guard entry exists -- but is the tracked loop actually
      // ALIVE, or a zombie? `runningSessions` is module-scoped and survives a
      // plugin re-register, but the loop it tracks can be torn down WITH the
      // old runtime on re-register. Staging beta.39 smoke (session 07e4c28a):
      // the guard fired at 11:05:26, then the original loop went silent for
      // 110 min -- the guard permanently blocked recovery from reclaiming a
      // dead loop. So: if the session's last progress (checkpoint / updated_at)
      // is stale beyond `stuck_loop_seconds`, treat the tracked loop as dead,
      // force-clear the stale guard entry, and proceed with THIS run. The
      // threshold is safely larger than a normal long worker SDK call, so a
      // legitimately-busy loop is never reclaimed.
      const prog = this.deps.state.db
        .prepare(`SELECT cycles_ran, cost_usd, last_checkpoint_at, updated_at FROM sessions WHERE id = ?`)
        .get(sessionId) as
        | { cycles_ran: number; cost_usd: number; last_checkpoint_at: number | null; updated_at: number | null }
        | undefined;
      const lastProgressMs = Math.max(prog?.last_checkpoint_at ?? 0, prog?.updated_at ?? 0);
      const staleMs = Date.now() - lastProgressMs;
      const stuckThresholdMs = (this.deps.config.loop.stuck_loop_seconds ?? 2700) * 1000;
      const isStuck = lastProgressMs > 0 && staleMs > stuckThresholdMs;

      if (!isStuck) {
        // Live loop (or fresh enough to be presumed live): skip the re-entry.
        this.deps.state.audit(
          "loop.run_skipped_already_running",
          { sessionId, reason: "a loop for this session is already running in this process", staleMs },
          sessionId,
        );
        this.deps.logger.warn("[loop] run() skipped: session loop already running (re-entrant call)", { sessionId, staleMs });
        // beta.42: arm an ACTIVE stall-watchdog. beta.40's reclaim was passive
        // (only re-checked on a subsequent run() call); a wedge with no further
        // re-register was never noticed. Re-check `updated_at` after
        // stall_watchdog_seconds; if the tracked loop made no progress,
        // force-deregister its stale handle so recovery/next-run can reclaim it.
        this.armStallWatchdog(sessionId, lastProgressMs);
        return {
          status: "skipped_already_running",
          sessionId,
          reason: "loop already running in this process",
          cycles: prog?.cycles_ran ?? 0,
          totalCostUsd: prog?.cost_usd ?? 0,
        };
      }

      // Zombie loop: reclaim it.
      this.deps.state.audit(
        "loop.run_reclaimed_stuck",
        {
          sessionId,
          reason: "tracked loop made no progress past stuck_loop_seconds; force-clearing stale guard and re-driving",
          staleMs,
          stuckThresholdMs,
        },
        sessionId,
      );
      this.deps.logger.warn(
        "[loop] reclaiming stuck loop (no progress past stuck_loop_seconds); force-clearing guard and restarting",
        { sessionId, staleMs, stuckThresholdMs },
      );
      runningSessions.delete(sessionId);
    }
    runningSessions.add(sessionId);
    this.ownedSessions.add(sessionId);
    clearStallWatchdog(sessionId); // a live loop is (re)taking ownership
    try {
      return await this.runInner(sessionId, brief);
    } finally {
      runningSessions.delete(sessionId);
      this.ownedSessions.delete(sessionId);
      clearStallWatchdog(sessionId);
    }
  }

  /**
   * beta.57 (P1): sessions whose loop THIS OrchestratorLoop instance is
   * currently driving. The module-scoped `runningSessions` registry is shared
   * across runtimes (it deliberately survives a plugin re-register), so a
   * teardown that drains on it waits for OTHER runtimes' loops too -- on a
   * re-register churn the doomed runtime could block up to
   * teardown_drain_seconds for a session it does not own and whose DB handle
   * it is not holding. Teardown should drain only on sessions it owns.
   */
  private readonly ownedSessions = new Set<string>();

  ownedRunningSessionIds(): string[] {
    return [...this.ownedSessions];
  }

  /**
   * beta.60: instance accessor for the module-level re-entrancy guard set (all
   * in-process running loops, across runtime generations). Used by
   * harness_resume force-unstick to REFUSE unsticking a session that still has
   * a live loop-runner tracked -- so we never yank a genuinely-busy loop out
   * from under itself. A session that wedged with a dead executor will NOT be
   * in this set once the stall-watchdog/reclaim cleared its handle (or if the
   * runtime that ran it was torn down), which is exactly when force is safe.
   */
  runningSessionIds(): string[] {
    return runningSessionIds();
  }

  /**
   * beta.42: arm an active stall-watchdog for a session whose re-entry the
   * guard just skipped. After `loop.stall_watchdog_seconds`, re-read the
   * session's progress; if it has NOT advanced past `lastProgressMs` AND the
   * guard entry is still present, the tracked loop is wedged with no external
   * re-entry to reclaim it -- force-deregister the stale handle (so the next
   * recovery/run reclaims it) and emit `loop.wedge_detected`. Idempotent: an
   * existing timer for the session is replaced.
   */
  private armStallWatchdog(sessionId: string, lastProgressMs: number): void {
    const seconds = this.deps.config.loop.stall_watchdog_seconds ?? 90;
    if (!(seconds > 0)) return;
    clearStallWatchdog(sessionId);
    const timer = setTimeout(() => {
      stallWatchdogs.delete(sessionId);
      try {
        if (!runningSessions.has(sessionId)) return; // loop finished/reclaimed already
        const prog = this.deps.state.db
          .prepare(`SELECT last_checkpoint_at, updated_at FROM sessions WHERE id = ?`)
          .get(sessionId) as { last_checkpoint_at: number | null; updated_at: number | null } | undefined;
        const nowProgress = Math.max(prog?.last_checkpoint_at ?? 0, prog?.updated_at ?? 0);
        if (nowProgress > lastProgressMs) return; // progressed -- healthy, no action
        // No forward progress since the skip: the tracked loop is wedged and
        // nothing re-entered to reclaim it. Force-deregister so recovery/next
        // run can take over.
        runningSessions.delete(sessionId);
        this.deps.state.audit(
          "loop.wedge_detected",
          {
            sessionId,
            reason: "no forward progress after run_skipped_already_running; stale guard handle force-deregistered",
            stallWatchdogSeconds: seconds,
            lastProgressMs,
          },
          sessionId,
        );
        this.deps.logger.warn("[loop] wedge detected: stale guard handle force-deregistered by stall-watchdog", {
          sessionId,
          stallWatchdogSeconds: seconds,
        });
      } catch (err) {
        this.deps.logger.warn("[loop] stall-watchdog check failed", { sessionId, err: String(err) });
      }
    }, seconds * 1000);
    // Don't keep the process alive solely for this timer.
    if (typeof timer.unref === "function") timer.unref();
    stallWatchdogs.set(sessionId, timer);
  }

  private async runInner(sessionId: string, brief: CrystallisedBrief): Promise<LoopOutcome> {
    const row = this.deps.state.db
      .prepare(`SELECT id, requester, cost_usd, budget_usd, cycles_ran, status FROM sessions WHERE id = ?`)
      .get(sessionId) as
      | { id: string; requester: string; cost_usd: number; budget_usd: number; cycles_ran: number; status: LoopStatus }
      | undefined;
    if (!row) throw new Error(`session ${sessionId} not found`);
    if (["done", "failed", "aborted"].includes(row.status)) {
      throw new Error(`session ${sessionId} is already terminal (${row.status})`);
    }

    const startedAt = Date.now();
    const hardDeadlineMs = startedAt + this.deps.config.loop.session_hard_timeout_seconds * 1000;
    this.deps.state.audit("loop.start", { sessionId, brief }, sessionId);

    // beta.101: plan paths the repo tree says are fictional (see the
    // plan_paths_suspect block below). Consulted at dispatch so each worker is
    // warned only about the paths in its OWN sub-task.
    let planPathSuspects: SuspectPlanPath[] = [];
    // 1. Planning
    this.setStatus(sessionId, "planning");
    await this.deps.reportProgress?.(sessionId, "planning");
    let plan: LeadPlan;
    // beta.63 (Part B): log the lead SDK call boundaries (request/response) into
    // the durable interaction log. A request with no matching response is the
    // exact hang signature the b60 stall left behind.
    const leadStart = Date.now();
    this.deps.interactionLog?.logSdkRequest(sessionId, {
      role: "lead", model: this.deps.config.models.lead, phase: "plan",
      prompt: `title: ${brief.title}\nmotivation: ${brief.motivation}\nacceptanceCriteria:\n${(brief.acceptanceCriteria ?? []).join("\n")}`,
    });
    try {
      // beta.43: bound the lead-planner SDK call by lead_timeout_seconds. The
      // lead await was UNBOUNDED (beta.42 only bounded the worker). A hung
      // planner froze the run with no timeout -- and a healthy long plan was
      // indistinguishable from a wedge, which is exactly what caused the
      // beta.42 smoke misdiagnosis.
      // beta.106: the lead budget must COVER the scout, not be consumed by it.
      //
      // b104 added the scout turn inside runLeadPlanner without touching this
      // bound, so one budget had to fit two turns. With the shipped defaults
      // (lead 900s, scout 600s) that leaves 300s for planning, and planning
      // alone measured 441s and 182s on b103 -- the arithmetic never closed. The
      // b105 smoke (session b08502aa) died at exactly 900s after the scout
      // start, with the lead mid-plan, and the failure was reported against the
      // WORKER timeout because the error text was generic (see WorkerTimeoutError).
      //
      // Adding the scout's own ceiling keeps `lead_timeout_seconds` meaning what
      // its name and docs say -- the time the PLANNER gets -- however the scout
      // knob is set.
      const scoutBudget =
        this.deps.config.loop.lead_repo_scout_enabled !== false
          ? Math.max(0, this.deps.config.loop.lead_scout_timeout_seconds ?? 420)
          : 0;
      plan = await withTimeout(
        this.deps.runLead(brief, {
          requester: row.requester,
          sessionId,
          // beta.105: make the checkout path durable. `preserveLocalBranch` is
          // a REQUEST that falls through silently when no local branch of that
          // name exists, so the flag being set proves nothing about what ran.
          onBranchDecision: (d) => {
            try {
              this.deps.state.audit("loop.branch_allocation", { sessionId, ...d }, sessionId);
            } catch { /* an audit write must never fail an allocation */ }
          },
        }),
        this.deps.config.loop.lead_timeout_seconds + scoutBudget,
        "lead_timeout_seconds",
      );
      this.deps.interactionLog?.logSdkResponse(sessionId, {
        role: "lead", model: this.deps.config.models.lead, phase: "plan",
        finishReason: "end_turn", durationMs: Date.now() - leadStart,
        outputChars: JSON.stringify(plan).length, toolCalls: [],
      });
      // beta.94 (Feature 1a): elide the idle-prone trailing PURE-OBSERVE scope
      // "final verification" sub-task (the b93 seq-12 stall). It has nothing to
      // write, so a worker can go idle on it indefinitely while adding zero
      // signal (every prior mutate sub-task already passed strict per-file
      // contract verification, and runFinalVerifyChecks runs the repo convention
      // scripts + the beta.94 deterministic scope check below). Gated on
      // loop.deterministic_final_scope_check (default true); audited so the
      // elision is visible in the trail. Best-effort; never fatal.
      if (this.deps.config.loop.deterministic_final_scope_check !== false) {
        try {
          const elided = elideFinalScopeSubTask(plan);
          if (elided) {
            this.deps.state.audit(
              "loop.final_verify_subtask_elided",
              { sessionId, seq: elided.seq, title: elided.title },
              sessionId,
            );
            this.deps.logger.info("[loop] beta.94: elided trailing pure-observe scope-verification sub-task (idle-prone, zero signal)", {
              sessionId, seq: elided.seq, title: elided.title,
            });
          }
        } catch (err) {
          this.deps.logger.warn("[loop] beta.94 final-scope sub-task elision failed (non-fatal)", { sessionId, err: String(err) });
        }
      }
      this.deps.state.db
        .prepare(`UPDATE sessions SET lead_plan_json = ?, repo = ?, branch = ?, worktree_path = ? WHERE id = ?`)
        .run(JSON.stringify(plan), plan.repo, plan.branch, plan.worktreePath, sessionId);
      this.deps.state.audit("loop.plan_ready", { sessionId, subTasks: plan.subTasks.length, risk: plan.riskLevel }, sessionId);
      // beta.104: record whether the lead actually SAW the repo before it
      // planned. Emitted on both outcomes -- a smoke report must be able to
      // attribute a plan full of fictional paths to a scout that never ran,
      // which is precisely what b102 could not do for the dispatch hint.
      if (plan.scout) {
        this.deps.state.audit(
          "loop.lead_scout",
          {
            sessionId,
            ran: plan.scout.ran,
            reportChars: plan.scout.reportChars,
            durationMs: plan.scout.durationMs,
            costUsd: plan.scout.costUsd,
            skippedReason: plan.scout.skippedReason,
            error: plan.scout.error,
            // beta.106: a partial report is usable but means the budget is
            // mis-set for this repo, and that must be visible in the trail.
            timedOut: plan.scout.timedOut === true,
            scoutBudgetSeconds: scoutBudget,
            // beta.107: b106's `reportChars: 20049` WAS a truncation, and the
            // smoke report read it as a report that happened to be that long.
            // Say it outright rather than leaving it to arithmetic on a
            // constant nobody has to hand.
            truncated: plan.scout.truncated === true,
            reportCharsRaw: plan.scout.reportCharsRaw,
          },
          sessionId,
        );
      }
      // beta.67 (Bug B): capture the branch FORK-POINT sha ONCE now that the
      // worktree exists. The worktree was branched from origin/<default base>
      // (git-worktree allocateInner), so `git merge-base <base> HEAD` is the
      // stable commit the branch forked from. Persist it so the adversary
      // review diffs `git diff <plan_base_sha>..HEAD` -- ONLY the branch's own
      // commits -- instead of against main-at-review-time, which accumulates
      // unrelated prior-PR/prior-smoke history (beta.66 smoke #4 hallucinated
      // "5 unrelated commits" and false-positive-revised a 1-commit branch).
      // Only capture on the FIRST plan (not a re-plan that already has one) and
      // only when the worktree probe is wired. Never fatal.
      if (this.deps.worktreeMergeBase) {
        try {
          const existing = this.deps.state.db
            .prepare(`SELECT plan_base_sha FROM sessions WHERE id = ?`)
            .get(sessionId) as { plan_base_sha: string | null } | undefined;
          if (!existing?.plan_base_sha) {
            const forkPoint = await this.deps.worktreeMergeBase(plan.worktreePath, this.deps.config.repos.default_base_branch).catch(() => "");
            if (forkPoint) {
              this.deps.state.db.prepare(`UPDATE sessions SET plan_base_sha = ? WHERE id = ?`).run(forkPoint, sessionId);
              this.deps.state.audit("loop.plan_base_sha_captured", { sessionId, planBaseSha: forkPoint, baseBranch: this.deps.config.repos.default_base_branch }, sessionId);
            } else {
              this.deps.logger.warn("[loop] could not resolve plan_base_sha fork-point; adversary will fall back to base-branch diff", { sessionId });
            }
          }
        } catch (err) {
          this.deps.logger.warn("[loop] plan_base_sha capture failed (non-fatal)", { sessionId, err: String(err) });
        }
      }
      // beta.105: LEDGER REACHABILITY AT RESUME. The worktree has just been
      // (re-)allocated, which is the exact operation that loses commits.
      //
      // b103 smoke (session b8ece861): a clarification resume re-planned, the
      // allocation took the reset path instead of preserving the local branch,
      // and eight of this run's ten recorded commits stopped being ancestors of
      // the tip. The b101 guard would have caught it instantly, but it only ran
      // before adversary review -- and this run stalled at a second
      // clarification and was aborted, so it never reached review. The loss was
      // found four hours later by hand.
      //
      // A fresh run has an empty ledger and returns immediately, so this costs
      // one no-op call on the common path and catches the b100 class at the
      // moment it happens on the path that has now produced it twice.
      if (
        this.deps.config.loop.resume_ledger_guard_enabled !== false &&
        this.deps.config.loop.ledger_reachability_guard_enabled !== false
      ) {
        const check = await this.checkLedgerReachability(sessionId, plan.worktreePath, 1, "resume");
        if (check.failed) {
          this.deps.logger.error("[loop] re-allocated worktree has lost commits this session already made; refusing to continue on a truncated branch", {
            sessionId, headSha: check.headSha, unreachable: check.unreachable,
          });
          return this.finaliseFailed(
            sessionId,
            `ledger_commits_unreachable_at_resume: ${check.detail}`,
            1,
            0,
          );
        }
      }
      // beta.63 (convention-awareness Fix 1): now that the repo is checked out
      // at plan.worktreePath, ingest its declared convention files into the
      // brief so the worker + adversary SDK prompts (no OpenClaw context
      // injection) explicitly carry them. Only on cycle-1 build; idempotent
      // (re-ingest overwrites). Never fatal.
      if (this.deps.config.brief?.ingest_repo_conventions !== false && !brief.repoConventions) {
        try {
          const conventions = ingestRepoConventions(plan.worktreePath, this.deps.config.brief?.convention_char_budget ?? 10000);
          brief.repoConventions = conventions;
          this.deps.state.audit("loop.repo_conventions_ingested", { sessionId, count: conventions.length, sources: conventions.map((c) => c.source) }, sessionId);
          this.deps.interactionLog?.log(sessionId, { event: "repo_conventions_ingested", phase: "plan", count: conventions.length, sources: conventions.map((c) => c.source) });
        } catch (err) {
          this.deps.logger.warn("[loop] repo convention ingest failed (non-fatal)", { sessionId, err: String(err) });
        }
      }
      // beta.101: flag plan paths that name a file in a directory the repo does
      // not have. The b100 smoke's entire failure cascade -- a failed verify, a
      // clarification round-trip, a re-plan and a wasted review turn -- traces
      // back to the lead inventing `src/components/layout/grc-nav.tsx` when
      // `src/components/layout/` does not exist. The worker found the real
      // sidebar and edited it correctly; only the CONTRACT was fictional.
      // Advisory by design (see plan-path-validate.ts): new modules legitimately
      // create new directories, so this informs the worker, never blocks.
      if (this.deps.config.loop.plan_path_validation_enabled !== false && this.deps.listRepoFiles) {
        try {
          const repoFiles = await this.deps.listRepoFiles(plan.worktreePath);
          const planPaths = plan.subTasks.flatMap((s) => s.filesLikelyTouched ?? []);
          const suspects = findSuspectPlanPaths(planPaths, repoFiles);
          if (suspects.length > 0) {
            planPathSuspects = suspects;
            this.deps.state.audit(
              "loop.plan_paths_suspect",
              { sessionId, count: suspects.length, suspects: suspects.map((s) => ({ path: s.path, missingDir: s.missingDir })), repoFileCount: repoFiles.length },
              sessionId,
            );
            this.deps.interactionLog?.log(sessionId, {
              event: "plan_paths_suspect", phase: "plan", count: suspects.length, paths: suspects.map((s) => s.path),
            });
            this.deps.logger.warn("[loop] plan names path(s) in directories that do not exist; workers will be told to treat them as guesses", {
              sessionId, suspects: suspects.map((s) => `${s.path} (no ${s.missingDir}/)`),
            });
          }
        } catch (err) {
          this.deps.logger.warn("[loop] plan path validation failed (non-fatal)", { sessionId, err: String(err) });
        }
      }
    } catch (err) {
      if (err instanceof WorkerTimeoutError) {
        this.deps.state.audit("loop.lead_timeout", { sessionId, lead_timeout_seconds: this.deps.config.loop.lead_timeout_seconds }, sessionId);
      }
      this.deps.interactionLog?.logSdkResponse(sessionId, {
        role: "lead", model: this.deps.config.models.lead, phase: "plan",
        finishReason: err instanceof WorkerTimeoutError ? "timeout" : "error", durationMs: Date.now() - leadStart,
      });
      this.deps.interactionLog?.log(sessionId, { event: "plan_failed", phase: "plan", error: String(err) });
      this.deps.state.audit("loop.plan_failed", { sessionId, err: String(err) }, sessionId);
      return this.finaliseFailed(sessionId, `plan_failed: ${String(err)}`, 0, row.cost_usd);
    }

    let cycle = 0;
    let totalCost = row.cost_usd;
    let lastReview: ReviewReport | undefined;
    // beta.97 (Fix #7): per-cycle adversary finding counts, in cycle order, so
    // the max-cycles terminal path can distinguish CONVERGING (findings
    // trending down -> a clean pass is plausibly one more cycle away, so SURFACE
    // an ask-to-extend) from DIVERGING/stuck (findings flat or rising -> the
    // plain do_not_merge ship is correct). Root: the b96 smoke shipped #893
    // do_not_merge on a 13 -> 8 -> 12 arc; 13 -> 8 was real convergence the
    // operator was never told about.
    const findingCountsByCycle: number[] = [];
    // beta.97 (Fix #7): the reason the loop left the review cycle for a terminal
    // "done", so the ship path can surface the converging ask-to-extend note.
    let terminalDoneReason = "";
    // beta.7 fix #2: running record of actual sub-task costs, used to project
    // the cost of upcoming sub-tasks for pre-execution budget gating.
    const subTaskCosts: number[] = [];
    // beta.78 (Feature 2): the SESSION budget is now a SOFT limit -- crossing
    // it WARNS (once) and the run continues. The true HARD stop is the
    // per-user daily_max_usd. This flag de-dupes the one-time soft warning so
    // we don't spam a warning on every sub-task once over the session budget.
    let sessionBudgetWarned = false;

    // beta.76 (Option 1 -- contract re-derivation): the set of REAL file paths
    // the run's workers have actually touched/committed so far. This is GROUND
    // TRUTH for the repo's real directory conventions (discovered by the
    // observe probe + every mutate that lands a file), and is used to correct a
    // downstream sub-task's STALE, lead-guessed contract path BEFORE it is
    // verified -- killing the path-drift class at the source instead of adding
    // one more tolerant match rule. Accumulated across sub-tasks within the run.
    const discoveredRealPaths = new Set<string>();

    // 2. Execute/review cycles
    while (cycle < this.deps.config.loop.max_cycles) {
      cycle += 1;
      this.deps.state.db.prepare(`UPDATE sessions SET cycles_ran = ? WHERE id = ?`).run(cycle, sessionId);
      this.checkpoint(sessionId, cycle);

      // 2a. Executing sub-tasks in dependency order, with bounded concurrency.
      this.setStatus(sessionId, "executing");
      await this.deps.reportProgress?.(sessionId, "executing", { cycle });
      const executeStart = Date.now();
      // beta.108: branch tip before this cycle's workers run, so a cycle that
      // changed nothing can be recognised as such. See the early-exit below.
      const cycleBaseSha = this.deps.worktreeHeadSha
        ? await this.deps.worktreeHeadSha(plan.worktreePath).catch(() => "")
        : "";

      // beta.92: DETERMINISTIC finding -> sub-task mapping REPLACES the deleted
      // LLM revise-spec turn (beta.67). The revise-spec turn kept exceeding its
      // lane-cap timeout (b73 signature) across THREE smokes (b89/b90/b91) and
      // falling back to a raw 10-finding dump handed to every sub-task, which
      // starved F1 scoping and induced worker confabulation. We now map each
      // diff-addressable finding (spec|quality|security, `.file` required) onto
      // the sub-task(s) that own its file via the SAME strict resolveContractPath
      // machinery b87/b88 use, broadcast meta (fit|runtime) findings to all, and
      // attach any mapping-miss to all (never dropped). No LLM turn => no
      // timeout => no raw-dump => no confab. `reviseSpecApplied` now means
      // "deterministic per-sub-task targeting is available"; downstream
      // consumers (per-sub-task contract relaxation, observe-reprobe skip, raw-
      // hint suppression) read the SAME flag, now driven by deterministic data.
      let reviseSpecApplied = false;
      let reviseMapping: ReviseMappingResult | undefined;
      const reviseAssignmentBySeq = new Map<number, SubTaskAssignment>();
      if (
        cycle > 1 &&
        lastReview?.findings &&
        this.deps.config.loop.deterministic_revise_mapping !== false
      ) {
        const mapSubTasks: MapSubTask[] = plan.subTasks.map((s) => ({
          seq: s.seq,
          filesLikelyTouched: s.filesLikelyTouched,
          contextPaths: (s.workerContext?.codeExcerpts ?? []).map((e) => e.path),
        }));
        reviseMapping = mapFindingsToSubTasks(
          mapSubTasks,
          lastReview.findings as MapFinding[],
          (owned, candidate) => resolveContractPath(owned, candidate, { strictContract: true }),
          {
            adoptOrphans: this.deps.config.loop.revise_adopt_orphan_findings !== false,
            maxAdoptionsPerCycle: this.deps.config.loop.revise_max_adoptions_per_cycle ?? 3,
          },
        );
        for (const a of reviseMapping.assignments) reviseAssignmentBySeq.set(a.seq, a);
        reviseSpecApplied = reviseMapping.anyTargeted;
        this.deps.state.audit(
          "loop.revise_mapping",
          {
            sessionId, cycle,
            subTasks: plan.subTasks.length,
            targetedSubTasks: reviseMapping.assignments.filter((a) => a.targeted.length > 0).length,
            metaBroadcast: reviseMapping.metaBroadcast.length,
            mappingMisses: reviseMapping.mappingMisses.length,
          },
          sessionId,
        );
        this.deps.interactionLog?.log(sessionId, {
          event: "revise_mapping", phase: "plan", cycle,
          targetedSubTasks: reviseMapping.assignments.filter((a) => a.targeted.length > 0).length,
        });
        // Charter guardrail: a filed diff-addressable finding that matched NO
        // sub-task is a MAPPING MISS -- it is attached to every sub-task as
        // context (never dropped, never run-all), and surfaced so we can see it.
        const adoptedBySeq = new Map(
          reviseMapping.orphanAdoptions.map((a) => [a.finding, a] as const),
        );
        const refusedFor = new Map(
          reviseMapping.orphanRefusals.map((r) => [r.finding, r] as const),
        );
        for (const miss of reviseMapping.mappingMisses) {
          const adopted = adoptedBySeq.get(miss);
          const refused = refusedFor.get(miss);
          this.deps.state.audit(
            "loop.finding_mapping_miss",
            {
              sessionId, cycle, dimension: miss.dimension, severity: miss.severity,
              file: (miss.file ?? "").trim() || null, title: miss.title,
              // beta.107: a miss that found an owner is a different animal from
              // one that stayed unactionable. b106 could not tell them apart,
              // because before b107 there was only the one kind.
              adoptedBySeq: adopted?.seq ?? null,
              adoptionReason: adopted?.reason ?? null,
              // beta.118: and "nobody could claim it" is different again from
              // "several could, equally". Only the latter is worth a router fix.
              refusedReason: refused?.reason ?? null,
              refusedSeqs: refused?.seqs ?? null,
            },
            sessionId,
          );
        }
        for (const ad of reviseMapping.orphanAdoptions) {
          this.deps.state.audit(
            "loop.orphan_finding_adopted",
            { sessionId, cycle, seq: ad.seq, file: ad.file, reason: ad.reason, score: ad.score, title: ad.finding.title },
            sessionId,
          );
        }
        if (reviseMapping.orphanAdoptions.length > 0) {
          // Put the adopted file into the sub-task's SCOPE as well. b91 scoping
          // (which runs just below) keeps a sub-task only when its
          // `filesLikelyTouched` intersects a finding file, so without this the
          // adopting sub-task can still be skipped -- and the one worker asked
          // to fix the finding never runs. `filesLikelyTouched` is a scope hint,
          // not a contract, and b103's path writeback already rewrites it.
          for (const ad of reviseMapping.orphanAdoptions) {
            const st = plan.subTasks.find((s) => s.seq === ad.seq);
            if (!st) continue;
            st.filesLikelyTouched = [...(st.filesLikelyTouched ?? [])];
            if (!st.filesLikelyTouched.includes(ad.file)) st.filesLikelyTouched.push(ad.file);
          }
          this.deps.logger.info(
            "[loop] beta.107: orphan finding(s) adopted by the nearest sub-task -- now targeted, not just broadcast",
            { sessionId, cycle, adopted: reviseMapping.orphanAdoptions.length },
          );
        }
        if (reviseMapping.mappingMisses.length > 0) {
          this.deps.logger.info(
            "[loop] revise-mapping: filed finding(s) matched no sub-task -> broadcast to all as context (never dropped)",
            { sessionId, cycle, misses: reviseMapping.mappingMisses.length },
          );
        }
      }

      const ordered = topoSortSubTasks(plan.subTasks);

      // beta.91 (Fix 1): revise-cycle scoping. On cycle > 1, skip sub-tasks whose
      // file scope does not intersect any finding -- they are already-correct
      // from a prior cycle (the DR/BCP smoke re-ran 8 of 12 no-change sub-tasks).
      // Conservative: any unfiled finding => run everything; never skip a dep of
      // a kept sub-task. Feature-gated (default on). Cycle 1 is never scoped.
      const reviseScopeSkip = new Set<number>();
      if (cycle > 1 && this.deps.config.loop.revise_scoping_enabled !== false && lastReview?.findings) {
        const scope = computeReviseScope(plan.subTasks, lastReview.findings, cycle);
        if (scope.scoped) {
          for (const s of scope.skipSeqs) reviseScopeSkip.add(s);
          this.deps.state.audit(
            "loop.revise_scoped",
            { sessionId, cycle, run: scope.runSeqs.length, skipped: scope.skipSeqs.length, skipSeqs: scope.skipSeqs, findingFiles: scope.findingFiles },
            sessionId,
          );
          this.deps.logger.info(
            "[loop] revise-scoping: skipping sub-tasks not targeted by any finding (already correct from a prior cycle)",
            { sessionId, cycle, run: scope.runSeqs.length, skipped: scope.skipSeqs.length },
          );
          this.deps.interactionLog?.log(sessionId, { event: "revise_scoped", phase: "plan", cycle, run: scope.runSeqs.length, skipped: scope.skipSeqs.length });
        } else {
          // beta.91 NIT-6: count unfiled findings so we can measure over time
          // whether the adversary `.file`-required fix is populating file paths
          // (an unscopable cycle with a high unfiled count = the prompt fix not
          // landing; a low count = genuinely file-less meta findings).
          const unfiledFindingCount = (lastReview.findings ?? []).filter((f) => !((f.file ?? "") as string).trim()).length;
          this.deps.state.audit(
            "loop.revise_scope_skipped",
            { sessionId, cycle, reason: scope.reason, findingCount: (lastReview.findings ?? []).length, unfiledFindingCount },
            sessionId,
          );
        }
      }

      // beta.91 (Fix 2): effective concurrency. Serial (1) unless the feature is
      // on AND subtask_concurrency > 1. The dispatcher additionally enforces a
      // file-overlap guard (canDispatchConcurrently) below.
      const concurrency = resolveEffectiveConcurrency({
        subtaskConcurrency: this.deps.config.loop.subtask_concurrency ?? 1,
        parallelEnabled: this.deps.config.loop.parallel_independent_subtasks === true,
      });
      const inFlight: Array<Promise<void>> = [];
      const inFlightSubTasks = new Map<Promise<void>, LeadPlanSubTask>();
      const done = new Set<number>();
      const failed = { seq: -1, err: null as unknown };

      /**
       * beta.117: isolated checkouts for concurrent workers.
       *
       * Built only when concurrency > 1 AND the adapter can actually create
       * slots. Everything below tolerates a null pool by running serially, so a
       * stubbed orchestrator or a repo the adapter cannot pool degrades to
       * pre-b117 behaviour instead of failing.
       *
       * Sized to `concurrency`, not `concurrency - 1`. Letting one worker keep
       * using the session worktree looks like a free slot and is not: that
       * checkout is the MERGE TARGET, and a merge into a tree another worker is
       * actively editing either aborts on a dirty tree or mixes that worker's
       * uncommitted edits into someone else's merge. Once parallel, the session
       * worktree is an integration checkout only, and every worker gets a slot.
       *
       * Slots are created lazily, so a cycle whose sub-tasks never actually
       * overlap still pays for just one.
       */
      const canPool =
        concurrency > 1 &&
        !!this.deps.allocatePooledWorktree &&
        !!this.deps.resetPooledWorktree &&
        !!this.deps.gitRun &&
        !!plan.branch;
      const pool: WorktreePool | null = canPool
        ? new WorktreePool({
            size: concurrency,
            sessionBranch: plan.branch,
            deps: {
              create: async (slot, slotBranch) =>
                this.deps.allocatePooledWorktree!({
                  sessionId, repoFullName: plan.repo, sessionBranch: plan.branch, slotBranch, slot,
                }),
              reset: async (wt, sha) => this.deps.resetPooledWorktree!(wt.path, sha),
              destroy: async (wt) => {
                await this.deps.releasePooledWorktree?.({
                  repoFullName: plan.repo, worktreePath: wt.path, slotBranch: wt.branch,
                });
              },
              logger: this.deps.logger,
            },
          })
        : null;
      if (pool) {
        this.deps.state.audit("loop.parallel_enabled", { sessionId, cycle, concurrency, poolSize: concurrency }, sessionId);
      }
      // beta.55 (B2): when set, the loop pauses in `awaiting_clarification`
      // instead of hard-failing. Carries the ONE question to surface + the
      // paused seq. Checked BEFORE finaliseFailed so the worktree is preserved.
      const clarify = { question: null as string | null, seq: -1, subtask: null as { title: string; intent: string } | null };

      const runOneInner = async (st: LeadPlanSubTask, workerWorktree: string): Promise<void> => {
        // beta.91 (Fix 1): revise-scoping skip. This sub-task's files don't
        // intersect any finding -> its prior-cycle commit is already correct and
        // part of the branch. Mark completed_no_change without a worker turn.
        if (reviseScopeSkip.has(st.seq)) {
          this.deps.state.db
            .prepare(`UPDATE sub_tasks SET status = 'completed_no_change', summary = ?, updated_at = ? WHERE session_id = ? AND cycle = ? AND seq = ?`)
            .run("revise-scoped: not targeted by any review finding (unchanged from prior cycle)", Date.now(), sessionId, cycle, st.seq);
          this.deps.state.audit("loop.subtask_revise_scoped_skip", { sessionId, cycle, seq: st.seq }, sessionId);
          this.deps.interactionLog?.log(sessionId, { event: "subtask_revise_scoped_skip", phase: "worker", seq: st.seq, cycle });
          done.add(st.seq);
          return;
        }
        // beta.53 (P1b): at most ONE env-wait retry per sub-task.
        let envWaitRetried = false;
        // beta.56 (P0-1): on a revise cycle, the worker MUST see the previous
        // review's findings or it will simply replay cycle 1's work.
        // beta.92: the deterministic mapping now produces a PER-SUB-TASK scoped
        // hint (only THIS sub-task's targeted findings + cross-cutting broadcast
        // guidance) -- never the full untargeted 10-finding dump that overwhelmed
        // workers and induced confabs (b91). Fall back to the beta.56 whole-
        // review raw hint only if mapping was unavailable/disabled.
        const reviseAssignment = reviseAssignmentBySeq.get(st.seq);
        const baseReviseHint =
          cycle > 1 && lastReview
            ? reviseAssignment
              ? buildScopedReviseHint(lastReview.verdict, lastReview.summary, reviseAssignment)
              : buildReviseDispatchHint(lastReview)
            : undefined;
        // beta.101: warn this worker about ITS OWN fictional plan paths only,
        // so the note stays short and unambiguous rather than a plan-wide dump.
        const mine = new Set((st.filesLikelyTouched ?? []).map((p) => p.trim().replace(/^\.\//, "")));
        const mySuspects = planPathSuspects.filter((s) => mine.has(s.path));
        const reviseHint = mySuspects.length
          ? `${baseReviseHint ? `${baseReviseHint}\n\n` : ""}${describeSuspectPlanPaths(mySuspects)}`
          : baseReviseHint;
        // beta.103: attaching a hint emitted NO audit event, so "did the worker
        // actually get told?" was unanswerable after the fact. The b102 smoke
        // report concluded the b101 plan-path warning was observability-only
        // and never reached a worker -- an unsound inference, but one the audit
        // trail gave no way to refute. Record the attachment itself.
        if (reviseHint) {
          this.deps.state.audit(
            "loop.dispatch_hint_attached",
            {
              sessionId, seq: st.seq, cycle,
              chars: reviseHint.length,
              sources: [
                ...(baseReviseHint ? ["revise"] : []),
                ...(mySuspects.length ? ["plan_path_suspect"] : []),
              ],
              suspectPaths: mySuspects.map((s) => s.path),
            },
            sessionId,
          );
        }
        // beta.70 (F5): skip observe-only RE-PROBE on a revise cycle. In
        // PR #870 the cycle-2 plan re-listed seq-1 as taskMode:'observe'
        // ("already completed and requires no changes; do not modify any
        // files") yet the loop re-ran it -- 58s + $0.29 to re-emit the same
        // probe report. On a revise cycle (cycle > 1), when THIS observe
        // sub-task already completed cleanly in a PRIOR cycle, mark it done and
        // skip the SDK call. Guard is conservative on THREE axes:
        //   (1) observe-only (never a mutate);
        //   (2) the prior-cycle row for this seq is a completed/no-change observe;
        //   (3) reviseSpecApplied -- the Fable revise-spec turn ran and
        //       re-listed this observe as an unchanged probe. We ONLY skip in
        //       that case, because without a revise-spec the observe sub-task is
        //       carrying the raw revise hint and IS meant to re-run (an observe
        //       step can apply a fix and the beta.56 hint targets it). This
        //       matches PR #870 exactly (it had a revise-spec) without breaking
        //       the raw-findings fallback path.
        // Config-gated (default on).
        if (
          cycle > 1 &&
          st.taskMode === "observe" &&
          reviseSpecApplied &&
          this.deps.config.loop.skip_observe_reprobe_on_revise !== false
        ) {
          const prior = this.priorObserveCompleted(sessionId, cycle, st.seq);
          if (prior) {
            this.deps.state.audit(
              "loop.observe_reprobe_skipped",
              { sessionId, cycle, seq: st.seq, priorCycle: prior.cycle, priorStatus: prior.status },
              sessionId,
            );
            this.deps.interactionLog?.log(sessionId, { event: "observe_reprobe_skipped", phase: "worker", seq: st.seq, cycle });
            done.add(st.seq);
            return;
          }
        }
        const reactions = await this.deps.readReactions(sessionId);
        if (reactions.abort) { failed.err = "user_abort_reaction"; failed.seq = st.seq; return; }
        if (Date.now() > hardDeadlineMs) { failed.err = "hard_timeout"; failed.seq = st.seq; return; }
        // beta.78 (Feature 2): the SESSION budget is now SOFT. Crossing it
        // WARNS once and the run CONTINUES (was a hard abort). The true HARD
        // stop is the per-user daily_max_usd, checked below. This matches
        // Carel's spec: "When hitting the budget limit, the harness should
        // warn, but not stop, unless it crosses the max daily for the user."
        if (totalCost > row.budget_usd && !sessionBudgetWarned) {
          sessionBudgetWarned = true;
          this.deps.state.audit(
            "loop.session_budget_warn",
            { sessionId, seq: st.seq, totalCost, sessionBudget: row.budget_usd },
            sessionId,
          );
          // Surface a daily-aware Slack warning (Feature 1 + 2 fused).
          this.warnSessionBudgetSoft(sessionId, row.requester, totalCost, row.budget_usd);
        }
        // beta.78 (Feature 2): HARD daily stop. Aborts when the user's total
        // spend TODAY (persistent budgets_daily ledger + the next sub-task's
        // estimate + the beta.61 review/push reserve) would cross daily_max.
        // budgets_daily already includes this session's recorded spend, so we
        // must NOT add totalCost again (avoid double-count). budgetBump lets a
        // user blow past caps deliberately (:moneybag: reaction).
        {
          const subEst = this.estimateSubTaskCost(st, subTaskCosts);
          const dailyMax = this.dailyMaxUsd();
          if (!reactions.budgetBump && dailyMax > 0) {
            const dailySoFar = this.safeDailySpend(row.requester);
            // beta.61 reserve: keep headroom for the pending adversary review +
            // push so a daily-cap abort doesn't strand committed work one
            // review short of a PR. Reserve is a fraction of the SESSION budget
            // (covers the same review/push tail as before).
            const reserveRatio = this.deps.config.loop.budget_reserve_ratio ?? 0.15;
            const reserve = row.budget_usd * Math.max(0, Math.min(0.9, reserveRatio));
            const dailyProjected = dailySoFar + subEst;
            if (dailyProjected + reserve > dailyMax) {
              this.deps.state.audit(
                "loop.daily_max_abort",
                { sessionId, seq: st.seq, user: row.requester, dailySoFar, subEst, reserve, dailyMax },
                sessionId,
              );
              this.warnDailyMaxHit(sessionId, row.requester, dailySoFar, dailyMax);
              failed.err = "daily_max_exhausted"; failed.seq = st.seq; return;
            }
          }
        }

        const subTaskId = `${sessionId}-c${cycle}-s${st.seq}`;
        // beta.19 fix: populate `started_at` on insert. The schema has
        // had this column since inception but nothing wrote to it, so
        // every sub_task row had `started_at IS NULL`. Now set it to the
        // same instant as `created_at` — for restart / recovery paths
        // (INSERT OR REPLACE) this deliberately overwrites any earlier
        // start time, which matches the previous cycle semantics (a
        // re-executed sub-task started NOW, not when it was first
        // scheduled).
        {
          const now = Date.now();
          this.deps.state.db.prepare(
            `INSERT OR REPLACE INTO sub_tasks (id, session_id, cycle, seq, description, worker_model, status, cost_usd, started_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'running', 0, ?, ?, ?)`,
          ).run(subTaskId, sessionId, cycle, st.seq, st.title, this.deps.config.models.worker, now, now, now);
        }
        // beta.63 (Part A): mark forward progress at sub-task START so a long
        // executing phase (many sub-tasks) reads as live to the watchdog.
        this.markProgress(sessionId, "subtask_start", "worker", { seq: st.seq, cycle, title: String(st.title).slice(0, 120) });

        // Capture the worktree HEAD BEFORE the worker runs, so commit_made
        // verification (HEAD != base) is meaningful.
        const subTaskBaseSha = this.deps.worktreeHeadSha ? await this.deps.worktreeHeadSha(workerWorktree).catch(() => "") : "";
        // beta.85: the BRANCH fork-point (plan_base_sha, persisted at plan time)
        // -- the base for "committed anywhere in this branch" used by the
        // revise-relaxed acceptance. Falls back to subTaskBaseSha when unset.
        const planBaseShaForVerify = ((): string => {
          try {
            const r = this.deps.state.db
              .prepare(`SELECT plan_base_sha FROM sessions WHERE id = ?`)
              .get(sessionId) as { plan_base_sha: string | null } | undefined;
            return r?.plan_base_sha || subTaskBaseSha;
          } catch {
            return subTaskBaseSha;
          }
        })();
        // beta.57 (P1): capture the sub-task start time so file_written can
        // reject a file that merely pre-existed (mtime/diff freshness check).
        // Previously hard-coded to 0, which disabled the freshness check and
        // let a stale file vacuously satisfy the contract.
        const subTaskStartedAtMs = Date.now();

        let result: WorkerResult;
        // beta.63 (Part B): worker SDK call boundary logging. seq + cycle carried
        // so a stall's sdk_request-without-sdk_response points at the exact
        // sub-task that hung.
        const workerStart = Date.now();
        this.deps.interactionLog?.logSdkRequest(sessionId, {
          role: "worker", model: this.deps.config.models.worker, phase: "worker", seq: st.seq, cycle,
          prompt: `subtask ${st.seq}: ${st.title}\nintent: ${st.intent ?? ""}\n${reviseHint ?? ""}`,
        });
        // beta.64 (P0-2): the worker call is now wrapped so a first_token_timeout
        // (returned by the inner watchdog) OR a worker timeout (thrown by the
        // outer withTimeout) is RETRIED ONCE on a fresh SDK session before we
        // flip the run terminal. beta.63's watchdogs were blind to a hang INSIDE
        // a single worker turn; beta.63 smoke #2's verify sub-task streamed zero
        // tokens and sat the full 1800s. runWorkerCallWithRetry emits the P0-1
        // sdk_stream_opened/sdk_first_token events + owns the retry.
        const call = await this.runWorkerCallWithRetry({
          workerWorktree,
          sessionId, st, cycle, brief, plan, requester: row.requester,
          dispatchHint: reviseHint, workerStart, subTaskId,
        });
        if (call.outcome === "timeout") {
          // beta.64 (P0-2): retry (if any) is exhausted and the worker still
          // timed out with no usable result. For an observe-mode VERIFY sub-task
          // we do NOT hard-fail: attempt P0-4 (scripted verifier fallback), then
          // P0-3 (best-effort verify => graceful reviewable PR). Only if BOTH
          // decline do we fall through to terminal.
          const isVerifySubTask = st.taskMode === "observe";
          if (isVerifySubTask) {
            const scripted = await this.tryScriptedVerifyFallback(sessionId, plan, st, cycle, subTaskBaseSha);
            if (scripted === "pass") {
              this.deps.state.db.prepare(
                `UPDATE sub_tasks SET status = 'completed_no_change', summary = ?, updated_at = ? WHERE id = ?`,
              ).run(`scripted verifier fallback PASS (LLM verify sub-task timed out)`, Date.now(), subTaskId);
              done.add(st.seq);
              return;
            }
            if (scripted !== "fail") {
              // scripted fallback disabled or unrunnable -> try best-effort verify.
              const shipped = await this.tryBestEffortVerify(sessionId, plan, brief, st, cycle, totalCost, row.requester, subTaskBaseSha);
              if (shipped) { failed.err = "__best_effort_shipped__"; failed.seq = st.seq; return; }
            }
          }
          this.deps.state.db.prepare(
            `UPDATE sub_tasks SET status = 'failed', summary = ?, updated_at = ? WHERE id = ?`,
          ).run(call.summary, Date.now(), subTaskId);
          failed.err = call.failErr;
          failed.seq = st.seq;
          return;
        }
        result = call.result;

        totalCost += result.costUsd;
        if (result.costUsd > 0) subTaskCosts.push(result.costUsd);
        this.addCost(sessionId, result.costUsd);
        await this.deps.budget.recordSpend(row.requester, result.costUsd, sessionId);
        this.deps.state.db.prepare(
          `UPDATE sub_tasks
           SET status = ?, cost_usd = ?, files_touched = ?, commit_sha = ?, sdk_session_id = ?, summary = ?, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          result.status,
          result.costUsd,
          JSON.stringify(result.filesChanged),
          result.commitSha ?? null,
          result.sdkSessionId ?? null,
          result.reason ?? null,
          Date.now(),
          Date.now(),
          subTaskId,
        );
        this.checkpoint(sessionId, cycle, subTaskId, result.sdkSessionId);

        // beta.48 (C1): always emit the worker's final message as a
        // breadcrumb, on EVERY sub-task (not just failures). This eliminates
        // the "opaque worker turn" blind spot (session dca2f3b5) where a
        // zero-side-effect end_turn was indistinguishable from a crash in the
        // harness log. Truncated; empty string when the worker produced only
        // tool calls and no concluding text.
        {
          const fm = (result.finalMessage ?? "").trim();
          this.deps.state.audit(
            "loop.worker_end_turn",
            {
              sessionId,
              seq: st.seq,
              cycle,
              status: result.status,
              commitSha: result.commitSha ?? null,
              // beta.103: every commit tip this turn produced. `commitSha` is a
              // single value and `sub_tasks.commit_sha` a single column, so a
              // turn where the worker committed its own work AND the harness
              // committed the remainder recorded only the harness commit -- the
              // worker's own commit entered no ledger at all and so could never
              // be reachability-checked. This array is what the guard reads.
              commitShas: result.commitShas ?? (result.commitSha ? [result.commitSha] : []),
              filesTouched: result.filesChanged,
              hasFinalMessage: fm.length > 0,
              finalMessage: fm.slice(0, 4000),
            },
            sessionId,
          );
          // beta.85: PER-SUB-TASK native progress. Pre-beta.85, native
          // deliverProgress fired ONLY from setStatus = phase transitions
          // (planning/executing/reviewing/done), so a long `executing` phase
          // with N sequential sub-tasks went SILENT between phase changes
          // (session 696226e4: 16 min, 4 sub-tasks, zero in-thread updates --
          // exactly what makes a team think it's hung). buildProgressSnapshot's
          // headline is already sub-task-granular ("Executing sub-task N/M --
          // title"), so firing deliverProgress on each worker_end_turn emits a
          // per-sub-task headline directly from the harness, with NO dependency
          // on the poll relay / a wake cron (both of which broke on 696226e4).
          // Best-effort + throw-guarded (same contract as the setStatus fire);
          // a no-op for agent-orchestrated runs (no real Slack binding).
          try {
            this.deps.deliverProgress?.(sessionId, "executing");
          } catch { /* best-effort: a progress post must never fail the run */ }
        }

        // If the worker itself failed/timed out, halt now.
        if (result.status !== "completed") {
          failed.err = `subtask_${st.seq}_${result.status}: ${result.reason ?? "no reason"}`;
          failed.seq = st.seq;
          return;
        }

        // beta.76 (Option 1): record the REAL paths this sub-task touched into
        // the run-level ground-truth set. These correct downstream (and this
        // sub-task's own) stale contract paths via rederiveContractPath. Both
        // committed and uncommitted-but-written files count as evidence of the
        // repo's real layout.
        for (const f of [...(result.filesChanged ?? []), ...(result.uncommittedFiles ?? [])]) {
          if (typeof f === "string" && f.trim()) discoveredRealPaths.add(f.trim());
        }

        // ---- beta.8 fix #1: HARNESS-SIDE verification ----
        // Regardless of the worker's `end_turn: completed`, the harness
        // independently verifies any observable side-effect the sub-task
        // CLAIMS (inferred from its own language, not from the model). This
        // is what catches a confabulated "I pushed / I opened a PR": we hit
        // git / the provider API ourselves. Runs even for `completed`.
        // beta.67 (Bug C): compute the EFFECTIVE task-mode for THIS pass. On a
        // revise cycle (cycle > 1) a plan-time `mutate` sub-task that correctly
        // makes NO change (the worker made no commit) is a legal no-op -- the
        // beta.66 loop.subtask_revise_no_change handler already recognises this
        // AFTER a verify failure, but the verifier still built the contract off
        // the plan-time `mutate` and hard-failed commit_made/file_committed
        // because HEAD didn't move. Demote the mode up-front so those kinds are
        // never included in the contract this pass -> the no-op verifies as a
        // PASS instead of a false-fail. A real cycle-1 mutate (or a revise pass
        // that DID commit) keeps effectiveTaskMode === taskMode, so it still
        // requires commit_made.
        const effectiveTaskMode =
          cycle > 1 && st.taskMode === "mutate" && !result.commitSha ? "observe" : st.taskMode;
        if (effectiveTaskMode !== st.taskMode) {
          this.deps.state.audit(
            "loop.subtask_revise_no_change",
            { sessionId, seq: st.seq, cycle, taskMode: st.taskMode ?? "unspecified", effectiveTaskMode: "observe", trigger: "contract_selection" },
            sessionId,
          );
          this.deps.interactionLog?.log(sessionId, { event: "subtask_revise_no_change", phase: "worker", seq: st.seq, cycle, effectiveTaskMode: "observe" });
        }
        const rawContract = inferVerifyContract(st, effectiveTaskMode);
        // beta.76 (Option 1): RE-DERIVE each path-bearing contract kind against
        // the real paths this run has already touched, so a stale lead-guessed
        // directory prefix (e.g. `tests/api/grc` when the repo really uses
        // `src/__tests__/api/grc`) is corrected BEFORE verification -- the
        // structural cure for the drift class. No-op when no evidence-backed
        // remap applies (returns the path unchanged), so this never makes
        // verification stricter. Skips file_in_pr (repo-wide, not scoped).
        const rederiveEnabled = this.deps.config.loop.contract_rederive_enabled !== false;
        // beta.103: every evidence-backed correction made below is also folded
        // back into st.filesLikelyTouched after the contract is built, so a
        // later revise cycle scopes against the real path instead of the
        // lead's fiction. See plan-path-writeback.ts for the b102 failure.
        const pathCorrections: PathCorrection[] = [];
        const contract: SubTaskVerify[] = rawContract.map((v) => {
          if (!rederiveEnabled) return v;
          if (!("path" in v) || !v.path || v.kind === "file_in_pr") return v;
          const rd = rederiveContractPath(v.path, [...discoveredRealPaths]);
          if (!rd.remapped) return v;
          pathCorrections.push({ from: v.path, to: rd.path });
          this.deps.state.audit(
            "loop.contract_path_rederived",
            { sessionId, seq: st.seq, cycle, kind: v.kind, from: v.path, to: rd.path, via: rd.via },
            sessionId,
          );
          this.deps.interactionLog?.log(sessionId, {
            event: "contract_path_rederived", phase: "worker", seq: st.seq, cycle,
            kind: v.kind, from: v.path, to: rd.path,
          });
          return { ...v, path: rd.path };
        });
        // beta.100: BOUNDED TEST-CONTRACT RECONCILIATION. The b76 prefix-remap
        // above only fires when the stale and real directories share a trailing
        // chain, so it cannot correct a test path that drifted on BOTH the
        // directory and the basename (b99 seq 3: contract
        // `.../continuity-exercises/route.test.ts` vs committed
        // `src/__tests__/api/grc/continuity-exercises-api.test.ts` -- no shared
        // dir suffix, so no remap was learned and a correct commit died on the
        // strict file_committed check). Reconcile that shape here, against THIS
        // sub-task's own touched files, under a 1:1 no-ambiguity constraint.
        // Scope matters: we pass the PER-SUB-TASK set, never discoveredRealPaths
        // (run-wide), which is what makes a lone unclaimed test file provably
        // this sub-task's. See contract-rederive.ts for the full argument.
        if (this.deps.config.loop.contract_test_path_reconcile !== false) {
          const subTaskTouched = [...(result.filesChanged ?? []), ...(result.uncommittedFiles ?? [])]
            .map((f) => (typeof f === "string" ? f.trim() : ""))
            .filter(Boolean);
          const pathEntryIdx: number[] = [];
          const pathEntryPaths: string[] = [];
          for (let i = 0; i < contract.length; i++) {
            const v = contract[i]!;
            if ((v.kind === "file_written" || v.kind === "file_committed") && v.path) {
              pathEntryIdx.push(i);
              pathEntryPaths.push(v.path);
            }
          }
          for (const rc of reconcileTestContractPaths(pathEntryPaths, subTaskTouched)) {
            const at = pathEntryPaths.indexOf(rc.from);
            if (at === -1) continue;
            const i = pathEntryIdx[at]!;
            const entry = contract[i]!;
            if (entry.kind !== "file_written" && entry.kind !== "file_committed") continue;
            contract[i] = { ...entry, path: rc.to };
            pathCorrections.push({ from: rc.from, to: rc.to });
            this.deps.state.audit(
              "loop.contract_test_path_reconciled",
              { sessionId, seq: st.seq, cycle, kind: entry.kind, from: rc.from, to: rc.to, subTaskTouched },
              sessionId,
            );
            this.deps.logger.info("[loop] reconciled a drifted TEST contract path onto the file this sub-task committed", {
              sessionId, seq: st.seq, cycle, from: rc.from, to: rc.to,
            });
            this.deps.interactionLog?.log(sessionId, {
              event: "contract_test_path_reconciled", phase: "worker", seq: st.seq, cycle,
              from: rc.from, to: rc.to,
            });
          }
        }
        // beta.103: fold the proven corrections back into the PLAN. Until now a
        // remap only ever reached the local `contract` array, so
        // `st.filesLikelyTouched` kept the lead's fictional path for the rest
        // of the run -- and computeReviseScope / mapFindingsToSubTasks both key
        // off filesLikelyTouched. In the b102 smoke that made cycle 3 skip the
        // one sub-task that owned both of its own outstanding findings. The
        // corrections are evidence-backed (learned from paths this run really
        // touched, 1:1 for the test reconcile), and applyPathCorrections only
        // ever REWRITES an entry the plan already declared -- it never appends
        // -- so a sub-task's scope can be corrected but never widened.
        if (this.deps.config.loop.plan_path_writeback_enabled !== false && pathCorrections.length > 0) {
          const wb = applyPathCorrections(st.filesLikelyTouched, pathCorrections);
          if (wb.applied.length > 0) {
            const before = [...(st.filesLikelyTouched ?? [])];
            st.filesLikelyTouched = wb.files;
            this.deps.state.audit(
              "loop.plan_path_written_back",
              { sessionId, seq: st.seq, cycle, applied: wb.applied, before, after: wb.files },
              sessionId,
            );
            this.deps.interactionLog?.log(sessionId, {
              event: "plan_path_written_back", phase: "worker", seq: st.seq, cycle,
              applied: wb.applied.map((c) => `${c.from} -> ${c.to}`),
            });
            this.deps.logger.info("[loop] corrected the plan's declared paths from verified evidence; revise scoping will use the real paths", {
              sessionId, seq: st.seq, cycle, corrections: describePathCorrections(wb.applied),
            });
          }
        }
        // beta.85: REVISE-CYCLE-AWARE CONTRACT RELAXATION -- the fix for the
        // revise verifier false-positive (session 696226e4 cyc2 seq7, and the
        // inverse-but-same-signature 1c744d70). On a revise cycle (cycle > 1)
        // the sub-task's contract still carries its CYCLE-1 shape (e.g. BOTH
        // route.ts AND download/route.ts), but a revise only needs to change
        // the file(s) the review actually FLAGGED. A contract file the current
        // review did NOT target was already shipped correctly in a prior cycle;
        // the worker correctly leaves it untouched (buildReviseDispatchHint even
        // TELLS it to: "if none apply, make NO changes"). Demanding a fresh
        // mtime/diff this sub-task then false-fails correct work. So: for a
        // NOT-TARGETED file_written/file_committed entry we set reviseRelaxed,
        // which makes verify.ts accept "present + committed anywhere in the
        // branch range" instead of a fresh write. A TARGETED file keeps the
        // strict fresh requirement -> 1c744d70 (worker skipped a TARGETED file)
        // still FAILS; 696226e4 (worker left a NOT-targeted correct file) PASSES.
        // Targeted set = files named by this cycle's review findings (file/line),
        // structurally matched against the contract path.
        if (cycle > 1 && lastReview?.findings?.length) {
          // beta.87 (Staging deep-dive [1]+[2]): build the TARGETED file set --
          // the files THIS revise sub-task is expected to change. A contract
          // file that is targeted keeps the STRICT fresh-write requirement; a
          // not-targeted file (already correct from a prior cycle) is relaxed.
          //
          // [2] PER-SUB-TASK SCOPE: when the revise-spec turn refreshed the
          // plan (reviseSpecApplied), this sub-task's OWN workerContext names
          // the files it should touch (filesLikelyTouched + codeExcerpts[].path)
          // -- use THAT, not the review-wide findings, so seq-4 doesn't inherit
          // strict mode from a finding about seq-7's file. Fall back to the
          // review-wide findings' `.file` only when there's no per-sub-task
          // signal (raw-findings path).
          // beta.92: prefer the DETERMINISTIC mapping's per-sub-task targeted
          // file set (the files THIS sub-task's findings actually name). Fall
          // back to filesLikelyTouched + codeExcerpts (per-sub-task signal), then
          // to the review-wide finding files (raw path) only if mapping is off.
          const mappedTargetedFiles = (reviseAssignment?.targetedFiles ?? [])
            .map((f) => (typeof f === "string" ? f.trim() : "")).filter(Boolean);
          const perSubTaskFiles = mappedTargetedFiles.length > 0
            ? mappedTargetedFiles
            : reviseSpecApplied
              ? [
                  ...(st.filesLikelyTouched ?? []),
                  ...((st.workerContext?.codeExcerpts ?? []).map((e) => e.path)),
                ].map((f) => (typeof f === "string" ? f.trim() : "")).filter(Boolean)
              : [];
          const reviewFindingFiles = lastReview.findings
            .map((f) => (typeof f.file === "string" ? f.file.trim() : ""))
            .filter(Boolean);
          const targetedFiles = perSubTaskFiles.length > 0 ? perSubTaskFiles : reviewFindingFiles;
          // beta.89 [F3] (Staging 3rd deep-dive): name WHICH target source drove
          // this sub-task's strict/relaxed decision. The revise-spec path uses
          // deterministic full-path workerContext (clean targeting); the raw-
          // findings fallback uses LLM `finding.file` (partial-path shorthand ->
          // likely `targets_unresolved` -> strict-everywhere -> a possible
          // false-fail of correct work). This one audit lets a post-mortem tell
          // from a single query which path a cycle-2 sub-task ran under, so the
          // one remaining semantic asymmetry is diagnosable instead of silent.
          this.deps.state.audit(
            "loop.revise_target_source",
            {
              sessionId, seq: st.seq, cycle,
              source: perSubTaskFiles.length > 0 ? "revise_spec_worker_context" : "raw_findings",
              reviseSpecApplied,
              targetCount: targetedFiles.length,
            },
            sessionId,
          );
          // beta.88 [E1] (Staging 2nd deep-dive): a NON-EMPTY targeted set that
          // structurally resolves to ZERO contract paths is functionally
          // IDENTICAL to an empty set -- e.g. the adversary wrote a PARTIAL
          // path (`download/route.ts`) that is shorter than the full contract
          // path, so no structural rule matches (suffix needs the real/committed
          // side to be the LONGER one). Without this guard `isTargeted` returns
          // false for EVERY entry -> everything relaxes -> the same false-pass
          // the beta.86 empty-targets fix closed, re-entered through a different
          // LLM output shape. So: only enter the relaxation path when at least
          // one target actually resolves to a contract path in THIS sub-task;
          // otherwise fall through to the strict-no-targets branch (keep
          // everything strict, a revise can't relax on unresolvable targets).
          const anyTargetResolvable =
            targetedFiles.length > 0 &&
            contract.some(
              (v) =>
                (v.kind === "file_written" || v.kind === "file_committed") &&
                !!v.path &&
                !!resolveContractPath(targetedFiles, v.path, { strictContract: true }),
            );
          if (anyTargetResolvable) {
            // [1] STRUCTURAL targeting only. A finding/spec path targets a
            // contract path ONLY via a real directory-context match
            // (exact/route-group/suffix/basename-dir), resolved through
            // resolveContractPath's strictContract mode. This kills the
            // beta.86 bidirectional bare-basename fuzzy match: an adversary
            // `file:"route.ts"` (bare) no longer force-strictens EVERY
            // `route.ts` sibling (which re-created the 696226e4 false-fail).
            // A bare-basename target that structurally resolves to >1 contract
            // file is genuinely ambiguous -> it targets NONE specifically
            // (resolveContractPath's strict mode returns no structural match
            // for a bare basename vs a dir'd path), so those siblings relax
            // rather than false-fail.
            const isTargeted = (p: string): boolean =>
              !!resolveContractPath(targetedFiles, p, { strictContract: true });
            for (let i = 0; i < contract.length; i++) {
              const v = contract[i]!;
              if ((v.kind === "file_written" || v.kind === "file_committed") && v.path && !isTargeted(v.path)) {
                contract[i] = { ...v, reviseRelaxed: true };
                this.deps.state.audit(
                  "loop.revise_contract_relaxed",
                  { sessionId, seq: st.seq, cycle, kind: v.kind, path: v.path, targetedFiles },
                  sessionId,
                );
                this.deps.interactionLog?.log(sessionId, {
                  event: "revise_contract_relaxed", phase: "worker", seq: st.seq, cycle, kind: v.kind, path: v.path, targetedFiles,
                });
              }
            }
          } else if (targetedFiles.length > 0) {
            // [E1] Non-empty targets that resolve to NOTHING -> keep strict.
            // Distinct audit so a partial-path adversary shorthand is visible.
            this.deps.state.audit(
              "loop.revise_contract_targets_unresolved",
              { sessionId, seq: st.seq, cycle, targetedFiles, contractPaths: contract.filter((v) => "path" in v && v.path).map((v) => (v as { path: string }).path) },
              sessionId,
            );
          } else {
            // Findings exist but none names a file -> keep strict, record why.
            this.deps.state.audit(
              "loop.revise_contract_strict_no_targets",
              { sessionId, seq: st.seq, cycle, findingCount: lastReview.findings.length },
              sessionId,
            );
          }
        }
        // beta.92 (charter #3): LOG-ONLY worker self-contradiction detector. The
        // b91 seq-6 confab: the worker's final message admitted it "did not
        // touch" a contract-REQUIRED file (b84 caught it at verify; we can bark
        // earlier). REQUIRED = file_written/file_committed contract entries that
        // are NOT reviseRelaxed (a relaxed file is legitimately left alone). No
        // behaviour change in b92 -- emit the audit, verification still decides.
        if (this.deps.config.loop.worker_confab_detect !== false) {
          try {
            const requiredPaths = contract
              .filter(
                (v) =>
                  (v.kind === "file_written" || v.kind === "file_committed") &&
                  !!(v as { path?: string }).path &&
                  !(v as { reviseRelaxed?: boolean }).reviseRelaxed,
              )
              .map((v) => (v as { path: string }).path);
            const confab = detectWorkerConfab(result.finalMessage, requiredPaths, result.filesChanged ?? []);
            if (confab.suspected) {
              this.deps.state.audit(
                "loop.worker_confab_suspected",
                { sessionId, seq: st.seq, cycle, offenders: confab.offenders, phrase: confab.phrase, requiredPaths },
                sessionId,
              );
              this.deps.logger.warn(
                "[loop] worker self-contradiction suspected: finalMessage claims a contract-required file was left untouched (LOG-ONLY; verification still decides)",
                { sessionId, seq: st.seq, cycle, offenders: confab.offenders },
              );
              this.deps.interactionLog?.log(sessionId, {
                event: "worker_confab_suspected", phase: "worker", seq: st.seq, cycle, offenders: confab.offenders,
              });
            }
          } catch (err) {
            // Detector must never fail a run -- it's observability only.
            this.deps.logger.warn("[loop] worker_confab_detect threw (ignored)", { sessionId, seq: st.seq, err: String(err) });
          }
        }
        if (contract.length > 0 && this.deps.buildVerifyProbes) {
          const probes = this.deps.buildVerifyProbes({
            plan, requester: row.requester, worktreePath: workerWorktree, baseSha: subTaskBaseSha,
          });
          const branchHint = contract.reduce<string>(
            (acc, v) => (v.kind === "branch_pushed" && v.branch ? v.branch : acc),
            plan.branch,
          );
          let verification: VerifyOutcome;
          try {
            verification = await verifySubTaskOutput(
              contract,
              {
                defaultBranch: branchHint, subTaskStartMs: subTaskStartedAtMs,
                baseSha: subTaskBaseSha, branchBaseSha: planBaseShaForVerify,
                // beta.95: revise-cycle TARGETED-file plan-base window.
                cycle,
                reviseTargetedPlanbaseWindow: this.deps.config.loop.revise_targeted_planbase_window !== false,
                acceptRenameAsWrite: this.deps.config.loop.file_written_accepts_rename !== false,
              },
              probes,
            );
          } catch (err) {
            // A probe error is a verification FAILURE, not a pass. Never let
            // an exception silently green-light a confabulated success.
            verification = { ok: false, results: [], summary: `probe error: ${String(err)}` };
          }

          this.deps.state.audit(
            "loop.subtask_verification",
            { sessionId, seq: st.seq, ok: verification.ok, contract, summary: verification.summary, results: verification.results },
            sessionId,
          );
          // beta.63 (Part B): mirror the verify probe into the durable log so a
          // stall trail shows which probes ran + passed before it froze.
          this.deps.interactionLog?.log(sessionId, {
            event: "verify_probe", phase: "worker", seq: st.seq, cycle,
            ok: verification.ok, contract, summary: verification.summary,
          });

          // beta.16 fix #2: also emit the observe-mode breadcrumb when
          // taskMode is 'observe' and verification passed. Keeps the audit
          // stream self-describing on observe sub-tasks (previously silent
          // because verify:[] means no checks fire, and inference filters
          // out mutation-scope kinds).
          if (verification.ok && (st.taskMode === "observe" || (contract.length === 0 && st.taskMode !== "mutate"))) {
            this.emitObserveCompleted(sessionId, st, result, contract);
          }

          if (!verification.ok) {
            // ---- beta.53 (P1b): retry-with-context on an env-wait hallucination ----
            // Staging beta.52 #858 seq-5: the worker WROTE the aria-label edit
            // (1145 bytes on disk) but never committed, then ended its turn with
            // "npm ci is still running. The Monitor will notify me when eslint is
            // installed. Waiting for that event." -- awaiting a mid-turn event
            // that does not exist. Rather than terminate the whole run on a
            // recoverable, well-understood hallucination, re-invoke the sub-task
            // ONCE with corrective context. Because P2 now captures
            // `uncommittedFiles`, we can branch the hint: for a PARTIAL-work turn
            // (wrote-but-didn't-commit) the fix is nearly free -- "you already
            // wrote X, just commit it"; for a ZERO-work turn -- "there is no such
            // event, do the work now, skip env verification if the tool is
            // missing". If the retry ALSO hallucinates (or otherwise fails
            // verification) we fall through to the normal terminal handling.
            const failedNow = verification.results.filter((x) => !x.passed);
            // beta.57 (P1): the retry trigger is now the OBSERVABLE STATE
            // INVARIANT, not the worker's phrasing. beta.52->53->54 each widened
            // a prose regex after a new wording escaped it; the state we
            // actually care about is directly checkable: a mutate-shaped
            // sub-task ended its turn with NO commit and ONLY local no-change
            // kinds failing. On cycle 1 that is never a legal outcome, so the
            // one-shot corrective retry fires unconditionally. On revise cycles
            // (cycle > 1) a no-commit turn IS often legal (the beta.35 no-op
            // downgrade below), so there the regex remains as the tiebreaker
            // between "legal nothing-to-do" and "confabulated wait".
            const phrasingMatched = matchesAsyncCoordConfabulation(result.finalMessage ?? "");
            const envWaitOnly =
              !envWaitRetried &&
              this.deps.config.loop.env_wait_retry_enabled !== false &&
              !result.commitSha &&
              failedNow.length > 0 &&
              failedNow.every((x) => ENV_WAIT_RETRYABLE_KINDS.has(x.kind)) &&
              (cycle === 1 || phrasingMatched);
            if (envWaitOnly) {
              envWaitRetried = true;
              const wrote = result.uncommittedFiles ?? [];
              const hint = wrote.length > 0
                ? `IMPORTANT: your PREVIOUS turn wrote these files to the worktree but never committed them: ${wrote.join(", ")}. There is NO background watcher, NO "Monitor event", NO completion notification, and NO event stream -- harness dispatch is one-shot and NOTHING will ever notify or resume you. Do NOT wait for any install/build/lint/test to "notify" you. Simply \`git add\` and \`git commit\` the work you already did, complete any remaining success criteria INLINE (run any command -- including the test suite, tsc, or lint -- directly in a single BLOCKING Bash call and read its output in THIS turn; or skip a missing tool and note it in the commit message), and end your turn.`
                : `IMPORTANT: your PREVIOUS turn ended waiting for something that does not exist (a "Monitor event", a "background watcher", a "completion notification", or similar). The harness has NO such mechanism -- dispatch is one-shot and nothing will notify or resume you. Complete this sub-task NOW without waiting for anything. To run tests/build/lint/install, execute the command DIRECTLY in a single blocking Bash call in THIS turn and read its output; do not background it and do not wait for a signal. If a tool (eslint/tsc/lint) is not installed, run \`npm ci\` INLINE first, OR skip that step and note it in the commit message. Make the required edit, commit it, and end your turn.`;
              this.deps.interactionLog?.log(sessionId, { event: "env_wait_retry", phase: "worker", seq: st.seq, cycle, partialWork: wrote.length > 0 });
              this.deps.state.audit(
                "loop.worker_env_wait_retry",
                {
                  sessionId, seq: st.seq, cycle,
                  partialWork: wrote.length > 0,
                  uncommittedFiles: wrote,
                  // beta.57: the regex is now telemetry, not the gate.
                  phrasingMatched,
                  priorFinalMessage: (result.finalMessage ?? "").slice(0, 500),
                },
                sessionId,
              );
              this.deps.logger.warn("[loop] env-wait hallucination detected; retrying sub-task once with corrective context", {
                sessionId, seq: st.seq, partialWork: wrote.length > 0,
              });
              try {
                // beta.90 (Feature 2): stream-slow liveness on the retry too.
                const onRetryStreamSlow = this.makeStreamSlowCallback(sessionId, st.seq, cycle);
                const retry = await withTimeout(
                  this.deps.runWorker({
                    brief, subTask: st, plan, requester: row.requester,
                    // Compose the revise context (if any) with the corrective hint.
                    dispatchHint: reviseHint ? `${reviseHint}\n\n${hint}` : hint,
                    // beta.91 (Fix 3): mechanical sub-tasks -> cheaper model.
                    modelOverride: selectWorkerModel(st, this.deps.config.models),
                    onStreamSlow: onRetryStreamSlow,
                  }),
                  this.deps.config.loop.worker_timeout_seconds,
                );
                this.addCost(sessionId, retry.costUsd);
                await this.deps.budget.recordSpend(row.requester, retry.costUsd, sessionId);
                totalCost += retry.costUsd;
                if (retry.costUsd > 0) subTaskCosts.push(retry.costUsd);
                let retryVerification: VerifyOutcome;
                try {
                  const retryProbes = this.deps.buildVerifyProbes!({
                    plan, requester: row.requester, worktreePath: workerWorktree, baseSha: subTaskBaseSha,
                  });
                  retryVerification = await verifySubTaskOutput(
                    contract,
                    {
                      defaultBranch: branchHint, subTaskStartMs: subTaskStartedAtMs,
                      // beta.95: the retry path dropped branchBaseSha -- a
                      // reviseRelaxed/targeted file on a revise-cycle retry lost
                      // its plan-base window. Thread both through here too.
                      baseSha: subTaskBaseSha, branchBaseSha: planBaseShaForVerify,
                      cycle,
                      reviseTargetedPlanbaseWindow: this.deps.config.loop.revise_targeted_planbase_window !== false,
                      acceptRenameAsWrite: this.deps.config.loop.file_written_accepts_rename !== false,
                    },
                    retryProbes,
                  );
                } catch (err) {
                  retryVerification = { ok: false, results: [], summary: `probe error: ${String(err)}` };
                }
                this.deps.state.audit(
                  "loop.subtask_verification",
                  { sessionId, seq: st.seq, ok: retryVerification.ok, contract, summary: retryVerification.summary, results: retryVerification.results, retry: true },
                  sessionId,
                );
                if (retryVerification.ok) {
                  this.deps.state.db.prepare(
                    `UPDATE sub_tasks SET status = ?, cost_usd = cost_usd + ?, files_touched = ?, commit_sha = ?, sdk_session_id = ?, summary = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
                  ).run(
                    retry.status,
                    retry.costUsd,
                    JSON.stringify(retry.filesChanged),
                    retry.commitSha ?? null,
                    retry.sdkSessionId ?? null,
                    `env-wait retry succeeded: ${retryVerification.summary}`,
                    Date.now(), Date.now(), subTaskId,
                  );
                  this.checkpoint(sessionId, cycle, subTaskId, retry.sdkSessionId);
                  this.deps.logger.info("[loop] env-wait retry SUCCEEDED", { sessionId, seq: st.seq });
                  done.add(st.seq);
                  return;
                }
                // Retry also failed verification -> fall through using the
                // retry's result/verification so the terminal report reflects
                // the second attempt.
                this.deps.logger.warn("[loop] env-wait retry FAILED verification; terminating", {
                  sessionId, seq: st.seq, summary: retryVerification.summary,
                });
                result = retry;
                verification = retryVerification;
              } catch (err) {
                this.deps.logger.warn("[loop] env-wait retry threw; terminating", { sessionId, seq: st.seq, err: String(err) });
                // keep original result/verification; fall through to terminal.
              }
            }
            // ---- beta.35 fix #1 + #2: legal no-op on a REVISE cycle ----
            // On a revise cycle (cycle > 1) the plan's mutate sub-task is
            // re-run against a base = the worker's current HEAD (the commit it
            // already produced on cycle 1). If the worker correctly concludes
            // there is nothing to change (the code already satisfies the
            // criteria; the adversary's revise findings were about runtime
            // evidence / PR-description text / accepted nits), it ends with
            // `end_turn` and NO new commit. The old code then failed the
            // `commit_made` contract (HEAD == base) and killed the whole
            // session -- even though the fix was already correct.
            //
            // A revise cycle that makes no change is a VALID outcome. So: if
            // this is a revise cycle, the worker completed cleanly, and the
            // ONLY failing checks are the "no new commit / no new file change"
            // kinds (i.e. the effective task-mode is 'observe' for this pass,
            // #2), downgrade the sub-task to `completed_no_change` and let the
            // loop proceed to ship. Any OTHER kind of failure (a real
            // confabulation: claimed a push/PR that didn't happen, wrote a
            // file that isn't there) still hard-fails -- we do NOT weaken the
            // trust-but-verify guarantee.
            const NO_CHANGE_KINDS = new Set(["commit_made", "file_committed", "file_written"]);
            const failedResults = verification.results.filter((x) => !x.passed);
            const onlyNoChangeFailures =
              failedResults.length > 0 &&
              failedResults.every((x) => NO_CHANGE_KINDS.has(x.kind));
            const workerMadeNoCommit = !result.commitSha; // worker itself reports no commit
            if (cycle > 1 && onlyNoChangeFailures && workerMadeNoCommit) {
              this.deps.state.db.prepare(
                `UPDATE sub_tasks SET status = 'completed_no_change', summary = ?, updated_at = ? WHERE id = ?`,
              ).run(
                `revise no-op: worker made no change (${verification.summary}); code already satisfies criteria`,
                Date.now(),
                subTaskId,
              );
              this.deps.state.audit(
                "loop.subtask_revise_no_change",
                {
                  sessionId,
                  seq: st.seq,
                  cycle,
                  taskMode: st.taskMode ?? "unspecified",
                  effectiveTaskMode: "observe",
                  baseRef: subTaskBaseSha ? subTaskBaseSha.slice(0, 12) : "(unknown)",
                  failedKinds: failedResults.map((x) => x.kind),
                  summary: verification.summary,
                },
                sessionId,
              );
              this.deps.logger.info("[loop] revise cycle no-op accepted (worker had nothing to change)", {
                sessionId, seq: st.seq, cycle,
              });
              done.add(st.seq);
              return;
            }
            // Emit per-kind failure events so failures are greppable and
            // operators can debug from audit alone.
            // beta.9: new specific events + backward-compat old event names
            // both fire so consumers watching old names keep working.
            for (const r of verification.results.filter((x) => !x.passed)) {
              // beta.15: include base_ref on commit/file_committed audit events
              // for debugging clarity. The commit_made check compares HEAD vs
              // the worker-session-start SHA (`subTaskBaseSha`), not the
              // branch base. Making this explicit in the audit payload lets
              // operators tell the difference between "worker didn't commit"
              // and "no new commits since sub-task started, which is correct
              // for observation-only sub-tasks".
              const baseRef = (r.kind === "commit_made" || r.kind === "file_committed")
                ? { baseRef: subTaskBaseSha ? subTaskBaseSha.slice(0, 12) : "(unknown)", baseSemantics: "worker-session-start" }
                : {};
              const payload = { sessionId, seq: st.seq, detail: r.detail, ...baseRef };
              switch (r.kind) {
                case "branch_pushed":
                  // beta.10: fire ONLY the backward-compat name here. The
                  // beta.9+ contract inference already emits
                  // `remote_branch_exists` alongside `branch_pushed` for push
                  // sub-tasks, and that kind fires `remote_branch_verify_failed`
                  // on its own case. Firing both here caused duplicate
                  // `remote_branch_verify_failed` events on the beta.10
                  // smoke test (one from `branch_pushed` -> HTTP 404, one
                  // from `remote_branch_exists` -> ls-remote empty).
                  this.deps.state.audit("loop.push_verify_failed", payload, sessionId);
                  break;
                case "remote_branch_exists":
                  this.deps.state.audit("loop.remote_branch_verify_failed", payload, sessionId);
                  break;
                case "commit_sha_matches":
                  this.deps.state.audit("loop.commit_sha_verify_failed", payload, sessionId);
                  break;
                case "pr_opened":
                  this.deps.state.audit("loop.pr_verify_failed", payload, sessionId);
                  break;
                case "pr_state":
                  // backward compat: also fire old pr_verify_failed
                  this.deps.state.audit("loop.pr_verify_failed", payload, sessionId);
                  this.deps.state.audit("loop.pr_state_verify_failed", payload, sessionId);
                  break;
                case "file_written":
                  // backward compat name
                  this.deps.state.audit("loop.file_verify_failed", payload, sessionId);
                  // new specific name
                  this.deps.state.audit("loop.file_written_verify_failed", payload, sessionId);
                  break;
                case "file_committed":
                  this.deps.state.audit("loop.file_committed_verify_failed", payload, sessionId);
                  break;
                case "file_pushed":
                  this.deps.state.audit("loop.file_pushed_verify_failed", payload, sessionId);
                  break;
                case "file_in_pr":
                  this.deps.state.audit("loop.file_in_pr_verify_failed", payload, sessionId);
                  break;
                case "commit_made":
                  // backward compat name
                  this.deps.state.audit("loop.commit_verify_failed", payload, sessionId);
                  break;
                default:
                  // fallback for any future kinds
                  this.deps.state.audit("loop.verify_failed", { ...payload, kind: r.kind }, sessionId);
              }
            }
            // ---- beta.48 (C1 + C2): reasoned-refusal observability ----
            // Session dca2f3b5 (beta.47 revise of #858) exposed a blind spot:
            // a worker can end its turn with `end_turn` + ZERO filesystem
            // side-effects because it made a REASONED REFUSAL (e.g. "the
            // sub-task's premise is factually false, renaming would regress
            // the repo"). The harness saw "0/N checks passed, worker did
            // nothing" and terminated, throwing away the worker's structured
            // explanation. The refusal was CORRECT but invisible. Detect the
            // shape (every failing check is a no-change kind AND the worker
            // made no commit AND it left a non-empty final message) and
            // surface that message so operators/downstream see WHY, instead
            // of an opaque empty turn. NOTE: this does NOT change the pass/
            // fail decision (the sub-task still fails verification) -- it only
            // makes the reason observable. We deliberately do NOT auto-accept
            // the refusal: a worker refusing on a false premise is a signal
            // that an UPSTREAM artefact (adversary finding / brief) was wrong,
            // which a human or a future replan loop should resolve.
            const NO_CHANGE_ONLY = failedResults.length > 0 && failedResults.every((x) => NO_CHANGE_KINDS.has(x.kind));
            const refusalText = (result.finalMessage ?? "").trim();
            const looksLikeRefusal = NO_CHANGE_ONLY && !result.commitSha && refusalText.length > 0;
            // ---- beta.52: distinguish a PROTOCOL-ASSUMPTION failure from a
            // reasoned refusal. Session fc64d8ea (beta.51 revise of #858) sub-
            // task 3: the worker ended its turn with 24 words -- "The install
            // is still completing. I'll await the Monitor event signaling tsc
            // is ready rather than polling further." -- and ZERO side-effects.
            // That is NOT a reasoned refusal (it did not dispute the task); it
            // HALLUCINATED a mid-turn event stream that does not exist in the
            // one-shot harness protocol, and exited waiting for a signal that
            // never comes. The beta.52 worker-prompt hardening kills the
            // behaviour; this tag makes the pattern greppable in metrics so we
            // can tell "worker was wrong about the harness" apart from "worker
            // correctly refused a bad task". Does NOT change pass/fail.
            const looksLikeProtocolAssumption =
              looksLikeRefusal && matchesAsyncCoordConfabulation(refusalText);
            if (looksLikeProtocolAssumption) {
              const firstLine = refusalText.split("\n").map((l) => l.trim()).find(Boolean) ?? refusalText.slice(0, 200);
              this.deps.state.audit(
                "loop.worker_env_wait_hallucination",
                {
                  sessionId,
                  seq: st.seq,
                  cycle,
                  reasonFirstLine: firstLine.slice(0, 300),
                  finalMessage: refusalText.slice(0, 4000),
                  failedKinds: failedResults.map((x) => x.kind),
                },
                sessionId,
              );
              this.deps.logger.warn("[loop] worker awaited a non-existent mid-turn event (env-wait hallucination) and did no work", {
                sessionId, seq: st.seq, reasonFirstLine: firstLine.slice(0, 200),
              });
            }
            if (looksLikeRefusal) {
              const firstLine = refusalText.split("\n").map((l) => l.trim()).find(Boolean) ?? refusalText.slice(0, 200);
              // beta.58 (Bug B): split the audit event by semantics. A refusal
              // whose explanation references a contradicted/invalid premise is
              // a GOOD-FAITH skip, not a bad-faith refusal -- emit a distinct
              // event so breakdowns are diagnosable without reading the prose.
              // (Pass/fail is unchanged: both still escalate to clarification.)
              const invalidPremiseSkip =
                matchesInvalidPremiseSkip(refusalText) && failedResults.some((x) => x.kind === "commit_made");
              this.deps.interactionLog?.log(sessionId, {
                event: invalidPremiseSkip ? "worker_skipped_invalid_premise" : "worker_refusal",
                phase: "worker", seq: st.seq, cycle, reasonFirstLine: firstLine.slice(0, 300),
              });
              this.deps.state.audit(
                invalidPremiseSkip ? "loop.worker_skipped_invalid_premise" : "loop.worker_refusal",
                {
                  sessionId,
                  seq: st.seq,
                  cycle,
                  reasonFirstLine: firstLine.slice(0, 300),
                  finalMessage: refusalText.slice(0, 4000),
                  failedKinds: failedResults.map((x) => x.kind),
                  summary: verification.summary,
                },
                sessionId,
              );
              this.deps.logger.warn(
                invalidPremiseSkip
                  ? "[loop] worker skipped a sub-task on a contradicted premise (good-faith, structured)"
                  : "[loop] worker made a reasoned refusal (zero side-effects + explanation)",
                { sessionId, seq: st.seq, reasonFirstLine: firstLine.slice(0, 200) },
              );
            }
            // beta.48 (C2): fold the refusal first-line into the persisted
            // summary so harness_progress.headline and the terminal update
            // show "worker refused: <reason>" rather than a bare
            // verification-failed string.
            const failSummary = looksLikeProtocolAssumption
              ? `worker awaited a non-existent mid-turn event and did no work: ${(refusalText.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 300)}`
              : looksLikeRefusal
                ? `worker refused (no changes made): ${(refusalText.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 300)}`
                : `verification failed: ${verification.summary}`;
            this.deps.state.db.prepare(
              `UPDATE sub_tasks SET status = 'failed_verification', summary = ?, updated_at = ? WHERE id = ?`,
            ).run(failSummary, Date.now(), subTaskId);
            this.deps.logger.warn("[loop] harness-side verification FAILED (worker confabulated success)", {
              sessionId, seq: st.seq, costUsd: result.costUsd, summary: verification.summary,
            });
            failed.err = `subtask_${st.seq}_failed_verification: ${failSummary}`;
            failed.seq = st.seq;
            // ---- beta.55 (B2): escalate a reasoned refusal / surviving
            // confabulation to a HUMAN instead of hard-failing the run. ----
            // Precondition: this is a genuine refusal (looksLikeRefusal) that
            // has ALREADY had its beta.54 async-coord retry (envWaitRetried is
            // true if a retry was attempted; a refusal that reaches here after
            // the retry, OR one that never qualified for retry, is a real
            // blocking ambiguity). Rather than kill the whole run, surface the
            // worker's OWN explanation as a question and pause resumably. The
            // worktree is preserved (finaliseAwaitingClarification does NOT
            // release it) so harness_answer can re-drive from this seq in place.
            if (
              looksLikeRefusal &&
              this.deps.config.loop.clarification_escalation_enabled !== false
            ) {
              const firstLine = refusalText.split("\n").map((l) => l.trim()).find(Boolean) ?? refusalText.slice(0, 200);
              clarify.question =
                `Sub-task ${st.seq} ("${st.title}") could not proceed. The worker's explanation: ${firstLine.slice(0, 500)}. ` +
                `How should it proceed? (Answer with a decision, or say "skip" to drop this sub-task, or "abort".)`;
              clarify.seq = st.seq;
              // beta.58 (D1/D2): capture the paused sub-task's title+intent so a
              // `skip` answer keys the prohibition by CONTENT (survives a re-plan's
              // seq renumbering) and can strip the owning finding line.
              clarify.subtask = { title: st.title, intent: st.intent };
            }
            // ---- beta.100: a CONTRACT-PATH MISMATCH pauses, it does not kill ----
            // b99 seq 3 (session 4420aa45): the worker committed d7cc9602 carrying
            // BOTH deliverables, but placed the test at the repo's real Jest
            // location rather than the co-located path the lead guessed pre-probe.
            // EVERY recovery path missed -- the b53 env-wait retry requires NO
            // commit, the b35 revise no-op requires cycle > 1, and the b55
            // escalation directly above requires `looksLikeRefusal`, which also
            // requires NO commit. So a run holding two good commits plus a correct
            // third one hard-failed at cycle 1, $3.94 spent, no PR, nothing to
            // resume from.
            //
            // The b100 reconciliation (see the contract build above) self-heals the
            // provable case. What reaches HERE is the genuinely ambiguous
            // remainder: the worker committed real work, but the harness cannot
            // prove whether the PLAN's path or the WORKER's placement is the wrong
            // one. That is a human decision, so pause resumably -- the worktree and
            // its commits survive and harness_answer re-drives from this seq.
            //
            // This does NOT weaken trust-but-verify. The sub-task still FAILS
            // (failed.err is set and the row is already `failed_verification`);
            // nothing is accepted and no check is relaxed. We change only the
            // TERMINAL DISPOSITION, from `failed` to `awaiting_clarification`. The
            // worker's prose is quoted as context but is never the evidence: the
            // expected paths come from the contract and the actual paths from git
            // via result.filesChanged.
            const PATH_MISMATCH_KINDS = new Set(["file_committed", "file_written"]);
            const contractPathMismatch =
              !!result.commitSha &&
              failedResults.length > 0 &&
              failedResults.every((x) => PATH_MISMATCH_KINDS.has(x.kind) && !!x.path);
            // ---- beta.105: BASENAME-ANCHORED RESCUE, before we bother a human ----
            // b103's rederive only corrects a path when an EARLIER sub-task
            // already taught the run the substitution. On the b103 smoke, seq 9
            // was the first sub-task to touch `src/components/`, so the lead's
            // fictional `components/layout/sidebar.tsx` met the worker's correct
            // `components/ui/sidebar.tsx` with no lesson to apply: no rederive
            // fired, and a mechanically-obvious correction escalated to a human
            // who took an hour to answer. Same basename, planned directory
            // absent from the repo, committed directory present -- the harness
            // had everything it needed to resolve this itself.
            //
            // So: propose the remap from the mismatch, re-verify against the
            // corrected contract, and only continue if verification ACTUALLY
            // passes. Nothing is waved through -- a rescue that does not verify
            // falls straight into the escalation below, unchanged. The strict
            // conditions live in basename-rescue.ts.
            if (
              !clarify.question &&
              contractPathMismatch &&
              this.deps.config.loop.basename_rescue_enabled !== false &&
              this.deps.listRepoFiles &&
              this.deps.buildVerifyProbes
            ) {
              try {
                const expected = [...new Set(failedResults.map((x) => x.path!).filter(Boolean))];
                const actual = (result.filesChanged ?? []).filter((f): f is string => typeof f === "string" && !!f.trim());
                const repoFiles = await this.deps.listRepoFiles(workerWorktree);
                const rescue = proposeBasenameRescue({ expected, actual, repoDirs: repoDirsFromFiles(repoFiles) });
                if (rescue) {
                  const rescued = contract.map((v) =>
                    "path" in v && v.path === rescue.from ? { ...v, path: rescue.to } : v,
                  );
                  const rescueProbes = this.deps.buildVerifyProbes({
                    plan, requester: row.requester, worktreePath: workerWorktree, baseSha: subTaskBaseSha,
                  });
                  const reverified = await verifySubTaskOutput(
                    rescued,
                    {
                      defaultBranch: branchHint, subTaskStartMs: subTaskStartedAtMs,
                      baseSha: subTaskBaseSha, branchBaseSha: planBaseShaForVerify,
                      cycle,
                      reviseTargetedPlanbaseWindow: this.deps.config.loop.revise_targeted_planbase_window !== false,
                      acceptRenameAsWrite: this.deps.config.loop.file_written_accepts_rename !== false,
                    },
                    rescueProbes,
                  );
                  this.deps.state.audit(
                    "loop.contract_path_basename_rescued",
                    {
                      sessionId, seq: st.seq, cycle,
                      from: rescue.from, to: rescue.to, via: rescue.via, reason: rescue.reason,
                      verified: reverified.ok, summary: reverified.summary,
                    },
                    sessionId,
                  );
                  if (reverified.ok) {
                    // Fold the correction into the plan through the same b103
                    // writeback path a learned remap uses, so a later revise
                    // cycle scopes against the real path too.
                    if (this.deps.config.loop.plan_path_writeback_enabled !== false) {
                      const before = st.filesLikelyTouched ?? [];
                      const wb = applyPathCorrections(before, [{ from: rescue.from, to: rescue.to }]);
                      if (wb.applied.length > 0) {
                        st.filesLikelyTouched = wb.files;
                        this.deps.state.audit(
                          "loop.plan_path_written_back",
                          { sessionId, seq: st.seq, cycle, applied: wb.applied, before, after: wb.files, source: "basename_rescue" },
                          sessionId,
                        );
                      }
                    }
                    this.deps.interactionLog?.log(sessionId, {
                      event: "contract_path_basename_rescued", phase: "worker", seq: st.seq, cycle,
                      from: rescue.from, to: rescue.to,
                    });
                    this.deps.logger.info(`[loop] ${describeBasenameRescue(rescue)}; re-verified clean, continuing without a clarification`, {
                      sessionId, seq: st.seq, cycle,
                    });
                    this.deps.state.db.prepare(
                      `UPDATE sub_tasks SET status = ?, files_touched = ?, commit_sha = ?, sdk_session_id = ?, summary = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
                    ).run(
                      "completed",
                      JSON.stringify(result.filesChanged ?? []),
                      result.commitSha ?? null,
                      result.sdkSessionId ?? null,
                      `basename-rescued contract path (${rescue.from} -> ${rescue.to}): ${reverified.summary}`,
                      Date.now(), Date.now(), subTaskId,
                    );
                    this.checkpoint(sessionId, cycle, subTaskId, result.sdkSessionId);
                    done.add(st.seq);
                    return;
                  }
                }
              } catch (err) {
                // A rescue that throws must leave the run exactly where it was:
                // escalating to a human, which is the pre-b105 behaviour.
                this.deps.logger.warn("[loop] basename rescue failed (non-fatal; escalating as before)", {
                  sessionId, seq: st.seq, cycle, err: String(err),
                });
              }
            }
            if (
              !clarify.question &&
              contractPathMismatch &&
              this.deps.config.loop.contract_mismatch_escalation_enabled !== false &&
              this.deps.config.loop.clarification_escalation_enabled !== false
            ) {
              const expected = [...new Set(failedResults.map((x) => x.path!).filter(Boolean))];
              const actual = (result.filesChanged ?? []).filter((f) => typeof f === "string" && f.trim());
              // beta.101: select the worker's reason by RELEVANCE, not
              // position. b100 quoted the first line and showed the operator
              // "That's fine, it's a harmless temp file outside the repo" --
              // about an unrelated file -- while the real explanation sat lower
              // in the message. See extractStatedReason.
              const statedReason = extractStatedReason(result.finalMessage ?? "", expected, actual);
              this.deps.state.audit(
                "loop.contract_path_mismatch_escalated",
                {
                  sessionId, seq: st.seq, cycle,
                  expected, actual,
                  commitSha: result.commitSha,
                  failedKinds: failedResults.map((x) => x.kind),
                  summary: verification.summary,
                },
                sessionId,
              );
              this.deps.interactionLog?.log(sessionId, {
                event: "contract_path_mismatch_escalated", phase: "worker", seq: st.seq, cycle, expected, actual,
              });
              this.deps.logger.warn("[loop] contract-path mismatch on a REAL commit; pausing for a human instead of failing the run", {
                sessionId, seq: st.seq, cycle, expected, actual,
              });
              // beta.111: before pausing a run for a human, check whether the
              // answer is already sitting in the branch. See contract-clarify.ts.
              const changedOnBranch =
                this.deps.worktreeCommittedFiles && workerWorktree
                  ? await this.deps
                      .worktreeCommittedFiles(workerWorktree, planBaseShaForVerify)
                      .catch(() => [] as string[])
                  : [];
              const mismatch = {
                seq: st.seq, title: st.title, commitSha: result.commitSha!,
                expected, actual, statedReason, changedOnBranch,
              };
              const auto = autoResolveContract(mismatch);
              if (auto.resolved && this.deps.config.loop.auto_resolve_satisfied_contract !== false) {
                this.deps.state.audit(
                  "loop.contract_auto_resolved",
                  { sessionId, seq: st.seq, cycle, expected, actual, coveredEarlier: auto.coveredEarlier, reason: auto.reason },
                  sessionId,
                );
                this.deps.interactionLog?.log(sessionId, {
                  event: "contract_auto_resolved", phase: "worker", seq: st.seq, cycle, coveredEarlier: auto.coveredEarlier,
                });
                this.deps.logger.info("[loop] beta.111: contract mismatch settled from branch history; not pausing for a human", {
                  sessionId, seq: st.seq, coveredEarlier: auto.coveredEarlier,
                });
                this.deps.state.db
                  .prepare(`UPDATE sub_tasks SET status = 'completed', summary = ?, updated_at = ? WHERE session_id = ? AND cycle = ? AND seq = ?`)
                  .run(`contract satisfied by the branch: ${auto.reason}`, Date.now(), sessionId, cycle, st.seq);
                done.add(st.seq);
                return;
              }
              clarify.question = buildContractClarification(mismatch);
              clarify.seq = st.seq;
              clarify.subtask = { title: st.title, intent: st.intent };
            }
            return;
          }
        } else if (st.taskMode === "observe" || (contract.length === 0 && st.taskMode !== "mutate")) {
          // beta.16 fix #2 + beta.18 fix: emit the observe-mode breadcrumb
          // when either:
          //   (a) taskMode is explicitly 'observe', or
          //   (b) the contract is empty AND taskMode is not explicitly
          //       'mutate' (defensive for pre-beta.15 plans without
          //       taskMode where inference just came up empty).
          //
          // Beta.16/17 shipped this branch without the `!== "mutate"`
          // guard, so a mutate sub-task whose inferred contract was empty
          // (or which took the buildVerifyProbes-absent test path) fired
          // `loop.subtask_observe_completed` with `taskMode:"mutate"` in
          // the payload — an incoherent event where the name says
          // "observe" but the payload admits it's a mutation. The inner
          // (verification-eligible) branch already had this guard; beta.18
          // brings this branch in line.
          this.emitObserveCompleted(sessionId, st, result, []);
        }

        // beta.55 (B3): the sub-task PASSED, but if the worker's own final
        // message signals it deviated from the literal wording (a judgment
        // call), make that a first-class audit signal so "guess-and-document"
        // is auditable rather than buried in prose. Does NOT change pass/fail.
        {
          const finalMsg = (result.finalMessage ?? "").trim();
          if (finalMsg && matchesWorkerDeviation(finalMsg)) {
            const firstLine = finalMsg.split("\n").map((l) => l.trim()).find(Boolean) ?? finalMsg.slice(0, 200);
            this.deps.state.audit(
              "loop.worker_deviation",
              { sessionId, seq: st.seq, cycle, summary: firstLine.slice(0, 500), finalMessage: finalMsg.slice(0, 2000) },
              sessionId,
            );
            this.deps.logger.info("[loop] worker deviated from literal wording (passed verification, judgment call)", {
              sessionId, seq: st.seq, summary: firstLine.slice(0, 200),
            });
          }
        }

        done.add(st.seq);
      };

      /**
       * beta.117: run one sub-task, in its own checkout when running parallel.
       *
       * Serial runs (still the default) take the early path and are byte-for-byte
       * the pre-b117 behaviour: the sub-task works directly in the session
       * worktree and commits straight onto the session branch.
       *
       * When parallel, the sub-task gets a leased slot instead and its commits
       * are merged back afterwards. The merge-back sits in a `finally` on
       * purpose. `runOneInner` has more than a dozen early returns -- revise
       * skips, clarification pauses, contract mismatches, verification failures
       * -- and a worker can have committed real work before reaching any of
       * them. Merging back on the success path alone would strand those commits
       * on a slot branch that gets deleted at the end of the run, which is the
       * b100 lost-commit failure reintroduced by the back door.
       */
      const runOne = async (st: LeadPlanSubTask): Promise<void> => {
        // No pool, or nothing for a worker to do: use the session worktree.
        if (!pool?.enabled || reviseScopeSkip.has(st.seq)) {
          return runOneInner(st, plan.worktreePath);
        }

        const sessionTip = this.deps.worktreeHeadSha
          ? await this.deps.worktreeHeadSha(plan.worktreePath).catch(() => "")
          : "";
        if (!sessionTip) {
          // Without a start point we cannot position a slot, and a slot at the
          // wrong base produces a diff against the wrong tree. Degrade to
          // serial rather than guess.
          this.deps.state.audit("loop.parallel_slot_degraded", { sessionId, cycle, seq: st.seq, reason: "session_tip_unavailable" }, sessionId);
          return runOneInner(st, plan.worktreePath);
        }

        let lease: PooledWorktree;
        try {
          lease = await pool.acquire(sessionTip);
        } catch (err) {
          // Disk, npm, or git trouble creating a slot must cost this sub-task
          // its parallelism, not the run.
          this.deps.state.audit("loop.parallel_slot_degraded", { sessionId, cycle, seq: st.seq, reason: "acquire_failed", err: String(err) }, sessionId);
          this.deps.logger.warn("[loop] could not lease a parallel slot; running this sub-task in the session worktree", { sessionId, seq: st.seq, err: String(err) });
          return runOneInner(st, plan.worktreePath);
        }

        try {
          return await runOneInner(st, lease.path);
        } finally {
          try {
            await this.mergeBackSlot({ sessionId, cycle, st, lease, baseSha: sessionTip, plan, failed });
          } finally {
            pool.release(lease);
          }
        }
      };

      // Dispatcher: greedily fill up to `concurrency` in-flight, respecting dependsOn.
      let idx = 0;
      while (idx < ordered.length || inFlight.length > 0) {
        if (failed.err) break;
        // Fill
        while (
          idx < ordered.length &&
          inFlight.length < concurrency &&
          (ordered[idx]!.dependsOn ?? []).every((d) => done.has(d)) &&
          // beta.91 (Fix 2): only start a second worker when its file scope is
          // known-disjoint from every in-flight worker (shared worktree write
          // safety). With concurrency=1 this is always true (inFlight empty).
          canDispatchConcurrently(ordered[idx]!, [...inFlightSubTasks.values()])
        ) {
          const st = ordered[idx]!;
          // beta.60: bound the ENTIRE runOne, not just the worker SDK call.
          // beta.42 wrapped runWorker in withTimeout, but runOne ALSO awaits
          // unbounded git/IO before and after the worker (worktreeHeadSha,
          // readReactions, verifySubTaskOutput probes, budget.recordSpend). A
          // hang in ANY of those froze the dispatcher at `await
          // Promise.race(inFlight)` forever with the sub-task row stuck
          // `running`, sdk_session_id=null, cost_usd=0, and NO worker process
          // spawned -- the exact b59 PR#858 seq-7 stall (5h30m silent, no
          // auto-recovery, because nothing re-called run() to arm the
          // stall-watchdog). Bounding runOne converts any such hang into a
          // clean SubTaskDeadlineError -> failed.err -> terminal.
          const p = withTimeout(runOne(st), this.deps.config.loop.subtask_deadline_seconds, "subtask_deadline_seconds")
            .catch((err) => {
              if (err instanceof WorkerTimeoutError) {
                this.deps.state.audit(
                  "loop.subtask_deadline_exceeded",
                  { sessionId, seq: st.seq, subtask_deadline_seconds: this.deps.config.loop.subtask_deadline_seconds },
                  sessionId,
                );
                this.deps.logger.error(
                  "[loop] sub-task exceeded subtask_deadline_seconds (dispatch hang, likely a stalled git/IO await before or after the worker); failing the run",
                  { sessionId, seq: st.seq, seconds: this.deps.config.loop.subtask_deadline_seconds },
                );
                // mark the stuck row failed so it doesn't linger as `running`
                this.deps.state.db.prepare(
                  `UPDATE sub_tasks SET status = 'failed', summary = ?, updated_at = ? WHERE session_id = ? AND cycle = ? AND seq = ?`,
                ).run(`sub-task dispatch exceeded ${this.deps.config.loop.subtask_deadline_seconds}s (stalled IO)`, Date.now(), sessionId, cycle, st.seq);
                if (!failed.err) { failed.err = `subtask_deadline_exceeded (seq ${st.seq})`; failed.seq = st.seq; }
              } else {
                // runOne handles its own errors internally; a throw here is
                // unexpected -- surface it rather than silently dropping.
                if (!failed.err) { failed.err = `subtask_dispatch_error: ${String(err)}`; failed.seq = st.seq; }
              }
            })
            .finally(() => {
              const i = inFlight.indexOf(p);
              if (i >= 0) inFlight.splice(i, 1);
              inFlightSubTasks.delete(p);
            });
          inFlight.push(p);
          inFlightSubTasks.set(p, st);
          idx++;
        }
        if (inFlight.length === 0 && idx < ordered.length) {
          // Blocked -- dependency not met yet and no in-flight to unblock. Data bug.
          failed.err = `subtask ${ordered[idx]!.seq} has unresolved dependencies`;
          failed.seq = ordered[idx]!.seq;
          break;
        }
        if (inFlight.length > 0) {
          await Promise.race(inFlight);
        }
      }
      await Promise.allSettled(inFlight);
      // beta.117: slots are per-cycle. A revise cycle re-plans which sub-tasks
      // run, and a slot still holding the previous cycle's tree would start a
      // worker from the wrong base. Draining here also means a run that fails
      // mid-cycle does not leave checkouts behind for the reaper to find.
      if (pool) {
        // beta.118: read the count BEFORE draining. `drain()` clears the slot
        // map, so reading after it always audited `slots: 0` -- and this line is
        // the only evidence of how much parallelism a run actually bought.
        const slots = pool.createdCount;
        await pool.drain();
        this.deps.state.audit("loop.parallel_pool_drained", { sessionId, cycle, slots }, sessionId);
      }

      if (failed.err) {
        // beta.55 (B2): a resumable clarification pause takes precedence over a
        // hard-fail. The sub-task DID fail verification (failed.err set), but
        // if we captured a clarification request we pause instead of dying, so
        // a human can unblock the exact sub-task rather than restart the run.
        if (clarify.question) {
          return this.finaliseAwaitingClarification(sessionId, clarify.question, clarify.seq, cycle, totalCost, clarify.subtask);
        }
        // beta.64 (P0-3): best-effort verify already pushed a graceful reviewable
        // PR (verify sub-task timed out but the prior probe was green + clean
        // diff). The session row is already terminal `done`; return shipped.
        if (failed.err === "__best_effort_shipped__") {
          const bePr = this.deps.state.db.prepare(`SELECT final_pr_url FROM sessions WHERE id = ?`).get(sessionId) as { final_pr_url: string | null } | undefined;
          return { status: "shipped", sessionId, prUrl: bePr?.final_pr_url ?? "", cycles: cycle, totalCostUsd: totalCost };
        }
        if (failed.err === "user_abort_reaction") return this.finaliseAbort(sessionId, "user_abort_reaction", cycle, totalCost);
        if (failed.err === "hard_timeout") return this.finaliseAbort(sessionId, "hard_timeout", cycle, totalCost);
        if (failed.err === "budget_exhausted") return this.finaliseAbort(sessionId, "budget_exhausted", cycle, totalCost);
        // beta.78 (Feature 2): per-user daily hard-cap abort.
        if (failed.err === "daily_max_exhausted") return this.finaliseAbort(sessionId, "daily_max_exhausted", cycle, totalCost);
        return this.finaliseFailed(sessionId, String(failed.err), cycle, totalCost);
      }

      // 2b. Reviewing
      // beta.7 fix #2 (hard cap inside review): don't start the adversary if
      // we can't afford it. Estimate review cost from the priciest observed
      // sub-task (reviews scan the whole diff, so they scale with work done),
      // falling back to a conservative reserve. Abort at the cycle boundary
      // rather than blowing the budget by ~$0.83 on a review we can't pay for.
      {
        const reactions = await this.deps.readReactions(sessionId);
        const reviewEstimate = this.estimateReviewCost(subTaskCosts);
        // beta.78 (Feature 2): the review-gate hard abort now keys off the
        // per-user DAILY cap, not the (soft) session budget. Crossing the
        // session budget only WARNS; a review is only skipped/aborted when
        // paying for it would blow the user's daily_max_usd. budgetBump
        // (:moneybag:) still overrides.
        const dailyMax = this.dailyMaxUsd();
        const dailySoFar = this.safeDailySpend(row.requester);
        const dailyWouldExceed = dailyMax > 0 && dailySoFar + reviewEstimate > dailyMax;
        if (!reactions.budgetBump && dailyWouldExceed) {
          // beta.8 (adversary point): the adversary was the only actor that
          // caught the beta.6 confabulation, and beta.7's review-budget abort
          // HID that failure by skipping review on cost. The observable-side-
          // effect check is ~$0 in tokens, so run it UNCONDITIONALLY before
          // aborting. This is the harness's own trust-but-verify guardrail;
          // it must never be bypassed purely on token budget.
          await this.runCheapObservableCheck(sessionId, plan, row.requester);
          this.deps.state.audit(
            "loop.review_budget_abort",
            { sessionId, cycle, totalCost, reviewEstimate, dailySoFar, dailyMax, reason: "daily_max" },
            sessionId,
          );
          this.warnDailyMaxHit(sessionId, row.requester, dailySoFar, dailyMax);
          return this.finaliseAbort(sessionId, "daily_max_exhausted", cycle, totalCost);
        }
      }
      // beta.81 (Track B / B4): the beta.63 LOCAL check-script runner is RETIRED
      // from the verification spine. Carel: "the harness should code, not try and
      // run it locally ... I do not want it to run locally, ever." Verification
      // is CI-only now (the post-push getCombinedStatus poll, B2). The runner is
      // fully off by default (verify.run_repo_check_scripts defaults to false in
      // beta.81); runFinalVerifyChecks early-returns [] in that case, so no local
      // typecheck/lint/test/build runs here. The runCheckScripts plumbing is
      // kept ONLY for the tryScriptedVerifyFallback rescue of a timed-out
      // observe VERIFY sub-task (a deterministic diff/tsc rescue), NOT as a
      // verify gate. An operator can still opt back in by setting
      // verify.run_repo_check_scripts:true, but the default path is CI-only.
      const conventionFindings = await this.runFinalVerifyChecks(sessionId, plan, cycle);
      // beta.94 (Feature 1b): deterministic harness-side scope check -- replaces
      // the elided LLM "final verification of scope boundaries" sub-task. Folds
      // any out-of-scope committed file into the review as a `fit`/`medium`
      // finding (never a hard fail). Same findings-return pattern.
      // beta.110: ScopeBlowoutError is deliberately NOT caught here. It ends
      // the run before the adversary is asked to review an unreviewable diff,
      // and the outer handler preserves the worktree so the good commits that
      // ARE in it stay recoverable. Ordinary scope creep is still a finding.
      const scopeFindings = await this.runFinalScopeCheck(sessionId, plan, cycle);
      if (scopeFindings.length > 0) conventionFindings.push(...scopeFindings);
      // beta.111: a branch that does not compile must not reach a merge
      // recommendation. The adversary reads the diff, not the compiler.
      const typeFindings = await this.runTypecheckGate(sessionId, plan, cycle);
      if (typeFindings.length > 0) conventionFindings.push(...typeFindings);

      this.setStatus(sessionId, "reviewing");
      await this.deps.reportProgress?.(sessionId, "reviewing", { cycle });
      let runtime: RuntimeSnapshot | undefined;
      try {
        runtime = await this.deps.fetchRuntime?.({ plan, sessionId });
      } catch (err) {
        this.deps.logger.warn("[loop] fetchRuntime failed", { err: String(err) });
      }
      // beta.7 fix #1: if no external runtime is available, synthesise a
      // "local" runtime snapshot from this cycle's verification audits so
      // the adversary still gets observable-output ground truth.
      if (!runtime) {
        const localVerification = this.readLocalVerification(sessionId);
        if (localVerification.length > 0) {
          const anyFailed = localVerification.some((v) => !v.ok);
          runtime = {
            provider: "local",
            status: anyFailed ? "unavailable" : "ok",
            logsExcerpt: localVerification
              .map((v) => `sub-task ${v.seq}: ${v.ok ? "VERIFIED" : "FAILED"} — ${v.summary}`)
              .join("\n"),
            errorCount: localVerification.filter((v) => !v.ok).length,
            localVerification,
          };
        }
      }
      // beta.101: LEDGER-COMMIT REACHABILITY GUARD. Runs BEFORE the adversary
      // SDK call so a branch that has lost work costs nothing to detect.
      //
      // b100 (session 3c6c1608) shipped six recorded commits into the void and
      // then paid for a review of a diff that contained none of them. The
      // adversary had to infer the problem from absence and blocked with
      // findings about "missing" work that had actually been written. Every
      // input needed to catch this deterministically was already in the DB.
      let ledgerUnreachable: string[] = [];
      if (this.deps.config.loop.ledger_reachability_guard_enabled !== false) {
        const check = await this.checkLedgerReachability(sessionId, plan.worktreePath, cycle, "review");
        ledgerUnreachable = check.unreachable;
        if (check.failed) {
          this.deps.logger.error("[loop] recorded sub-task commits are unreachable from HEAD; refusing to review or ship an incomplete branch", {
            sessionId, cycle, headSha: check.headSha, unreachable: check.unreachable,
          });
          // Fail rather than pause: a text answer cannot restore a branch, and
          // reviewing or shipping this diff would silently omit work the run
          // already did. The commits survive under the rescue refs.
          return this.finaliseFailed(sessionId, `ledger_commits_unreachable: ${check.detail}`, cycle, totalCost);
        }
      }

      this.emitPhaseTiming(sessionId, "executing", cycle, executeStart, {
        subTasks: plan.subTasks.length,
      });

      // beta.108: a revise cycle that moved the branch tip nowhere has nothing
      // for the adversary to review, and re-reviewing an unchanged diff cannot
      // do anything but re-emit the previous cycle's findings.
      //
      // The b106 revise (session 21c9c44e) closed exactly this way: cycle 3
      // dispatched five sub-tasks, four came back `subtask_revise_no_change`,
      // and the run still paid for a full adversary pass over the whole branch
      // to change two files. When NOTHING commits, that pass is pure cost.
      //
      // Guarded tightly: only on a revise cycle (cycle > 1, so a first cycle
      // that legitimately produced no diff still gets reviewed), only when we
      // could actually read both shas (an unreadable sha must not be mistaken
      // for "no change"), and only when a prior review exists to carry forward
      // as the verdict.
      if (
        this.deps.config.loop.early_exit_no_change_cycle !== false &&
        cycle > 1 &&
        lastReview &&
        cycleBaseSha &&
        this.deps.worktreeHeadSha
      ) {
        const tipNow = await this.deps.worktreeHeadSha(plan.worktreePath).catch(() => "");
        if (tipNow && tipNow === cycleBaseSha) {
          this.deps.state.audit(
            "loop.cycle_no_change_early_exit",
            { sessionId, cycle, headSha: tipNow, carriedFindings: lastReview.findings?.length ?? 0 },
            sessionId,
          );
          this.deps.logger.info(
            "[loop] revise cycle produced no commits; skipping a re-review of an unchanged diff and shipping on the prior verdict (beta.108)",
            { sessionId, cycle, headSha: tipNow },
          );
          terminalDoneReason = "shipped_no_change_cycle";
          break;
        }
      }

      let report: ReviewReport;
      // beta.63 (Part B): adversary SDK call boundary logging.
      const reviewStart = Date.now();
      this.deps.interactionLog?.logSdkRequest(sessionId, {
        role: "adversary", model: this.deps.config.models.adversary, phase: "review", cycle,
        prompt: `adversary review cycle ${cycle} for ${brief.title}; checklist: ${(plan.reviewChecklist ?? []).join("; ")}`,
      });
      try {
        // beta.43: bound the adversary SDK call by adversary_timeout_seconds
        // (previously declared in config but UNENFORCED on this await). A hung
        // reviewer froze the run at the review phase with no timeout.
        // beta.67 (Bug B): read the persisted fork-point sha and hand it to the
        // adversary so its diff is `git diff <plan_base_sha>..HEAD` -- ONLY
        // this branch's own commits. Also emit the cheap sanity log
        // (loop.adversary_diff_base) with the base + HEAD sha and the branch's
        // commit count; warn when the count is suspiciously high vs the plan's
        // sub-task count (the beta.66 smoke #4 signature).
        let adversaryBaseSha: string | undefined;
        try {
          const r = this.deps.state.db
            .prepare(`SELECT plan_base_sha FROM sessions WHERE id = ?`)
            .get(sessionId) as { plan_base_sha: string | null } | undefined;
          adversaryBaseSha = r?.plan_base_sha ?? undefined;
          if (adversaryBaseSha && this.deps.worktreeHeadSha) {
            const headSha = await this.deps.worktreeHeadSha(plan.worktreePath).catch(() => "");
            const commitCount = this.deps.worktreeCommitCount
              ? await this.deps.worktreeCommitCount(plan.worktreePath, adversaryBaseSha).catch(() => -1)
              : -1;
            const subTaskCount = plan.subTasks.length;
            const tooManyCommits = commitCount >= 0 && commitCount > Math.max(subTaskCount * 3, subTaskCount + 5);
            // beta.101: the b67 heuristic only ever asked "too MANY commits?".
            // The b100 smoke was the mirror image -- a diff of ONE commit while
            // six recorded sub-task commits were missing from it -- and scored
            // `suspicious: false`. Missing recorded work is at least as strong
            // a signal that the diff base is wrong as excess commits are.
            const missingLedgerCommits = ledgerUnreachable.length > 0;
            const suspicious = tooManyCommits || missingLedgerCommits;
            this.deps.state.audit("loop.adversary_diff_base", { sessionId, cycle, baseSha: adversaryBaseSha, headSha, commitCount, subTaskCount, suspicious, tooManyCommits, missingLedgerCommits, unreachableLedgerCommits: ledgerUnreachable }, sessionId);
            if (tooManyCommits) {
              this.deps.logger.warn("[loop] adversary diff commit count is suspiciously high vs sub-task count -- diff base may be wrong", { sessionId, commitCount, subTaskCount, baseSha: adversaryBaseSha });
            }
            if (missingLedgerCommits) {
              this.deps.logger.warn("[loop] adversary diff is missing recorded sub-task commits -- diff base or branch may be wrong", { sessionId, unreachable: ledgerUnreachable, baseSha: adversaryBaseSha });
            }
          } else {
            this.deps.state.audit("loop.adversary_diff_base", { sessionId, cycle, baseSha: adversaryBaseSha ?? null, headSha: null, commitCount: -1, subTaskCount: plan.subTasks.length, fallback: !adversaryBaseSha }, sessionId);
          }
        } catch (err) {
          this.deps.logger.warn("[loop] adversary_diff_base sanity log failed (non-fatal)", { sessionId, err: String(err) });
        }
        report = await withTimeout(
          this.deps.runAdversary({ brief, plan, runtime, requester: row.requester, baseSha: adversaryBaseSha, priorFindings: lastReview?.findings }),
          this.deps.config.loop.adversary_timeout_seconds,
          "adversary_timeout_seconds",
        );
        this.deps.interactionLog?.logSdkResponse(sessionId, {
          role: "adversary", model: this.deps.config.models.adversary, phase: "review", cycle,
          finishReason: report.verdict, costUsd: report.costUsd, durationMs: Date.now() - reviewStart,
          outputChars: report.summary ? report.summary.length : undefined, sdkSessionId: report.sdkSessionId,
        });
        // beta.62 (fix #1): the post-review persist awaits (recordSpend,
        // saveReview) were OUTSIDE any try/catch. A throw there propagated
        // uncaught out of runInner -> run()'s try/finally -> the external
        // fire-and-forget `.catch` which only logs to api.logger (NOT the
        // audit_log DB). Combined with the non-timeout review error below
        // emitting NO audit, this produced the b60-attempt-2 signature: no
        // `loop.review` event, no crash event, `status=failed` with a multi-
        // minute gap -- indistinguishable from a stall. Fold them into the
        // same try so any failure surfaces as `loop.review_failed`.
        totalCost += report.costUsd;
        this.addCost(sessionId, report.costUsd);
        await this.deps.budget.recordSpend(row.requester, report.costUsd, sessionId);
        this.saveReview(sessionId, cycle, report);
        // beta.83 (#2): the session-budget SOFT warn also fires here, after the
        // adversary review's cost lands. Pre-beta.83 the ONLY soft-warn check
        // was inside runOne (the sub-task loop), so a run that crossed its
        // session budget DURING the review (the DR/BCP run, session 37b01e86:
        // $11.62 -> $12.27 = 123% across the review) never warned -- the warn
        // path was simply never reached. Now the review path re-checks the
        // LIVE total and warns once if it just crossed. `sessionBudgetWarned`
        // is the same runInner-scoped latch, so we still warn at most once.
        if (totalCost > row.budget_usd && !sessionBudgetWarned) {
          sessionBudgetWarned = true;
          this.deps.state.audit(
            "loop.session_budget_warn",
            { sessionId, phase: "review", cycle, totalCost, sessionBudget: row.budget_usd },
            sessionId,
          );
          this.warnSessionBudgetSoft(sessionId, row.requester, totalCost, row.budget_usd);
        }
        // beta.69 (F5): if the user cancelled while the adversary SDK call was
        // in flight (forensic 1f2e6642: cycle-3 review landed 2s AFTER the
        // cancel and was persisted + transitioned on), discard this review and
        // abort cleanly. We still record the spend already incurred (honest
        // accounting) but do NOT let a post-cancel verdict drive a transition.
        const postReviewReactions = await this.deps.readReactions(sessionId);
        if (postReviewReactions.abort) {
          this.deps.state.audit("loop.review_discarded_post_cancel", { sessionId, cycle, verdict: report.verdict }, sessionId);
          this.deps.logger.info("[loop] adversary review completed after user cancel; discarding verdict and aborting", { sessionId, cycle });
          return this.finaliseAbort(sessionId, "user_abort_reaction", cycle, totalCost);
        }
      } catch (err) {
        // beta.43: a hung reviewer is a distinct, already-audited class.
        const isTimeout = err instanceof WorkerTimeoutError;
        if (isTimeout) {
          this.deps.state.audit("loop.adversary_timeout", { sessionId, cycle, adversary_timeout_seconds: this.deps.config.loop.adversary_timeout_seconds }, sessionId);
        }
        // beta.62 (fix #1): ALWAYS emit a structured crash event so the audit
        // trail never just stops mid-review. This is the telemetry that was
        // missing -- without it a review crash is invisible until you read the
        // sessions row's status column directly.
        this.deps.interactionLog?.logSdkResponse(sessionId, {
          role: "adversary", model: this.deps.config.models.adversary, phase: "review", cycle,
          finishReason: isTimeout ? "timeout" : "error", durationMs: Date.now() - reviewStart,
        });
        this.deps.interactionLog?.log(sessionId, { event: "review_failed", phase: "review", cycle, isTimeout, error: String((err as Error)?.message ?? err) });
        this.deps.state.audit(
          "loop.review_failed",
          { sessionId, cycle, isTimeout, error: String((err as Error)?.message ?? err) },
          sessionId,
        );
        this.deps.logger.error("[loop] adversary review crashed", { sessionId, cycle, isTimeout, err: String(err) });
        // beta.110: time the review even when it fails, especially then.
        //
        // On PR #932 session `9217236c` the adversary hung for a full 900s and
        // the session died -- and because phase_timing only fired on success,
        // the audit log shows one `executing` event and nothing else. The
        // single most expensive stretch of the run was the one stretch with no
        // number against it, and the 15 minutes had to be inferred by
        // subtracting timestamps.
        this.emitPhaseTiming(sessionId, "review", cycle, reviewStart, {
          verdict: null,
          isTimeout,
          error: String((err as Error)?.message ?? err).slice(0, 200),
        });
        // beta.62 (fix #2/#3): try to salvage the run rather than discard the
        // completed, self-verified work. Returns a terminal outcome either way.
        return await this.finaliseReviewCrash(sessionId, err, cycle, totalCost, { plan, brief, lastReview, row });
      }
      // beta.63 (Fix 2): fold the convention-check failures into the review as
      // REVISE-worthy findings. If the adversary said `pass` but a declared
      // check script failed, downgrade to `revise` so the worker gets another
      // cycle to fix the convention violation (e.g. regenerate the OKF bundle).
      // Never escalates to `block` (not a hard fail) -- max-cycles still ships.
      //
      // beta.70 (F2): only force `pass`->`revise` when a convention finding is
      // actually BLOCKING (diff_addressable + medium+). A `process`-class
      // convention finding -- e.g. "OKF bundle not regenerated" -- is enforced
      // by the convention-check phase itself (it re-runs the regenerator) and
      // must NOT force another expensive code cycle. In PR #870 this exact
      // force-upgrade turned a clean `pass` into a 19-min cycle-2 that re-ran
      // `npm run okf` over 1436 files for a zero diff. All findings still
      // attach to the report (they ship on the PR body); only the verdict is
      // gated. A real typecheck/lint failure or a persisted heap OOM stays
      // blocking and still triggers the revise.
      if (conventionFindings.length > 0) {
        const blockingConvention = conventionFindings.filter((f) =>
          isBlockingFinding(f, classifyFinding(f, { repoHasTestScript: true })),
        );
        report = {
          ...report,
          findings: [...report.findings, ...conventionFindings],
          verdict:
            report.verdict === "pass" && blockingConvention.length > 0
              ? "revise"
              : report.verdict,
        };
        if (report.verdict === "pass" && blockingConvention.length === 0 && conventionFindings.length > 0) {
          this.deps.state.audit("loop.convention_findings_nonblocking", { sessionId, cycle, total: conventionFindings.length }, sessionId);
        }
      }
      lastReview = report;
      // beta.69 (F1): visibility for the convergence gate. When the adversary's
      // raw verdict was `revise` but the final verdict is `pass` AND there were
      // no real convention failures, the run converged on a green cycle whose
      // only remaining findings were non-blocking (process/env/architectural/
      // unproven-runtime). This is the fix for forensic 1f2e6642's cycle-2
      // all-green revise. (The downgrade itself happens in runAdversary; here
      // we just record that the loop is now shipping instead of churning.)
      if (report.verdict === "pass" && conventionFindings.length === 0 && (report.findings?.length ?? 0) > 0) {
        this.deps.state.audit("loop.converged_on_green", { sessionId, cycle, findings: report.findings.length }, sessionId);
      }
      this.deps.state.audit("loop.review", { sessionId, cycle, verdict: report.verdict, findings: report.findings.length, conventionFindings: conventionFindings.length }, sessionId);
      // beta.108: the review phase is the largest UNMEASURED block in a run.
      // The b106 revise (session 21c9c44e) reported a 55.2-minute wall clock of
      // which planning (574s) and worker execution (1499s) account for 35
      // minutes; the other ~20 were review, push, PR update and CI polling, and
      // nothing timed any of them. We were optimising the two thirds we could
      // see. Emit the phase duration so the next speed decision has a number
      // behind it.
      this.emitPhaseTiming(sessionId, "review", cycle, reviewStart, {
        verdict: report.verdict,
        findings: report.findings.length,
        costUsd: report.costUsd,
      });
      // beta.97 (Fix #7): record this cycle's finding count for the convergence check.
      findingCountsByCycle.push(report.findings?.length ?? 0);

      const reactions = await this.deps.readReactions(sessionId);
      const blockingFindings = this.countBlockingFindings(report.findings);
      this.deps.state.audit(
        "loop.blocking_findings",
        { sessionId, cycle, verdict: report.verdict, findings: report.findings?.length ?? 0, blockingFindings },
        sessionId,
      );
      const decision = OrchestratorLoop.advance({
        currentStatus: "reviewing",
        verdict: report.verdict,
        blockingFindings,
        shipWhenNoBlockingFindings: this.deps.config.loop.ship_when_no_blocking_findings !== false,
        cyclesRan: cycle,
        maxCycles: this.deps.config.loop.max_cycles,
        findingCountsByCycle,
        reactions,
        // beta.78 (Feature 2): whether to run ANOTHER cycle is gated by the
        // per-user DAILY cap, not the (now-soft) session budget. Crossing the
        // session budget warns but does not stop; only the daily hard-cap
        // (or :moneybag: override) blocks a further cycle.
        budgetExhausted:
          !reactions.budgetBump &&
          this.dailyMaxUsd() > 0 &&
          this.safeDailySpend(row.requester) > this.dailyMaxUsd(),
        hardTimeout: Date.now() > hardDeadlineMs,
      });
      this.deps.state.audit("loop.transition", { sessionId, from: "reviewing", ...decision }, sessionId);

      if (decision.nextStatus === "done") {
        terminalDoneReason = decision.reason;
        break;
      }
      if (decision.nextStatus === "failed") {
        return this.finaliseFailed(sessionId, decision.reason, cycle, totalCost);
      }
      if (decision.nextStatus === "aborted") {
        return this.finaliseAbort(sessionId, decision.reason, cycle, totalCost);
      }
      // else "executing": continue the outer while
    }

    // 3. Push + PR
    if (!lastReview) {
      return this.finaliseFailed(sessionId, "no_review_produced", cycle, totalCost);
    }
    let prUrl: string;
    // beta.63 (Part A): mark finalize START so the watchdog sees the push/PR
    // phase as live (this is exactly the b60 gap: quiet AFTER the last sub-task
    // deadline but BEFORE/at finalize, with no watchdog covering it).
    this.markProgress(sessionId, "finalize_start", "finalize", { cycle });
    // beta.108: everything from here to `loop.shipped` -- push, PR open/update,
    // review comment, CI polling -- was untimed. See emitPhaseTiming.
    const shipStart = Date.now();
    // beta.73 (D3): instrument the push/PR-open step. Pre-beta.73 there was NO
    // audit event between the transition->done and the terminal worktree
    // release, so a push/PR failure (422 branch collision, missing GH token, a
    // bare exception) was completely invisible (session 70341bc3). Emit an
    // explicit start + failure event carrying the underlying error.
    this.deps.state.audit("loop.pr_open_started", { sessionId, cycle, branch: plan.branch }, sessionId);
    // beta.81 (Track B / B3): if the repo has NO CI, AUTHOR a GitHub Actions
    // workflow running the repo's declared check scripts and COMMIT it into the
    // worktree BEFORE the push, so verification runs on GitHub (Carel: build the
    // CI, never run locally). ciAuthorWorkflow returns null when a workflow
    // already exists or nothing is runnable. Best-effort: a failure here must
    // not block the push (the PR + review already stand); it just means no CI.
    let authoredWorkflowThisCycle = false;
    if (this.deps.ciAuthorWorkflow) {
      try {
        const authored = await this.deps.ciAuthorWorkflow({ worktreePath: plan.worktreePath });
        if (authored) {
          authoredWorkflowThisCycle = true;
          this.deps.state.audit("loop.ci_workflow_authored", { sessionId, cycle, path: authored.path, scripts: authored.scripts }, sessionId);
          this.deps.interactionLog?.log(sessionId, { event: "ci_workflow_authored", phase: "finalize", cycle, path: authored.path, scripts: authored.scripts });
          this.deps.logger.info("[loop] authored a GitHub Actions workflow for a no-CI repo (beta.81 B3)", { sessionId, path: authored.path, scripts: authored.scripts });
        }
      } catch (err) {
        this.deps.logger.warn("[loop] CI workflow authoring failed (non-fatal; repo will simply have no CI)", { sessionId, err: String(err) });
      }
    }
    try {
      prUrl = await this.deps.pushBranchAndOpenPr({ plan, brief, reviewReport: lastReview, requester: row.requester });
    } catch (err) {
      this.deps.state.audit("loop.pr_open_failed", { sessionId, cycle, branch: plan.branch, error: String(err) }, sessionId);
      this.deps.interactionLog?.log(sessionId, { event: "pr_open_failed", phase: "finalize", cycle, error: String(err) });
      return this.finaliseFailed(sessionId, `pr_error: ${String(err)}`, cycle, totalCost);
    }
    // beta.63 (Part A): PR opened -- mark progress before the terminal write.
    this.markProgress(sessionId, "pr_opened", "finalize", { cycle });
    // beta.81 (Track B / B2): POST-PUSH CI VERIFICATION WAIT-STATE. Now that the
    // branch is on GitHub, poll CI and fold the result into the terminal
    // recommendation. success -> ship as normal (review verdict drives the
    // merge rec below). failure -> flag needs_human_review with the failing CI
    // logs as the recorded reason (the revise finding source). timeout ->
    // SOFT checkpoint: keep the PR open, needs_human_review, offer a resumable
    // continue-watch (never a hard fail). none/skipped -> ship on the review
    // verdict (a no-CI repo just got a workflow authored above but its FIRST
    // status may not exist yet on this SHA; do not block the deliverable).
    let ciOverride: { recommendation: "needs_human_review"; reason: string } | null = null;
    // beta.91 (F4): non-blocking caveat when an authored workflow never registered.
    let ciNeverRegisteredCaveat: string | null = null;
    {
      let headSha = "";
      try {
        headSha = this.deps.worktreeHeadSha ? await this.deps.worktreeHeadSha(plan.worktreePath).catch(() => "") : "";
      } catch { headSha = ""; }
      if (headSha && this.deps.ciCombinedStatus) {
        this.setStatus(sessionId, "reviewing");
        this.markProgress(sessionId, "ci_wait", "finalize", { cycle, sha: headSha });
        const ci = await this.pollCiStatus({ sessionId, repoFullName: plan.repo, sha: headSha, requester: row.requester, workflowAuthoredThisSession: authoredWorkflowThisCycle });
        if (ci.outcome === "failure") {
          ciOverride = {
            recommendation: "needs_human_review",
            reason:
              `GitHub CI FAILED on ${headSha}. Do NOT merge until CI is green. Failing check logs (excerpt):\n` +
              `${(ci.logs || "(no log excerpt available)").slice(0, 1500)}`,
          };
        } else if (ci.outcome === "timeout") {
          ciOverride = {
            recommendation: "needs_human_review",
            reason:
              `CI still running after ${Math.round(ci.waitedSeconds / 60)} min on ${headSha}. ` +
              `The PR is open; CI has not reported a verdict yet. Re-check CI on GitHub, or resume watching via harness_progress -- this is a soft checkpoint, not a failure.`,
          };
        } else if (ci.outcome === "authored_workflow_never_registered") {
          // beta.91 (F4): we authored + pushed a workflow this cycle but GitHub
          // never registered a run within the grace window. NON-blocking: the
          // merge recommendation is NOT overridden to needs_human_review (that
          // would be too aggressive for a registration lag), but the caveat is
          // surfaced so a human knows CI never actually verified this SHA.
          this.deps.state.audit("loop.ci_authored_never_registered", { sessionId, cycle, sha: headSha, waitedSeconds: ci.waitedSeconds }, sessionId);
          this.deps.logger.warn("[loop] authored a CI workflow but GitHub never registered a run within the grace window; shipping with a visible caveat (CI did NOT verify this SHA)", { sessionId, sha: headSha, waitedSeconds: ci.waitedSeconds });
          ciNeverRegisteredCaveat =
            `NOTE: the harness authored a CI workflow but GitHub did not register a run on ${headSha} within ${ci.waitedSeconds}s. CI did NOT verify this commit -- confirm the workflow ran (or re-run it) before relying on a green check.`;
        }
      }
    }
    // beta.34: derive the post-ship MERGE / DO-NOT-MERGE recommendation from
    // the final review + whether we reached a clean pass. Persist it + the PR
    // number for the harness_merge_pr hard gate.
    const reachedCleanPass = lastReview.verdict === "pass";
    const rec = deriveMergeRecommendation({
      review: { verdict: lastReview.verdict, findings: lastReview.findings ?? [] },
      // beta.109: so a `revise` carrying only lows is recommended for merge
      // rather than blocked on the verdict word alone.
      blockingFindings: this.countBlockingFindings(lastReview.findings),
      reachedCleanPass,
      ciStatus: undefined, // the merge tool re-checks CI at merge time
    });
    // beta.81 (Track B / B2): a CI failure/timeout OVERRIDES the review-derived
    // recommendation to needs_human_review -- CI is the verification spine, so
    // a red or still-running CI must never be recommended for merge.
    const finalRecommendation = ciOverride?.recommendation ?? rec.recommendation;
    let finalReason = ciOverride ? `${ciOverride.reason}\n\n(review verdict: ${lastReview.verdict}; ${rec.reason})` : rec.reason;
    // beta.91 (F4): append the never-registered caveat to whatever reason we have
    // (merge still recommended, but the human sees CI did not verify the SHA).
    if (ciNeverRegisteredCaveat) finalReason = `${finalReason}\n\n${ciNeverRegisteredCaveat}`;
    // beta.97 (Fix #7): if we shipped on max-cycles with a CONVERGING finding
    // trend, append an explicit ask-to-extend note. The merge recommendation is
    // UNCHANGED (still do_not_merge / needs_human_review); this is purely the
    // operator-facing signal that one more revise cycle was plausibly worth it,
    // rather than a bare do_not_merge with no context.
    if (terminalDoneReason === "shipped_max_cycles_revise_converging") {
      const arc = findingCountsByCycle.join(" → ");
      finalReason =
        `${finalReason}\n\nCONVERGING: adversary findings were trending down across cycles (${arc}) but the run hit the ${this.deps.config.loop.max_cycles}-cycle ceiling before a clean pass. ` +
        `This looks worth extending: re-run \`harness_revise\` on this PR to continue from the current findings — a clean sign-off was plausibly one or two cycles away.`;
      this.deps.state.audit(
        "loop.max_cycles_extend_suggested",
        { sessionId, findingCountsByCycle, maxCycles: this.deps.config.loop.max_cycles },
        sessionId,
      );
    }
    const prNumber = parsePrNumber(prUrl);
    this.deps.state.db
      .prepare(
        `UPDATE sessions SET final_pr_url = ?, pr_number = ?, merge_recommendation = ?, merge_recommendation_reason = ?, status = 'done', updated_at = ? WHERE id = ?`,
      )
      .run(prUrl, prNumber ?? null, finalRecommendation, finalReason, Date.now(), sessionId);
    this.deps.state.audit(
      "loop.shipped",
      { sessionId, prUrl, prNumber, mergeRecommendation: finalRecommendation, reason: finalReason, ciOverride: !!ciOverride },
      sessionId,
    );
    this.emitPhaseTiming(sessionId, "ship", cycle, shipStart, {
      prNumber,
      mergeRecommendation: finalRecommendation,
    });
    // beta.16 fix #3 + beta.17 correctness: prune the worktree on
    // `loop.shipped`. Beta.16 emitted the audit event but the underlying
    // release() silently no-op'd because it reconstructed the path from
    // sessionId (a UUID) while the allocator used `pending-<Date.now()>`
    // on-disk ids. Beta.17 threads the actual `worktree_path` from the
    // sessions row into the release call.
    await this.tryReleaseWorktree(sessionId, plan.repo, plan.worktreePath, "shipped");
    return { status: "shipped", sessionId, prUrl, cycles: cycle, totalCostUsd: totalCost };
  }

  /**
   * beta.70 (F5): did THIS observe sub-task already complete cleanly in a
   * PRIOR cycle? Used to skip a redundant observe re-probe on a revise cycle.
   * Returns the prior cycle + status when a `sub_tasks` row exists at the same
   * seq, in an earlier cycle, with a completed/no-change status. Conservative:
   * a prior FAILED observe returns null (we re-run it). Best-effort; on any DB
   * error returns null (never blocks the run).
   */
  private priorObserveCompleted(
    sessionId: string,
    cycle: number,
    seq: number,
  ): { cycle: number; status: string } | null {
    try {
      const row = this.deps.state.db
        .prepare(
          `SELECT cycle, status FROM sub_tasks
           WHERE session_id = ? AND seq = ? AND cycle < ?
             AND status IN ('completed', 'completed_no_change')
           ORDER BY cycle DESC LIMIT 1`,
        )
        .get(sessionId, seq, cycle) as { cycle: number; status: string } | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  /**
   * beta.16 fix #2: helper for emitting the `loop.subtask_observe_completed`
   * audit breadcrumb. Fires exactly once per observe-mode sub-task terminal
   * success. Payload is intentionally similar to `loop.subtask_verification`
   * so downstream consumers can treat the two events uniformly.
   */
  private emitObserveCompleted(
    sessionId: string,
    st: LeadPlanSubTask,
    result: WorkerResult,
    contract: unknown[],
  ): void {
    this.deps.state.audit(
      "loop.subtask_observe_completed",
      {
        sessionId,
        seq: st.seq,
        taskMode: st.taskMode ?? "unspecified",
        verify_count: contract.length,
        worker_files_touched: result.filesChanged ?? [],
        worker_commit_sha: result.commitSha ?? null,
        worker_end_reason: result.reason ?? null,
        cost_usd: result.costUsd,
      },
      sessionId,
    );
  }

  /**
   * beta.16 fix #3 + beta.17 telemetry: best-effort worktree release.
   * Called on all terminal transitions (shipped/aborted/failed). Never
   * throws — worktree cleanup failures are logged, audited, and swallowed
   * so they cannot fail an already-terminal session.
   *
   * beta.17: audit payload now carries `{ok, path, error?}` on both the
   * success and failure events so operators can distinguish
   * event-fired-but-nothing-happened from event-fired-and-succeeded.
   * Beta.16's `loop.worktree_released` was a lie on production because
   * the underlying release() silently no-op'd (see releaseByPath docs).
   */
  private async tryReleaseWorktree(sessionId: string, repoFullName: string, worktreePath: string, reason: "shipped" | "aborted" | "failed"): Promise<void> {
    if (!this.deps.releaseWorktree) return;
    try {
      const outcome = await this.deps.releaseWorktree({ sessionId, repoFullName, worktreePath, reason });
      if (outcome.ok) {
        this.deps.state.audit(
          "loop.worktree_released",
          { sessionId, reason, ok: true, path: outcome.path ?? worktreePath, ...(outcome.error ? { note: outcome.error } : {}) },
          sessionId,
        );
      } else {
        this.deps.logger.warn("[loop] worktree release reported not-ok", { sessionId, reason, worktreePath, err: outcome.error });
        this.deps.state.audit(
          "loop.worktree_release_failed",
          { sessionId, reason, ok: false, path: outcome.path ?? worktreePath, error: outcome.error ?? "unknown" },
          sessionId,
        );
      }
    } catch (err) {
      // The releaseWorktree impl threw synchronously / rejected. Different
      // failure mode from ok:false, but the operator surface is the same.
      this.deps.logger.warn("[loop] worktree release threw", { sessionId, reason, worktreePath, err: String(err) });
      this.deps.state.audit(
        "loop.worktree_release_failed",
        { sessionId, reason, ok: false, path: worktreePath, error: String(err) },
        sessionId,
      );
    }
  }

  /**
   * Pull the latest verification outcome per sub-task from the audit log,
   * to feed the adversary as local runtime data (beta.7 fix #1).
   */
  /**
   * beta.8: cheap, unconditional final observable check. Independently asks
   * the provider whether the branch exists on origin (the single most
   * important fact: did anything actually reach the remote?). Runs even when
   * the review budget is exhausted, because it costs ~$0 in tokens and is
   * the harness's last line of defence against a confabulated "it shipped".
   * Records loop.cheap_observable_check with the result.
   */
  private async runCheapObservableCheck(sessionId: string, plan: LeadPlan, requester: string): Promise<void> {
    if (!this.deps.buildVerifyProbes) return;
    try {
      const probes = this.deps.buildVerifyProbes({ plan, requester, worktreePath: plan.worktreePath, baseSha: "" });
      const branch = await probes.remoteBranchExists(plan.branch);
      this.deps.state.audit(
        "loop.cheap_observable_check",
        { sessionId, branch: plan.branch, remoteBranchExists: branch.exists, detail: branch.detail },
        sessionId,
      );
      if (!branch.exists) {
        this.deps.logger.warn("[loop] cheap observable check: branch NOT on remote at abort time", {
          sessionId, branch: plan.branch, detail: branch.detail,
        });
      }
    } catch (err) {
      this.deps.logger.warn("[loop] cheap observable check errored", { sessionId, err: String(err) });
    }
  }

  private readLocalVerification(sessionId: string): Array<{ seq: number; ok: boolean; summary: string }> {
    const rows = this.deps.state.db
      .prepare(
        `SELECT payload FROM audit_log
         WHERE session_id = ? AND event = 'loop.subtask_verification'
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as Array<{ payload: string }>;
    const bySeq = new Map<number, { seq: number; ok: boolean; summary: string }>();
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload) as { seq: number; ok: boolean; summary: string };
        if (typeof p.seq === "number") bySeq.set(p.seq, { seq: p.seq, ok: !!p.ok, summary: String(p.summary ?? "") });
      } catch {
        // ignore malformed audit rows
      }
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * beta.7 fix #2: project the cost of an upcoming sub-task. Prefer the
   * running median of ACTUAL costs (empirical, per-session), because token
   * estimates from the lead are notoriously optimistic. Fall back to the
   * plan's token estimate via the price table, then to a conservative
   * per-task reserve so we never project zero.
   */
  private estimateSubTaskCost(st: LeadPlanSubTask, observed: number[]): number {
    if (observed.length > 0) return median(observed);
    if (st.estimatedTokens > 0) {
      return estimateSubTaskCost(
        this.deps.config.models.worker,
        st.estimatedTokens,
        this.deps.config.models.price_overrides,
      );
    }
    return 0.25; // conservative reserve when we have nothing to go on
  }

  /**
   * beta.7 fix #2: estimate adversary review cost. Reviews scan the whole
   * diff, so cost scales with the work done: use the max observed sub-task
   * cost as a proxy, with a conservative floor.
   */
  private estimateReviewCost(observed: number[]): number {
    const floor = 0.5;
    if (observed.length === 0) return floor;
    return Math.max(floor, Math.max(...observed));
  }

  /**
   * beta.64 (P0-1 + P0-2): run ONE worker sub-task call bounded by
   * worker_timeout_seconds, emit the sdk_stream_opened / sdk_first_token /
   * sdk_response interaction-log events (P0-1), and RETRY ONCE on a FRESH SDK
   * session when the attempt times out (P0-2). A timeout is either:
   *   - the outer withTimeout throwing WorkerTimeoutError (full-turn worker
   *     timeout), OR
   *   - the inner first-token watchdog returning result.status ===
   *     'first_token_timeout' (stream opened, ZERO tokens -- beta.63 smoke #2).
   * Returns `{outcome:'ok', result}` on a usable turn (even a non-completed
   * end_turn -- the caller's verification handles that), or `{outcome:'timeout',
   * summary, failErr}` when the (possibly retried) call still timed out.
   * `worker_timeout_retry_enabled: false` disables the retry (still audits the
   * timeout). Max 1 retry per sub-task, mirroring the beta.53 env-wait pattern.
   */
  private async runWorkerCallWithRetry(p: {
    sessionId: string; st: LeadPlanSubTask; cycle: number; brief: CrystallisedBrief;
    plan: LeadPlan; requester: string; dispatchHint?: string; workerStart: number; subTaskId: string;
    /** beta.117: the leased slot; NOT plan.worktreePath when running parallel. */
    workerWorktree: string;
  }): Promise<{ outcome: "ok"; result: WorkerResult } | { outcome: "timeout"; summary: string; failErr: string }> {
    const { sessionId, st, cycle, brief, plan, requester, dispatchHint, workerWorktree } = p;
    const retryEnabled = this.deps.config.loop.worker_timeout_retry_enabled !== false;
    // beta.113: two attempts was one retry. Three gives the escalated
    // first-token window (below) somewhere to escalate to.
    const maxAttempts = retryEnabled ? Math.max(2, this.deps.config.loop.worker_timeout_max_attempts ?? 3) : 1;
    // beta.94 (Feature 2): capture the sub-task base sha ONCE so the idle-no-work
    // "did this sub-task touch files" probe can diff <subTaskBase>..HEAD. Absent
    // probe => the idle detector still tracks counts but the no-writes gate is
    // conservative (treats an unavailable diff as "no writes").
    const idleSubTaskBase = this.deps.worktreeHeadSha
      ? await this.deps.worktreeHeadSha(workerWorktree).catch(() => "")
      : "";

    let lastFirstToken = false;
    let lastSummary = "";
    let lastFailErr = "";
    // beta.113: widen the first-token deadline on each retry.
    //
    // The DR/BCP run died here. Sub-task 3 hit `phase2_first_token` on attempt
    // 1, the b64 retry fired exactly as designed, and attempt 2 hit
    // `phase2_first_token` again -- both against the same 30-second window.
    // Retrying a slow start against an identical deadline is not a retry, it is
    // the same experiment twice, and it cost a 56-minute, $9.41 run that had
    // eleven typecheck-clean commits and one blocking finding left to fix.
    //
    // 30s is fine for a small dispatch and tight for a large one: this worker
    // carried a revise context, a dispatch hint and 18 ingested convention
    // files, and a model that thinks before emitting can spend longer than that
    // before its first visible token. So each attempt gets the previous
    // window multiplied, capped, and always inside the full-turn timeout that
    // bounds everything anyway.
    const baseFirstToken = this.deps.config.loop.sdk_first_token_timeout_seconds ?? 30;
    const mult = this.deps.config.loop.worker_first_token_retry_multiplier ?? 3;
    const cap = Math.max(baseFirstToken, this.deps.config.loop.worker_first_token_retry_cap_seconds ?? 300);
    const firstTokenFor = (attempt: number) =>
      firstTokenWindowForAttempt(attempt, baseFirstToken, mult, cap);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        // beta.64 (P0-2): audit the retry BEFORE it runs, so a durable trail
        // shows we re-invoked on a fresh session (no resumeSessionId is passed
        // at this callsite, so the SDK opens a brand-new stream).
        this.deps.state.audit(
          "loop.worker_timeout_retry",
          { sessionId, seq: st.seq, attempt, priorKind: lastFirstToken ? "first_token_timeout" : "worker_timeout" },
          sessionId,
        );
        this.deps.interactionLog?.log(sessionId, {
          event: "worker_timeout_retry", phase: "worker", seq: st.seq, cycle, attempt,
          priorKind: lastFirstToken ? "first_token_timeout" : "worker_timeout",
        });
        this.deps.logger.warn("[loop] worker timed out; retrying once on a FRESH SDK session", {
          sessionId, seq: st.seq, attempt, priorKind: lastFirstToken ? "first_token_timeout" : "worker_timeout",
        });
      }
      const attemptStart = Date.now();
      let result: WorkerResult | null = null;
      let threwTimeout = false;
      // beta.81 (Track C / C1): PROVE the SDK re-entry actually happens on a
      // retry. Forensic d01a7484 logged `worker_timeout_retry attempt:2` but
      // then fired ZERO sdk_request/sdk_stream_opened for ~65 min -- the retry
      // executor died BETWEEN the audit log line and the runWorker call, so the
      // retry "log-then-noop"'d into silence with the sub-task row untouched.
      // This audit fires IMMEDIATELY before the (re-)invocation, so a retry that
      // never reaches runWorker is now distinguishable in the trail, and the
      // loop still cannot fall out of this method without a terminal outcome
      // (see the guaranteed `{outcome:'timeout'}` return below).
      if (attempt > 1) {
        this.deps.state.audit(
          "loop.worker_retry_reinvoked",
          { sessionId, seq: st.seq, attempt, worker_timeout_seconds: this.deps.config.loop.worker_timeout_seconds },
          sessionId,
        );
      }
      // beta.94 (Feature 2): a narrow idle-no-work ABORT channel. onStreamSlow
      // (when the conjunction holds AND loop.worker_idle_abort_enabled is true)
      // rejects this race with a WorkerTimeoutError, routing the sub-task into
      // the SAME timeout-class terminal ({outcome:'timeout'}) as a real worker
      // timeout -- worktree preserved, no new terminal path. When the abort flag
      // is off the reject is never called, so behaviour is unchanged.
      let idleAbortReject: ((e: Error) => void) | undefined;
      const idleAbortPromise = new Promise<never>((_resolve, reject) => { idleAbortReject = reject; });
      idleAbortPromise.catch(() => { /* swallow if the worker wins the race */ });
      try {
        // beta.90 (Feature 2): surface a worker stream that opens then goes idle
        // (no token delta) as loop.worker_stream_slow + a heartbeat bump.
        // beta.94 (Feature 2): also arm the idle-no-work conjunction detector.
        const onStreamSlow = this.makeStreamSlowCallback(sessionId, st.seq, cycle, {
          plan,
          baseSha: idleSubTaskBase,
          onIdleAbort: () => idleAbortReject?.(new WorkerTimeoutError(this.deps.config.loop.worker_timeout_seconds)),
        });
        result = await withTimeout(
          Promise.race([
            // beta.91 (Fix 3): mechanical sub-tasks -> cheaper worker model.
            this.deps.runWorker({
              brief, subTask: st, plan, requester, dispatchHint,
              // beta.117: the leased slot, which is NOT plan.worktreePath when
              // this sub-task is running in parallel.
              worktreePath: workerWorktree,
              modelOverride: selectWorkerModel(st, this.deps.config.models),
              onStreamSlow,
              firstTokenTimeoutSecondsOverride: firstTokenFor(attempt),
            }),
            idleAbortPromise,
          ]),
          this.deps.config.loop.worker_timeout_seconds,
        );
      } catch (err) {
        if (err instanceof WorkerTimeoutError) {
          threwTimeout = true;
        } else {
          // A non-timeout throw is NOT retried here -- surface it immediately as
          // the pre-beta.64 worker_error terminal (the caller marks it failed).
          this.deps.interactionLog?.logSdkResponse(sessionId, {
            role: "worker", model: this.deps.config.models.worker, phase: "worker", seq: st.seq, cycle,
            finishReason: "error", durationMs: Date.now() - attemptStart,
          });
          return { outcome: "timeout", summary: `worker threw: ${String(err)}`, failErr: `worker_error: ${String(err)}` };
        }
      }

      const firstTokenTimeout = !threwTimeout && result?.status === "first_token_timeout";
      if (!threwTimeout && result && !firstTokenTimeout) {
        // Usable turn. Emit P0-1 stream events + the sdk_response boundary.
        if (result.streamOpened) {
          this.deps.interactionLog?.logSdkStreamOpened(sessionId, {
            role: "worker", model: this.deps.config.models.worker, phase: "worker", seq: st.seq, cycle,
            sdkSessionId: result.sdkSessionId,
          });
        }
        if (typeof result.msToFirstToken === "number") {
          this.deps.interactionLog?.logSdkFirstToken(sessionId, {
            role: "worker", model: this.deps.config.models.worker, phase: "worker", seq: st.seq, cycle,
            msToFirstToken: result.msToFirstToken, sdkSessionId: result.sdkSessionId,
          });
        }
        this.deps.interactionLog?.logSdkResponse(sessionId, {
          role: "worker", model: this.deps.config.models.worker, phase: "worker", seq: st.seq, cycle,
          finishReason: result.reason ?? "end_turn", costUsd: result.costUsd,
          outputChars: result.finalMessage ? result.finalMessage.length : undefined,
          durationMs: Date.now() - attemptStart, sdkSessionId: result.sdkSessionId,
          finalMessageTail: result.finalMessage ? result.finalMessage.slice(-500) : undefined,
        });
        // A timed-out earlier attempt still cost tokens; account for the
        // retry's spend by returning the result (the caller adds result.costUsd).
        return { outcome: "ok", result };
      }

      // Timeout-class outcome for THIS attempt. Emit the boundary + audit.
      lastFirstToken = !!firstTokenTimeout;
      if (firstTokenTimeout && result?.streamOpened) {
        // The stream DID open; record that so the trail distinguishes
        // "POST hung before open" from "opened, no tokens".
        this.deps.interactionLog?.logSdkStreamOpened(sessionId, {
          role: "worker", model: this.deps.config.models.worker, phase: "worker", seq: st.seq, cycle,
          sdkSessionId: result.sdkSessionId,
        });
      }
      this.deps.interactionLog?.logSdkResponse(sessionId, {
        role: "worker", model: this.deps.config.models.worker, phase: "worker", seq: st.seq, cycle,
        finishReason: firstTokenTimeout ? "first_token_timeout" : "timeout", durationMs: Date.now() - attemptStart,
        sdkSessionId: result?.sdkSessionId,
      });
      if (firstTokenTimeout) {
        // beta.65 (P0): split-phase attribution. streamOpened=false => the
        // PHASE-1 (call-init -> stream-open) watchdog fired (the pre-stream POST
        // hang beta.64 missed); streamOpened=true => the PHASE-2 (stream-open ->
        // first-token) watchdog fired (the beta.63 smoke #2 case). Both audit
        // the same event + route into the same fresh-session retry.
        const phase = result?.streamOpened ? "phase2_first_token" : "phase1_stream_open";
        this.deps.state.audit(
          "loop.worker_first_token_timeout",
          {
            sessionId, seq: st.seq, attempt, phase, streamOpened: !!result?.streamOpened,
            sdk_first_token_timeout_seconds: firstTokenFor(attempt),
            sdk_stream_open_timeout_seconds: this.deps.config.loop.sdk_stream_open_timeout_seconds ?? 120,
          },
          sessionId,
        );
        lastSummary = result?.streamOpened
          ? `worker first_token_timeout (phase 2: stream opened, zero tokens) attempt ${attempt}`
          : `worker first_token_timeout (phase 1: stream never opened / pre-stream POST hang) attempt ${attempt}`;
        lastFailErr = `worker_first_token_timeout: seq ${st.seq}`;
      } else {
        this.deps.state.audit(
          "loop.worker_timeout",
          { sessionId, seq: st.seq, attempt, worker_timeout_seconds: this.deps.config.loop.worker_timeout_seconds },
          sessionId,
        );
        lastSummary = `worker_timeout attempt ${attempt}`;
        lastFailErr = `worker_timeout: seq ${st.seq}`;
      }
      // Loop continues to the retry attempt (if any); otherwise falls through.
    }
    // beta.81 (Track C / C1): a retried-but-still-timed-out sub-task MUST return
    // a terminal timeout outcome (the caller marks the row failed) -- NEVER a
    // no-op that leaves the sub-task row `running` forever. Guarantee a
    // non-empty summary/failErr so the terminal fail is always attributable.
    return {
      outcome: "timeout",
      summary: lastSummary || `worker_timeout (exhausted ${maxAttempts} attempt(s)) seq ${st.seq}`,
      failErr: lastFailErr || `worker_timeout: seq ${st.seq}`,
    };
  }

  /**
   * beta.64 (P0-4): SCRIPTED VERIFIER FALLBACK for an observe-mode VERIFY
   * sub-task whose LLM turn timed out. A "run tsc, diff, check scripts" verify
   * step needs no model: run `npx tsc --noEmit`, `git diff --stat <base>..HEAD`,
   * and the allowlisted repo check scripts (reusing the beta.63 discover/run
   * plumbing) deterministically, and report pass/fail as if the sub-task ran.
   * Returns 'pass' (all deterministic checks green), 'fail' (a check failed), or
   * 'unavailable' (feature disabled, or nothing runnable -> caller escalates to
   * best-effort verify). Never throws. Gated by loop.scripted_verify_fallback.
   */
  private async tryScriptedVerifyFallback(
    sessionId: string, plan: LeadPlan, st: LeadPlanSubTask, cycle: number, baseSha: string,
  ): Promise<"pass" | "fail" | "unavailable"> {
    if (this.deps.config.loop.scripted_verify_fallback === false) return "unavailable";
    const worktree = plan.worktreePath;
    if (!worktree) return "unavailable";
    let tscOk: boolean | null = null;
    let diffStat = "";
    let scriptFailures = 0;
    let scriptsRan = 0;
    // 1. tsc --noEmit (only if the repo has a tsconfig AND a runner is wired).
    try {
      const runTsc = this.deps.runScriptedTsc;
      if (runTsc && existsSync(join(worktree, "tsconfig.json"))) {
        const timeoutMs = Math.max(10, this.deps.config.verify?.check_script_timeout_seconds ?? 600) * 1000;
        const out = await runTsc(worktree, timeoutMs).catch(() => null);
        if (out) tscOk = out.ok;
      }
    } catch { /* best-effort */ }
    // 2. git diff --stat base..HEAD (informational + folded into the log).
    try {
      if (this.deps.gitDiffStat && baseSha) {
        diffStat = (await this.deps.gitDiffStat(worktree, baseSha).catch(() => "")) ?? "";
      }
    } catch { /* best-effort */ }
    // 3. Allowlisted repo check scripts (reuse beta.63 plumbing).
    try {
      const vcfg = this.deps.config.verify;
      if (!vcfg || vcfg.run_repo_check_scripts !== false) {
        const discovered = discoverCheckScripts(worktree);
        if (discovered.length > 0) {
          const results = runCheckScripts({
            repoRoot: worktree,
            discovered,
            allowlist: vcfg?.check_script_allowlist ?? ["okf:check", "lint", "typecheck", "test"],
            timeoutSeconds: vcfg?.check_script_timeout_seconds ?? 600,
            runScript: this.deps.runCheckScript,
          });
          for (const r of results) {
            if (r.ran) { scriptsRan++; if (r.exitCode !== 0) scriptFailures++; }
          }
        }
      }
    } catch { /* best-effort */ }

    const ranAnything = tscOk !== null || scriptsRan > 0;
    if (!ranAnything) {
      this.deps.state.audit("loop.scripted_verify_fallback", { sessionId, seq: st.seq, cycle, result: "unavailable", tscOk, scriptsRan, scriptFailures, diffStat: diffStat.slice(0, 500) }, sessionId);
      this.deps.interactionLog?.log(sessionId, { event: "scripted_verify_fallback", phase: "worker", seq: st.seq, cycle, result: "unavailable" });
      return "unavailable";
    }
    const passed = (tscOk === null || tscOk === true) && scriptFailures === 0;
    const result: "pass" | "fail" = passed ? "pass" : "fail";
    this.deps.state.audit("loop.scripted_verify_fallback", { sessionId, seq: st.seq, cycle, result, tscOk, scriptsRan, scriptFailures, diffStat: diffStat.slice(0, 500) }, sessionId);
    this.deps.interactionLog?.log(sessionId, { event: "scripted_verify_fallback", phase: "worker", seq: st.seq, cycle, result, tscOk, scriptsRan, scriptFailures });
    this.deps.logger.warn("[loop] scripted verifier fallback ran (LLM verify sub-task timed out)", { sessionId, seq: st.seq, result, tscOk, scriptFailures });
    return result;
  }

  /**
   * beta.64 (P0-3): BEST-EFFORT VERIFY. Honors the beta.60 "Carel must get a
   * reviewable PR" rule. When an observe-mode VERIFY sub-task times out (after
   * the P0-2 retry AND the P0-4 scripted fallback declined/was unavailable),
   * AND the prior mutate sub-task's verify_probe is GREEN, AND git diff-stat
   * shows only expected files touched, do NOT discard the work: push the branch
   * and open the PR flagged merge_recommendation=needs_human_review (reusing the
   * beta.62 graceful-PR machinery), marking the run verify_skipped. Returns true
   * when a graceful PR was opened (run is terminal `done`), false otherwise (the
   * caller falls through to terminal fail). Gated by loop.best_effort_verify.
   * Never throws.
   */
  private async tryBestEffortVerify(
    sessionId: string, plan: LeadPlan, brief: CrystallisedBrief, st: LeadPlanSubTask,
    cycle: number, totalCost: number, requester: string, baseSha: string,
  ): Promise<boolean> {
    if (this.deps.config.loop.best_effort_verify === false) return false;
    // Precondition 1: the PRIOR mutate sub-task's verify_probe was GREEN. Read
    // the latest per-sub-task verification (green means the code is shippable).
    const localVerify = this.readLocalVerification(sessionId);
    const priorGreen = localVerify.length > 0 && localVerify.every((v) => v.ok);
    // Precondition 2: git diff-stat shows only expected files touched (a clean,
    // in-scope diff). Best-effort -- if we can't compute it, treat as unclean.
    let cleanDiff = false;
    let diffStat = "";
    try {
      if (this.deps.gitDiffStat && baseSha) {
        diffStat = (await this.deps.gitDiffStat(plan.worktreePath, baseSha).catch(() => "")) ?? "";
        // "Clean" = there IS a diff (work was done) and every changed path is
        // within the plan's expected files (or the plan declared none, in which
        // case any diff is accepted since the mutate probe already vouched).
        const changedPaths = parseDiffStatPaths(diffStat);
        const expected = new Set(collectExpectedFiles(plan));
        cleanDiff = changedPaths.length > 0 && (expected.size === 0 || changedPaths.every((f) => expected.has(f) || [...expected].some((e) => f === e || f.startsWith(e))));
      }
    } catch { cleanDiff = false; }

    const eligible = priorGreen && cleanDiff;
    this.deps.state.audit(
      "loop.verify_skipped_best_effort",
      { sessionId, seq: st.seq, cycle, eligible, priorGreen, cleanDiff, reason: "worker_timeout", diffStat: diffStat.slice(0, 800), changedFiles: parseDiffStatPaths(diffStat) },
      sessionId,
    );
    this.deps.interactionLog?.log(sessionId, { event: "verify_skipped_best_effort", phase: "finalize", seq: st.seq, cycle, eligible, priorGreen, cleanDiff, reason: "worker_timeout" });
    if (!eligible) {
      this.deps.logger.warn("[loop] best-effort verify NOT eligible (prior probe not green or diff not clean); falling through to terminal", { sessionId, seq: st.seq, priorGreen, cleanDiff });
      return false;
    }

    // Open the graceful PR flagged needs_human_review (beta.62 pattern).
    this.markProgress(sessionId, "finalize_start", "finalize", { cycle, viaBestEffortVerify: true });
    const priorReview = this.getLastReview(sessionId);
    const reviewReport: ReviewReport = priorReview ?? {
      verdict: "revise",
      findings: [],
      summary: "The LLM VERIFY sub-task timed out; the prior mutate sub-task self-verified GREEN with a clean, in-scope diff. Opened for MANUAL human review (best-effort verify).",
      costUsd: 0, tokensIn: 0, tokensOut: 0,
    };
    let prUrl: string;
    try {
      prUrl = await this.deps.pushBranchAndOpenPr({ plan, brief, reviewReport, requester });
    } catch (pushErr) {
      this.deps.state.audit("loop.best_effort_verify_pr_failed", { sessionId, seq: st.seq, error: String((pushErr as Error)?.message ?? pushErr) }, sessionId);
      this.deps.interactionLog?.log(sessionId, { event: "best_effort_verify_pr_failed", phase: "finalize", seq: st.seq, error: String(pushErr) });
      // Push failed -- preserve the worktree so the branch is still inspectable.
      this.finaliseFailedPreserveWorktree(sessionId, `verify_timeout_best_effort_pr_failed: ${String(pushErr)}`, cycle, totalCost);
      // Signal to the caller that we ALREADY handled the terminal transition
      // (returning true short-circuits the caller's own terminal fail path).
      return true;
    }
    const recReason =
      `The final VERIFY sub-task's LLM turn TIMED OUT (no first token / worker timeout) even after a fresh-session retry, but the prior mutate sub-task self-verified GREEN and the diff is clean + in-scope. ` +
      `Opened for MANUAL human review (best-effort verify) -- there is no machine verify sign-off, so this is NOT auto-mergeable.`;
    const prNumber = parsePrNumber(prUrl);
    this.markProgress(sessionId, "pr_opened", "finalize", { cycle, viaBestEffortVerify: true });
    this.setStatus(sessionId, "done");
    this.deps.state.db
      .prepare(`UPDATE sessions SET final_pr_url = ?, pr_number = ?, merge_recommendation = ?, merge_recommendation_reason = ?, status = 'done', updated_at = ? WHERE id = ?`)
      .run(prUrl, prNumber ?? null, "needs_human_review", recReason, Date.now(), sessionId);
    this.deps.state.audit("loop.shipped", { sessionId, prUrl, prNumber, mergeRecommendation: "needs_human_review", reason: recReason, viaBestEffortVerify: true }, sessionId);
    this.deps.interactionLog?.log(sessionId, { event: "best_effort_verify_pr", phase: "finalize", seq: st.seq, prUrl, prNumber });
    await this.tryReleaseWorktree(sessionId, plan.repo, plan.worktreePath, "shipped");
    return true;
  }

  /**
   * beta.81 (Track B / B2 + B3): POST-PUSH CI VERIFICATION WAIT-STATE. After a
   * branch is pushed + the PR opened, CI is the verification spine (Carel:
   * "the harness should just monitor the CI and check for errors"). This polls
   * getCombinedStatus(headSha) every `ci.poll_interval_seconds` until it is not
   * `pending`, up to `ci.wait_timeout_seconds`, and returns one of:
   *   - {outcome:'success'}  -> proceed to ship (caller keeps the PR).
   *   - {outcome:'failure', logs} -> CI red; caller drives a revise / flags the
   *       PR needs_human_review with the failing logs as the finding source.
   *   - {outcome:'timeout'} -> SOFT checkpoint (Carel: not a hard fail): surface
   *       "CI still running after N min on <sha>" + offer a resumable
   *       continue-watching. Caller keeps the PR open (needs_human_review).
   *   - {outcome:'none'} -> repo has NO CI. Caller authors a workflow (B3) --
   *       NEVER a local fallback (Carel: "I do not want it to run locally, ever").
   *   - {outcome:'skipped'} -> ciCombinedStatus dep absent (pre-beta.81 test
   *       doubles / unwired deployments); caller ships on the review verdict.
   * Injected `sleep` (default real setTimeout) keeps tests instant. Never throws
   * -- a status-fetch error is treated as a transient `pending` and re-polled.
   */
  async pollCiStatus(input: {
    sessionId: string;
    repoFullName: string;
    sha: string;
    requester: string;
    /**
     * beta.91 (F4): true when the harness AUTHORED + pushed a CI workflow this
     * cycle. A `none` status then means "GitHub has not registered the run
     * YET" (registration lag), NOT "repo has no CI" -- so we grace-poll instead
     * of terminating on poll 1 (the b90 shipped-known-red bug).
     */
    workflowAuthoredThisSession?: boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  }): Promise<
    | { outcome: "success" }
    | { outcome: "failure"; logs: string }
    | { outcome: "timeout"; sha: string; waitedSeconds: number }
    | { outcome: "none" }
    | { outcome: "authored_workflow_never_registered"; sha: string; waitedSeconds: number }
    | { outcome: "skipped" }
  > {
    const { sessionId, repoFullName, sha, requester } = input;
    if (!this.deps.ciCombinedStatus) return { outcome: "skipped" };
    const cfg = this.deps.config.ci ?? { wait_timeout_seconds: 900, poll_interval_seconds: 20, none_grace_seconds: 45 };
    const waitMs = Math.max(30, cfg.wait_timeout_seconds ?? 900) * 1000;
    const pollMs = Math.max(5, cfg.poll_interval_seconds ?? 20) * 1000;
    // beta.91 (F4): when we authored + pushed a workflow this cycle, a `none`
    // status means GitHub has not registered the run YET (registration lag),
    // not "no CI". Grace-poll for the run to appear instead of terminating on
    // poll 1 (the b90 shipped-known-red bug). Bounded, never exceeds waitMs.
    //
    // beta.103: the SAME registration lag applies to a repo that ALREADY has
    // CI, and b91 gated the grace on `workflowAuthoredThisSession` -- so for
    // those repos poll 1 still terminated on `none`. The b102 smoke shipped
    // PR #906 that way: the PR opened at 10:30:44, GitHub registered the first
    // check run at 10:30:49, and the immediate first poll landed in that
    // ~5s hole, read `none`, and concluded "this repo has no CI". Lint went
    // red at 10:33:11 against a 900s wait budget that was never touched, and
    // the run shipped `do_not_merge` on the review verdict instead of
    // `needs_human_review` with the failing logs.
    //
    // The grace is now unconditional. A repo that genuinely has no CI still
    // resolves to `none`, just `none_grace_seconds` later -- irrelevant at the
    // end of a multi-minute run, and the price of never again mistaking
    // "GitHub has not caught up" for "there is nothing to wait for".
    // `authoredWorkflowGrace` is kept separate because only the authoring case
    // may return `authored_workflow_never_registered`.
    const graceMs = Math.max(0, cfg.none_grace_seconds ?? 45) * 1000;
    const graceActive = graceMs > 0;
    const authoredWorkflowGrace = !!input.workflowAuthoredThisSession && graceMs > 0;
    const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = input.now ?? (() => Date.now());
    const started = now();
    this.deps.state.audit("loop.ci_poll_started", { sessionId, sha, waitTimeoutSeconds: cfg.wait_timeout_seconds, pollIntervalSeconds: cfg.poll_interval_seconds }, sessionId);
    this.deps.interactionLog?.log(sessionId, { event: "ci_poll_started", phase: "finalize", sha });
    let polls = 0;
    // First read is immediate (no leading sleep) so a repo with no CI resolves
    // fast and a fast CI is not needlessly waited on.
    for (;;) {
      let status: "success" | "failure" | "pending" | "none";
      try {
        status = await this.deps.ciCombinedStatus({ repoFullName, sha, requester });
      } catch (err) {
        // Transient fetch error -> treat as pending + re-poll (never throw).
        this.deps.logger.warn("[loop] CI status fetch failed (treating as pending)", { sessionId, sha, err: String(err) });
        status = "pending";
      }
      polls++;
      if (status === "success") {
        this.deps.state.audit("loop.ci_success", { sessionId, sha, polls }, sessionId);
        this.deps.interactionLog?.log(sessionId, { event: "ci_success", phase: "finalize", sha, polls });
        return { outcome: "success" };
      }
      if (status === "failure") {
        let logs = "";
        try {
          logs = this.deps.ciFailingLogs ? await this.deps.ciFailingLogs({ repoFullName, sha, requester }) : "";
        } catch (err) {
          this.deps.logger.warn("[loop] CI failing-log fetch failed (non-fatal)", { sessionId, sha, err: String(err) });
        }
        this.deps.state.audit("loop.ci_failure", { sessionId, sha, polls, logsExcerpt: (logs ?? "").slice(0, 800) }, sessionId);
        this.deps.interactionLog?.log(sessionId, { event: "ci_failure", phase: "finalize", sha, polls });
        return { outcome: "failure", logs: logs ?? "" };
      }
      if (status === "none") {
        // beta.91 (F4): if we authored a workflow this cycle and are still
        // inside the grace window, treat `none` as "not registered yet" and
        // keep polling -- GitHub often takes several seconds to register a
        // freshly-pushed workflow run. Only after the grace window elapses with
        // still-`none` do we conclude the authored workflow never registered.
        const elapsedNone = now() - started;
        if (graceActive && elapsedNone < graceMs && elapsedNone + pollMs <= waitMs) {
          this.deps.state.audit("loop.ci_none_grace_wait", { sessionId, sha, polls, elapsedMs: elapsedNone, graceMs }, sessionId);
          await sleep(pollMs);
          continue;
        }
        this.deps.state.audit("loop.ci_none", { sessionId, sha, polls, graceActive, authoredWorkflowGrace, elapsedMs: elapsedNone }, sessionId);
        this.deps.interactionLog?.log(sessionId, { event: "ci_none", phase: "finalize", sha });
        // Authored a workflow but it never registered within grace -> distinct,
        // NON-blocking outcome (a real no-CI repo returns plain `none`).
        if (authoredWorkflowGrace) {
          return { outcome: "authored_workflow_never_registered", sha, waitedSeconds: Math.round(elapsedNone / 1000) };
        }
        return { outcome: "none" };
      }
      // pending: check the deadline, then sleep + re-poll.
      const elapsed = now() - started;
      if (elapsed + pollMs > waitMs) {
        const waitedSeconds = Math.round(elapsed / 1000);
        this.deps.state.audit("loop.ci_wait_timeout", { sessionId, sha, polls, waitedSeconds, waitTimeoutSeconds: cfg.wait_timeout_seconds }, sessionId);
        this.deps.interactionLog?.log(sessionId, { event: "ci_wait_timeout", phase: "finalize", sha, waitedSeconds });
        this.deps.logger.warn("[loop] CI still running after the wait timeout; surfacing a resumable checkpoint (NOT a hard fail)", { sessionId, sha, waitedSeconds });
        return { outcome: "timeout", sha, waitedSeconds };
      }
      await sleep(pollMs);
    }
  }

  /**
   * beta.63 (convention-awareness Fix 2): run the repo's DECLARED check scripts
   * (from package.json#scripts, gated by verify.check_script_allowlist) inline +
   * blocking in the worktree at the end of a cycle's execution. Returns
   * REVISE-worthy `ReviewFinding[]` for scripts that exited non-zero; unrunnable/
   * timed-out scripts produce a NON-FATAL note (no finding). Never throws.
   * Emits `loop.convention_check_ran` per run and `loop.convention_check_failed`
   * per non-zero exit.
   */
  private async runFinalVerifyChecks(sessionId: string, plan: LeadPlan, cycle: number): Promise<ReviewFinding[]> {
    const vcfg = this.deps.config.verify;
    if (!vcfg || vcfg.run_repo_check_scripts === false) return [];
    const worktree = plan.worktreePath;
    if (!worktree) return [];
    let discovered;
    try {
      discovered = discoverCheckScripts(worktree);
    } catch (err) {
      this.deps.logger.warn("[loop] convention check discovery failed (non-fatal)", { sessionId, err: String(err) });
      return [];
    }
    if (discovered.length === 0) return [];

    let results: CheckScriptResult[];
    try {
      results = runCheckScripts({
        repoRoot: worktree,
        discovered,
        allowlist: vcfg.check_script_allowlist ?? ["okf:check", "lint", "typecheck", "test"],
        timeoutSeconds: vcfg.check_script_timeout_seconds ?? 600,
        runScript: this.deps.runCheckScript,
        // beta.70 (F4): larger heap for the OOM retry on Thanos-scale typechecks.
        heapRetryMb: vcfg.check_script_heap_retry_mb ?? 8192,
      });
    } catch (err) {
      this.deps.logger.warn("[loop] convention check run failed (non-fatal)", { sessionId, err: String(err) });
      return [];
    }

    const findings: ReviewFinding[] = [];
    for (const r of results) {
      // beta.70 (F4): a heap OOM that PERSISTED after the larger-heap retry is a
      // genuine blocking failure -- surface it distinctly (was a silent skip
      // that shipped a false green in PR #870). It stays `fit`/`medium` so it
      // folds into the review as revise-worthy, but with an explicit oom flag.
      if (r.oom) {
        this.deps.state.audit("loop.convention_check_oom", { sessionId, cycle, script: r.script, exitCode: r.exitCode, heapRetried: !!r.heapRetried }, sessionId);
        this.deps.state.audit("loop.convention_check_failed", { sessionId, cycle, script: r.script, exitCode: r.exitCode, oom: true, outputTail: r.outputTail }, sessionId);
        this.deps.interactionLog?.log(sessionId, { event: "convention_check_failed", phase: "review", cycle, script: r.script, exitCode: r.exitCode, oom: true });
        findings.push({
          dimension: "quality",
          severity: "high",
          title: `Repo check script '${r.script}' ran out of memory (heap OOM, exit ${r.exitCode})`,
          detail:
            `'${r.script}' died of a V8 heap OOM even after a retry with a larger heap. Types/checks are UNVERIFIED -- do NOT treat this as green. ` +
            `Consider raising verify.check_script_heap_retry_mb or splitting the project. Output tail:\n${r.outputTail}`,
        });
        continue;
      }
      if (r.ran && r.exitCode === 0) {
        this.deps.state.audit("loop.convention_check_ran", { sessionId, cycle, script: r.script, exitCode: r.exitCode, heapRetried: !!r.heapRetried }, sessionId);
        this.deps.interactionLog?.log(sessionId, { event: "convention_check_ran", phase: "review", cycle, script: r.script, exitCode: r.exitCode });
      } else if (r.ran && r.exitCode !== 0) {
        this.deps.state.audit("loop.convention_check_ran", { sessionId, cycle, script: r.script, exitCode: r.exitCode }, sessionId);
        this.deps.state.audit("loop.convention_check_failed", { sessionId, cycle, script: r.script, exitCode: r.exitCode, outputTail: r.outputTail }, sessionId);
        this.deps.interactionLog?.log(sessionId, { event: "convention_check_failed", phase: "review", cycle, script: r.script, exitCode: r.exitCode });
        findings.push({
          dimension: "fit",
          severity: "medium",
          title: `Repo check script '${r.script}' failed (exit ${r.exitCode})`,
          detail:
            `The repo declares '${r.script}' as a convention check but it exited non-zero in the final-verify sweep. ` +
            `CI may not run it. Fix the violation (e.g. regenerate a stale bundle) or justify it. Output tail:\n${r.outputTail}`,
        });
      } else {
        // Not run: either not on the allowlist, or unrunnable/timed-out.
        this.deps.state.audit(
          "loop.convention_check_skipped",
          { sessionId, cycle, script: r.script, unrunnable: !!r.unrunnable, reason: r.skippedReason ?? "skipped" },
          sessionId,
        );
        this.deps.interactionLog?.log(sessionId, { event: "convention_check_skipped", phase: "review", cycle, script: r.script, unrunnable: !!r.unrunnable, reason: r.skippedReason });
      }
    }
    return findings;
  }

  /**
   * beta.94 (Feature 1b): DETERMINISTIC FINAL SCOPE CHECK. Replaces the
   * idle-prone LLM "final verification of scope boundaries" sub-task (elided in
   * Feature 1a) with a harness-side git check: diff the files COMMITTED in
   * `<plan_base_sha>..HEAD` against the UNION of every sub-task's declared
   * per-file scope (collectDeclaredScopeFiles). A committed file OUTSIDE that
   * union is out-of-scope. This does NOT hard-fail -- it returns a ReviewFinding
   * (dimension `fit`, severity `medium`) so it folds into the adversary review,
   * mirroring runFinalVerifyChecks. Gated by loop.deterministic_final_scope_check
   * (default true). Best-effort, EXCEPT for the beta.110 blowout tripwire,
   * which throws ScopeBlowoutError to stop the cycle before review.
   *
   * Emits `loop.final_scope_check_ran` per run and
   * `loop.final_scope_check_out_of_scope` when out-of-scope files are found.
   */
  /**
   * beta.111: run the repo's OWN typecheck script and block on errors in files
   * this branch changed.
   *
   * Separate from runFinalVerifyChecks, which is gated behind
   * verify.run_repo_check_scripts and stays off by default because running a
   * repo's whole check suite per cycle is expensive. This runs exactly one
   * script and only reports errors it can attribute to this branch, so it is
   * safe to leave on. See typecheck-gate.ts for why the alternative -- diffing
   * against a typecheck at the base commit -- is not worth a second full run.
   *
   * Never throws. A gate that cannot run is a note, not a failure; the one
   * thing it must never do is invent a green.
   */
  private async runTypecheckGate(sessionId: string, plan: LeadPlan, cycle: number): Promise<ReviewFinding[]> {
    const vcfg = this.deps.config.verify;
    if (vcfg?.typecheck_gate === false) return [];
    const worktree = plan.worktreePath;
    if (!worktree || !this.deps.worktreeCommittedFiles) return [];

    let script: string | undefined;
    let discovered: CheckScript[] = [];
    try {
      discovered = discoverCheckScripts(worktree);
      script = discovered.find((d) => /^(typecheck|type-check|types|tsc)$/i.test(d.name))?.name;
    } catch {
      return [];
    }
    if (!script) {
      this.deps.state.audit("loop.typecheck_gate_skipped", { sessionId, cycle, reason: "no typecheck script in package.json" }, sessionId);
      return [];
    }

    let base: string | undefined;
    try {
      const r = this.deps.state.db
        .prepare(`SELECT plan_base_sha FROM sessions WHERE id = ?`)
        .get(sessionId) as { plan_base_sha: string | null } | undefined;
      base = r?.plan_base_sha ?? undefined;
    } catch {
      base = undefined;
    }
    // Without a base we cannot tell this branch's errors from the repo's, and
    // reporting the repo's would block every run on pre-existing breakage.
    if (!base) {
      this.deps.state.audit("loop.typecheck_gate_skipped", { sessionId, cycle, reason: "no plan_base_sha to scope errors to this branch" }, sessionId);
      return [];
    }

    const startedAt = Date.now();
    let results: CheckScriptResult[];
    try {
      results = runCheckScripts({
        repoRoot: worktree,
        discovered,
        allowlist: [script],
        timeoutSeconds: vcfg?.check_script_timeout_seconds ?? 600,
        runScript: this.deps.runCheckScript,
        heapRetryMb: vcfg?.check_script_heap_retry_mb ?? 8192,
      });
    } catch (err) {
      this.deps.logger.warn("[loop] beta.111 typecheck gate failed to run (non-fatal)", { sessionId, err: String(err) });
      this.deps.state.audit("loop.typecheck_gate_skipped", { sessionId, cycle, reason: `runner threw: ${String(err)}` }, sessionId);
      return [];
    }
    let r = results.find((x) => x.script === script);
    let durationMs = Date.now() - startedAt;
    // beta.115: `npm run typecheck` exiting 127 does NOT mean the branch is
    // clean, and until now a skip returned no findings, which reads as clean.
    // PR #964 shipped one TS2551 that CI caught on the very same tree using
    // `npx tsc --noEmit` -- so the compiler was reachable and only the npm
    // indirection was broken. Try the compiler directly before giving up.
    if (!r || !r.ran) {
      const firstReason = r?.skippedReason ?? "did not run";
      const direct = this.deps.runTypecheckDirect?.(worktree, (vcfg?.check_script_timeout_seconds ?? 600) * 1000);
      if (direct) {
        this.deps.state.audit(
          "loop.typecheck_gate_fallback",
          { sessionId, cycle, script, scriptReason: firstReason, via: direct.via, exitCode: direct.status },
          sessionId,
        );
        r = {
          script,
          ran: true,
          exitCode: direct.status ?? null,
          outputTail: `${direct.stdout}\n${direct.stderr}`.slice(-20_000),
        };
        durationMs = Date.now() - startedAt;
      } else {
        // No route to the compiler. Say so loudly: a gate that could not run is
        // not a gate that passed. Classified `env` by finding-classify (the text
        // names exit 127 / missing binary), so it blocks the merge
        // recommendation without driving revise cycles a worker cannot fix --
        // repairing the worktree is the bootstrap's job, not the diff's.
        const diagnosis = this.deps.diagnoseCheckEnv?.(worktree);
        this.deps.state.audit(
          "loop.typecheck_gate_unavailable",
          { sessionId, cycle, script, reason: firstReason, diagnosis, durationMs: Date.now() - startedAt },
          sessionId,
        );
        this.deps.logger.warn("[loop] beta.115 typecheck gate could not run by any route", { sessionId, cycle, script, diagnosis });
        return [
          {
            title: "Typecheck gate could not run: the branch is unverified, not verified",
            detail:
              `The repo declares a \`${script}\` script but it could not be executed in the review worktree ` +
              `(${firstReason}), and invoking the compiler directly did not work either. ` +
              `No type errors were found because nothing looked for them -- do not read this as a clean branch. ` +
              `Diagnosis: ${JSON.stringify(diagnosis ?? {})}. ` +
              `This is worktree/tooling breakage (missing binary, command not found), not a defect in the diff, ` +
              `so it cannot be fixed by changing code; a human should run the typecheck before merging.`,
            severity: "high",
            dimension: "runtime",
          } as ReviewFinding,
        ];
      }
    }
    if (r.exitCode === 0) {
      this.deps.state.audit("loop.typecheck_gate_ran", { sessionId, cycle, script, exitCode: 0, errorsTotal: 0, errorsInChangedFiles: 0, durationMs }, sessionId);
      this.deps.interactionLog?.log(sessionId, { event: "typecheck_gate_ran", phase: "review", cycle, script, clean: true });
      return [];
    }

    const all = parseTscErrors(r.outputTail);
    // Non-zero exit with nothing parseable means the script failed for some
    // other reason (missing binary, OOM). runFinalVerifyChecks owns that case
    // when enabled; here it is a note, because a parse miss is not evidence of
    // a type error and must not be dressed up as one.
    if (all.length === 0) {
      this.deps.state.audit("loop.typecheck_gate_unparsed", { sessionId, cycle, script, exitCode: r.exitCode, oom: !!r.oom, outputTail: r.outputTail, durationMs }, sessionId);
      return [];
    }
    let committed: string[];
    try {
      committed = await this.deps.worktreeCommittedFiles(worktree, base);
    } catch {
      return [];
    }
    const mine = errorsInChangedFiles(all, committed ?? []);
    this.deps.state.audit(
      "loop.typecheck_gate_ran",
      { sessionId, cycle, script, exitCode: r.exitCode, errorsTotal: all.length, errorsInChangedFiles: mine.length, durationMs },
      sessionId,
    );
    if (mine.length === 0) {
      this.deps.logger.info("[loop] beta.111 typecheck gate: errors exist but none in files this branch changed; pre-existing", {
        sessionId, script, errorsTotal: all.length,
      });
      return [];
    }
    this.deps.state.audit(
      "loop.typecheck_gate_failed",
      { sessionId, cycle, script, errors: mine.slice(0, 20), errorsTotal: all.length },
      sessionId,
    );
    this.deps.interactionLog?.log(sessionId, {
      event: "typecheck_gate_failed", phase: "review", cycle, script, errorsInChangedFiles: mine.length,
    });
    return [buildTypecheckFinding(mine, script)];
  }

  private async runFinalScopeCheck(sessionId: string, plan: LeadPlan, cycle: number): Promise<ReviewFinding[]> {
    if (this.deps.config.loop.deterministic_final_scope_check === false) return [];
    const worktree = plan.worktreePath;
    if (!worktree || !this.deps.worktreeCommittedFiles) return [];
    // Base = the persisted branch fork-point (same base the adversary diffs
    // against). Without it we cannot scope committed files to THIS branch's own
    // commits, so we conservatively skip (no finding) rather than diff against a
    // wrong base and hallucinate out-of-scope files.
    let base: string | undefined;
    try {
      const r = this.deps.state.db
        .prepare(`SELECT plan_base_sha FROM sessions WHERE id = ?`)
        .get(sessionId) as { plan_base_sha: string | null } | undefined;
      base = r?.plan_base_sha ?? undefined;
    } catch {
      base = undefined;
    }
    if (!base) return [];

    let committed: string[];
    try {
      committed = await this.deps.worktreeCommittedFiles(worktree, base);
    } catch (err) {
      this.deps.logger.warn("[loop] beta.94 final-scope check: committed-files probe failed (non-fatal)", { sessionId, err: String(err) });
      return [];
    }
    if (!Array.isArray(committed) || committed.length === 0) return [];

    const declared = collectDeclaredScopeFiles(plan);
    // A committed file is IN-SCOPE if it matches ANY declared contract path via
    // the shared tolerant path matcher (route-group / suffix / basename-dir) --
    // the same normalisation every per-file verifier uses, so we don't
    // false-flag a route-group-normalised path the worker legitimately wrote.
    const outOfScope = committed.filter((f) => !declared.some((d) => declaredCovers(f, d)));

    this.deps.state.audit(
      "loop.final_scope_check_ran",
      { sessionId, cycle, committedCount: committed.length, declaredCount: declared.length, outOfScopeCount: outOfScope.length },
      sessionId,
    );
    this.deps.interactionLog?.log(sessionId, { event: "final_scope_check_ran", phase: "review", cycle, committedCount: committed.length, outOfScopeCount: outOfScope.length });

    if (outOfScope.length === 0) return [];

    // beta.110: a BLOWOUT is not scope creep, and must not become a finding.
    //
    // On PR #932 session `9217236c` this check fired with committedCount 12432
    // / declaredCount 9 / outOfScopeCount 12423 -- an npm cache swept in by
    // commit()'s `add -A` -- and then returned a `medium` finding and let the
    // run continue. The adversary was handed a 12,432-file diff, hit
    // adversary_timeout_seconds at 900s with no result, and the session died
    // as `review_crash` having pushed nothing. Eight good commits were sitting
    // in that worktree and never reached the PR.
    //
    // Reviewing a diff that size was never going to work, so spending fifteen
    // minutes discovering that is pure loss. Stop here instead, with a reason
    // that names the paths -- the worktree is preserved either way, so the good
    // commits stay recoverable.
    const blowoutAt = this.deps.config.loop.scope_blowout_file_threshold ?? 500;
    if (blowoutAt > 0 && outOfScope.length >= blowoutAt) {
      this.deps.state.audit(
        "loop.scope_blowout",
        {
          sessionId, cycle,
          committedCount: committed.length,
          declaredCount: declared.length,
          outOfScopeCount: outOfScope.length,
          threshold: blowoutAt,
          sample: outOfScope.slice(0, 20),
        },
        sessionId,
      );
      throw new ScopeBlowoutError(outOfScope.length, blowoutAt, outOfScope.slice(0, 20));
    }

    this.deps.state.audit(
      "loop.final_scope_check_out_of_scope",
      { sessionId, cycle, outOfScope, declared },
      sessionId,
    );
    this.deps.logger.warn("[loop] beta.94 final-scope check: committed file(s) outside the declared sub-task scope union", { sessionId, cycle, outOfScope });
    return [
      {
        dimension: "fit",
        severity: "medium",
        title: `Out-of-scope file write(s): ${outOfScope.length} committed file(s) fall outside the declared sub-task scope`,
        detail:
          `The deterministic final-scope check compared the files committed in this branch (\`git diff ${base.slice(0, 12)}..HEAD\`) ` +
          `against the UNION of every sub-task's declared file scope (verify paths + filesLikelyTouched). ` +
          `These committed file(s) were NOT declared by any sub-task and may be unintended scope creep:\n` +
          outOfScope.map((f) => `  - ${f}`).join("\n") +
          `\n\nDeclared scope union:\n` +
          (declared.length ? declared.map((f) => `  - ${f}`).join("\n") : "  (none declared)") +
          `\n\nEither confirm these edits are intended (and the plan under-declared its scope) or revert the out-of-scope changes.`,
      },
    ];
  }

  /**
   * beta.78 (Feature 2): the configured per-user daily hard cap, or 0 when
   * unset/misconfigured. 0 => no daily gate (back-compat: pre-beta.78 configs
   * and test doubles without a `budgets` block behave as before). Defensive.
   */
  private dailyMaxUsd(): number {
    const dm = this.deps.config.budgets?.daily_max_usd;
    return typeof dm === "number" && dm > 0 ? dm : 0;
  }

  /**
   * beta.78 (Feature 2): a user's spend TODAY from the persistent ledger, or 0
   * if the budget enforcer double doesn't expose getDailySpend (test doubles).
   * Never throws.
   */
  private safeDailySpend(user: string): number {
    try {
      const fn = (this.deps.budget as { getDailySpend?: (u: string) => number }).getDailySpend;
      return typeof fn === "function" ? fn.call(this.deps.budget, user) : 0;
    } catch {
      return 0;
    }
  }

  /**
   * beta.78 (Feature 1+2): daily-AWARE soft session-budget warning. When a
   * run crosses its SOFT session budget, warn the user via Slack (best-effort,
   * direct-post) and FACTOR IN remaining daily headroom -- Carel's ask: "If
   * the user has used 80% of their daily, the soft limit should be aware that
   * there is only 20% left for the day, and notify the user if this might be a
   * bit low and ask for a budget increase." Never throws.
   */
  private warnSessionBudgetSoft(
    sessionId: string,
    user: string,
    totalCost: number,
    sessionBudget: number,
  ): void {
    try {
      const dailyMax = this.dailyMaxUsd();
      const dailySoFar = this.safeDailySpend(user);
      let text =
        `:warning: This run passed its session budget ` +
        `($${totalCost.toFixed(2)} / $${sessionBudget.toFixed(2)}). It will keep going ` +
        `— the hard stop is your daily cap.`;
      if (typeof dailyMax === "number" && dailyMax > 0) {
        const remaining = Math.max(0, dailyMax - dailySoFar);
        const pct = Math.min(100, Math.round((dailySoFar / dailyMax) * 100));
        text +=
          ` You've used ${pct}% of today's budget ` +
          `($${dailySoFar.toFixed(2)} / $${dailyMax.toFixed(2)}), ~$${remaining.toFixed(2)} left.`;
        // Nudge for a budget increase when the remaining daily headroom looks
        // low relative to what this run has already spent.
        if (remaining < totalCost) {
          text += ` That may be low to finish this — reply with a higher budget or drop :moneybag: to override the cap.`;
        }
      }
      this.deps.postWarning?.(sessionId, text);
    } catch {
      /* best-effort; a warning must never fail the run */
    }
  }

  /**
   * beta.78 (Feature 2): hard daily-cap notification. Posted when the run is
   * aborted because the user's daily_max_usd would be exceeded. Never throws.
   */
  private warnDailyMaxHit(sessionId: string, user: string, dailySoFar: number, dailyMax: number): void {
    try {
      this.deps.postWarning?.(
        sessionId,
        `:octagonal_sign: Daily budget reached for <@${user}> ` +
          `($${dailySoFar.toFixed(2)} / $${dailyMax.toFixed(2)}). This run is stopping. ` +
          `Drop :moneybag: to override the cap, or resume tomorrow when the daily budget resets (UTC).`,
      );
    } catch {
      /* best-effort */
    }
  }

  private finaliseAbort(sessionId: string, reason: string, cycles: number, totalCostUsd: number): LoopOutcome {
    this.setStatus(sessionId, "aborted");
    this.deps.state.audit("loop.aborted", { sessionId, reason }, sessionId);
    // beta.16 fix #3: release worktree on abort too. Best-effort; we don't
    // await inside the return path because callers assume finaliseAbort is
    // synchronous. Instead, kick off the release and let it settle on the
    // event loop; the failure path is logged and audited inside
    // tryReleaseWorktree.
    this.scheduleWorktreeReleaseForSession(sessionId, "aborted");
    return { status: "aborted", sessionId, reason, cycles, totalCostUsd };
  }

  /**
   * beta.16 fix #3 + beta.17 correctness: schedule a best-effort worktree
   * release for a session that has already reached a terminal status.
   * Looks up both `repo` and `worktree_path` from the sessions row so the
   * release call gets the actual on-disk path (not a reconstruction).
   * Never throws.
   */
  private scheduleWorktreeReleaseForSession(sessionId: string, reason: "shipped" | "aborted" | "failed"): void {
    if (!this.deps.releaseWorktree) return;
    try {
      const row = this.deps.state.db
        .prepare(`SELECT repo, worktree_path FROM sessions WHERE id = ?`)
        .get(sessionId) as { repo: string | null; worktree_path: string | null } | undefined;
      if (row?.repo && row?.worktree_path) {
        void this.tryReleaseWorktree(sessionId, row.repo, row.worktree_path, reason);
      } else if (row?.repo) {
        // No worktree_path yet (session died before allocation completed):
        // there's nothing to release, but audit the skip so the stream
        // stays self-describing.
        this.deps.state.audit(
          "loop.worktree_release_skipped",
          { sessionId, reason, reason_skipped: "no worktree_path on session row (likely died pre-allocation)" },
          sessionId,
        );
      }
    } catch (err) {
      this.deps.logger.warn("[loop] scheduleWorktreeReleaseForSession failed to look up session row", { sessionId, err: String(err) });
    }
  }

  /**
   * beta.16 fix #3: build a `LoopOutcome` for a hard-failed session and
   * release the worktree. Centralises the six failure-return sites so we
   * cannot forget to release the worktree on new failure paths.
   */
  private finaliseFailed(sessionId: string, reason: string, cycles: number, totalCostUsd: number): LoopOutcome {
    // beta.73 (D3): ALWAYS audit the failure reason (greppable terminal).
    // beta.96: audit the reason BEFORE setStatus -- setStatus -> deliverProgress
    // (native Slack terminal post) reads this reason to build the headline; the
    // pre-b96 order (audit AFTER setStatus) meant a plan-phase death posted an
    // empty headline and was silently dropped (session 1b267b86, 2h no feedback).
    this.deps.state.audit("loop.failed", { sessionId, reason, cycles }, sessionId);
    this.deps.interactionLog?.log(sessionId, { event: "failed", phase: "finalize", reason });
    this.setStatus(sessionId, "failed");
    this.scheduleWorktreeReleaseForSession(sessionId, "failed");
    return { status: "failed", sessionId, reason, cycles, totalCostUsd };
  }

  /**
   * beta.62 (fix #3): terminal-fail a session WITHOUT releasing the worktree,
   * so the on-disk commit chain stays inspectable. Used for a review CRASH
   * that could NOT be salvaged into a graceful PR (e.g. a cycle-1 crash with
   * no prior review, a non-green self-verify, or the graceful push itself
   * failed). The b60-attempt-2 failure discarded 8 good commits precisely
   * because the crash path released the worktree; preserving it means a human
   * can `git log`/push the branch manually even when the harness couldn't.
   */
  private finaliseFailedPreserveWorktree(sessionId: string, reason: string, cycles: number, totalCostUsd: number): LoopOutcome {
    // beta.96: audit the reason BEFORE setStatus so the native terminal post
    // (deliverProgress) sees it (see finaliseFailed for the full rationale).
    // beta.74 (D3 nit): also emit the canonical `loop.failed{reason}` event so
    // there is ONE terminal-fail event across BOTH terminal paths (this
    // preserve-worktree variant AND finaliseFailed). Pre-beta.74 a review crash
    // routed through here and emitted ONLY `loop.failed_worktree_preserved`, so
    // a `harness_progress` consumer greppping for `loop.failed` missed the
    // review-crash terminals (session 666fc103). The reason string is preserved
    // on both events; this just unifies the event name.
    this.deps.state.audit("loop.failed", { sessionId, reason, cycles, worktreePreserved: true }, sessionId);
    this.deps.state.audit(
      "loop.failed_worktree_preserved",
      { sessionId, reason, cycles },
      sessionId,
    );
    this.deps.interactionLog?.log(sessionId, { event: "failed_worktree_preserved", phase: "finalize", reason });
    this.setStatus(sessionId, "failed");
    return { status: "failed", sessionId, reason, cycles, totalCostUsd };
  }

  /**
   * beta.63 (Part A): the LATE-STAGE STALL WATCHDOG.
   *
   * Origin: the b60 record-depth run got ~7 sub-tasks deep, hit a live
   * env-wait-retry, then the loop STOPPED EMITTING with the session still
   * `executing` and no terminal event -- for ~2 days -- until a container
   * restart cleared it. beta.42 bound the re-entrancy guard, beta.60 bound the
   * whole `runOne`; this binds the SESSION as a whole (and the finalize phase
   * specifically), which those two do not cover.
   *
   * For every non-terminal executing/reviewing session whose last_progress_at
   * froze past `loop.session_stall_seconds`, it:
   *   1. emits a LOUD `loop.session_stalled {phase, msSinceProgress}` (logger +
   *      audit + interaction log);
   *   2. attempts bounded self-recovery -- if NO live loop-runner owns the
   *      session (dead executor), re-tick the loop-runner (reuse resume
   *      machinery: re-drive `run()` from the crystallised brief); if a live
   *      runner IS present the session is genuinely busy -> leave it alone;
   *   3. if unrecoverable AND `stall_auto_terminal` is on, transition to a
   *      terminal `failed`(reason=stalled_no_progress) PRESERVING the worktree,
   *      and -- when the branch already has commits and `stall_graceful_pr` is
   *      on -- attempt a graceful push+PR flagged needs_human_review (beta.62
   *      pattern) so a 95%-done deliverable is not evaporated the way b60 was.
   *
   * Idempotent + never throws. Safe to call from a gateway tick / maintenance
   * cycle / interval. Returns the list of stalls handled (for tests + telemetry).
   */
  async checkStalls(now = Date.now()): Promise<Array<{ sessionId: string; phase: string; msSinceProgress: number; action: string }>> {
    const stallSeconds = this.deps.config.loop.session_stall_seconds ?? 1800;
    const thresholdMs = Math.max(300, stallSeconds) * 1000;
    const handled: Array<{ sessionId: string; phase: string; msSinceProgress: number; action: string }> = [];

    // Only NON-TERMINAL, actively-working phases can stall. `planning` is
    // bounded by lead_timeout; `crystallising` happens pre-loop;
    // `awaiting_clarification` is a resting pause (must NOT be reaped).
    let rows: Array<{ id: string; status: string; last_progress_at: number | null; updated_at: number | null; crystallised_prompt: string | null; repo: string | null; branch: string | null; worktree_path: string | null; requester: string; cycles_ran: number; cost_usd: number }>;
    try {
      rows = this.deps.state.db
        .prepare(
          `SELECT id, status, last_progress_at, updated_at, crystallised_prompt, repo, branch,
                  worktree_path, requester, cycles_ran, cost_usd
             FROM sessions
            WHERE status IN ('executing', 'reviewing')`,
        )
        .all() as typeof rows;
    } catch (err) {
      this.deps.logger.warn("[loop] checkStalls query failed", { err: String(err) });
      return handled;
    }

    for (const row of rows) {
      const lastProgress = Math.max(row.last_progress_at ?? 0, row.updated_at ?? 0);
      if (lastProgress <= 0) continue; // never made progress -- not our case
      const msSinceProgress = now - lastProgress;
      if (msSinceProgress <= thresholdMs) continue; // still within a legit phase

      const phase = row.status;
      // 1. LOUD stall event (logger + audit + interaction log).
      this.deps.logger.error("[loop] SESSION STALLED (no forward progress)", {
        sessionId: row.id, phase, msSinceProgress, stallSeconds,
      });
      this.deps.state.audit("loop.session_stalled", { sessionId: row.id, phase, msSinceProgress }, row.id);
      this.deps.interactionLog?.log(row.id, { event: "session_stalled", phase: mapPhase(row.status as LoopStatus), status: phase, msSinceProgress });

      // 2. Bounded self-recovery: only if NO live loop-runner owns the session
      //    (a live runner means it is genuinely busy, not wedged).
      const liveRunners = runningSessionIds();
      if (liveRunners.includes(row.id)) {
        this.deps.state.audit("loop.session_stall_live_runner", { sessionId: row.id, phase, msSinceProgress }, row.id);
        this.deps.interactionLog?.log(row.id, { event: "stall_live_runner", phase: mapPhase(row.status as LoopStatus), msSinceProgress });
        handled.push({ sessionId: row.id, phase, msSinceProgress, action: "skipped_live_runner" });
        continue;
      }

      // Dead executor. Re-tick the loop-runner (reuse resume machinery) IF we
      // have a crystallised brief to drive from.
      if (row.crystallised_prompt) {
        try {
          const brief = JSON.parse(row.crystallised_prompt) as CrystallisedBrief;
          this.deps.state.audit("loop.session_stall_recovery", { sessionId: row.id, phase, action: "re_tick_loop_runner" }, row.id);
          this.deps.interactionLog?.log(row.id, { event: "stall_recovery", phase: mapPhase(row.status as LoopStatus), action: "re_tick_loop_runner" });
          // Reset to planning so run() re-drives the phase (same as harness_
          // resume force). Bump last_progress_at so a second watchdog tick in
          // the recovery window does not double-fire.
          this.setStatus(row.id, "planning");
          void this.run(row.id, brief).catch((err) => {
            this.deps.logger.error("[loop] stall self-recovery re-tick failed", { sessionId: row.id, err: String(err) });
          });
          handled.push({ sessionId: row.id, phase, msSinceProgress, action: "re_ticked" });
          continue;
        } catch (err) {
          this.deps.logger.warn("[loop] stall recovery could not parse brief; falling through to terminal", { sessionId: row.id, err: String(err) });
        }
      }

      // 3. Unrecoverable. Auto-terminal transition is behind its own sub-flag
      //    so detection+logging can stay ON while auto-transition is toggled
      //    OFF separately (per Carel).
      if (this.deps.config.loop.stall_auto_terminal === false) {
        this.deps.state.audit("loop.session_stall_no_auto_terminal", { sessionId: row.id, phase, msSinceProgress }, row.id);
        this.deps.interactionLog?.log(row.id, { event: "stall_no_auto_terminal", phase: mapPhase(row.status as LoopStatus), msSinceProgress });
        handled.push({ sessionId: row.id, phase, msSinceProgress, action: "detected_only" });
        continue;
      }

      const outcome = await this.finaliseStalled(row);
      handled.push({ sessionId: row.id, phase, msSinceProgress, action: outcome });
    }
    return handled;
  }

  /**
   * beta.67 (Bug A): EXTERNAL stall-sweep entry point.
   *
   * Origin: beta.66 smoke #4 -- the loop-runner PROCESS died between a
   * worker's sdk_response and the next handler step. The session record stayed
   * `status=executing` forever; `ps` showed no live process. beta.63's
   * in-process `checkStalls` watchdog CANNOT fire in this case: a dead process
   * cannot watchdog its own death. Also `harness_cancel` set a `reactions_json.
   * abort` flag that the dead loop never consumed, so the session never
   * reached a terminal status.
   *
   * This method is meant to be called by the EXTERNAL periodic `stall-sweep`
   * service (registered in src/index.ts like pr-watcher / retention-nightly),
   * which runs INDEPENDENT of any loop-runner process. On each tick it:
   *
   *   1. runs the EXISTING {@link checkStalls} fast path (detection + bounded
   *      re-tick recovery + auto-terminal transition) -- the external process
   *      is the safety net, checkStalls is still the in-process fast path;
   *   2. ADDITIONALLY reaps sessions that have a pending cancel flag
   *      (`reactions_json.abort`) set but are STILL non-terminal because their
   *      loop is dead (no live loop-runner) -- transitions those to a terminal
   *      `failed` (reason `cancelled_dead_loop`) PRESERVING the worktree
   *      (beta.62 pattern), consuming the cancel the dead loop never did.
   *
   * Covers `executing`, `planning`, and `reviewing` (checkStalls covers only
   * executing/reviewing; a planning session whose loop dies must also be
   * reaped by the cancel path). Idempotent + never throws. Returns a summary
   * for tests + telemetry.
   */
  async sweepStalls(now = Date.now()): Promise<{
    ran: boolean;
    recovered: Array<{ sessionId: string; phase: string; msSinceProgress: number; action: string }>;
    terminated: Array<{ sessionId: string; phase: string; reason: string }>;
  }> {
    this.deps.state.audit("loop.stall_sweep_ran", { at: now }, undefined);
    const recovered: Array<{ sessionId: string; phase: string; msSinceProgress: number; action: string }> = [];
    const terminated: Array<{ sessionId: string; phase: string; reason: string }> = [];

    // 1. Fast path: run the EXISTING in-process watchdog logic. From the
    //    external process this is the actual safety net for a dead executor.
    try {
      const handled = await this.checkStalls(now);
      for (const h of handled) recovered.push(h);
      if (handled.length > 0) {
        this.deps.state.audit("loop.stall_sweep_recovered", { count: handled.length, handled }, undefined);
      }
    } catch (err) {
      this.deps.logger.warn("[loop] sweepStalls checkStalls failed", { err: String(err) });
    }

    // 2. Pending-cancel + dead-loop reaping. A `harness_cancel` set
    //    reactions_json.abort but the loop-runner is dead, so the abort was
    //    never consumed and the session sits non-terminal forever.
    let rows: Array<{ id: string; status: string; reactions_json: string | null; cycles_ran: number; cost_usd: number }>;
    try {
      rows = this.deps.state.db
        .prepare(
          `SELECT id, status, reactions_json, cycles_ran, cost_usd
             FROM sessions
            WHERE status IN ('executing', 'planning', 'reviewing')`,
        )
        .all() as typeof rows;
    } catch (err) {
      this.deps.logger.warn("[loop] sweepStalls cancel query failed", { err: String(err) });
      return { ran: true, recovered, terminated };
    }

    const liveRunners = runningSessionIds();
    for (const row of rows) {
      let aborted = false;
      try {
        aborted = !!(row.reactions_json ? (JSON.parse(row.reactions_json) as { abort?: boolean }).abort : false);
      } catch { aborted = false; }
      if (!aborted) continue;
      // A live runner will consume the abort at its next checkpoint (beta.55
      // path at loop.ts ~866); do NOT double-reap it here.
      if (liveRunners.includes(row.id)) continue;

      // Dead loop with a pending cancel -> consume it: terminal failed,
      // PRESERVING the worktree (beta.62 pattern) so the branch stays
      // inspectable on disk.
      const reason = "cancelled_dead_loop";
      this.deps.logger.error("[loop] stall-sweep reaping cancelled session with a dead loop", { sessionId: row.id, phase: row.status });
      this.finaliseFailedPreserveWorktree(row.id, reason, row.cycles_ran ?? 0, row.cost_usd ?? 0);
      this.deps.state.audit("loop.stall_sweep_terminated", { sessionId: row.id, phase: row.status, reason }, row.id);
      this.deps.interactionLog?.log(row.id, { event: "stall_sweep_terminated", phase: mapPhase(row.status as LoopStatus), reason });
      terminated.push({ sessionId: row.id, phase: row.status, reason });
    }

    return { ran: true, recovered, terminated };
  }

  /**
   * beta.63 (Part A): terminal handling of an UNRECOVERABLE stall. Never
   * evaporate a near-done deliverable: if the branch has commits and
   * `stall_graceful_pr` is on, attempt a graceful push+PR flagged
   * needs_human_review (beta.62 pattern); otherwise fail terminally PRESERVING
   * the worktree so the commit chain stays inspectable on disk. Never throws.
   * Returns a short action string for telemetry.
   */
  private async finaliseStalled(row: {
    id: string; status: string; repo: string | null; branch: string | null; worktree_path: string | null;
    requester: string; cycles_ran: number; cost_usd: number; crystallised_prompt: string | null;
  }): Promise<string> {
    const sessionId = row.id;
    const cycles = row.cycles_ran ?? 0;
    const totalCost = row.cost_usd ?? 0;
    const gracefulEnabled = this.deps.config.loop.stall_graceful_pr !== false;

    // Does the branch have commits worth salvaging? Use the commit probe from
    // buildVerifyProbes (commitMadeSince against an empty base = "any commit").
    let hasCommits = false;
    if (gracefulEnabled && row.repo && row.branch && row.worktree_path && this.deps.buildVerifyProbes && this.deps.worktreeHeadSha) {
      try {
        const head = await this.deps.worktreeHeadSha(row.worktree_path).catch(() => "");
        const plan: LeadPlan = JSON.parse(this.getPlanJson(sessionId) ?? "{}") as LeadPlan;
        const probes = this.deps.buildVerifyProbes({ plan, requester: row.requester, worktreePath: row.worktree_path, baseSha: "" });
        const made = await probes.commitMadeSince("").catch(() => ({ made: false, detail: "" }));
        hasCommits = !!made.made && !!head;
      } catch (err) {
        this.deps.logger.warn("[loop] stall commit probe failed", { sessionId, err: String(err) });
      }
    }

    if (gracefulEnabled && hasCommits) {
      const planJson = this.getPlanJson(sessionId);
      if (planJson) {
        try {
          const plan = JSON.parse(planJson) as LeadPlan;
          // Prefer the crystallised brief; synthesise a minimal one from the
          // plan when it is missing so a near-done deliverable is still salvaged
          // into a PR rather than evaporated.
          const brief: CrystallisedBrief = row.crystallised_prompt
            ? (JSON.parse(row.crystallised_prompt) as CrystallisedBrief)
            : { title: `stalled session ${sessionId}`, motivation: "Recovered from a stalled harness session.", acceptanceCriteria: ["(recovered)"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
          const lastReview = this.getLastReview(sessionId);
          const reviewReport: ReviewReport = lastReview ?? {
            verdict: "revise",
            findings: [],
            summary: "Session stalled before a final adversary verdict; opened for manual human review.",
            costUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
          };
          const prUrl = await this.deps.pushBranchAndOpenPr({ plan, brief, reviewReport, requester: row.requester });
          const recReason =
            `The session STALLED (no forward progress past the watchdog window) before a final verdict, but the branch has commits. ` +
            `Opened for MANUAL human review -- there is no machine sign-off, so this is NOT auto-mergeable.`;
          const prNumber = parsePrNumber(prUrl);
          this.setStatus(sessionId, "done");
          this.deps.state.db
            .prepare(`UPDATE sessions SET final_pr_url = ?, pr_number = ?, merge_recommendation = ?, merge_recommendation_reason = ?, status = 'done', updated_at = ? WHERE id = ?`)
            .run(prUrl, prNumber ?? null, "needs_human_review", recReason, Date.now(), sessionId);
          this.deps.state.audit("loop.shipped", { sessionId, prUrl, prNumber, mergeRecommendation: "needs_human_review", reason: recReason, viaStallRecovery: true }, sessionId);
          this.deps.interactionLog?.log(sessionId, { event: "stall_graceful_pr", phase: "finalize", prUrl, prNumber });
          await this.tryReleaseWorktree(sessionId, row.repo!, row.worktree_path!, "shipped");
          return "graceful_pr";
        } catch (pushErr) {
          this.deps.state.audit("loop.stall_graceful_pr_failed", { sessionId, error: String((pushErr as Error)?.message ?? pushErr) }, sessionId);
          this.deps.interactionLog?.log(sessionId, { event: "stall_graceful_pr_failed", phase: "finalize", error: String(pushErr) });
          // fall through to preserve-worktree fail
        }
      }
    }

    // Not salvageable into a PR -- fail terminally but PRESERVE the worktree.
    this.finaliseFailedPreserveWorktree(sessionId, "stalled_no_progress", cycles, totalCost);
    return "failed_preserved";
  }

  /** beta.63: read the persisted lead plan JSON for a session (or null). */
  /**
   * beta.101 / beta.105: is every commit this session recorded still reachable
   * from the worktree's HEAD?
   *
   * b101 built this and ran it in ONE place: immediately before the adversary
   * SDK call. The b103 smoke (session b8ece861) showed why that is not enough.
   * A clarification resume moved the branch ref off the run's own work -- eight
   * of ten ledger commits stopped being ancestors of the tip -- and the run then
   * stalled at a second clarification and was aborted. The guard never ran once,
   * because the session never reached review. The loss was found four hours
   * later, by hand, in a post-mortem.
   *
   * So this is now a shared probe with two call sites: at RESUME (right after a
   * re-plan re-allocates the worktree, which is the operation that loses
   * commits) and before REVIEW (unchanged). Extracted rather than duplicated so
   * the two can never drift apart.
   *
   * Fails OPEN on a probe error: an unreachable-commit check that cannot run
   * must not block an otherwise sound run.
   */
  /**
   * beta.108: emit `loop.phase_timing` so every phase of a run is attributable.
   *
   * Deliberately one event shape rather than a bespoke field per phase, so a
   * report can sum `durationMs` grouped by `phase` and have the total match the
   * wall clock. Never throws -- timing must not be able to fail a run.
   */
  private emitPhaseTiming(
    sessionId: string,
    phase: "planning" | "executing" | "review" | "ship",
    cycle: number,
    startedAtMs: number,
    extra: Record<string, unknown> = {},
  ): void {
    try {
      this.deps.state.audit(
        "loop.phase_timing",
        { sessionId, phase, cycle, durationMs: Math.max(0, Date.now() - startedAtMs), ...extra },
        sessionId,
      );
    } catch {
      /* observability only */
    }
  }

  /**
   * beta.109: how many of a review's findings would justify another cycle.
   *
   * Uses isBlockingFinding -- diff-addressable AND medium or above -- so this
   * agrees with the convention-finding gate rather than inventing a second,
   * looser notion of "serious" alongside merge-recommendation's high-and-above
   * BLOCKING_SEVERITIES.
   */
  private countBlockingFindings(findings: ReviewFinding[] | undefined): number {
    if (!findings) return 0;
    return findings.filter((f) => isBlockingFinding(f, classifyFinding(f, { repoHasTestScript: true }))).length;
  }

  private async checkLedgerReachability(
    sessionId: string,
    worktreePath: string,
    cycle: number,
    phase: "resume" | "review",
  ): Promise<{ failed: boolean; unreachable: string[]; headSha: string; detail: string }> {
    const none = { failed: false, unreachable: [] as string[], headSha: "", detail: "" };
    if (!this.deps.unreachableCommits) return none;
    try {
      const rows = this.deps.state.db
        .prepare(`SELECT seq, commit_sha, description FROM sub_tasks WHERE session_id = ? AND commit_sha IS NOT NULL AND commit_sha != '' ORDER BY cycle, seq`)
        .all(sessionId) as Array<{ seq: number; commit_sha: string; description: string | null }>;
      // beta.102: union with the append-only audit log. sub_tasks rows are
      // keyed by (cycle, seq) and REPLACED, so a clarification re-plan -- which
      // restarts at cycle 1 -- erases the commit_sha of any row whose seq the
      // new plan reuses. Reading only that table would blind this guard on
      // precisely the runs it exists to protect. See mergeLedgerCommits.
      const auditRows = this.deps.state.db
        .prepare(`SELECT payload FROM audit_log WHERE session_id = ? AND event = 'loop.worker_end_turn' ORDER BY created_at`)
        .all(sessionId) as Array<{ payload: string }>;
      const fromAudit: LedgerCommit[] = [];
      for (const a of auditRows) {
        try {
          const p = JSON.parse(a.payload) as { seq?: number; commitSha?: string | null; commitShas?: unknown };
          const seq = Number(p?.seq ?? -1);
          // beta.103: prefer the full per-turn tip list; fall back to the single
          // `commitSha` for turns recorded before b103.
          const many = Array.isArray(p?.commitShas) ? p.commitShas : [];
          for (const s of many) {
            if (typeof s === "string" && s.trim()) fromAudit.push({ seq, commitSha: s.trim() });
          }
          if (many.length === 0 && p?.commitSha) fromAudit.push({ seq, commitSha: String(p.commitSha) });
        } catch { /* a malformed payload must not break the guard */ }
      }
      const ledger = mergeLedgerCommits(
        rows.map((r) => ({ seq: r.seq, commitSha: r.commit_sha, title: r.description ?? undefined })),
        fromAudit,
      );
      // A fresh run has recorded nothing yet, so there is nothing to lose. This
      // is what makes the resume call site safe to make unconditionally.
      if (ledger.length === 0) return none;
      const headSha = this.deps.worktreeHeadSha
        ? await this.deps.worktreeHeadSha(worktreePath).catch(() => "")
        : "";
      const bad = await this.deps.unreachableCommits(worktreePath, headSha || "HEAD", ledger.map((e) => e.commitSha));
      const integrity = buildLedgerIntegrityReport(ledger, bad);
      this.deps.state.audit(
        "loop.ledger_reachability_checked",
        { sessionId, cycle, phase, headSha, checked: integrity.checked, unreachableCount: integrity.unreachable.length, ok: integrity.ok },
        sessionId,
      );
      if (integrity.ok) return { ...none, headSha };
      const detail = describeLedgerIntegrityFailure(integrity, headSha);
      this.deps.state.audit(
        "loop.ledger_commits_unreachable",
        {
          sessionId, cycle, phase, headSha,
          checked: integrity.checked,
          unreachable: integrity.unreachable.map((e) => ({ seq: e.seq, commitSha: e.commitSha })),
        },
        sessionId,
      );
      this.deps.interactionLog?.log(sessionId, {
        event: "ledger_commits_unreachable", phase: phase === "resume" ? "plan" : "review", cycle,
        unreachable: integrity.unreachable.map((e) => e.commitSha),
      });
      return { failed: true, unreachable: integrity.unreachable.map((e) => e.commitSha), headSha, detail };
    } catch (err) {
      this.deps.logger.warn("[loop] ledger reachability guard failed (non-fatal; continuing)", {
        sessionId, cycle, phase, err: String(err),
      });
      return none;
    }
  }

  private getPlanJson(sessionId: string): string | null {
    try {
      const r = this.deps.state.db.prepare(`SELECT lead_plan_json FROM sessions WHERE id = ?`).get(sessionId) as { lead_plan_json: string | null } | undefined;
      return r?.lead_plan_json ?? null;
    } catch { return null; }
  }

  /** beta.63: read the most recent completed review for a session (or undefined). */
  private getLastReview(sessionId: string): ReviewReport | undefined {
    try {
      const r = this.deps.state.db
        .prepare(`SELECT verdict, findings, summary, cost_usd AS costUsd, sdk_session_id AS sdkSessionId FROM reviews WHERE session_id = ? ORDER BY cycle DESC LIMIT 1`)
        .get(sessionId) as { verdict: string; findings: string; summary: string; costUsd: number; sdkSessionId: string | null } | undefined;
      if (!r) return undefined;
      return {
        verdict: r.verdict as ReviewReport["verdict"],
        findings: JSON.parse(r.findings ?? "[]"),
        summary: r.summary ?? "",
        costUsd: r.costUsd ?? 0,
        tokensIn: 0,
        tokensOut: 0,
        sdkSessionId: r.sdkSessionId ?? undefined,
      };
    } catch { return undefined; }
  }

  /**
   * beta.62 (fix #2/#3): handle an adversary-review CRASH. The completed,
   * self-verified sub-task work must not be silently discarded (the
   * b60-attempt-2 failure). GRACEFUL PATH -- when all of:
   *   - `graceful_pr_on_review_crash` is not disabled, AND
   *   - a PRIOR cycle already produced a completed adversary review
   *     (`priorReview`), AND
   *   - this cycle's own sub-task self-verification is fully GREEN (the latest
   *     verification for every sub-task passed),
   * open the PR anyway with `merge_recommendation = 'needs_human_review'` so a
   * human can inspect the adversary-motivated commits. The harness_merge_pr
   * hard gate refuses `needs_human_review` (never auto-overridable), so this
   * cannot silently ship unverified code -- it just preserves the deliverable.
   * OTHERWISE fail terminally but PRESERVE the worktree (fix #3) so the branch
   * remains inspectable on disk. Never throws.
   *
   * beta.90 (Feature 1): an INFRASTRUCTURE crash (out of disk / memory / IO /
   * transport -- see infra-crash.ts) with GREEN self-verify is ALSO eligible,
   * WITHOUT requiring cycle>=2 or a prior review, because it is an environment
   * failure that says nothing about the code. When there is no prior review to
   * ship, a minimal `revise` review is synthesized so the graceful PR still
   * opens flagged needs_human_review.
   */
  private async finaliseReviewCrash(
    sessionId: string,
    err: unknown,
    cycle: number,
    totalCost: number,
    ctx: { plan: LeadPlan; brief: CrystallisedBrief; lastReview: ReviewReport | undefined; row: { requester: string } },
  ): Promise<LoopOutcome> {
    const reason = `review_crash: ${String((err as Error)?.message ?? err)}`;
    const gracefulEnabled = this.deps.config.loop.graceful_pr_on_review_crash !== false;
    const priorReview = ctx.lastReview; // set only after a PRIOR cycle's review persisted
    const selfVerify = this.readLocalVerification(sessionId);
    const selfVerifyGreen = selfVerify.length > 0 && selfVerify.every((v) => v.ok);

    // beta.90 (Feature 1): an INFRASTRUCTURE crash (ENOSPC/out-of-disk, ENOMEM,
    // EMFILE, ECONNRESET/socket-hang-up, etc.) is an ENVIRONMENT failure, not a
    // signal about the code under review. It must NOT sink a fully self-verified
    // run just because it happened on cycle 1 (no prior review). When the crash
    // is infra AND every sub-task self-verified green, recovery is eligible
    // WITHOUT requiring cycle>=2 or a prior review -- we open a
    // needs_human_review PR (never auto-mergeable) so the deliverable survives.
    const infra = isInfraCrash(String((err as Error)?.message ?? err));
    const eligible = gracefulEnabled && selfVerifyGreen && (infra || (cycle >= 2 && !!priorReview));
    this.deps.state.audit(
      "loop.review_crash_recovery",
      {
        sessionId,
        cycle,
        eligible,
        gracefulEnabled,
        infra,
        hasPriorReview: !!priorReview,
        selfVerifyGreen,
        selfVerifySubtasks: selfVerify.length,
        selfVerifyFailed: selfVerify.filter((v) => !v.ok).map((v) => v.seq),
      },
      sessionId,
    );

    if (!eligible) {
      // Not salvageable into a PR -- fail, but keep the worktree (fix #3).
      return this.finaliseFailedPreserveWorktree(sessionId, reason, cycle, totalCost);
    }

    // beta.90: when eligible via the INFRA path but there is NO prior review to
    // ship, synthesize a minimal `revise` ReviewReport so the graceful push has
    // a report to attach (mirrors the STALL graceful-PR pattern). The PR is
    // flagged needs_human_review either way, so this cannot silently ship
    // unverified code -- it just preserves the self-verified deliverable.
    const synthesizedReview: ReviewReport = {
      verdict: "revise",
      findings: [],
      summary:
        "Adversary review crashed on an infrastructure error (e.g. out of disk) before producing a verdict; all sub-tasks self-verified green. Opened for MANUAL human review.",
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    const reviewForPr = priorReview ?? synthesizedReview;

    // GRACEFUL PR: open the PR on the existing branch using the last COMPLETED
    // review (the prior cycle's) or the synthesized infra-crash review, flagged
    // needs_human_review.
    let prUrl: string;
    try {
      prUrl = await this.deps.pushBranchAndOpenPr({
        plan: ctx.plan,
        brief: ctx.brief,
        reviewReport: reviewForPr,
        requester: ctx.row.requester,
      });
    } catch (pushErr) {
      this.deps.state.audit(
        "loop.review_crash_pr_failed",
        { sessionId, cycle, error: String((pushErr as Error)?.message ?? pushErr) },
        sessionId,
      );
      // Push failed too -- preserve the worktree so the branch is still
      // inspectable on disk.
      return this.finaliseFailedPreserveWorktree(sessionId, `${reason}; graceful_pr_failed: ${String(pushErr)}`, cycle, totalCost);
    }

    const recReason = infra
      ? `The adversary review for cycle ${cycle} crashed on an INFRASTRUCTURE error (e.g. out of disk) before producing a verdict, but all ${selfVerify.length} sub-task(s) self-verified green. ` +
        `The commits are opened for MANUAL human review -- there is no machine sign-off, so this is NOT auto-mergeable.`
      : `The adversary review for cycle ${cycle} crashed before producing a verdict, but all ${selfVerify.length} sub-task(s) self-verified green and the prior cycle's review was addressed. ` +
        `The commits are opened for MANUAL human review -- there is no machine sign-off, so this is NOT auto-mergeable.`;
    const prNumber = parsePrNumber(prUrl);
    this.deps.state.db
      .prepare(
        `UPDATE sessions SET final_pr_url = ?, pr_number = ?, merge_recommendation = ?, merge_recommendation_reason = ?, status = 'done', updated_at = ? WHERE id = ?`,
      )
      .run(prUrl, prNumber ?? null, "needs_human_review", recReason, Date.now(), sessionId);
    this.deps.state.audit(
      "loop.shipped",
      { sessionId, prUrl, prNumber, mergeRecommendation: "needs_human_review", reason: recReason, viaReviewCrashRecovery: true, viaInfraCrash: infra },
      sessionId,
    );
    // The deliverable is safely on origin as a PR; releasing the local
    // worktree is fine here (unlike the non-graceful path).
    await this.tryReleaseWorktree(sessionId, ctx.plan.repo, ctx.plan.worktreePath, "shipped");
    return { status: "shipped", sessionId, prUrl, cycles: cycle, totalCostUsd: totalCost };
  }

  /**
   * beta.55 (B2): pause the session for a human decision. Persists the
   * question + the paused sub-task seq and sets status `awaiting_clarification`.
   * CRITICAL: does NOT release the worktree (unlike finaliseFailed/Abort) so
   * harness_answer can re-drive the loop from the paused seq in place. The
   * worktree-heal protect set (beta.45) + recovery both treat
   * `awaiting_clarification` as resumable, so a stray re-register or restart
   * won't reap the worktree or auto-fail the pause.
   */
  private finaliseAwaitingClarification(
    sessionId: string,
    question: string,
    seq: number,
    cycles: number,
    totalCostUsd: number,
    subtask?: { title: string; intent: string } | null,
  ): LoopOutcome {
    this.setStatus(sessionId, "awaiting_clarification");
    this.deps.state.db.prepare(
      `UPDATE sessions SET clarification_question = ?, clarification_seq = ?, clarification_answer = NULL, clarification_subtask = ?, updated_at = ? WHERE id = ?`,
    ).run(question, seq, subtask ? JSON.stringify(subtask) : null, Date.now(), sessionId);
    this.deps.state.audit(
      "loop.clarification_requested",
      { sessionId, seq, question: question.slice(0, 1000), cycle: cycles },
      sessionId,
    );
    this.deps.logger.warn("[loop] paused for clarification (awaiting_clarification); worktree preserved", {
      sessionId, seq, question: question.slice(0, 200),
    });
    // Deliberately NO scheduleWorktreeReleaseForSession -- the worktree must
    // survive so the answered resume continues in place.
    return { status: "awaiting_clarification", sessionId, question, seq, cycles, totalCostUsd };
  }
}

/**
 * beta.63 (Part A/B): map a loop status to the interaction-log phase
 * classification. Kept a free function so it is importable by tests.
 */
export function mapPhase(status: LoopStatus): InteractionPhase {
  switch (status) {
    case "crystallising": return "classify";
    case "planning": return "plan";
    case "executing": return "worker";
    case "reviewing": return "review";
    case "done":
    case "failed":
    case "aborted": return "finalize";
    default: return "unknown";
  }
}

/** Median of a non-empty numeric array. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/**
 * Kahn's-algorithm topological sort of sub-tasks by `dependsOn`.
 * Stable: preserves original seq order among independent tasks.
 * Throws on cycles.
 */
export function topoSortSubTasks(subTasks: LeadPlanSubTask[]): LeadPlanSubTask[] {
  const bySeq = new Map(subTasks.map((s) => [s.seq, s] as const));
  const remainingDeps = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const s of subTasks) {
    const deps = (s.dependsOn ?? []).filter((d) => bySeq.has(d));
    remainingDeps.set(s.seq, deps.length);
    for (const d of deps) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d)!.push(s.seq);
    }
  }
  const ready: number[] = subTasks
    .filter((s) => (remainingDeps.get(s.seq) ?? 0) === 0)
    .map((s) => s.seq)
    .sort((a, b) => a - b);
  const out: LeadPlanSubTask[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    out.push(bySeq.get(next)!);
    for (const dep of dependents.get(next) ?? []) {
      const left = (remainingDeps.get(dep) ?? 0) - 1;
      remainingDeps.set(dep, left);
      if (left === 0) {
        // Insert-in-order to keep stable ordering
        const pos = ready.findIndex((r) => r > dep);
        if (pos === -1) ready.push(dep);
        else ready.splice(pos, 0, dep);
      }
    }
  }
  if (out.length !== subTasks.length) {
    throw new Error(`sub-task dependency cycle detected (only sorted ${out.length}/${subTasks.length})`);
  }
  return out;
}
