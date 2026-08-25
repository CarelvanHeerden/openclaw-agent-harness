/**
 * Backend-agnostic structured-output extraction.
 *
 * v2.0.0: moved out of the Claude SDK adapter unchanged. Nothing here ever
 * depended on the SDK -- it operates on a string of model output -- and every
 * backend needs the same ladder, because the failure it handles is a property
 * of language models, not of one vendor:
 *
 *   extract -> validate against a schema -> repair a truncated document -> retry
 *
 * That matters more in v2 than it did in v1. The six tool-less roles ask a
 * model for JSON and parse what comes back; there is no forced-output mode on
 * either backend. Pointing the worker at a local model makes a malformed or
 * truncated reply likelier, so the ladder is the contract, and exhausting it
 * must fail toward review rather than toward a pass.
 */
/**
 * What a structured call throws when it cannot produce a valid document.
 *
 * v2.0.0: moved here from the Claude adapter because the ladder that throws it
 * is here, and because both backends need to distinguish the same three
 * things: the raw reply, the substring we actually tried to parse, and whether
 * the model was cut off. A caller deciding whether to retry, repair, or fail
 * toward review reads exactly those.
 */
export interface StructuredCallError extends Error {
    rawText?: string;
    truncated?: boolean;
    /**
     * beta.126: what the failed call cost. A call that throws still burned
     * tokens -- the b125 planning failure spent six minutes of Opus across two
     * attempts and the session recorded $0.00 -- and a caller cannot charge for
     * what it is never told.
     */
    costUsd?: number;
    /**
     * beta.128: the JSON we actually tried to parse, kept whole. `rawText` is the
     * entire reply (prose, fences and all) and the message embeds only a 2000
     * char slice; neither lets a caller point at the offending token. See
     * `describeJsonSyntaxFault`.
     */
    extractedText?: string;
}
/**
 * beta.126: is this reply a JSON document that was cut off?
 *
 * Until now the only evidence of truncation the harness would accept was
 * `stop_reason === "max_tokens"` from the SDK. That works when the SDK knows
 * the model. When it does not -- a model id newer than the pinned SDK, which
 * is the b125 lead configuration -- the output stops at a ceiling the SDK
 * never names, no stop reason arrives, and the b97 compaction retry never
 * fires. The b81 anti-prose rung runs instead and re-truncates identically,
 * because telling a model "you returned prose, begin with '{'" does nothing
 * about a reply being cut at a fixed length. That is 6m15s and $0 for nothing.
 *
 * The document itself is better evidence than the metadata. A reply that opens
 * a JSON container and never closes it was cut off -- there is no other way to
 * produce one. Prose has no opening container; prose wrapped around a complete
 * object balances and never reaches here.
 */
export declare function looksTruncatedJson(text: string): boolean;
/**
 * beta.99 (P0-6): repair a JSON document that was cut off mid-write.
 *
 * `scanBalanced` requires depth to return to 0, so a truncated reply yields
 * ZERO candidates and `extractJson` throws "no JSON in output" -- discarding a
 * document that was perfectly well-formed for its first 95%. On b98 that meant
 * a plan whose sub-task 1 was complete and sub-task 2 half-written was binned
 * wholesale.
 *
 * The repair walks the text tracking string/escape state and container depth,
 * rewinds to the last position where a COMPLETE element had just been closed,
 * and appends the closers needed to balance it. Anything after that point (the
 * half-written element) is dropped.
 *
 * Returns null when there is nothing recoverable. The result is deliberately
 * INCOMPLETE-BUT-VALID: callers must treat it as a partial document, announce
 * it loudly, and re-validate before use. It is never a silent substitute for a
 * complete reply.
 */
