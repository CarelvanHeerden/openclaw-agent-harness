/**
 * The structured-output ladder, and what happens when it runs out.
 *
 * Six of the eight roles ask a model for a JSON document and parse what comes
 * back. Neither backend offers a forced-output mode, so "the model returned
 * prose" is not an error condition to be handled once — it is a routine event
 * with a defined response. v1 handled it twice: the lead grew an elaborate
 * three-attempt ladder over beta.97 through beta.128, and the adversary grew
 * nothing at all and simply threw.
 *
 * v2 makes it one ladder both backends climb, because pointing the worker at a
 * local model makes a malformed or truncated reply likelier, not rarer.
 *
 *   1. extract    — pull the JSON out of prose, fences, or double encoding
 *   2. validate   — check the keys the caller actually requires
 *   3. repair     — if the document was cut off, close it and re-validate
 *   4. retry      — ask again, told specifically what was wrong last time
 *
 * The rungs are ordered by cost. Extraction and repair are free; a retry is a
 * whole model call. A truncated reply is repaired before it is re-asked,
 * because re-asking a model that hit its output ceiling reproduces the same
 * truncation — that was b98's retry ladder, three identical failures and
 * twelve minutes for no plan.
 *
 * WHAT HAPPENS AT THE END is the part that matters. See `onExhaustion`.
 */

import {
  extractAndValidateJson,
  looksTruncatedJson,
  repairTruncatedJson,
  describeJsonSyntaxFault,
  type JsonValidationOptions,
  type StructuredCallError,
} from "./json.js";

/** One model call. The ladder supplies the correction; the backend makes the call. */
export type StructuredAttempt = (correction: string | null) => Promise<{
  raw: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  sessionId: string;
  /** True when the backend knows the reply was cut off at the output ceiling. */
  truncated?: boolean;
}>;

export interface LadderAttempt {
  outcome: "ok" | "invalid_json" | "truncated" | "repaired" | "call_failed";
  detail?: string;
  costUsd: number;
}

export interface LadderResult<T> {
  parsed: T;
  raw: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  sessionId: string;
  attempts: LadderAttempt[];
  /** True when the document came back from `repairTruncatedJson`, so it is INCOMPLETE-but-valid. */
  repaired: boolean;
}

/**
 * Thrown when every rung has been tried.
 *
 * Carries the attempt trail so a caller can report what it cost and what went
 * wrong at each step, rather than surfacing only the final message. b128's
 * lesson: a recovered truncation that left no trace is a mechanism nobody can
 * tell is working.
 */
export interface LadderExhaustedError extends Error {
  attempts: LadderAttempt[];
  costUsd: number;
  lastRaw: string;
  role: string;
}

export interface LadderOptions<T> {
  /** Which role is asking, for messages and audit. */
  role: string;
  validation: JsonValidationOptions<T>;
  attempt: StructuredAttempt;
  /** Total model calls, including the first. Default 3. */
  maxAttempts?: number;
  logger?: { warn: (m: string, meta?: unknown) => void };
}

/**
 * Run the ladder. Resolves with a validated document, or throws
 * `LadderExhaustedError`.
 *
 * It THROWS rather than returning a degraded default, deliberately. A default
 * that means "this went wrong" has to travel through the caller as data, and
 * every caller then has to remember to check it — which is precisely how a
 * failed review becomes an approval. A throw cannot be forgotten. What the
 * caller must do with it is `onExhaustion`, below.
 */
