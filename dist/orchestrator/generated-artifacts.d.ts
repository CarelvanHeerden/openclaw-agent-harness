/**
 * Generated-artifact OWNERSHIP (rc.5 fix #1).
 *
 * WHY THIS EXISTS
 * ---------------
 * The harness used to hand the worker an impossible contract. Three separate
 * prompt sites told it that regeneration was somebody else's job:
 *
 *   - the worker convention block: "any bundle/artifact REGENERATION step
 *     (e.g. running `npm run okf`) is handled by the harness AFTER your turn in
 *     its convention-check phase -- do NOT run regenerators yourself";
 *   - the worker prompt proper: "DO NOT run ... bundle/artifact regenerators";
 *   - the adversary convention block: "do NOT raise a finding merely because a
 *     generated bundle/artifact was not regenerated ... the harness regenerates
 *     derived artifacts in its own post-worker convention-check phase".
 *
 * No such phase exists. `runFinalVerifyChecks` runs the repo's declared CHECK
 * scripts (default allowlist `okf:check`, `lint`, `typecheck`, `test`), never a
 * generator, and commits nothing -- and since beta.81 it is off by default
 * (`verify.run_repo_check_scripts: false`), so on a stock deployment the phase
 * being promised does not run at all. Verification then asked for the generated
 * file anyway, and because nothing in the verify layer knew the path was
 * derived, its absence surfaced through the contract path-resolution machinery
 * as a path mismatch: "we could not find your file", when the truth was "nobody
 * was ever going to write it".
 *
 * THE OWNERSHIP MODEL
 * -------------------
 * Generation is the WORKER's job, and only for paths an operator has
 * explicitly mapped to a generator script here.
 *
 * That split follows the line beta.81 actually drew. Its retirement of local
 * execution was scoped to the VERIFICATION SPINE ("verification is CI-only
 * now") -- not to execution as such. The harness already runs `npm ci` in the
 * worktree to bootstrap deps, and the worker already runs `git commit` in its
 * workspace to finish every sub-task. The operative distinction is AUTHORING
 * versus VERIFYING: a command that produces a committed deliverable is
 * authoring, which the worker owns; a command that decides whether the work is
 * correct is verification, which CI owns. A generated bundle the repo requires
 * committed is part of the change, not a check on it.
 *
 * WHAT THIS MAP DELIBERATELY DOES NOT DO
 * --------------------------------------
 * It never infers. Ownership comes from operator-approved config and nothing
 * else -- not from script names, not from directory names, and not from a
 * built-in default for any particular repo's toolchain. An unmapped path is an
 * ordinary file: it gets no generation, and it gets no exemption from the
 * normal contract checks either. Both halves matter. Inferring ownership would
 * let a hand-written file be silently reassigned to a generator; exempting
 * unmapped paths would recreate the very hole this fix closes.
 *
 * The map authorizes SCOPED WORKER-SIDE generation only. Nothing here runs a
 * generator, and nothing here should grow the ability to: harness-side
 * execution of these scripts is out of scope by construction.
 */
/** An operator-declared mapping from a generator script to the paths it owns. */
export interface GeneratorMapping {
    /** A `package.json` script name, run by the WORKER as `npm run <script>`. */
    script: string;
    /**
     * Repo-relative paths this script produces. An entry ending in `/` is a
     * directory prefix and owns everything beneath it; any other entry is an
     * exact file path. The distinction is explicit precisely so that ownership
     * never has to be guessed from the shape of a path.
     */
    produces: string[];
    /**
     * rc.6: repo-relative paths this script READS, in the same file/`dir/` form
     * as `produces`. Optional, and the reason it exists is narrow.
     *
     * Freshness is otherwise unprovable. The harness never executes a generator
     * (see the header), so when a derived artifact did not change it cannot tell
     * "nobody ran the generator" from "the generator ran and was a legitimate
     * no-op". rc.5 resolved that by assuming the worst and failing, which is how
     * a sub-task whose only change was a test file kept being told its committed
     * OpenAPI bundle was stale. Declared inputs turn the question into one git
     * can answer: did anything this script reads change while its output did not?
     */
    inputs?: string[];
}
/** A mapping that survived validation. Paths are normalised, repo-relative. */
export interface ResolvedGenerator {
    script: string;
    /** Exact file paths owned by this script. */
    files: string[];
    /** Directory prefixes (each with a trailing `/`) owned by this script. */
    dirs: string[];
    /** rc.6: exact input file paths. Empty when the operator declared none. */
    inputs: string[];
    /** rc.6: input directory prefixes (each with a trailing `/`). */
    inputDirs: string[];
}
/** A rejected mapping entry. These are configuration errors, never silent. */
export interface GeneratorConfigError {
    script: string;
    path?: string;
    reason: string;
}
/**
 * Normalise a declared or queried path to a comparable repo-relative POSIX
 * form. Returns null when the path escapes the repository or is not relative --
 * an escaping `produces` entry would let config point generation, and the
 * ownership exemptions that follow from it, at a file outside the worktree.
 */
