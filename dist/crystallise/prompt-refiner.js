/**
 * Prompt crystallisation.
 *
 * Rough user request in Slack -> structured, well-scoped brief that a lead
 * agent can plan against. Two-step:
 *
 *   1. Classifier (Haiku) decides intent:
 *      - "dev_task"     : real dev work, proceed to crystallisation.
 *      - "not_dev"      : chat / non-dev request, decline politely.
 *      - "unsafe"       : mentions secrets, deletion, etc.; refuse.
 *
 *   2. If dev_task: the crystalliser produces a strict-schema brief:
 *      { title, motivation, acceptanceCriteria[], filesLikelyTouched[],
 *        outOfScope[], repoHint, riskLevel }.
 *
 * The brief is stored on `sessions.crystallised_prompt` before the confirmed
 * control-plane run starts. Exact authenticated confirmation is handled by
 * OpenClaw before execution begins.
 */
import { resolveRepoAlias } from "./repo-alias.js";
function addSpend(into, from) {
    if (!from)
        return;
    if (typeof from.tokensIn === "number")
        into.tokensIn += from.tokensIn;
    if (typeof from.tokensOut === "number")
        into.tokensOut += from.tokensOut;
    if (typeof from.costUsd === "number")
        into.costUsd += from.costUsd;
    else if (typeof from.tokensIn === "number" || typeof from.tokensOut === "number")
        into.partial = true;
}
/**
 * rc.2: assemble the facts a clarification is allowed to rest on.
 *
 * Everything here comes from operator config or from state the caller checked.
 * Nothing is inferred from model output, per the brief's rule that a
 * model-generated claim is not evidence of repository or worktree state.
 */
export function groundingFrom(config, continuation) {
    const repos = (config?.repos ?? {});
    return {
        allowedRepos: Array.isArray(repos.allowed) ? repos.allowed : [],
        defaultBaseBranch: repos.default_base_branch,
        continuation,
    };
}
/**
 * The pure orchestration -- takes injected callables so unit tests never
 * hit the network.
 */
