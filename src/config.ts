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
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
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
}

export interface ModelsConfig {
  lead: string;
  worker: string;
  adversary: string;
  classifier: string;
  /** Optional per-model price overrides for cost estimation. Set when Anthropic ships new pricing before we release. Keys are model ids (e.g. 'claude-fable-5'). Values are USD per million tokens. */
  price_overrides?: Record<string, { input: number; output: number }>;
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
   * beta.84 (#2): HARD timeout (seconds) on the Fable revise-spec turn.
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
   * beta.81 (Track C): give the LEAD re-plan SDK call the same "retry once on
   * extractJson failure" guard the classifier has (runClassifierSdk), so a
   * transient prose-drift (the lead returns prose instead of the JSON plan
   * contract -- the beta.40 anti-persona-drift class, which crashed the
   * d01a7484 re-plan) does not hard-crash the plan. Default true.
   */
  lead_json_retry_enabled?: boolean;
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
   * beta.78 (Feature 4): vault service-name pattern used by `harness_onboard`
   * to store a user's git token. Placeholders: {userid} (Slack user id),
   * {provider}. Default "git-pat:{userid}". Keep this consistent with
   * `default_service_pattern` so an onboarded token is actually resolved for
   * that user's runs.
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
    listener_enabled: false,
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
    subtask_concurrency: 1,
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
    stall_sweep_interval_seconds: 60,
    enforce_worker_context: true,
    revise_spec_turn_enabled: true,
    revise_spec_timeout_seconds: 180,
    skip_observe_reprobe_on_revise: true,
    sdk_first_token_timeout_seconds: 30,
    sdk_stream_open_timeout_seconds: 120,
    worker_stream_idle_warn_seconds: 90,
    worker_timeout_retry_enabled: true,
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
    lead_json_retry_enabled: true,
  },
  ci: {
    wait_timeout_seconds: 900,
    poll_interval_seconds: 20,
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
    // self-verify a change. The old list lacked tsc/make/python/pytest/diff
    // etc., so a worker that ran a build or test after editing hit a hard
    // reject. Deliberately EXCLUDES file-mutating shell commands
    // (cp/mv/ln/tee/mkdir/touch): file writes must go through the SDK
    // Write/Edit tools, which enforce `path_denylist` (bash args are NOT
    // path-denylist-checked, so allowing `cp x .env` here would bypass it).
    // bash_denylist_tokens below remain the hard safety guard.
    bash_whitelist: [
      "git", "pnpm", "npm", "npx", "yarn", "node", "tsc", "tsx", "deno", "bun",
      "python", "python3", "pip", "pip3", "pytest", "go", "cargo", "make", "just",
      "ls", "cat", "grep", "rg", "head", "tail", "wc", "jq", "yq", "sed", "awk",
      "find", "which", "echo", "printf", "test", "true", "false", "pwd",
      "diff", "sort", "uniq", "cut", "tr", "env", "date", "basename", "dirname",
      "realpath", "xargs", "comm",
    ],
    // beta.57 (P2): shells added as argument-token denies -- the whitelist
    // already excludes them as base commands, but `xargs sh -c`, `find -exec
    // bash` and `env sh` smuggled an unguarded shell through whitelisted hosts.
    bash_denylist_tokens: ["sudo", "su", "rm", "shred", "mkfs", "dd", "chmod", "chown", "chgrp", "umount", "mount", "iptables", "reboot", "shutdown", "halt", "poweroff", "kill", "killall", "pkill", "sh", "bash", "zsh", "dash", "ksh", "fish"],
    path_denylist: [".env", ".env.*", ".secrets/", "/etc/", "/root/", "~/.ssh/", "id_rsa", "id_ed25519"],
    allow_git_push: false,
    allow_network_commands: false,
  },
  pat_routing: {
    overrides: {},
    commit_identity: {},
    default_service_pattern: "github-{owner}",
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

export function parseHarnessConfig(input: unknown): HarnessConfig {
  const merged = mergeDeep(DEFAULTS, input);

  // Hard validation on safety-critical fields.
  //
  // `slack.channel` is only required in autonomous listener mode. In the
  // default agent-orchestrated mode the OpenClaw agent drives the harness
  // via tools, so no channel to listen on is needed.
  if (merged.slack.listener_enabled && !merged.slack.channel) {
    throw new Error("harness.slack.channel is required when slack.listener_enabled is true");
  }
  // `authorised_users` is always required: it gates who may invoke the
  // harness (whether via the listener OR via agent tool calls) and who may
  // drop control reactions.
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
  // beta.81 (Track B / B2): clamp the CI-wait window + poll cadence. The wait
  // is a SOFT checkpoint (surfaces + offers resume on timeout, never a hard
  // fail), so the range is generous; the poll interval floors at 5s so a fast
  // CI is not hammered and ceilings at 300s so a slow CI is not missed.
  if (typeof merged.ci?.wait_timeout_seconds === "number") {
    merged.ci.wait_timeout_seconds = Math.max(30, Math.min(7200, merged.ci.wait_timeout_seconds));
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
