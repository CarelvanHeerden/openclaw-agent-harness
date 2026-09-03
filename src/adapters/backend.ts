/**
 * What the harness asks of a model backend.
 *
 * v1 had one backend and no interface: eight `run*Sdk` functions in one file,
 * each shaped by whatever the Claude Agent SDK happened to hand back. v2 has to
 * run the same eight roles over OpenCode's ACP as well, and the risk in that is
 * not the plumbing — it is that a second backend quietly supports LESS than the
 * first, in ways the harness only discovers mid-run.
 *
 * So capabilities are DECLARED here rather than discovered at the call site. A
 * backend states what it can do; a role states its floor; the mismatch is
 * refused at startup with a sentence naming both. The alternative — find out
 * when the tool-permission callback never fires — is the one failure mode this
 * file exists to prevent, because that particular gap is silent and it is the
 * containment boundary.
 */

// ---------------------------------------------------------------------------
// Roles and shapes
// ---------------------------------------------------------------------------

/**
 * The eight roles the harness runs. Names match the config keys operators set
 * per role in M7, so a floor violation can be reported against something the
 * operator can actually edit.
 */
export type RoleName =
  | "worker"
  | "scout"
  | "lead"
  | "adversary"
  | "classifier"
  | "crystalliser"
  | "revise_spec"
  | "worker_context";

export const ROLE_NAMES: readonly RoleName[] = [
  "worker", "scout", "lead", "adversary", "classifier", "crystalliser", "revise_spec", "worker_context",
] as const;

/**
 * Two shapes, and only two.
 *
 * `agentic` — the role is handed tools and a worktree and takes as many turns
 * as it needs. Every tool call passes a permission callback first. Two roles:
 * the worker (writes code) and the scout (reads the repo).
 *
 * `structured` — one prompt in, one JSON document out, no tools at all. The
 * other six. Tools are not merely unused here, they are actively disabled:
 * beta.28 and beta.40 both traced a "no JSON in output" failure to a
 * structured role being given tools and drifting into an assistant persona
 * that narrates a plan instead of emitting the contract.
 */
export type RoleShape = "agentic" | "structured";

export const ROLE_SHAPES: Readonly<Record<RoleName, RoleShape>> = {
  worker: "agentic",
  scout: "agentic",
  lead: "structured",
  adversary: "structured",
  classifier: "structured",
  crystalliser: "structured",
  revise_spec: "structured",
  worker_context: "structured",
};

// ---------------------------------------------------------------------------
// Capability tiers
// ---------------------------------------------------------------------------

/**
 * How capable the operator DECLARES a model to be.
 *
 * This is an assertion, not a measurement — the harness cannot benchmark a
 * model it has never seen, and a local endpoint will happily serve a 7B model
 * under any name the operator likes. What it can do is refuse to run the roles
 * where a weak model fails SILENTLY rather than loudly.
 *
 * That distinction is the whole point. A weak worker fails visibly: the code
 * does not compile, verification goes red, the cycle repeats. A weak
 * ADVERSARY fails invisibly — it returns `{"verdict":"pass","findings":[]}`,
 * which is well-formed, cheap, and indistinguishable from a careful review
 * that found nothing. The same is true of a lead that emits a plausible but
 * shallow plan, and a crystalliser that produces a brief missing the
 * constraint the whole request turned on.
 *
 * So the floor guards the three judgement roles, and the operator carries the
 * declaration.
 */
export type CapabilityTier = "frontier" | "strong" | "basic";

const TIER_RANK: Readonly<Record<CapabilityTier, number>> = { basic: 0, strong: 1, frontier: 2 };

export function tierAtLeast(actual: CapabilityTier, floor: CapabilityTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[floor];
}

/**
 * The minimum declared tier per role.
 *
 * `basic` for the five roles whose failures are self-announcing — the worker
 * and scout are checked by verification, and classifier / revise_spec /
 * worker_context produce small documents whose validation catches a bad one.
 * `strong` for lead, adversary and crystalliser, per the reasoning above.
 *
 * Deliberately not `frontier` for any role: that would make the harness
 * unusable on exactly the local models v2 exists to support, and "frontier" is
 * a marketing tier, not a measurable one. `strong` says: the operator has
 * looked at this model and believes it can hold a judgement task. If they are
 * wrong, the A/B matrix in M9 is what tells them.
 */
export const ROLE_MIN_TIER: Readonly<Record<RoleName, CapabilityTier>> = {
  worker: "basic",
  scout: "basic",
  classifier: "basic",
  revise_spec: "basic",
  worker_context: "basic",
  lead: "strong",
  adversary: "strong",
  crystalliser: "strong",
};

