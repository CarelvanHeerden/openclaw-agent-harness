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
        monthly_warn_ratio: 0.8,
    },
    repos: {
        allowed: [],
        can_create: false,
        create_org: "",
        create_visibility: "private",
        default_base_branch: "main",
    },
    models: {
        lead: "claude-fable-5",
        worker: "claude-sonnet-5",
        adversary: "claude-fable-5",
        classifier: "claude-haiku-4-5",
    },
    loop: {
        max_cycles: 3,
        adversarial_pass_ends_early: true,
        worker_timeout_seconds: 1800,
        adversary_timeout_seconds: 900,
        session_hard_timeout_seconds: 7200,
        subtask_concurrency: 1,
    },
    vercel: {
        enabled: false,
        credential_service: "",
        project_id: "",
        preview_wait_seconds: 300,
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
        bash_whitelist: ["git", "pnpm", "npm", "node", "ls", "cat", "grep", "head", "tail", "wc", "jq", "sed", "awk", "find", "which", "echo", "printf", "test"],
        bash_denylist_tokens: ["sudo", "su", "rm", "shred", "mkfs", "dd", "chmod", "chown", "chgrp", "umount", "mount", "iptables", "reboot", "shutdown", "halt", "poweroff", "kill", "killall", "pkill"],
        path_denylist: [".env", ".env.*", ".secrets/", "/etc/", "/root/", "~/.ssh/", "id_rsa", "id_ed25519"],
        allow_git_push: false,
        allow_network_commands: false,
    },
    pat_routing: {
        overrides: {},
        commit_identity: {},
        default_service_pattern: "github-{user}-{org}",
    },
};
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
    // Hard validation on safety-critical fields
    if (!merged.slack.channel) {
        throw new Error("harness.slack.channel is required");
    }
    if (merged.slack.authorised_users.length === 0) {
        throw new Error("harness.slack.authorised_users must contain at least one Slack user id");
    }
    if (merged.budgets.session_default_usd > merged.budgets.session_hard_ceiling_usd) {
        throw new Error("harness.budgets.session_default_usd must be <= session_hard_ceiling_usd");
    }
    if (merged.budgets.monthly_per_user_usd <= 0) {
        throw new Error("harness.budgets.monthly_per_user_usd must be > 0");
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
    return merged;
}
//# sourceMappingURL=config.js.map