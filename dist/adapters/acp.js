/**
 * ACP worker backend.
 *
 * Speaks the Agent Client Protocol over stdio to an external dev harness
 * (OpenCode, Codex, Claude Code, ...) and presents the result through the same
 * `WorkerDeps.runWorkerModel` contract the Claude Code SDK path already
 * satisfies. Nothing in the orchestrator, verifier, adversary or budget layer
 * changes; only which function is injected at the seam.
 *
 * We speak ACP directly rather than going through OpenClaw's acpx bridge
 * ("Option B"). The bridge is documented as surfacing usage as approximate and
 * carrying no cost data, and it abstracts away both the permission
 * request/response pair and the per-agent rawInput shapes -- all three of which
 * we need. See docs/acp-capability-matrix.md for the measurements behind this.
 *
 * Transport is newline-delimited JSON-RPC 2.0, per the ACP stdio binding.
 *
 * KNOWN LIMITS, measured rather than assumed:
 *   - Usage arrives in TWO places and they carry different things. The
 *     `usage_update` notification carries context occupancy (`used`, `size`)
 *     and a cumulative `cost`; the `session/prompt` RESULT carries the token
 *     split. An earlier revision of this file read only the notification and
 *     concluded ACP had no token split at all — see `recordPromptUsage`.
 *   - `cost` is cumulative per session and optional. We delta it across the
 *     turn; agents that report neither cost nor tokens yield usageSource
 *     "unavailable", which the ledger must not read as zero spend.
 *   - Permission enforcement depends on the BACKEND's own config. An agent not
 *     configured to ask never sends session/request_permission and the guard
 *     never runs. `preflightAcpBackend()` exists to make that a startup failure
 *     rather than a silent hole.
 */
import { spawn } from "node:child_process";
import { redactSecrets } from "./git-worktree.js";
import { buildAgentEnv } from "./shared/env.js";
import { runStructuredLadder } from "./shared/structured.js";
/**
 * `max_turn_requests` and `refusal` have no harness equivalent. Both mean the
 * turn ended without finishing the work, which is what `tool_error` signals to
 * the retry logic. The raw reason is preserved in logsExcerpt for the audit.
 */
const STOP_REASON_MAP = {
    end_turn: "end_turn",
    max_tokens: "max_tokens",
    cancelled: "canceled",
    refusal: "tool_error",
    max_turn_requests: "tool_error",
};
const LOG_EXCERPT_MAX = 20_000;
/** Minimal ndjson JSON-RPC 2.0 peer over a child process's stdio. */
class AcpConnection {
    child;
    onRequest;
    onNotify;
    nextId = 1;
    pending = new Map();
    buf = "";
    closed = false;
    constructor(child, onRequest, onNotify) {
        this.child = child;
        this.onRequest = onRequest;
        this.onNotify = onNotify;
        child.stdout.on("data", (c) => this.ingest(c.toString()));
        // v2.0.0: a spawn failure -- a mistyped command, a binary that is not
        // installed -- arrives as an asynchronous `error` event, NOT as a throw
        // from `spawn()`. Unhandled, it is an uncaught exception that takes the
        // whole harness process down rather than failing one turn. The M6 probe
        // found this by trying to launch a binary that does not exist, which is
        // exactly what a misconfigured `worker_backend` looks like in production.
        child.on("error", (err) => {
            this.closed = true;
            this.spawnError = err;
            const wrapped = new Error(`acp agent could not be started: ${err.message}`);
            for (const [, p] of this.pending)
                p.reject(wrapped);
            this.pending.clear();
        });
        child.stdin.on("error", () => {
            // The child died between our checking and our writing. `exit`/`error`
            // above own the rejection; this only stops an EPIPE from escaping.
        });
        child.on("exit", (code, signal) => {
            this.closed = true;
            const err = this.spawnError
                ? new Error(`acp agent could not be started: ${this.spawnError.message}`)
                : new Error(`acp agent exited (code=${code} signal=${signal})`);
            for (const [, p] of this.pending)
                p.reject(err);
            this.pending.clear();
        });
    }
    spawnError;
    ingest(chunk) {
        this.buf += chunk;
        let nl;
        while ((nl = this.buf.indexOf("\n")) !== -1) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                continue; // non-JSON noise on stdout is not fatal
            }
            void this.dispatch(msg);
        }
    }
    async dispatch(msg) {
        const id = msg["id"];
        // Response to something we sent.
        if (id !== undefined && (("result" in msg) || ("error" in msg))) {
            const p = this.pending.get(id);
            if (!p)
                return;
            this.pending.delete(id);
            if ("error" in msg) {
                const e = msg["error"];
                p.reject(new Error(e?.message ?? "acp rpc error"));
            }
            else {
                p.resolve(msg["result"]);
            }
            return;
        }
        const method = msg["method"];
        if (!method)
            return;
        // Request from the agent: must be answered or the agent blocks forever.
        if (id !== undefined) {
            let result;
            try {
                result = await this.onRequest(method, msg["params"]);
            }
            catch {
                result = {};
            }
            this.write({ jsonrpc: "2.0", id, result });
            return;
        }
        this.onNotify(method, msg["params"]);
    }
    write(obj) {
        if (this.closed)
            return;
        try {
            this.child.stdin.write(JSON.stringify(obj) + "\n");
        }
        catch {
            /* agent already gone; pending requests reject via the exit handler */
        }
    }
    request(method, params) {
        const id = this.nextId++;
        const p = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: resolve, reject });
        });
        this.write({ jsonrpc: "2.0", id, method, params });
        return p;
    }
}
/**
 * Runs one worker turn against an ACP backend.
 *
 * Watchdogs stay harness-side, exactly as they do for the SDK path: ACP has no
 * notion of "the stream failed to open", so phase-1 (launch -> first update),
 * phase-2 (first update -> first token) and the overall turn timeout are all
 * enforced here by aborting the child.
 */
