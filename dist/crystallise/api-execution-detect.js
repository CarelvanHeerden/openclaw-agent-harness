/**
 * beta.79 (F1): API-execution brief detection.
 *
 * ORIGIN — the beta.77 DR/BCP smoke (session 95b341cb, PR #881). Staging's
 * forensic proved the convergence gate was healthy; the REAL defect was that
 * the lead SILENTLY PIVOTED an API-execution task into markdown documentation.
 * The DR/BCP prompt's 9 acceptance criteria ALL described external-API
 * side-effects against a LIVE GRC system (`POST /api/grc/evidence`,
 * `DELETE /api/grc/policies/...`, `{ ok: true }` return contracts, HTTP status
 * codes against project-thanos.vercel.app). Not one AC said "document X". But
 * every sub-task across 3 cycles was a `mutate` on a markdown file, so the
 * adversary kept finding "you assert this happened when nothing shows it
 * happened" — because nothing DID happen. The run only produced docs ABOUT the
 * procedure.
 *
 * Root cause in code: the classifier only picks `dev_task|clarify|not_dev|
 * unsafe` (weak-clarify bias), and lead task modes are `observe|mutate|mixed`
 * — all repo-file operations. There is NO "execute-against-external-API" mode
 * and no "this isn't repo work" reject path. Handed an API-execution brief,
 * the lead's only trained move is to make files.
 *
 * THE FIX (this module): a PURE detector run against the CRYSTALLISED brief
 * (the ACs are structured text at that point). When the ACs are DOMINATED by
 * external-API-execution signals, the crystalliser returns a `clarify` (reusing
 * the existing beta.55 human-in-loop entry) instead of a brief — asking the
 * requester whether this is repo CODE work or an operational task to run
 * against the live system (out of scope for the code-gen harness).
 *
 * DESIGN BIAS: false-NEGATIVE over false-positive. A normal repo task that
 * merely MENTIONS an endpoint in one AC ("add a test asserting the handler
 * returns 201") must NOT trip this — that's why we require the endpoint to be
 * an OUTCOME/side-effect to PERFORM (≥ minCriteria matched) AND to DOMINATE
 * (matched/total >= minRatio). Blocking a real code task is the worse failure.
 */
/**
 * Signals that an acceptance criterion describes PERFORMING an external-API
 * side-effect (as opposed to writing repo code that HANDLES a request). Each
 * regex targets an OUTCOME the harness cannot produce in a worktree: an HTTP
 * call to a live endpoint, a live-system state assertion, or a wire-contract
 * on a response.
 */
const EXECUTION_SIGNALS = [
    // HTTP verb against a path-shaped endpoint: "POST /api/...", "DELETE /api/grc/policies/...".
    { re: /\b(POST|GET|PUT|PATCH|DELETE)\s+\/[a-z0-9._~\/-]+/i, label: "http-verb-endpoint" },
    // A live absolute URL with an /api/ path (the run must CALL it).
    { re: /https?:\/\/[^\s)]+\/api\/[a-z0-9._~\/-]+/i, label: "live-api-url" },
    // A vercel/deploy host — strong "external live system" tell.
    { re: /\bhttps?:\/\/[a-z0-9.-]*\.vercel\.app\b/i, label: "vercel-host" },
    // Wire-contract return-value assertions on a response body.
    { re: /\breturns?\s*(a\s*)?\{\s*ok\s*:\s*true\s*\}/i, label: "return-ok-true" },
    { re: /\{\s*ok\s*:\s*true\s*\}/i, label: "ok-true-literal" },
    // HTTP status-code contracts as an OUTCOME ("returns 201", "responds 200", "HTTP 204").
    { re: /\b(returns?|respond(s|ing)?|expects?|status(\s*code)?\s*(is|=|:)?)\s*(HTTP\s*)?(200|201|202|204|400|401|403|404|409|422|500)\b/i, label: "http-status-contract" },
    // Auth header / content-type on a request the run must SEND.
    { re: /\bAuthorization:\s*Bearer\b/i, label: "auth-bearer-header" },
    { re: /\bContent-Type:\s*(application\/json|multipart\/form-data)\b/i, label: "content-type-header" },
    // Explicit "against a live/external system/API" phrasing.
    { re: /\b(against|to|on)\s+(the\s+)?(live|external|production|remote)\s+(system|api|service|endpoint|server)\b/i, label: "against-live-system" },
    // Multipart file upload to an endpoint (the DR/BCP step-1 pattern).
    { re: /\bmultipart\/form-data\b|\bfile=@|\bupload the file first\b/i, label: "file-upload-call" },
];
/**
 * Guard: a criterion that is clearly about WRITING repo code/tests for handling
 * a request must NOT count as an execution outcome even if it names an endpoint
 * or status. These phrasings describe the CODE, not a call to perform.
 */
