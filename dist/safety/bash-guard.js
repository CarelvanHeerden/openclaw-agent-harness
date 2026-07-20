/**
 * Bash command guard.
 *
 * Replaces the naive regex denylist. Tokenises the command with a small
 * POSIX-ish parser, walks the token list, and rejects on:
 *   - a base command not in the whitelist,
 *   - any token in a denylist pattern,
 *   - any pipe segment whose command is not in the whitelist,
 *   - any `git push` (regardless of args),
 *   - any subshell/backtick/command-substitution (parsed but rejected),
 *   - any redirection to `/dev/tcp`, `/dev/udp` (exfiltration channels).
 *
 * NOT a full shell parser. It is deliberately conservative: ambiguous input
 * is rejected. If a legitimate command is rejected, add it to the whitelist
 * or split the operation into simpler steps.
 */
const NETWORK_COMMANDS = ["curl", "wget", "nc", "ncat", "ssh", "scp", "rsync"];
const DENYLIST_TOKEN_DEFAULTS = [
    "sudo",
    "su",
    "rm",
    "shred",
    "mkfs",
    "dd",
    "chmod",
    "chown",
    "chgrp",
    "umount",
    "mount",
    "iptables",
    "reboot",
    "shutdown",
    "halt",
    "poweroff",
    "kill",
    "killall",
    "pkill",
];
export function defaultGuardConfig() {
    return {
        // beta.32: keep in sync with config.ts safety.bash_whitelist default.
        // Production uses the config value; this is the standalone fallback.
        // Excludes file-mutating shell commands (writes go through SDK Write/Edit
        // which enforce path_denylist).
        whitelist: [
            "git", "pnpm", "npm", "npx", "yarn", "node", "tsc", "tsx", "deno", "bun",
            "python", "python3", "pip", "pip3", "pytest", "go", "cargo", "make", "just",
            "ls", "cat", "grep", "rg", "head", "tail", "wc", "jq", "yq", "sed", "awk",
            "find", "which", "echo", "printf", "test", "true", "false", "pwd",
            "diff", "sort", "uniq", "cut", "tr", "env", "date", "basename", "dirname",
            "realpath", "xargs", "comm",
        ],
        denylistTokens: DENYLIST_TOKEN_DEFAULTS,
        allowGitPush: false,
        allowNetworkCommands: false,
    };
}
/**
 * Simple POSIX-ish tokeniser. Handles single/double quotes and escapes but
 * treats subshells and command substitution as a hard reject signal.
 */
export function tokenise(cmd) {
    const tokens = [];
    let cur = "";
    let quote = null;
    let i = 0;
    const push = () => {
        if (cur.length > 0)
            tokens.push(cur);
        cur = "";
    };
    while (i < cmd.length) {
        const ch = cmd[i];
        if (quote === null && (ch === "`" || (ch === "$" && cmd[i + 1] === "("))) {
            return { tokens, error: "command substitution not allowed" };
        }
        if (quote === null && ch === "\\") {
            cur += cmd[i + 1] ?? "";
            i += 2;
            continue;
        }
        if (quote === null && (ch === '"' || ch === "'")) {
            quote = ch;
            i++;
            continue;
        }
        if (quote !== null && ch === quote) {
            quote = null;
            i++;
            continue;
        }
        if (quote === null && /\s/.test(ch)) {
            push();
            i++;
            continue;
        }
        // Split on shell operators as their own tokens
        if (quote === null && (ch === "|" || ch === "&" || ch === ";" || ch === ">" || ch === "<")) {
            push();
            // Consume operator (handling && || >> etc)
            let op = ch;
            if (cmd[i + 1] === ch) {
                op += cmd[i + 1];
                i += 2;
            }
            else {
                i++;
            }
            tokens.push(op);
            continue;
        }
        cur += ch;
        i++;
    }
    if (quote !== null)
        return { tokens, error: "unterminated quote" };
    push();
    return { tokens };
}
const OPERATORS = new Set(["|", "||", "&", "&&", ";", ">", ">>", "<", "<<"]);
// beta.48 (P5): a redirect operator attaches a file to the CURRENT command;
// it does NOT start a new command. Its following token is a redirect TARGET
// (a filename), not a command name. Treating `>` as a segment boundary meant
// `foo 2>/dev/null` tokenised to [`foo`,`2`,`>`,`/dev/null`] and split into a
// second "segment" whose base was `/dev/null` -> rejected as `command
// "/dev/null" not in whitelist`. The worker (session dca2f3b5) hit this twice.
// True SEGMENT separators (pipe / list) start a new command; REDIRECTS do not.
const SEGMENT_SEPARATORS = new Set(["|", "||", "&", "&&", ";"]);
const REDIRECT_OPERATORS = new Set([">", ">>", "<", "<<"]);
/**
 * Split token list into pipe/list segments. Each segment is a list of tokens
 * representing one command. Segments are separated by pipe/list operators
 * only. Redirect operators (`>`, `>>`, `<`, `<<`) and their immediately
 * following target token are stripped from the segment so the redirect target
 * (a filename like /dev/null) is never mistaken for a command. The network
 * exfiltration check on /dev/tcp|/dev/udp runs separately over the FULL token
 * list in guardCommand (before this split), so dropping targets here does not
 * weaken that check.
 */