export async function runWorkerAcp(params) {
    const { agent, worktreePath, systemPrompt, userMessage, model, resumeSessionId, timeoutSeconds, streamOpenTimeoutSeconds = 120, firstTokenTimeoutSeconds = 30, streamIdleWarnSeconds = 90, onStreamSlow, acpGuard, secretToken, logger, } = params;
    const startedAt = Date.now();
    const logs = [];
    const denied = [];
    let finalMessage = "";
    let streamOpened = false;
    let msToFirstToken;
    let lastActivityAt = Date.now();
    let sessionId = "";
    let costBaseline = null;
    let costLatest = null;
    let contextUsed;
    let contextSize;
    let sawAnyCost = false;
    let tokensIn = 0;
    let tokensOut = 0;
    let tokensCached = 0;
    let sawTokenSplit = false;
    const recordPromptUsage = (u) => {
        const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
        // Only claim a split when the agent actually sent one. An agent that omits
        // `usage` must leave `sawTokenSplit` false so `usageSource` reports the gap
        // rather than a measured zero.
        if (u.inputTokens === undefined && u.outputTokens === undefined)
            return;
        sawTokenSplit = true;
        tokensIn = n(u.inputTokens);
        tokensOut = n(u.outputTokens);
        // Cache reads and writes are billed differently by every provider that has
        // them, so they are kept separate rather than folded into tokensIn. M8 is
        // where that becomes a price; here it is only recorded.
        tokensCached = n(u.cachedWriteTokens) + n(u.cachedReadTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens);
    };
    const scrub = (s) => (secretToken ? redactSecrets(s, secretToken) : s);
    const pushLog = (s) => {
        if (logs.length < 400)
            logs.push(scrub(s));
    };
    const child = spawn(agent.command, agent.args, {
        cwd: worktreePath,
        stdio: ["pipe", "pipe", "pipe"],
        // v2.0.0 (P0): this was `{ ...process.env, ... }`, which handed the agent
        // every secret the harness holds -- the vault key, the GitHub PAT, the
        // Slack tokens. The SDK path has filtered its child since beta.57 and the
        // vault key specifically since beta.110; this path was new and simply did
        // not know. That is exactly the drift `shared/env.ts` exists to stop, and
        // it is why the filter is shared rather than copied.
        //
        // `agent.env` is applied AFTER the filter and is the only route in for
        // anything sensitive -- see M6, where the OpenCode configuration arrives as
        // OPENCODE_CONFIG_CONTENT and may carry provider keys.
        env: buildAgentEnv({ NO_COLOR: "1", ...(agent.env ?? {}) }),
        // The child is a process GROUP leader so the whole tree can be signalled.
        // See `reap`.
        detached: true,
    });
    const stderrParts = [];
    child.stderr.on("data", (d) => {
        if (stderrParts.length < 100)
            stderrParts.push(d.toString());
    });
    /**
     * Single place that ends the agent, so no path can leak a process.
     *
     * v2.0.0: signals the process GROUP, not just the child. `opencode` is a node
     * wrapper that spawns its own children -- the provider client, any MCP
     * servers it is configured with -- and SIGTERM to the wrapper alone leaves
     * those orphaned. On a long-running harness that is a slow leak of processes
     * holding a worktree open, and on a timeout it means the turn we just
     * abandoned keeps talking to the model and keeps spending.
     *
     * The child is spawned `detached`, which makes it a group leader, so
     * `kill(-pid)` reaches the whole tree. `child.kill()` remains as the fallback
     * for the case where the group is already gone or the platform refuses the
     * negative pid.
     */
    let reaped = false;
    const signalGroup = (sig) => {
        const pid = child.pid;
        if (pid === undefined)
            return;
        try {
            // Negative pid = "every process in this group".
            process.kill(-pid, sig);
        }
        catch {
            // No group (spawn failed, or already reaped): fall back to the child.
            try {
                child.kill(sig);
            }
            catch { /* already gone */ }
        }
    };
    const reap = () => {
        if (reaped)
            return;
        reaped = true;
        signalGroup("SIGTERM");
        // Escalate if it ignores SIGTERM; unref so we never hold the event loop.
        const t = setTimeout(() => signalGroup("SIGKILL"), 5_000);
        t.unref?.();
    };
    let abortReason = null;
    const timers = [];
    const arm = (ms, fn) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        timers.push(t);
    };
    // Phase 1: launched but never produced a single session/update.
    arm(streamOpenTimeoutSeconds * 1000, () => {
        if (!streamOpened) {
            abortReason = "first_token_timeout";
            pushLog(`[acp] stream-open watchdog fired after ${streamOpenTimeoutSeconds}s`);
            reap();
        }
    });
    // Overall turn budget.
    arm(timeoutSeconds * 1000, () => {
        abortReason = "timeout";
        pushLog(`[acp] turn timeout after ${timeoutSeconds}s`);
        reap();
    });
    const markActivity = () => {
        lastActivityAt = Date.now();
        if (!streamOpened) {
            streamOpened = true;
            // Phase 2 only becomes meaningful once the stream is actually open.
            arm(firstTokenTimeoutSeconds * 1000, () => {
                if (msToFirstToken === undefined) {
                    abortReason = "first_token_timeout";
                    pushLog(`[acp] first-token watchdog fired after ${firstTokenTimeoutSeconds}s`);
                    reap();
                }
            });
        }
    };
    // Liveness only; never aborts, matching the SDK path's stream-slow semantics.
    if (onStreamSlow) {
        const iv = setInterval(() => {
            const idleMs = Date.now() - lastActivityAt;
            if (idleMs >= streamIdleWarnSeconds * 1000) {
                onStreamSlow({ idleMs, elapsedMs: Date.now() - startedAt, tokensOut: 0, label: "acp" });
            }
        }, 15_000);
        iv.unref?.();
        timers.push(iv);
    }
    const handleUpdate = (update) => {
        const kind = update["sessionUpdate"];
        markActivity();
        switch (kind) {
            case "agent_message_chunk":
            case "agent_message": {
                if (msToFirstToken === undefined)
                    msToFirstToken = Date.now() - startedAt;
                const text = extractText(update);
                if (text) {
                    finalMessage += text;
                    pushLog(text);
                }
                break;
            }
            case "agent_thought_chunk":
                if (msToFirstToken === undefined)
                    msToFirstToken = Date.now() - startedAt;
                break;
            case "usage_update": {
                const used = update["used"];
                const size = update["size"];
                if (typeof used === "number")
                    contextUsed = used;
                if (typeof size === "number")
                    contextSize = size;
                const cost = update["cost"];
                if (cost && typeof cost.amount === "number") {
                    sawAnyCost = true;
                    // Cumulative per session, so the first figure is this turn's baseline.
                    if (costBaseline === null)
                        costBaseline = cost.amount;
                    costLatest = cost.amount;
                }
                break;
            }
            case "tool_call":
            case "tool_call_update": {
                const title = update["title"];
                if (typeof title === "string" && title.length > 0)
                    pushLog(`[tool:${String(update["kind"] ?? "?")}] ${title}`);
                break;
            }
            default:
                break;
        }
    };
    const conn = new AcpConnection(child, async (method, rpcParams) => {
        if (method === "session/request_permission") {
            const p = rpcParams;
            const call = p?.toolCall ?? {};
            const options = p?.options ?? [];
            const verdict = await acpGuard(call);
            if (!verdict.allow) {
                denied.push({ kind: call.kind, reason: verdict.reason });
                pushLog(`[guard] DENIED ${String(call.kind)}: ${verdict.reason ?? "no reason"}`);
                const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");
                // No reject option offered is itself a denial we cannot honour; the
                // cancelled outcome is the only safe fallback.
                return reject?.optionId
                    ? { outcome: { outcome: "selected", optionId: reject.optionId } }
                    : { outcome: { outcome: "cancelled" } };
            }
            const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
            return { outcome: { outcome: "selected", optionId: allow?.optionId } };
        }
        // We advertise fs:false, so these should not arrive. Answer anyway to
        // avoid deadlocking an agent that ignores our capabilities.
        if (method === "fs/read_text_file")
            return { content: "" };
        return {};
    }, (method, notifyParams) => {
        if (method !== "session/update")
            return;
        const p = notifyParams;
        if (p?.update)
            handleUpdate(p.update);
    });
    let stopReason = "tool_error";
    try {
        await conn.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        });
        if (resumeSessionId) {
            try {
                await conn.request("session/load", { sessionId: resumeSessionId, cwd: worktreePath, mcpServers: [] });
                sessionId = resumeSessionId;
            }
            catch (err) {
                // session/load is optional in the spec and unsupported by some agents.
                // A fresh session plus the dispatch hint is the documented fallback.
                pushLog(`[acp] session/load failed, starting fresh: ${scrub(String(err))}`);
            }
        }
        if (!sessionId) {
            const created = await conn.request("session/new", {
                cwd: worktreePath,
                mcpServers: [],
            });
            sessionId = created?.sessionId ?? "";
        }
        // Only some agents advertise model selection over ACP (Claude Code does,
        // OpenCode does not). Failure is non-fatal: the backend's own config then
        // owns the model choice.
        if (model) {
            try {
                await conn.request("session/set_model", { sessionId, modelId: model });
            }
            catch {
                pushLog(`[acp] session/set_model unsupported; backend config owns the model`);
            }
        }
        const res = await conn.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: `${systemPrompt}\n\n---\n\n${userMessage}` }],
        });
        // v2.0.0: the token split lives on the session/prompt RESULT, not on the
        // usage_update notification. The original matrix recorded "ACP carries no
        // input/output token split" from reading only the notification, which
        // carries context occupancy (`used`/`size`) and cost. The captured probe
        // sessions in probe/runs show the result frame carrying
        // `{inputTokens, outputTokens, totalTokens, cachedWriteTokens}` -- so the
        // split was there all along and the harness was throwing it away.
        //
        // This matters beyond tidiness: a local provider reports no cost at all, so
        // tokens are the ONLY usage signal the budget enforcer will have.
        if (res?.usage)
            recordPromptUsage(res.usage);
        stopReason = STOP_REASON_MAP[res?.stopReason ?? "end_turn"] ?? "tool_error";
        if (res?.stopReason && STOP_REASON_MAP[res.stopReason] === "tool_error") {
            pushLog(`[acp] raw stopReason=${res.stopReason}`);
        }
    }
    catch (err) {
        // A watchdog that killed the child surfaces here as a transport error; the
        // watchdog's own classification wins.
        stopReason = abortReason ?? "tool_error";
        pushLog(`[acp] ${scrub(String(err))}`);
    }
    finally {
        for (const t of timers)
            clearTimeout(t);
        reap();
    }
    if (abortReason)
        stopReason = abortReason;
    if (stderrParts.length > 0)
        pushLog(`[acp stderr] ${scrub(stderrParts.join("").slice(-2000))}`);
    const costUsd = costBaseline !== null && costLatest !== null ? Math.max(0, costLatest - costBaseline) : 0;
    logger?.info("[acp] worker turn finished", {
        stopReason,
        sessionId,
        denied: denied.length,
        usageSource: sawAnyCost ? "acp-delta" : "unavailable",
    });
    return {
        sdkSessionId: sessionId,
        stopReason,
        costUsd,
        // Real counts when the agent sent a split; 0 with `usageSource` saying so
        // when it did not. A consumer must always be able to tell "not measured"
        // from "free" -- that distinction is the whole reason usageSource exists.
        tokensIn,
        tokensOut,
        tokensCached: sawTokenSplit ? tokensCached : undefined,
        logsExcerpt: logs.join("").slice(-LOG_EXCERPT_MAX),
        finalMessage: finalMessage.trim(),
        streamOpened,
        msToFirstToken,
        usageSource: acpUsageSource(sawAnyCost, sawTokenSplit),
        contextUsed,
        contextSize,
        deniedToolCalls: denied,
    };
}
/**
 * How to read the usage numbers on a result.
 *
 * Three states, because the two signals arrive independently: a hosted provider
 * sends both cost and tokens, a local endpoint sends tokens but has no invoice
 * to report, and an agent that sends neither leaves the ledger with a hole that
 * must not be recorded as zero spend.
 */
