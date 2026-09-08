/**
 * Adversarial reviewer.
 *
 * Reviews the diff produced by the workers, plus (optionally) live runtime
 * data from Vercel preview logs, and produces a `ReviewReport`.
 *
 * Dimensions reviewed (documented so the adversary prompt can quote them):
 *   1. Spec fidelity: does the diff satisfy every acceptance criterion?
 *   2. Codebase fit: does it match existing patterns/conventions?
 *   3. Quality: types, tests, lint, no `any`, no dead code, no TODO leaks.
 *   4. Security: no secrets, no obvious injection/XSS, no dangerous deps.
 *   5. Runtime: preview deploy status, log errors, unhandled promise rejections.
 *
 * Runtime sources are pluggable behind `harness.vercel.enabled`:
 *   - vercel: automatic bridge (preview build + event logs)
 *   - manual: uploaded via `harness_upload_logs` tool (any deploy target)
 *   - none:   nothing available; adversary must not sign off on runtime
 *
 * Runtime rule (unchanged): if the runtime data is missing or shows
 * `no_deploy_yet`/`build_failed`/`unavailable`, the adversary gets an
 * explicit banner and MUST refuse to sign off on the runtime dimension.
 */
/**
 * rc.3: what a REVISE session's adversary needs that an ordinary one does not.
 *
 * A revise brief flattens three different kinds of instruction into one string:
 * what the feature was originally asked to do, what the operator now wants
 * changed, and what this revision must not do. Handed that flattened text, the
 * adversary on StitchGuard PR #1168 read the revision-only exclusion "no new
 * schema or migration redesign" as a rule the *feature* had broken, and spent
 * cycle after cycle telling workers to delete the Prisma models and the
 * migration the whole PR was built on.
 *
 * Present only for a revise, and only once the baseline columns exist. An
 * ordinary run leaves it undefined and gets the single-brief prompt unchanged.
 */
export interface AdversaryRevisionContext {
    /** The ROOT feature brief. Still authoritative; the revision is additive. */
    originalFeatureContract: string;
    /** What THIS revision was asked to change, as the operator listed it. */
    directives: string[];
    /** The operator's free-text steer for this revision, verbatim. */
    guidance?: string;
    /** Exclusions that constrain NEW revision work only, never existing code. */
    outOfScopeRules: string[];
    /** Repo-relative files the revision itself committed (revisionStart..HEAD). */
    deltaFiles: string[];
    /** PR head before any revision work; the delta window's base. */
    revisionStartSha?: string;
    /** Fork point of the PR being revised; the correctness window's base. */
    originalPrBaseSha?: string;
}
export interface AdversaryInput {
    crystallisedPrompt: string;
    diffPath: string;
    repoPath: string;
    runtime?: {
        provider: "vercel" | "manual" | "local";
        status: "ok" | "no_deploy_yet" | "build_failed" | "unavailable";
        deploymentUrl?: string;
        logsExcerpt?: string;
        errorCount?: number;
        uploadedAt?: number;
        uploadedBy?: string;
        source?: string;
        localVerification?: Array<{
            seq: number;
            ok: boolean;
            summary: string;
        }>;
    };
    reviewChecklist: string[];
    model: string;
    timeoutSeconds: number;
    /** beta.63 (Fix 1): repo conventions ingested at brief build. Optional. */
    repoConventions?: import("./repo-conventions.js").RepoConvention[];
    /**
     * beta.69 (F3): findings the adversary raised in a PRIOR cycle. Fed into the
     * prompt ("do not repeat unless you can state why the fix is insufficient")
     * and into the verdict gate (recycled findings cannot sustain a `revise`).
     */
    priorFindings?: ReviewFinding[];
    /**
     * beta.69 (F1): true when the target repo has NO declared test script, so a
     * "no tests" finding is a process concern the worker cannot fix (it must not
     * add a test script). Derived from repoConventions / discovered scripts.
     */
    repoHasTestScript?: boolean;
    /**
     * rc.3: set for a revise session, so the prompt can separate the feature
     * contract from the revision directives instead of flattening both into
     * `crystallisedPrompt`. See `AdversaryRevisionContext`.
     */
    revision?: AdversaryRevisionContext;
}
export interface ReviewFinding {
    /**
     * beta.127: where this finding came from. Absent means the adversary, which
     * is everything before b127. `"ci"` marks a finding synthesised from a real
     * GitHub CI failure, which the classifier must not downgrade -- see
     * classifyFinding.
     */
    /**
     * rc.3: `"harness_env"` marks a finding the HARNESS authored about its own
     * tooling -- the beta.115 typecheck gate reporting that nothing could run.
     * Like `"ci"`, it is a fact the harness established rather than a judgement
     * the adversary argued, so the classifier trusts it directly instead of
     * inferring the bucket from the wording. Needed because the rc.3
     * `isNonDemotable` rule stops HIGH-severity findings being demoted on
     * keywords, and this one is deliberately high AND deliberately non-blocking:
     * it must stop a merge, and no code change can repair a missing binary.
     */
    source?: "ci" | "harness_env" | "deterministic_scope";
    dimension: "spec" | "fit" | "quality" | "security" | "runtime";
    /**
     * rc.3: `"unknown"` is a real value here, not a defect. The adversary's JSON
     * is not schema-checked, so a severity we cannot map lands as `"unknown"` and
     * is treated as blocking rather than quietly becoming `"low"`. See
     * `normaliseSeverity` in finding-classify.ts.
     */
    severity: "info" | "low" | "medium" | "high" | "critical" | "unknown";
    title: string;
    detail: string;
    /** beta.91: repo-relative path. REQUIRED for diff-addressable findings
     * (medium+ spec/quality/security); meta findings set null explicitly. */
    file?: string | null;
    line?: number;
    /**
     * beta.119: the OTHER repo-relative paths that must change for this finding
     * to be resolved. Set when the fix spans files -- a route that cannot persist
     * a field until the Prisma model gains a column, a dead UI control whose
     * removal belongs to the component that renders it. The router targets the
     * owners of these paths too, so every worker the fix needs is asked in the
     * same cycle.
     */
    relatedFiles?: string[] | null;
    /**
     * rc.3: stable identity across chunks and cycles. Assigned by
     * `dedupeFindings`; see finding-lifecycle.ts. Absent on a finding that has
     * not been through reconciliation yet.
     */
    fingerprint?: string;
    /**
     * rc.3: where this finding is in its life. Absent means `open` -- everything
     * before rc.3 behaves as it always did. `resolved`, `stale`, `accepted` and
     * `dispositioned` stop it driving repair cycles and blocking a merge.
     */
    lifecycleState?: import("./finding-lifecycle.js").FindingLifecycleState;
    /** rc.3: why a post-cycle-1 finding against unchanged code was admitted. */
    lateDiscoveryReason?: string;
}
export interface ReviewReport {
    verdict: "pass" | "revise" | "block";
    findings: ReviewFinding[];
    summary: string;
    sdkSessionId?: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    /**
     * rc.3: true when `verdict` is a `pass` the gate produced from the model's
     * `revise`, rather than one the adversary actually gave.
     *
     * The downgrade was previously visible only as a log line, while the `pass`
     * it produced went on to set `reachedCleanPass` and make the PR
     * auto-mergeable. A reader of the PR could not tell the two kinds of pass
     * apart. Carried on the report so the audit trail, the PR body and the merge
     * recommendation can all say which one it was.
     */
    verdictDowngraded?: boolean;
}
/**
 * Adversary prompt-preamble helper. Injected verbatim into the adversary's
 * system prompt so runtime dimension is never silently skipped.
 */
