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
 * Every tool OpenCode is known to expose.
 *
 * The list exists so that each one can be named in `permission` explicitly. The
 * wildcard below is the actual safety net — it covers tools added by a version
 * we have never seen — but a wildcard on its own leaves a question the docs do
 * not settle: whether a tool with its own permissive default beats `"*"` on
 * precedence. Naming them removes the question. If the two ever disagree, the
 * explicit entry is the one that says "ask".
 */
export const OPENCODE_TOOLS = [
  "bash",
  "edit",
  "write",
  "read",
  "patch",
  "grep",
  "glob",
  "list",
  "webfetch",
  "task",
  "todowrite",
  "todoread",
] as const;

export interface OpenCodeConfigInput {
  /**
   * Provider blocks, e.g. an OpenAI-compatible endpoint with a baseURL and a
   * key resolved from the vault. M7 fills this in; M6 only makes sure it
   * travels in the same document.
   */
  provider?: Record<string, unknown>;
  /** `provider/model`, when the harness is choosing rather than the backend. */
  model?: string;
  /**
   * Roles that must run with NO tools at all — the six structured ones. Their
   * permission block is irrelevant because the tools are not present, but see
   * `buildOpenCodeConfig`: both are set anyway.
   */
  toolless?: boolean;
}

/**
 * Build the configuration document.
 *
 * Returns an object; `serialiseOpenCodeConfig` produces the string that goes
 * into the environment. Kept separate so a test can assert on the structure
 * rather than on JSON formatting.
 */
export function buildOpenCodeConfig(input: OpenCodeConfigInput = {}): Record<string, unknown> {
  const permission: Record<string, string> = {
    // The catch-all, and the thing that actually protects against a tool this
    // list has not heard of yet.
    "*": "ask",
  };
  for (const tool of OPENCODE_TOOLS) permission[tool] = "ask";

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permission,
  };

  if (input.toolless) {
    // Belt and braces for the six structured roles. `tools: {..false}` is the
    // mechanism; the deny-all guard in `runStructuredAcp` is the layer that
    // does not depend on the backend honouring its own configuration. Both are
    // here because `preflightAcpBackend` exists precisely because a backend
    // ignoring its permission config is a thing that has been observed.
    const tools: Record<string, boolean> = {};
    for (const tool of OPENCODE_TOOLS) tools[tool] = false;
    config.tools = tools;
  }

  if (input.provider && Object.keys(input.provider).length > 0) config.provider = input.provider;
  if (input.model) config.model = input.model;

  return config;
}

export function serialiseOpenCodeConfig(input: OpenCodeConfigInput = {}): string {
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
export function openCodeConfigEnv(input: OpenCodeConfigInput = {}): Record<string, string> {
  return { OPENCODE_CONFIG_CONTENT: serialiseOpenCodeConfig(input) };
}
