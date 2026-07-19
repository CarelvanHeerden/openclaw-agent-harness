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
    /**
     * beta.24: harness log verbosity. When `level: 'debug'`, error log sites
     * (crystallise, lead SDK, worker SDK, adversary SDK, git vault lookup,
     * pr-watcher) log full error objects instead of one-line summaries.
     * Defaults to 'info' (pre-beta.24 behaviour).
     */
    logging: LoggingConfig;
}
export interface LoggingConfig {
    level: "debug" | "info" | "warn" | "error";
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
    /**
     * beta.36: hard daily spend ceiling (USD). Used as the basis for the
     * post-merge deploy-repair budget (`vercel.deploy_repair.budget_ratio` of
     * this). Must be >= daily_warn_usd. Default 200.
     */
    daily_max_usd: number;
    monthly_warn_ratio: number;
}
export interface ReposConfig {
    allowed: string[];
    can_create: boolean;
    create_org: string;
    create_visibility: "private" | "public";
    default_base_branch: string;
    /**
     * beta.32: when the adversary verdict is not a clean "pass", open the PR
     * as a GitHub *draft*. Default FALSE. Draft PRs are rejected with HTTP 422
     * on repos that don't support them (private repos on free plans, some repo
     * types), which would kill the run at the very last step. Even when true,
     * the live path retries as a non-draft PR on a 422 rather than failing.
     * The verdict warning always goes in the PR body regardless of draft state.
     */
    draft_pr_on_nonpass?: boolean;
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
    /**
     * beta.40: stuck-loop reclaim threshold (seconds). The beta.38 re-entrancy
     * guard (`runningSessions`) is module-scoped and survives a plugin
     * re-register, but the loop it tracks can be torn down WITH the old runtime
     * on re-register -- leaving a zombie entry that permanently blocks recovery
     * from re-driving the session (Staging beta.39 smoke: session 07e4c28a wedged
     * silently for 110 min after the guard fired). When `run()` is asked to start
     * a session still marked running, but its `last_checkpoint_at`/`updated_at`
     * has not advanced for THIS many seconds, the tracked loop is treated as dead:
     * the stale entry is force-cleared and the fresh run proceeds. Must be safely
     * larger than a normal long worker SDK call so a legitimately-busy loop is
     * never reclaimed. Default 2700 (45 min).
     */
    stuck_loop_seconds: number;
    /**
     * beta.41: max seconds teardown() waits for a still-running loop from the
     * runtime being torn down to finish before closing its state DB. A plugin
     * re-register (OKF / gateway auto-discovery churn when `plugins.allow` is
     * empty) schedules a fire-and-forget teardown of the previous runtime;
     * closing the DB out from under an in-flight `loop.run()` throws "database is
     * not open" and crashes the run (killed the beta.39 + beta.40 ProjectThanos
     * smokes at exactly this point). We drain running loops first, bounded by
     * this timeout. Default 3600 (1 h) -- long enough for any real run, bounded
     * so a genuinely-wedged loop can't block teardown forever.
     */
    teardown_drain_seconds: number;
    /**
     * beta.42: active stall-watchdog delay (seconds). When the re-entrancy guard
     * SKIPS a re-entry (loop.run_skipped_already_running), it arms a timer for
     * this long, then re-checks the session's last_checkpoint_at/updated_at. If
     * no forward progress AND the guard handle is still present, the tracked loop
     * is wedged with no external re-entry to reclaim it -- the stale handle is
     * force-deregistered (loop.wedge_detected) so recovery/next-run can take
     * over. beta.40's reclaim was passive (only re-checked on a subsequent run()
     * call); this makes it active. Should be short relative to a full run but
     * longer than a normal event gap. Default 90s.
     */
    stall_watchdog_seconds: number;
}
export interface VercelConfig {
    enabled: boolean;
    credential_service: string;
    /**
     * beta.34: env-var fallback for the Vercel token, mirroring the GitHub /
     * Anthropic pattern. Read only if `credential_service` is unset or the
     * vault lookup fails/returns empty. Lets vault-less deployments (e.g. the
     * env-only Staging container, which has no memory-hybrid vault) supply the
     * token via env instead of losing it. Default: "VERCEL_TOKEN".
     */
    api_key_env?: string;
    team_id?: string;
    project_id: string;
    preview_wait_seconds: number;
    /**
     * beta.36: post-merge deploy-repair loop. When Vercel is configured and a
     * merged PR's deployment comes back ERROR, the harness auto-attempts fixes
     * (up to `max_attempts` new PRs) driven by the Vercel build logs. If it
     * still fails, it reverts ALL merges (main PR + every repair PR) and leaves
     * the last attempt as an open PR for human review.
     */
    deploy_repair?: DeployRepairConfig;
}
export interface DeployRepairConfig {
    /** Master switch. Default true when a vercel block is present. */
    enabled: boolean;
    /** Max repair PRs before giving up and reverting. Default 3. */
    max_attempts: number;
    /**
     * Repair budget as a fraction of `budgets.daily_max_usd`. The whole repair
     * loop (all attempts) shares this pool; if exhausted mid-loop, the harness
     * reverts to a working `main` and pauses for the user's go-ahead. Default
     * 0.25 (25% of daily max). User-overridable per invocation via the
     * `harness_merge_pr` `repairBudgetUsd` param.
     */
    budget_ratio: number;
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
export type GitProvider = "github" | "gitlab";
/**
 * A token pointer. Exactly one of `value` | `env` | `vault` must be set.
 *   - value: inline secret in openclaw.json (single-operator; setter accepts risk)
 *   - env:   name of an environment variable holding the token
 *   - vault: credential-vault service name (requires memory-hybrid plugin)
 */
export interface TokenPointer {
    value?: string;
    env?: string;
    vault?: string;
}
/**
 * A person node in the hierarchical `pat_routing.<provider>.<org>.<person>`
 * tree. Colocates everything about one requester's authority for one org:
 * the token to commit under, the git commit identity, and the Slack user id
 * that maps an inbound request to this person.
 */
export interface PersonToken {
    /** Token pointer: one of value | env | vault. */
    token: TokenPointer;
    /** Git commit author name. Required. */
    name: string;
    /** Git commit author email. Required (validated at config load). */
    email: string;
    /**
     * Slack user id for this person. In vault / self-write tiers OpenClaw
     * captures this automatically from the inbound message. In the manual
     * copy-paste tier the operator must fill it in by hand.
     */
    slack_user_id?: string;
}
export interface PatRoutingConfig {
    /**
     * beta.25 hierarchical routing. Keyed by provider, then repo owner/org,
     * then person key. Person is matched to the requester via
     * `PersonToken.slack_user_id`. Takes precedence over the legacy flat
     * fields below. Example:
     *   { github: { "stitch-vercel": { "Janice": { token: {env:"..."}, name, email, slack_user_id } } } }
     */
    github?: Record<string, Record<string, PersonToken>>;
    gitlab?: Record<string, Record<string, PersonToken>>;
    overrides: Record<string, Record<string, string>>;
    commit_identity: Record<string, {
        name: string;
        email: string;
    }>;
    /**
     * Per-user provider logins, keyed by Slack user id. Enables true
     * per-requester tokens: the `{requester}` placeholder resolves to the
     * requesting user's login for the active provider.
     *   { "U07...": { github: "carelvanheerden", gitlab: "cvh" } }
     */
    user_identities?: Record<string, Partial<Record<GitProvider, string>>>;
    /**
     * Provider selection. `default_provider` is used when a repo's provider
     * can't be inferred. `provider_by_owner` pins specific owners to a
     * provider (e.g. a GitLab group). Default provider: github.
     */
    default_provider?: GitProvider;
    provider_by_owner?: Record<string, GitProvider>;
    /** Per-provider settings (API base + env fallback var). Sensible defaults applied. */
    providers?: Partial<Record<GitProvider, ProviderConfig>>;
    /**
     * Template for the vault credential service name. Placeholders:
     *   {owner} - repo owner (org or user), e.g. "CarelvanHeerden"
     *   {repo}  - repo name, e.g. "openclaw-agent-harness"
     *   {user}  - requester's GitHub login (deprecated alias; for a personal
     *             repo this equals {owner}, which is why the old default
     *             "github-{user}-{org}" collapsed to a duplicated segment)
     *   {org}   - repo owner (deprecated alias of {owner})
     * Default: "github-{owner}" (per-owner tokens). All placeholders are
     * lower-cased.
     */
    default_service_pattern: string;
    /**
     * Legacy single-provider GitHub auth fallback. Superseded by
     * `providers.github.api_key_env` but kept for back-compat; if set it wins
     * for GitHub.
     */
    auth?: PatAuthConfig;
}
export interface ProviderConfig {
    /** REST API base, e.g. "https://api.github.com" or "https://gitlab.com/api/v4". */
    api_base: string;
    /** Env var holding a token for this provider, used as vault fallback. */
    api_key_env: string;
}
export interface PatAuthConfig {
    /**
     * Name of the environment variable holding a GitHub token, used when the
     * vault lookup for the resolved service fails or returns nothing.
     * Default: "GH_TOKEN". Lets vault-less deployments just set GH_TOKEN.
     */
    api_key_env?: string;
}
/**
 * beta.25: validate the hierarchical pat_routing tree. Each person node must
 * carry a name, a real-looking email, and exactly one token pointer
 * (value|env|vault). Fails loud at config load so the operator never
 * discovers a missing email mid-run.
 */
export declare function validatePatHierarchy(pr: PatRoutingConfig): void;
export declare function parseHarnessConfig(input: unknown): HarnessConfig;
//# sourceMappingURL=config.d.ts.map