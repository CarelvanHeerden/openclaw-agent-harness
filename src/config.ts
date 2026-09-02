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
  /**
   * v2.0.0-beta.1: per-role backend selection. Optional, and absent means
   * every role runs on claude-code exactly as it did in v1.
   */
  backends?: BackendsConfig;
  /** v2.0.0-beta.1: OpenAI-compatible endpoints for OpenCode roles. */
  providers?: ProvidersConfig;
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
   * beta.81 (Track B): CI-verification shift. After a branch is pushed, the
   * harness polls the commit's combined GitHub status/check-runs and treats
   * CI as the verification spine (the local check-script runner is retired).
   */
  ci: CiConfig;
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
  /**
   * beta.110: harness-owned credential vault. Replaces the memory-hybrid
   * `credential_get` / `credential_store` tools outright -- there is no
   * fallback to them, by design (see adapters/credential-vault.ts).
   */
  credentials: CredentialsConfig;
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
}

export interface CredentialsConfig {
  /**
   * Directory holding `vault.db` and (by default) `vault.key`. Relative paths
   * resolve against the harness data dir -- the directory that already holds
   * the state DB, NOT the git worktree, so the vault survives worktree
   * teardown and is never inside a tree a worker can walk.
   * Default: "harness-vault".
   */
  dir?: string;
  /**
   * Env var checked for a raw 32-byte key (64 hex chars or base64). When set
   * it OVERRIDES the key file, so a container can inject the key without a
   * mounted volume. Default: "OAH_VAULT_KEY".
   */
  key_env?: string;
  /**
   * Explicit key-file path. Default `<dir>/vault.key`, mode 0600. Generated on
   * first boot if absent; back it up, because without it every stored
   * credential is unrecoverable.
   */
  key_file?: string;
}

export interface CiConfig {
  /**
   * beta.81 (Track B / B2): max wall-clock seconds the harness waits for CI to
   * finish after pushing a branch before it treats the wait as a SOFT
   * checkpoint. On timeout the harness does NOT hard-fail -- it surfaces
   * "CI still running after N min on <sha>" and offers a resumable
   * continue-watching. Default 900 (15 min). Clamped to [30, 7200].
   */
  wait_timeout_seconds: number;
  /**
   * beta.81 (Track B / B2): poll interval (seconds) for the post-push CI wait.
   * The harness re-queries getCombinedStatus(headSha) every this-many seconds
   * until it is not `pending` (or the wait_timeout_seconds elapses).
   * Default 20. Clamped to [5, 300].
   */
  poll_interval_seconds: number;
  /**
   * beta.91 (F4): grace window (seconds) for an AUTHORED-this-cycle workflow to
   * REGISTER on GitHub. When the harness authored + pushed a CI workflow and
   * the combined status comes back `none`, that means GitHub has not registered
   * the run YET (registration lag) rather than "no CI" -- so we keep polling for
   * up to this many seconds before concluding the workflow never registered
   * (a distinct, NON-blocking `authored_workflow_never_registered` outcome).
   * Fixes the b90 bug where the harness shipped a `merge` recommendation 0.5s
   * after push, before its own workflow registered, then CI later caught a real
   * typecheck error. Only applies when a workflow was authored this cycle; a
   * genuine no-CI repo still returns `none` fast. 0 disables the grace window
   * (restores beta.90 terminate-on-first-none). Default 45. Clamped [0, 300].
   */
  none_grace_seconds?: number;
  /**
   * beta.124: consecutive polls answered with 401/403/404 before the harness
   * stops polling and reports the denial as the outcome.
   *
   * The b123 smoke asked the check-runs API 44 times over 896 seconds and was
   * told 403 every time -- 12% of the run's wall clock spent re-reading a
   * settled answer, ending in "could NOT determine CI state", which does not
   * tell anyone what to fix. Not 1, because a lone 403 can be a secondary
   * rate limit or a token mid-rotation; 2 in a row is a fact about the
   * configuration. Minimum 1. Default 2.
   */
  permanent_denial_polls?: number;
  /**
   * beta.125: when the Checks API is permanently denied, read the commit's CI
   * from the Actions workflow-runs API instead.
   *
   * b124 detected the denial quickly and then gave up, on the theory that an
   * operator would go and grant the missing permission. There is no permission
   * to grant: fine-grained PATs cannot call the Checks API at all, GitHub says
   * so in its own list of limitations, and the "Checks: read" b124 told people
   * to look for has never existed. Meanwhile the same token's `Actions: read`
   * -- which IS supported -- can list every workflow run on the sha, with the
   * same status/conclusion vocabulary.
   *
   * Only fires on a permanent denial. A transient 5xx is still re-polled
   * against the real endpoint rather than routed around. Set false to restore
   * b124 behaviour. Default true.
   */
  workflow_runs_fallback?: boolean;
  /**
   * beta.127: how many extra cycles a RED CI may buy, at the ship gate.
   *
   * Before b127, CI ran once, after the loop had already decided to finish, and
   * its only effect was to stamp `needs_human_review` on the recommendation.
   * Nothing was fixed, because there was no cycle left to fix it in.
   *
   * The b126 smoke: 33 sub-tasks, zero verification failures, four cycles
   * including one granted for converging findings, 107 minutes, $18.78, and a
   * PR failing 2 of 8836 tests. One test the run broke by inserting a nav item
   * into a group asserted to be contiguous; one it wrote itself, comparing a
   * Date against the string it becomes after JSON serialisation. The revise
   * loop was optimising against the adversary's opinion while the only gate
   * that actually blocks a merge was invisible to it.
   *
   * These cycles are granted ON TOP of max_cycles and of any b124 converging
   * extension, and only when the budget covers another cycle. That is
   * deliberate: hitting the cycle ceiling means the harness ran out of opinions
   * to act on, which is a different thing from the build being broken, and a
   * broken build is the one finding that is never a matter of taste.
   *
   * Each granted cycle re-pushes and re-checks, so the ceiling also bounds how
   * many CI round-trips a session can spend. 0 disables and restores b126
   * behaviour. Default 1.
   */
  max_repair_cycles?: number;
  /**
   * beta.131: give a CI failure that names no file its own sub-task, carrying
   * the raw failing output and no declared file scope.
   *
   * Without it such a finding is broadcast to every sub-task as background
   * context and owned by none of them, which is how 03a8a7b6 spent a repair
   * cycle and about $3 re-running seven sub-tasks while the failing assertion
   * went unread. Only fires when NO CI finding names a file; one that does has
   * a real owner and is routed there instead. Default true.
   */
  repair_subtask_enabled?: boolean;
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
  /**
   * beta.80 (F1): when true (default), the crystalliser is told the harness is
   * a REPO tool -- external-API side-effect acceptance criteria are reframed
   * into "build the code + a test", never "perform the live call". Live calls
   * are legitimate only as test/verify steps against code just written. Set
   * false to restore the pre-beta.80 crystalliser prompt.
   */
  repo_only_invariant: boolean;
  /**
   * beta.80 (F2): when true (default), the crystalliser self-reports competing
   * readings of a brief and, when >= bimodal_min_interpretations distinct
   * readings (or an explicit clarificationNeeded) exist, the run PAUSES for a
   * hard clarify instead of guessing one reading. Set false to always proceed.
   */
  bimodal_clarify: boolean;
  /**
   * beta.80 (F2): how many distinct crystalliser interpretations force a
   * clarify pause. Default 2.
   */
  bimodal_min_interpretations: number;
  /**
   * beta.120 (brief fidelity): directories `harness_run`'s `requestPath` may
   * read a specification from. EMPTY BY DEFAULT, which disables file reads --
   * the harness holds GitHub tokens and a brief's contents reach model prompts
   * and PR bodies, so an operator must name the safe directories explicitly.
   * Point this at wherever the calling runtime stores user-uploaded files.
   * `~` is expanded; symlinks are resolved before the check.
   */
  request_file_roots: string[];
  /** beta.120: hard cap on a `requestPath` file. Default 262144 (256 KB). */
  request_file_max_bytes: number;
  /**
   * beta.120: pause for a human to confirm the crystallised brief BEFORE any
   * planning or worker spend.
   *
   * "off"       - never pause (pre-beta.120 behaviour).
   * "high_risk" - pause when the brief's riskLevel is at or above
   *               confirm_min_risk. Default.
   * "always"    - pause on every run.
   *
   * Motivation: two b119 smokes spent ~$18 and ~2h each building a feature
   * whose brief had been paraphrased upstream (`performedAt` became
   * `scheduledAt`). The error was obvious on sight; nothing showed it to
   * anyone. Crystallising costs cents, so this gate is nearly free.
   */
  confirm_before_spend: "off" | "high_risk" | "always";
  /**
   * beta.120: lowest riskLevel that triggers a confirmation under "high_risk"
   * mode. Default "high".
   *
   * There is deliberately NO budget threshold here: `estimated_usd` is derived
   * from the session budget rather than from the task, so gating on it would
   * silently make "high_risk" behave as "always". Set this to "medium" if you
   * want a wider net, or the mode to "always" if you want every run gated.
   */
  confirm_min_risk: "medium" | "high";
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
   * beta.111: run the repo's typecheck script before review and block on
   * errors in files this branch changed. Independent of
   * run_repo_check_scripts, which stays off by default for cost. Default true.
   */
  typecheck_gate?: boolean;
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
   * NOTE: `listener_enabled` is deliberately absent. beta.34 removed the
   * autonomous Slack listener; beta.133 removed the setting, because a key that
   * can be configured but not obeyed is worse than no key at all -- it made the
   * harness refuse to start over a prerequisite for a mode it does not have.
   * Existing configs may still carry it: the JSON schema still accepts the key
   * (both schemas are `additionalProperties: false`, so dropping it there would
   * turn an old config into a validation failure), `parseHarnessConfig`
   * discards it, and bootstrap warns once.
   */