export async function crystallisePrompt(userText, deps, 
/** beta.21: OKF concepts pre-attached by the caller (typically the OpenClaw agent's context enrichment). Pass-through only — crystalliser does not crawl OKF itself. */
concepts) {
    // v2.0.0-beta.1: every exit carries what it spent. Early rejections still
    // ran a classifier call, so the measured spend must be retained.
    // Reporting zero for them made rejected requests look free. A
    // channel that rejects a hundred prompts a day was invisible in the ledger.
    const spend = { costUsd: 0, tokensIn: 0, tokensOut: 0, partial: false };
    const grounding = groundingFrom(deps.config, deps.continuation);
    const audit = (event, payload) => {
        try {
            deps.audit?.(event, payload);
        }
        catch {
            /* an audit write must never fail crystallisation */
        }
    };
    const cls = await deps.callClassifier(userText);
    addSpend(spend, cls);
    deps.logger.info("[crystalliser] classifier", cls);
    // Older classifier implementations may still emit the retired `clarify`
    // intent. Treat any such dev-shaped ambiguity as a development request and
    // let the crystalliser choose the bounded conservative interpretation. The
    // harness never turns that model suggestion into a user-facing pause.
    const rawIntent = String(cls.intent ?? "");
    const effectiveCls = rawIntent === "clarify"
        ? { intent: "dev_task", reason: `${cls.reason} (resolved internally using conservative defaults)` }
        : cls;
    if (rawIntent === "clarify") {
        deps.logger.info("[crystalliser] classifier ambiguity resolved internally", { reason: cls.reason });
        audit("crystallise.ambiguity_resolved", { role: "classifier", strategy: "conservative_default" });
    }
    if (effectiveCls.intent === "not_dev" || effectiveCls.intent === "unsafe") {
        return { kind: "reject", reason: effectiveCls.reason, intent: effectiveCls.intent, spend };
    }
    if (effectiveCls.intent !== "dev_task") {
        deps.logger.warn("[crystalliser] unknown classifier intent rejected", { intent: rawIntent });
        audit("crystallise.unsafe_model_output", { role: "classifier", reason: "unknown_intent", intent: rawIntent });
        return {
            kind: "reject",
            reason: "The request classifier returned an unrecognized intent, so the request was refused safely.",
            intent: "unsafe",
            spend,
        };
    }
    let brief;
    try {
        brief = await deps.callCrystalliser(userText, effectiveCls, concepts);
    }
    catch (error) {
        deps.logger.warn("[crystalliser] malformed crystalliser output rejected", { error: String(error) });
        audit("crystallise.unsafe_model_output", { role: "crystalliser", reason: "call_or_parse_failure" });
        return {
            kind: "reject",
            reason: "The request could not be converted into a safe, bounded repository change.",
            intent: "unsafe",
            spend,
        };
    }
    addSpend(spend, brief);
    // beta.21: guarantee concepts land on the brief even if the SDK-side
    // crystalliser silently drops the field (e.g. pre-beta.21 model version).
    // The caller's concept list is authoritative when the SDK produces none.
    if (concepts && concepts.length > 0 && (!brief.relevantConcepts || brief.relevantConcepts.length === 0)) {
        brief.relevantConcepts = concepts;
    }
    // Repository identity is deterministic. The explicit repository supplied to
    // the control plane remains authoritative; for legacy bare-name collisions,
    // select the lexicographically first allowed candidate rather than exposing
    // a harness pause. This recommendation is stable across retries and hosts.
    const repoResolution = resolveRepoAlias(brief.repoHint, grounding.allowedRepos);
    if (repoResolution.kind === "ambiguous") {
        const selected = [...repoResolution.candidates].sort((a, b) => a.localeCompare(b))[0];
        brief.repoHint = selected;
        deps.logger.info("[crystalliser] ambiguous repo alias resolved conservatively", {
            hint: repoResolution.hint,
            selected,
            candidates: repoResolution.candidates.length,
        });
        audit("crystallise.ambiguity_resolved", {
            role: "harness",
            strategy: "lexicographic_allowed_repository",
            hint: repoResolution.hint,
            selected,
        });
    }
    else if (repoResolution.kind === "resolved" && repoResolution.via === "alias") {
        deps.logger.info("[crystalliser] repo alias resolved", { hint: brief.repoHint, repo: repoResolution.repo });
        audit("crystallise.repo_alias_resolved", { hint: brief.repoHint, repo: repoResolution.repo });
        brief.repoHint = repoResolution.repo;
    }
    // Tolerate one release of stale model output from the retired bimodal schema.
    // Select the first model-ranked buildable reading, explicitly bound it to a
    // repository change with tests, and discard the pause-only fields before the
    // brief is persisted or shown for confirmation.
    if (!resolveRetiredAmbiguityFields(brief, audit)) {
        return {
            kind: "reject",
            reason: "The request could not be converted into a safe, bounded repository change.",
            intent: "unsafe",
            spend,
        };
    }
    try {
        validateBrief(brief);
    }
    catch (error) {
        deps.logger.warn("[crystalliser] invalid brief rejected", { error: String(error) });
        audit("crystallise.unsafe_model_output", { role: "crystalliser", reason: "invalid_brief" });
        return {
            kind: "reject",
            reason: "The request could not be converted into a safe, bounded repository change.",
            intent: "unsafe",
            spend,
        };
    }
    return { kind: "brief", brief, classification: effectiveCls, spend };
}
function resolveRetiredAmbiguityFields(brief, audit) {
    const legacy = brief;
    const interpretations = Array.isArray(legacy.interpretations) ? legacy.interpretations : [];
    const candidates = [
        ...interpretations.map((item) => typeof item?.reading === "string" ? item.reading.trim() : ""),
        ...(Array.isArray(legacy.clarificationNeeded?.options)
            ? legacy.clarificationNeeded.options.filter((value) => typeof value === "string").map((value) => value.trim())
            : []),
    ].filter(Boolean);
    const liveSideEffect = /\b(?:live|production|prod|deploy|publish|release|send|email|message|delete|remove|migrate|migration|backfill|rotate|revoke|merge|push|api\s+call|external\s+(?:system|service))\b/i;
    const boundedRepositoryWork = /\b(?:build|implement|add|change|fix|refactor|document|runbook|test|repository|code|feature)\b/i;
    const selected = candidates.find((candidate) => boundedRepositoryWork.test(candidate) && !liveSideEffect.test(candidate));
    if (candidates.length > 0 && !selected) {
        audit("crystallise.unsafe_model_output", { role: "crystalliser", reason: "only_live_side_effect_interpretations" });
        delete legacy.interpretations;
        delete legacy.clarificationNeeded;
        return false;
    }
    if (selected) {
        const note = `Conservative interpretation selected: ${selected}.`;
        if (!brief.motivation.includes(note))
            brief.motivation = `${brief.motivation.trim()} ${note}`;
        if (!brief.acceptanceCriteria.some((criterion) => /repository change.*test/i.test(criterion))) {
            brief.acceptanceCriteria.push("Implement the selected interpretation as a bounded repository change with deterministic tests; do not perform live external side effects.");
        }
        audit("crystallise.ambiguity_resolved", { role: "crystalliser", strategy: "first_ranked_bounded_reading" });
    }
    delete legacy.interpretations;
    delete legacy.clarificationNeeded;
    return true;
}
function validateBrief(brief) {
    if (!brief.title || brief.title.length < 3)
        throw new Error("brief.title too short");
    if (!brief.motivation || brief.motivation.length < 10) {
        throw new Error("brief.motivation too short");
    }
    if (!Array.isArray(brief.acceptanceCriteria) || brief.acceptanceCriteria.length === 0) {
        throw new Error("brief.acceptanceCriteria must be non-empty");
    }
    if (!["low", "medium", "high"].includes(brief.riskLevel)) {
        throw new Error(`brief.riskLevel invalid: ${brief.riskLevel}`);
    }
}
//# sourceMappingURL=prompt-refiner.js.map