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
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
export function diagnoseCheckEnv(worktree, deps = {}) {
    const spawn = deps.spawn ?? spawnSync;
    const env = deps.env ?? process.env;
    const nm = join(worktree, "node_modules");
    const bin = join(nm, ".bin");
    const tscPath = join(bin, "tsc");
    let nodeModulesEntries;
    const nodeModules = existsSync(nm) ? "present" : "missing";
    if (nodeModules === "present") {
        try {
            // A directory that exists but holds almost nothing is the signature of an
            // aborted `npm ci` -- distinguishable from a healthy tree only by size.
            nodeModulesEntries = readdirSync(nm).length;
        }
        catch {
            /* unreadable is itself reported by the `present` + absent count */
        }
    }
    let tsc = "missing";
    if (existsSync(tscPath)) {
        try {
            // accessSync follows the link, so a dangling symlink -- which existsSync
            // happily reports as present -- throws ENOENT here and lands in the
            // not-executable bucket. No separate stat is needed for that.
            accessSync(tscPath, constants.X_OK);
            tsc = "executable";
        }
        catch {
            tsc = "present_not_executable";
        }
    }
    let npm = "not_on_path";
    try {
        const probe = spawn("npm", ["--version"], { cwd: worktree, encoding: "utf8", timeout: 30_000, env });
        if (probe.status === 0)
            npm = "on_path";
    }
    catch {
        /* not_on_path */
    }
    return {
        nodeModules,
        nodeModulesEntries,
        binDir: existsSync(bin) ? "present" : "missing",
        tsc,
        npm,
        path: (env.PATH ?? "").slice(0, 400) || undefined,
    };
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
export function runTypecheckDirect(worktree, timeoutMs, deps = {}) {
    const spawn = deps.spawn ?? spawnSync;
    const env = deps.env ?? process.env;
    const opts = { cwd: worktree, timeout: timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env };
    const local = join(worktree, "node_modules", ".bin", "tsc");
    const attempts = [];
    if (existsSync(local))
        attempts.push({ via: "node_modules_bin", cmd: local, args: ["--noEmit"] });
    attempts.push({ via: "npx", cmd: "npx", args: ["--no-install", "tsc", "--noEmit"] });
    for (const a of attempts) {
        let res;
        try {
            res = spawn(a.cmd, a.args, opts);
        }
        catch {
            continue;
        }
        const stdout = String(res.stdout ?? "");
        const stderr = String(res.stderr ?? "");
        // 127/126 from the fallback means this route is broken too; try the next.
        // Anything else -- including a non-zero exit full of TS errors -- is a
        // successful RUN, which is exactly what the gate is asking for.
        if (res.status === 127 || res.status === 126)
            continue;
        if (res.error && !isTimeout(res))
            continue;
        if (/\b(command not found|: not found|could not determine executable)\b/i.test(`${stdout}\n${stderr}`))
            continue;
        return { via: a.via, status: res.status, stdout, stderr, timedOut: isTimeout(res) };
    }
    return null;
}
function isTimeout(res) {
    const code = res.error?.code;
    return code === "ETIMEDOUT" || (res.signal === "SIGTERM" && !!res.error);
}
//# sourceMappingURL=typecheck-fallback.js.map