/**
 * Backend-agnostic diff chunking for review.
 *
 * v2.0.0: moved out of the Claude SDK adapter unchanged. Splitting a diff on
 * `diff --git` boundaries is a property of unified diffs, not of whoever is
 * reviewing them, and any backend running the adversary needs it. The chunk
 * ceilings live here so a caller cannot pick a different one per backend and
 * silently change what gets reviewed.
 */
export const DIFF_SINGLE_CHUNK_BYTES = 180_000;
export const CHUNK_MAX_BYTES = 180_000;
export function splitDiffOnFileBoundaries(diff, maxBytes = CHUNK_MAX_BYTES) {
    if (diff.length <= maxBytes)
        return [diff];
    const parts = diff.split(/(?=^diff --git )/m);
    const chunks = [];
    let cur = "";
    for (const part of parts) {
        if (part.length > maxBytes) {
            // single file too big; emit any accumulated chunk, then truncate this file
            if (cur) {
                chunks.push(cur);
                cur = "";
            }
            chunks.push(part.slice(0, maxBytes) + `\n[TRUNCATED: file diff was ${part.length} bytes, capped at ${maxBytes}]\n`);
            continue;
        }
        if (cur.length + part.length > maxBytes) {
            chunks.push(cur);
            cur = part;
        }
        else {
            cur += part;
        }
    }
    if (cur)
        chunks.push(cur);
    return chunks;
}
//# sourceMappingURL=diff.js.map