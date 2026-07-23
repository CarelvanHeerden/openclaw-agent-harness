/**
 * Fable-5 adversarial reviewer.
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
}
export interface ReviewFinding {
    dimension: "spec" | "fit" | "quality" | "security" | "runtime";
    severity: "info" | "low" | "medium" | "high" | "critical";
    title: string;
    detail: string;
    file?: string;
    line?: number;
}
export interface ReviewReport {
    verdict: "pass" | "revise" | "block";
    findings: ReviewFinding[];
    summary: string;
    sdkSessionId?: string;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
}
/**
 * Adversary prompt-preamble helper. Injected verbatim into the adversary's
 * system prompt so runtime dimension is never silently skipped.
 */
export declare function runtimeBanner(input: AdversaryInput): string;
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
}
export declare function runAdversary(input: AdversaryInput, deps: AdversaryDeps): Promise<ReviewReport>;
//# sourceMappingURL=fable5-adversary.d.ts.map