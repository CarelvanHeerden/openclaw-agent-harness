/**
 * The OpenCode configuration the harness hands its agent.
 *
 * This is a security control, not a convenience. The M2 capability probe
 * measured OpenCode on default configuration running four shell commands and
 * two file edits and issuing ZERO permission requests — which means the harness
 * guard was never consulted, and `bash_whitelist` and `path_denylist` were
 * silently inert while still reading as enabled in `openclaw.json`. The same
 * run, with `permission` set, produced a permission request for every call
 * carrying exactly the fields the guard needs.
 *
 * So the configuration is what makes the ACP path as safe as the SDK path it
 * stands in for, and the harness generates it rather than asking an operator to
 * maintain a second file correctly.
 *
 * WHY AN ENVIRONMENT VARIABLE. `OPENCODE_CONFIG_CONTENT` carries the whole
 * document and takes precedence over every on-disk `opencode.json`. Writing a
 * file into the worktree instead would put the control INSIDE the thing the
 * worker can edit: a worker that rewrites `opencode.json` and re-runs anything
 * has removed its own guard. It would also collide with a repo that has its own
 * OpenCode configuration, and the precedence rules between them are not
 * something to be discovering at runtime.
 *
 * The variable is added to interaction-log redaction, because once M7 puts
 * provider keys in the `provider` block this document is a credential.
 */
/**
 * Every permission key OpenCode 1.18.23 actually consults.
 *
 * PERMISSION KEYS ARE NOT TOOL IDS, and conflating the two is how the first
 * version of this list shipped three keys that do nothing. `permission` is
 * keyed by the name a tool ASKS UNDER, which is often not its own id:
 *
 *   - `write` and `apply_patch` both ask under `edit`. There is no `patch` key;
 *     the tool is `apply_patch`. Naming `patch` guarded nothing.
 *   - `list` is a dead key. It survives in the published JSON schema for
 *     legacy reasons, but no tool and no permission check reference it.
 *   - `todoread` does not exist anywhere in the 1.18.23 source.
 *
 * The schema at `https://opencode.ai/config.json` will not catch any of that:
 * it sets `additionalProperties`, so it accepts every typo silently.
 *
 * WHY NAMING EVERY KEY IS LOAD-BEARING, and not, as this comment previously
 * claimed, a belt-and-braces gesture on top of a wildcard that does the real
 * work. Two facts about OpenCode combine badly:
 *
 *   1. `permission` is deep-merged per key, and `OPENCODE_CONFIG_CONTENT`
 *      merges AFTER a repo-local `opencode.json`. Merging preserves the
 *      target's key ORDER: an overwritten key keeps the repo's position, and
 *      only a genuinely new key is appended.
 *   2. Rules are evaluated LAST-MATCH-WINS BY INSERTION ORDER. `"*"` has no
 *      special standing. OpenCode's own docs tell you to put the catch-all
 *      first and the specific rules after it, precisely because later wins.
 *
 * So a repository containing `{"*": "allow", "websearch": "allow"}` defeats an
 * injected `{"*": "ask"}` completely: our wildcard overwrites theirs IN PLACE
 * at position 0, their `websearch: allow` still sits after it, and last-match
 * hands the model an unguarded network egress channel. Naming `websearch`
 * ourselves overwrites that entry in place too, and closes it.
 *
 * THE RESIDUAL HOLE, stated plainly because it is not closed. The wildcard
 * cannot protect a key we have not named: any permission a future OpenCode
 * adds, that a hostile repository names and allows, sorts after our `"*"` and
 * wins. Only keys in this list are actually pinned. That is a real limit on
 * the guard, it is version-coupled by construction, and it is part of why
 * `SECURITY.md` marks non-Anthropic workers trusted-repo-only.
 *
 * Verified against the `v1.18.23` tag (`ef2880f3`) and by running the binary.
 */
