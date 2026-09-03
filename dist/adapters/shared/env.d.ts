/**
 * The filtered environment handed to any agent subprocess.
 *
 * v2.0.0: lifted out of the Claude SDK adapter, where it was `buildSdkEnv`, and
 * made backend-neutral. The reasoning is beta.57's and is unchanged: an agent
 * child that inherits the full harness environment can read every secret the
 * harness holds, and `echo $GH_TOKEN` inside a worker is not something the bash
 * guard can stop. The worker needs none of them — git credentials are injected
 * per-invocation by the harness's own git operations, never by the child.
 *
 * It moved because v2 spawns a SECOND kind of child. The ACP backend runs
 * `opencode` as a subprocess, and the version of that code on the ACP branch
 * spawns it with `{ ...process.env }` — handing OpenCode the vault key, the
 * GitHub PAT and the Slack tokens that this filter exists to withhold. One
 * filter, used by both backends, is the fix: a new backend inherits the
 * protection instead of having to remember it.
 */
/**
 * beta.110: allow bootstrap to deny an operator-renamed secret env var (e.g. a
 * custom `credentials.key_env`). The denylist is static by design -- this is the
 * one seam that widens it, and it only ever ADDS.
 */
export declare function registerDeniedEnvVar(name: string): void;
/** Is this variable withheld from agent subprocesses? Exported for tests. */
export declare function isDeniedEnvVar(name: string): boolean;
/**
 * Build a child environment: the parent's, minus everything denied, plus
 * exactly what the caller names.
 *
 * `extra` is applied AFTER the filter and is the only way a secret reaches the
 * child. That ordering is the whole design. A backend needs to pass something
 * sensitive — `ANTHROPIC_API_KEY` for the SDK, `OPENCODE_CONFIG_CONTENT` for
 * ACP once it carries provider keys — and the choice to do so has to be
 * explicit and greppable at the call site, rather than a variable that happens
 * to survive a regex. Nothing is ever allow-listed by pattern.
 */
export declare function buildAgentEnv(extra?: Record<string, string | undefined>): Record<string, string>;
//# sourceMappingURL=env.d.ts.map