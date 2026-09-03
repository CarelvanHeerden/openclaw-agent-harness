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
 * Extracts the first well-formed top-level JSON object or array from a
 * string. Handles the common case where the model wraps output in prose
 * or a fenced code block despite instructions.
 *
 * WARNING: prefer `extractAndValidateJson()` over calling this directly.
 * If the model outputs `{"foo":1}\n{"bar":2}` we return only the first object;
 * without validation you can silently miss the second half of the response.
 */
/**
 * Scan for the first balanced {...} or [...] object starting at `from`,
 * respecting string literals and escapes. Returns the substring or null.
 */
function scanBalanced(text: string, from = 0): string | null {
  const start = text.slice(from).search(/[{[]/);
  if (start === -1) return null;
  const abs = from + start;
  const opening = text[abs]!;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = abs; i < text.length; i++) {
    const ch = text[i]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === opening) depth++;
    else if (ch === closing) {
      depth--;
      if (depth === 0) return text.slice(abs, i + 1);
    }
  }
  return null;
}

function parsesAsJson(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
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
export function looksTruncatedJson(text: string): boolean {
  if (!text) return false;
  if (!/[{[]/.test(text)) return false;   // no container was ever opened: prose
  return scanBalanced(text) === null;      // opened and never closed: cut off
}

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
export function repairTruncatedJson(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  // The cut point is chosen so the PARTIAL trailing element is dropped whole.
  // Preferring the last CLOSED container does that: on a plan cut mid-way
  // through sub-task 5, we rewind to the `}` that closed sub-task 4 and keep
  // 1..4 intact. Cutting at the last comma instead would keep a half-built
  // `{"seq":5}` that then fails plan validation for a confusing reason.
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let lastCloseEnd = -1;   // index AFTER the last `}`/`]` that closed a container
  let lastCloseDepth = 0;  // container depth remaining after that close
  let lastCommaAt = -1;    // fallback for documents where nothing ever closed
  let lastCommaDepth = 0;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") { stack.push(ch === "{" ? "}" : "]"); continue; }
    if (ch === "}" || ch === "]") {
      if (stack.length === 0) break;
      stack.pop();
      if (stack.length === 0) return text.slice(start, i + 1); // never truncated
      lastCloseEnd = i + 1;
      lastCloseDepth = stack.length;
      continue;
    }
    if (ch === ",") { lastCommaAt = i; lastCommaDepth = stack.length; continue; }
  }

  const cutEnd = lastCloseEnd > 0 ? lastCloseEnd : lastCommaAt;
  const cutDepth = lastCloseEnd > 0 ? lastCloseDepth : lastCommaDepth;
  if (cutEnd <= start || cutDepth <= 0) return null;

  // Re-walk to the cut point to recover the exact set of open containers.
  const closers: string[] = [];
  let s2 = false;
  let e2 = false;
  for (let i = start; i < cutEnd; i++) {
    const ch = text[i]!;
    if (e2) { e2 = false; continue; }
    if (ch === "\\") { e2 = true; continue; }
    if (ch === '"') { s2 = !s2; continue; }
    if (s2) continue;
    if (ch === "{") closers.push("}");
    else if (ch === "[") closers.push("]");
    else if (ch === "}" || ch === "]") closers.pop();
  }
  if (closers.length === 0) return null;

  const body = text.slice(start, cutEnd).replace(/[,\s]+$/, "");
  const repaired = body + closers.reverse().join("");
  return parsesAsJson(repaired) ? repaired : null;
}

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
export function extractJson(text: string): string {
  const candidates: string[] = [];

  // 1. All fenced blocks (```json ... ``` or ``` ... ```), in order.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m[1]) candidates.push(m[1].trim());
  }

  // 2. First balanced object in the raw text (prose-wrapped JSON).
  const balanced = scanBalanced(text);
  if (balanced) candidates.push(balanced);

  // 3. For each candidate, also try a JSON-string-unescape pass. If a
  //    candidate is escaped text like `\n{\n \"repo\"...`, wrapping it in
  //    quotes and JSON.parse-ing yields the real JSON string, which we then
  //    re-scan for a balanced object. This handles the double-encoded case.
  const unescaped: string[] = [];
  for (const c of candidates) {
    if (!(c.includes('\\"') || c.includes("\\n"))) continue;
    // The candidate is (likely) the escaped BODY of a JSON string, e.g.
    // `\n{\n \"repo\"...`. Its embedded quotes are already backslash-escaped,
    // so wrap in quotes and parse directly. Only if that fails do we try
    // escaping bare quotes (for a half-escaped candidate).
    let decoded: string | null = null;
    try {
      decoded = JSON.parse(`"${c}"`) as string;
    } catch {
      try {
        decoded = JSON.parse(`"${c.replace(/(?<!\\)"/g, '\\"')}"`) as string;
      } catch {
        decoded = null;
      }
    }
    if (decoded) {
      const inner = scanBalanced(decoded) ?? decoded;
      unescaped.push(inner);
    }
  }
  candidates.push(...unescaped);

  // Return the first candidate that actually parses.
  for (const c of candidates) {
    if (parsesAsJson(c)) return c;
  }
  // Fall back to the first candidate at all (preserves prior behaviour of
  // returning *something* so the caller's JSON.parse produces the real
  // diagnostic), or throw the prose error if we found nothing JSON-shaped.
  if (candidates.length > 0) return candidates[0]!;
  // beta.126: tell the two failures apart before naming a cause.
  //
  // There was one message here, and it said the model returned prose and to
  // check `tools: []`. On the b125 planning failure the reply began
  // `{"repo":"Stitch-Vercel/ProjectThanos","branch":...` -- unmistakably the
  // contract, cut off mid-write -- and the error still called it prose and
  // pointed at built-in tools. An operator following that advice is debugging
  // a subsystem that is working. Confidently wrong is worse than silent.
  if (looksTruncatedJson(text)) {
    throw new Error(
      `truncated JSON in output (the reply opened a JSON container and never closed it — ` +
        `it was cut off, most likely at an output-token ceiling; this is NOT prose drift): ` +
        `${text.length} chars, ending "...${text.slice(-120)}"`,
    );
  }
  throw new Error(
    `no JSON in output (model returned prose, not the JSON contract — ` +
      `check that structured calls run with tools: [] to disable built-in tools): ${text.slice(0, 200)}`,
  );
}

