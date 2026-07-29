/**
 * Plugin configuration types + parser.
 *
 * The parser is used both by the plugin's `configSchema.parse` hook and by
 * `bootstrapHarness()` at register time. It is intentionally strict on the
 * critical safety fields (allow-lists, budgets) and permissive on the rest
 * (falls back to sensible defaults).
 */
// ---- Defaults ----
const DEFAULTS = {
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
export function validatePatHierarchy(pr) {
    const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    for (const provider of ["github", "gitlab"]) {
        const orgs = pr[provider];
        if (!orgs)
            continue;
        for (const [org, people] of Object.entries(orgs)) {
            if (!people || typeof people !== "object") {
                throw new Error(`harness.pat_routing.${provider}.${org} must be an object of { person: {...} }`);
            }
            for (const [person, node] of Object.entries(people)) {
                const loc = `harness.pat_routing.${provider}.${org}.${person}`;
                if (!node || typeof node !== "object")
                    throw new Error(`${loc} must be an object`);
                if (!node.name || !node.name.trim())
                    throw new Error(`${loc}.name is required`);
                if (!node.email || !emailRe.test(node.email))
                    throw new Error(`${loc}.email is required and must be a valid email`);
                const tp = node.token;
                if (!tp || typeof tp !== "object")
                    throw new Error(`${loc}.token is required (one of value|env|vault)`);
                const set = [tp.value, tp.env, tp.vault].filter((x) => x !== undefined && x !== "");
                if (set.length === 0)
                    throw new Error(`${loc}.token must set exactly one of value|env|vault (none set)`);
                if (set.length > 1)
                    throw new Error(`${loc}.token must set exactly one of value|env|vault (${set.length} set)`);
            }
        }
    }
}
function mergeDeep(base, override) {
    if (override === null || override === undefined)
        return base;
    if (typeof base !== "object" || Array.isArray(base))
        return override ?? base;
    if (typeof override !== "object" || Array.isArray(override))
        return base;
    const out = { ...base };
    for (const key of Object.keys(override)) {
        const b = base[key];
        const o = override[key];
        if (b !== null &&
            typeof b === "object" &&
            !Array.isArray(b) &&
            o !== null &&
            typeof o === "object" &&
            !Array.isArray(o)) {
            out[key] = mergeDeep(b, o);
        }
        else {
            out[key] = o ?? b;
        }
    }
    return out;
}
export function parseHarnessConfig(input) {
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
        if (merged.loop.sdk_first_token_timeout_seconds < 10)
            merged.loop.sdk_first_token_timeout_seconds = 10;
        if (merged.loop.sdk_first_token_timeout_seconds > 1800)
            merged.loop.sdk_first_token_timeout_seconds = 1800;
    }
    // beta.65 (P0): clamp the PHASE-1 stream-open watchdog window (call-init ->
    // stream-open). Phase 1 is highly variable even on success (seq-2 legit 422s),
    // so the window is longer than phase 2, but a breach is a benign fresh-session
    // retry, not a terminal fail. Clamp [10, 600].
    if (typeof merged.loop.sdk_stream_open_timeout_seconds === "number") {
        if (merged.loop.sdk_stream_open_timeout_seconds < 10)
            merged.loop.sdk_stream_open_timeout_seconds = 10;
        if (merged.loop.sdk_stream_open_timeout_seconds > 600)
            merged.loop.sdk_stream_open_timeout_seconds = 600;
    }
    // beta.90 (Feature 2): clamp the worker STREAM-SLOW idle-warn window. Floor 30
    // (one tick cadence; anything lower is noise), ceiling 600 (10 min -- past
    // that a stall watchdog / worker timeout owns the outcome). This is
    // observability, never a hard fail, so the range is generous.
    if (typeof merged.loop.worker_stream_idle_warn_seconds === "number") {
        if (merged.loop.worker_stream_idle_warn_seconds < 30)
            merged.loop.worker_stream_idle_warn_seconds = 30;
        if (merged.loop.worker_stream_idle_warn_seconds > 600)
            merged.loop.worker_stream_idle_warn_seconds = 600;
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
        if (!merged.vercel.credential_service)
            throw new Error("harness.vercel.credential_service required when vercel.enabled");
        if (!merged.vercel.project_id)
            throw new Error("harness.vercel.project_id required when vercel.enabled");
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
export function assessBudgetCoherence(b) {
    const warnings = [];
    const { session_default_usd: sd, session_hard_ceiling_usd: hc, daily_max_usd: dm, daily_warn_usd: dw, monthly_per_user_usd: mo, } = b;
    // The headline case from Carel: daily cap exceeds monthly cap.
    if (dm > mo) {
        warnings.push(`daily_max_usd ($${dm}) exceeds monthly_per_user_usd ($${mo}) -- a user could never actually reach the daily cap before the monthly cap stops them; the daily limit is effectively dead.`);
    }
    // A single session should not be allowed to blow the whole day.
    if (hc > dm) {
        warnings.push(`session_hard_ceiling_usd ($${hc}) exceeds daily_max_usd ($${dm}) -- one session can exhaust or overshoot a user's entire daily budget in a single run.`);
    }
    // A single session should not be allowed to blow the whole month.
    if (hc > mo) {
        warnings.push(`session_hard_ceiling_usd ($${hc}) exceeds monthly_per_user_usd ($${mo}) -- one session can exhaust a user's entire monthly budget.`);
    }
    // Warn threshold above hard cap is pointless (never fires).
    if (dw > dm) {
        warnings.push(`daily_warn_usd ($${dw}) exceeds daily_max_usd ($${dm}) -- the daily warning would never fire before the hard stop.`);
    }
    // Non-positive values that are not caught by the fatal checks.
    if (sd <= 0)
        warnings.push(`session_default_usd ($${sd}) should be > 0.`);
    if (hc <= 0)
        warnings.push(`session_hard_ceiling_usd ($${hc}) should be > 0.`);
    if (dm <= 0)
        warnings.push(`daily_max_usd ($${dm}) should be > 0 to act as a real hard stop.`);
    return warnings;
}
//# sourceMappingURL=config.js.map