function splitSegments(tokens) {
    const segments = [];
    let cur = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (SEGMENT_SEPARATORS.has(t)) {
            if (cur.length > 0)
                segments.push(cur);
            cur = [];
        }
        else if (REDIRECT_OPERATORS.has(t)) {
            // Skip the redirect operator AND its target token (the filename that
            // follows). e.g. `> /dev/null`, `2>> log.txt`, `< input`.
            // Also drop a trailing bare file-descriptor prefix already pushed onto
            // cur (the `2` in `foo 2>/dev/null`) so it isn't left as a stray arg.
            const last = cur[cur.length - 1];
            if (last !== undefined && /^[0-9]+$/.test(last))
                cur.pop();
            i++; // consume the target token as well
        }
        else {
            cur.push(t);
        }
    }
    if (cur.length > 0)
        segments.push(cur);
    return segments;
}
/**
 * Builds a `canUseTool` callback for the Claude Agent SDK. The callback
 * receives the tool name and its raw input, and returns an `{ allow, reason }`
 * decision. Currently intercepts:
 *   - `Bash` -> guardCommand()
 *   - `Write` / `Edit` / `MultiEdit` -> path denylist (write side)
 *   - `Read` / `NotebookRead` -> path denylist (read side, to stop workers
 *     exfiltrating .env, credential vaults, or private keys through the
 *     SDK's built-in file readers, which bypass Bash entirely).
 *   - `Glob` / `Grep` -> path/pattern denylist (prevents `Glob '**\/.env'`).
 * Everything else is allowed (SDK enforces its own permission model for those).
 *
 * The path denylist is enforced *identically* for read and write paths.
 * If you want a read-allowed / write-denied file, put it in a location
 * not covered by the denylist.
 */
export function buildBashGuard(cfg) {
    const guard = {
        whitelist: cfg.bash_whitelist,
        denylistTokens: cfg.bash_denylist_tokens,
        allowGitPush: cfg.allow_git_push,
        allowNetworkCommands: cfg.allow_network_commands,
    };
    const pathBlocked = (p) => {
        for (const pat of cfg.path_denylist) {
            if (pat.endsWith("/") && p.includes(pat))
                return true;
            if (pat.includes("*")) {
                const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
                if (re.test(p))
                    return true;
            }
            else if (p === pat || p.endsWith("/" + pat)) {
                return true;
            }
        }
        return false;
    };
    const extractPath = (input, keys) => {
        const rec = input;
        if (!rec)
            return "";
        for (const k of keys) {
            const v = rec[k];
            if (typeof v === "string" && v.length > 0)
                return v;
        }
        return "";
    };
    return async (toolName, toolInput) => {
        if (toolName === "Bash") {
            const cmd = toolInput?.command ?? "";
            const r = guardCommand(cmd, guard);
            return { allow: r.allowed, reason: r.reason };
        }
        // Write side
        if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit" || toolName === "NotebookEdit") {
            const filePath = extractPath(toolInput, ["file_path", "path", "notebook_path"]);
            if (pathBlocked(filePath)) {
                return { allow: false, reason: `write path '${filePath}' is denylisted` };
            }
            return { allow: true };
        }
        // Read side. The SDK exposes Read + NotebookRead which bypass Bash. We
        // apply the same path_denylist to keep .env / vaults / private keys out
        // of a worker's reach even without Bash access.
        if (toolName === "Read" || toolName === "NotebookRead") {
            const filePath = extractPath(toolInput, ["file_path", "path", "notebook_path"]);
            if (pathBlocked(filePath)) {
                return { allow: false, reason: `read path '${filePath}' is denylisted` };
            }
            return { allow: true };
        }
        // Glob / Grep pattern side. A worker could do `Glob '**\/.env'` to
        // enumerate secrets. Check the pattern against the denylist too. If the
        // pattern is glob-y, expand a few common forms to catch obvious attempts.
        if (toolName === "Glob" || toolName === "Grep") {
            const pat = extractPath(toolInput, ["pattern", "glob", "path", "file_pattern"]);
            if (pat && pathBlocked(pat)) {
                return { allow: false, reason: `search pattern '${pat}' hits denylist` };
            }
            return { allow: true };
        }
        return { allow: true };
    };
}
export function guardCommand(cmd, cfg = defaultGuardConfig()) {
    const t = tokenise(cmd);
    if (t.error)
        return { allowed: false, reason: t.error };
    // Redirects to /dev/tcp or /dev/udp are network exfiltration channels
    for (const tok of t.tokens) {
        if (tok.startsWith("/dev/tcp") || tok.startsWith("/dev/udp")) {
            return { allowed: false, reason: `network redirection target ${tok}` };
        }
    }
    const segments = splitSegments(t.tokens);
    if (segments.length === 0)
        return { allowed: false, reason: "empty command" };
    for (const seg of segments) {
        const base = seg[0];
        if (!base)
            return { allowed: false, reason: "empty segment" };
        // Strip env-var assignments (KEY=value) that some shells allow before a command
        let cmdIdx = 0;
        while (cmdIdx < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[cmdIdx])) {
            cmdIdx++;
        }
        const effectiveBase = seg[cmdIdx];
        if (!effectiveBase)
            return { allowed: false, reason: "no effective command in segment" };
        if (!cfg.whitelist.includes(effectiveBase)) {
            return { allowed: false, reason: `command "${effectiveBase}" not in whitelist` };
        }
        // Hard token denylist: any argument matching a denylisted token is rejected,
        // regardless of position. Word-boundary aware because tokens are already split.
        for (const tok of seg) {
            if (cfg.denylistTokens.includes(tok)) {
                return { allowed: false, reason: `denylisted token "${tok}"` };
            }
        }
        // Explicit git push block
        if (!cfg.allowGitPush && effectiveBase === "git" && seg.slice(cmdIdx + 1).some((x) => x === "push")) {
            return { allowed: false, reason: "git push is not permitted for workers" };
        }
        if (!cfg.allowNetworkCommands && NETWORK_COMMANDS.includes(effectiveBase)) {
            return { allowed: false, reason: `network command "${effectiveBase}" is not permitted` };
        }
    }
    return { allowed: true };
}
//# sourceMappingURL=bash-guard.js.map