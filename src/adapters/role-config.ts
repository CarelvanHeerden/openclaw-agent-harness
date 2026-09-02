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

import {
  ROLE_MIN_TIER,
  ROLE_NAMES,
  ROLE_SHAPES,
  tierAtLeast,
  type CapabilityTier,
  type RoleName,
} from "./backend.js";

/** The backends a role can name. Extending this is a deliberate act. */
export type BackendId = "claude-code" | "opencode";

export const BACKEND_IDS: readonly BackendId[] = ["claude-code", "opencode"] as const;

/**
 * The default when nothing says otherwise.
 *
 * `claude-code` rather than "whatever is configured first", because v2 must be
 * a no-op for a v1 operator who upgrades and changes nothing. An install that
 * never mentions backends behaves exactly as it did.
 */
export const DEFAULT_BACKEND: BackendId = "claude-code";

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
   * Backend reasoning effort/variant. OpenCode exposes this as the ACP
   * `thought_level` config option (currently id `effort`). Undefined preserves
   * the backend default; agentic reasoning models should normally use at least
   * `medium`.
   */
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * What the operator asserts this model can do. See `CapabilityTier`: it is a
   * declaration, not a measurement, and it exists so the three judgement roles
   * can refuse a model the operator has not vouched for.
   */
  tier?: CapabilityTier;
}

export interface ProviderConfig {
  /**
   * The AI-SDK package.
   *
   * Absent has two meanings, and `resolveProviderNpm` is where they are told
   * apart. With a `base_url` it means "the OpenAI-compatible shim against my
   * endpoint", which is the original behaviour. Without one it means "a
   * provider OpenCode already ships — I am only supplying the key", and
   * nothing is emitted so OpenCode uses its own.
   *
   * That second case is not a convenience. `@ai-sdk/openai-compatible` sends
   * `max_tokens`, and every OpenAI reasoning model rejects it outright:
   * `Unsupported parameter: 'max_tokens' is not supported with this model.
   * Use 'max_completion_tokens' instead.` The turn dies inside OpenCode with
   * no text, which then reads as a capability-probe failure — the first
   * all-roles run on OpenAI failed in nine seconds that way. `@ai-sdk/openai`
   * sends the right parameter, and it reports per-turn cost as well, so usage
   * arrives as `acp-delta` rather than tokens we price ourselves.
   */
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
  models?: Record<string, { name?: string }>;
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
  /** Requested ACP thought level, inherited per-field like model and tier. */
  effort?: RoleBackendConfig["effort"];
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
export function splitModelId(model: string): { provider?: string; model: string } {
  const i = model.indexOf("/");
  if (i <= 0 || i === model.length - 1) return { model };
  return { provider: model.slice(0, i), model: model.slice(i + 1) };
}

/** The AI-SDK packages a provider may name. Extending this needs a live turn to prove it. */
export const SUPPORTED_PROVIDER_NPM = ["@ai-sdk/openai-compatible", "@ai-sdk/openai"] as const;

/**
 * Which package a provider block will actually load, or `undefined` for one
 * OpenCode already knows.
 *
 * Single-sourced because `validateRoleConfig` and `buildProviderBlock` both
 * need the answer, and the failure mode when they disagree is a configuration
 * that validates and then runs as something else.
 */
export function resolveProviderNpm(p: ProviderConfig): string | undefined {
  if (p.npm) return p.npm;
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
export function resolveRoleBackend(role: RoleName, input: RolesConfigInput = {}): ResolvedRoleBackend {
  const own = input.roles?.[role] ?? {};
  const fallback = input.default ?? {};

  const backend = own.backend ?? fallback.backend ?? DEFAULT_BACKEND;
  const model = own.model ?? fallback.model;
  const effort = own.effort ?? fallback.effort;
  const tier = own.tier ?? fallback.tier ?? "strong";

  const { provider } = model ? splitModelId(model) : {};

  return {
    role,
    backend,
    model,
    effort,
    provider,
    tier,
    inherited: own.backend === undefined && own.model === undefined,
  };
}

export function resolveAllRoles(input: RolesConfigInput = {}): Record<RoleName, ResolvedRoleBackend> {
  const out = {} as Record<RoleName, ResolvedRoleBackend>;
  for (const role of ROLE_NAMES) out[role] = resolveRoleBackend(role, input);
  return out;
}

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
export function validateRoleConfig(input: RolesConfigInput = {}): RoleConfigProblem[] {
  const problems: RoleConfigProblem[] = [];
  const providers = input.providers ?? {};

  for (const [id, p] of Object.entries(providers)) {
    if (p.npm && !(SUPPORTED_PROVIDER_NPM as readonly string[]).includes(p.npm)) {
      problems.push({
        provider: id,
        message:
          `provider '${id}' declares npm '${p.npm}'; supported: ${SUPPORTED_PROVIDER_NPM.join(", ")}`,
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
    } else if (!/^https?:\/\//.test(p.base_url)) {
      problems.push({ provider: id, message: `provider '${id}' base_url must be an http(s) URL` });
    } else if (!p.base_url.replace(/\/+$/, "").endsWith("/v1")) {
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
          message:
            `role '${role}' uses provider '${r.provider}', which is not declared in 'providers' ` +
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
        message:
          `role '${role}' is declared tier '${r.tier}' but requires at least '${floor}'. ` +
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
export function buildProviderBlock(
  providers: Record<string, ProviderConfig>,
  resolveKey: (service: string) => string | undefined,
): { block: Record<string, unknown>; dropped: { provider: string; reason: string }[] } {
  const block: Record<string, unknown> = {};
  const dropped: { provider: string; reason: string }[] = [];

  for (const [id, p] of Object.entries(providers ?? {})) {
    const options: Record<string, unknown> = {};
    if (p.base_url) options.baseURL = p.base_url;

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
    const entry: Record<string, unknown> = npm ? { npm, options } : { options };
    if (p.name) entry.name = p.name;
    if (p.models) entry.models = p.models;
    block[id] = entry;
  }

  return { block, dropped };
}

/** Providers an operator declared local, so cost reporting stays token-only. */
export function localProviders(providers: Record<string, ProviderConfig> = {}): Set<string> {
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
export function pricingModelId(model: string, providers: Record<string, ProviderConfig> = {}): string {
  const { provider, model: bare } = splitModelId(model);
  if (!provider) return model;
  const mapped = providers[provider]?.pricing_provider;
  return mapped ? `${mapped}/${bare}` : model;
}
