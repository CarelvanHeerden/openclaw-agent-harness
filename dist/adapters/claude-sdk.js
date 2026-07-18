/**
 * Adapters over `@anthropic-ai/claude-agent-sdk`.
 *
 * These wrap the SDK so callers get a stable, testable shape:
 *   - `runWorker()`: single-turn worker with canUseTool + tools.
 *   - `runReviewer()`: single-turn adversary with JSON-only output.
 *   - `runClassifier()`: single-turn intent classifier.
 *   - `runLead()`: single-turn planner returning a strict LeadPlan.
 *
 * All wrappers convert the streaming AsyncIterator into a single terminal
 * result and count usage. The SDK's `canUseTool` callback signature is a
 * function `(toolName, toolInput) => { behavior: "allow" | "deny", ... }`.
 * We adapt our internal `{ allow, reason }` shape to that.
 *
 * NOTE (2026-07-13): This module lazy-imports the SDK so tests can run
 * without the real SDK installed. Production code will error clearly if
 * the SDK is missing.
 */
/**
 * Build the `env` passed to the SDK subprocess.
 *
 * The embedded Claude Code binary reads ANTHROPIC_API_KEY from its process
 * environment. We inherit the parent env and, when the harness has resolved
 * an explicit key (vault or config env-var), set ANTHROPIC_API_KEY so the
 * subprocess never falls back to the interactive `/login` session store
 * (which does not exist in a headless container).
 *
 * Returns `undefined` when no explicit key is supplied, so the SDK keeps its
 * default behaviour (inherit parent env) for local dev where the developer
 * may already be logged in.
 */
