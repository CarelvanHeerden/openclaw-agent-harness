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
import { ROLE_MIN_TIER, ROLE_NAMES, ROLE_SHAPES, tierAtLeast, } from "./backend.js";
export const BACKEND_IDS = ["claude-code", "opencode"];
/**
 * The default when nothing says otherwise.
 *
 * `claude-code` rather than "whatever is configured first", because v2 must be
 * a no-op for a v1 operator who upgrades and changes nothing. An install that
 * never mentions backends behaves exactly as it did.
 */
export const DEFAULT_BACKEND = "claude-code";
/**
 * Split `provider/model` into its parts.
 *
 * Returns `undefined` for the provider when the id is bare. Only the FIRST
 * slash separates: model ids legitimately contain slashes
 * (`openrouter/anthropic/claude-3`), and treating the last slash as the
 * separator would silently address the wrong provider.
 */
export function splitModelId(model) {
    const i = model.indexOf("/");
    if (i <= 0 || i === model.length - 1)
        return { model };
    return { provider: model.slice(0, i), model: model.slice(i + 1) };
}
/** The AI-SDK packages a provider may name. Extending this needs a live turn to prove it. */
export const SUPPORTED_PROVIDER_NPM = ["@ai-sdk/openai-compatible", "@ai-sdk/openai"];
/**
 * Which package a provider block will actually load, or `undefined` for one
 * OpenCode already knows.
 *
 * Single-sourced because `validateRoleConfig` and `buildProviderBlock` both
 * need the answer, and the failure mode when they disagree is a configuration
 * that validates and then runs as something else.
 */
export function resolveProviderNpm(p) {
    if (p.npm)
        return p.npm;
    // A custom endpoint needs a shim; the compat one is the only shim that takes
    // an arbitrary baseURL. No endpoint means a built-in, so we name nothing and
    // let OpenCode supply both package and URL.
    return p.base_url ? "@ai-sdk/openai-compatible" : undefined;
}
/**
 * What a role will actually run on, after the three-level merge.
 *
 * Per-field rather than per-block: a role that sets only `tier` keeps the
 * default's backend and model. Merging whole blocks would make `tier` silently
 * reset them, which is the kind of config behaviour that gets discovered in
 * production.
 */
export function resolveRoleBackend(role, input = {}) {
    const own = input.roles?.[role] ?? {};
    const fallback = input.default ?? {};
    const backend = own.backend ?? fallback.backend ?? DEFAULT_BACKEND;
    const model = own.model ?? fallback.model;
    const tier = own.tier ?? fallback.tier ?? "strong";
    const { provider } = model ? splitModelId(model) : {};
    return {
        role,
        backend,
        model,
        provider,
        tier,
        inherited: own.backend === undefined && own.model === undefined,
    };
}
export function resolveAllRoles(input = {}) {
    const out = {};
    for (const role of ROLE_NAMES)
        out[role] = resolveRoleBackend(role, input);
    return out;
}
/**
 * Every problem in the configuration, not just the first.
 *
 * Returns a list rather than throwing so the caller decides what is fatal.
 * A missing provider block is fatal; a `default` tier below a role's floor is
 * fatal for that role only, and reporting it alongside the others lets an
 * operator fix the whole file in one edit instead of eight startup attempts.
 */