const CODE_WORK_GUARD = /\b(add|write|create|implement|refactor|update|fix|test(s)?\s+(that|asserting|for)|assert(ing)?\s+the\s+(handler|route|endpoint|response)|the\s+handler\s+(returns|responds)|unit\s*test|integration\s*test|route\s*handler|in\s+the\s+(codebase|repo|file))\b/i;
function criterionSignals(text) {
    const labels = [];
    for (const { re, label } of EXECUTION_SIGNALS) {
        if (re.test(text))
            labels.push(label);
    }
    return labels;
}
/**
 * Detect whether a crystallised brief is fundamentally an API-EXECUTION task
 * (perform live side-effects) rather than a repo code-generation task.
 */
export function detectApiExecutionBrief(brief, opts = {}) {
    const enabled = opts.enabled !== false;
    const minCriteria = typeof opts.minCriteria === "number" ? opts.minCriteria : 2;
    const minRatio = typeof opts.minRatio === "number" ? opts.minRatio : 0.4;
    if (!enabled) {
        return { isApiExecution: false, matchedCriteria: [], ratio: 0, reason: "detection disabled" };
    }
    const acs = Array.isArray(brief.acceptanceCriteria) ? brief.acceptanceCriteria : [];
    const total = acs.length;
    if (total === 0) {
        return { isApiExecution: false, matchedCriteria: [], ratio: 0, reason: "no acceptance criteria" };
    }
    const matched = [];
    for (const ac of acs) {
        const text = String(ac ?? "");
        const sigs = criterionSignals(text);
        if (sigs.length === 0)
            continue;
        // A criterion that is plainly about writing repo code/tests is NOT an
        // execution outcome — unless it ALSO carries a strong live-URL/vercel/
        // ok-true signal that a mere "handler returns 201" test would not.
        const strong = sigs.some((s) => s === "live-api-url" || s === "vercel-host" || s === "return-ok-true" || s === "ok-true-literal" || s === "against-live-system" || s === "file-upload-call");
        if (!strong && CODE_WORK_GUARD.test(text))
            continue;
        matched.push(text);
    }
    const ratio = matched.length / total;
    const fires = matched.length >= minCriteria && ratio >= minRatio;
    return {
        isApiExecution: fires,
        matchedCriteria: matched,
        ratio,
        reason: fires
            ? `${matched.length}/${total} acceptance criteria describe external-API side-effects (ratio ${ratio.toFixed(2)} >= ${minRatio}, min ${minCriteria})`
            : `${matched.length}/${total} matched (ratio ${ratio.toFixed(2)}); below threshold (min ${minCriteria} criteria AND ratio >= ${minRatio})`,
    };
}
/**
 * The clarifying question surfaced to the requester when a brief is detected as
 * API-execution. Names the concrete matched signal and asks the ONE decision.
 */
export function buildApiExecutionClarification(result) {
    const example = result.matchedCriteria[0]?.slice(0, 160) ?? "an external API call";
    return [
        "These acceptance criteria describe API side-effects against a LIVE external system",
        `(e.g. "${example}").`,
        "This harness generates and reviews REPO CODE and opens a PR — it does not execute calls against a live API from the worktree.",
        "Do you want me to (a) write repo code/tests that implement this behaviour, or",
        "(b) is this an operational task to run against the live system (out of scope for the code harness)?",
    ].join(" ");
}
//# sourceMappingURL=api-execution-detect.js.map