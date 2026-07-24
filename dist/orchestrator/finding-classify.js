/**
 * beta.69: finding classifiability gate.
 *
 * ROOT CAUSE this fixes (forensic session 1f2e6642 — the `?all=true` grc-changes
 * export that burned 1h29m / $4.54 on a correct 30-LOC diff): the adversary loop
 * had NO concept of "can a diff-cycle worker legitimately fix this finding?". A
 * `revise` verdict was sustained by findings that were structurally unfixable in
 * a code cycle:
 *   - "No runtime data" — needs a preview deploy the harness never made (fired 3×).
 *   - "No tests / tests not wired" — repo has no test script BY DESIGN and the
 *     workerContext forbade adding one; flagged anyway, then the workaround got
 *     re-flagged (the D3 spiral).
 *   - recycled prior-cycle findings — cycle 2 had 0 convention findings and still
 *     revised.
 *
 * This module classifies every {@link ReviewFinding} as one of:
 *   - `diff_addressable`   — a worker can fix it by editing the diff. BLOCKING iff severity >= medium.
 *   - `process`            — about repo process/tooling the diff must not change (e.g. "no test script"). NON-blocking.
 *   - `env`                — build/tool environment ("exit 127", "eslint: not found"). NON-blocking.
 *   - `architectural`      — platform/deploy/size limits not addressable in a diff. NON-blocking.
 *   - `unproven_runtime`   — runtime dimension with no live deploy evidence. NON-blocking.
 *
 * The verdict gate (in fable5-adversary.ts `runAdversary`) then requires at least
 * one NEW, blocking (diff_addressable + severity>=medium) finding to sustain a
 * `revise`. Everything else is surfaced on the PR body, not used to block
 * convergence. `block` verdicts are never downgraded here.
 */
const UNPROVEN_RUNTIME_RE = /\b(no runtime data|no runtime verification|runtime is unproven|preview deploy|not been (deployed|verified at runtime)|without a (preview |)deploy|no deploy(ed| evidence)?)\b/i;
const TEST_WIRING_RE = /\b(no (automated |unit |integration )?tests?|test(s)? (are|were)? ?(not|n't)|zero test|without tests?|test script|tests? (are )?not (executed|run|wired|declared)|not (executed|run|wired) by (any )?(declared )?(check )?script)\b/i;
const ENV_RE = /\b(exit(ed)? (code )?127|command not found|: not found|eslint: not found|tsx: not found|npm ci|node_modules|cannot find module|MODULE_NOT_FOUND|sh: \w+:)\b/i;
const ARCHITECTURAL_RE = /\b(platform (response |payload |body )?(size )?limit|response (body )?too large|max(imum)? (payload|response|body) size|serverless (function )?limit|edge runtime limit|4\.5\s?mb|deploy(ment)? (architecture|target)|infrastructure|out of scope of a (single )?diff)\b/i;
/**
 * Classify a single finding. Pure. Order matters: the most "structurally
 * unfixable in a diff" buckets win over the generic diff_addressable default.
 */
export function classifyFinding(f, ctx = {}) {
    const text = `${f.title ?? ""} ${f.detail ?? ""}`;
    // Runtime dimension with no live deploy evidence: the harness decides whether
    // to push; the worker cannot conjure runtime data in a code cycle.
    if (f.dimension === "runtime" && (ctx.runtimeUnavailable || UNPROVEN_RUNTIME_RE.test(text))) {
        return "unproven_runtime";
    }
    // Env/tooling breakage (exit 127, missing binary). Not a diff defect — the
    // worktree bootstrap owns this (F4). Distinct from a real convention failure.
    if (ENV_RE.test(text)) {
        return "env";
    }
    // Test-wiring findings when the repo has no test script by design: adding a
    // test script / wiring tests into package.json is a PROCESS change the
    // workerContext explicitly forbids. Flagging its absence can never be fixed
    // by the worker, so it must not sustain a revise.
    if (TEST_WIRING_RE.test(text) && ctx.repoHasTestScript !== true) {
        return "process";
    }
    // Platform/deploy/size limits: not addressable by editing this diff.
    if (ARCHITECTURAL_RE.test(text)) {
        return "architectural";
    }
    return "diff_addressable";
}
/**
 * A finding is BLOCKING (can sustain a `revise`) only when it is
 * `diff_addressable` AND at least `medium` severity. Everything else is
 * surfaced but non-blocking.
 */
export function isBlockingFinding(f, cls) {
    if (cls !== "diff_addressable")
        return false;
    return f.severity === "medium" || f.severity === "high" || f.severity === "critical";
}
/**
 * Fuzzy "same finding as a prior cycle" test, used to strip recycled findings
 * from the "NEW this cycle" set (F3). Token-overlap on the title, mirroring the
 * conservative style of finding-hygiene.ts. Two findings match when they share
 * the same dimension AND >= `minShared` distinctive title tokens.
 */
export function isRecycledFinding(f, priorFindings, minShared = 2) {
    if (!priorFindings || priorFindings.length === 0)
        return false;
    const toks = (s) => new Set((s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 4));
    const cur = toks(f.title);
    if (cur.size === 0)
        return false;
    for (const p of priorFindings) {
        if (p.dimension !== f.dimension)
            continue;
        const prev = toks(p.title);
        let shared = 0;
        for (const t of cur)
            if (prev.has(t))
                shared++;
        if (shared >= Math.min(minShared, cur.size))
            return true;
    }
    return false;
}
/**
 * The verdict gate. Given the model's verdict + findings and the classification
 * context, decide the final verdict.
 *
 *   - `block` is never downgraded (genuine redesign still hard-stops).
 *   - `revise` requires >= 1 NEW (non-recycled) blocking finding; otherwise it
 *     is downgraded to `pass` (the run has converged — remaining findings are
 *     non-blocking process/env/architectural/runtime notes that ship on the PR
 *     body, and the `reachedCleanPass=false`/do_not_merge gate still forces a
 *     human to approve the merge).
 *   - `pass` is left as-is (the old force-upgrade to revise is DELETED).
 */
export function gateVerdict(params) {
    const { verdict, findings, ctx, priorFindings } = params;
    const newBlocking = findings.filter((f) => {
        const cls = classifyFinding(f, ctx);
        if (!isBlockingFinding(f, cls))
            return false;
        if (isRecycledFinding(f, priorFindings))
            return false;
        return true;
    });
    if (verdict === "block") {
        return { verdict, downgraded: false, newBlocking };
    }
    if (verdict === "revise" && newBlocking.length === 0) {
        return { verdict: "pass", downgraded: true, newBlocking };
    }
    return { verdict, downgraded: false, newBlocking };
}
//# sourceMappingURL=finding-classify.js.map