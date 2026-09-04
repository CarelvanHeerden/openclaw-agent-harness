/**
 * Chooses which backend runs each role, and assembles what that backend needs.
 *
 * Everything M4 through M8 built is inert without this: the ACP adapter, the
 * per-role config, the OpenCode config generator and the pricing catalogue were
 * all reachable from tests and from nothing else. A `backends` block in an
 * operator's config was accepted by the manifest and then quietly ignored,
 * which is the worst of the three possible behaviours — worse than rejecting
 * it, and worse than honouring it — because the operator has evidence they
 * configured something and no evidence it did nothing.
 *
 * WHAT THIS DOES NOT DO. It does not reimplement any role. The prompts stay in
 * `claude-code.ts`, where they accumulated their behaviour, and this supplies
 * an alternative EXECUTOR for the roles an operator has moved (see
 * `StructuredExecutor`). Two copies of the adversary's system prompt, one per
 * backend, would diverge on the first fix applied to either.
 *
 * FAIL-CLOSED ORDER. Configuration is validated, then the live probe runs, and
 * only then is any role allowed onto a non-default backend. The probe is the
 * one that matters: a backend that has silently stopped routing tool calls
 * through `session/request_permission` reads as perfectly healthy from its
 * config, which is exactly the failure the M2 capability probe found in all
 * three agents by default.
 */
