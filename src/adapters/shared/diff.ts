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

/** rc.7: one file's section of a unified diff, and what it did. */
export interface FoldedGeneratedFile {
  path: string;
  script: string;
  added: number;
  removed: number;
  bytes: number;
}

/** How many folded files are listed individually before the tail is counted. */
const FOLD_MANIFEST_LIMIT = 200;

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
export function foldGeneratedFiles(
  diff: string,
  ownerOf: (path: string) => string | null,
): { diff: string; folded: FoldedGeneratedFile[] } {
  if (!diff.includes("diff --git ")) return { diff, folded: [] };
  const parts = diff.split(/(?=^diff --git )/m);
  const kept: string[] = [];
  const folded: FoldedGeneratedFile[] = [];

  for (const part of parts) {
    // `b/` side: a rename's destination is the path that now exists.
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    const path = header?.[2];
    const script = path ? ownerOf(path) : null;
    if (!path || script === null) {
      kept.push(part);
      continue;
    }
    let added = 0;
    let removed = 0;
    for (const line of part.split("\n")) {
      // `+++`/`---` are the file headers, not content.
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    folded.push({ path, script, added, removed, bytes: part.length });
  }

  if (folded.length === 0) return { diff, folded: [] };

  const totalAdded = folded.reduce((n, f) => n + f.added, 0);
  const totalRemoved = folded.reduce((n, f) => n + f.removed, 0);
  const totalBytes = folded.reduce((n, f) => n + f.bytes, 0);
  const scripts = [...new Set(folded.map((f) => f.script))];
  const listed = folded.slice(0, FOLD_MANIFEST_LIMIT);

  const banner = [
    "=".repeat(78),
    `GENERATED OUTPUT: ${folded.length} file(s) SUMMARISED, NOT SHOWN VERBATIM`,
    "=".repeat(78),
    "",
    `These files are declared output of ${scripts.map((s) => `\`npm run ${s}\``).join(", ")} in this`,
    "repository's verify.generators. Their contents are derived from sources that ARE",
    "shown in full below. They changed as follows:",
    "",
    `  ${folded.length} file(s), +${totalAdded} -${totalRemoved} line(s), ${totalBytes} bytes of diff omitted`,
    "",
    ...listed.map((f) => `  ${f.path}  +${f.added} -${f.removed}  (npm run ${f.script})`),
    ...(folded.length > listed.length ? [`  ... and ${folded.length - listed.length} more`] : []),
    "",
    "Review the SOURCES and the GENERATOR, not this output. A defect here is a",
    "defect in one of those, and it is fixed there.",
    "",
    "This is a summary, not a claim that the files are correct. If you have a",
    "specific reason to doubt one -- a source change that should have altered it",
    "and a line count suggesting it did not, output that looks hand-edited, a path",
    "that does not belong to the generator -- file a finding saying so and naming",
    "the file. Do NOT report these files as missing or unreviewed in general; they",
    "are listed above and their omission is deliberate.",
    "=".repeat(78),
    "",
    "",
  ].join("\n");

  return { diff: banner + kept.join(""), folded };
}

export function splitDiffOnFileBoundaries(diff: string, maxBytes: number = CHUNK_MAX_BYTES): string[] {
  if (diff.length <= maxBytes) return [diff];
  const parts = diff.split(/(?=^diff --git )/m);
  const chunks: string[] = [];
  let cur = "";
  for (const part of parts) {
    if (part.length > maxBytes) {
      // single file too big; emit any accumulated chunk, then truncate this file
      if (cur) { chunks.push(cur); cur = ""; }
      chunks.push(part.slice(0, maxBytes) + `\n[TRUNCATED: file diff was ${part.length} bytes, capped at ${maxBytes}]\n`);
      continue;
    }
    if (cur.length + part.length > maxBytes) {
      chunks.push(cur);
      cur = part;
    } else {
      cur += part;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