export function acpUsageSource(sawCost, sawTokens) {
    if (sawCost && sawTokens)
        return "acp-delta";
    if (sawTokens)
        return "tokens-only";
    if (sawCost)
        return "acp-delta";
    return "unavailable";
}
/** Pulls display text out of the several content shapes ACP allows. */
function extractText(update) {
    const direct = update["text"];
    if (typeof direct === "string")
        return direct;
    const content = update["content"];
    if (typeof content === "string")
        return content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
        const t = content["text"];
        if (typeof t === "string")
            return t;
    }
    if (Array.isArray(content)) {
        return content
            .map((c) => (c && typeof c === "object" ? (c["text"] ?? "") : ""))
            .filter((s) => typeof s === "string")
            .join("");
    }
    return "";
}
/**
 * Run one of the six tool-less roles over ACP.
 *
 * These roles take one prompt and return one JSON document. They are not
 * agents: giving them tools does not merely waste a turn, it changes what they
 * emit — beta.28 and beta.40 both traced "no JSON in output" to a structured
 * role drifting into an assistant persona and narrating instead of answering.
 *
 * Tools are refused TWICE, on purpose. M6 configures the backend to have none,
 * and the guard below denies every request that arrives anyway. The first is
 * the real mechanism; the second is there because the whole reason
 * `preflightAcpBackend` exists is that a backend silently ignoring its own
 * permission configuration is a thing that happens, and a structured role that
 * quietly gained filesystem access would be a containment failure in the roles
 * that were supposed to be the safe ones.
 *
 * Each ladder rung is a FRESH session. Appending a correction to a session that
 * has already produced prose invites the model to continue in the same register,
 * and a new session costs nothing here because there is no accumulated worktree
 * state to carry over.
 */
