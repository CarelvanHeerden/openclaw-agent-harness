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
export declare function guardCommand(cmd: string, cfg?: GuardConfig): GuardResult;
//# sourceMappingURL=bash-guard.d.ts.map