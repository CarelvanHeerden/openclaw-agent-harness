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
/**
 * rc.9: WHY a call was denied, in a form something other than a human can read.
 *
 * The StitchGuard incident had the whole reason -- rule, path, tool -- at the
 * moment of denial, recorded it in one audit row, and then threw the structure
 * away. Twenty seconds later the retry classifier logged `reason: ""` and the
 * clarification shown to the operator quoted the model's planning prose. A
 * string is not enough: every consumer between the guard and the human needs to
 * be able to ask "was this a policy denial?" without parsing English.
 */
export interface GuardDenial {
    /** Stable machine code. Classification keys on this, never on the message. */
    code: "path_denylisted" | "path_unresolvable" | "target_metadata_conflict" | "no_path_exposed" | "secret_material" | "command_denied" | "network_denied" | "unknown_kind";
    /** The policy rule that fired, e.g. the denylist pattern `.env.*`. */
    rule?: string;
    /** Normalised paths the decision was about. Safe to show: paths, not contents. */
    paths?: string[];
    /** The ACP tool kind, e.g. `edit`. */
    kind?: string;
    /** One operator-facing sentence, including what to do about it. */
    message: string;
    /** Typed, bounded recovery. Present only when the guard knows a safe route. */
    recovery?: {
        code: "one_target_per_call";
        retryable: true;
        instruction: string;
    };
}
export interface AcpGuardVerdict {
    allow: boolean;
    /** Back-compatible prose. Kept so existing callers and logs are unchanged. */
    reason?: string;
    /** Present on every denial rc.9 owns. Absent means "allowed". */
    denial?: GuardDenial;
    /** beta.x: the denylist could not be applied to this call at all. */
    unenforced?: boolean;
    /** Canonical paths actually checked, for audit. */
    checkedPaths?: string[];
    /** Sanitized target-source reconciliation; never contains patch contents. */
    targetEvidence?: AcpTargetEvidence;
}
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
export interface AcpTargetEvidence {
    /** Paths the recognized tool schema says the operation will really touch. */
    authoritativePaths: string[];
    /** Human-display metadata, retained for reconciliation/audit only. */
    advisoryPaths: string[];
    schema: "apply_patch/v1" | "codex_changes/v1" | "single_path/v1" | "locations/v1" | "unknown";
    complete: boolean;
    conflict?: string;
    /** True only when a joined display string exactly renders authoritative targets. */
    joinedDisplaySummary?: boolean;
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
 * Reconcile execution-authoritative targets with display metadata.
 *
 * Field names alone confer no authority. Patch and changes payloads must match
 * a recognized, complete schema; otherwise the call fails closed.
 */
export declare function acpTargetEvidenceFromToolCall(call: AcpToolCallForGuard): AcpTargetEvidence;
/** The `apply_patch` body, when this call has one. Needed for the content check. */
export declare function acpPatchTextFromToolCall(call: AcpToolCallForGuard): string | null;
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
    /**
     * rc.9: exact repo-relative paths the denylist covers but this deployment has
     * explicitly authorised, e.g. `.env.example`. Opt-in, no globs, and still
     * subject to the secret-content check. See `docs/SECURITY.md`.
     */
    path_denylist_exceptions?: string[];
    /** Absolute worktree root, so an absolute path can be judged repo-relative. */
    repoRoot?: string;
    /** Symlink resolver. Absent in the pure guard; wired in production. */
    realpath?: (p: string) => string;
}): (call: AcpToolCallForGuard) => Promise<AcpGuardVerdict>;
/**
 * beta.57 (P2): shared path-denylist matcher (same semantics as the SDK
 * Read/Write guard in buildBashGuard).
 */
export declare function pathMatchesDenylist(p: string, patterns: readonly string[]): boolean;
/**
 * Which denylist pattern blocks this path, or null. Same predicate as
 * {@link pathMatchesDenylist}, but it NAMES the rule -- rc.9 needs that, because
 * an operator told only "denylisted" cannot decide anything, and the
 * StitchGuard clarification's whole failure was telling a human less than the
 * harness knew.
 */
export declare function denylistRuleFor(p: string, patterns: readonly string[]): string | null;
export declare function guardCommand(cmd: string, cfg?: GuardConfig): GuardResult;
//# sourceMappingURL=bash-guard.d.ts.map