import { ROLE_SHAPES } from "./backend.js";
import { buildProviderBlock, localProviders, pricingModelId, resolveAllRoles, validateRoleConfig, } from "./role-config.js";
import { openCodeConfigEnv } from "./opencode-config.js";
import { PINNED_OPENCODE_VERSION } from "./opencode-version.js";
import { preflightAcpBackendLive, runStructuredAcp } from "./acp.js";
import { costOf, refreshCatalogue, resolvePrice, } from "./shared/model-catalogue.js";
export class BackendConfigError extends Error {
    problems;
    constructor(problems) {
        super(`backend configuration is not usable:\n  - ${problems.join("\n  - ")}`);
        this.problems = problems;
        this.name = "BackendConfigError";
    }
}
/** How OpenCode is launched when the operator has not said otherwise. */
export function defaultOpenCodeCommand() {
    // `opencode` on PATH, which the Dockerfile installs at the pinned version.
    // Not `npx -y opencode-ai@latest`: that puts a network fetch on the startup
    // path of every session and lets whoever published most recently decide what
    // the worker's tool calls flow through.
    return { command: "opencode", args: ["acp"] };
}
export class BackendRouter {
    input;
    roles;
    providerBlock;
    local;
    probed = false;
    catalogue;
    /** Models already reported as unpriced, so the warning fires once, not per turn. */
    failSafeWarned = new Set();
    constructor(input) {
        this.input = input;
        const cfg = {
            default: input.backends?.default,
            roles: input.backends,
            providers: input.providers,
        };
        // Validate BEFORE anything is resolved for use. Reports every problem in
        // one pass, because the surface is eight roles times two backends and an
        // operator fixing them one startup at a time is being punished for our
        // convenience.
        const problems = validateRoleConfig(cfg);
        if (problems.length > 0) {
            const rendered = problems.map((p) => p.message);
            input.audit("backend.config_rejected", { problems: rendered });
            throw new BackendConfigError(rendered);
        }
        this.roles = resolveAllRoles(cfg);
        this.local = localProviders(input.providers ?? {});
        const { block, dropped } = buildProviderBlock(input.providers ?? {}, input.resolveKey);
        this.providerBlock = block;
        for (const d of dropped) {
            // Dropped, not emitted with an empty key: an absent provider fails as
            // "unknown provider", where an empty key fails as a 401 that sends the
            // operator to rotate a credential that was never there.
            input.logger.warn(`[backend] provider '${d.provider}' dropped: ${d.reason}`);
            input.audit("backend.provider_dropped", { provider: d.provider, reason: d.reason });
        }
    }
    /** Roles the operator has moved off the default backend. */
    get openCodeRoles() {
        return Object.keys(this.roles).filter((r) => this.roles[r].backend === "opencode");
    }
    get usesOpenCode() {
        return this.openCodeRoles.length > 0;
    }
    backendFor(role) {
        return this.roles[role];
    }
    /** True when this role's provider bills nothing, so cost must stay absent. */
    isLocal(role) {
        const p = this.roles[role].provider;
        return p !== undefined && this.local.has(p);
    }
    /**
     * Turn a turn's raw usage into the dollar figure the ledger records.
     *
     * The three `usageSource` values are genuinely different facts and are not
     * collapsed into a number:
     *
     *   acp-delta    the agent priced its own turn. Believe it.
     *   tokens-only  tokens arrived with no cost. A local provider bills
     *                nothing, so zero is TRUE. Anyone else DOES bill, so we
     *                price the tokens ourselves off the models.dev catalogue.
     *                Recording zero here is exactly the cost leak M8 spent a
     *                milestone removing from the SDK paths.
     *   unavailable  neither arrived. The ledger has a hole, and `undefined`
     *                says so where `0` would quietly claim a free turn.
     */
    priceTurn(role, usage) {
        if (usage.usageSource === "unavailable")
            return { costUsd: undefined, priceSource: "unmeasured" };
        if (usage.usageSource === "acp-delta")
            return { costUsd: usage.costUsd, priceSource: "agent" };
        const model = this.roles[role].model;
        if (!model)
            return { costUsd: undefined, priceSource: "unmeasured" };
        // Priced under the catalogue's id, not the operator's label for the
        // endpoint -- EXCEPT for a local one, which is not rewritten at all.
        //
        // `resolvePrice` reads "is this local" off the provider segment of the id
        // it is given, and the rewritten segment names whoever PUBLISHES the
        // model rather than who serves it. So rewriting a local provider made it
        // stop matching and start billing catalogue rates for tokens that cost
        // nothing. Skipping the rewrite keeps the ladder's own ordering intact --
        // overrides above local, deliberately, because an operator who prices a
        // local model has said something specific -- where widening the local set
        // to cover mapped ids would let one local provider zero-rate a paid one
        // that happens to share a publisher.
        const priceKey = this.isLocal(role) ? model : pricingModelId(model, this.input.providers ?? {});
        const res = resolvePrice({
            model: priceKey,
            overrides: this.input.priceOverrides,
            catalogue: this.catalogue,
            localProviders: this.local,
        });
        // The fail-safe is a real answer to "what might this cost at worst", and a
        // terrible answer to "what did this cost". It is also the only rung of the
        // ladder that cannot be told from a correct one downstream: it returns a
        // plausible number, the ledger records it, and nothing else fires. Said
        // once per model so a misconfiguration is loud on the first turn and quiet
        // for the rest of the run.
        if (res.source === "fail-safe" && !this.failSafeWarned.has(model)) {
            this.failSafeWarned.add(model);
            this.input.logger.warn(`[backend] no price for '${model}'; billing it at the most-expensive-known rate ` +
                `($${res.price.input}/$${res.price.output} per million). Costs and budget ceilings for this ` +
                `run are over-stated. Set providers.<id>.pricing_provider if this endpoint serves a model ` +
                `models.dev already prices, or models.price_overrides if it does not.`, { role, model, pricedAs: priceKey });
            this.input.audit("backend.price_fail_safe", { role, model, pricedAs: priceKey, price: res.price });
        }
        // `costOf` returns undefined for a non-billable model. That is a real zero
        // — a local endpoint issues no invoice — as distinct from the `undefined`
        // above, which means nobody measured.
        if (!res.billable)
            return { costUsd: 0, priceSource: "local" };
        return { costUsd: costOf(usage.tokensIn, usage.tokensOut, res), priceSource: res.source };
    }
    /**
     * Refresh the pricing catalogue, off the hot path and never fatal.
     *
     * Pricing being stale is a reporting problem; pricing being unreachable must
     * not be a run problem. A rejected or unreachable refresh keeps whatever
     * cache was already good, and the resolution ladder falls back to the
     * built-in table below that.
     */
    async refreshPricing(store) {
        try {
            this.catalogue = await refreshCatalogue({
                store,
                audit: (event, payload) => this.input.audit(event, payload),
            });
        }
        catch (err) {
            this.input.logger.warn(`[backend] pricing refresh failed, continuing on cache: ${String(err)}`);
        }
    }
    /** The agent spec for a role, carrying the generated OpenCode configuration. */
    agentSpecFor(role) {
        const r = this.roles[role];
        return {
            ...(this.input.openCodeCommand ?? defaultOpenCodeCommand()),
            env: openCodeConfigEnv({
                provider: this.providerBlock,
                model: r.model,
                // The six structured roles get no tools at all. The deny-all guard in
                // `runStructuredAcp` is the layer that does not depend on the backend
                // honouring its own configuration; this is the layer that asks nicely.
                toolless: ROLE_SHAPES[role] === "structured",
            }),
            onVersionMismatch: (info) => {
                this.input.logger.warn(`[backend] ${info.message ?? "opencode version mismatch"}`, { role });
                this.input.audit("backend.version_mismatch", {
                    role,
                    agent: info.agentName ?? null,
                    reported: info.reported ?? null,
                    expected: info.expected,
                    relation: info.relation,
                });
            },
        };
    }
    /**
     * Prove the guard is live before any role is allowed onto OpenCode.
     *
     * Idempotent, and a failure THROWS. Returning a degraded router that quietly
     * fell back to Claude Code would be the wrong kindness: the operator asked
     * for a specific configuration, and running a different one while reporting
     * success is how a cost or capability surprise gets attributed to the wrong
     * thing three weeks later.
     */
    async preflight() {
        if (this.probed || !this.usesOpenCode)
            return;
        const role = this.openCodeRoles[0];
        if (!role)
            return;
        const result = await preflightAcpBackendLive({
            agentId: "opencode",
            // The configuration we are about to hand the agent, so the static half
            // of the preflight inspects the real document rather than a guess.
            backendConfig: JSON.parse(this.agentSpecFor(role).env?.OPENCODE_CONFIG_CONTENT ?? "{}"),
            agent: this.agentSpecFor(role),
            cwd: this.input.scratchDir,
            model: this.roles[role].model,
            effort: this.roles[role].effort,
            logger: this.input.logger,
        });
        this.input.audit("backend.preflight", {
            agent: "opencode",
            pinnedVersion: PINNED_OPENCODE_VERSION,
            roles: this.openCodeRoles,
            ok: result.ok,
            sawPermissionRequest: result.sawPermissionRequest,
            denialHonoured: result.denialHonoured,
            detail: result.detail ?? null,
        });
        if (!result.ok) {
            throw new Error(`the OpenCode backend failed its startup capability probe: ${result.detail ?? "no detail"}. ` +
                `Roles ${this.openCodeRoles.join(", ")} would run with the harness guard never consulted, ` +
                `so the harness refuses to start rather than run them unguarded.`);
        }
        this.probed = true;
        this.input.logger.info("[backend] opencode passed the live permission probe", {
            roles: this.openCodeRoles,
        });
    }
    /**
     * The executor for a structured role, or `undefined` to use the SDK default.
     *
     * `undefined` rather than an SDK-shaped wrapper so that the Claude Code path
     * is byte-for-byte what it was before this module existed. A role nobody
     * moved should not acquire a new layer.
     */
    executorFor(role) {
        if (this.roles[role].backend !== "opencode")
            return undefined;
        const r = this.roles[role];
        const agent = this.agentSpecFor(role);
        const { logger } = this.input;
        return async (params) => {
            const out = await runStructuredAcp({
                agent,
                role,
                cwd: this.input.scratchDir,
                systemPrompt: params.systemPrompt,
                userMessage: params.userMessage,
                // The role's configured model wins: `params.model` is the Anthropic id
                // from `models.*`, which means nothing to another provider.
                model: r.model ?? params.model,
                effort: r.effort,
                timeoutSeconds: params.timeoutSeconds,
                streamOpenTimeoutSeconds: params.streamOpenTimeoutSeconds,
                validation: params.validation ?? { requiredKeys: [], label: role },
                logger,
                // Honoured, not ignored. The adversary drives its own ladder and reads
                // `raw`; parsing here consumed the reply and handed back an empty
                // string, so every verdict the model produced was reported to that
                // ladder as "no JSON in output" with nothing after `--- raw ---`.
                skipParse: params.skipParse,
            });
            const priced = this.priceTurn(role, out);
            if (priced.costUsd === undefined) {
                // The ledger cannot represent "unknown", so a hole is reported as a
                // zero AND said out loud, rather than only the former.
                logger.warn(`[backend] ${role} turn on opencode reported no usable cost`, {
                    usageSource: out.usageSource,
                    tokensIn: out.tokensIn,
                    tokensOut: out.tokensOut,
                });
            }
            return {
                parsed: out.parsed,
                sdkSessionId: out.sdkSessionId,
                costUsd: priced.costUsd ?? 0,
                tokensIn: out.tokensIn,
                tokensOut: out.tokensOut,
                raw: out.raw,
                stopReason: out.stopReason,
            };
        };
    }
    /** A one-line summary per role, for the startup log and the audit trail. */
    describe() {
        return Object.keys(this.roles).map((role) => ({
            role,
            backend: this.roles[role].backend,
            provider: this.roles[role].provider ??
                (this.roles[role].backend === "claude-code"
                    ? "anthropic"
                    : (this.roles[role].model?.split("/")[0] ?? "unknown")),
            model: this.roles[role].model,
            effort: this.roles[role].effort,
            tier: this.roles[role].tier,
        }));
    }
}
/**
 * Build a router, or `undefined` when nothing is configured.
 *
 * `undefined` is the v1 path, unchanged and untouched. An install that never
 * mentions backends does not get a router, does not run a probe, and does not
 * pay for a code path it is not using.
 */
export function buildBackendRouter(input) {
    const declared = input.backends && Object.keys(input.backends).length > 0;
    if (!declared)
        return undefined;
    const router = new BackendRouter(input);
    return router.usesOpenCode ? router : undefined;
}
//# sourceMappingURL=backend-router.js.map