export async function runStructuredAcp(params) {
    let sessionId = "";
    let usageSource = "unavailable";
    const denyAll = async (call) => {
        params.logger?.warn(`[acp/${params.role}] denied a tool call in a structured role; the backend is not honouring its tool configuration`, { role: params.role, kind: call.kind ?? null, title: call.title ?? null });
        return { allow: false, reason: `role '${params.role}' runs with no tools` };
    };
    const r = await runStructuredLadder({
        role: params.role,
        validation: params.validation,
        maxAttempts: params.maxAttempts,
        logger: params.logger,
        attempt: async (correction) => {
            const turn = await runWorkerAcp({
                agent: params.agent,
                worktreePath: params.cwd,
                systemPrompt: params.systemPrompt,
                userMessage: correction ? `${params.userMessage}\n\n${correction}` : params.userMessage,
                model: params.model,
                timeoutSeconds: params.timeoutSeconds,
                streamOpenTimeoutSeconds: params.streamOpenTimeoutSeconds,
                acpGuard: denyAll,
                secretToken: params.secretToken,
                logger: params.logger,
            });
            if (!sessionId)
                sessionId = turn.sdkSessionId;
            usageSource = turn.usageSource;
            return {
                raw: turn.finalMessage,
                costUsd: turn.costUsd,
                tokensIn: turn.tokensIn,
                tokensOut: turn.tokensOut,
                sessionId: turn.sdkSessionId,
                truncated: turn.stopReason === "max_tokens",
            };
        },
    });
    return {
        parsed: r.parsed,
        sdkSessionId: sessionId,
        costUsd: r.costUsd,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        usageSource,
        repaired: r.repaired,
    };
}
/**
 * What this backend can do.
 *
 * `toolPermissionCallback` is declared true, but M6 does not take that on
 * trust: it is the one capability whose absence is invisible at runtime, and
 * the M2 probe measured OpenCode on default configuration running four shell
 * commands and two edits without a single permission request. The declaration
 * says "this backend is capable of asking"; the live probe establishes that
 * this INSTALLATION actually does.
 *
 * `reportsCostUsd` is true for hosted providers and false in practice for local
 * ones, which is why `usageSource` accompanies every result rather than the
 * harness inferring it from a zero.
 */
