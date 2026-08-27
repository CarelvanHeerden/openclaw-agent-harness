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

import { ROLE_SHAPES, type RoleName } from "./backend.js";
import type { StructuredExecParams, StructuredExecResult, StructuredExecutor } from "./claude-code.js";
import {
  buildProviderBlock,
  localProviders,
  resolveAllRoles,
  validateRoleConfig,
  type ProviderConfig,
  type ResolvedRoleBackend,
  type RoleBackendConfig,
} from "./role-config.js";
import { openCodeConfigEnv } from "./opencode-config.js";
import { PINNED_OPENCODE_VERSION } from "./opencode-version.js";
import { preflightAcpBackendLive, runStructuredAcp, type AcpAgentSpec } from "./acp.js";
import {
  costOf,
  refreshCatalogue,
  resolvePrice,
  type Catalogue,
  type CatalogueStore,
} from "./shared/model-catalogue.js";

export class BackendConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`backend configuration is not usable:\n  - ${problems.join("\n  - ")}`);
    this.name = "BackendConfigError";
  }
}

export interface BackendRouterInput {
  backends?: { default?: RoleBackendConfig } & Partial<Record<RoleName, RoleBackendConfig>>;
  providers?: Record<string, ProviderConfig>;
  /** Resolves a vault service name to a secret. Never the secret itself. */
  resolveKey: (service: string) => string | undefined;
  /** Scratch directory for tool-less roles, which still need a cwd. */
  scratchDir: string;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
  audit: (event: string, payload: unknown) => void;
  /** Overridable for tests; defaults to launching the pinned OpenCode. */
  openCodeCommand?: { command: string; args: string[] };
}

/** How OpenCode is launched when the operator has not said otherwise. */
export function defaultOpenCodeCommand(): { command: string; args: string[] } {
  // `opencode` on PATH, which the Dockerfile installs at the pinned version.
  // Not `npx -y opencode-ai@latest`: that puts a network fetch on the startup
  // path of every session and lets whoever published most recently decide what
  // the worker's tool calls flow through.
  return { command: "opencode", args: ["acp"] };
}

export class BackendRouter {
  private readonly roles: Record<RoleName, ResolvedRoleBackend>;
  private readonly providerBlock: Record<string, unknown>;
  private readonly local: ReadonlySet<string>;
  private probed = false;
  private catalogue: Catalogue | undefined;

  constructor(private readonly input: BackendRouterInput) {
    const cfg = {
      default: input.backends?.default,
      roles: input.backends as Partial<Record<RoleName, RoleBackendConfig>> | undefined,
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
  get openCodeRoles(): RoleName[] {
    return (Object.keys(this.roles) as RoleName[]).filter((r) => this.roles[r].backend === "opencode");
  }

  get usesOpenCode(): boolean {
    return this.openCodeRoles.length > 0;
  }

  backendFor(role: RoleName): ResolvedRoleBackend {
    return this.roles[role];
  }

  /** True when this role's provider bills nothing, so cost must stay absent. */
  isLocal(role: RoleName): boolean {
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
  priceTurn(
    role: RoleName,
    usage: { usageSource: "acp-delta" | "tokens-only" | "unavailable"; costUsd: number; tokensIn: number; tokensOut: number },
  ): { costUsd?: number; priceSource: string } {
    if (usage.usageSource === "unavailable") return { costUsd: undefined, priceSource: "unmeasured" };
    if (usage.usageSource === "acp-delta") return { costUsd: usage.costUsd, priceSource: "agent" };

    const model = this.roles[role].model;
    if (!model) return { costUsd: undefined, priceSource: "unmeasured" };

    const res = resolvePrice({
      model,
      catalogue: this.catalogue,
      localProviders: this.local,
    });
    // `costOf` returns undefined for a non-billable model. That is a real zero
    // — a local endpoint issues no invoice — as distinct from the `undefined`
    // above, which means nobody measured.
    if (!res.billable) return { costUsd: 0, priceSource: "local" };
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
  async refreshPricing(store: CatalogueStore): Promise<void> {
    try {
      this.catalogue = await refreshCatalogue({
        store,
        audit: (event, payload) => this.input.audit(event, payload),
      });
    } catch (err) {
      this.input.logger.warn(`[backend] pricing refresh failed, continuing on cache: ${String(err)}`);
    }
  }

  /** The agent spec for a role, carrying the generated OpenCode configuration. */
  agentSpecFor(role: RoleName): AcpAgentSpec {
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
  async preflight(): Promise<void> {
    if (this.probed || !this.usesOpenCode) return;

    const role = this.openCodeRoles[0];
    if (!role) return;

    const result = await preflightAcpBackendLive({
      agentId: "opencode",
      // The configuration we are about to hand the agent, so the static half
      // of the preflight inspects the real document rather than a guess.
      backendConfig: JSON.parse(
        this.agentSpecFor(role).env?.OPENCODE_CONFIG_CONTENT ?? "{}",
      ) as unknown,
      agent: this.agentSpecFor(role),
      cwd: this.input.scratchDir,
      model: this.roles[role].model,
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
      throw new Error(
        `the OpenCode backend failed its startup capability probe: ${result.detail ?? "no detail"}. ` +
        `Roles ${this.openCodeRoles.join(", ")} would run with the harness guard never consulted, ` +
        `so the harness refuses to start rather than run them unguarded.`,
      );
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
  executorFor(role: RoleName): StructuredExecutor | undefined {
    if (this.roles[role].backend !== "opencode") return undefined;
    const r = this.roles[role];
    const agent = this.agentSpecFor(role);
    const { logger } = this.input;

    return async <T>(params: StructuredExecParams<T>): Promise<StructuredExecResult<T>> => {
      const out = await runStructuredAcp<T>({
        agent,
        role,
        cwd: this.input.scratchDir,
        systemPrompt: params.systemPrompt,
        userMessage: params.userMessage,
        // The role's configured model wins: `params.model` is the Anthropic id
        // from `models.*`, which means nothing to another provider.
        model: r.model ?? params.model,
        timeoutSeconds: params.timeoutSeconds,
        streamOpenTimeoutSeconds: params.streamOpenTimeoutSeconds,
        validation: params.validation ?? { requiredKeys: [], label: role },
        logger,
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
        raw: "",
        stopReason: null,
      };
    };
  }

  /** A one-line summary per role, for the startup log and the audit trail. */
  describe(): Array<{ role: RoleName; backend: string; model?: string; tier: string }> {
    return (Object.keys(this.roles) as RoleName[]).map((role) => ({
      role,
      backend: this.roles[role].backend,
      model: this.roles[role].model,
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
export function buildBackendRouter(input: BackendRouterInput): BackendRouter | undefined {
  const declared = input.backends && Object.keys(input.backends).length > 0;
  if (!declared) return undefined;
  const router = new BackendRouter(input);
  return router.usesOpenCode ? router : undefined;
}
