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
}
/** A mapping that survived validation. Paths are normalised, repo-relative. */
export interface ResolvedGenerator {
    script: string;
    /** Exact file paths owned by this script. */
    files: string[];
    /** Directory prefixes (each with a trailing `/`) owned by this script. */
    dirs: string[];
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
export declare function resolveGenerators(raw: GeneratorMapping[] | undefined): GeneratorMap;
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
/** Reason a generated artifact was rejected as stale. */
export declare function describeStaleGeneratedArtifact(path: string, owner: ResolvedGenerator): string;
//# sourceMappingURL=generated-artifacts.d.ts.map