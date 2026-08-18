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
 *   - ACP carries no input/output token split. Only `used` (context occupancy)
 *     and `size` (window). tokensIn/tokensOut are reported as 0 and flagged via
 *     `usageSource`, so the ledger records a gap instead of a false zero.
 *   - `cost` is cumulative per session and optional. We delta it across the
 *     turn; agents that never report it yield usageSource "unavailable".
 *   - Permission enforcement depends on the BACKEND's own config. An agent not
 *     configured to ask never sends session/request_permission and the guard
 *     never runs. `preflightAcpBackend()` exists to make that a startup failure
 *     rather than a silent hole.
 */
import { spawn } from "node:child_process";
import { redactSecrets } from "./git-worktree.js";
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
        child.on("exit", (code, signal) => {
            this.closed = true;
            const err = new Error(`acp agent exited (code=${code} signal=${signal})`);
            for (const [, p] of this.pending)
                p.reject(err);
            this.pending.clear();
        });
    }
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
    const scrub = (s) => (secretToken ? redactSecrets(s, secretToken) : s);
    const pushLog = (s) => {
        if (logs.length < 400)
            logs.push(scrub(s));
    };
    const child = spawn(agent.command, agent.args, {
        cwd: worktreePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", ...(agent.env ?? {}) },
    });
    const stderrParts = [];
    child.stderr.on("data", (d) => {
        if (stderrParts.length < 100)
            stderrParts.push(d.toString());
    });
    /** Single place that ends the child, so no path can leak a process. */
    let reaped = false;
    const reap = () => {
        if (reaped)
            return;
        reaped = true;
        try {
            child.kill("SIGTERM");
        }
        catch {
            /* already gone */
        }
        // Escalate if it ignores SIGTERM; unref so we never hold the event loop.
        const t = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            }
            catch {
                /* already gone */
            }
        }, 5_000);
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
        // ACP has no input/output split. Reporting 0 with usageSource set is
        // deliberate: a consumer must be able to tell "not measured" from "free".
        tokensIn: 0,
        tokensOut: 0,
        logsExcerpt: logs.join("").slice(-LOG_EXCERPT_MAX),
        finalMessage: finalMessage.trim(),
        streamOpened,
        msToFirstToken,
        usageSource: sawAnyCost ? "acp-delta" : "unavailable",
        contextUsed,
        contextSize,
        deniedToolCalls: denied,
    };
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
//# sourceMappingURL=acp.js.map