export const ACP_CAPABILITIES = {
    id: "acp",
    toolUse: true,
    toolPermissionCallback: true,
    disableAllTools: true,
    // session/load is optional in the spec and unsupported by some agents; the
    // adapter falls back to a fresh session, so resume is best-effort.
    resumeSession: true,
    reportsCostUsd: true,
};
/**
 * Startup check for the one failure mode that is invisible at runtime.
 *
 * An ACP backend that is not configured to ask for permission simply never
 * sends `session/request_permission`. Nothing errors; the guard is just never
 * consulted, and the bash whitelist and path denylist are silently inert while
 * still reading as enabled. The M2 probe measured exactly this: OpenCode on
 * default config ran four shell commands and two edits with zero permission
 * requests.
 *
 * This must therefore be verified before a worker is ever dispatched, and must
 * fail closed.
 */
export function preflightAcpBackend(input) {
    const reasons = [];
    const cfg = input.backendConfig;
    if (input.agentId === "opencode") {
        const perm = cfg?.["permission"];
        if (!perm) {
            reasons.push("opencode.json has no `permission` block; the backend will run bash and edits without asking, so the harness guard would never be consulted");
        }
        else {
            for (const key of ["bash", "edit"]) {
                const v = perm[key];
                // A nested object maps patterns to actions; a bare "allow" is the
                // dangerous case because it silently bypasses the guard entirely.
                if (v === undefined) {
                    reasons.push(`opencode.json permission.${key} is unset (defaults are permissive); set it to "ask"`);
                }
                else if (v === "allow") {
                    reasons.push(`opencode.json permission.${key} is "allow"; the harness guard cannot see these calls`);
                }
            }
        }
    }
    else if (input.agentId === "codex") {
        // Measured: Codex only escalates on sandbox escape, so in-workspace reads
        // of denylisted files never reach the guard.
        reasons.push("codex uses sandbox-and-escalate: in-workspace reads of denylisted files (.env, keys) never raise a permission request, so path_denylist is unenforceable");
    }
    else if (input.agentId === "claude") {
        // Measured: none of Claude Code's five ACP session modes asks for every
        // tool call, whereas the SDK path invokes canUseTool for all of them.
        // Routing the worker here would be a safety regression against what we
        // already ship, for the same vendor and the same model.
        reasons.push("claude over ACP is strictly weaker than the existing claude-code SDK backend: no session mode asks for every tool call, and it emits no usage_update. Use worker_backend=claude-code instead");
    }
    return { ok: reasons.length === 0, reasons };
}
/**
 * Prove, by doing it, that this INSTALLATION asks before it acts.
 *
 * `preflightAcpBackend` reads configuration and reasons about what it should
 * mean. That is worth doing and it is not sufficient, because every step
 * between the config and the behaviour can fail silently: the variable may not
 * reach the child, the agent's version may have renamed a key, the document may
 * be shadowed by managed preferences, or the backend may simply not honour what
 * it was told. In all of those cases the config LOOKS right and the guard is
 * never called — and a guard that is never called is indistinguishable from a
 * guard that approved everything.
 *
 * So this drives a real turn, asks for a real tool call, and requires the
 * round-trip to happen. It DENIES the call, because a probe that approves is
 * only half a test: an agent could conceivably ask and then ignore the answer,
 * and the denial path is the one the containment story actually rests on.
 *
 * FAILS CLOSED, on every axis. No permission request, a timeout, a spawn
 * failure, an agent that proceeds after being refused, or any thrown error all
 * return `ok: false`. There is no path through this function where "we could
 * not tell" produces a pass, because "we could not tell" is exactly what the
 * broken case looks like.
 */