/**
 * beta.128: the JS literals a language model reaches for when it is thinking in
 * JavaScript instead of JSON. None of them are JSON values, so any one of them
 * fails the whole document.
 */
const NON_JSON_LITERALS = ["undefined", "NaN", "Infinity"] as const;

/**
 * beta.128: find the first non-JSON literal that sits OUTSIDE a string.
 *
 * String-aware on purpose: a plan whose prose legitimately says `the value is
 * undefined` must not be reported as the fault. Only a bare token in value
 * position breaks the parse.
 */
function findNonJsonLiteral(text: string): { index: number; token: string } | undefined {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    for (const token of NON_JSON_LITERALS) {
      if (ch === token[0] && text.startsWith(token, i)) return { index: i, token };
    }
  }
  return undefined;
}

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
export function describeJsonSyntaxFault(err: unknown): string | undefined {
  const e = err as StructuredCallError | undefined;
  if (!e) return undefined;
  const message = String(e.message ?? "");
  if (!/JSON\.parse failed/i.test(message)) return undefined;
  // Prefer the document carried on the error; fall back to the copy embedded in
  // the message for errors that crossed a boundary which dropped the property.
  const embedded = /--- extracted ---\n([\s\S]*?)\n--- raw ---/.exec(message);
  const text = e.extractedText ?? embedded?.[1];
  if (!text) return undefined;

  // The parser reports a position on some runtimes and not others, so treat it
  // as a hint and fall back to locating the offending literal ourselves.
  const positionMatch = /at position (\d+)/.exec(message);
  const located = findNonJsonLiteral(text);
  const index = positionMatch ? Number(positionMatch[1]) : located?.index;
  const reason = /(SyntaxError: [^\n]*)/.exec(message)?.[1] ?? "the document is not valid JSON";

  const lines = [`The JSON parser rejected it with: ${reason}`];
  if (index !== undefined && index >= 0 && index < text.length) {
    const from = Math.max(0, index - 180);
    const to = Math.min(text.length, index + 180);
    const window = `${text.slice(from, index)}>>>HERE>>>${text.slice(index, to)}`;
    lines.push(`Here is the text around the fault, with >>>HERE>>> marking the position:`, window);
  }
  if (located) {
    lines.push(
      `The token \`${located.token}\` is a JavaScript literal, not a JSON value. JSON has no ` +
        `\`undefined\`, \`NaN\` or \`Infinity\`, and permits no trailing commas.`,
      `If a field has no value, OMIT the key entirely or write null. Never emit the bare token \`${located.token}\`.`,
    );
  }
  return lines.join("\n");
}

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
export function classifyAttempt(err: unknown): LeadAttemptInfo["outcome"] {
  const e = err as StructuredCallError | undefined;
  if (e?.truncated === true) return "truncated";
  if (/JSON\.parse failed/i.test(String(e?.message ?? ""))) return "invalid_json";
  return "error";
}

