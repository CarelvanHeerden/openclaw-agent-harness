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
    /** beta.63 (convention-awareness Fix 1): brief construction / ingest tuning. */
    brief: BriefConfig;
    /** beta.63 (convention-awareness Fix 2): final-verify repo-check-script runner. */
    verify: VerifyConfig;
    pat_routing: PatRoutingConfig;
    /**
     * beta.24: harness log verbosity. When `level: 'debug'`, error log sites
     * (crystallise, lead SDK, worker SDK, adversary SDK, git vault lookup,
     * pr-watcher) log full error objects instead of one-line summaries.
     * Defaults to 'info' (pre-beta.24 behaviour).
     */
    logging: LoggingConfig;
    /**
     * beta.63 (Part B): durable, structured, append-only interaction log
     * written OUTSIDE the git worktree (in the harness data dir). Captures every
     * SDK/LLM call, state transition, verify probe, and stall/recovery event so a
     * near-completion failure leaves a complete, greppable trail that survives a
     * worktree release + container restart. Default ON.
     */
    log: LogConfig;
}
export interface LoggingConfig {
    level: "debug" | "info" | "warn" | "error";
}
export interface BriefConfig {
    /**
     * beta.63 (Fix 1): at brief build, ingest the checked-out repo's declared
     * convention files (.cursor/rules/**, .cursorrules, CONTRIBUTING.md,
     * CONVENTIONS.md, AGENTS.md, .github/CONTRIBUTING.md) into the optional brief
     * field `repoConventions[]` so the lead + worker + adversary SDK prompts
     * (which get NO OpenClaw context injection) explicitly carry them. Default true.
     */
    ingest_repo_conventions: boolean;
    /**
     * Total char budget for the ingested conventions block. When over budget, the
     * LONGEST sources are truncated first, with a note appended, rather than
     * dropping sources silently. Default 10000.
     */
    convention_char_budget: number;
}
export interface VerifyConfig {
    /**
     * beta.63 (Fix 2): the final-verify sub-task runs repo-declared check scripts
     * (from package.json#scripts) inline + blocking in the worktree. A non-zero
     * exit becomes a REVISE-worthy `loop.convention_check_failed` finding, NOT a
     * hard run-fail (the code may be correct and only a bundle stale). An
     * unrunnable / network-needing script is logged non-fatal + noted. Default true.
     */
    run_repo_check_scripts: boolean;
    /**
     * Allowlist of package.json script names the harness may run in final-verify.
     * A discovered script NOT on this list is NEVER run. Default
     * ["okf:check","lint","typecheck","test"].
     */
    check_script_allowlist: string[];
    /** Per-script wall-clock timeout (seconds). Default 600. */
    check_script_timeout_seconds: number;
    /**
     * beta.70 (F4): V8 heap ceiling (MB) applied via NODE_OPTIONS on the RETRY
     * after a check script dies of a heap OOM (exit 134 / "Ineffective
     * mark-compacts near heap limit"). On Thanos-scale repos `tsc --noEmit`
     * deterministically OOMs at the 4 GB default; 8 GB clears it. A persisted
     * OOM after the retry becomes a BLOCKING finding (was a silent false-green).
     * Default 8192.
     */
    check_script_heap_retry_mb?: number;
}
export interface LogConfig {
    /** Master switch for the interaction log. Default true. */
    interaction_log_enabled: boolean;
    /**
     * Directory for the JSONL logs. Default `<dataDir>/logs` where dataDir is the
     * directory holding the state DB (resolved at bootstrap; empty here means the
     * default is derived from storage.state_db_path).
     */
    dir: string;
    /**
     * When false (DEFAULT), only prompt SIZES + TAILS are logged, not full prompt
     * bodies (transcripts can be huge + sensitive). Set true for deep-debug.
     * NOTE: this does NOT disable secret redaction — redaction on write is
     * mandatory and always applied regardless of this flag.
     */
    full_prompts: boolean;
    /** Prune per-session log files older than this many days. Default 14. */
    retention_days: number;
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
    /**
     * beta.43: max seconds the lead-planner SDK call may run before it is treated
     * as a hang and the run fails cleanly. Like worker_timeout_seconds before
     * beta.42, the lead await was previously UNBOUNDED -- a hung planner froze
     * the run with no timeout. (This is the gap that made a healthy ~10min lead
     * call on the beta.42 ProjectThanos smoke look indistinguishable from a
     * wedge.) Default 900s.
     */
    lead_timeout_seconds: number;
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
    /**
     * beta.60: max wall-clock seconds a SINGLE sub-task's dispatch may run before
     * it is force-failed. beta.42 bounded only the worker SDK call
     * (worker_timeout_seconds); but runOne ALSO awaits unbounded git/IO between
     * the row-flip-to-running and the worker spawn -- notably worktreeHeadSha
     * (git rev-parse), readReactions, verifySubTaskOutput probes, and
     * budget.recordSpend. A hang in ANY of those wedges the whole dispatcher at
     * `await Promise.race(inFlight)` with the sub-task row stuck `running`,
     * `sdk_session_id=null`, `cost_usd=0`, and NO worker process ever spawned --
     * exactly the b59 PR#858 seq-7 stall (5h30m silent, no auto-recovery). This
     * bounds the ENTIRE runOne invocation, so no single IO await can freeze the
     * loop. Must be >= worker_timeout_seconds plus margin for pre/post-worker IO.
     * Default 2100 (35 min = 30 min worker + 5 min IO headroom).
     */
    subtask_deadline_seconds: number;
    /**
     * beta.61: fraction of the TOTAL session budget to hold in reserve for the
     * pending adversary review + packaging/push while a cycle's review has not
     * yet run. The pre-sub-task budget projection adds this reserve, so the loop
     * aborts EARLY (before starting a sub-task that would leave no room to finish
     * the cycle) rather than completing every sub-task and then dying one review
     * short of a PR -- exactly the b60 smoke failure (all findings addressed,
     * budget exhausted at cycle-2 seq-4, cycle-2 review never ran, no PR). Clamped
     * to [0, 0.9]. Default 0.15.
     */
    budget_reserve_ratio: number;
    /**
     * beta.53 (P1b): when a worker ends its turn awaiting a non-existent mid-turn
     * "Monitor event" (env-wait hallucination) and made no committed change,
     * re-invoke the sub-task ONCE with corrective context instead of failing the
     * whole run. Default true. Set false to disable the retry (still tags the
     * failure as loop.worker_env_wait_hallucination).
     */
    env_wait_retry_enabled?: boolean;
    /**
     * beta.55 (B2): when a worker refuses/confabulates a sub-task even after the
     * beta.54 async-coord retry, instead of hard-failing the whole run, pause the
     * session in `awaiting_clarification` (persisting the worker's own question/
     * reason + the paused seq) and surface it via harness_progress for a human to
     * answer with harness_answer. Default true. Set false to keep the old
     * terminal-fail behaviour.
     */
    clarification_escalation_enabled?: boolean;
    /**
     * beta.62 (fix #2/#3): when a cycle-N adversary review CRASHES (SDK error,
     * parse error, or a post-review persist throw) rather than returning a
     * verdict, and (a) a PRIOR cycle already produced a completed adversary
     * review (`lastReview`) AND (b) this cycle's own sub-task self-verification
     * was fully green, DO NOT discard the work: open the PR anyway with
     * `merge_recommendation = 'needs_human_review'` so a human can inspect the
     * adversary-motivated commits (exactly the b60-attempt-2 smoke failure --
     * 8 good commits, all cycle-1 findings addressed, seq-6 self-verify green,
     * but the cycle-2 review call crashed silently and the run threw the work
     * away). When the graceful PR path is NOT taken (e.g. a cycle-1 crash, or
     * the push itself fails), the worktree is PRESERVED (not released) so the
     * commit chain remains inspectable on disk. Default true. Set false to keep
     * the old hard-fail-and-release behaviour on a review crash.
     */
    graceful_pr_on_review_crash?: boolean;
    /**
     * beta.63 (Part A): session-level stall watchdog. A session writes
     * `session.last_progress_at` on EVERY state transition; the watchdog checks
     * non-terminal executing/reviewing/finalising sessions where
     * `now - last_progress_at > session_stall_seconds` and (a) emits a loud
     * `loop.session_stalled`, (b) attempts bounded self-recovery (re-tick the
     * loop-runner), and (c) if unrecoverable transitions to a terminal `failed`
     * (reason=stalled_no_progress) PRESERVING the worktree and, if the branch has
     * commits, opening a graceful push+PR flagged needs_human_review. Must be
     * larger than the longest legit phase (adversary review + push). Default 1800.
     */
    session_stall_seconds?: number;
    /**
     * beta.63 (Part A): sub-flag gating the AUTO-TERMINAL transition of a stalled
     * session. When false, the watchdog still DETECTS + LOGS + attempts recovery,
     * but never forces the terminal `failed` transition (detection/observability
     * on, auto-transition off). Per Carel: keep these separately toggleable.
     * Default true.
     */
    stall_auto_terminal?: boolean;
    /**
     * beta.63 (Part A): on an UNRECOVERABLE stall with commits on the branch,
     * attempt a graceful push + PR flagged needs_human_review (beta.62 pattern) so
     * a near-done deliverable is not evaporated. Default true.
     */
    stall_graceful_pr?: boolean;
    /**
     * beta.67 (Bug A): EXTERNAL stall-sweep cadence (seconds). beta.63's
     * `checkStalls` runs IN-PROCESS, so a dead loop-runner process cannot
     * watchdog its own death (beta.66 smoke #4). This is the tick interval for
     * the EXTERNAL `stall-sweep` service (src/index.ts, registered like
     * pr-watcher / retention-nightly) that runs `loop.sweepStalls()` independent
     * of any loop process: it runs the existing checkStalls fast path AND reaps
     * sessions with a pending cancel flag whose loop is dead. Default 60;
     * clamped [15, 600].
     */
    stall_sweep_interval_seconds?: number;
    /**
     * beta.67 (P0a): enforce SUBSTANTIVE workerContext on mutate/mixed sub-tasks
     * (rationale + file-anchored changeSpec/excerpt) at the validatePlan gate.
     * true (default) -> one bounded lead re-ask then hard-throw. false -> WARN-
     * only escape hatch. Enforces the founding orchestrator-split goal.
     */
    enforce_worker_context?: boolean;
    /**
     * beta.67 (P0b): run ONE Fable revise-spec turn between the adversary and
     * the cycle-2 workers to refresh workerContext (resolved changeSpec) instead
     * of handing workers the raw findings (the beta.63/64 no-op regression).
     * false -> beta.66 behaviour. Failure also falls back. Default true.
     */
    revise_spec_turn_enabled?: boolean;
    /**
     * beta.70 (F5): skip an observe-only sub-task's RE-PROBE on a revise cycle
     * when the SAME seq already completed cleanly in a prior cycle. In PR #870
     * the cycle-2 plan re-listed the seq-1 probe ("already completed, no
     * changes") and the loop re-ran it for 58s + $0.29. true (default) skips it;
     * false restores the always-re-run behaviour.
     */
    skip_observe_reprobe_on_revise?: boolean;
    /**
     * beta.64 (P0-1): FIRST-TOKEN WATCHDOG window (seconds). A SEPARATE timer from
     * worker_timeout_seconds, this is the PHASE-2 watchdog: armed inside
     * consumeWorkerStream when the SDK stream OPENS (system/init) and disarmed on
     * the first assistant content block (text/tool_use). If no first content
     * block arrives within this window, the stream is aborted with the distinct
     * stopReason `first_token_timeout` so the loop retries on a fresh session.
     *
     * beta.65: split-phase redesign. Live smoke #3 durable-log evidence showed
     * phase 2 (stream-open -> first-token) is ALWAYS near-instant on success
     * (4-5ms), while the stall is ALWAYS in PHASE 1 (call-init -> stream-open,
     * see `sdk_stream_open_timeout_seconds`). So the phase-2 default is LOWERED
     * 90 -> 30 (still generous vs a <10ms healthy phase 2). Clamped to [10, 1800].
     */
    sdk_first_token_timeout_seconds?: number;
    /**
     * beta.65 (P0): PHASE-1 watchdog window (seconds). A SEPARATE timer armed at
     * CALL INITIATION (the top of consumeWorkerStream, BEFORE the SDK stream
     * opens) and disarmed when the stream opens (system/init). If the stream
     * never opens within this window, the call is aborted with the same distinct
     * stopReason `first_token_timeout` so the loop retries on a FRESH SDK session.
     *
     * This is the beta.64 gap: beta.64 armed the first-token watchdog only on
     * stream-open, so a PRE-STREAM POST hang (the SDK streaming POST never
     * returns its first byte -- smoke #3: 28+min silence, no sdk_stream_opened,
     * no abort) was NEVER covered and sat for the full worker timeout (1800s).
     * Phase 1 is highly variable even on SUCCESS (smoke #3: seq-1 47s, seq-2
     * 422s-and-succeeded, seq-3 hung >1800s), so the default (120) is set so a
     * legit-but-slow open like seq-2's 422s WILL be aborted -- that is CORRECT:
     * the abort routes into the SAME first_token_timeout -> one-fresh-session
     * retry path, and a cold/unpooled-connection slow open is fast on retry. A
     * one-retry cost beats waiting 422s+ or hanging forever. Clamped to [10, 600].
     */
    sdk_stream_open_timeout_seconds?: number;
    /**
     * beta.64 (P0-2): when a worker sub-task fails with a first_token_timeout OR a
     * worker timeout, RETRY it ONCE on a FRESH SDK session (no resumeSessionId)
     * before flipping the run terminal. The retry re-verifies; a pass completes
     * the sub-task, a fail falls through to the existing terminal path using the
     * retry's result. Max 1 retry per sub-task. Default true.
     */
    worker_timeout_retry_enabled?: boolean;
    /**
     * beta.64 (P0-3): BEST-EFFORT VERIFY. If a VERIFY sub-task (observe-mode, the
     * last/verify sub-task) times out even after the P0-2 retry, AND the prior
     * mutate sub-task's verify_probe was GREEN, AND git diff-stat shows only
     * expected files touched, mark the run verify_skipped (reason worker_timeout),
     * push the branch, and open the PR flagged merge_recommendation=needs_human_review
     * (reusing the beta.62 graceful-PR machinery) rather than discarding shippable
     * work. This is what SHOULD have happened in beta.63 smoke #2 -- the code was
     * shippable, only the verifier hung. Default true.
     */
    best_effort_verify?: boolean;
    /**
     * beta.64 (P0-4): SCRIPTED VERIFIER FALLBACK. When an observe-mode VERIFY
     * sub-task times out (before giving up to best-effort verify), run a
     * DETERMINISTIC fallback -- `npx tsc --noEmit` + `git diff --stat <base>..HEAD`
     * + the allowlisted repo check scripts (reusing the beta.63 runFinalVerifyChecks
     * / discoverCheckScripts / runCheckScripts plumbing) -- and report pass/fail to
     * the loop as if the sub-task ran. A "run tsc/lint/diff/grep" verify sub-task
     * needs no LLM, so a hung verifier should not block a shippable change.
     * Default true.
     */
    scripted_verify_fallback?: boolean;
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