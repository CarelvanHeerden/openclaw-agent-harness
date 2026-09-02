/**
 * Which backend and model each role runs on, and how a provider's key reaches
 * the agent without reaching anything else.
 *
 * Two jobs that belong together because they fail together: a role pointed at
 * `local/qwen-coder` is broken in exactly the same way whether the `local`
 * provider was never declared or was declared without a key. Both produce a
 * process that starts, runs, and returns something shaped like an answer.
 *
 * WHY RESOLUTION IS A FUNCTION AND NOT A LOOKUP. Every role has three possible
 * sources — its own block, the `default` block, and the built-in fallback — and
 * the interesting cases are the partial ones: a role that sets `model` but not
 * `backend` is asking for a model on the default backend, and a role that sets
 * `backend` but not `model` is asking for that backend's own default. Spelling
 * that out once here is the difference between one merge rule and eight.
 *
 * WHY VALIDATION IS SEPARATE FROM RESOLUTION. `resolveRoleBackend` answers
 * "what did the operator ask for", `validateRoleConfig` answers "is that
 * coherent". Keeping them apart means the error path can report EVERY problem
 * in one pass rather than dying on the first, which matters when the surface is
 * eight roles times two backends and the operator is editing JSON by hand.
 */
import { type CapabilityTier, type RoleName } from "./backend.js";
/** The backends a role can name. Extending this is a deliberate act. */
export type BackendId = "claude-code" | "opencode";
export declare const BACKEND_IDS: readonly BackendId[];
/**
 * The default when nothing says otherwise.
 *
 * `claude-code` rather than "whatever is configured first", because v2 must be
 * a no-op for a v1 operator who upgrades and changes nothing. An install that
 * never mentions backends behaves exactly as it did.
 */
export declare const DEFAULT_BACKEND: BackendId;
export interface RoleBackendConfig {
    backend?: BackendId;
    /**
     * `provider/model`, matching OpenCode's own addressing so an operator can
     * copy a model id straight out of `opencode models` or models.dev.
     *
     * For `claude-code` a bare model id is also accepted, because that is what
     * `models.lead` has always held and v1 configs must keep working.
     */
    model?: string;
    /**
     * What the operator asserts this model can do. See `CapabilityTier`: it is a
     * declaration, not a measurement, and it exists so the three judgement roles
     * can refuse a model the operator has not vouched for.
     */
    tier?: CapabilityTier;
}
export interface ProviderConfig {
    /** The AI-SDK package. Only the OpenAI-compatible shim is supported today. */
    npm?: string;
    /** Display name, surfaced in audit events and errors. */
    name?: string;
    /**
     * The endpoint. Must end in `/v1`: the OpenAI-compatible shim appends
     * `/chat/completions` to whatever it is given, so a baseURL missing the
     * version segment produces a 404 on the first call and nothing before it.
     * Cheap to check here, invisible until runtime otherwise.
     */
    base_url?: string;
    /**
     * Vault service name holding the key. The key itself is NEVER in config —
     * that is the whole reason the vault exists — and it reaches the agent only
     * inside `OPENCODE_CONFIG_CONTENT`, which is allow-listed past the env
     * deny-list by name and redacted from the interaction log.
     */
    api_key_service?: string;
    /**
     * A provider that bills nothing: a local server, or one already paid for.
     *
     * Cost reporting becomes token counts with no dollars attached. That is a
     * measurement rather than the `costUsd: 0` a missing price would produce,
     * and the distinction matters because zero is indistinguishable from
     * "nobody looked".
     */
    local?: boolean;
    /**
     * The models.dev provider id these models are priced under.
     *
     * Needed because a provider id here is an OPERATOR'S LABEL, and the pricing
     * catalogue is keyed by models.dev's. They diverge for the most ordinary
     * reason: OpenCode ships built-in providers called `anthropic` and `openai`,
     * a custom block sharing an id gets deep-merged into the built-in one, and
     * the way out is to name yours something else. `anthropic-compat` and
     * `openai-compat` are that workaround — and every model under them missed
     * the catalogue completely, fell past `PRICES`, and was billed at the
     * most-expensive-known fail-safe of $15/$75 per million. For Sonnet 4.5 at
     * $3/$15 that is exactly 5x on both terms, so every v2 cost figure and every
     * budget ceiling was wrong by that factor in the direction that stops runs
     * early.
     *
     * Nothing announced it. The fail-safe returns a number, so the ledger showed
     * a plausible dollar figure, and the one log line that would have said
     * otherwise only fires when the cost is `undefined`. See `priceTurn`, which
     * now warns when a turn prices this way.
     *
     * Explicit rather than inferred: stripping a `-compat` suffix would guess,
     * and a wrong guess here is silent by the same mechanism. Absent means the
     * provider id already IS the catalogue id, which is the common case.
     */
    pricing_provider?: string;
    models?: Record<string, {
        name?: string;
    }>;
}
export interface RolesConfigInput {
    /** Applied to any role that does not override it. */
    default?: RoleBackendConfig;
    roles?: Partial<Record<RoleName, RoleBackendConfig>>;
    providers?: Record<string, ProviderConfig>;
}
export interface ResolvedRoleBackend {
    role: RoleName;
    backend: BackendId;
    /** Undefined means "let the backend pick", which only claude-code can do. */
    model?: string;
    /** The provider segment of `provider/model`, when the model is qualified. */
    provider?: string;
    tier: CapabilityTier;
    /** True when the values came from `default` or the built-in, not the role. */
    inherited: boolean;
}
/**
 * Split `provider/model` into its parts.
 *
 * Returns `undefined` for the provider when the id is bare. Only the FIRST
 * slash separates: model ids legitimately contain slashes
 * (`openrouter/anthropic/claude-3`), and treating the last slash as the
 * separator would silently address the wrong provider.
 */