export declare function normaliseRepoPath(raw: string): string | null;
/**
 * rc.6: does a `repos.never_commit_paths` pathspec cover this path?
 *
 * WHY THIS CHECK EXISTS. `never_commit_paths` is not advisory. Its enforcement
 * (`revertNeverCommitPaths`) unstages AND restores every matching path before
 * the commit, so work under it is discarded, not merely skipped. Point a
 * generator at a tree that is also excluded and the contract becomes literally
 * unsatisfiable: the worker is instructed to run the script and commit what it
 * writes, the harness throws the result away, the contract then fails because
 * the artifact was never committed, and the failure text advises re-running the
 * generator -- which will be thrown away again.
 *
 * The observed configuration had exactly this shape: `okf` declared as the
 * generator for `okf/...`, and `never_commit_paths: ["okf/**"]`.
 *
 * Supports the `*` / `**` / `?` pathspec forms an operator would write here. A
 * pattern with no wildcard owns its subtree, as a git pathspec does.
 */
export declare function neverCommitCovers(patterns: readonly string[] | undefined, path: string): boolean;
/**
 * The validated ownership map. Construct with {@link resolveGenerators}.
 *
 * `errors` is part of the result rather than a thrown exception because a bad
 * mapping must surface as an actionable configuration failure attached to the
 * work it affects, not as a crash at config-load time.
 */
export interface GeneratorMap {
    entries: ResolvedGenerator[];
    errors: GeneratorConfigError[];
    /** True when no generator is declared -- the default, and the common case. */
    empty: boolean;
    /**
     * The generator that owns `path`, or null. Ambiguously-owned paths resolve to
     * null: two scripts claiming one artifact is a configuration error, and
     * guessing between them would authorize the wrong command.
     */
    ownerOf(path: string): ResolvedGenerator | null;
}
/**
 * Validate operator config into an ownership map.
 *
 * Rejects, per entry: a non-plain script name, an empty `produces`, a path that
 * is not repo-relative, and a path claimed by more than one script. A rejected
 * PATH removes only that path; a rejected SCRIPT removes the whole entry. In
 * both cases the affected paths end up unowned, which means "ordinary file" --
 * no generation, no exemption.
 */
export declare function resolveGenerators(raw: GeneratorMapping[] | undefined, opts?: {
    /**
     * rc.6: `repos.never_commit_paths`. A produced path this covers is rejected
     * -- see {@link neverCommitCovers} for why that combination cannot be
     * satisfied by any worker.
     */
    neverCommitPaths?: string[];
}): GeneratorMap;
/**
 * Contract paths still eligible for a topology rescue.
 *
 * The rescue exists because the lead can guess a SOURCE file's location wrong,
 * so a same-basename file the worker did touch is probably the one it meant. A
 * derived path carries no such ambiguity: the operator declared exactly where
 * the generator writes. Rescuing one onto a sibling would relabel "the
 * generator never ran" as "the file moved", and pass.
 */
export declare function rescuableContractPaths(map: GeneratorMap | undefined, paths: readonly string[]): string[];
/**
 * Is the mapped script actually declared by the repo? A mapping that names a
 * script `package.json` does not have is MISSING TOOLING: the worker cannot run
 * it, so the artifact will never appear, and the contract on it would otherwise
 * fail as an unexplained path mismatch.
 */