  /** Outbound posting target. Optional; there is nothing to listen on. */
  channel: string;
  authorised_users: string[];
  /** Vault service name for the Slack bot token (used by reactions poller + adapter fallback). Optional; if unset, poller stays idle. */
  credential_service?: string;
  /** Interval for reactions poller in ms. Default 15000. */
  reactions_poll_ms?: number;
  /**
   * beta.77: harness-native OUTBOUND progress/terminal delivery. When true
   * (DEFAULT) and `credential_service` is set AND a session has a REAL Slack
   * binding (channel + non-synthetic thread passed on `harness_run`), the
   * harness direct-posts progress/terminal headlines to Slack via the vault bot
   * token -- an independent path from the wedge-prone agent `api.sendMessage`
   * turn. Set false to force the poll-only model. Auto-noop (graceful fallback)
   * when the token or binding is absent. Does NOT affect clarifications/inbound.
   */
  native_progress_delivery?: boolean;
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
  allowed: string[];              // e.g. ["example-org/*", "CarelvanHeerden/*"]
  can_create: boolean;
  create_org: string;
  create_visibility: "private" | "public";
  default_base_branch: string;    // e.g. "main"
  /**
   * beta.32: when the adversary verdict is not a clean "pass", open the PR
   * as a GitHub *draft*. Default FALSE. Draft PRs are rejected with HTTP 422
   * on repos that don't support them (private repos on free plans, some repo
   * types), which would kill the run at the very last step. Even when true,
   * the live path retries as a non-draft PR on a 422 rather than failing.
   * The verdict warning always goes in the PR body regardless of draft state.
   */
  draft_pr_on_nonpass?: boolean;
  /**
   * beta.114: pathspecs whose changes are reverted instead of committed.
   *
   * For generated trees that belong to the repo's tooling rather than to any
   * feature. The b113 DR/BCP run shipped 154 files of which 141 were
   * ProjectThanos's regenerated `okf/**` documentation bundle, swept in by the
   * unscoped `git add -A` after a worker ran the generator. That left the PR
   * conflicting with main and gave the adversary 141 files of unrelated
   * surface to re-review every cycle.
   *
   * Configured, never inferred: a generated tree looks exactly like
   * hand-written code, and a harness that guessed would discard real work.
   * Empty by default, so this is inert unless a repo opts in.
   *
   * Example: ["okf/**"]
   */
  never_commit_paths?: string[];
}