export async function runStructuredLadder<T>(opts: LadderOptions<T>): Promise<LadderResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const attempts: LadderAttempt[] = [];
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let sessionId = "";
  let lastRaw = "";
  let correction: string | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    let call: Awaited<ReturnType<StructuredAttempt>>;
    try {
      call = await opts.attempt(correction);
    } catch (err) {
      // beta.126: a call that throws still burned tokens. Record what the
      // backend managed to tell us before it failed, so a failed run is not
      // reported as free.
      const spent = (err as StructuredCallError)?.costUsd ?? 0;
      costUsd += spent;
      attempts.push({ outcome: "call_failed", detail: String((err as Error)?.message ?? err), costUsd: spent });
      if (i === maxAttempts - 1) throw exhausted(opts.role, attempts, costUsd, lastRaw, err);
      correction = "The previous attempt failed before producing a reply. Answer with the JSON document only.";
      continue;
    }

    costUsd += call.costUsd;
    tokensIn += call.tokensIn;
    tokensOut += call.tokensOut;
    if (!sessionId) sessionId = call.sessionId;
    lastRaw = call.raw;

    // Rungs 1 and 2: extract, then validate.
    try {
      const parsed = extractAndValidateJson<T>(call.raw, { ...opts.validation, logger: opts.logger ?? opts.validation.logger });
      attempts.push({ outcome: "ok", costUsd: call.costUsd });
      return { parsed, raw: call.raw, costUsd, tokensIn, tokensOut, sessionId, attempts, repaired: false };
    } catch (err) {
      // beta.126: the stop_reason is authoritative when it arrives, but when
      // the backend does not know the model it never does. An unbalanced
      // document is the truncation telling us itself.
      const wasTruncated = call.truncated === true || looksTruncatedJson(call.raw);

      // Rung 3: repair, but only for a truncation. Repairing a document that
      // was never cut off would paper over a genuine contract violation.
      if (wasTruncated) {
        const repairedText = repairTruncatedJson(call.raw);
        if (repairedText) {
          try {
            const parsed = extractAndValidateJson<T>(repairedText, { ...opts.validation, logger: opts.logger });
            attempts.push({ outcome: "repaired", detail: "document was cut off; closed and re-validated", costUsd: call.costUsd });
            opts.logger?.warn(
              `[${opts.role}] recovered a TRUNCATED reply by repair; the document is incomplete but valid`,
              { role: opts.role, rawLen: call.raw.length, repairedLen: repairedText.length },
            );
            return { parsed, raw: call.raw, costUsd, tokensIn, tokensOut, sessionId, attempts, repaired: true };
          } catch {
            // The repair produced valid JSON that still fails the contract:
            // the part that was cut off was a part we require. Fall through.
          }
        }
      }

      const fault = describeJsonSyntaxFault(err);
      attempts.push({
        outcome: wasTruncated ? "truncated" : "invalid_json",
        detail: fault ?? String((err as Error)?.message ?? err),
        costUsd: call.costUsd,
      });

      if (i === maxAttempts - 1) throw exhausted(opts.role, attempts, costUsd, lastRaw, err);

      // Rung 4: retry, told what went wrong. A truncation needs LESS output,
      // not a restated contract -- re-asserting the contract re-truncates
      // identically, which is the b98 ladder.
      correction = wasTruncated
        ? "Your previous reply was cut off at the output limit. Answer again, MUCH more concisely: fewer " +
          "items, shorter strings, no commentary. The document must be complete and closed."
        : `Your previous reply could not be parsed as the required JSON. ${fault ?? ""} Answer with the JSON ` +
          `document only -- no prose, no code fence, no explanation.`.trim();
    }
  }

  /* c8 ignore next */
  throw exhausted(opts.role, attempts, costUsd, lastRaw, new Error("ladder exhausted"));
}

function exhausted(role: string, attempts: LadderAttempt[], costUsd: number, lastRaw: string, cause: unknown): LadderExhaustedError {
  const trail = attempts.map((a, i) => `#${i + 1} ${a.outcome}${a.detail ? `: ${a.detail}` : ""}`).join("; ");
  const err = new Error(
    `[${role}] could not obtain a valid JSON document after ${attempts.length} attempt(s): ${trail}`,
  ) as LadderExhaustedError;
  err.attempts = attempts;
  err.costUsd = costUsd;
  err.lastRaw = lastRaw;
  err.role = role;
  (err as { cause?: unknown }).cause = cause;
  return err;
}

// ---------------------------------------------------------------------------
// What a role must do when the ladder runs out
// ---------------------------------------------------------------------------

/**
 * The direction each role fails in, when no valid document could be obtained.
 *
 * `review` — the run continues, but the result is treated as "a human must
 *   look at this". Never as approval.
 * `fail_run` — the run stops. Nothing ships.
 *
 * The adversary is the case this exists for. Its failure mode is not that it
 * returns nothing; it is that "the reviewer could not be reached" and "the
 * reviewer found no problems" have the same shape at the call site, and a
 * `pass`-shaped default silently converts an outage into an approval. So there
 * is no route from ladder exhaustion to `pass`, for any role, under any
 * configuration.
 */
export type ExhaustionPolicy = "review" | "fail_run";

export const ROLE_EXHAUSTION_POLICY: Readonly<Record<string, ExhaustionPolicy>> = {
  // A review that did not happen is not a review that passed.
  adversary: "review",
  // No plan means there is nothing to execute; stopping is the honest outcome.
  lead: "fail_run",
  crystalliser: "fail_run",
  // These three refine work already under way. Losing one degrades the cycle
  // but does not make anything unsafe, and the deliverable still faces the
  // adversary before it can ship.
  classifier: "review",
  revise_spec: "review",
  worker_context: "review",
};

/**
 * The verdict a role reports when its ladder is exhausted.
 *
 * Exported so a test can assert the property directly: for every role, and
 * every policy, the answer is never `pass`.
 */
export function exhaustionVerdict(role: string): { verdict: "revise" | "block"; policy: ExhaustionPolicy; why: string } {
  const policy = ROLE_EXHAUSTION_POLICY[role] ?? "review";
  return {
    // `revise` rather than `block`: the code is not known to be bad, it is
    // unreviewed, and those are different things an operator needs to tell
    // apart. What they have in common is that neither may merge.
    verdict: "revise",
    policy,
    why: `the ${role} could not produce a valid response; treating this as unreviewed, not as approved`,
  };
}