export declare function generatorScriptDeclared(scripts: Record<string, unknown> | undefined, script: string): boolean;
/**
 * Which generators does THIS set of paths authorize, and for which paths?
 *
 * The caller passes the sub-task's own paths (its verification contract and its
 * declared scope), never the whole repo -- authorization is per sub-task by
 * construction, so no turn can be talked into a speculative repo-wide run.
 * Grouped by script and returned in declaration order for a stable prompt.
 */
export declare function authorizedGeneratorsForPaths(map: GeneratorMap, paths: readonly string[]): {
    script: string;
    paths: string[];
}[];
/**
 * The worker-facing instruction for the generated artifacts THIS sub-task is
 * contracted to produce. Returns "" when none are, which keeps the blanket
 * "do not run repo-wide generators" guard in force for every other turn -- the
 * beta.70 cost lesson (a 19-minute speculative `npm run okf` across 1436 files
 * for a zero diff) is preserved by only ever authorizing a NAMED script for a
 * NAMED path the sub-task already owes.
 */
export declare function renderGeneratorInstruction(owners: {
    script: string;
    paths: string[];
}[]): string;
/**
 * Actionable failure text for a contract on a generated path. Replaces the
 * path-mismatch story with the real one: which script owns the artifact, and
 * whether the reason it is absent is missing tooling or an unrun generator.
 */
export declare function describeGeneratedArtifactFailure(params: {
    path: string;
    owner: ResolvedGenerator;
    scriptDeclared: boolean;
    baseDetail: string;
}): string;
/** rc.6: which of this generator's declared inputs changed in the window. */
export declare function changedGeneratorInputs(owner: ResolvedGenerator, changedFiles: readonly string[]): string[];
/**
 * rc.6: is a derived artifact that did not change in this window acceptable?
 *
 * THE RULE rc.5 GOT WRONG. rc.5 required a generator-owned path to be rewritten
 * inside the current sub-task's window on every revise cycle, and failed it
 * otherwise with the words "its sources moved, so the committed artifact is
 * stale". Neither clause was ever checked. Nothing established that any source
 * had moved, and nothing compared the artifact to anything -- the only fact in
 * evidence was "this file did not change", which for a deterministic generator
 * is the expected outcome of a test-only sub-task. The compliance-calendar run
 * hit this repeatedly and had no way through it: the only action that satisfies
 * a diff requirement is a fake diff, which is the one thing a derived file must
 * never contain.
 *
 * So the four states the report separates are separated here, and the harness
 * only claims the ones it can evidence:
 *
 *   - REGENERATED   the artifact changed in this window. Nothing to decide.
 *   - MISSING       it is not in the branch at all. The generator never ran,
 *                   and that is a fact, not an inference. Fail.
 *   - STALE         a declared input changed and the output did not. Also a
 *                   fact. Fail, and name the inputs.
 *   - UNPROVEN      it is present, unchanged, and no input evidence exists.
 *                   A no-op is as consistent with this as a skipped generator,
 *                   and the harness cannot execute the script to find out
 *                   (deliberately -- see the header). Accept, and say so.
 *
 * The UNPROVEN accept is the deliberate loosening, and it is bounded three
 * ways: the artifact must already be committed in the branch, the sub-task must
 * not have been targeted at that file, and an operator who declares `inputs`
 * converts it into a real STALE check. Repos that care also run a `*:check`
 * script in CI, which is the deterministic answer this layer cannot compute.
 */
export type GeneratedFreshness = {
    verdict: "regenerated";
    detail: string;
    passed: true;
} | {
    verdict: "missing";
    detail: string;
    passed: false;
} | {
    verdict: "stale";
    detail: string;
    passed: false;
    changedInputs: string[];
} | {
    verdict: "unproven";
    detail: string;
    passed: true;
};
export declare function assessGeneratedFreshness(params: {
    path: string;
    owner: ResolvedGenerator;
    /** The artifact itself changed inside this sub-task's window. */
    writtenThisWindow: boolean;
    /** It exists and is committed somewhere in the branch. */
    presentInBranch: boolean;
    /** The window's changed files, or null when the harness could not read them. */
    changedFiles: readonly string[] | null;
    /** Probe text, carried through so a failure stays diagnosable. */
    baseDetail: string;
}): GeneratedFreshness;
//# sourceMappingURL=generated-artifacts.d.ts.map