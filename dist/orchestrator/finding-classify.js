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
const ENV_RE = /\b(exit(ed)? (code )?12[67]|command not found|: not found|eslint: not found|tsx: not found|npm ci|node_modules|cannot find module|MODULE_NOT_FOUND|sh: \w+:|permission denied|cannot execute|exec format error|noexec)\b/i;
const ARCHITECTURAL_RE = /\b(platform (response |payload |body )?(size )?limit|response (body )?too large|max(imum)? (payload|response|body) size|serverless (function )?limit|edge runtime limit|4\.5\s?mb|deploy(ment)? (architecture|target)|infrastructure|out of scope of a (single )?diff)\b/i;
// beta.70 (F2): generated-artifact / convention-check findings. The harness
// runs the repo's declared check scripts (okf regen, okf:check, lint) in the
// POST-WORKER convention-check phase (repo-conventions.ts runCheckScripts) —
// that phase is the authoritative enforcer. An adversary finding that merely
// restates "you didn't regenerate the OKF bundle / the bundle is stale / run
// keep-okf-current" double-counts a check the pipeline already owns, and in
// PR #870 it was the SOLE medium that sustained a `revise` (a 19-min cycle-2
// worker re-ran `npm run okf` across 1436 files to produce a ZERO diff). The
// generated bundle is not the DIFF the worker should be hand-editing; it is a
// derived artifact the convention phase regenerates deterministically. So a
// bundle-drift/regeneration finding is `process` (NON-blocking) — it ships on
// the PR body and is enforced by the convention check, but it does not force
// another expensive code cycle. A genuine code defect (wrong logic, wrong
// placement) still classifies `diff_addressable`.
//
// rc.3: the bare `regenerate` alternative is REMOVED. It matched the verb
// anywhere in the finding text, so "the session token is never rotated -- an
// attacker can replay it; regenerate it on each login" classified as `process`
// and could not sustain a `revise`. The demotion is meant for findings ABOUT a
// generated artifact, so the verb now has to be attached to one.
const GENERATED_ARTIFACT_RE = /\b(okf[- ]?bundle|okf[:-]?check|keep[- ]?okf[- ]?current|run (npm run )?okf|re-?generat(e|es|ed|ing|ion)( of)?( the| a| an)? (okf|bundle|generated|artifact|lock(file)?|snapshot|schema|client|types?)|bundle (is |was |has been )?(stale|out ?of ?date|not (regenerated|current|up[- ]?to[- ]?date))|stale (generated|okf)|generated (bundle|artifact|file)s? (are |is |were |was )?(stale|out of date|not regenerated))\b/i;
/**
 * rc.3: the buckets below `diff_addressable` are all keyword matches on prose,
 * and every one of them demotes. That is a one-way ratchet toward shipping: a
 * real defect whose wording happens to trip a regex becomes non-blocking, and
 * a `revise` built on it is downgraded to an auto-mergeable `pass`.
 *
 * These findings are never demoted on the strength of a keyword:
 *   - `security` dimension -- the cost of wrongly demoting one is not symmetric
 *     with the cost of one extra review cycle.
 *   - `high` and `critical` severity -- the adversary said this is serious;
 *     a regex written for an OKF bundle does not get to overrule that.
 *   - unreadable severity -- see `normaliseSeverity`. We cannot show it is
 *     minor, so we do not treat it as minor.
 *
 * This deliberately does NOT cover the `medium`-severity demotions the beta.69
 * and beta.70 forensics were about (PR #870's sole medium, the 1f2e6642
 * runtime spiral). Those stay demotable, so this closes the hole without
 * reopening the loops that motivated the buckets.
 */
function isNonDemotable(f) {
    if (f.dimension === "security")
        return true;
    const s = normaliseSeverity(f.severity);
    return s === "high" || s === "critical" || s === "unknown";
}
/**
 * Classify a single finding. Pure. Order matters: the most "structurally
 * unfixable in a diff" buckets win over the generic diff_addressable default.
 */