export declare function runtimeBanner(input: AdversaryInput): string;
/**
 * rc.3: the labelled brief sections for a revise review.
 *
 * Five sections in the order the spec names them, plus the precedence rules
 * that stop the exclusions being read backwards in time. Returns `null` for an
 * ordinary run, whose prompt is unchanged.
 */
export declare function buildRevisionBriefSections(input: AdversaryInput): string[] | null;
export declare function buildAdversarySystemPrompt(input: AdversaryInput): string;
export interface AdversaryDeps {
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
    callAdversaryModel: (input: {
        systemPrompt: string;
        diffText: string;
        model: string;
        timeoutSeconds: number;
    }) => Promise<{
        parsed: {
            verdict: ReviewReport["verdict"];
            findings: ReviewFinding[];
            summary: string;
        };
        sdkSessionId: string;
        costUsd: number;
        tokensIn: number;
        tokensOut: number;
    }>;
    readDiff: (diffPath: string) => Promise<string>;
    /**
     * beta.91 (Staging pass-2 nit): observability hook for the file-attribution
     * retry. Fired once when a retry runs, carrying before/after unfiled counts
     * and whether the call already carried priorFindings (the conflation edge
     * Staging traced). Wired by index.ts to emit a loop.file_attribution_retry
     * audit. Optional + best-effort (a throw here never fails the review).
     */
    onFileAttributionRetry?: (info: {
        before: number;
        after: number;
        applied: boolean;
        hadPriorFindings: boolean;
    }) => void;
}
/**
 * beta.70 (F3): the adversary's response was not the verdict JSON. In PR #870
 * the cycle-2 adversary emitted a bash pre-flight discovery step as its ENTIRE
 * final message ({command, description}) instead of {verdict, findings,
 * summary}, so the parser threw "JSON missing required keys" and the run
 * crash-recovered to `needs_human_review` -- producing NO real verdict after
 * 4 min of adversary tokens. This detects that class from the thrown error so
 * `runAdversary` can retry ONCE with a hardened "verdict JSON only" nudge
 * before giving up.
 */
export declare function isAdversaryFormatError(err: unknown): boolean;
/**
 * beta.70 (F3): appended to the system prompt on the format-retry. Hammers the
 * ONE thing that failed: return the verdict object, do not call a tool, do not
 * explore -- you already have the full diff.
 */
export declare const ADVERSARY_FORMAT_RETRY_NUDGE: string;
export declare function runAdversary(input: AdversaryInput, deps: AdversaryDeps): Promise<ReviewReport>;
//# sourceMappingURL=adversary.d.ts.map