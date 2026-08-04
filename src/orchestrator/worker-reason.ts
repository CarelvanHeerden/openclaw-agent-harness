/**
 * beta.101: EXTRACT THE WORKER'S ACTUAL REASON FOR A PATH DEVIATION.
 *
 * b100's Fix 2 asks a human to adjudicate "was the plan's path wrong, or the
 * worker's placement?" and quotes the worker's justification to inform that
 * call. It sourced the quote from the FIRST non-empty line of the worker's
 * final message, which assumes workers lead with their reasoning. They do not.
 *
 * In the b100 smoke the operator was shown:
 *
 *   "The worker's stated reason: That's fine, it's a harmless temp file outside
 *    the repo. Sub-task complete."
 *
 * -- a remark about an unrelated temp file. The worker's real reason (the
 * planned nav file did not exist, so it edited the actual sidebar component)
 * was further down the message. The one input a human needs to decide correctly
 * was actively misleading.
 *
 * So instead of position, select on RELEVANCE: prefer a sentence that names one
 * of the paths under dispute or explains a placement decision, and fall back to
 * the old first-line behaviour only when nothing in the message qualifies.
 */

/** Phrases that mark a sentence as explaining a placement/deviation decision. */
const DEVIATION_CUES = [
  "instead", "rather than", "does not exist", "doesn't exist", "no such",
  "not exist", "already exists", "actually", "convention", "located", "lives in",
  "placed", "put it", "moved", "wrong path", "incorrect path", "could not find",
  "couldn't find", "no file", "missing",
];

/** Content-free sign-off noise that must never be surfaced as a reason. */
const NOISE = /^(sub-?task (is )?(complete|done)|done|complete|completed|all done|finished|that'?s (it|fine)|ok(ay)?)\b[.!]?$/i;

function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-*\d.)\s]+/, "").trim();
    if (!trimmed) continue;
    // Split into sentences so one dense paragraph still yields the right clause.
    for (const s of trimmed.split(/(?<=[.!?])\s+(?=[A-Z`"'*_[(])/)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function basenames(paths: string[]): string[] {
  return paths
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .map((p) => p.split("/").filter(Boolean).pop() ?? "")
    .filter((b) => b.length > 2);
}

/**
 * Pure. Returns the most likely explanation for why the worker's files differ
 * from its contract, bounded to `maxChars`, or "" when the message is empty.
 *
 * Scoring, highest first: naming a disputed path (or its basename) is the
 * strongest signal of relevance; a deviation cue is the next strongest; a
 * sentence with both wins outright.
 */
export function extractStatedReason(
  finalMessage: string,
  expectedPaths: string[] = [],
  actualPaths: string[] = [],
  maxChars = 400,
): string {
  const text = (finalMessage ?? "").trim();
  if (!text) return "";

  const needles = [
    ...expectedPaths.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean),
    ...actualPaths.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean),
    ...basenames([...expectedPaths, ...actualPaths]),
  ].map((s) => s.toLowerCase());

  const candidates = sentences(text).filter((s) => !NOISE.test(s));
  let best = "";
  let bestScore = 0;
  for (const s of candidates) {
    const lower = s.toLowerCase();
    let score = 0;
    if (needles.some((n) => n && lower.includes(n))) score += 2;
    if (DEVIATION_CUES.some((c) => lower.includes(c))) score += 1;
    // Prefer the EARLIEST sentence at a given score: later restatements tend to
    // be summaries, and the first statement of a reason is usually the fullest.
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (bestScore === 0) best = candidates[0] ?? "";
  return best.length > maxChars ? `${best.slice(0, maxChars).trimEnd()}...` : best;
}