export interface ModelsConfig {
  lead: string;
  worker: string;
  adversary: string;
  classifier: string;
  /**
   * beta.91 (Fix 3): optional cheaper/faster model for MECHANICAL sub-tasks
   * (Prisma models, migration, sidebar entry, barrel exports -- pattern-follow
   * scaffolding with no cross-file judgment). When set, such sub-tasks dispatch
   * on this model; everything else (and the lead + adversary) stays on the
   * strong models. Absent = every sub-task uses `worker` (beta.90 behaviour).
   * The verify + adversary safety net is unchanged, so a weaker model that gets
   * a mechanical task wrong is caught by review, not shipped.
   */
  worker_mechanical?: string;
  /** Optional per-model price overrides for cost estimation. Set when Anthropic ships new pricing before we release. Keys are model ids (e.g. 'claude-fable-5'). Values are USD per million tokens. */
  price_overrides?: Record<string, { input: number; output: number }>;
  /**
   * beta.99 (P0-4): OUTPUT-TOKEN CEILING for the SDK subprocess, exported as
   * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
   *
   * Why this exists: nothing in the harness ever set an output ceiling, so
   * every structured call inherited whatever default the bundled SDK picks for
   * the model id -- and the SDK resolves that from its OWN baked-in model
   * table. A model id newer than the pinned SDK (e.g. `claude-opus-5` against
   * SDK 0.3.207, which is exactly the b98 lead configuration) is absent from
   * that table, so the ceiling it lands on is not one we chose and not one we
   * can see. Setting this explicitly makes the plan-size budget OURS.
   *
   * Current-generation models (Fable 5, Sonnet 5, Opus 4.7/4.8) accept up to
   * 128000 output tokens; 64000 is their default. Default here: 64000.
   * Set 0 to disable (inherit the SDK default, pre-beta.99 behaviour).
   */
  max_output_tokens?: number;
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

/**
 * v2.0.0-beta.1: which backend and model each role runs on.
 *
 * Absent means every role runs on `claude-code` exactly as it did in v1, which
 * is the property that makes this block safe to add: an operator who upgrades
 * and edits nothing sees no change. See `src/adapters/role-config.ts` for the
 * merge rules and the validation.
 */
export interface BackendsConfig {
  /** Applied to any role that does not override it. */
  default?: RoleBackendEntry;
  worker?: RoleBackendEntry;
  scout?: RoleBackendEntry;
  lead?: RoleBackendEntry;
  adversary?: RoleBackendEntry;
  classifier?: RoleBackendEntry;
  crystalliser?: RoleBackendEntry;
  revise_spec?: RoleBackendEntry;
  worker_context?: RoleBackendEntry;
}

export interface RoleBackendEntry {
  /** `claude-code` (default) or `opencode`. */
  backend?: "claude-code" | "opencode";
  /** `provider/model` for opencode; a bare model id is also accepted for claude-code. */
  model?: string;
  /**
   * Operator's declaration of how capable this model is: `basic`, `strong` or
   * `frontier`. The lead, adversary and crystalliser refuse to run below
   * `strong`, because those are the roles where a weak model returns a
   * well-formed wrong answer rather than an obvious failure.
   */
  tier?: "basic" | "strong" | "frontier";
}

/**
 * OpenAI-compatible endpoints made available to OpenCode roles.
 *
 * Keys live in the vault and are named here by service, never inlined. They
 * reach the agent only inside `OPENCODE_CONFIG_CONTENT`.
 */
export interface ProvidersConfig {
  [providerId: string]: {
    /** The AI-SDK package; only `@ai-sdk/openai-compatible` is supported. */
    npm?: string;
    /** Display name, used in audit events and error messages. */
    name?: string;
    /** Endpoint base URL. Must end in `/v1`. */
    base_url?: string;
    /** Vault service name holding this provider's API key. */
    api_key_service?: string;
    /** True for a provider that bills nothing: report tokens, not dollars. */
    local?: boolean;
    /**
     * models.dev provider id to price this provider's models against, when it
     * differs from the id above (e.g. `anthropic-compat` -> `anthropic`).
     * Without it the catalogue misses and every turn bills at the
     * most-expensive-known fail-safe.
     */
    pricing_provider?: string;
    /** Model ids this provider serves, with optional display names. */
    models?: Record<string, { name?: string }>;
  };
}

export interface LoopConfig {
  max_cycles: number;
  /**
   * beta.124 INERT: declared, schema'd, defaulted -- and never read. A `pass`
   * verdict ends the loop unconditionally (`advance()`, case "reviewing"), so
   * setting this to false has never done anything.
   *
   * Left declared rather than deleted, because `additionalProperties: false`
   * in the manifest means removing it would hard-fail every existing config
   * that sets it. Not wired up either: the honest implementation of "false"
   * is "keep cycling after a clean pass", which would then hit the ceiling
   * carrying a `pass` verdict and ship as `shipped_max_cycles_revise` --
   * do_not_merge on a run the adversary approved. That is a worse lie than the
   * inert flag, for a mode nobody has asked for.
   *
   * `tests/beta124-config-keys-are-live.test.mjs` pins this list, so the next
   * dead key fails CI instead of being discovered by a smoke test.
   */
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
  /**
   * beta.129: when the wall clock will not fit another cycle but the findings
   * are not finished, ASK the operator for more time instead of silently
   * landing a half-reviewed branch.
   *
   * Session d48ba433 hit the 2h ceiling with $18 of its $40 unspent and no way
   * to say "keep going" -- the confirmation gate can raise money mid-flight and
   * nothing could raise time. Disabling this restores the b120 behaviour of
   * shipping whatever exists.
   */
  time_extension_ask_enabled: boolean;
  /**
   * beta.129: how long the loop waits, in place, for an answer to that question
   * before giving up and shipping. Bounded on purpose: an unanswered question
   * must never be the reason a deliverable is not on GitHub. Default 300s.
   */
  time_extension_wait_seconds: number;
  /**
   * beta.129: seconds granted when the operator says yes without naming a
   * figure. A reply carrying its own time clause ("2 more hours") wins.
   * Default 1800.
   */
  time_extension_default_seconds: number;
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
   * beta.120 (fix 1): when a run ABORTS on a resource ceiling (wall clock,
   * session budget, daily cap) and the branch has commits, push them and open a
   * needs_human_review PR instead of discarding the worktree. Default true.
   *
   * A resource ceiling says nothing about the quality of the code: the b119
   * take-2 smoke hit its 120-minute wall clock at 121.6 minutes and deleted 27
   * commits, 15 files, a clean typecheck and a converging review. Setting this
   * false restores that behaviour for resource aborts, but the worktree is
   * still PRESERVED whenever commits exist -- an abort never deletes work.
   */
  abort_salvage_pr?: boolean;
  /**
   * beta.120 (fix 4): stop starting new revise cycles once fewer than this many
   * seconds remain before `session_hard_timeout_seconds`, and ship what exists
   * instead. Default 600 (10 min). Set 0 to disable.
   *
   * The b119 take-2 run was killed at a review boundary with no runway left to
   * push, because the deadline was only ever consulted to decide whether to
   * ABORT -- never to decide whether there was still time to finish properly.
   */
  ship_time_reserve_seconds?: number;
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
   * beta.99 (P0-1): what to do when a plan is STILL missing substantive
   * workerContext after the bounded re-ask.
   *
   * false (default) -> ship the degraded plan with a loud warning. Workers on
   * those seqs simply start colder, which is a quality regression, not a
   * broken run.
   * true -> restore the pre-beta.99 hard-fail (LeadPlanValidationError).
   *
   * The default flipped because b98 (session f2613eec) burned a whole session
   * and produced NOTHING while the harness was holding a valid plan: the gate
   * failing is not a good enough reason to throw the plan away.
   */
  require_worker_context_strict?: boolean;
  /**
   * beta.67 (P0b): run ONE Fable revise-spec turn between the adversary and
   * the cycle-2 workers to refresh workerContext (resolved changeSpec) instead
   * of handing workers the raw findings (the beta.63/64 no-op regression).
   * false -> beta.66 behaviour. Failure also falls back. Default true.
   *
   * beta.92 DEPRECATED: the LLM revise-spec turn was DELETED and replaced by a
   * deterministic finding->sub-task mapping (see `deterministic_revise_mapping`).
   * This key is retained (declared, no effect) so pre-b92 configs that set it
   * still validate under the manifest's additionalProperties:false.
   */
  revise_spec_turn_enabled?: boolean;
  /**
   * beta.84 (#2): HARD timeout (seconds) on the Fable revise-spec turn.
   * beta.92 DEPRECATED (no effect): the timed turn was removed; kept for config
   * back-compat only.
   *
   * WHY (beta.73 signature, session 1c744d70): the revise-spec turn is an
   * UNBOUNDED lead-model call. On a busy/cron-nested run it has spun ~570s
   * (9.5 min) and then failed on the ambient ~218s cron lane cap -- burning
   * ~10 minutes before it fell back to the raw-findings hint (which beta.83
   * only made VISIBLE, not faster). Bounding it here makes the fallback FAST:
   * if the distillation can't produce a refreshed plan within the budget, we
   * stop waiting and drop to the raw-findings hint immediately (audited as
   * loop.revise_spec_timeout) instead of eating the whole lane cap. The
   * fallback path is identical to a throw/empty -- never worse than beta.66.
   * 0 disables the bound (restores the pre-beta.84 unbounded behaviour).
   * Default 180s (< a typical cron lane cap, generous for a single distill).
   */
  revise_spec_timeout_seconds?: number;
  /**
   * beta.70 (F5): skip an observe-only sub-task's RE-PROBE on a revise cycle
   * when the SAME seq already completed cleanly in a prior cycle. In PR #870
   * the cycle-2 plan re-listed the seq-1 probe ("already completed, no
   * changes") and the loop re-ran it for 58s + $0.29. true (default) skips it;
   * false restores the always-re-run behaviour.
   */
  skip_observe_reprobe_on_revise?: boolean;
  /**
   * beta.91 (Fix 1): on a revise cycle (cycle > 1), skip sub-tasks whose file
   * scope does not intersect ANY review finding's file -- they are
   * already-correct from a prior cycle and re-running them is pure overhead (the
   * DR/BCP smoke re-ran 8 of 12 no-change sub-tasks). A finding with no
   * resolvable file makes the cycle unscopable -> the optimisation is skipped
   * and every sub-task runs (conservative). Never skips a sub-task a KEPT one
   * depends on. true (default) enables; false restores beta.90 (run-all).
   */
  revise_scoping_enabled?: boolean;
  /**
   * beta.92: use the DETERMINISTIC finding->sub-task mapping (revise-mapping.ts)
   * on a revise cycle instead of the deleted LLM revise-spec turn. Maps each
   * diff-addressable finding (spec|quality|security, `.file` required) to the
   * sub-task(s) that own its file via strict resolveContractPath; broadcasts
   * meta (fit|runtime) findings + mapping-misses to all sub-tasks (never
   * dropped). No LLM turn => no timeout => no raw-dump => no confab. true
   * (default) enables; false disables mapping (workers get the beta.56 whole-
   * review raw hint -- the old fallback, retained as an escape hatch).
   */
  deterministic_revise_mapping?: boolean;
  /**
   * beta.92 (charter #3): LOG-ONLY worker self-contradiction detector. Emits
   * loop.worker_confab_suspected when the worker's final message lexically
   * claims it left a contract-REQUIRED (non-relaxed) file untouched. No
   * behaviour change -- verification still decides pass/fail. true (default)
   * emits the audit; false disables the detector.
   */
  worker_confab_detect?: boolean;
  /**
   * beta.95: REVISE-CYCLE VERIFIER DIFF-WINDOW fix. On a revise cycle (cycle > 1)
   * a TARGETED contract file (one the review DID target, so `reviseRelaxed` is
   * NOT set) is verified against the worker-session-start SHA + an mtime-
   * predates-sub-task-start freshness heuristic. Both read the WRONG window: a
   * file that cycle-1 already touched has an mtime older than cycle-2's sub-task
   * start, and its cycle-1 commit sits OUTSIDE `worker-session-start..HEAD`, so
   * `file_written` (mtime) and `file_committed` (strict-match base) BOTH false-
   * fail even though the worker's cycle-2 edit is genuine (the 98cea58f cyc2
   * seq2 `prisma/schema.prisma` failure: real commit e75c669, base 202720e).
   * When true (default) a TARGETED file on cycle > 1 is verified against the
   * BRANCH fork-point window (`plan_base_sha..HEAD`, i.e. `branchBaseSha`) for
   * both checks, matching the range the worker legitimately owns. false restores
   * the beta.94 worker-session-start window (targeted-file false-positive vector).
   */
  revise_targeted_planbase_window?: boolean;
  /**
   * beta.76 (Option 1) + beta.93 kill-switch: contract-path RE-DERIVATION. When
   * true (default) a stale lead-guessed contract path is corrected against the
   * repo's real touched layout BEFORE verification (with the beta.93 exact-match
   * + same-basename guards so a correctly-committed path is never rewritten).
   * false disables re-derivation entirely -- the verifier compares against the
   * lead's declared path verbatim (relies on the beta.50+ tolerant match rules).
   */
  contract_rederive_enabled?: boolean;
  /**
   * beta.100: bounded TEST-CONTRACT reconciliation. When true (default), a
   * contract path that is a TEST file and does not structurally resolve against
   * what the sub-task actually touched is rewritten onto the sub-task's own
   * committed test file -- but ONLY when there is exactly one such unmatched
   * test contract and exactly one unclaimed committed test file, so the pairing
   * is unambiguous. Closes the b99 seq-3 failure, where the lead guessed a
   * co-located `route.test.ts` and the worker correctly used the repo's real
   * Jest `__tests__/` location; the b76 prefix-remapper could not help because
   * the two paths share no trailing directory chain. false disables it, and the
   * strict file_committed check fails such a sub-task as it did before b100.
   */
  contract_test_path_reconcile?: boolean;
  /**
   * beta.100: when a sub-task made a REAL commit but its files do not match the
   * contract paths, pause the run in `awaiting_clarification` (worktree and
   * commits preserved, resumable via harness_answer) instead of hard-failing.
   * The sub-task still fails verification and nothing is accepted -- only the
   * terminal disposition changes. false restores the pre-b100 hard fail.
   */
  contract_mismatch_escalation_enabled?: boolean;
  /**
   * beta.101: before adversary review, verify every commit_sha in the sub-task
   * ledger is reachable from HEAD, and FAIL the run when any is not. Catches a
   * branch that has silently lost work the run already committed (b100 smoke,
   * session 3c6c1608: six orphaned commits went unnoticed until the adversary
   * blocked on their absence). false restores the pre-b101 unchecked review.
   */
  ledger_reachability_guard_enabled?: boolean;
  /**
   * beta.101: at plan time, flag `filesLikelyTouched` entries naming a file in
   * a directory the repo does not have, and warn the worker to treat them as
   * guesses. Advisory only -- never blocks, since new modules legitimately
   * create new directories. false disables the check entirely.
   */
  plan_path_validation_enabled?: boolean;
  /**
   * beta.103: after verification proves a contract path correction (b76 rederive
   * or b100 test reconcile), write it back into the sub-task's
   * `filesLikelyTouched` so later revise cycles scope against the real path.
   * Without this the plan keeps the lead's fictional path and revise-scoping
   * skips the sub-task that owns the findings (b102 smoke, PR #906: three
   * cycles re-raising the same two findings against a sub-task it kept
   * skipping). false restores the pre-b103 write-nothing-back behaviour.
   */
  plan_path_writeback_enabled?: boolean;
  /**
   * beta.104: run a READ-ONLY repo investigation turn before the lead plans.
   *
   * Until b104 the lead planned with `tools: []` and no worktree, so it had
   * never opened a file of the repo it was planning against -- while the b67
   * gate required it to emit verbatim `codeExcerpts` regardless. The b102 smoke
   * counted seven fictional paths in one plan, and every worker had to
   * rediscover the real layout the planner should have established once.
   *
   * true (default) -> scout, then plan against the findings. false -> the
   * pre-b104 blind plan. Best-effort either way: a scout failure never fails
   * the run, it just falls back to blind.
   */
  lead_repo_scout_enabled?: boolean;
  /**
   * beta.104: wall-clock ceiling on the scout turn.
   *
   * beta.106: default lowered 600 -> 420, and the loop now ADDS this to
   * `lead_timeout_seconds` rather than expecting the planner to share it. The
   * b105 smoke scouted for 14 minutes and left the planner nothing.
   */
  lead_scout_timeout_seconds?: number;
  /**
   * beta.106: hard ceiling on scout agent turns. Default 60 (SCOUT_MAX_TURNS).
   *
   * Aborting the wall clock does not interrupt a tool call already in flight --
   * on the b105 smoke the 600s abort fired and the scout still ran to ~850s --
   * so the SDK's turn cap is the bound that actually holds.
   */
  lead_scout_max_turns?: number;
  /**
   * beta.104: ceiling on the report folded into the planning prompt.
   *
   * beta.107: default raised 20000 -> 32000, and truncation is now middle-out.
   * b106 reported `reportChars: 20049`, which is the exact length
   * `boundScoutReport` produces when it cuts at 20000 -- the ceiling was binding
   * on an ordinary feature brief and nothing said so. b98 remains the reason a
   * ceiling exists: an oversized lead input costs a whole run when the reply
   * breaches the output ceiling.
   */
  lead_scout_max_chars?: number;
  /**
   * beta.107: let a diff-addressable finding whose file NO sub-task claims be
   * adopted by the nearest sub-task, so it is targeted rather than merely
   * broadcast as context. See adoptOrphanFindings in revise-mapping.ts: on b106
   * the `help-content.ts` convention finding was raised, mapped to nobody, and
   * re-raised every cycle until the run hit its ceiling. Default on.
   */
  revise_adopt_orphan_findings?: boolean;
  /**
   * beta.108: ceiling on how many orphan findings a single revise cycle may
   * adopt. Adoption widens a sub-task's file scope, and scope is what a revise
   * cycle costs -- the b106 revise on PR #932 fired TWENTY-ONE mapping misses
   * across two cycles (against the original smoke's two), because the adversary
   * re-reads the whole branch each cycle and keeps surfacing adjacent issues.
   * Uncapped, the adopter would drag most of the branch back into every cycle
   * and undo the targeting that makes revise cheap. Adoption is severity-
   * ordered, so the cap sheds the least important candidates first. Default 3.
   */
  revise_max_adoptions_per_cycle?: number;
  /**
   * beta.119: also route a finding to the owners of the OTHER files its fix
   * needs (`relatedFiles`, plus any repo path the finding's prose names).
   *
   * The b118 smoke raised "the upload route discards the kind/title fields the
   * drawer sends" in all three cycles and fixed it in none. Routing was
   * correct -- the route file's owner was targeted every cycle -- but that
   * worker could not act alone: persisting the fields needed a Prisma column it
   * did not own, and deleting the now-dead dropdown needed the drawer it did
   * not own. It reported no-change, which the loop cannot distinguish from
   * "already correct", so the finding was re-raised until the cycle ceiling.
   * Default true. Set false for the pre-b119 single-owner routing.
   */
  revise_route_co_fix_owners?: boolean;
  /**
   * beta.119: extra execute+review cycles the loop may grant ITSELF past
   * `max_cycles` when the adversary's finding count is trending down and the
   * budget covers another cycle.
   *
   * b97 already detected this arc and wrote the operator a note asking them to
   * run `harness_revise` by hand -- the same cycle the harness could have run
   * while the worktree was still warm. The b118 smoke went 16 -> 8 -> 9 and
   * stopped on the ceiling having spent $12.90 of $30, shipping four blocking
   * findings its own report called "small and mechanical". Both conditions must
   * hold, so a stuck run (flat or rising findings) still stops on time.
   * Default 1. Set 0 to restore the pre-b119 hard ceiling.
   */
  max_cycle_extensions?: number;
  /**
   * beta.119: when the plan intends to edit `.github/workflows/**`, verify the
   * routed token has the `workflow` scope BEFORE running any sub-task.
   *
   * The CI-optimisation run planned a one-line ci.yml change, executed it,
   * reviewed it, and discovered only at the push that GitHub refuses workflow
   * writes without that scope -- a question answerable from the plan and a
   * response header before the first worker started. Only a token that
   * PROVABLY lacks the scope stops a run; fine-grained PATs and App tokens
   * report no scope header and are waved through. Default true.
   */
  workflow_scope_precheck?: boolean;
  /**
   * beta.108: end a revise cycle that moved the branch tip nowhere, instead of
   * paying for an adversary pass over a diff that did not change. The b106
   * revise's cycle 3 dispatched five sub-tasks, four returned
   * `subtask_revise_no_change`, and the run still bought a full review. Only
   * applies from cycle 2 onward and only when a prior review exists to carry
   * forward. true (default) enables; false restores the b107 always-review
   * behaviour.
   */
  early_exit_no_change_cycle?: boolean;
  /**
   * beta.109: end the review loop when the adversary says `revise` but no finding is diff-addressable at medium severity or above.
   * The adversary writes `revise` while ANY finding is open, including the informational ones it emits to record that a prior finding was fixed, so a run converges to a floor it can never cross: ProjectThanos PR #932 went 18 -> 15 -> 17 across three cycles and finished with ten low, six info and one low convention finding, nothing at medium or above, over three separate revises.
   * Medium and above still cycles, so this cannot ship real defects; the residual lows go on the PR body and harness_revise picks them up on request.
   */
  ship_when_no_blocking_findings?: boolean;
  /**
   * beta.111: settle a contract mismatch from branch history instead of
   * pausing for a human, when every expected path the sub-task did not touch
   * was already changed earlier on this branch. Default true.
   */
  auto_resolve_satisfied_contract?: boolean;
  /**
   * beta.110: out-of-scope committed file count at which a cycle is abandoned BEFORE adversary review, instead of folding the overage into the review as a `fit` finding.
   * On ProjectThanos PR #932 an in-worktree npm cache was swept into a commit by git add -A; the check reported 12423 out-of-scope files, produced a finding, and let the run continue -- the adversary then hit its 900s timeout on a 12432-file diff and the session died having pushed nothing, stranding eight good commits.
   * A diff that size cannot be reviewed, so discovering that slowly is pure loss.
   * Set 0 to disable and keep the pre-b110 finding-only behaviour.
   */
  scope_blowout_file_threshold?: number;
  /**
   * beta.105: also run the ledger reachability guard at RESUME, right after a
   * re-plan re-allocates the worktree, not only before adversary review.
   *
   * b101 built the guard and ran it in one place. The b103 smoke (session
   * b8ece861) then lost eight of ten recorded commits when a clarification
   * resume re-allocated the worktree onto a different tip, stalled at a second
   * clarification, and was aborted -- so the guard never ran at all and the
   * loss surfaced four hours later in a hand-written post-mortem. Re-allocation
   * is the operation that loses commits, so it is where the check belongs.
   *
   * A fresh run has an empty ledger and short-circuits, so this costs one no-op
   * call on the common path. Default true.
   */
  resume_ledger_guard_enabled?: boolean;
  /**
   * beta.105: when contract verification fails on a single file whose basename
   * matches the committed file's, the plan's directory does not exist in the
   * repo and the committed file's does, synthesise the remap and rederive
   * instead of pausing for a human.
   *
   * b103's rederive is a CONSUMER of remaps learned from earlier sub-tasks. On
   * the b103 smoke seq 9 was the first sub-task to touch `src/components/`, so
   * there was no remap to lean on and a mechanically-obvious correction
   * (`components/layout/sidebar.tsx` -> `components/ui/sidebar.tsx`) escalated
   * to clarification and cost an hour of dead time. Default true.
   */
  basename_rescue_enabled?: boolean;
  /**
   * beta.105: accept a `file_written` contract when the path was ADDED or
   * RENAMED-TO inside the sub-task's own commit range, even though the blob's
   * mtime predates the sub-task.
   *
   * `git mv` preserves mtime, so a worker that correctly moves a file to the
   * path the contract asks for produces `file_committed` PASS and
   * `file_written` FAIL on the same file in the same commit (b103 smoke seq 3).
   * Two checks disagreeing about one file is incoherent verifier state, not a
   * safety property. Default true.
   */
  file_written_accepts_rename?: boolean;
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
   * beta.90 (Feature 2): STREAM-SLOW idle-warn window (seconds). Inside
   * consumeWorkerStream, once the worker SDK stream has OPENED, a 30s tick
   * watches for token/message activity; if the stream goes IDLE (no delta) for
   * this many seconds it emits `loop.worker_stream_slow` and bumps the session
   * liveness heartbeat (so harness_progress surfaces "worker stream idle Ns"
   * instead of the phase looking wedged). OBSERVABILITY ONLY -- it NEVER aborts
   * (a slow stream recovered on b89; a blunt abort would have wrongly killed
   * it). Root cause: session 041bd3d3 sub-task 2, worker stream opened then went
   * idle ~15 min with no signal in harness_progress. Default 90; 0 disables;
   * clamped [30, 600].
   */
  worker_stream_idle_warn_seconds?: number;
  /**
   * beta.64 (P0-2): when a worker sub-task fails with a first_token_timeout OR a
   * worker timeout, RETRY it ONCE on a FRESH SDK session (no resumeSessionId)
   * before flipping the run terminal. The retry re-verifies; a pass completes
   * the sub-task, a fail falls through to the existing terminal path using the
   * retry's result. Max 1 retry per sub-task. Default true.
   */
  worker_timeout_retry_enabled?: boolean;
  /**
   * beta.113: how many worker attempts a timeout-class failure gets in total,
   * including the first. The b64 default of 2 retried sub-task 3 of the DR/BCP
   * run once, against the same too-short first-token window, and then took the
   * whole session down. Default 3. Clamped [1, 5].
   */
  worker_timeout_max_attempts?: number;
  /**
   * beta.113: multiply the first-token watchdog by this on each retry, so a
   * genuinely slow start gets a wider window rather than the identical one that
   * just failed. Default 3 (30s -> 90s -> 270s). Clamped [1, 10].
   */
  worker_first_token_retry_multiplier?: number;
  /** beta.113: ceiling for the escalated first-token window. Default 300s. */
  worker_first_token_retry_cap_seconds?: number;
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
  /**
   * beta.81 (Track C / C4): recovery-resume circuit breaker. Forensic
   * d01a7484 showed `recovery.auto_resuming` firing 4x in ~40s on a
   * `planning`-phase session (interrupted -> re-resumed before it could
   * finish -> bounce loop, actively re-burning budget). When MORE than
   * `recovery_max_resumes` auto-resumes fire for the SAME session within
   * `recovery_resume_window_seconds`, the harness HARD-STOPS that session
   * (marks it `failed`, reason `recovery_bounce_loop`) and surfaces it to a
   * human instead of resuming again. Default 3 resumes in 60s.
   */
  recovery_max_resumes?: number;
  /**
   * beta.81 (Track C / C4): window (seconds) over which `recovery_max_resumes`
   * auto-resumes for a single session trip the circuit breaker. Default 60.
   */
  recovery_resume_window_seconds?: number;
  /**
   * beta.81 (Track C / C3): when a session left mid-`executing` is recovered,
   * RESUME AT the failed/incomplete sub-task (mark the orphaned running
   * sub-task `failed`, preserve completed sub-task commits) instead of
   * re-planning the whole session from scratch (which re-burns completed
   * sub-tasks -- forensic d01a7484 re-ran 10 completed sub-tasks + crashed on
   * an extractJson re-plan). Default true. Set false to restore the pre-beta.81
   * full-restart recovery behaviour.
   */
  recovery_resume_at_subtask?: boolean;
  /**
   * beta.132: refuse to auto-resume a session that already has a plan AND at
   * least one finished cycle, in ANY phase.
   *
   * b81 stopped this for `executing` only; every other phase still fell
   * through to a re-drive of `loop.run`, which re-plans from scratch -- a
   * fresh lead call and scout (mean $6.24 across this repo's own audit
   * history), `cycles_ran` reset, and completed sub-tasks re-run over their
   * own commits. It fires unattended on plugin boot, and restarting the
   * container is how a new build gets installed, so it lands on live runs as
   * a matter of routine.
   *
   * With the guard on, such a session is surfaced instead: marked
   * needs_human_review against its PR if it has one, otherwise failed with
   * the worktree preserved. Sessions with no plan yet still resume normally.
   * Default true. Set false to restore the pre-beta.132 re-drive.
   */
  recovery_replan_guard?: boolean;
  /**
   * beta.81 (Track C): give the LEAD re-plan SDK call the same "retry once on
   * extractJson failure" guard the classifier has (runClassifierSdk), so a
   * transient prose-drift (the lead returns prose instead of the JSON plan
   * contract -- the beta.40 anti-persona-drift class, which crashed the
   * d01a7484 re-plan) does not hard-crash the plan. Default true.
   */
  lead_json_retry_enabled?: boolean;
  /**
   * beta.99 (P0-6): when BOTH lead plan attempts are cut off at the output
   * ceiling, salvage the well-formed prefix of the reply rather than failing
   * the run with `plan_failed`.
   *
   * The salvaged plan is REAL but INCOMPLETE -- trailing sub-tasks were cut
   * off -- and it is logged loudly as such. It still has to pass validatePlan.
   * Default true: an incomplete plan that ships something reviewable beats a
   * dead session that spent the operator's time and shipped nothing.
   * Set false to restore the pre-beta.99 hard-fail.
   */
  lead_salvage_truncated_plan?: boolean;
  /**
   * beta.128: when a lead plan comes back COMPLETE but fails JSON.parse, spend
   * one more call asking for the same plan with the fault corrected, quoting
   * the parser's complaint and the text around it.
   *
   * Distinct from `lead_json_retry_enabled` (prose drift) and from the
   * truncation rung: this one fires on a whole document spoiled by a token,
   * which salvage cannot help with because there is nothing to close. Session
   * f75f7db6 lost a 24k-char plan and two Opus calls to `"seq_note":undefined`.
   * Default true. Set false to hard-fail instead of paying for a third call.
   */
  lead_syntax_retry_enabled?: boolean;
  /**
   * beta.94 (Feature 1): DETERMINISTIC FINAL SCOPE CHECK. Two behaviours gated
   * together:
   *   (a) In the lead-plan normalisation, DROP a trailing PURE-OBSERVE sub-task
   *       whose sole purpose is scope/boundary "final verification" (taskMode
   *       observe, no mutate verify kinds, description matches the scope-verify
   *       heuristic). Such a sub-task has nothing to write, so a worker can go
   *       IDLE on it indefinitely (the b93 seq-12 stall) while adding ZERO
   *       signal -- every prior mutate sub-task already passed strict per-file
   *       contract verification, and runFinalVerifyChecks already runs the repo
   *       convention scripts deterministically. Elision is audited as
   *       `loop.final_verify_subtask_elided`.
   *   (b) After the last mutate sub-task completes, run a HARNESS-SIDE
   *       deterministic scope check: the files COMMITTED in `<base>..HEAD` are
   *       compared against the UNION of every sub-task's declared per-file
   *       verify/contract scope. A committed file OUTSIDE that union produces a
   *       ReviewFinding (dimension `fit`, severity `medium`) that folds into the
   *       adversary review -- it is NOT a hard fail. Audited as
   *       `loop.final_scope_check_ran` / `loop.final_scope_check_out_of_scope`.
   * Default true.
   */
  deterministic_final_scope_check?: boolean;
  /**
   * beta.94 (Feature 2): NARROW IDLE-NO-WORK ABORT. beta.90 added
   * `loop.worker_stream_slow` as pure observability. beta.94 adds a NEW
   * `loop.worker_idle_no_work` audit event that fires when the conjunction of
   * (>= worker_idle_consecutive_slow consecutive stream-slow ticks) AND
   * (tokensOut===0 on ALL of them) AND (cumulative elapsed >
   * worker_idle_min_elapsed_seconds) AND (no worktree writes during the
   * sub-task) holds -- the b93 seq-12 signature (worker went idle, tokensOut=0,
   * ~15 min, nothing to write). That event is LOG-ONLY by default.
   *
   * When this flag is TRUE, the same conjunction ALSO aborts the sub-task
   * cleanly via the existing WorkerTimeoutError / {outcome:'timeout'} terminal
   * path (so the worktree is preserved -- NO new terminal path is invented).
   * Default FALSE (beta.90 observability-only behaviour stays fully intact).
   */
  worker_idle_abort_enabled?: boolean;
  /**
   * beta.94 (Feature 2): number of CONSECUTIVE `loop.worker_stream_slow` ticks
   * (all with tokensOut===0) required before `loop.worker_idle_no_work` may
   * fire. Default 3. Clamped [2, 20].
   */
  worker_idle_consecutive_slow?: number;
  /**
   * beta.94 (Feature 2): minimum cumulative elapsed (seconds) inside the worker
   * stream before `loop.worker_idle_no_work` may fire. Default 900 (15 min).
   * Clamped [60, 3600].
   */
  worker_idle_min_elapsed_seconds?: number;
}

export interface VercelConfig {
  enabled: boolean;
  credential_service: string;    // vault service name (only read when enabled)
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
  /**
   * beta.76 (Defect B): minimum free bytes on the worktrees filesystem before a
   * dep-bootstrap install is attempted. Below this, the install is skipped and
   * a blocking `harness.worktree_disk_low` diagnostic is surfaced (an install
   * under a full disk corrupts node_modules -> a test sub-task commits an unrun
   * test). Default 1073741824 (1 GiB). Set 0 to disable the preflight.
   */
  min_free_disk_bytes: number;
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
 *   - vault: service name in the harness-owned credential vault (beta.110; was
 *            the memory-hybrid plugin's vault before the cutover)
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

  overrides: Record<string, Record<string, string>>;    // { userId: { orgOrRepo: credentialService } }
  commit_identity: Record<string, { name: string; email: string }>;
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
   *   {owner}     - repo owner (org or user), e.g. "CarelvanHeerden"
   *   {repo}      - repo name, e.g. "openclaw-agent-harness"
   *   {requester} - requester's provider login, from `user_identities`
   *   {userid}    - requester's raw Slack id, e.g. "U07UT6G8LQ4". The only
   *                 placeholder shared with `onboard_service_pattern`, so it
   *                 is the one that makes a per-user setup expressible on both
   *                 sides. NOT lower-cased, because onboarding writes the id
   *                 verbatim (beta.133).
   *   {user}      - requester's GitHub login (deprecated alias; for a personal
   *                 repo this equals {owner}, which is why the old default
   *                 "github-{user}-{org}" collapsed to a duplicated segment)
   *   {org}       - repo owner (deprecated alias of {owner})
   *   {provider}  - "github" or "gitlab"
   * Default: "{provider}-{owner}" (per-owner tokens). Every placeholder except
   * {userid} is lower-cased.
   *
   * The default carried a hard-coded "github-" prefix until it was noticed that
   * one person's GitHub and GitLab tokens for a same-named org collapse onto a
   * single name, so the second overwrites the first. {provider} expands to
   * "github" on GitHub repos, so this default reads identically to the old one
   * on any single-provider GitHub deployment -- it only diverges where the old
   * name was wrong.
   */
  default_service_pattern: string;
  /**
   * beta.78 (Feature 4): vault service-name pattern used by `harness_onboard`
   * to store a user's git token. Placeholders: {userid} (Slack user id),
   * {provider}. Default "git-pat:{userid}".
   *
   * This MUST be able to produce the same string as `default_service_pattern`,
   * or an onboarded token is stored under a name no session ever looks up --
   * onboarding reports success and the run dies later at clone. beta.133 makes
   * that reachable ({userid} now exists on both sides) and makes the broken
   * combination refuse at onboard time instead of failing silently.
   */
  onboard_service_pattern?: string;
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

// ---- Defaults ----

const DEFAULTS: HarnessConfig = {
  slack: {
    channel: "",
    authorised_users: [],
    native_progress_delivery: true,
    reactions: {
      ship_it: "rocket",
      abort: "x",
      pause: "pause_button",
      budget_bump: "moneybag",
    },
  },
  budgets: {
    monthly_per_user_usd: 1000,
    session_default_usd: 50,
    session_hard_ceiling_usd: 200,
    daily_warn_usd: 100,
    daily_max_usd: 200,
    monthly_warn_ratio: 0.8,
  },
  repos: {
    allowed: [],
    can_create: false,
    create_org: "",
    create_visibility: "private",
    default_base_branch: "main",
    draft_pr_on_nonpass: false,
  },
  models: {
    lead: "claude-fable-5",
    worker: "claude-sonnet-5",
    adversary: "claude-fable-5",
    classifier: "claude-haiku-4-5",
    // beta.126: make the declared default true in the config object too.
    //
    // b99 declared `"default": 64000` in the manifest, again in
    // config.schema.json, and a third time in the doc comment here ("Default
    // here: 64000"), but never put it in DEFAULTS. A JSON Schema `default` is
    // an annotation -- it describes a value, it does not supply one.
    //
    // In practice the ceiling still reached the subprocess, because
    // `buildSdkEnv` falls back to DEFAULT_SDK_MAX_OUTPUT_TOKENS (the same
    // 64000) when the parameter is undefined. So this was a consistency bug,
    // not an outage: `config.models.max_output_tokens` read back as undefined
    // for anyone inspecting the effective config, logging it, or reasoning
    // about it -- which is exactly what happened while diagnosing the b125
    // planning failure, and it cost an hour chasing the wrong cause.
    //
    // Two defaults for one value, in two files, is the actual defect. Kept as
    // a literal because config.ts imports nothing (importing the adapter here
    // would close a cycle); the b126 guard test asserts this equals
    // DEFAULT_SDK_MAX_OUTPUT_TOKENS so the pair cannot drift apart.
    max_output_tokens: 64000,
    auth: {
      credential_service: "",
      api_key_env: "ANTHROPIC_API_KEY",
    },
  },
  loop: {
    max_cycles: 3,
    adversarial_pass_ends_early: true,
    worker_timeout_seconds: 1800,
    adversary_timeout_seconds: 900,
    lead_timeout_seconds: 900,
    session_hard_timeout_seconds: 7200,
    time_extension_ask_enabled: true,
    time_extension_wait_seconds: 300,
    time_extension_default_seconds: 1800,
    stuck_loop_seconds: 2700,
    teardown_drain_seconds: 3600,
    stall_watchdog_seconds: 90,
    subtask_deadline_seconds: 2100,
    budget_reserve_ratio: 0.15,
    env_wait_retry_enabled: true,
    clarification_escalation_enabled: true,
    graceful_pr_on_review_crash: true,
    session_stall_seconds: 1800,
    stall_auto_terminal: true,
    stall_graceful_pr: true,
    abort_salvage_pr: true,
    ship_time_reserve_seconds: 600,
    stall_sweep_interval_seconds: 60,
    enforce_worker_context: true,
    revise_spec_turn_enabled: true,
    revise_spec_timeout_seconds: 180,
    skip_observe_reprobe_on_revise: true,
    revise_scoping_enabled: true,
    revise_targeted_planbase_window: true,
    deterministic_revise_mapping: true,
    worker_confab_detect: true,
    contract_rederive_enabled: true,
    contract_test_path_reconcile: true,
    contract_mismatch_escalation_enabled: true,
    ledger_reachability_guard_enabled: true,
    plan_path_validation_enabled: true,
    plan_path_writeback_enabled: true,
    lead_repo_scout_enabled: true,
    lead_scout_timeout_seconds: 420,
    lead_scout_max_turns: 60,
    lead_scout_max_chars: 32000,
    revise_adopt_orphan_findings: true,
    revise_max_adoptions_per_cycle: 3,
    revise_route_co_fix_owners: true,
    max_cycle_extensions: 1,
    workflow_scope_precheck: true,
    early_exit_no_change_cycle: true,
    ship_when_no_blocking_findings: true,
    auto_resolve_satisfied_contract: true,
    scope_blowout_file_threshold: 500,
    resume_ledger_guard_enabled: true,
    basename_rescue_enabled: true,
    file_written_accepts_rename: true,
    sdk_first_token_timeout_seconds: 30,
    sdk_stream_open_timeout_seconds: 120,
    worker_stream_idle_warn_seconds: 90,
    worker_timeout_retry_enabled: true,
    worker_timeout_max_attempts: 3,
    worker_first_token_retry_multiplier: 3,
    worker_first_token_retry_cap_seconds: 300,
    best_effort_verify: true,
    // beta.85: DEFAULT OFF. This fallback ran `tsc` + repo check-scripts LOCALLY
    // in the worktree when an observe VERIFY sub-task timed out -- the last
    // remaining local-execution path, against Carel's hard "never run locally,
    // ever" rule (verification is CI-only since beta.81). The runner code is
    // kept for opt-in, but the default no longer runs the repo's suite locally.
    scripted_verify_fallback: false,
    recovery_max_resumes: 3,
    recovery_resume_window_seconds: 60,
    recovery_resume_at_subtask: true,
    recovery_replan_guard: true,
    lead_json_retry_enabled: true,
    // beta.128: one more call when a COMPLETE plan fails JSON.parse. See the
    // field doc -- this is the `"seq_note":undefined` class, which neither the
    // truncation rung nor salvage can touch.
    lead_syntax_retry_enabled: true,
    // beta.94 (Feature 1): elide the idle-prone trailing pure-observe scope
    // "final verification" sub-task + run a deterministic harness-side scope
    // check that folds out-of-scope commits into the review. Default ON.
    deterministic_final_scope_check: true,
    // beta.94 (Feature 2): the loop.worker_idle_no_work audit event ALWAYS
    // fires on the conjunction; the ABORT is opt-in (default OFF, so beta.90's
    // observability-only behaviour is preserved).
    worker_idle_abort_enabled: false,
    worker_idle_consecutive_slow: 3,
    worker_idle_min_elapsed_seconds: 900,
  },
  ci: {
    wait_timeout_seconds: 900,
    poll_interval_seconds: 20,
    none_grace_seconds: 45,
    permanent_denial_polls: 2,
    max_repair_cycles: 1,
    repair_subtask_enabled: true,
    workflow_runs_fallback: true,
  },
  vercel: {
    api_key_env: "VERCEL_TOKEN",
    enabled: false,
    credential_service: "",
    project_id: "",
    preview_wait_seconds: 300,
    deploy_repair: {
      enabled: true,
      max_attempts: 3,
      budget_ratio: 0.25,
    },
  },
  storage: {
    state_db_path: "~/.openclaw/workspace/openclaw-agent-harness/state.db",
    worktree_root: "~/.openclaw/workspace/openclaw-agent-harness/worktrees",
    audit_retention_days: 90,
    prune_terminal_sessions: false,
    prune_terminal_sessions_days: 365,
    min_free_disk_bytes: 1024 * 1024 * 1024,
  },
  safety: {
    worker_permission_mode: "acceptEdits",
    // beta.32: widened so a worker can actually build/test/inspect to
    // self-verify a change. v2 OpenCode additionally needs `cd` (it prefixes
    // every command with `cd $worktree && …`), `mkdir`/`cp`/`mv`/`touch`
    // (its edit tool cannot create parent directories or rename files).
    // `ln` and `tee` stay off: a symlink or a redirected write is how you
    // plant a file the path denylist never sees. `rm`/`chmod` stay on the
    // token denylist. Bash args of the new mutators ARE path-checked, so
    // `cp x .env` is still refused when the denylist is loaded.
    bash_whitelist: [
      "git", "pnpm", "npm", "npx", "yarn", "node", "tsc", "tsx", "deno", "bun",
      "python", "python3", "pip", "pip3", "pytest", "go", "cargo", "make", "just",
      "ls", "cat", "grep", "rg", "head", "tail", "wc", "jq", "yq", "sed", "awk",
      "find", "which", "echo", "printf", "test", "true", "false", "pwd",
      "diff", "sort", "uniq", "cut", "tr", "env", "date", "basename", "dirname",
      "realpath", "xargs", "comm", "mkdir", "cd", "cp", "mv", "touch",
    ],
    // beta.57 (P2): shells added as argument-token denies -- the whitelist
    // already excludes them as base commands, but `xargs sh -c`, `find -exec
    // bash` and `env sh` smuggled an unguarded shell through whitelisted hosts.
    bash_denylist_tokens: ["sudo", "su", "rm", "shred", "mkfs", "dd", "chmod", "chown", "chgrp", "umount", "mount", "iptables", "reboot", "shutdown", "halt", "poweroff", "kill", "killall", "pkill", "sh", "bash", "zsh", "dash", "ksh", "fish"],
    // beta.110: the credential vault and its key are readable by anything
    // running as the harness uid -- and the worker subprocess DOES run as that
    // uid. Stripping the key out of the child's env (buildSdkEnv) stops
    // `echo $OAH_VAULT_KEY`; these entries stop `cat .../vault.key`. Both are
    // needed, and neither is a substitute for the other.
    path_denylist: [
      ".env", ".env.*", ".secrets/", "/etc/", "/root/", "~/.ssh/", "id_rsa", "id_ed25519",
      "harness-vault/", "vault.key", "vault.db",
    ],
    allow_git_push: false,
    allow_network_commands: false,
  },
  pat_routing: {
    overrides: {},
    commit_identity: {},
    default_service_pattern: "{provider}-{owner}",
    auth: {
      api_key_env: "GH_TOKEN",
    },
    user_identities: {},
    default_provider: "github",
    provider_by_owner: {},
    providers: {
      github: { api_base: "https://api.github.com", api_key_env: "GH_TOKEN" },
      gitlab: { api_base: "https://gitlab.com/api/v4", api_key_env: "GITLAB_TOKEN" },
    },
  },
  brief: {
    ingest_repo_conventions: true,
    convention_char_budget: 10000,
    repo_only_invariant: true,
    bimodal_clarify: true,
    bimodal_min_interpretations: 2,
    request_file_roots: [],
    request_file_max_bytes: 262144,
    confirm_before_spend: "high_risk",
    confirm_min_risk: "high",
  },
  verify: {
    // beta.81 (Track B / B4): the LOCAL check-script runner is RETIRED from the
    // verification spine -- verification is CI-only now (Carel: "I do not want
    // it to run locally, ever"). Default false. The runner code is kept only
    // for the scripted-verify FALLBACK of a timed-out observe VERIFY sub-task
    // (a deterministic diff/tsc rescue), NOT as a verify gate.
    run_repo_check_scripts: false,
    check_script_allowlist: ["okf:check", "lint", "typecheck", "test"],
    check_script_timeout_seconds: 600,
    typecheck_gate: true,
    check_script_heap_retry_mb: 8192,
  },
  logging: {
    level: "info",
  },
  log: {
    interaction_log_enabled: true,
    dir: "",
    full_prompts: false,
    retention_days: 14,
  },
  credentials: {
    dir: "harness-vault",
    key_env: "OAH_VAULT_KEY",
  },
};

/**
 * beta.25: validate the hierarchical pat_routing tree. Each person node must
 * carry a name, a real-looking email, and exactly one token pointer
 * (value|env|vault). Fails loud at config load so the operator never
 * discovers a missing email mid-run.
 */
export function validatePatHierarchy(pr: PatRoutingConfig): void {
  const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  for (const provider of ["github", "gitlab"] as const) {
    const orgs = pr[provider];
    if (!orgs) continue;
    for (const [org, people] of Object.entries(orgs)) {
      if (!people || typeof people !== "object") {
        throw new Error(`harness.pat_routing.${provider}.${org} must be an object of { person: {...} }`);
      }
      for (const [person, node] of Object.entries(people)) {
        const loc = `harness.pat_routing.${provider}.${org}.${person}`;
        if (!node || typeof node !== "object") throw new Error(`${loc} must be an object`);
        if (!node.name || !node.name.trim()) throw new Error(`${loc}.name is required`);
        if (!node.email || !emailRe.test(node.email)) throw new Error(`${loc}.email is required and must be a valid email`);
        const tp = node.token;
        if (!tp || typeof tp !== "object") throw new Error(`${loc}.token is required (one of value|env|vault)`);
        const set = [tp.value, tp.env, tp.vault].filter((x) => x !== undefined && x !== "");
        if (set.length === 0) throw new Error(`${loc}.token must set exactly one of value|env|vault (none set)`);
        if (set.length > 1) throw new Error(`${loc}.token must set exactly one of value|env|vault (${set.length} set)`);
      }
    }
  }
}

function mergeDeep<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (typeof base !== "object" || Array.isArray(base)) return (override as T) ?? base;
  if (typeof override !== "object" || Array.isArray(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[key];
    const o = (override as Record<string, unknown>)[key];
    if (
      b !== null &&
      typeof b === "object" &&
      !Array.isArray(b) &&
      o !== null &&
      typeof o === "object" &&
      !Array.isArray(o)
    ) {
      out[key] = mergeDeep(b, o);
    } else {
      out[key] = o ?? b;
    }
  }
  return out as T;
}

/**
 * PURE: did this config carry the removed `slack.listener_enabled` key?
 *
 * beta.133. Read off the RAW input, because `parseHarnessConfig` drops the key
 * and the parsed config can no longer answer. Bootstrap uses this to warn once
 * that the setting does nothing, which is the whole of what it should do -- the
 * old behaviour was to refuse startup unless a channel was supplied for a
 * listener that was deleted ninety-nine releases ago.
 */
export function declaresRemovedListenerFlag(input: unknown): boolean {
  const slack = (input as { slack?: unknown } | null | undefined)?.slack;
  if (!slack || typeof slack !== "object") return false;
  return Object.prototype.hasOwnProperty.call(slack, "listener_enabled");
}

/**
 * v2.0.0: `loop` keys that parallel sub-task dispatch owned, now removed.
 *
 * Kept as data rather than prose because three things must agree on the list:
 * the parse-time drop below, the startup warning, and the manifest entries
 * that let such a config through the gateway at all.
 */
export const REMOVED_LOOP_KEYS = ["subtask_concurrency", "parallel_independent_subtasks"] as const;

/**
 * PURE: which removed parallelism keys did this config carry?
 *
 * v2.0.0. Read off the RAW input, because `parseHarnessConfig` drops them and
 * the parsed config can no longer answer -- the same shape as
 * {@link declaresRemovedListenerFlag}.
 *
 * These keys MUST stay declared in `openclaw.plugin.json`. The gateway
 * validates an operator's config against that manifest with
 * `additionalProperties: false`, so deleting them there would not "remove a
 * setting" -- it would reject the operator's ENTIRE plugin config the moment
 * an existing one still named them, which is the beta.34 and rc.1 outage. They
 * are accepted, ignored, and warned about instead.
 */
export function declaresRemovedParallelKeys(input: unknown): string[] {
  const loop = (input as { loop?: unknown } | null | undefined)?.loop;
  if (!loop || typeof loop !== "object") return [];
  return REMOVED_LOOP_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(loop, k));
}

export function parseHarnessConfig(input: unknown): HarnessConfig {
  const merged = mergeDeep(DEFAULTS, input);

  // An old config may still carry `slack.listener_enabled`. Accept it and drop
  // it: the schemas keep the property so such a config still validates, but
  // nothing downstream should be able to read a setting nothing obeys.
  delete (merged.slack as unknown as Record<string, unknown>).listener_enabled;

  // v2.0.0: same treatment for the parallelism keys. Dropping them here is what
  // stops a stale `subtask_concurrency: 4` from reading as live configuration
  // in a dump or a log when nothing obeys it any more.
  for (const k of REMOVED_LOOP_KEYS) {
    delete (merged.loop as unknown as Record<string, unknown>)[k];
  }

  // Hard validation on safety-critical fields.
  //
  // `authorised_users` is always required: it gates who may invoke the
  // harness via agent tool calls, and who may drop control reactions.
  if (merged.slack.authorised_users.length === 0) {
    throw new Error("harness.slack.authorised_users must contain at least one Slack user id");
  }
  // beta.78 (Feature 3): budget coherence. The HARD (fatal) invariants stay
  // throws because a run built on them would be nonsensical. The SOFTER
  // incoherences (e.g. daily_max > monthly_per_user) are surfaced as loud
  // startup WARNINGS via assessBudgetCoherence() -> bootstrapHarnessAsync,
  // not boot-fails, so an operator mis-ordering doesn't brick the harness.
  if (merged.budgets.session_default_usd > merged.budgets.session_hard_ceiling_usd) {
    throw new Error("harness.budgets.session_default_usd must be <= session_hard_ceiling_usd");
  }
  if (merged.budgets.monthly_per_user_usd <= 0) {
    throw new Error("harness.budgets.monthly_per_user_usd must be > 0");
  }
  if (merged.budgets.daily_max_usd < merged.budgets.daily_warn_usd) {
    throw new Error("harness.budgets.daily_max_usd must be >= daily_warn_usd");
  }
  if (merged.vercel.deploy_repair) {
    const dr = merged.vercel.deploy_repair;
    if (dr.max_attempts < 1 || dr.max_attempts > 10) {
      throw new Error("harness.vercel.deploy_repair.max_attempts must be between 1 and 10");
    }
    if (dr.budget_ratio <= 0 || dr.budget_ratio > 1) {
      throw new Error("harness.vercel.deploy_repair.budget_ratio must be in (0, 1]");
    }
  }
  if (merged.repos.allowed.length === 0) {
    throw new Error("harness.repos.allowed must list at least one owner or owner/repo glob");
  }
  // beta.63 (Part A): clamp the stall watchdog window to a sane range. It must
  // be larger than the longest legit phase (adversary review + push) so a
  // healthy long run is never mis-detected as a stall. Clamp to >= 300s.
  if (typeof merged.loop.session_stall_seconds === "number" && merged.loop.session_stall_seconds < 300) {
    merged.loop.session_stall_seconds = 300;
  }
  // beta.67 (Bug A): clamp the EXTERNAL stall-sweep cadence to [15, 600]s.
  // Too fast wastes wakeups; too slow lets a dead-loop session linger.
  if (typeof merged.loop.stall_sweep_interval_seconds === "number") {
    merged.loop.stall_sweep_interval_seconds = Math.max(15, Math.min(600, merged.loop.stall_sweep_interval_seconds));
  }
  // beta.63 (Fix 2): clamp the per-check-script timeout to a sane floor.
  if (typeof merged.verify.check_script_timeout_seconds === "number" && merged.verify.check_script_timeout_seconds < 10) {
    merged.verify.check_script_timeout_seconds = 10;
  }
  // beta.64 (P0-1) / beta.65 (P0): clamp the PHASE-2 first-token watchdog window
  // (stream-open -> first-token). Phase 2 is always <10ms on success, so 30s is
  // generous; kept clamp [10, 1800] for operator flexibility.
  if (typeof merged.loop.worker_timeout_max_attempts === "number") {
    if (merged.loop.worker_timeout_max_attempts < 1) merged.loop.worker_timeout_max_attempts = 1;
    if (merged.loop.worker_timeout_max_attempts > 5) merged.loop.worker_timeout_max_attempts = 5;
  }
  if (typeof merged.loop.worker_first_token_retry_multiplier === "number") {
    if (merged.loop.worker_first_token_retry_multiplier < 1) merged.loop.worker_first_token_retry_multiplier = 1;
    if (merged.loop.worker_first_token_retry_multiplier > 10) merged.loop.worker_first_token_retry_multiplier = 10;
  }
  if (typeof merged.loop.worker_first_token_retry_cap_seconds === "number") {
    if (merged.loop.worker_first_token_retry_cap_seconds < 10) merged.loop.worker_first_token_retry_cap_seconds = 10;
    if (merged.loop.worker_first_token_retry_cap_seconds > 1800) merged.loop.worker_first_token_retry_cap_seconds = 1800;
  }
  if (typeof merged.loop.sdk_first_token_timeout_seconds === "number") {
    if (merged.loop.sdk_first_token_timeout_seconds < 10) merged.loop.sdk_first_token_timeout_seconds = 10;
    if (merged.loop.sdk_first_token_timeout_seconds > 1800) merged.loop.sdk_first_token_timeout_seconds = 1800;
  }
  // beta.65 (P0): clamp the PHASE-1 stream-open watchdog window (call-init ->
  // stream-open). Phase 1 is highly variable even on success (seq-2 legit 422s),
  // so the window is longer than phase 2, but a breach is a benign fresh-session
  // retry, not a terminal fail. Clamp [10, 600].
  if (typeof merged.loop.sdk_stream_open_timeout_seconds === "number") {
    if (merged.loop.sdk_stream_open_timeout_seconds < 10) merged.loop.sdk_stream_open_timeout_seconds = 10;
    if (merged.loop.sdk_stream_open_timeout_seconds > 600) merged.loop.sdk_stream_open_timeout_seconds = 600;
  }
  // beta.90 (Feature 2): clamp the worker STREAM-SLOW idle-warn window. Floor 30
  // (one tick cadence; anything lower is noise), ceiling 600 (10 min -- past
  // that a stall watchdog / worker timeout owns the outcome). This is
  // observability, never a hard fail, so the range is generous.
  if (typeof merged.loop.worker_stream_idle_warn_seconds === "number") {
    if (merged.loop.worker_stream_idle_warn_seconds < 30) merged.loop.worker_stream_idle_warn_seconds = 30;
    if (merged.loop.worker_stream_idle_warn_seconds > 600) merged.loop.worker_stream_idle_warn_seconds = 600;
  }
  // beta.94 (Feature 2): clamp the idle-no-work conjunction thresholds. The
  // consecutive-slow floor is 2 (a single tick is noise); the elapsed floor is
  // 60s so a genuinely-slow-but-alive worker is never mistaken for idle. Both
  // are generous ceilings because this is a narrow LAST-RESORT abort, not a
  // primary timeout (the worker_timeout / stall watchdog own the normal path).
  if (typeof merged.loop.worker_idle_consecutive_slow === "number") {
    merged.loop.worker_idle_consecutive_slow = Math.max(2, Math.min(20, Math.round(merged.loop.worker_idle_consecutive_slow)));
  }
  if (typeof merged.loop.worker_idle_min_elapsed_seconds === "number") {
    merged.loop.worker_idle_min_elapsed_seconds = Math.max(60, Math.min(3600, merged.loop.worker_idle_min_elapsed_seconds));
  }
  // beta.81 (Track B / B2): clamp the CI-wait window + poll cadence. The wait
  // is a SOFT checkpoint (surfaces + offers resume on timeout, never a hard
  // fail), so the range is generous; the poll interval floors at 5s so a fast
  // CI is not hammered and ceilings at 300s so a slow CI is not missed.
  if (typeof merged.ci?.wait_timeout_seconds === "number") {
    merged.ci.wait_timeout_seconds = Math.max(30, Math.min(7200, merged.ci.wait_timeout_seconds));
  }
  if (typeof merged.ci?.none_grace_seconds === "number") {
    merged.ci.none_grace_seconds = Math.max(0, Math.min(300, merged.ci.none_grace_seconds));
  }
  if (typeof merged.ci?.poll_interval_seconds === "number") {
    merged.ci.poll_interval_seconds = Math.max(5, Math.min(300, merged.ci.poll_interval_seconds));
  }
  if (merged.vercel.enabled) {
    if (!merged.vercel.credential_service) throw new Error("harness.vercel.credential_service required when vercel.enabled");
    if (!merged.vercel.project_id) throw new Error("harness.vercel.project_id required when vercel.enabled");
  }

  // beta.25: validate the hierarchical pat_routing tree up front so
  // operators find misconfig at config-load / reload, not mid-run.
  validatePatHierarchy(merged.pat_routing);

  return merged;
}

/**
 * beta.78 (Feature 3): pure budget-coherence assessment.
 *
 * Carel's ask: "If the budgets do not match up the harness should raise
 * this. Max daily is 200 but max monthly is 100?" This surfaces INCOHERENT
 * budget configs as loud warnings at startup instead of silently letting a
 * daily cap exceed the monthly cap (which makes the monthly cap unreachable
 * as a per-day limiter and vice-versa).
 *
 * SIDE-EFFECT FREE + pure so it is trivially unit-testable and safe to call
 * from bootstrap. Returns a list of human-readable warning strings; an empty
 * list means the budgets are coherent. The HARD/fatal invariants
 * (session_default <= hard_ceiling, monthly > 0, daily_max >= daily_warn)
 * are enforced as throws in normaliseConfig(); this covers the softer
 * ordering/coherence relationships that should WARN, not brick the boot.
 *
 * Expected sane ordering: session_default <= session_hard_ceiling <=
 * daily_max <= monthly_per_user.
 */
export function assessBudgetCoherence(b: BudgetsConfig): string[] {
  const warnings: string[] = [];
  const {
    session_default_usd: sd,
    session_hard_ceiling_usd: hc,
    daily_max_usd: dm,
    daily_warn_usd: dw,
    monthly_per_user_usd: mo,
  } = b;

  // The headline case from Carel: daily cap exceeds monthly cap.
  if (dm > mo) {
    warnings.push(
      `daily_max_usd ($${dm}) exceeds monthly_per_user_usd ($${mo}) -- a user could never actually reach the daily cap before the monthly cap stops them; the daily limit is effectively dead.`,
    );
  }
  // A single session should not be allowed to blow the whole day.
  if (hc > dm) {
    warnings.push(
      `session_hard_ceiling_usd ($${hc}) exceeds daily_max_usd ($${dm}) -- one session can exhaust or overshoot a user's entire daily budget in a single run.`,
    );
  }
  // A single session should not be allowed to blow the whole month.
  if (hc > mo) {
    warnings.push(
      `session_hard_ceiling_usd ($${hc}) exceeds monthly_per_user_usd ($${mo}) -- one session can exhaust a user's entire monthly budget.`,
    );
  }
  // Warn threshold above hard cap is pointless (never fires).
  if (dw > dm) {
    warnings.push(
      `daily_warn_usd ($${dw}) exceeds daily_max_usd ($${dm}) -- the daily warning would never fire before the hard stop.`,
    );
  }
  // Non-positive values that are not caught by the fatal checks.
  if (sd <= 0) warnings.push(`session_default_usd ($${sd}) should be > 0.`);
  if (hc <= 0) warnings.push(`session_hard_ceiling_usd ($${hc}) should be > 0.`);
  if (dm <= 0) warnings.push(`daily_max_usd ($${dm}) should be > 0 to act as a real hard stop.`);

  return warnings;
}
