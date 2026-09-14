/**
 * Backend-agnostic diff chunking for review.
 *
 * v2.0.0: moved out of the Claude SDK adapter unchanged. Splitting a diff on
 * `diff --git` boundaries is a property of unified diffs, not of whoever is
 * reviewing them, and any backend running the adversary needs it. The chunk
 * ceilings live here so a caller cannot pick a different one per backend and
 * silently change what gets reviewed.
 */
export declare const DIFF_SINGLE_CHUNK_BYTES = 180000;
export declare const CHUNK_MAX_BYTES = 180000;
/** rc.7: one file's section of a unified diff, and what it did. */
export interface FoldedGeneratedFile {
    path: string;
    script: string;
    added: number;
    removed: number;
    bytes: number;
}
/**
 * rc.7: replace declared generated output with a summary of itself.
 *
 * WHY. A regenerated bundle is real, reviewable-looking diff -- 1,663 files on
 * the StitchGuard OKF tree -- and it goes to the adversary verbatim. Past
 * DIFF_SINGLE_CHUNK_BYTES that splits into chunks reviewed in sequence, so the
 * hand-written change that actually needs review is scattered across calls,
 * each seeing a fraction of it, while most of the money is spent reading
 * machine output line by line. The generated content is not where defects live:
 * it is a function of sources that are themselves in the diff.
 *
 * WHAT THIS IS NOT. It is not a way to hide files from review. Every folded
 * file is named, with its line counts and the script that owns it, so the
 * adversary knows exactly what changed and can demand to see any of it. Only
 * paths an operator explicitly declared in `verify.generators` are eligible --
 * nothing is inferred from a directory name -- and the whole thing is off
 * unless a deployment turns it on. What it removes is the line-by-line content
 * of files whose content is derived, not the fact of their change.
 *
 * Pure, and takes a predicate rather than a GeneratorMap so this stays free of
 * the orchestrator.
 */
export declare function foldGeneratedFiles(diff: string, ownerOf: (path: string) => string | null): {
    diff: string;
    folded: FoldedGeneratedFile[];
};
export declare function splitDiffOnFileBoundaries(diff: string, maxBytes?: number): string[];
//# sourceMappingURL=diff.d.ts.map