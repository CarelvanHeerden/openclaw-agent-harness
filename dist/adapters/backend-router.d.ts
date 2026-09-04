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
import { type RoleName } from "./backend.js";
import type { StructuredExecutor } from "./claude-code.js";
import { type ProviderConfig, type ResolvedRoleBackend, type RoleBackendConfig } from "./role-config.js";
import { type AcpAgentSpec } from "./acp.js";
import { type CatalogueStore, type ModelPrice } from "./shared/model-catalogue.js";
export interface EffectiveBackendRoute {
    role: RoleName;
    backend: "claude-code" | "opencode";
    provider: string;
    model?: string;
    effort?: string;
    tier: string;
}
export declare class BackendConfigError extends Error {
    readonly problems: string[];
    constructor(problems: string[]);
}
export interface BackendRouterInput {
    backends?: {
        default?: RoleBackendConfig;
    } & Partial<Record<RoleName, RoleBackendConfig>>;
    providers?: Record<string, ProviderConfig>;
    /** Resolves a vault service name to a secret. Never the secret itself. */
    resolveKey: (service: string) => string | undefined;
    /** Scratch directory for tool-less roles, which still need a cwd. */
    scratchDir: string;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
    audit: (event: string, payload: unknown) => void;
    /** Overridable for tests; defaults to launching the pinned OpenCode. */
    openCodeCommand?: {
        command: string;
        args: string[];
    };
    /**
     * `models.price_overrides`, the top of the resolution ladder.
     *
     * Passed in because it was not. `resolvePrice` accepts overrides and honours
     * them above everything else, and this router called it without them — so
     * the documented escape hatch for a model the catalogue does not price was
     * inert on the one backend most likely to run such a model. An operator
     * following the advice in the startup pricing warning would have seen no
     * change and no reason why.
     */
    priceOverrides?: Record<string, ModelPrice>;
}
/**
 * Where the OpenCode executable came from. `dependency` is the only one that
 * carries a version guarantee; `path` is whatever the machine happens to have.
 */
export type OpenCodeBinarySource = "dependency" | "path";
export interface ResolvedOpenCodeBinary {
    command: string;
    source: OpenCodeBinarySource;
    /** Why the dependency was not used. Present only when `source` is `path`. */
    reason?: string;
}
/**
 * Locate the OpenCode executable, preferring the copy npm installed for us.
 *
 * v2.0.0-rc.1 shipped this as the bare string `opencode` and relied on the
 * standalone Dockerfile's `npm install --global opencode-ai@1.18.23` to put it
 * on PATH. That is fine for the image and wrong everywhere else: OpenClaw
 * installs a plugin with `npm install --omit=dev` and never builds our
 * Dockerfile, so on a plugin install the pinned agent was simply absent and
 * `opencode-ai` was not in `dependencies` for npm to fetch. The backend was
 * unreachable on the installation path most operators actually use.
 *
 * Resolving through `require.resolve` rather than PATH also makes the version
 * pin mean something. A PATH lookup finds whatever `opencode` the machine has
 * — a different major, a shim, a stale global — and
 * `src/adapters/opencode-version.ts` can only warn about it after the fact.
 * The dependency is resolved from our own `node_modules`, so it is the version
 * `package.json` names.
 *
 * The PATH fallback stays because the Docker image and existing developer
 * machines already work that way, and removing it would break them to fix a
 * different problem. It is reported, not silent: `source` tells the caller
 * which one it got, so an operator can see that the pin is not in force.
 */
export declare function resolveOpenCodeBinary(requireFn?: (id: string) => string, exists?: (p: string) => boolean): ResolvedOpenCodeBinary;
/** How OpenCode is launched when the operator has not said otherwise. */
export declare function defaultOpenCodeCommand(): {
    command: string;
    args: string[];
};
export declare class BackendRouter {
    private readonly input;
    private readonly roles;
    private readonly providerBlock;
    private readonly local;
    private probed;
    private catalogue;
    /** Models already reported as unpriced, so the warning fires once, not per turn. */
    private readonly failSafeWarned;
    /** Resolved on first use, because resolution touches the filesystem. */
    private openCodeBinary;
    constructor(input: BackendRouterInput);
    /** Roles the operator has moved off the default backend. */
    get openCodeRoles(): RoleName[];
    get usesOpenCode(): boolean;
    backendFor(role: RoleName): ResolvedRoleBackend;
    /** True when this role's provider bills nothing, so cost must stay absent. */
    isLocal(role: RoleName): boolean;
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
    priceTurn(role: RoleName, usage: {
        usageSource: "acp-delta" | "tokens-only" | "unavailable";
        costUsd: number;
        tokensIn: number;
        tokensOut: number;
    }): {
        costUsd?: number;
        priceSource: string;
    };
    /**
     * Refresh the pricing catalogue, off the hot path and never fatal.
     *
     * Pricing being stale is a reporting problem; pricing being unreachable must
     * not be a run problem. A rejected or unreachable refresh keeps whatever
     * cache was already good, and the resolution ladder falls back to the
     * built-in table below that.
     */
    refreshPricing(store: CatalogueStore): Promise<void>;
    /**
     * The launcher, resolved once and reported once.
     *
     * Falling back to PATH is legitimate but means the version pin is not in
     * force, and that is exactly the kind of thing that should not be inferred
     * from silence afterwards.
     */
    private openCodeCommandSpec;
    /** The agent spec for a role, carrying the generated OpenCode configuration. */
    agentSpecFor(role: RoleName): AcpAgentSpec;
    /**
     * Prove the guard is live before any role is allowed onto OpenCode.
     *
     * Idempotent, and a failure THROWS. Returning a degraded router that quietly
     * fell back to Claude Code would be the wrong kindness: the operator asked
     * for a specific configuration, and running a different one while reporting
     * success is how a cost or capability surprise gets attributed to the wrong
     * thing three weeks later.
     */
    preflight(): Promise<void>;
    /**
     * The executor for a structured role, or `undefined` to use the SDK default.
     *
     * `undefined` rather than an SDK-shaped wrapper so that the Claude Code path
     * is byte-for-byte what it was before this module existed. A role nobody
     * moved should not acquire a new layer.
     */
    executorFor(role: RoleName): StructuredExecutor | undefined;
    /** A one-line summary per role, for the startup log and the audit trail. */
    describe(fallbackModelForRole?: (role: RoleName) => string | undefined): EffectiveBackendRoute[];
}
/**
 * Build a router, or `undefined` when nothing is configured.
 *
 * `undefined` is the v1 path, unchanged and untouched. An install that never
 * mentions backends does not get a router, does not run a probe, and does not
 * pay for a code path it is not using.
 */
export declare function buildBackendRouter(input: BackendRouterInput): BackendRouter | undefined;
//# sourceMappingURL=backend-router.d.ts.map