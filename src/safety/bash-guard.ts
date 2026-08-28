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
  whitelist: string[];             // base commands allowed (e.g. "git", "pnpm")
  denylistTokens: string[];        // hard-blocked substrings (e.g. "sudo", "rm")
  allowGitPush: boolean;           // default: false
  allowNetworkCommands: boolean;   // default: false (blocks curl/wget/nc/ssh)
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
  // beta.57 (P2): shells as ARGUMENT tokens. The whitelist already excludes
  // them as base commands, but `xargs sh -c ...`, `find . -exec bash ...` and
  // `env sh ...` smuggled a fresh unguarded shell through whitelisted hosts.
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
];

export function defaultGuardConfig(): GuardConfig {
  return {
    // beta.32: keep in sync with config.ts safety.bash_whitelist default.
    // Production uses the config value; this is the standalone fallback.
    // Excludes copy/move/link mutators (writes go through SDK Write/Edit
    // which enforce path_denylist). `mkdir` is allowed: OpenCode cannot create
    // parent directories through the edit tool.
    whitelist: [
      "git", "pnpm", "npm", "npx", "yarn", "node", "tsc", "tsx", "deno", "bun",
      "python", "python3", "pip", "pip3", "pytest", "go", "cargo", "make", "just",
      "ls", "cat", "grep", "rg", "head", "tail", "wc", "jq", "yq", "sed", "awk",
      "find", "which", "echo", "printf", "test", "true", "false", "pwd",
      "diff", "sort", "uniq", "cut", "tr", "env", "date", "basename", "dirname",
      "realpath", "xargs", "comm", "mkdir",
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
export function tokenise(cmd: string): { tokens: string[]; error?: string } {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let i = 0;

  const push = () => {
    if (cur.length > 0) tokens.push(cur);
    cur = "";
  };

  while (i < cmd.length) {
    const ch = cmd[i]!;

    // beta.57 (P2): command substitution is rejected INSIDE double quotes too.
    // The shell expands $(...) and backticks within double quotes, so
    // `echo "$(curl evil)"` was a working bypass of the substitution reject
    // (only unquoted substitution was caught before). Single quotes do not
    // expand, so they remain allowed.
    if ((quote === null || quote === '"') && (ch === "`" || (ch === "$" && cmd[i + 1] === "("))) {
      return { tokens, error: "command substitution not allowed" };
    }

    if (quote === null && ch === "\\") {
      cur += cmd[i + 1] ?? "";
      i += 2;
      continue;
    }

    if (quote === null && (ch === '"' || ch === "'")) {
      quote = ch as '"' | "'";
      i++;
      continue;
    }

    if (quote !== null && ch === quote) {
      quote = null;
      i++;
      continue;
    }

    // beta.57 (P2): a NEWLINE is a command separator, not plain whitespace.
    // `git status\ncurl evil.com` previously tokenised as one segment whose
    // base was `git` -- the second command was never whitelist-checked.
    if (quote === null && ch === "\n") {
      push();
      tokens.push(";");
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
      } else {
        i++;
      }
      tokens.push(op);
      continue;
    }

    cur += ch;
    i++;
  }

  if (quote !== null) return { tokens, error: "unterminated quote" };
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
function splitSegments(tokens: string[]): { segments: string[][]; redirectTargets: string[] } {
  const segments: string[][] = [];
  const redirectTargets: string[] = [];
  let cur: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (SEGMENT_SEPARATORS.has(t)) {
      if (cur.length > 0) segments.push(cur);
      cur = [];
    } else if (REDIRECT_OPERATORS.has(t)) {
      // Skip the redirect operator AND its target token (the filename that
      // follows). e.g. `> /dev/null`, `2>> log.txt`, `< input`.
      // Also drop a trailing bare file-descriptor prefix already pushed onto
      // cur (the `2` in `foo 2>/dev/null`) so it isn't left as a stray arg.
      const last = cur[cur.length - 1];
      if (last !== undefined && /^[0-9]+$/.test(last)) cur.pop();
      // beta.57 (P2): the target is no longer just dropped -- it is collected
      // so guardCommand can check it against the path denylist (`echo x >
      // .env` was invisible before).
      const target = tokens[i + 1];
      if (target !== undefined && !SEGMENT_SEPARATORS.has(target) && !REDIRECT_OPERATORS.has(target)) {
        redirectTargets.push(target);
      }
      i++; // consume the target token as well
    } else {
      cur.push(t);
    }
  }
  if (cur.length > 0) segments.push(cur);
  return { segments, redirectTargets };
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
export function buildBashGuard(cfg: {
  bash_whitelist: string[];
  bash_denylist_tokens: string[];
  path_denylist: string[];
  allow_git_push: boolean;
  allow_network_commands: boolean;
}): (toolName: string, toolInput: unknown) => Promise<{ allow: boolean; reason?: string }> {
  const guard: GuardConfig = {
    whitelist: cfg.bash_whitelist,
    denylistTokens: cfg.bash_denylist_tokens,
    allowGitPush: cfg.allow_git_push,
    allowNetworkCommands: cfg.allow_network_commands,
    // beta.57 (P2): Bash redirect targets + file-reading command args are now
    // checked against the same path denylist as the SDK Read/Write tools.
    pathDenylist: cfg.path_denylist,
  };
  const pathBlocked = (p: string): boolean => pathMatchesDenylist(p, cfg.path_denylist);

  const extractPath = (input: unknown, keys: readonly string[]): string => {
    const rec = input as Record<string, unknown> | null | undefined;
    if (!rec) return "";
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return "";
  };

  return async (toolName: string, toolInput: unknown) => {
    if (toolName === "Bash") {
      const cmd = (toolInput as { command?: string })?.command ?? "";
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

/**
 * ACP tool-call shape, reduced to the fields the guard needs. Mirrors the
 * spec's `ToolCall`/`ToolCallUpdate` as delivered on a `session/request_permission`.
 * Every field except the kind discriminator is OPTIONAL in the spec, which is
 * exactly why this guard fails closed.
 */
export interface AcpToolCallForGuard {
  kind?: string | null;
  rawInput?: unknown;
  locations?: ReadonlyArray<{ path?: string | null } | null> | null;
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
export function acpCommandFromToolCall(call: AcpToolCallForGuard): string | null {
  const raw = call.rawInput as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object") return null;
  const cmd = raw["command"];
  return typeof cmd === "string" && cmd.trim().length > 0 ? cmd : null;
}

/**
 * Collects every filesystem path an ACP tool call would touch.
 *
 * Sources, all of which occur in practice:
 *   - `locations[].path` (protocol-normalised; OpenCode and Codex both populate it)
 *   - `rawInput.filepath` (OpenCode) / `file_path` (Claude Code SDK) / `path`
 *   - `rawInput.changes` KEYS (Codex edits carry no path field at all -- the
 *     affected paths are the keys of the changes object)
 */
export function acpPathsFromToolCall(call: AcpToolCallForGuard): string[] {
  const out = new Set<string>();
  for (const loc of call.locations ?? []) {
    const p = loc?.path;
    if (typeof p === "string" && p.length > 0) out.add(p);
  }
  const raw = call.rawInput as Record<string, unknown> | null | undefined;
  if (raw && typeof raw === "object") {
    for (const k of ["filepath", "file_path", "path", "notebook_path", "abs_path"]) {
      const v = raw[k];
      if (typeof v === "string" && v.length > 0) out.add(v);
    }
    const changes = raw["changes"];
    if (changes && typeof changes === "object" && !Array.isArray(changes)) {
      for (const k of Object.keys(changes as Record<string, unknown>)) {
        if (k.length > 0) out.add(k);
      }
    }
  }
  return [...out];
}

/** Search-style calls expose a pattern rather than a path. */
function acpPatternFromToolCall(call: AcpToolCallForGuard): string | null {
  const raw = call.rawInput as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object") return null;
  for (const k of ["pattern", "glob", "query", "regex", "file_pattern"]) {
    const v = raw[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

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
export function buildAcpGuard(cfg: {
  bash_whitelist: string[];
  bash_denylist_tokens: string[];
  path_denylist: string[];
  allow_git_push: boolean;
  allow_network_commands: boolean;
}): (call: AcpToolCallForGuard) => Promise<{ allow: boolean; reason?: string; unenforced?: boolean }> {
  const guard: GuardConfig = {
    whitelist: cfg.bash_whitelist,
    denylistTokens: cfg.bash_denylist_tokens,
    allowGitPush: cfg.allow_git_push,
    allowNetworkCommands: cfg.allow_network_commands,
    pathDenylist: cfg.path_denylist,
  };

  const denyIfBlockedPaths = (
    call: AcpToolCallForGuard,
    label: string,
  ): { allow: boolean; reason?: string } => {
    const paths = acpPathsFromToolCall(call);
    if (paths.length === 0) {
      return { allow: false, reason: `${label} tool call exposed no path to check (failing closed)` };
    }
    for (const p of paths) {
      if (pathMatchesDenylist(p, cfg.path_denylist)) {
        return { allow: false, reason: `${label} path '${p}' is denylisted` };
      }
    }
    return { allow: true };
  };

  return async (call: AcpToolCallForGuard) => {
    const kind = typeof call.kind === "string" ? call.kind.toLowerCase() : "";

    switch (kind) {
      case "execute": {
        const cmd = acpCommandFromToolCall(call);
        if (cmd === null) {
          return { allow: false, reason: "execute tool call carried no command string (failing closed)" };
        }
        const r = guardCommand(cmd, guard);
        return { allow: r.allowed, reason: r.reason };
      }

      case "edit":
      case "delete":
      case "move":
        return denyIfBlockedPaths(call, kind);

      // READ IS THE ONE KIND THAT DEGRADES TO ALLOW, AND ONLY WHEN THE AGENT
      // TELLS US NOTHING. Measured on opencode-ai@1.18.23, a read permission
      // request is `{kind:"read", title:"read", locations:[], rawInput:{}}` --
      // no path in any field, so there is nothing for the denylist to match.
      //
      // Failing closed here is the safe answer and it makes the backend
      // useless: a worker that cannot read a file cannot change one, and it
      // presents as a model that narrates its intent and then stops. That was
      // found by a real StitchGuard run, not by review, because the small smoke
      // that preceded it only CREATED a file and so never read anything.
      //
      // The trade is stated in SECURITY.md and is deliberately narrow. When a
      // path IS supplied -- Codex supplies one, and a future OpenCode may --
      // the denylist enforces exactly as before. `unenforced` is how the caller
      // learns this happened, because a control that has silently stopped
      // applying is worse than one that was never claimed.
      case "read": {
        const paths = acpPathsFromToolCall(call);
        if (paths.length === 0) {
          return {
            allow: true,
            unenforced: true,
            reason: "read tool call exposed no path; path_denylist cannot be applied to it on this backend",
          };
        }
        for (const p of paths) {
          if (pathMatchesDenylist(p, cfg.path_denylist)) {
            return { allow: false, reason: `read path '${p}' is denylisted` };
          }
        }
        return { allow: true };
      }

      case "search": {
        const pat = acpPatternFromToolCall(call);
        if (pat === null) {
          // A search we cannot inspect could enumerate secrets (`**/.env`).
          return { allow: false, reason: "search tool call exposed no pattern to check (failing closed)" };
        }
        if (pathMatchesDenylist(pat, cfg.path_denylist)) {
          return { allow: false, reason: `search pattern '${pat}' hits denylist` };
        }
        return { allow: true };
      }

      case "fetch":
        if (!cfg.allow_network_commands) {
          return { allow: false, reason: "network fetch is not permitted (allow_network_commands=false)" };
        }
        return { allow: true };

      // Pure reasoning, no side effect to guard.
      case "think":
        return { allow: true };

      default:
        return {
          allow: false,
          reason: kind
            ? `unrecognised ACP tool kind '${kind}' (failing closed)`
            : "ACP tool call carried no kind (failing closed)",
        };
    }
  };
}

/**
 * beta.57 (P2): shared path-denylist matcher (same semantics as the SDK
 * Read/Write guard in buildBashGuard).
 */
export function pathMatchesDenylist(p: string, patterns: readonly string[]): boolean {
  for (const pat of patterns) {
    if (pat.endsWith("/") && p.includes(pat)) return true;
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      if (re.test(p)) return true;
    } else if (p === pat || p.endsWith("/" + pat)) {
      return true;
    }
  }
  return false;
}

// beta.57 (P2): commands that print/transform file contents. Their
// path-looking args are checked against the path denylist so `cat .env`
// cannot bypass the SDK Read guard.
const FILE_READING_COMMANDS = new Set(["cat", "head", "tail", "grep", "rg", "sed", "awk", "cut", "sort", "uniq", "wc", "diff", "comm", "tr"]);

// beta.57 (P2): interpreters that accept inline code via a flag. Inline code
// is a fully unguarded escape hatch (`node -e "require('fs')..."`), so those
// flags are rejected; running a script FILE (`node scripts/x.js`) stays fine.
const INTERPRETER_INLINE_FLAGS: Record<string, string[]> = {
  node: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  bun: ["-e", "--eval", "-p", "--print"],
  python: ["-c"],
  python3: ["-c"],
};

/**
 * beta.57 (P2): commands that EXECUTE another command given as an argument
 * (`xargs CMD`, `env [VAR=x...] CMD`, `find ... -exec CMD`). The nested
 * command is located and re-checked against the same whitelist/denylist as a
 * base command, closing the `xargs curl ...` / `env curl ...` hole.
 */
function nestedCommandOf(seg: string[], cmdIdx: number): string | undefined {
  const base = seg[cmdIdx]!;
  const rest = seg.slice(cmdIdx + 1);
  if (base === "xargs") {
    // Skip flags (and their glued values like -I{} / -n1); first bare word is the command.
    for (const a of rest) {
      if (a.startsWith("-")) continue;
      return a;
    }
    return undefined;
  }
  if (base === "env") {
    for (const a of rest) {
      if (a.startsWith("-")) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
      return a;
    }
    return undefined;
  }
  if (base === "find") {
    const i = rest.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir");
    if (i >= 0) return rest[i + 1];
    return undefined;
  }
  return undefined;
}

export function guardCommand(cmd: string, cfg: GuardConfig = defaultGuardConfig()): GuardResult {
  const t = tokenise(cmd);
  if (t.error) return { allowed: false, reason: t.error };

  // Redirects to /dev/tcp or /dev/udp are network exfiltration channels
  for (const tok of t.tokens) {
    if (tok.startsWith("/dev/tcp") || tok.startsWith("/dev/udp")) {
      return { allowed: false, reason: `network redirection target ${tok}` };
    }
  }

  const { segments, redirectTargets } = splitSegments(t.tokens);
  if (segments.length === 0) return { allowed: false, reason: "empty command" };

  // beta.57 (P2): redirect targets are checked against the path denylist.
  const pathDeny = cfg.pathDenylist ?? [];
  if (pathDeny.length > 0) {
    for (const target of redirectTargets) {
      if (pathMatchesDenylist(target, pathDeny)) {
        return { allowed: false, reason: `redirect target '${target}' is denylisted` };
      }
    }
  }

  for (const seg of segments) {
    const base = seg[0];
    if (!base) return { allowed: false, reason: "empty segment" };

    // Strip env-var assignments (KEY=value) that some shells allow before a command
    let cmdIdx = 0;
    while (cmdIdx < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[cmdIdx]!)) {
      cmdIdx++;
    }
    const effectiveBase = seg[cmdIdx];
    if (!effectiveBase) return { allowed: false, reason: "no effective command in segment" };

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

    // beta.57 (P2): inline-code interpreter flags are an unguarded escape hatch.
    const inlineFlags = INTERPRETER_INLINE_FLAGS[effectiveBase];
    if (inlineFlags) {
      const hit = seg.slice(cmdIdx + 1).find((a) => inlineFlags.includes(a));
      if (hit) {
        return { allowed: false, reason: `inline code via "${effectiveBase} ${hit}" is not permitted (write a script file instead)` };
      }
    }

    // beta.57 (P2): nested-command hosts (xargs/env/find -exec) re-check the
    // command they would execute against the same rules as a base command.
    const nested = nestedCommandOf(seg, cmdIdx);
    if (nested !== undefined) {
      if (!cfg.whitelist.includes(nested)) {
        return { allowed: false, reason: `nested command "${nested}" (via ${effectiveBase}) not in whitelist` };
      }
      if (!cfg.allowNetworkCommands && NETWORK_COMMANDS.includes(nested)) {
        return { allowed: false, reason: `nested network command "${nested}" (via ${effectiveBase}) is not permitted` };
      }
    }

    // beta.57 (P2): path-denylist check on args of file-reading commands, so
    // Bash cannot read what the SDK Read guard refuses.
    if (pathDeny.length > 0 && FILE_READING_COMMANDS.has(effectiveBase)) {
      for (const a of seg.slice(cmdIdx + 1)) {
        if (a.startsWith("-")) continue;
        if (pathMatchesDenylist(a, pathDeny)) {
          return { allowed: false, reason: `argument path '${a}' is denylisted` };
        }
      }
    }
  }

  return { allowed: true };
}