export interface JsonValidationOptions<T> {
  /** Required top-level keys on the parsed object. Missing keys throw. */
  requiredKeys: readonly (keyof T)[];
  /** Optional per-key type checker. Values that fail throw. */
  typeCheck?: (parsed: unknown) => parsed is T;
  /** Warn if the raw text after the JSON object contains more JSON. Default true. */
  warnOnTrailingJson?: boolean;
  /** Logger for the trailing-JSON warning. */
  logger?: { warn: (m: string, meta?: unknown) => void };
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
export function extractAndValidateJson<T>(rawText: string, opts: JsonValidationOptions<T>): T {
  const label = opts.label ?? "model output";
  let extracted: string;
  try {
    extracted = extractJson(rawText);
  } catch (err) {
    throw new Error(`[${label}] extractJson failed: ${String(err)}\n--- raw ---\n${rawText.slice(0, 4000)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (err) {
    // beta.128: keep the extracted document ON the error. The b127 planning
    // failure was a complete, balanced, 24k-char plan containing one invalid
    // token (`"seq_note":undefined`). Everything needed to ask the model to
    // fix that one token was in this function and thrown away here.
    const parseErr = new Error(
      `[${label}] JSON.parse failed: ${String(err)}\n--- extracted ---\n${extracted.slice(0, 2000)}\n--- raw ---\n${rawText.slice(0, 4000)}`,
    ) as StructuredCallError;
    parseErr.extractedText = extracted;
    throw parseErr;
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[${label}] JSON parsed to non-object: ${typeof parsed}\n--- extracted ---\n${extracted.slice(0, 2000)}`);
  }
  const rec = parsed as Record<string, unknown>;
  const missing: string[] = [];
  for (const key of opts.requiredKeys) {
    if (!(String(key) in rec)) missing.push(String(key));
  }
  if (missing.length > 0) {
    throw new Error(`[${label}] JSON missing required keys: ${missing.join(", ")}\n--- extracted ---\n${extracted.slice(0, 2000)}\n--- raw ---\n${rawText.slice(0, 4000)}`);
  }
  if (opts.typeCheck && !opts.typeCheck(parsed)) {
    throw new Error(`[${label}] JSON failed typeCheck\n--- extracted ---\n${extracted.slice(0, 2000)}`);
  }
  // Trailing-JSON detection: if there's another `{`/`[` after the first object
  // ends, we would have silently ignored it. Warn so operators can see it.
  const warnOnTrailing = opts.warnOnTrailingJson !== false;
  if (warnOnTrailing && opts.logger) {
    const idx = rawText.indexOf(extracted);
    if (idx >= 0) {
      const tail = rawText.slice(idx + extracted.length);
      const nextBracket = tail.search(/[{[]/);
      if (nextBracket !== -1 && tail.slice(nextBracket, nextBracket + 200).match(/^[{[][\s\S]{4,}/)) {
        opts.logger.warn(`[${label}] model output contained a second JSON object we ignored`, {
          tailPreview: tail.slice(nextBracket, nextBracket + 200),
          extractedLen: extracted.length,
          rawLen: rawText.length,
        });
      }
    }
  }
  return parsed as T;
}