export function validateRoleConfig(input = {}) {
    const problems = [];
    const providers = input.providers ?? {};
    for (const [id, p] of Object.entries(providers)) {
        if (p.npm && !SUPPORTED_PROVIDER_NPM.includes(p.npm)) {
            problems.push({
                provider: id,
                message: `provider '${id}' declares npm '${p.npm}'; supported: ${SUPPORTED_PROVIDER_NPM.join(", ")}`,
            });
        }
        if (!p.base_url) {
            // Required only for the compat shim, which has no endpoint of its own. A
            // provider naming neither package nor URL is a built-in, and demanding a
            // base_url for it would mean writing down an address OpenCode already
            // knows, in a field that exists to override it.
            if (resolveProviderNpm(p) === "@ai-sdk/openai-compatible") {
                problems.push({ provider: id, message: `provider '${id}' has no base_url` });
            }
        }
        else if (!/^https?:\/\//.test(p.base_url)) {
            problems.push({ provider: id, message: `provider '${id}' base_url must be an http(s) URL` });
        }
        else if (!p.base_url.replace(/\/+$/, "").endsWith("/v1")) {
            // See ProviderConfig.base_url: the shim appends a path, so a missing
            // version segment is a 404 on the first call and nothing before it.
            problems.push({
                provider: id,
                message: `provider '${id}' base_url should end in /v1 (got '${p.base_url}')`,
            });
        }
    }
    for (const role of ROLE_NAMES) {
        const r = resolveRoleBackend(role, input);
        if (!BACKEND_IDS.includes(r.backend)) {
            problems.push({ role, message: `role '${role}' names unknown backend '${r.backend}'` });
            continue;
        }
        // A qualified model must address a provider that exists — unless it is a
        // provider the backend itself ships with, which we cannot enumerate. Only
        // custom providers are checkable, so only they are checked: a false
        // rejection of `anthropic/claude-x` would be worse than a missed typo.
        if (r.provider && providers[r.provider] === undefined && r.backend === "opencode") {
            const known = Object.keys(providers);
            if (known.length > 0) {
                problems.push({
                    role,
                    provider: r.provider,
                    message: `role '${role}' uses provider '${r.provider}', which is not declared in 'providers' ` +
                        `(declared: ${known.join(", ")}). If it is a built-in OpenCode provider, this is fine; ` +
                        `if it is a typo, it is not.`,
                });
            }
        }
        // The floor. Only the judgement roles have one above `basic`, and the
        // reasoning is in ROLE_MIN_TIER: these are the roles whose failures are
        // well-formed and therefore invisible.
        const floor = ROLE_MIN_TIER[role];
        if (!tierAtLeast(r.tier, floor)) {
            problems.push({
                role,
                message: `role '${role}' is declared tier '${r.tier}' but requires at least '${floor}'. ` +
                    `A weak model in this role returns a confident, well-formed, wrong answer.`,
            });
        }
        // The structured roles need no tools, so any backend can host them. The
        // agentic ones need a permission callback, and that is a backend property
        // checked live at startup by the M6 probe — not here, because a
        // declaration is exactly what that probe exists to distrust.
        if (r.backend === "opencode" && !r.model && ROLE_SHAPES[role] === "structured") {
            problems.push({
                role,
                message: `role '${role}' runs on opencode with no model set; opencode has no default the harness can assume`,
            });
        }
    }
    return problems;
}
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
export function buildProviderBlock(providers, resolveKey) {
    const block = {};
    const dropped = [];
    for (const [id, p] of Object.entries(providers ?? {})) {
        const options = {};
        if (p.base_url)
            options.baseURL = p.base_url;
        if (p.api_key_service) {
            const key = resolveKey(p.api_key_service);
            if (!key) {
                dropped.push({ provider: id, reason: `no credential '${p.api_key_service}' in the vault` });
                continue;
            }
            // Literal, not `{env:NAME}`. The env-substitution form would require the
            // key to be in the child's environment, and the whole point of carrying
            // it inside this document is that it is the one secret allowed through.
            options.apiKey = key;
        }
        // Absent when the provider is one OpenCode ships: naming a package there
        // would override its own, which for OpenAI means swapping the SDK that
        // sends `max_completion_tokens` for the one that sends `max_tokens`.
        const npm = resolveProviderNpm(p);
        const entry = npm ? { npm, options } : { options };
        if (p.name)
            entry.name = p.name;
        if (p.models)
            entry.models = p.models;
        block[id] = entry;
    }
    return { block, dropped };
}
/** Providers an operator declared local, so cost reporting stays token-only. */
export function localProviders(providers = {}) {
    return new Set(Object.entries(providers).filter(([, p]) => p.local).map(([id]) => id));
}
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
export function pricingModelId(model, providers = {}) {
    const { provider, model: bare } = splitModelId(model);
    if (!provider)
        return model;
    const mapped = providers[provider]?.pricing_provider;
    return mapped ? `${mapped}/${bare}` : model;
}
//# sourceMappingURL=role-config.js.map