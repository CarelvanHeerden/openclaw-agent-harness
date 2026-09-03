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
export interface GuardConfig {
    whitelist: string[];
    denylistTokens: string[];
    allowGitPush: boolean;
    allowNetworkCommands: boolean;
    /**
     * beta.57 (P2): optional path denylist (same patterns as safety.path_denylist).
     * When set, redirect targets and path-looking arguments to read/print
     * commands (cat/head/tail/grep/sed/awk/...) are checked against it, so a
     * worker cannot `cat .env` or `sed -n p ~/.ssh/id_rsa` its way past the
     * SDK Read-tool denylist.
     */
    pathDenylist?: string[];
}
export interface GuardResult {
    allowed: boolean;
    reason?: string;
}
export declare function defaultGuardConfig(): GuardConfig;
/**
 * Simple POSIX-ish tokeniser. Handles single/double quotes and escapes but
 * treats subshells and command substitution as a hard reject signal.
 */
export declare function tokenise(cmd: string): {
    tokens: string[];
    error?: string;
};
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
export declare function buildBashGuard(cfg: {
    bash_whitelist: string[];
    bash_denylist_tokens: string[];
    path_denylist: string[];
    allow_git_push: boolean;
    allow_network_commands: boolean;
}): (toolName: string, toolInput: unknown) => Promise<{
    allow: boolean;
    reason?: string;
}>;
/**
 * ACP tool-call shape, reduced to the fields the guard needs. Mirrors the
 * spec's `ToolCall`/`ToolCallUpdate` as delivered on a `session/request_permission`.
 * Every field except the kind discriminator is OPTIONAL in the spec, which is
 * exactly why this guard fails closed.
 */
export interface AcpToolCallForGuard {
    kind?: string | null;
    rawInput?: unknown;
    locations?: ReadonlyArray<{
        path?: string | null;
    } | null> | null;
    title?: string | null;
}
/**
 * Pulls the shell command out of an ACP `execute` tool call.
 *
 * Measured shapes (see docs/acp-capability-matrix.md):
 *   OpenCode -> { command, cwd }
 *   Codex    -> { command, cwd, parsed_cmd, call_id, ... }
 * Returns null when no command string is present, which the caller MUST treat
 * as a denial rather than a pass.
 */
export declare function acpCommandFromToolCall(call: AcpToolCallForGuard): string | null;
/**
 * Collects every filesystem path an ACP tool call would touch.
 *
 * Sources, all of which occur in practice:
 *   - `locations[].path` (protocol-normalised; OpenCode and Codex both populate it)
 *   - `rawInput.filepath` (OpenCode) / `file_path` (Claude Code SDK) / `path`
 *   - `rawInput.changes` KEYS (Codex edits carry no path field at all -- the
 *     affected paths are the keys of the changes object)
 */
export declare function acpPathsFromToolCall(call: AcpToolCallForGuard): string[];
/**
 * Builds a permission handler for an ACP backend, to be wired to
 * `session/request_permission`.
 *
 * Why this exists as a separate entry point from `buildBashGuard`: that guard
 * keys on Claude Code's tool NAMES (`Bash`, `Write`, `Read`, ...) and ends in
 * `return { allow: true }`. Point it at any other backend and every call falls
 * through to allowed, silently voiding the whitelist and both denylists while
 * still reading as enabled in config. ACP instead gives us a protocol-normalised
 * `ToolKind`, which is a sounder thing to key on than a vendor's tool names.
 *
 * FAIL-CLOSED, and deliberately so. `kind`, `rawInput` and `locations` are all
 * optional in the ACP spec, so "we could not determine what this call does" is
 * a denial, not a pass. The probe showed `rawInput` arriving EMPTY on the
 * initial `status: "pending"` update and only being filled in at
 * `status: "in_progress"` -- i.e. once the tool is already running -- so a
 * guard that shrugged at missing input would be trivially bypassable.
 *
 * NOTE: this only protects calls the backend actually asks about. An agent
 * configured not to request permission never reaches this code at all. See
 * `docs/acp-capability-matrix.md`; enforcing that config is a separate,
 * mandatory preflight.
 */
export declare function buildAcpGuard(cfg: {
    bash_whitelist: string[];
    bash_denylist_tokens: string[];
    path_denylist: string[];
    allow_git_push: boolean;
    allow_network_commands: boolean;
}): (call: AcpToolCallForGuard) => Promise<{
    allow: boolean;
    reason?: string;
    unenforced?: boolean;
}>;
/**
 * beta.57 (P2): shared path-denylist matcher (same semantics as the SDK
 * Read/Write guard in buildBashGuard).
 */
export declare function pathMatchesDenylist(p: string, patterns: readonly string[]): boolean;
export declare function guardCommand(cmd: string, cfg?: GuardConfig): GuardResult;
//# sourceMappingURL=bash-guard.d.ts.map