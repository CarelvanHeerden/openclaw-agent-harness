/**
 * Fable-5 lead.
 *
 * Given a crystallised brief, produces:
 *   - a sub-task decomposition (ordered list of atomic units of work)
 *   - a risk assessment used to size the review effort
 *   - an initial repo/branch plan (repo name, branch name, worktree path)
 *
 * The lead never writes code itself. It only plans and delegates. It also
 * writes a "review checklist" that the adversary consumes on cycle N.
 */
import { boundScoutReportDetailed, SCOUT_REPORT_MAX_CHARS } from "./lead-scout.js";
/**
 * beta.108: make a fresh branch name unique to its session, and STABLE for it.
 *
 * The lead invents the branch and validation only checked the `harness/`
 * prefix, so two concurrent sessions on related briefs could draw the same
 * slug. In a single-user harness that never surfaced; with a Slack channel
 * where every thread is an independent run against one repo, it is a matter of
 * time. The consequence is quiet: GitHub folds the second push into the first
 * session's pull request and the review reads two unrelated changes as one.
 *
 * Stability matters as much as uniqueness. A clarification re-drive re-plans
 * from scratch, and nothing obliged the lead to re-emit the same slug -- so the
 * b101 `preserveLocalBranch` machinery could go looking for a branch under the
 * old name, not find it, and fall through to `reset_to_base`. That is precisely
 * the shape of the b100 lost-commits defect. Deriving the suffix from the
 * session id makes the name reproducible across every re-plan of that session.
 *
 * Skipped for a revise, where `pinnedBranch` must match the existing PR.
 */
/**
 * beta.113: which repo should the scout open?
 *
 * The brief's hint when it has one. Otherwise the allow-list, but only when it
 * names exactly one concrete repo -- two candidates means the lead has a real
 * choice and scouting one could prime the plan for the wrong codebase, and a
 * glob names no single repo to clone.
 *
 * Exists because the DR/BCP run logged `skippedReason=no_repo_hint` and then
 * planned eight sub-tasks for a 6,769-file repo blind, while `repos.allowed`
 * held the single repo the loop went on to clone twenty seconds later.
 */
export function resolveScoutRepo(repoHint, allowed) {
    if (repoHint && repoHint.includes("/"))
        return repoHint;
    const entries = (allowed ?? []).map((r) => (r ?? "").trim()).filter(Boolean);
    // The WHOLE list must be that one repo. Filtering globs out first and taking
    // the last concrete entry standing would read `["owner/repo", "other/*"]` as
    // unambiguous, when the run may legitimately target anything under `other/`.
    if (entries.length !== 1)
        return undefined;
    const only = entries[0];
    return only.includes("/") && !only.includes("*") ? only : undefined;
}
export function sessionScopedBranch(branch, sessionId) {
    const suffix = (sessionId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase();
    if (!suffix)
        return branch;
    const b = (branch ?? "").trim().replace(/\/+$/, "");
    // Idempotent: a re-plan of the same session must not stack suffixes.
    if (b.endsWith(`-${suffix}`))
        return b;
    return `${b}-${suffix}`;
}
/**
 * beta.99 (P0-2): merge bounded top-up contexts into the plan IN PLACE.
 * Only fills seqs that are currently insubstantive, and only when the
 * incoming block is itself substantive -- so a vague top-up can never
 * overwrite context the lead already got right. Returns the seqs merged.
 */
export function mergeWorkerContexts(plan, topUp) {
    if (!Array.isArray(topUp) || topUp.length === 0)
        return [];
    const merged = [];
    for (const entry of topUp) {
        if (!entry || typeof entry.seq !== "number" || !entry.workerContext)
            continue;
        const target = plan.subTasks.find((st) => st.seq === entry.seq);
        if (!target)
            continue;
        if (hasSubstantiveWorkerContext(target.workerContext))
            continue;
        if (!hasSubstantiveWorkerContext(entry.workerContext))
            continue;
        target.workerContext = entry.workerContext;
        merged.push(entry.seq);
    }
    return merged;
}
/**
 * beta.67 (P0a): raised when a plan fails workerContext enforcement AFTER the
 * one bounded lead re-ask. Surfaced as a plan failure -- a loud fail at
 * planning beats another silent workers-no-op'd revise cycle downstream.
 */
export class LeadPlanValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "LeadPlanValidationError";
    }
}
// beta.67 (P0a): minimum length for a changeSpec to count as substantive.
const CHANGESPEC_MIN_CHARS = 40;
// beta.67 (P0a): a changeSpec / excerpt must reference a FILE to be actionable.
// Kills the length-only hole where filler prose passes on length alone.
const PATH_TOKEN_RE = /\S+\.(ts|tsx|js|jsx|py|go|rs|md|json|ya?ml)\b|\S+\/\S+/;
/**
 * beta.67 (P0a): SUBSTANCE check for a sub-task's workerContext -- not mere
 * field presence. rationale non-empty AND (file-anchored changeSpec >=40 chars
 * OR a codeExcerpts entry with a real snippet + path). gotchas/relatedSymbols
 * are optional garnish and do NOT satisfy the gate.
 */