export const OPENCODE_PERMISSION_KEYS = [
    // Consulted by a tool in 1.18.23.
    "bash",
    "edit",
    "read",
    "glob",
    "grep",
    "task",
    "todowrite",
    "webfetch",
    "websearch",
    "skill",
    "lsp",
    "question",
    "external_directory",
    "doom_loop",
    "plan_enter",
    "plan_exit",
    // Inert TODAY — both ask under `edit` — and named anyway. These are the two
    // most likely keys to be split back out by a future version, and an unnamed
    // key is one a hostile repository can allow past our wildcard. Costs a line
    // each; the failure it covers is a silent write bypass after an upgrade.
    "write",
    "apply_patch",
    // MCP tools are installation-specific and cannot be enumerated. The prefix
    // wildcard is the only handle OpenCode gives us, and it has the same
    // ordering weakness as `"*"` — a repository naming a specific `mcp_foo`
    // still beats it.
    "mcp_*",
];
/**
 * Every tool id OpenCode 1.18.23 can register.
 *
 * A DIFFERENT LIST from the permission keys above, and it has to be: `tools`
 * is keyed by tool id, `permission` by the name a tool asks under. Feeding one
 * list to both — which is what shipped — puts `external_directory` and
 * `mcp_*` into a `tools` block that has no such tools, and omits `execute`,
 * which is a real one.
 *
 * Conditional registrations are included. `execute`, `lsp`, `plan_exit` and
 * `question` only appear behind their respective flags, but disabling a tool
 * that was never registered is free, and the alternative is a list that goes
 * wrong the moment an operator sets an experimental flag.
 *
 * `invalid` is deliberately absent: it is OpenCode's internal placeholder for
 * an unresolvable call, not something a model can invoke.
 */
export const OPENCODE_TOOL_IDS = [
    "bash",
    "read",
    "glob",
    "grep",
    "edit",
    "write",
    "apply_patch",
    "task",
    "webfetch",
    "websearch",
    "todowrite",
    "skill",
    "question",
    "lsp",
    "execute",
    "plan_exit",
];
/**
 * @deprecated Was neither a complete nor an accurate list of tool ids, and was
 * used for both `permission` and `tools`. Use `OPENCODE_PERMISSION_KEYS` or
 * `OPENCODE_TOOL_IDS` — whichever block you are actually filling in.
 */
export const OPENCODE_TOOLS = OPENCODE_PERMISSION_KEYS;
/**
 * Build the configuration document.
 *
 * Returns an object; `serialiseOpenCodeConfig` produces the string that goes
 * into the environment. Kept separate so a test can assert on the structure
 * rather than on JSON formatting.
 */
export function buildOpenCodeConfig(input = {}) {
    const permission = {
        // FIRST, and the order is the point. Rules are last-match-wins by
        // insertion order, so a catch-all placed first is overridden by the
        // specific entries after it -- which is what OpenCode's own docs
        // recommend, and the opposite of what "wildcard as final safety net"
        // would imply. It covers only permissions nobody else names.
        "*": "ask",
    };
    for (const key of OPENCODE_PERMISSION_KEYS)
        permission[key] = "ask";
    const config = {
        $schema: "https://opencode.ai/config.json",
        permission,
    };
    if (input.toolless) {
        // Belt and braces for the six structured roles. `tools: {..false}` is the
        // mechanism; the deny-all guard in `runStructuredAcp` is the layer that
        // does not depend on the backend honouring its own configuration. Both are
        // here because `preflightAcpBackend` exists precisely because a backend
        // ignoring its permission config is a thing that has been observed.
        const tools = {};
        for (const tool of OPENCODE_TOOL_IDS)
            tools[tool] = false;
        config.tools = tools;
    }
    if (input.provider && Object.keys(input.provider).length > 0)
        config.provider = input.provider;
    if (input.model)
        config.model = input.model;
    return config;
}
export function serialiseOpenCodeConfig(input = {}) {
    return JSON.stringify(buildOpenCodeConfig(input));
}
/**
 * The environment entry for an ACP agent spec.
 *
 * A single named place so the variable name is written once. It is spelled out
 * in `AcpAgentSpec.env`, which `buildAgentEnv` applies AFTER the deny-list —
 * that ordering is what lets a document containing provider keys reach the
 * child while nothing else does.
 */
export function openCodeConfigEnv(input = {}) {
    return { OPENCODE_CONFIG_CONTENT: serialiseOpenCodeConfig(input) };
}
//# sourceMappingURL=opencode-config.js.map