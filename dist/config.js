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
        bash_denylist_tokens: ["sudo", "su", "rm", "shred", "mkfs", "dd", "chmod", "chown", "chgrp", "umount", "mount", "iptables", "reboot", "shutdown", "halt", "poweroff", "kill", "killall", "pkill"],
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
    logging: {
        level: "info",
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
//# sourceMappingURL=config.js.map