export function hasSubstantiveWorkerContext(wc) {
    if (!wc)
        return false;
    const hasRationale = typeof wc.rationale === "string" && wc.rationale.trim().length > 0;
    if (!hasRationale)
        return false;
    const changeSpecOk = typeof wc.changeSpec === "string" &&
        wc.changeSpec.trim().length >= CHANGESPEC_MIN_CHARS &&
        PATH_TOKEN_RE.test(wc.changeSpec);
    const excerptOk = Array.isArray(wc.codeExcerpts) &&
        wc.codeExcerpts.some((e) => !!e &&
            typeof e.snippet === "string" &&
            e.snippet.trim().length > 0 &&
            typeof e.path === "string" &&
            e.path.trim().length > 0);
    return changeSpecOk || excerptOk;
}
// beta.67 (P0a): mutate/mixed MUST carry substantive workerContext; observe is
// exempt. `mixed` is gated same as `mutate` (a mixed sub-task that mutates
// without context is the beta.63/64 failure mode wearing a hat).
const CONTEXT_REQUIRED_MODES = new Set(["mutate", "mixed"]);
/** beta.67 (P0a): seqs of mutate/mixed sub-tasks lacking substantive context. */
export function subTasksMissingWorkerContext(plan) {
    return plan.subTasks
        .filter((st) => CONTEXT_REQUIRED_MODES.has(st.taskMode ?? "") &&
        !hasSubstantiveWorkerContext(st.workerContext))
        .map((st) => st.seq);
}
/**
 * beta.94 (Feature 1): mutate-scope verify kinds. A sub-task whose verify
 * carries ANY of these is a real mutation step (writes/commits/pushes), not a
 * pure observation. Used to distinguish a genuinely-empty pure-observe
 * "final scope verification" sub-task from a mutate sub-task.
 */
const MUTATE_VERIFY_KINDS = new Set([
    "file_written",
    "file_committed",
    "commit_made",
    "branch_pushed",
    "file_pushed",
    "pr_opened",
]);
/**
 * beta.94 (Feature 1): heuristic for a scope/boundary "final verification"
 * sub-task -- the b93 seq-12 idle-stall signature. Matches phrasings like
 * "final verification of scope boundaries", "verify nothing outside scope was
 * touched", "confirm scope boundaries".
 */
const SCOPE_VERIFY_DESC_RE = /scope|boundar|final.{0,15}verif|nothing.{0,10}(outside|touched)/i;
/**
 * beta.94 (Feature 1): is `st` a TRAILING PURE-OBSERVE scope-verification
 * sub-task that can be safely elided?
 *
 *   - taskMode === "observe" (explicitly read-only), AND
 *   - it declares NO mutate verify kind (nothing to write/commit/push), AND
 *   - its title/intent/successCriteria match SCOPE_VERIFY_DESC_RE.
 *
 * Such a sub-task has nothing to produce, so a worker can go IDLE on it
 * indefinitely while adding zero signal: every prior mutate sub-task already
 * passed strict per-file contract verification, and runFinalVerifyChecks runs
 * the repo convention scripts deterministically. Pure/deterministic.
 */
export function isElidableFinalScopeSubTask(st) {
    if (st.taskMode !== "observe")
        return false;
    const hasMutateVerify = Array.isArray(st.verify) && st.verify.some((v) => MUTATE_VERIFY_KINDS.has(v.kind));
    if (hasMutateVerify)
        return false;
    const text = `${st.title ?? ""} ${st.intent ?? ""} ${(st.successCriteria ?? []).join(" ")}`;
    return SCOPE_VERIFY_DESC_RE.test(text);
}
/**
 * beta.94 (Feature 1a): DROP a trailing pure-observe scope-verification
 * sub-task from the worker plan (the b93 seq-12 idle-prone "final verification
 * of scope boundaries" step). Only the LAST sub-task is a candidate, and only
 * if NOTHING depends on it. Mutates `plan.subTasks` in place and returns the
 * elided sub-task (so the caller can audit `loop.final_verify_subtask_elided`),
 * or `undefined` when nothing was elided. Pure aside from the in-place splice;
 * never throws.
 */
