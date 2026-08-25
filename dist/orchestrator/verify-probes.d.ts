import type { HarnessConfig } from "../config.js";
import type { GitAdapter } from "../adapters/git-worktree.js";
import type { PatRouter } from "../auth/pat-router.js";
import type { LeadPlan } from "./lead.js";
import type { VerifyProbes } from "./verify.js";
/**
 * beta.123: the verification probes, lifted out of createRuntime so a test can
 * hold the REAL ones.
 *
 * They lived inline in index.ts, closed over `git`/`pat`/`config`, and were
 * therefore unreachable from any test -- every suite that drives the loop had
 * to hand it a stub whose answers were decided by the test. So the probes were
 * covered by exactly nothing, and `file_committed` reading a `git mv` as "you
 * did not do the work" survived to kill the b122 smoke on its last sub-task.
 *
 * Nothing here changed in the lift. The factory takes what the closure used to
 * capture and returns the same builder the runtime passes to the loop.
 */
export interface VerifyProbeContext {
    git: GitAdapter;
    pat: PatRouter;
    config: HarnessConfig;
    /**
     * Stays a callback rather than moving with the probes: it closes over the
     * credential adapter and the runtime logger, and a test that wants real git
     * behaviour against a local bare repo needs no token at all.
     */
    resolveGitToken: (resolution: ReturnType<PatRouter["resolve"]>) => Promise<string>;
}
export interface BuildVerifyProbesArgs {
    plan: LeadPlan;
    requester: string;
    worktreePath: string;
    baseSha: string;
}
export declare function createVerifyProbes(ctx: VerifyProbeContext): (args: BuildVerifyProbesArgs) => VerifyProbes;
//# sourceMappingURL=verify-probes.d.ts.map