export declare function repairTruncatedJson(text: string): string | null;
/**
 * Extract the JSON contract from a model's raw output.
 *
 * beta.31: the lead planner (session 78237f43) failed with
 *   `[lead] JSON.parse failed: SyntaxError: Unexpected token '\', "\n{\n \"r\"..."`
 * The model wrapped its plan as a JSON-STRING-ENCODED payload (as if writing
 * it to a file): the ```json fence content was the escaped string
 * `\n{\n \"repo\": ...` rather than raw JSON. The old code grabbed the first
 * fence blindly and returned the escaped text, which JSON.parse rejects on
 * the leading `\`.
 *
 * New strategy: gather CANDIDATES (all fenced blocks + the first balanced
 * brace-scan of the whole text + a JSON-string-unescape of each candidate)
 * and return the FIRST candidate that actually parses. This tolerates:
 *   - raw JSON,
 *   - ```json fenced JSON,
 *   - double-encoded (JSON-string-escaped) JSON, incl. inside a fence,
 *   - JSON preceded/followed by prose.
 */
export declare function extractJson(text: string): string;
/**
 * beta.128: turn a `JSON.parse failed` error into a correction a model can act
 * on -- the parser's own complaint, the text either side of the fault, and the
 * rule that was broken.
 *
 * WHY THIS EXISTS. Session f75f7db6 (b127) died on a complete plan carrying
 * `"seq_note":undefined`. The retry it got said "you returned prose or an
 * incomplete object" -- describing neither the document nor the fault, about a
 * reply that was valid in every other respect. A model told what is wrong and
 * where can fix one token; a model told it wrote prose when it did not has no
 * move to make.
 *
 * Deliberately NOT a repair: we do not guess what `undefined` was meant to
 * hold. Only the model knows whether that field should be a value or absent.
 *
 * Returns undefined when the error is not a parse fault we can describe, so
 * callers fall back to their existing retry text.
 */
export declare function describeJsonSyntaxFault(err: unknown): string | undefined;
/**
 * beta.128: what one lead planning attempt did. Reported per attempt so the
 * audit trail records the attempts that were survived, not only the one that
 * ended the run. See `runLeadSdk.onAttempt`.
 */
export interface LeadAttemptInfo {
    attempt: number;
    /**
     * `truncated` means cut off at the output ceiling; `invalid_json` means a
     * COMPLETE document the parser rejected. Keeping them apart is the whole
     * point -- b126 conflated them and retried a cut-off reply with a plea to
     * stop writing prose.
     */
    outcome: "ok" | "truncated" | "invalid_json" | "error";
    costUsd: number;
    outputChars: number;
    /** Which retry rung produced this attempt. Absent on the first attempt. */
    rung?: "mechanical_size_reduction" | "contract_reassertion" | "syntax_repair";
    error?: string;
}
/** beta.128: which failure class an attempt landed in. See LeadAttemptInfo. */
export declare function classifyAttempt(err: unknown): LeadAttemptInfo["outcome"];
export interface JsonValidationOptions<T> {
    /** Required top-level keys on the parsed object. Missing keys throw. */
    requiredKeys: readonly (keyof T)[];
    /** Optional per-key type checker. Values that fail throw. */
    typeCheck?: (parsed: unknown) => parsed is T;
    /** Warn if the raw text after the JSON object contains more JSON. Default true. */
    warnOnTrailingJson?: boolean;
    /** Logger for the trailing-JSON warning. */
    logger?: {
        warn: (m: string, meta?: unknown) => void;
    };
    /** Context label for error messages (e.g. "lead planner"). */
    label?: string;
}
/**
 * Robust wrapper around `extractJson()`.
 *  - Extracts the first JSON object/array.
 *  - Parses it.
 *  - Verifies required top-level keys are present.
 *  - Optionally warns (not throws) when the raw response contains a
 *    second JSON object we're silently discarding.
 *  - Rethrows with the ORIGINAL raw text on any failure, so an operator
 *    can see exactly what the model returned.
 */
export declare function extractAndValidateJson<T>(rawText: string, opts: JsonValidationOptions<T>): T;
//# sourceMappingURL=json.d.ts.map