export function elideFinalScopeSubTask(plan) {
    const subs = plan.subTasks;
    if (!Array.isArray(subs) || subs.length <= 1)
        return undefined; // never elide the only sub-task
    const last = subs[subs.length - 1];
    if (!isElidableFinalScopeSubTask(last))
        return undefined;
    // Do not drop if any other sub-task depends on it (topo integrity).
    const dependedOn = subs.some((s) => (s.dependsOn ?? []).includes(last.seq));
    if (dependedOn)
        return undefined;
    plan.subTasks = subs.slice(0, -1);
    return { seq: last.seq, title: last.title };
}
export async function runLeadPlanner(brief, deps) {
    // beta.67 (P0a): one BOUNDED re-ask ([initial, one re-ask]); a second
    // insubstantive plan hard-throws so it surfaces as a plan failure.
    // Optional-chain `loop`: some unit-test deps pass a partial config without a
    // `loop` block. Real HarnessConfig always has it; missing -> enforcement on
    // (but a plan with no mutate/mixed sub-tasks trivially passes the gate).
    const enforceContext = deps.config.loop?.enforce_worker_context !== false;
    const maxAttempts = enforceContext ? 2 : 1;
    let raw;
    let correctiveNote;
    // beta.73 (D2): when the brief carries a `branchHint` that names an EXISTING
    // remote branch (e.g. an open PR's branch) and it is NOT already a pinned
    // revise, promote it to `pinnedBranch`. This is the fix for session
    // 70341bc3: a harness_run brief said `branchHint:
    // harness/grc-changes-export-mode` + "build on the existing branch (PR #876),
    // do not open a new PR", but branchHint is only a NAME hint -- reuse
    // (checkout the branch HEAD) was gated on `pinnedBranch`, which was unset. So
    // the worktree reset to main (whose route.ts lacked the export handler) and
    // the worker had to reconstruct-then-revert it just to verify. Promoting the
    // hint to pinned makes index.ts's `reuseExistingBranch: !!brief.pinnedBranch`
    // check out the branch's own head. Guarded by an existence check so a hint
    // for a NEW branch still creates it fresh (unchanged behaviour). Best-effort:
    // if the check dep is absent or throws, we skip the promotion.
    if (!brief.pinnedBranch && brief.branchHint && deps.remoteBranchExists) {
        try {
            const repoForCheck = brief.repoHint && brief.repoHint.includes("/") ? brief.repoHint : undefined;
            if (repoForCheck && (await deps.remoteBranchExists(repoForCheck, brief.branchHint))) {
                brief.pinnedBranch = brief.branchHint;
                deps.logger.info("[lead] branchHint names an existing remote branch -> promoting to pinned/reuse", {
                    branch: brief.branchHint,
                    repo: repoForCheck,
                });
            }
        }
        catch (err) {
            deps.logger.warn?.("[lead] branchHint existence check failed (non-fatal; treating as new branch)", { err: String(err) });
        }
    }
    // beta.104: SCOUT THE REPO BEFORE PLANNING. See lead-scout.ts for why the
    // pre-b104 lead was planning blind and what that cost. Everything here is
    // best-effort: any failure leaves `brief.repoScoutReport` unset, and the
    // planning prompt is then byte-identical to b103's.
    let scoutOutcome = { ran: false, reportChars: 0, skippedReason: "disabled" };
    if (deps.config.loop?.lead_repo_scout_enabled !== false && deps.scoutRepo) {
        // Only scout a repo the run is actually allowed to touch. An unresolvable
        // or disallowed hint means the lead picks the repo itself, so there is no
        // worktree we could legitimately allocate at this point.
        const allowed = deps.config.repos?.allowed ?? [];
        // beta.113: fall back to the allow-list when the brief carries no hint.
        //
        // The DR/BCP run logged `lead_scout ran=false skippedReason=no_repo_hint`
        // and then planned eight sub-tasks for a 6,769-file repo without ever
        // opening it. The repo was never ambiguous: `repos.allowed` held exactly
        // one concrete entry, and the loop cloned precisely that one about twenty
        // seconds later. The gate was reading `brief.repoHint`, which the
        // crystalliser only sets when the request text happens to name a repo --
        // and a spec written for humans usually does not.
        //
        // Exactly one concrete entry, or nothing. Two candidates means the lead
        // genuinely has a choice to make and scouting one of them could prime the
        // plan for the wrong codebase; a glob names no single repo to clone.
        const repoForScout = resolveScoutRepo(brief.repoHint, allowed);
        if (!repoForScout) {
            scoutOutcome = {
                ran: false,
                reportChars: 0,
                skippedReason: allowed.length > 0 ? "no_repo_hint_and_no_sole_allowed_repo" : "no_repo_hint",
            };
        }
        else if (allowed.length > 0 && !isRepoAllowed(repoForScout, allowed)) {
            scoutOutcome = { ran: false, reportChars: 0, skippedReason: "repo_not_allowed" };
        }
        else {
            const startedAt = Date.now();
            try {
                const result = await deps.scoutRepo({ brief, repoFullName: repoForScout });
                const bounds = boundScoutReportDetailed(result?.report ?? "", deps.config.loop?.lead_scout_max_chars ?? SCOUT_REPORT_MAX_CHARS);
                const report = bounds.text;
                if (report) {
                    brief.repoScoutReport = report;
                    scoutOutcome = {
                        ran: true,
                        reportChars: report.length,
                        costUsd: result?.costUsd,
                        durationMs: Date.now() - startedAt,
                        timedOut: result?.timedOut === true ? true : undefined,
                        truncated: bounds.truncated ? true : undefined,
                        reportCharsRaw: bounds.originalChars,
                    };
                    deps.logger.info("[lead] beta.104: scouted the repo before planning", {
                        repo: repoForScout, reportChars: report.length, durationMs: scoutOutcome.durationMs,
                        timedOut: scoutOutcome.timedOut ?? false,
                    });
                    if (bounds.truncated) {
                        // Not fatal -- both ends survive -- but it means the ceiling is
                        // binding for this repo, which is a knob-tuning signal that b106
                        // had no way to surface.
                        deps.logger.warn?.("[lead] beta.107: scout report exceeded the ceiling; kept both ends, dropped the middle", {
                            repo: repoForScout, reportCharsRaw: bounds.originalChars, omittedChars: bounds.omittedChars,
                            ceiling: deps.config.loop?.lead_scout_max_chars ?? SCOUT_REPORT_MAX_CHARS,
                        });
                    }
                }
                else {
                    scoutOutcome = { ran: false, reportChars: 0, skippedReason: "empty_report", durationMs: Date.now() - startedAt };
                    deps.logger.warn?.("[lead] beta.104: scout returned an empty report; planning blind (pre-b104 behaviour)", {
                        repo: repoForScout,
                    });
                }
            }
            catch (err) {
                scoutOutcome = {
                    ran: false, reportChars: 0, skippedReason: "error",
                    error: String(err).slice(0, 300), durationMs: Date.now() - startedAt,
                };
                deps.logger.warn?.("[lead] beta.104: scout FAILED; planning blind (non-fatal, pre-b104 behaviour)", {
                    repo: repoForScout, err: String(err).slice(0, 300),
                });
            }
        }
    }
    else if (!deps.scoutRepo) {
        scoutOutcome = { ran: false, reportChars: 0, skippedReason: "unwired" };
    }
    // beta.99 (P0-1): the LAST plan that parsed AND validated. b98 (session
    // f2613eec) proved why this must exist: lead call #1 returned a perfectly
    // good plan whose only sin was thin workerContext, the b67 gate re-asked for
    // the WHOLE plan with MORE prose, that bigger reply blew the output ceiling,
    // and the resulting throw propagated out of runLeadPlanner -- discarding the
    // valid plan we already held. A run must never die holding a usable plan.
    let lastValid;
    let lastValidMissing = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            raw = await deps.callLeadModel(brief, deps.config.repos.allowed, correctiveNote);
            // beta.44: revise flow. Override the lead branch/repo BEFORE validation.
            if (brief.pinnedBranch) {
                raw.branch = brief.pinnedBranch;
                if (brief.repoHint && brief.repoHint.includes("/"))
                    raw.repo = brief.repoHint;
                deps.logger.info("[lead] revise: branch pinned", { branch: raw.branch, repo: raw.repo, reviseOf: brief.reviseOfSessionId });
            }
            else if (deps.sessionId) {
                raw.branch = sessionScopedBranch(raw.branch, deps.sessionId);
            }
            // beta.33: defensively strip push/PR sub-tasks BEFORE validation.
            sanitizeRemoteSubTasks(raw, deps.logger);
            validatePlan(raw, deps.config);
        }
        catch (err) {
            // beta.99 (P0-1): a FAILED re-ask must not destroy the plan we already
            // banked. Only a failure with nothing banked is terminal.
            if (attempt > 1 && lastValid) {
                deps.logger.warn?.("[lead] workerContext re-ask FAILED; falling back to the previous VALID plan rather than failing the run (beta.99)", { err: String(err).slice(0, 300), missingSeqs: lastValidMissing, reviseOf: brief.reviseOfSessionId });
                raw = lastValid;
                break;
            }
            throw err;
        }
        // beta.67 (P0a): workerContext substance gate (mutate/mixed only).
        if (!enforceContext)
            break;
        const missing = subTasksMissingWorkerContext(raw);
        if (missing.length === 0)
            break;
        lastValid = raw;
        lastValidMissing = missing;
        if (attempt < maxAttempts) {
            // beta.99 (P0-2): prefer the BOUNDED context top-up -- ask ONLY for the
            // missing workerContext blocks and merge them into the plan we already
            // have. The whole-plan re-ask below is what truncated on b98: its output
            // size is the entire plan PLUS the extra prose, on every retry.
            if (deps.callWorkerContextModel) {
                try {
                    const topUp = await deps.callWorkerContextModel(brief, raw, missing);
                    const merged = mergeWorkerContexts(raw, topUp);
                    const stillMissing = subTasksMissingWorkerContext(raw);
                    deps.logger.info("[lead] bounded workerContext top-up applied (beta.99)", {
                        requestedSeqs: missing,
                        mergedSeqs: merged,
                        stillMissing,
                    });
                    if (stillMissing.length === 0)
                        break;
                    // Partial success still shrinks the whole-plan re-ask below.
                    lastValidMissing = stillMissing;
                }
                catch (err) {
                    deps.logger.warn?.("[lead] bounded workerContext top-up failed; falling back to whole-plan re-ask", {
                        err: String(err).slice(0, 300),
                        missingSeqs: missing,
                    });
                }
            }
            const stillMissing = subTasksMissingWorkerContext(raw);
            correctiveNote =
                `WORKER CONTEXT REQUIRED: sub-tasks [${stillMissing.join(", ")}] are taskMode mutate/mixed but ` +
                    `their workerContext is missing or insubstantive. For EACH of those seqs you MUST provide a ` +
                    `workerContext with a non-empty rationale AND concrete file-anchored guidance -- either a ` +
                    `changeSpec that names the exact file+location of the edit (>=40 chars, referencing a real ` +
                    `path like src/foo/bar.ts) OR a codeExcerpts entry with the actual code you read (with its ` +
                    `path). A worker CANNOT implement these correctly from a bare intent; hand down your ` +
                    `investigation. If you cannot produce concrete context for a sub-task, it is mis-scoped -- ` +
                    `split it into an observe (investigate) step + a mutate (implement) step, or reduce its scope.` +
                    // beta.99 (P0-3): the b98 reply blew the output ceiling because this
                    // note demands MORE prose with no size bound. Bound it explicitly, and
                    // keep it consistent with the truncation-retry instruction so the two
                    // can never contradict each other inside one prompt again.
                    `\nSIZE LIMIT (HARD): return the COMPLETE plan as ONE closed JSON object. Keep every other field ` +
                    `EXACTLY as you already wrote it -- do not re-expand prose elsewhere. Keep each changeSpec under ` +
                    `400 characters and include at most ONE short codeExcerpt (<=15 lines) per sub-task. A COMPLETE ` +
                    `terse plan is REQUIRED; a richer plan that gets cut off is a FAILED plan.`;
            deps.logger.warn?.("[lead] workerContext insufficient; re-asking lead once", { missingSeqs: stillMissing, reviseOf: brief.reviseOfSessionId });
        }
        else {
            // beta.99 (P0-1): the gate has now had its bounded re-ask and the plan is
            // STILL thin. Historically this threw and killed the run. A thin-context
            // plan is a DEGRADED plan (workers start colder), not a broken one -- so
            // by default we ship it with a loud warning instead of burning the whole
            // session. Set loop.require_worker_context_strict:true to restore the
            // old hard-fail.
            if (deps.config.loop?.require_worker_context_strict === true) {
                throw new LeadPlanValidationError(`lead plan sub-tasks [${missing.join(", ")}] are taskMode mutate/mixed but lack substantive ` +
                    `workerContext after one re-ask (rationale + file-anchored changeSpec/excerpt required). ` +
                    `Set loop.enforce_worker_context:false to downgrade this to a warning.`);
            }
            deps.logger.warn?.("[lead] workerContext STILL insufficient after the bounded re-ask; proceeding with the degraded plan " +
                "(workers start colder on these seqs). Set loop.require_worker_context_strict:true to hard-fail instead. (beta.99)", { missingSeqs: missing, reviseOf: brief.reviseOfSessionId });
        }
    }
    if (!raw)
        throw new LeadPlanValidationError("lead plan produced no output");
    // beta.67 (P0a): enforcement off -> WARN-only escape hatch (no retry/throw).
    if (!enforceContext) {
        const missing = subTasksMissingWorkerContext(raw);
        if (missing.length > 0) {
            deps.logger.warn?.("[lead] workerContext insufficient (enforcement disabled; not retrying)", { missingSeqs: missing, reviseOf: brief.reviseOfSessionId });
        }
    }
    const worktreePath = await deps.allocateWorktree(raw.repo, raw.branch, deps.onBranchDecision);
    const approxCostUsd = deps.estimateCost(raw);
    const plan = { ...raw, worktreePath, approxCostUsd, scout: scoutOutcome };
    deps.logger.info("[lead] plan", {
        subTaskCount: plan.subTasks.length,
        risk: plan.riskLevel,
        approxCostUsd,
    });
    return plan;
}
/**
 * beta.104: the allow-list match `validatePlan` has always applied to the
 * lead's chosen repo, extracted so the scout gate uses the SAME rule. An
 * exact-match-only check here would silently skip scouting every repo that is
 * allowed by an `owner/*` glob -- i.e. most of them.
 */
