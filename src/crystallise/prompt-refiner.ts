/**
 * Prompt crystallisation.
 *
 * Rough user request in Slack -> structured, well-scoped brief that a lead
 * agent can plan against. Two-step:
 *
 *   1. Classifier (Haiku) decides intent:
 *      - "dev_task"     : real dev work, proceed to crystallisation.
 *      - "not_dev"      : chat / non-dev request, decline politely.
 *      - "unsafe"       : mentions secrets, deletion, etc.; refuse.
 *
 *   2. If dev_task: the crystalliser produces a strict-schema brief:
 *      { title, motivation, acceptanceCriteria[], filesLikelyTouched[],
 *        outOfScope[], repoHint, riskLevel }.
 *
 * The brief is stored on `sessions.crystallised_prompt` before the confirmed
 * control-plane run starts. Exact authenticated confirmation is handled by
 * OpenClaw before execution begins.
 */

import type { HarnessConfig } from "../config.js";
import {
  type ClarificationGrounding,
  type VerifiedContinuation,
} from "./clarification-guard.js";
import { resolveRepoAlias } from "./repo-alias.js";

export type ClassifierIntent = "dev_task" | "not_dev" | "unsafe";

export interface ClassifierResult {
  intent: ClassifierIntent;
  reason: string;
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
   * the OpenClaw agent invokes `harness_prepare_change` with concepts already surfaced
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
   * Free-text direction from the human who requested a revise, describing what
   * the fix must DO. Set by `a new confirmed change`'s `guidance` parameter.
   *
   * The instruction itself lives in `acceptanceCriteria`, which is what reaches
   * the lead, the workers and the adversary; this field is the structured copy,
   * so the PR review comment can render it as its own section without pattern-
   * matching the criteria array. See src/tools/revise-guidance.ts.
   */
  operatorGuidance?: string;
  /**
   * beta.101: set by a trusted host confirmation when re-driving a session out of
   * `awaiting_clarification`. The resume path re-plans, which allocates a fresh
   * worktree; without this marker allocation resets the session branch to base
   * and orphans every commit the run has already made (b100 smoke, session
   * 3c6c1608: six commits lost). Threaded to GitContext.preserveLocalBranch so
   * the new worktree checks the branch out at its own tip instead.
   */
  resumeFromClarification?: boolean;
  /**
   * beta.135: an `accept` answer to a contract-path clarification resumes the
   * plan already stored on the session instead of asking the lead to invent a
   * replacement plan.
   *
   * The accepted commit is already on the branch and the human settled only
   * whether its contract path was wrong. Re-planning the whole feature can
   * discard every still-pending sub-task; the policy-Drive smoke turned an
   * original five-step plan into one read-only observe step and then opened a
   * persistence-only PR. This marker is durable so crash recovery makes the
   * same continuation decision.
   */
  resumeExistingPlan?: boolean;
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
  /**
   * beta.104: the lead scout's report on the actual repository, produced in a
   * read-only worktree turn BEFORE planning.
   *
   * Not written by the crystalliser -- `runLeadPlanner` sets it. It lives on
   * the brief because the brief is what the lead planning call and the bounded
   * workerContext top-up call both receive, so both get the repo facts with no
   * further plumbing.
   *
   * The ADVERSARY must never see this. It does not: the reviewer's prompt is
   * built in index.ts from a hand-written projection (title, motivation,
   * acceptance criteria), never from the brief object. If that ever becomes a
   * `JSON.stringify(brief)`, reviewer independence goes with it.
   */
  repoScoutReport?: string;
}

export interface RepoConvention {
  /** Source label, e.g. ".cursor/rules/keep-okf-current.mdc", "CONTRIBUTING.md", or "package.json#scripts". */
  source: string;
  /** The convention text (possibly truncated per the char budget). */
  text: string;
  /** True when this source's text was truncated to fit the budget. */
  truncated?: boolean;
}

/**
 * What a role call spent.
 *
 * Every field is optional because a backend may know the token split without a
 * dollar figure — that is the normal case for a local provider, where tokens
 * are a real measurement and cost genuinely does not apply. `costUsd:
 * undefined` therefore means "not billable or not known", which is the
 * distinction the old hardcoded `costUsd: 0` erased.
 */
export interface RoleCost {
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
}

/** Sum of what a crystallise pass spent, across the classifier and the brief. */
export interface SpendTotals {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /**
   * True when at least one call reported tokens but no cost, so `costUsd` is a
   * floor rather than the total. Without this flag a local-model run and a
   * free run are the same number.
   */
  partial: boolean;
}

function addSpend(into: SpendTotals, from: Partial<RoleCost> | undefined): void {
  if (!from) return;
  if (typeof from.tokensIn === "number") into.tokensIn += from.tokensIn;
  if (typeof from.tokensOut === "number") into.tokensOut += from.tokensOut;
  if (typeof from.costUsd === "number") into.costUsd += from.costUsd;
  else if (typeof from.tokensIn === "number" || typeof from.tokensOut === "number") into.partial = true;
}