export async function probeAcpPermissionEnforcement(input) {
    const marker = `harness-probe-${Date.now().toString(36)}`;
    let sawPermissionRequest = false;
    let sawDeniableOption = false;
    const fail = (detail, extra) => ({
        ok: false,
        reasons: [
            `the ACP permission probe did not confirm that '${input.agent.command}' asks before it acts: ${detail}. ` +
                `The harness guard (bash whitelist, path deny-list, no-push) is enforced ONLY through ` +
                `session/request_permission, so without that round-trip those controls do not run at all, ` +
                `while still reading as enabled in openclaw.json.`,
        ],
        sawPermissionRequest,
        denialHonoured: false,
        detail,
        ...extra,
    });
    let turn;
    try {
        turn = await runWorkerAcp({
            agent: input.agent,
            worktreePath: input.cwd,
            // The probe asks for a write rather than a shell command because `edit`
            // and `bash` are configured separately in OpenCode and a write is the
            // one that cannot be satisfied from a cache or a sandbox short-circuit.
            systemPrompt: "You are being checked for tool availability. Do exactly what is asked, using your file-writing tool. " +
                "Do not explain, do not ask questions, and do not use any other tool.",
            userMessage: `Create a file named ${marker}.txt in the current directory containing the single word ok.`,
            model: input.model ?? "",
            timeoutSeconds: input.timeoutSeconds ?? 120,
            acpGuard: async (call) => {
                sawPermissionRequest = true;
                input.logger?.info("[acp/probe] permission request received", { kind: call.kind ?? null });
                return { allow: false, reason: "capability probe: denying on purpose to confirm the round-trip" };
            },
            logger: input.logger,
        });
    }
    catch (err) {
        return fail(`the agent could not be run at all (${String(err?.message ?? err)})`);
    }
    if (turn.stopReason === "timeout" || turn.stopReason === "first_token_timeout") {
        return fail(`the agent produced no usable turn before the probe deadline (${turn.stopReason})`);
    }
    // "Did the agent run at all" has to be answered BEFORE "did it ask", or a
    // missing binary is reported as a permission-configuration fault and sends
    // the operator after the wrong thing entirely. A child that never opened its
    // stream never got as far as having an opinion about permissions.
    //
    // This is a separate branch from the try/catch above because a spawn failure
    // does not throw out of `runWorkerAcp`: the adapter handles the child's async
    // `error` event and returns a failed turn, which is what stops one bad
    // command from taking the harness down.
    if (!turn.streamOpened) {
        return fail(`the agent could not be run at all (it never opened an ACP stream; ` +
            `${turn.logsExcerpt.trim().slice(-300) || "no output"})`);
    }
    if (!sawPermissionRequest) {
        return fail("the agent completed a turn that should have required a file write WITHOUT ever asking permission. " +
            "This is the measured default behaviour of OpenCode with no `permission` block, and it means " +
            "OPENCODE_CONFIG_CONTENT is not reaching the agent or is not being honoured");
    }
    // The guard denied. The adapter records what it refused, and the agent must
    // not have gone ahead regardless.
    sawDeniableOption = turn.deniedToolCalls.length > 0;
    if (!sawDeniableOption) {
        return fail("a permission request arrived but the adapter recorded no denial, so the refusal path is unproven");
    }
    const wrote = turn.finalMessage.includes(marker) && /created|written|wrote/i.test(turn.finalMessage);
    if (wrote) {
        return fail("the agent reported completing the write AFTER the harness refused it; a backend that asks and then " +
            "proceeds anyway offers no containment at all", { sawPermissionRequest: true });
    }
    input.logger?.info("[acp/probe] permission enforcement confirmed", {
        denied: turn.deniedToolCalls.length,
        stopReason: turn.stopReason,
    });
    return {
        ok: true,
        reasons: [],
        sawPermissionRequest: true,
        denialHonoured: true,
        detail: `asked before acting and honoured a denial (${turn.deniedToolCalls.length} call(s) refused)`,
    };
}
/**
 * The full startup check: read the configuration, then prove the behaviour.
 *
 * Static inspection runs first because it is free and its messages are more
 * specific — "permission.bash is 'allow'" tells an operator what to edit, where
 * the live probe can only say "it did not ask". But a clean static result is
 * never sufficient on its own, so a pass there does not skip the probe.
 */
export async function preflightAcpBackendLive(input) {
    const stat = preflightAcpBackend({ agentId: input.agentId, backendConfig: input.backendConfig });
    if (!stat.ok) {
        return { ...stat, sawPermissionRequest: false, denialHonoured: false, detail: "refused on configuration inspection" };
    }
    return probeAcpPermissionEnforcement(input);
}
//# sourceMappingURL=acp.js.map