export function isRepoAllowed(repoFullName, allowed) {
    if (!repoFullName.includes("/"))
        return false;
    const owner = repoFullName.split("/")[0];
    return allowed.some((glob) => {
        if (glob === repoFullName)
            return true;
        if (glob.endsWith("/*") && glob.slice(0, -2) === owner)
            return true;
        return false;
    });
}
function validatePlan(plan, config) {
    if (!plan.repo || !plan.repo.includes("/")) {
        throw new Error(`lead plan repo "${plan.repo}" is not owner/repo`);
    }
    const owner = plan.repo.split("/")[0];
    const inAllowList = config.repos.allowed.some((glob) => {
        if (glob === plan.repo)
            return true;
        if (glob.endsWith("/*") && glob.slice(0, -2) === owner)
            return true;
        return false;
    });
    if (!inAllowList) {
        throw new Error(`lead plan repo "${plan.repo}" is not in the allow-list ${JSON.stringify(config.repos.allowed)}`);
    }
    if (!plan.branch.startsWith("harness/")) {
        throw new Error(`lead plan branch "${plan.branch}" must start with "harness/"`);
    }
    if (plan.subTasks.length === 0) {
        throw new Error("lead plan has zero sub-tasks");
    }
    if (plan.subTasks.length > 20) {
        throw new Error(`lead plan has ${plan.subTasks.length} sub-tasks; hard cap is 20`);
    }
    const seqs = new Set(plan.subTasks.map((s) => s.seq));
    if (seqs.size !== plan.subTasks.length)
        throw new Error("duplicate sub-task seq numbers");
}
// beta.33: remote verify kinds a worker can never satisfy (the harness pushes
// + opens the PR itself, after review). Any of these on a sub-task means the
// lead planned a push/PR step, which always failed and aborted the run.
const REMOTE_VERIFY_KINDS = new Set([
    "branch_pushed",
    "remote_branch_exists",
    "file_pushed",
    "pr_opened",
    "pr_state",
    "file_in_pr",
    "commit_sha_matches",
]);
// Push/PR-only intent (no file/commit work) — used to decide if a sub-task is
// purely a (now-forbidden) push/PR step that can be safely dropped.
const PUSH_PR_ONLY_RE = /\b(push(ing|es)?\b|open(ing|s)?\s+(a\s+)?(pull request|pr|merge request|mr)|create\s+(a\s+)?(pull request|pr|merge request|mr))\b/i;
const LOCAL_WORK_RE = /\b(write|edit|modify|add|remove|delete|update|commit|refactor|rename|create\s+file|implement|fix|change)\b/i;
/**
 * beta.33: neutralise push/PR sub-tasks the lead emitted despite the prompt.
 *
 * - Strip all remote verify kinds and force `contractScope: 'local'` on every
 *   sub-task (the harness verifies/pushes remotely, not the worker).
 * - If a sub-task, after stripping, is PURELY a push/PR step (intent matches
 *   push/PR language and has no local-work language) AND nothing depends on
 *   it, drop it entirely — it's redundant with the harness endgame.
 * - Otherwise keep it as a local sub-task with the remote checks removed, so
 *   it can't fail on a remote 404.
 *
 * Mutates `plan` in place. Best-effort + logged; never throws.
 */