export interface CrystalliserDeps {
  config: HarnessConfig;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
  callClassifier: (userText: string) => Promise<ClassifierResult & Partial<RoleCost>>;
  /**
   * beta.21: the crystalliser callable now receives optional pre-known
   * concept references so the SDK-side prompt can enrich the brief with
   * concept-aware `filesLikelyTouched` / `outOfScope` guidance. Callers
   * that don't have OKF context pass
   * `undefined` and behaviour is identical to pre-beta.21.
   */
  callCrystalliser: (userText: string, classifier: ClassifierResult, concepts?: OkfConceptRef[]) => Promise<CrystallisedBrief & Partial<RoleCost>>;
  /**
   * rc.2: durable record of every clarification decision, including the ones
   * withheld. A suppressed question leaves no other trace -- the run simply
   * proceeds -- and "why did it not ask me?" needs an answer as much as "why
   * did it ask me that?" does.
   */
  audit?: (event: string, payload: Record<string, unknown>) => void;
  /**
   * rc.2: continuation state the caller has ALREADY verified against the
   * filesystem. Omitted for a new run, which is the overwhelming majority and
   * the case that produced the invented-worktree question.
   */
  continuation?: VerifiedContinuation;
}

/**
 * rc.2: assemble the facts a clarification is allowed to rest on.
 *
 * Everything here comes from operator config or from state the caller checked.
 * Nothing is inferred from model output, per the brief's rule that a
 * model-generated claim is not evidence of repository or worktree state.
 */