// ---------------------------------------------------------------------------
// Backend capabilities
// ---------------------------------------------------------------------------

export interface BackendCapabilities {
  /** Stable id used in config, audit events and error messages. */
  id: string;

  /** Can run the `agentic` shape at all: tools, multiple turns, a worktree. */
  toolUse: boolean;

  /**
   * Every tool call is offered to the harness for approval BEFORE it runs, and
   * a denial actually prevents it.
   *
   * This is the containment boundary, so it is the one capability that must
   * never be assumed. Over the SDK it is `canUseTool`; over ACP it is the
   * `session/request_permission` round-trip. A backend that cannot do this
   * cannot run a worker, because bash-guard, the path deny-list and the
   * no-push rule are all enforced through it — without it they are three
   * functions nobody calls.
   *
   * M6 verifies this with a LIVE probe rather than trusting the declaration,
   * because the failure is silent: a backend that never asks for permission
   * looks exactly like a backend whose every request was approved.
   */
  toolPermissionCallback: boolean;

  /**
   * Can run a turn with ALL tools disabled, for the six structured roles. See
   * `RoleShape` — leaving tools on is not a performance question, it changes
   * what the model emits.
   */
  disableAllTools: boolean;

  /** Can resume a prior session by id, for the worker's revise cycles. */
  resumeSession: boolean;

  /**
   * Reports a real monetary cost per call.
   *
   * False for local and self-hosted providers, where there is no invoice to
   * report. Those report tokens only, and the budget enforcer has to say so
   * rather than record `$0.00` and let a run look free — that was the b125
   * failure in a different guise.
   */
  reportsCostUsd: boolean;
}

/**
 * Why a (role, backend) pairing is refused, or null when it is fine.
 *
 * Returns a sentence rather than a boolean because this is read by an operator
 * at startup, and "capability floor not met" without both sides named is not
 * something anyone can act on.
 */
export function checkCapabilityFloor(
  role: RoleName,
  caps: BackendCapabilities,
  declaredTier: CapabilityTier,
): string | null {
  const shape = ROLE_SHAPES[role];

  if (shape === "agentic") {
    if (!caps.toolUse) {
      return `role '${role}' needs tool use and backend '${caps.id}' does not support it`;
    }
    if (!caps.toolPermissionCallback) {
      return `role '${role}' runs untrusted model output against a real filesystem, and backend '${caps.id}' ` +
        `cannot gate tool calls; bash-guard, the path deny-list and the no-push rule are all enforced through ` +
        `that callback, so without it they do not run at all`;
    }
  }

  if (shape === "structured" && !caps.disableAllTools) {
    return `role '${role}' must run with tools disabled and backend '${caps.id}' cannot disable them; ` +
      `a structured role with tools available drifts into narrating instead of emitting its JSON contract ` +
      `(beta.28, beta.40)`;
  }

  const floor = ROLE_MIN_TIER[role];
  if (!tierAtLeast(declaredTier, floor)) {
    return `role '${role}' requires a model declared at least '${floor}' and this one is declared ` +
      `'${declaredTier}'; a weak model in this role fails quietly rather than loudly, which is why the ` +
      `floor exists`;
  }

  return null;
}

/**
 * The sub-task sizing instruction handed to the lead planner.
 *
 * v1 hard-coded "ATOMIC sub-tasks a Sonnet worker can complete in one turn".
 * That sentence was doing real work — it calibrates how finely to decompose —
 * but it calibrates against a brand, and in v2 the worker might be Kimi K3 or
 * a local model. Naming a competitor's model to a competitor's model is at
 * best confusing and at worst actively misleading about the size to aim for.
 *
 * So the calibration is now expressed as the worker's DECLARED tier, which is
 * the thing the sentence was really about all along.
 */
export function subTaskSizingInstruction(workerTier: CapabilityTier): string {
  switch (workerTier) {
    case "frontier":
      return "Decompose a brief into ATOMIC sub-tasks. The worker is a highly capable model: a sub-task may " +
        "span several related files, but must still be completable in a single turn and verifiable on its own.";
    case "strong":
      return "Decompose a brief into ATOMIC sub-tasks a capable coding model can complete in one turn. " +
        "Each sub-task should touch a small, related set of files and be verifiable on its own.";
    case "basic":
      return "Decompose a brief into SMALL, ATOMIC sub-tasks. The worker is a modest model, so prefer more " +
        "sub-tasks over larger ones: each should touch as few files as possible, carry explicit instructions, " +
        "and be verifiable on its own.";
  }
}
