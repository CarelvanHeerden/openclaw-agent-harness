/**
 * rc.9 -- turning a backend's idea of "a path" into something a policy can judge.
 *
 * StitchGuard, session f7c4e585, 2026-09-14 19:35:17. A worker's `apply_patch`
 * touching four files was denied with:
 *
 *   edit path '.env.example, README.md, docs/deployment-runbook.md,
 *              docs/slack/client-offboarding-app-manifest.yaml' is denylisted
 *
 * One path, four files in it. That single string is the whole story of this
 * module, because it exposed three separate defects at once:
 *
 *  1. `apply_patch` carries NO per-file path. Its entire input is a `patchText`
 *     blob whose `*** Update File:` directives name the targets, and nothing in
 *     the harness read them. The guard was judging a display string.
 *
 *  2. A combined string is judged as one path, and the denylist is anchored, so
 *     the verdict depends on the ORDER of the files in it. `.env.example,
 *     README.md` was denied because the pattern `.env.*` compiles to
 *     `^\.env\..*$` and `.*` happily swallows ", README.md". Reverse it to
 *     `README.md, .env.production` and nothing matches: ALLOWED. The one
 *     denial that did fire fired by accident.
 *
 *  3. `/repo/.env.production` was allowed outright, because the wildcard branch
 *     of the matcher tested the pattern against the whole string while the
 *     literal branch had a `p.endsWith("/" + pat)` case. A pattern with a `*`
 *     in it simply did not understand directories.
 *
 * The rules here follow from that:
 *
 *   - Prefer a STRUCTURED source of paths (patch directives) over a string the
 *     backend assembled for a human to read.
 *   - Canonicalise before judging: separators, `.`/`..`, absolute vs
 *     repo-relative, and -- when the caller can resolve them -- symlink targets.
 *   - When a string might encode more than one path, REFUSE. Do not split on
 *     commas: a comma is a legal character in a filename, and guessing wrong in
 *     the permissive direction is how `README.md, .env.production` got through.
 *
 * Nothing here loosens the denylist. The one relaxation in this file is the
 * authorised-template exception, which is opt-in, exact-match only, and paired
 * with a content check -- see {@link templateExceptionApplies}.
 */
/** Canonical forms of one raw path, or a refusal that the caller must honour. */
export interface PathResolution {
    /** The string as the backend supplied it. */
    raw: string;
    /**
     * Every canonical form policy must be evaluated against -- the lexical path
     * plus, when a resolver was supplied, its symlink target. Judging only one of
     * them is how a symlink escapes. Empty only when `refuse` is set.
     */
    candidates: string[];
    /**
     * Set when the string could not be resolved to an unambiguous path. The
     * caller MUST deny: this is the fail-closed channel, not a warning.
     */
    refuse?: string;
}
export interface ResolveOptions {
    /** Absolute repo root. Paths inside it are made repo-relative before matching. */
    repoRoot?: string;
    /**
     * Resolves symlinks, e.g. `fs.realpathSync`. Optional because the pure guard
     * has no filesystem. Throwing for a MISSING path is expected and ignored (a
     * patch creating a new file has no target yet); throwing for any other reason
     * is a refusal, because "I could not tell what this points at" is not a pass.
     */
    realpath?: (p: string) => string;
}
/**
 * Does this string plausibly encode more than one path?
 *
 * Deliberately conservative in the REFUSING direction, because the alternative
 * -- splitting and hoping -- is what this module exists to prevent. A comma is
 * legal in a filename, so `my,file.txt` must still resolve normally. What is
 * not plausible as a single filename is a comma followed by a space followed by
 * something that itself looks like a path, repeated.
 */
export declare function looksLikeMultiplePaths(raw: string): boolean;
/**
 * Turn one backend-supplied path string into the canonical forms policy judges.
 *
 * Never throws. A string it cannot make sense of comes back with `refuse` set,
 * which the guard turns into a denial.
 */
export declare function resolvePathForPolicy(raw: string, opts?: ResolveOptions): PathResolution;
/**
 * The paths an `apply_patch` will actually touch, read from its own directives.
 *
 * This is the structured source the incident lacked. The OpenAI apply_patch
 * envelope names every target explicitly:
 *
 *   *** Begin Patch
 *   *** Update File: docs/runbook.md
 *   *** Add File: docs/new.md
 *   *** Delete File: docs/old.md
 *   *** Move to: docs/renamed.md
 *   *** End Patch
 *
 * A `Move to:` is recorded as well as its source: a rename out of a protected
 * path is still a write to it, and a rename INTO one is a write to the
 * destination.
 *
 * Returns [] when the text carries no directives at all -- the caller must
 * treat that as "no path exposed" and fail closed, exactly as before.
 */
export declare function pathsFromPatchText(patchText: string): string[];
export interface ParsedPatchTargets {
    complete: boolean;
    paths: string[];
    reason?: string;
}
/**
 * Recognise the complete apply_patch/v1 envelope. A partial parse is never
 * authoritative: especially for moves, omitting the destination would judge
 * only half of the operation.
 */
export declare function parsePatchTargets(patchText: string): ParsedPatchTargets;
export interface SecretScan {
    /** True when the added lines contain something that must never be committed. */
    found: boolean;
    /** Human-readable, and safe: names the SHAPE, never the value. */
    detail?: string;
}
/**
 * Scan the ADDED lines of a patch for secret material.
 *
 * Only added lines: a patch that merely moves an existing line around is not
 * introducing anything, and scanning context lines would refuse every edit to a
 * file that already contains a placeholder.
 *
 * Known token shapes are detected by running the line through the interaction
 * log's redactor and seeing whether it changed. That keeps ONE list of secret
 * shapes in the codebase -- a second copy here would inevitably drift, and the
 * drift would be silent in the permissive direction.
 *
 * Never returns the offending value, only its shape and line number, because
 * this text is destined for an operator-visible clarification.
 */
export declare function scanPatchForSecrets(patchText: string): SecretScan;
/**
 * May this denylisted path be edited after all?
 *
 * The exception is deliberately the narrowest thing that solves the real case:
 *
 *   - EXACT repo-relative paths only. No globs, no directories, no `*.example`.
 *     `.env.example` is a decision about one file, not about a shape of name.
 *   - EVERY resolved form must be authorised, so `../../.env.example` or a
 *     symlink pointing somewhere else does not inherit the authorisation.
 *   - Content is checked separately by {@link scanPatchForSecrets}. An
 *     authorisation to edit a template is not an authorisation to put a live
 *     credential in it.
 *
 * Empty `exceptions` means the exception does not exist, which is the default.
 */
export declare function templateExceptionApplies(resolution: Pick<PathResolution, "candidates">, exceptions: readonly string[]): boolean;
//# sourceMappingURL=path-policy.d.ts.map