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
export declare function splitDiffOnFileBoundaries(diff: string, maxBytes?: number): string[];
//# sourceMappingURL=diff.d.ts.map