export function buildSdkEnv(apiKey) {
    if (!apiKey)
        return undefined;
    const base = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string")
            base[k] = v;
    }
    base.ANTHROPIC_API_KEY = apiKey;
    return base;
}
let sdkCache;
async function loadSdk() {
    if (sdkCache)
        return sdkCache;
    try {
        sdkCache = await import("@anthropic-ai/claude-agent-sdk");
    }
    catch (err) {
        throw new Error(`@anthropic-ai/claude-agent-sdk is required at runtime but failed to load: ${String(err)}`);
    }
    return sdkCache;
}
export async function runWorkerSdk(params) {
    const sdk = await loadSdk();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), params.timeoutSeconds * 1000);
    let stopReason = "end_turn";
    let sdkSessionId = "";
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    const logLines = [];
    try {
        const stream = sdk.query({
            prompt: params.userMessage,
            options: {
                model: params.model,
                systemPrompt: params.systemPrompt,
                cwd: params.worktreePath,
                permissionMode: params.permissionMode,
                resume: params.resumeSessionId,
                env: buildSdkEnv(params.apiKey),
                canUseTool: async (toolName, toolInput) => {
                    const decision = await params.canUseTool(toolName, toolInput);
                    if (decision.allow)
                        return { behavior: "allow", updatedInput: toolInput };
                    return {
                        behavior: "deny",
                        message: decision.reason ?? "denied by harness guard",
                    };
                },
                abortSignal: abort.signal,
            },
        });
        for await (const message of stream) {
            logLines.push(JSON.stringify(message).slice(0, 300));
            if (message.type === "system" && message.subtype === "init") {
                sdkSessionId = message.session_id;
            }
            if (message.type === "result") {
                stopReason = message.subtype === "success" ? "end_turn" : "tool_error";
                costUsd = message.total_cost_usd ?? 0;
                tokensIn = message.usage?.input_tokens ?? 0;
                tokensOut = message.usage?.output_tokens ?? 0;
            }
        }
    }
    catch (err) {
        if (abort.signal.aborted)
            stopReason = "timeout";
        else
            stopReason = "tool_error";
        logLines.push(`ERROR: ${String(err)}`);
    }
    finally {
        clearTimeout(timer);
    }
    return {
        sdkSessionId,
        stopReason,
        costUsd,
        tokensIn,
        tokensOut,
        logsExcerpt: logLines.slice(-25).join("\n"),
    };
}
// ---- Structured-output helpers (classifier, crystalliser, lead, adversary) ----
async function structuredCall(params) {
    const sdk = await loadSdk();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), params.timeoutSeconds * 1000);
    let sdkSessionId = "";
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    const textChunks = [];
    // Informational: emit a periodic tick so operators can tell a long SDK
    // phase (e.g. a 9-minute plan) is progressing vs stuck. Uses the running
    // token counts as a liveness proxy. No-op when no logger is supplied.
    const startedAt = Date.now();
    let ticks = 0;
    const tickLabel = params.validation?.label ?? "sdk";
    const tickTimer = params.logger
        ? setInterval(() => {
            ticks += 1;
            params.logger?.warn?.(`[${tickLabel}] tick +${ticks * 30}s`, { elapsedMs: Date.now() - startedAt, tokensIn, tokensOut, textChunks: textChunks.length });
        }, 30_000)
        : undefined;
    if (tickTimer && typeof tickTimer.unref === "function") {
        tickTimer.unref();
    }
    try {
        const stream = sdk.query({
            prompt: params.userMessage,
            options: {
                model: params.model,
                systemPrompt: params.systemPrompt,
                // beta.27: these are SINGLE-SHOT structured JSON extractors
                // (classifier / crystalliser / lead / adversary), NOT agents.
                // `permissionMode: "plan"` alone still leaves read-only exploration
                // tools enabled, and the SDK's Claude Code agent will happily go
                // "help the user" mode -- exploring the local filesystem
                // (e.g. /app/extensions) and narrating a prose plan instead of
                // emitting the JSON contract. That produced
                // `[classifier] extractJson failed: no JSON in output: "I'll help you fix the ..."`
                // on the first ProjectThanos smoke. Force NO tools so the model must
                // answer directly. `allowedTools: []` disables tool_use entirely;
                // `permissionMode: "plan"` stays as belt-and-braces.
                allowedTools: [],
                permissionMode: "plan",
                env: buildSdkEnv(params.apiKey),
                abortSignal: abort.signal,
            },
        });
        for await (const message of stream) {
            if (message.type === "system" && message.subtype === "init") {
                sdkSessionId = message.session_id;
            }
            if (message.type === "assistant" && Array.isArray(message.message?.content)) {
                for (const c of message.message.content) {
                    if (c.type === "text")
                        textChunks.push(c.text);
                }
            }
            if (message.type === "result") {
                costUsd = message.total_cost_usd ?? 0;
                tokensIn = message.usage?.input_tokens ?? 0;
                tokensOut = message.usage?.output_tokens ?? 0;
            }
        }
    }
    finally {
        clearTimeout(timer);
        if (tickTimer)
            clearInterval(tickTimer);
    }
    const raw = textChunks.join("");
    let parsed;
    if (params.validation) {
        parsed = extractAndValidateJson(raw, { ...params.validation, logger: params.logger ?? params.validation.logger });
    }
    else {
        const json = extractJson(raw);
        parsed = JSON.parse(json);
    }
    return { parsed, sdkSessionId, costUsd, tokensIn, tokensOut, raw };
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
export function extractJson(text) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1])
        return fence[1].trim();
    const start = text.search(/[{[]/);
    if (start === -1) {
        throw new Error(`no JSON in output (model returned prose, not the JSON contract — ` +
            `check that structured calls run with allowedTools: []): ${text.slice(0, 200)}`);
    }
    const opening = text[start];
    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (esc) {
            esc = false;
            continue;
        }
        if (ch === "\\") {
            esc = true;
            continue;
        }
        if (ch === '"') {
            inStr = !inStr;
            continue;
        }
        if (inStr)
            continue;
        if (ch === opening)
            depth++;
        else if (ch === closing) {
            depth--;
            if (depth === 0)
                return text.slice(start, i + 1);
        }
    }
    throw new Error("unbalanced JSON in output");
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
export function extractAndValidateJson(rawText, opts) {
    const label = opts.label ?? "model output";
    let extracted;
    try {
        extracted = extractJson(rawText);
    }
    catch (err) {
        throw new Error(`[${label}] extractJson failed: ${String(err)}\n--- raw ---\n${rawText.slice(0, 4000)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(extracted);
    }
    catch (err) {
        throw new Error(`[${label}] JSON.parse failed: ${String(err)}\n--- extracted ---\n${extracted.slice(0, 2000)}\n--- raw ---\n${rawText.slice(0, 4000)}`);
    }
    if (!parsed || typeof parsed !== "object") {
        throw new Error(`[${label}] JSON parsed to non-object: ${typeof parsed}\n--- extracted ---\n${extracted.slice(0, 2000)}`);
    }
    const rec = parsed;
    const missing = [];
    for (const key of opts.requiredKeys) {
        if (!(String(key) in rec))
            missing.push(String(key));
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
    return parsed;
}
export async function runClassifierSdk(params) {
    const systemPrompt = [
        "You classify a single Slack message from a developer channel.",
        "Return STRICT JSON: { intent: 'dev_task' | 'clarify' | 'not_dev' | 'unsafe', reason: string, suggestedClarification?: string }",
        "- dev_task: the user wants code written, refactored, tested, or a config changed. Include ambiguous but clearly technical asks here.",
        "- clarify: the ask is dev-shaped but missing the ONE thing you'd need to act (which repo, which branch, what file).",
        "- not_dev: chat, thanks, jokes, non-technical questions. No action needed.",
        "- unsafe: asks that would exfiltrate secrets, delete data, disable safeguards, or violate policy.",
        "Output the JSON and nothing else.",
    ].join("\n");
    const r = await structuredCall({
        model: params.model,
        systemPrompt,
        userMessage: params.userText,
        timeoutSeconds: params.timeoutSeconds,
        apiKey: params.apiKey,
        validation: { requiredKeys: ["intent", "reason"], label: "classifier" },
    });
    return { ...r.parsed, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}
export async function runCrystalliserSdk(params) {
    const conceptBlock = formatConceptBlockForCrystalliser(params.concepts);
    const systemPrompt = [
        "You are a senior engineer refining a rough dev request into a well-scoped brief.",
        "Return STRICT JSON matching CrystallisedBrief:",
        "  { title: string, motivation: string, acceptanceCriteria: string[],",
        "    filesLikelyTouched: string[], outOfScope: string[],",
        "    repoHint?: string, branchHint?: string, riskLevel: 'low'|'medium'|'high',",
        "    relevantConcepts?: OkfConceptRef[] }",
        "OkfConceptRef: { id: string, path?: string, summary?: string, tags?: string[] }",
        "Rules:",
        "- title: concise imperative sentence",
        "- motivation: 1-3 sentences",
        "- acceptanceCriteria: observable, testable outcomes (min 1)",
        "- riskLevel: high if touches auth/secrets/payment code or db schema; medium if user-facing behavior changes; low otherwise.",
        // beta.21: OKF concept awareness.
        "- relevantConcepts: pass-through of any RELEVANT KNOWLEDGE concepts the caller supplied (see block below). Do NOT invent new concept ids. When a supplied concept has a `path`, prefer adding that path to `filesLikelyTouched` unless the request explicitly excludes it. When a supplied concept has `tags` unrelated to the request's domain, consider adding a matching directory or subsystem to `outOfScope` so the lead planner doesn't wander.",
        "- If NO concepts are supplied, omit the `relevantConcepts` field entirely.",
        conceptBlock,
        "Output the JSON and nothing else.",
    ]
        .filter((line) => line.length > 0)
        .join("\n");
    const r = await structuredCall({
        model: params.model,
        systemPrompt,
        userMessage: params.userText,
        timeoutSeconds: params.timeoutSeconds,
        apiKey: params.apiKey,
        validation: { requiredKeys: ["title", "motivation", "acceptanceCriteria", "riskLevel"], label: "crystalliser" },
    });
    return { ...r.parsed, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}
/**
 * beta.21: render supplied OKF concepts into a block the crystalliser can
 * reference. Keeps summaries short and omits `content` (large; that's for
 * the worker, not the crystalliser). Returns empty string when no concepts
 * are supplied, so the .filter() at the callsite drops the block cleanly.
 */
export function formatConceptBlockForCrystalliser(concepts) {
    if (!concepts || concepts.length === 0)
        return "";
    const rows = concepts.map((c) => {
        const parts = [`- id: ${c.id}`];
        if (c.summary)
            parts.push(`  summary: ${c.summary}`);
        if (c.path)
            parts.push(`  path: ${c.path}`);
        if (c.tags && c.tags.length > 0)
            parts.push(`  tags: [${c.tags.join(", ")}]`);
        return parts.join("\n");
    });
    return [
        "",
        "RELEVANT KNOWLEDGE (OKF concepts supplied by the caller; DO NOT invent new ids):",
        ...rows,
        "",
    ].join("\n");
}
export async function runLeadSdk(params) {
    const systemPrompt = [
        "You are the lead planner. Decompose a brief into ATOMIC sub-tasks a Sonnet worker can complete in one turn.",
        "Return STRICT JSON:",
        "  { repo: string (owner/repo, must be in reposAllowed),",
        "    branch: string (must start with 'harness/'; NOTE: the harness namespaces all branches under 'harness/' and may rewrite/slugify your hint, so the final branch name is authoritative from the plan, not this field),",
        "    subTasks: SubTask[],",
        "    reviewChecklist: string[],",
        "    riskLevel: 'low'|'medium'|'high' }",
        "SubTask: { seq: number, title: string, intent: string, filesLikelyTouched: string[], successCriteria: string[], estimatedTokens: number, dependsOn?: number[], contractScope?: 'local'|'remote'|'mixed', taskMode?: 'observe'|'mutate'|'mixed' }",
        "Rules:",
        "- Prefer 3-8 sub-tasks. Hard cap 20.",
        "- Each sub-task must be independently reviewable.",
        "- reviewChecklist has one item per acceptance criterion + one for tests + one for docs.",
        // beta.14: authoritative scope axis (local vs remote).
        "- contractScope tells the harness verifier which side-effects to check:",
        "    'local'  = sub-task only touches worktree fs + git (write file, commit, verify local state). NO push. NO PR. NO remote lookup. Use this for ALL observation-only / read-only / write-only / commit-only sub-tasks.",
        "    'remote' = sub-task pushes to origin, opens a PR, verifies remote SHA, or otherwise interacts with the provider (GitHub/GitLab).",
        "    'mixed'  = both local AND remote in the same sub-task. Rare; prefer decomposition when possible.",
        "- If a sub-task says 'Do not push' / 'Do not open a PR' / 'observation only' / 'read-only', it MUST have contractScope: 'local'.",
        "- If a sub-task says 'push branch' / 'open PR' / 'verify remote SHA', it MUST have contractScope: 'remote'.",
        // beta.15: authoritative mode axis (observe vs mutate).
        "- taskMode tells the harness verifier whether the sub-task PRODUCES artifacts or just checks them:",
        "    'observe' = sub-task is read-only. It does NOT write files, make commits, push, or open PRs. Use for pure verification / assertion / inspection sub-tasks.",
        "    'mutate'  = sub-task produces new artifacts (writes a file, commits, pushes, opens a PR).",
        "    'mixed'   = both. Rare; prefer decomposition.",
        "- If a sub-task is a final 'verify everything is correct' or 'confirm no side effects' step, it MUST have taskMode: 'observe'. Its verify contract should be pure state-check kinds (or empty).",
        "- If a sub-task writes a file, makes a commit, pushes, or opens a PR, it MUST have taskMode: 'mutate'.",
        "- The two axes compose: `contractScope=local, taskMode=observe` = purest local read-only check. `contractScope=remote, taskMode=mutate` = push+PR. Etc.",
        // beta.15: encourage explicit verify:[] on observation sub-tasks.
        "- Pure-observation sub-tasks that do NOT need any observable-side-effect check may emit `verify: []` explicitly. This is meaningful: it says 'trust the SDK signal, nothing observable to verify'. It's cleaner than relying on inference-then-filter.",
        "- When in doubt on scope: prefer 'local' + 'observe'. Missing fields = harness falls back to regex inference which is less reliable.",
        // beta.15: reinforce final-verification pattern.
        "- A common plan shape: (1) mutation steps with taskMode='mutate', (2) final observation step with taskMode='observe' and verify:[] to confirm the mutation steps completed correctly. The observation step is optional but useful for reviewer clarity.",
        // beta.21: OKF concept awareness on the lead side.
        "- The brief MAY include `relevantConcepts` (OKF concept refs supplied by the caller). Each has `id`, and optionally `path`, `summary`, `tags`. When present:",
        "    * If a concept has a `path`, prefer that path in the affected sub-task's `filesLikelyTouched` unless the brief explicitly excludes it. Cheap way to anchor the plan on the right subsystem.",
        "    * If a concept has `tags` whose subsystem is unrelated to the request, DO NOT plan sub-tasks that touch that subsystem — treat it as an implicit out-of-scope hint. Example: request is about the retry service, one concept is `infrastructure/nginx` with tags [infrastructure] — do not touch nginx configs.",
        "    * If NO relevantConcepts are provided, plan as usual. Do NOT invent concepts or reference ids that were not supplied.",
        // beta.19: atomicity guidance. Staging's beta.17 smoke #2 exposed a
        // pathology where the lead split "append line X to docs/Y.md, committing
        // the change locally" into two mutate sub-tasks (write, then commit).
        // s2's verify contract [commit_made, file_committed, file_written]
        // compared against s2's own worker-session-start SHA, but the write
        // happened in s1 -> s2's HEAD was unchanged from its base -> verify
        // correctly failed. Correct behaviour given the plan, wrong plan.
        "- ATOMICITY RULE: a WRITE action and its accompanying COMMIT belong in ONE mutate sub-task, not two. If a single sentence or acceptance criterion contains both a write clause and a commit clause (e.g. 'append line X to file Y and commit locally', 'add function Z and commit', 'update docs and commit'), it is ONE atomic sub-task. Split only when the write and commit are genuinely separate acts of work (e.g. write in cycle 1, refactor in cycle 2, then commit both).",
        "- Corollary: if you split a write from its commit into two sub-tasks, the commit sub-task's verify contract will compare HEAD vs its OWN worker-session-start SHA. If the write already happened in the prior sub-task, the commit sub-task's worker sees the file already present, has nothing new to do, exits with end_turn, and verification (correctly) fails. This is the harness's atomic-work contract with you, not a bug. Avoid it by keeping write+commit together.",
        "- Anti-pattern to AVOID: 3 sub-tasks (write, commit, verify) for a single write-and-commit criterion. Correct shape: 1 mutate sub-task (write+commit) + optional 1 observe sub-task (verify). If you find yourself planning 3+ sub-tasks for what a single sentence describes, you are over-decomposing.",
        "- Push-and-PR similarly: 'push branch and open a PR' is ONE mutate sub-task with contractScope='remote', not two.",
        `- reposAllowed: ${JSON.stringify(params.reposAllowed)}`,
        "Output the JSON and nothing else.",
    ].join("\n");
    const r = await structuredCall({
        model: params.model,
        systemPrompt,
        userMessage: JSON.stringify(params.brief),
        timeoutSeconds: params.timeoutSeconds,
        apiKey: params.apiKey,
        logger: params.logger,
        validation: { requiredKeys: ["repo", "branch", "subTasks", "reviewChecklist", "riskLevel"], label: "lead" },
    });
    return { ...r.parsed, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
}
/**
 * Adversary SDK call.
 *
 * Large diffs are chunked instead of silently truncated (prior behaviour was
 * a hard `.slice(0, 200_000)` which caused the tail of any big refactor to be
 * reviewed by no one). Strategy:
 *   1. If diff fits in DIFF_SINGLE_CHUNK_BYTES, one call, done.
 *   2. Otherwise, split on file boundaries (`diff --git a/... b/...`) and
 *      review chunks in sequence, feeding the running findings back into the
 *      next chunk's system prompt so the adversary has context.
 *   3. Merge all findings; verdict is the strictest across chunks
 *      (block > revise > pass).
 *   4. If a single file boundary exceeds one chunk (huge single file),
 *      truncate that file to CHUNK_MAX_BYTES and annotate the summary
 *      that the file was partially reviewed (this is rare in practice).
 *
 * Adversary is told explicitly when chunking is in effect so its findings
 * can note incomplete coverage rather than silently missing it.
 */
const DIFF_SINGLE_CHUNK_BYTES = 180_000;
const CHUNK_MAX_BYTES = 180_000;
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
function mergeVerdict(a, b) {
    const order = { pass: 0, revise: 1, block: 2 };
    return order[a] >= order[b] ? a : b;
}
export async function runAdversarySdk(params) {
    const diffBytes = params.diffText.length;
    // Fast path: single call.
    if (diffBytes <= DIFF_SINGLE_CHUNK_BYTES) {
        const r = await structuredCall({
            model: params.model,
            systemPrompt: params.systemPrompt,
            userMessage: `Here is the diff to review:\n\n${params.diffText}`,
            timeoutSeconds: params.timeoutSeconds,
            apiKey: params.apiKey,
            validation: { requiredKeys: ["verdict", "findings", "summary"], label: "adversary" },
        });
        return { parsed: r.parsed, sdkSessionId: r.sdkSessionId, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
    }
    // Slow path: chunked.
    const chunks = splitDiffOnFileBoundaries(params.diffText);
    let verdict = "pass";
    const findings = [];
    const summaries = [];
    let sdkSessionId = "";
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (let i = 0; i < chunks.length; i++) {
        const chunkPrompt = params.systemPrompt +
            `\n\nNOTE: this diff was too large to review in one pass. This is CHUNK ${i + 1} OF ${chunks.length} (${diffBytes} bytes total). Findings from prior chunks are attached below; include chunk-level context in your response. Verdict is aggregated across all chunks.`;
        const chunkUserMsg = i === 0
            ? `Here is CHUNK ${i + 1}/${chunks.length} of the diff:\n\n${chunks[i]}`
            : `Prior chunks produced these findings so far:\n\n${JSON.stringify(findings, null, 2).slice(0, 8000)}\n\nHere is CHUNK ${i + 1}/${chunks.length}:\n\n${chunks[i]}`;
        const r = await structuredCall({
            model: params.model,
            systemPrompt: chunkPrompt,
            userMessage: chunkUserMsg,
            timeoutSeconds: params.timeoutSeconds,
            apiKey: params.apiKey,
            validation: { requiredKeys: ["verdict", "findings", "summary"], label: `adversary-chunk-${i + 1}/${chunks.length}` },
        });
        verdict = mergeVerdict(verdict, r.parsed.verdict);
        findings.push(...(Array.isArray(r.parsed.findings) ? r.parsed.findings : []));
        summaries.push(`Chunk ${i + 1}/${chunks.length}: ${r.parsed.summary}`);
        if (!sdkSessionId)
            sdkSessionId = r.sdkSessionId;
        costUsd += r.costUsd;
        tokensIn += r.tokensIn;
        tokensOut += r.tokensOut;
    }
    return {
        parsed: {
            verdict,
            findings,
            summary: `Reviewed in ${chunks.length} chunks (${diffBytes} bytes total). Aggregated verdict: ${verdict}.\n\n${summaries.join("\n\n")}`,
        },
        sdkSessionId,
        costUsd,
        tokensIn,
        tokensOut,
        chunkedReview: { chunkCount: chunks.length, totalBytes: diffBytes },
    };
}
/**
 * Cost estimation table (USD per M tokens).
 *
 * Update policy: these prices WILL drift. `estimateSubTaskCost()` is used
 * only for BUDGET PROJECTIONS in the loop; the authoritative source of
 * truth is the `total_cost_usd` returned by the SDK on each call, which we
 * accumulate in the state store.
 *
 * `checkPriceDrift()` runs whenever we get a real SDK cost back and compares
 * it against our estimate. Drift > 20% logs a warning so we can update the
 * table. Pricing is also configurable at plugin config time via
 * `harness.models.price_overrides` (see config.ts), so operators can patch
 * without waiting for a release.
 */
export const PRICES = {
    "claude-fable-5": { input: 10, output: 50 },
    "claude-sonnet-5": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 1, output: 5 },
};
export function estimateSubTaskCost(model, tokens, overrides) {
    const table = { ...PRICES, ...(overrides ?? {}) };
    const p = table[model] ?? table["claude-sonnet-5"];
    // Rough 20/80 in/out split for planning purposes
    return (tokens * 0.2 * p.input + tokens * 0.8 * p.output) / 1_000_000;
}
/**
 * Called after a real SDK call. Returns { drift, warn } where warn=true when
 * the actual cost deviates > 20% from our estimate for that model+tokens.
 * Callers should log the warning (with model + actual + estimate) so we
 * catch stale price tables in one run instead of over billing cycles.
 */
export function checkPriceDrift(model, actualCostUsd, tokensIn, tokensOut, overrides) {
    const table = { ...PRICES, ...(overrides ?? {}) };
    const p = table[model];
    if (!p)
        return { drift: 0, warn: false, estimated: 0 };
    const estimated = (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
    if (estimated <= 0 || actualCostUsd <= 0)
        return { drift: 0, warn: false, estimated };
    const drift = Math.abs(actualCostUsd - estimated) / estimated;
    return { drift, warn: drift > 0.2, estimated };
}
//# sourceMappingURL=claude-sdk.js.map