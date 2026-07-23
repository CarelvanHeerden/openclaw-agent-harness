/**
 * Prompt crystallisation.
 *
 * Rough user request in Slack -> structured, well-scoped brief that a lead
 * agent can plan against. Two-step:
 *
 *   1. Classifier (Haiku) decides intent:
 *      - "dev_task"     : real dev work, proceed to crystallisation.
 *      - "clarify"      : ambiguous, ask the user a question.
 *      - "not_dev"      : chat / non-dev request, decline politely.
 *      - "unsafe"       : mentions secrets, deletion, etc.; refuse.
 *
 *   2. If dev_task: Fable-5 crystalliser produces a strict-schema brief:
 *      { title, motivation, acceptanceCriteria[], filesLikelyTouched[],
 *        outOfScope[], repoHint, riskLevel }.
 *
 * The brief is stored on `sessions.crystallised_prompt` before the loop
 * starts. Users see it as a Slack thread reply and can react with a
 * confirming emoji before execution begins.
 */

import type { HarnessConfig } from "../config.js";

export type ClassifierIntent = "dev_task" | "clarify" | "not_dev" | "unsafe";

export interface ClassifierResult {
  intent: ClassifierIntent;
  reason: string;
  suggestedClarification?: string;
}

/**
 * A single OKF concept referenced by the requester or auto-attached by the
 * OpenClaw context enrichment layer.
 *
 * Beta.21: this is the harness's *pass-through* record of what the caller
 * (usually the OpenClaw agent) knew was relevant. The harness itself does
 * NOT crawl OKF bundles or read concept files from disk — it trusts the
 * caller to supply concept metadata and, optionally, the concept text. The
 * lead planner uses concept references to bias `filesLikelyTouched` +
 * `outOfScope`; the worker prompt includes the concept text so it starts
 * primed instead of exploring the tree blind.
 */
export interface OkfConceptRef {
  /** Concept id from the OKF bundle (e.g. `services/retry`, `infrastructure/n8n`). */
  id: string;
  /** Optional relative path in the target repo where the concept file lives. Callers may omit this if the concept is source-of-truth outside the repo. */
  path?: string;
  /** Human-facing one-line description of the concept. */
  summary?: string;
  /** Optional bag of tags surfaced by OKF (e.g. ["infrastructure", "monitoring"]). Used by the lead as heuristic `outOfScope` hints when a tag does not match the request domain. */
  tags?: string[];
  /** Optional concept file body (markdown). When present, injected into the worker's system prompt so it starts primed. Bounded by `services/context-injection` guards downstream. */
  content?: string;
}

export interface CrystallisedBrief {
  title: string;
  motivation: string;
  acceptanceCriteria: string[];
  filesLikelyTouched: string[];
  outOfScope: string[];
  repoHint?: string;
  branchHint?: string;
  riskLevel: "low" | "medium" | "high";
  /**
   * beta.21: OKF concept references carried through from the caller. When
   * the OpenClaw agent invokes `harness_run` with concepts already surfaced
   * by the OKF plugin's context enrichment, they land here and propagate
   * to the lead planner + workers. Optional — pre-beta.21 briefs simply
   * omit the field.
   */
  relevantConcepts?: OkfConceptRef[];
  /**
   * beta.44: revise flow. reviseOfSessionId links this to the shipped session
   * being revised; pinnedBranch is used VERBATIM as the branch (not slugified)
   * so revise commits stack on the existing PR head and update the same PR.
   */
  reviseOfSessionId?: string;
  pinnedBranch?: string;
  /**
   * beta.63 (convention-awareness Fix 1): the checked-out repo's declared
   * convention files (.cursor/rules/**, .cursorrules, CONTRIBUTING.md,
   * CONVENTIONS.md, AGENTS.md, .github/CONTRIBUTING.md) + repo check scripts,
   * ingested at brief build. The lead + worker + adversary SDK prompts get NO
   * OpenClaw context injection, so conventions MUST be carried explicitly here
   * to reach them. Char-budgeted (brief.convention_char_budget); over budget the
   * LONGEST sources are truncated first with an appended note. Optional; empty/
   * absent when the repo declares none or ingest is disabled.
   */
  repoConventions?: RepoConvention[];
}

export interface RepoConvention {
  /** Source label, e.g. ".cursor/rules/keep-okf-current.mdc", "CONTRIBUTING.md", or "package.json#scripts". */
  source: string;
  /** The convention text (possibly truncated per the char budget). */
  text: string;
  /** True when this source's text was truncated to fit the budget. */
  truncated?: boolean;
}

export interface CrystalliserDeps {
  config: HarnessConfig;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
  callClassifier: (userText: string) => Promise<ClassifierResult>;
  /**
   * beta.21: the crystalliser callable now receives optional pre-known
   * concept references so the SDK-side prompt can enrich the brief with
   * concept-aware `filesLikelyTouched` / `outOfScope` guidance. Callers
   * that don't have OKF context (e.g. the legacy Slack listener path) pass
   * `undefined` and behaviour is identical to pre-beta.21.
   */
  callCrystalliser: (userText: string, classifier: ClassifierResult, concepts?: OkfConceptRef[]) => Promise<CrystallisedBrief>;
}

/**
 * The pure orchestration -- takes injected callables so unit tests never
 * hit the network.
 */
export async function crystallisePrompt(
  userText: string,
  deps: CrystalliserDeps,
  /** beta.21: OKF concepts pre-attached by the caller (typically the OpenClaw agent's context enrichment). Pass-through only — crystalliser does not crawl OKF itself. */
  concepts?: OkfConceptRef[],
): Promise<
  | { kind: "brief"; brief: CrystallisedBrief; classification: ClassifierResult }
  | { kind: "clarify"; question: string }
  | { kind: "reject"; reason: string; intent: ClassifierIntent }
> {
  const cls = await deps.callClassifier(userText);
  deps.logger.info("[crystalliser] classifier", cls);

  if (cls.intent === "clarify") {
    return {
      kind: "clarify",
      question: cls.suggestedClarification ?? "Could you say a bit more about what you'd like me to do?",
    };
  }
  if (cls.intent === "not_dev" || cls.intent === "unsafe") {
    return { kind: "reject", reason: cls.reason, intent: cls.intent };
  }

  const brief = await deps.callCrystalliser(userText, cls, concepts);
  // beta.21: guarantee concepts land on the brief even if the SDK-side
  // crystalliser silently drops the field (e.g. pre-beta.21 model version).
  // The caller's concept list is authoritative when the SDK produces none.
  if (concepts && concepts.length > 0 && (!brief.relevantConcepts || brief.relevantConcepts.length === 0)) {
    brief.relevantConcepts = concepts;
  }
  validateBrief(brief);
  return { kind: "brief", brief, classification: cls };
}

function validateBrief(brief: CrystallisedBrief): void {
  if (!brief.title || brief.title.length < 3) throw new Error("brief.title too short");
  if (!brief.motivation || brief.motivation.length < 10) {
    throw new Error("brief.motivation too short");
  }
  if (!Array.isArray(brief.acceptanceCriteria) || brief.acceptanceCriteria.length === 0) {
    throw new Error("brief.acceptanceCriteria must be non-empty");
  }
  if (!["low", "medium", "high"].includes(brief.riskLevel)) {
    throw new Error(`brief.riskLevel invalid: ${brief.riskLevel}`);
  }
}