export function classifyFinding(f, ctx = {}) {
    const text = `${f.title ?? ""} ${f.detail ?? ""}`;
    // beta.127: a CI failure is not an opinion to be triaged. It is a job that
    // ran the repo's own suite against this exact commit and returned non-zero,
    // which is the strongest evidence the harness ever holds -- stronger than
    // anything the adversary says, because it was executed rather than argued.
    //
    // It must short-circuit, because every bucket below matches on KEYWORDS in
    // the finding text, and a CI finding's text is a raw job log. A jest failure
    // whose message happens to contain "Cannot find module" would classify as
    // `env`; one mentioning "regenerate" would classify as `process`. Both are
    // non-blocking, so the red build would be filed as advisory and the run
    // would ship over it -- silently, and only on the runs unlucky enough to
    // fail with the wrong words in them.
    if (f.source === "ci")
        return "diff_addressable";
    // rc.3: the mirror of the rule above. The harness reporting that its own
    // typecheck gate could not run is a fact it established, so it is filed as
    // `env` without consulting the prose -- and without the `isNonDemotable` rule
    // below promoting it, which it otherwise would, since the finding is
    // deliberately `high` so that it stops a merge.
    if (f.source === "harness_env")
        return "env";
    // Runtime dimension with no live deploy evidence: the harness decides whether
    // to push; the worker cannot conjure runtime data in a code cycle.
    //
    // rc.3: `ctx.runtimeUnavailable` is a fact the harness established, not a
    // guess about prose, so it still demotes anything. The `UNPROVEN_RUNTIME_RE`
    // half is a keyword match and obeys the non-demotable rule below.
    if (f.dimension === "runtime" && ctx.runtimeUnavailable) {
        return "unproven_runtime";
    }
    // rc.3: every rule from here down demotes on keywords alone, so each one is
    // gated on `isNonDemotable` -- see there for why security, high, critical and
    // unreadable severities are not demoted by prose.
    //
    // The generated-artifact rule below is the exception, and takes no guard.
    const demotable = !isNonDemotable(f);
    if (demotable && f.dimension === "runtime" && UNPROVEN_RUNTIME_RE.test(text)) {
        return "unproven_runtime";
    }
    // Env/tooling breakage (exit 127, missing binary). Not a diff defect — the
    // worktree bootstrap owns this (F4). Distinct from a real convention failure.
    // Checked BEFORE the generated-artifact bucket so "okf:check exited 127"
    // classifies as `env` (bootstrap's job), not `process`.
    if (demotable && ENV_RE.test(text)) {
        return "env";
    }
    // beta.70 (F2): generated-artifact / OKF-bundle regeneration findings. The
    // convention-check phase (post-worker) runs the repo's declared regen + check
    // scripts and is the authoritative enforcer. Flagging "bundle not
    // regenerated" is redundant with that phase and must not sustain a revise
    // (PR #870 root cause). Checked AFTER runtime/env so a real env-127 still
    // wins; both `process` and `env` are non-blocking so gating is unaffected.
    //
    // rc.3: this is the one demotion that applies at ANY severity, because it is
    // not really a judgement about the finding -- the convention phase regenerates
    // the bundle deterministically, so the complaint is answered by machinery
    // rather than argued about. A high-severity "the bundle is stale" is still
    // just a stale bundle (beta.127 asserts exactly this). It earns the exemption
    // by being narrow: the bare verb "regenerate" was removed from the pattern in
    // rc.3 precisely so it cannot reach findings that are not about an artifact.
    if (GENERATED_ARTIFACT_RE.test(text)) {
        return "process";
    }
    if (!demotable)
        return "diff_addressable";
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
const SEVERITY_SYNONYMS = {
    info: "info",
    informational: "info",
    note: "info",
    nit: "info",
    trivial: "info",
    low: "low",
    minor: "low",
    medium: "medium",
    moderate: "medium",
    med: "medium",
    warn: "medium",
    warning: "medium",
    high: "high",
    major: "high",
    severe: "high",
    critical: "critical",
    crit: "critical",
    blocker: "critical",
    fatal: "critical",
};
/** Anything we cannot read becomes `"unknown"`, which is treated as blocking. */
export function normaliseSeverity(raw) {
    if (typeof raw !== "string")
        return "unknown";
    const key = raw.trim().toLowerCase();
    if (key === "")
        return "unknown";
    return SEVERITY_SYNONYMS[key] ?? "unknown";
}
/**
 * `medium` or above, the threshold that lets a finding sustain a `revise`.
 * `unknown` qualifies: fail toward review.
 */
export function isAtLeastMedium(raw) {
    const s = normaliseSeverity(raw);
    return s === "medium" || s === "high" || s === "critical" || s === "unknown";
}
/**
 * A finding is BLOCKING (can sustain a `revise`) only when it is
 * `diff_addressable` AND at least `medium` severity. Everything else is
 * surfaced but non-blocking.
 */
export function isBlockingFinding(f, cls) {
    if (cls !== "diff_addressable")
        return false;
    return isAtLeastMedium(f.severity);
}
/**
 * rc.5: whether a finding should stop a MERGE. A different question from
 * `isBlockingFinding`, which asks whether another worker cycle is worth running.
 *
 * Collapsing the two is what produced PR #1084. `deriveMergeRecommendation` was
 * handed the correct classified count and then ignored it, gating on raw
 * severity instead, so a `medium` `unproven_runtime` finding -- "preview deploy
 * logs show 14 errors", with no verified deploy behind it -- forced
 * `do_not_merge` on a review the verdict gate had correctly passed. Nothing
 * could clear it: a revise cycle cannot conjure runtime evidence, and the
 * finding recurs every cycle, so the PR was stuck until a human merged around
 * the harness. A gate nobody can satisfy is not a safety control.
 *
 * Two classes stop a merge:
 *   - `diff_addressable` at >= medium: a real defect a worker could have fixed
 *     and did not.
 *   - `env`: the harness saying it could not verify something (the beta.115
 *     typecheck gate reporting no `tsc`). Not a defect, but not a clean bill of
 *     health either.
 *
 * `unproven_runtime`, `process` and `architectural` do not. Nobody can close
 * them -- not a worker, not the operator -- so they belong on the PR body where
 * a human reads them, not on a gate that can only deadlock.
 */
export function blocksMerge(f, cls) {
    // The medium floor applies to both. An adversary aside about a missing linter
    // is an `env` finding too, and a `low` one should no more stop a merge than a
    // `low` defect does. The beta.115 gate finding is deliberately `high`, so the
    // case this exists for is unaffected.
    if (!isAtLeastMedium(f.severity))
        return false;
    return cls === "diff_addressable" || cls === "env";
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