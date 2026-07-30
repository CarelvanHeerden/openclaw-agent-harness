/**
 * beta.92 (charter item #3): LOG-ONLY worker self-contradiction detector.
 *
 * The b91 seq-6 confab: the worker's OWN final message said it "did not touch"
 * `.../[fileId]/download/route.ts`, yet that file was a contract-required
 * commit. The b84 strict verifier caught it correctly at verify time -- but the
 * worker had already lexically admitted the miss in its final message, so we
 * could bark EARLIER with a clearer error.
 *
 * SCOPE (agreed with Staging, deliberately conservative): b92 is LOG-ONLY.
 * We emit `loop.worker_confab_suspected` when the worker's finalMessage
 * contains a "not touched / already correct / left unchanged" phrase applied to
 * a file that is a contract-required path THIS sub-task must change. We do NOT
 * hard-fail on it in b92 (false-positive risk: a worker may legitimately say
 * "I did not touch X" for a not-targeted, revise-relaxed contract file). The
 * hard-fail decision is deferred to b93 once we have audit data on how often
 * this fires and whether it correlates with genuine confabs.
 *
 * Pure/deterministic. No fs, no git, no SDK.
 */

/** Phrases signalling the worker claims it did NOT change a file. */
const NOT_TOUCHED_RE =
  /\b(?:did not|didn'?t|do not|don'?t|not|never)\s+(?:touch|modif|chang|edit|alter|writ|updat)\w*\b|\b(?:left|leav\w*|kept|remain\w*)\s+(?:it\s+)?(?:untouched|unchanged|as[-\s]is|as\s+it\s+was)\b|\balready\s+(?:correct|complete|fine|good|in\s+place|exists?)\b/i;

/** basename of a path (lowercased, slash-normalised). */
function base(p: string): string {
  const n = p.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
  const i = n.lastIndexOf("/");
  return i === -1 ? n : n.slice(i + 1);
}

export interface ConfabProbe {
  suspected: boolean;
  /** contract-required paths the worker's message lexically claims it left alone. */
  offenders: string[];
  /** the matched "not touched" phrase (first hit), for the audit payload. */
  phrase?: string;
}

/**
 * Detect a suspected worker confabulation from its final message.
 *
 * @param finalMessage      the worker's end-of-turn message
 * @param requiredPaths     contract paths THIS sub-task is REQUIRED to change
 *                          (NOT revise-relaxed) -- a "not touched" claim about
 *                          one of these is the confab signal.
 */
export function detectWorkerConfab(
  finalMessage: string | undefined,
  requiredPaths: string[],
): ConfabProbe {
  const msg = (finalMessage ?? "").trim();
  if (!msg || requiredPaths.length === 0) return { suspected: false, offenders: [] };

  // Scan per-sentence so a "not touched" clause is scoped near the filename it
  // mentions (a global match on the whole message would over-fire).
  const sentences = msg.split(/(?<=[.!?\n])\s+/);
  const offenders = new Set<string>();
  let phrase: string | undefined;

  for (const path of requiredPaths) {
    const b = base(path);
    if (!b || !b.includes(".")) continue; // need a real filename
    for (const s of sentences) {
      const low = s.toLowerCase();
      if (!low.includes(b) && !low.includes(path.trim().toLowerCase())) continue;
      const m = s.match(NOT_TOUCHED_RE);
      if (m) {
        offenders.add(path);
        if (!phrase) phrase = m[0];
        break;
      }
    }
  }

  return { suspected: offenders.size > 0, offenders: [...offenders], phrase };
}