function sanitizeRemoteSubTasks(plan, logger) {
    let strippedKinds = 0;
    let coercedScope = 0;
    for (const st of plan.subTasks) {
        // beta.56 (P0-4): coerce to 'local' even when contractScope is ABSENT.
        // The beta.33 sanitiser only rewrote an explicit non-local scope, so a
        // sub-task with no contractScope and no explicit verify fell through to
        // regex inference, which can still infer branch_pushed/pr_opened from
        // ambient wording ("commit so it can be pushed") -- checks a worker can
        // never satisfy. Workers are structurally local-only (the harness pushes
        // after review), so 'local' is always correct here.
        if (st.contractScope !== "local") {
            st.contractScope = "local";
            coercedScope++;
        }
        if (Array.isArray(st.verify) && st.verify.length > 0) {
            const before = st.verify.length;
            st.verify = st.verify.filter((v) => !REMOTE_VERIFY_KINDS.has(v.kind));
            strippedKinds += before - st.verify.length;
        }
    }
    // Identify pure push/PR-only sub-tasks that are safe to drop (nothing
    // depends on them). Do NOT drop if a dependency points at them, to avoid
    // breaking the topo order — just leave them neutralised (local, no remote
    // verify) so the worker no-ops harmlessly.
    const dependedOn = new Set();
    for (const st of plan.subTasks)
        for (const d of st.dependsOn ?? [])
            dependedOn.add(d);
    const droppable = plan.subTasks.filter((st) => {
        const text = `${st.title} ${st.intent} ${(st.successCriteria ?? []).join(" ")}`;
        const pushPrOnly = PUSH_PR_ONLY_RE.test(text) && !LOCAL_WORK_RE.test(text);
        const noVerify = !st.verify || st.verify.length === 0;
        return pushPrOnly && noVerify && !dependedOn.has(st.seq);
    });
    if (droppable.length > 0 && droppable.length < plan.subTasks.length) {
        const dropSeqs = new Set(droppable.map((s) => s.seq));
        plan.subTasks = plan.subTasks.filter((s) => !dropSeqs.has(s.seq));
        logger.info("[lead] beta.33: dropped push/PR-only sub-task(s) (harness pushes after review)", {
            dropped: [...dropSeqs],
        });
    }
    if (strippedKinds > 0 || coercedScope > 0) {
        logger.info("[lead] beta.33: neutralised remote verify on sub-tasks", {
            strippedRemoteKinds: strippedKinds,
            coercedToLocal: coercedScope,
        });
    }
    // beta.57 (P1): the lead prompt now REQUIRES explicit verify + taskMode on
    // every sub-task. Tolerate omissions (regex inference remains the safety
    // net) but surface them loudly so prompt regressions are visible in ops
    // logs instead of silently degrading to inference.
    const missingVerify = plan.subTasks.filter((st) => !Array.isArray(st.verify)).map((st) => st.seq);
    const missingMode = plan.subTasks.filter((st) => !st.taskMode).map((st) => st.seq);
    if (missingVerify.length > 0 || missingMode.length > 0) {
        logger.info("[lead] beta.57: plan omitted explicit verify/taskMode on sub-task(s); falling back to inference", {
            missingVerify,
            missingTaskMode: missingMode,
        });
    }
}
//# sourceMappingURL=fable5-lead.js.map