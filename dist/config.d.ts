/**
 * Plugin configuration types + parser.
 *
 * The parser is used both by the plugin's `configSchema.parse` hook and by
 * `bootstrapHarness()` at register time. It is intentionally strict on the
 * critical safety fields (allow-lists, budgets) and permissive on the rest
 * (falls back to sensible defaults).
 */
export interface HarnessConfig {
    slack: SlackConfig;
    budgets: BudgetsConfig;
    repos: ReposConfig;
    models: ModelsConfig;
    loop: LoopConfig;
    vercel: VercelConfig;
    storage: StorageConfig;
    safety: SafetyConfig;
    pat_routing: PatRoutingConfig;
}
export interface SlackConfig {
    /**
     * When true, the plugin subscribes to `message_received` and treats
     * allow-listed messages in `channel` as dev requests (autonomous mode).
     *
     * When false (DEFAULT), the plugin does NOT listen to Slack at all. The
     * OpenClaw agent orchestrates everything by calling the harness tools
     * (`harness_run`, `harness_status`, ...). This is the recommended mode:
     * you talk to the OpenClaw agent, and the agent drives the harness.
     */
    listener_enabled: boolean;
    channel: string;
    authorised_users: string[];
    /** Vault service name for the Slack bot token (used by reactions poller + adapter fallback). Optional; if unset, poller stays idle. */
    credential_service?: string;
    /** Interval for reactions poller in ms. Default 15000. */
    reactions_poll_ms?: number;
    reactions: {
        ship_it: string;
        abort: string;
        pause: string;
        budget_bump: string;
    };
}
export interface BudgetsConfig {
    monthly_per_user_usd: number;
    session_default_usd: number;
    session_hard_ceiling_usd: number;
    daily_warn_usd: number;
    monthly_warn_ratio: number;
}
export interface ReposConfig {
    allowed: string[];
    can_create: boolean;
    create_org: string;
    create_visibility: "private" | "public";
    default_base_branch: string;
}
export interface ModelsConfig {
    lead: string;
    worker: string;
    adversary: string;
    classifier: string;
    /** Optional per-model price overrides for cost estimation. Set when Anthropic ships new pricing before we release. Keys are model ids (e.g. 'claude-fable-5'). Values are USD per million tokens. */
    price_overrides?: Record<string, {
        input: number;
        output: number;
    }>;
    /**
     * Anthropic auth for the embedded `@anthropic-ai/claude-agent-sdk`.
     *
     * The SDK spawns the bundled Claude Code binary as a subprocess. With no
     * explicit key it falls back to Claude Code's interactive `/login` session
     * store, which does not exist in a headless container -> the lead planner
     * dies immediately with "Not logged in. Please run /login".
     *
     * We resolve a key (vault-first, then env) and inject it into the SDK
     * subprocess env as ANTHROPIC_API_KEY so no `/login` is ever needed.
     */
    auth?: ModelsAuthConfig;
}
export interface ModelsAuthConfig {
    /**
     * Vault credential service name holding the Anthropic API key (type
     * `api_key`). Resolved via the same credential path used for GitHub PATs.
     * Preferred over `api_key_env` when both are set.
     */
    credential_service?: string;
    /**
     * Name of the environment variable holding the Anthropic API key. Used
     * only if `credential_service` is unset or the vault lookup fails.
     * Default: "ANTHROPIC_API_KEY".
     */
    api_key_env?: string;
}
export interface LoopConfig {
    max_cycles: number;
    adversarial_pass_ends_early: boolean;
    worker_timeout_seconds: number;
    adversary_timeout_seconds: number;
    session_hard_timeout_seconds: number;
    /** Max sub-tasks a cycle will run concurrently. Default 1 (sequential). */
    subtask_concurrency: number;
}
export interface VercelConfig {
    enabled: boolean;
    credential_service: string;
    team_id?: string;
    project_id: string;
    preview_wait_seconds: number;
}
export interface StorageConfig {
    state_db_path: string;
    worktree_root: string;
    audit_retention_days: number;
    prune_terminal_sessions: boolean;
    prune_terminal_sessions_days: number;
}
export interface SafetyConfig {
    worker_permission_mode: "acceptEdits" | "bypassPermissions" | "plan";
    bash_whitelist: string[];
    bash_denylist_tokens: string[];
    path_denylist: string[];
    allow_git_push: boolean;
    allow_network_commands: boolean;
}
export interface PatRoutingConfig {
    overrides: Record<string, Record<string, string>>;
    commit_identity: Record<string, {
        name: string;
        email: string;
    }>;
    default_service_pattern: string;
}
export declare function parseHarnessConfig(input: unknown): HarnessConfig;
//# sourceMappingURL=config.d.ts.map