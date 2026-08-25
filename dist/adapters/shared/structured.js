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
import { extractAndValidateJson, looksTruncatedJson, repairTruncatedJson, describeJsonSyntaxFault, } from "./json.js";
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
export async function runStructuredLadder(opts) {
    const maxAttempts = opts.maxAttempts ?? 3;
    const attempts = [];
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let sessionId = "";
    let lastRaw = "";
    let correction = null;
    for (let i = 0; i < maxAttempts; i++) {
        let call;
        try {
            call = await opts.attempt(correction);
        }
        catch (err) {
            // beta.126: a call that throws still burned tokens. Record what the
            // backend managed to tell us before it failed, so a failed run is not
            // reported as free.
            const spent = err?.costUsd ?? 0;
            costUsd += spent;
            attempts.push({ outcome: "call_failed", detail: String(err?.message ?? err), costUsd: spent });
            if (i === maxAttempts - 1)
                throw exhausted(opts.role, attempts, costUsd, lastRaw, err);
            correction = "The previous attempt failed before producing a reply. Answer with the JSON document only.";
            continue;
        }
        costUsd += call.costUsd;
        tokensIn += call.tokensIn;
        tokensOut += call.tokensOut;
        if (!sessionId)
            sessionId = call.sessionId;
        lastRaw = call.raw;
        // Rungs 1 and 2: extract, then validate.
        try {
            const parsed = extractAndValidateJson(call.raw, { ...opts.validation, logger: opts.logger ?? opts.validation.logger });
            attempts.push({ outcome: "ok", costUsd: call.costUsd });
            return { parsed, raw: call.raw, costUsd, tokensIn, tokensOut, sessionId, attempts, repaired: false };
        }
        catch (err) {
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
                        const parsed = extractAndValidateJson(repairedText, { ...opts.validation, logger: opts.logger });
                        attempts.push({ outcome: "repaired", detail: "document was cut off; closed and re-validated", costUsd: call.costUsd });
                        opts.logger?.warn(`[${opts.role}] recovered a TRUNCATED reply by repair; the document is incomplete but valid`, { role: opts.role, rawLen: call.raw.length, repairedLen: repairedText.length });
                        return { parsed, raw: call.raw, costUsd, tokensIn, tokensOut, sessionId, attempts, repaired: true };
                    }
                    catch {
                        // The repair produced valid JSON that still fails the contract:
                        // the part that was cut off was a part we require. Fall through.
                    }
                }
            }
            const fault = describeJsonSyntaxFault(err);
            attempts.push({
                outcome: wasTruncated ? "truncated" : "invalid_json",
                detail: fault ?? String(err?.message ?? err),
                costUsd: call.costUsd,
            });
            if (i === maxAttempts - 1)
                throw exhausted(opts.role, attempts, costUsd, lastRaw, err);
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
function exhausted(role, attempts, costUsd, lastRaw, cause) {
    const trail = attempts.map((a, i) => `#${i + 1} ${a.outcome}${a.detail ? `: ${a.detail}` : ""}`).join("; ");
    const err = new Error(`[${role}] could not obtain a valid JSON document after ${attempts.length} attempt(s): ${trail}`);
    err.attempts = attempts;
    err.costUsd = costUsd;
    err.lastRaw = lastRaw;
    err.role = role;
    err.cause = cause;
    return err;
}
export const ROLE_EXHAUSTION_POLICY = {
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
export function exhaustionVerdict(role) {
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
//# sourceMappingURL=structured.js.map