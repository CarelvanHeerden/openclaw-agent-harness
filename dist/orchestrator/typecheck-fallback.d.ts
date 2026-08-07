/**
 * beta.115: a typecheck gate that could not run must not read as a pass.
 *
 * The b114 DR/BCP run (session 532c706b) skipped the b111 typecheck gate in all
 * three cycles with `env_unavailable: check-script binary missing (exit 127 /
 * command not found)`, then shipped PR #964, whose CI failed on exactly one
 * error:
 *
 *   src/app/api/grc/continuity-exercises/[id]/route.ts(118,12): error TS2551:
 *   Property 'updatedById' does not exist on type 'ContinuityExerciseUpdateInput'
 *
 * That is the same shape as the `ownerUserId` error which survived three
 * revises on PR #932 and motivated building the gate in the first place. The
 * gate was on, the repo had a `typecheck` script, and the gate still let a
 * non-compiling branch through -- silently, because a skip returned no findings
 * and no findings reads as "clean".
 *
 * Two things are wrong and this module addresses the first:
 *
 * 1. The gate only ever invokes `npm run <script>`. ProjectThanos's own CI runs
 *    `npx tsc --noEmit` and passes on the same tree the harness could not
 *    typecheck, so the compiler was reachable and only the npm indirection was
 *    broken. When the script route is unrunnable we resolve the compiler
 *    ourselves rather than giving up.
 * 2. If no route can run, the caller must say so out loud (see loop.ts).
 *
 * `diagnoseCheckEnv` exists because the b114 worktree was reclaimed before it
 * could be inspected, leaving the 127 unexplained. Whatever the next occurrence
 * is, the audit record should be enough to name the cause without needing the
 * worktree to still be on disk.
 */
import { spawnSync } from "node:child_process";
/** Evidence about why a check script could not be executed. Audit-shaped. */
export interface CheckEnvDiagnosis {
    nodeModules: "present" | "missing";
    /** Entry count of node_modules; a tiny number means a partial/aborted install. */
    nodeModulesEntries?: number;
    binDir: "present" | "missing";
    tsc: "executable" | "present_not_executable" | "missing";
    npm: "on_path" | "not_on_path";
    /** Trimmed for the audit; the full value is rarely the interesting part. */
    path?: string;
}
export declare function diagnoseCheckEnv(worktree: string, deps?: {
    spawn?: typeof spawnSync;
    env?: NodeJS.ProcessEnv;
}): CheckEnvDiagnosis;
export interface DirectRun {
    /** How the compiler was reached, for the audit trail. */
    via: "node_modules_bin" | "npx";
    status: number | null;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
}
/**
 * Run the TypeScript compiler without going through the repo's npm script.
 *
 * Ordered by directness: the repo's own pinned binary first, then `npx
 * --no-install` (which will still find that same binary, but via a different
 * resolution path that survives some of the ways the first one breaks). We
 * never install anything -- a review gate that mutates the worktree to make
 * itself runnable would be a worse bug than the one it is fixing.
 *
 * Returns null when no route exists, which the caller must treat as "the gate
 * did not run", never as "the branch compiles".
 */
export declare function runTypecheckDirect(worktree: string, timeoutMs: number, deps?: {
    spawn?: typeof spawnSync;
    env?: NodeJS.ProcessEnv;
}): DirectRun | null;
//# sourceMappingURL=typecheck-fallback.d.ts.map