export function groundingFrom(
  config: HarnessConfig | undefined,
  continuation?: VerifiedContinuation,
): ClarificationGrounding {
  const repos = (config?.repos ?? {}) as Partial<HarnessConfig["repos"]>;
  return {
    allowedRepos: Array.isArray(repos.allowed) ? repos.allowed : [],
    defaultBaseBranch: repos.default_base_branch,
    continuation,
  };
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
  | { kind: "brief"; brief: CrystallisedBrief; classification: ClassifierResult; spend: SpendTotals }
  | { kind: "reject"; reason: string; intent: ClassifierIntent; spend: SpendTotals }
> {
  // v2.0.0-beta.1: every exit carries what it spent. Early rejections still
  // ran a classifier call, so the measured spend must be retained.
  // Reporting zero for them made rejected requests look free. A
  // channel that rejects a hundred prompts a day was invisible in the ledger.
  const spend: SpendTotals = { costUsd: 0, tokensIn: 0, tokensOut: 0, partial: false };

  const grounding = groundingFrom(deps.config, deps.continuation);
  const audit = (event: string, payload: Record<string, unknown>): void => {
    try {
      deps.audit?.(event, payload);
    } catch {
      /* an audit write must never fail crystallisation */
    }
  };

  const cls = await deps.callClassifier(userText);
  addSpend(spend, cls);
  deps.logger.info("[crystalliser] classifier", cls);

  // Older classifier implementations may still emit the retired `clarify`
  // intent. Treat any such dev-shaped ambiguity as a development request and
  // let the crystalliser choose the bounded conservative interpretation. The
  // harness never turns that model suggestion into a user-facing pause.
  const rawIntent = String((cls as { intent?: unknown }).intent ?? "");
  const effectiveCls: ClassifierResult = rawIntent === "clarify"
    ? { intent: "dev_task", reason: `${cls.reason} (resolved internally using conservative defaults)` }
    : cls;
  if (rawIntent === "clarify") {
    deps.logger.info("[crystalliser] classifier ambiguity resolved internally", { reason: cls.reason });
    audit("crystallise.ambiguity_resolved", { role: "classifier", strategy: "conservative_default" });
  }
  if (effectiveCls.intent === "not_dev" || effectiveCls.intent === "unsafe") {
    return { kind: "reject", reason: effectiveCls.reason, intent: effectiveCls.intent, spend };
  }
  if (effectiveCls.intent !== "dev_task") {
    deps.logger.warn("[crystalliser] unknown classifier intent rejected", { intent: rawIntent });
    audit("crystallise.unsafe_model_output", { role: "classifier", reason: "unknown_intent", intent: rawIntent });
    return {
      kind: "reject",
      reason: "The request classifier returned an unrecognized intent, so the request was refused safely.",
      intent: "unsafe",
      spend,
    };
  }

  let brief: CrystallisedBrief & Partial<RoleCost>;
  try {
    brief = await deps.callCrystalliser(userText, effectiveCls, concepts);
  } catch (error) {
    deps.logger.warn("[crystalliser] malformed crystalliser output rejected", { error: String(error) });
    audit("crystallise.unsafe_model_output", { role: "crystalliser", reason: "call_or_parse_failure" });
    return {
      kind: "reject",
      reason: "The request could not be converted into a safe, bounded repository change.",
      intent: "unsafe",
      spend,
    };
  }
  addSpend(spend, brief);
  // beta.21: guarantee concepts land on the brief even if the SDK-side
  // crystalliser silently drops the field (e.g. pre-beta.21 model version).
  // The caller's concept list is authoritative when the SDK produces none.
  if (concepts && concepts.length > 0 && (!brief.relevantConcepts || brief.relevantConcepts.length === 0)) {
    brief.relevantConcepts = concepts;
  }

  // Repository identity is deterministic. The explicit repository supplied to
  // the control plane remains authoritative; for legacy bare-name collisions,
  // select the lexicographically first allowed candidate rather than exposing
  // a harness pause. This recommendation is stable across retries and hosts.
  const repoResolution = resolveRepoAlias(brief.repoHint, grounding.allowedRepos);
  if (repoResolution.kind === "ambiguous") {
    const selected = [...repoResolution.candidates].sort((a, b) => a.localeCompare(b))[0]!;
    brief.repoHint = selected;
    deps.logger.info("[crystalliser] ambiguous repo alias resolved conservatively", {
      hint: repoResolution.hint,
      selected,
      candidates: repoResolution.candidates.length,
    });
    audit("crystallise.ambiguity_resolved", {
      role: "harness",
      strategy: "lexicographic_allowed_repository",
      hint: repoResolution.hint,
      selected,
    });
  } else if (repoResolution.kind === "resolved" && repoResolution.via === "alias") {
    deps.logger.info("[crystalliser] repo alias resolved", { hint: brief.repoHint, repo: repoResolution.repo });
    audit("crystallise.repo_alias_resolved", { hint: brief.repoHint, repo: repoResolution.repo });
    brief.repoHint = repoResolution.repo;
  }

  // Tolerate one release of stale model output from the retired bimodal schema.
  // Select the first model-ranked buildable reading, explicitly bound it to a
  // repository change with tests, and discard the pause-only fields before the
  // brief is persisted or shown for confirmation.
  if (!resolveRetiredAmbiguityFields(brief, audit)) {
    return {
      kind: "reject",
      reason: "The request could not be converted into a safe, bounded repository change.",
      intent: "unsafe",
      spend,
    };
  }

  try {
    validateBrief(brief);
  } catch (error) {
    deps.logger.warn("[crystalliser] invalid brief rejected", { error: String(error) });
    audit("crystallise.unsafe_model_output", { role: "crystalliser", reason: "invalid_brief" });
    return {
      kind: "reject",
      reason: "The request could not be converted into a safe, bounded repository change.",
      intent: "unsafe",
      spend,
    };
  }
  return { kind: "brief", brief, classification: effectiveCls, spend };
}

function resolveRetiredAmbiguityFields(brief: CrystallisedBrief, audit: (event: string, payload: Record<string, unknown>) => void): boolean {
  const legacy = brief as CrystallisedBrief & {
    interpretations?: Array<{ reading?: unknown; whatDiffers?: unknown }>;
    clarificationNeeded?: { question?: unknown; options?: unknown };
  };
  const interpretations = Array.isArray(legacy.interpretations) ? legacy.interpretations : [];
  const candidates = [
    ...interpretations.map((item) => typeof item?.reading === "string" ? item.reading.trim() : ""),
    ...(Array.isArray(legacy.clarificationNeeded?.options)
      ? legacy.clarificationNeeded.options.filter((value): value is string => typeof value === "string").map((value) => value.trim())
      : []),
  ].filter(Boolean);
  const liveSideEffect = /\b(?:live|production|prod|deploy|publish|release|send|email|message|delete|remove|migrate|migration|backfill|rotate|revoke|merge|push|api\s+call|external\s+(?:system|service))\b/i;
  const boundedRepositoryWork = /\b(?:build|implement|add|change|fix|refactor|document|runbook|test|repository|code|feature)\b/i;
  const selected = candidates.find((candidate) => boundedRepositoryWork.test(candidate) && !liveSideEffect.test(candidate));
  if (candidates.length > 0 && !selected) {
    audit("crystallise.unsafe_model_output", { role: "crystalliser", reason: "only_live_side_effect_interpretations" });
    delete legacy.interpretations;
    delete legacy.clarificationNeeded;
    return false;
  }
  if (selected) {
    const note = `Conservative interpretation selected: ${selected}.`;
    if (!brief.motivation.includes(note)) brief.motivation = `${brief.motivation.trim()} ${note}`;
    if (!brief.acceptanceCriteria.some((criterion) => /repository change.*test/i.test(criterion))) {
      brief.acceptanceCriteria.push("Implement the selected interpretation as a bounded repository change with deterministic tests; do not perform live external side effects.");
    }
    audit("crystallise.ambiguity_resolved", { role: "crystalliser", strategy: "first_ranked_bounded_reading" });
  }
  delete legacy.interpretations;
  delete legacy.clarificationNeeded;
  return true;
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