export declare function splitModelId(model: string): {
    provider?: string;
    model: string;
};
/**
 * What a role will actually run on, after the three-level merge.
 *
 * Per-field rather than per-block: a role that sets only `tier` keeps the
 * default's backend and model. Merging whole blocks would make `tier` silently
 * reset them, which is the kind of config behaviour that gets discovered in
 * production.
 */
export declare function resolveRoleBackend(role: RoleName, input?: RolesConfigInput): ResolvedRoleBackend;
export declare function resolveAllRoles(input?: RolesConfigInput): Record<RoleName, ResolvedRoleBackend>;
export interface RoleConfigProblem {
    role?: RoleName;
    provider?: string;
    message: string;
}
/**
 * Every problem in the configuration, not just the first.
 *
 * Returns a list rather than throwing so the caller decides what is fatal.
 * A missing provider block is fatal; a `default` tier below a role's floor is
 * fatal for that role only, and reporting it alongside the others lets an
 * operator fix the whole file in one edit instead of eight startup attempts.
 */
export declare function validateRoleConfig(input?: RolesConfigInput): RoleConfigProblem[];
/**
 * The `provider` block for `OPENCODE_CONFIG_CONTENT`, with real keys in it.
 *
 * `resolveKey` is passed in rather than the vault itself so the caller owns the
 * async boundary and the tests do not need one. A provider whose key cannot be
 * resolved is DROPPED rather than emitted with an empty `apiKey`: an absent
 * provider fails at the first call with "unknown provider", which is a legible
 * error, where an empty key fails inside the endpoint's auth handler as a 401
 * that reads like the key is wrong rather than missing.
 */
export declare function buildProviderBlock(providers: Record<string, ProviderConfig>, resolveKey: (service: string) => string | undefined): {
    block: Record<string, unknown>;
    dropped: {
        provider: string;
        reason: string;
    }[];
};
/** Providers an operator declared local, so cost reporting stays token-only. */
export declare function localProviders(providers?: Record<string, ProviderConfig>): Set<string>;
/**
 * Rewrite a configured model id into the one the pricing catalogue knows.
 *
 * `anthropic-compat/claude-sonnet-4-5` addresses the endpoint; the catalogue
 * calls the same model `anthropic/claude-sonnet-4-5`. Only the provider
 * segment moves — the model segment is whatever the endpoint serves and is not
 * ours to rename. See `ProviderConfig.pricing_provider` for what the mismatch
 * cost.
 *
 * A bare id, an unknown provider, or a provider with no `pricing_provider`
 * comes back untouched, so this is a no-op for every configuration that did
 * not need it.
 */
export declare function pricingModelId(model: string, providers?: Record<string, ProviderConfig>): string;
//# sourceMappingURL=role-config.d.ts.map