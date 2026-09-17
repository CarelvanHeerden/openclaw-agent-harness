/**
 * What actually happened when a worker ended its turn with nothing committed.
 *
 * rc.2, observed failure (session 40f71a12-a3e5-4874-8e16-4f1cc8a0f037, sub-task
 * "Add tenant-scoped SAST persistence"). A Kimi/OpenCode worker tried to inspect
 * an XLSX with an inline Python command. The bash guard denied it correctly and
 * said what to do instead -- write a script file. The worker then ended its turn
 * with pure narration:
 *
 *   "Now let me check the workbook headers quickly, the tenant extension
 *    mechanism, and package.json prisma scripts."
 *
 * No files, no commit. The harness classified that sentence as a REFUSAL and
 * asked the operator "How should it proceed?" -- a question with no answer,
 * because the recovery was already written in the denial the worker had just
 * received.
 *
 * The classifier it went through was:
 *
 *   const looksLikeRefusal = NO_CHANGE_ONLY && !result.commitSha && text.length > 0;
 *
 * That is not refusal detection. It is "the worker said something and did not
 * commit", which is equally true of a refusal, a half-finished thought, and a
 * worker that got its command syntax wrong. Meanwhile `WorkerResult` already
 * carried `deniedToolCalls` -- the structured record of exactly which command
 * was denied and why -- and nothing consulted it.
 *
 * This module separates the outcomes that need a human from the ones the
 * harness can fix by itself. The rule behind every judgement here: a human is
 * worth interrupting only for something a human can decide. A command-format
 * mistake, a guard denial, or an unfinished sentence is not that.
 */

import { HARNESS_SCRATCH_DIR } from "../adapters/git-worktree.js";
import type { AcpTargetEvidence, GuardDenial } from "../safety/bash-guard.js";

/** One denial, as the ACP adapter records it. */
export interface DeniedToolCall {
  kind?: string | null;
  title?: string;
  reason?: string;
  /**
   * rc.9: the guard's structured verdict, when the guard produced one.
   *
   * Everything below used to be inferred by matching English against `reason`.
   * That is why StitchGuard's denylist denial classified as `incomplete`: no
   * entry in RECOVERIES matched "is denylisted", so the strongest fact about
   * the turn -- a policy said no -- was simply not in evidence by the time the
   * outcome was decided.
   */
  denial?: GuardDenial;
  /** Sanitized source/authority reconciliation; never patch contents. */
  targetEvidence?: AcpTargetEvidence;
}

export type WorkerOutcomeKind =
  /** A guard denial whose reason names a permitted alternative. Retry it. */
  | "recoverable_tool_denial"
  /**
   * rc.9: a policy said no, and saying it again will not change the answer.
   * Ask -- but ask the RIGHT question, quoting the rule rather than the
   * worker's prose.
   */
  | "policy_denial"
  /** The turn ended describing what it was about to do. Retry it. */
  | "progress_only"
  /** Something only a human can settle. Ask. */
  | "genuine_blocker"
  /** The worker declined the work on its merits. Ask. */
  | "refusal"
  /** Nothing happened and the worker said nothing useful about why. Retry it. */
  | "incomplete";

/**
 * rc.9: which structured denial codes are DETERMINISTIC -- the same call, made
 * again, gets the same answer.
 *
 * The distinction is the whole point of the bucket. StitchGuard burned a second
 * billed worker turn re-submitting a patch that touched `.env.example`, was
 * denied identically, and then reported the conflict as a "refusal". A denial
 * that cannot change is not a thing to retry; it is a thing to ask about.
 *
 * `secret_material` is deliberately ABSENT: the worker can fix that one itself
 * by writing a placeholder instead of a credential, so it stays retryable.
 * `path_unresolvable` and `no_path_exposed` are absent too -- they describe a
 * malformed request, and a differently-shaped retry may well succeed.
 */
const DETERMINISTIC_DENIAL_CODES = new Set(["path_denylisted", "network_denied"]);

/** The structured policy denial a human has to settle, if this turn had one. */
export interface PolicyDenialOutcome {
  code: string;
  rule?: string;
  paths: string[];
  tool?: string;
  message: string;
  /** How many times this exact denial was recorded across the sub-task. */
  attempts: number;
}

export interface RecoveryGuidance {
  /** Coarse bucket for metrics: `inline_code`, `heredoc`, `git_push`, `guided`. */
  category: string;
  /** The guard's own words, verbatim. The retry prompt quotes these. */
  reason: string;
  /** The command that was denied, when the backend reported one. */
  title?: string;
  /** The permitted route to the same result, in the imperative. */
  remedy: string;
  /** rc.11: stable guard-owned recovery code when available. */
  code?: string;
}

export interface WorkerOutcome {
  kind: WorkerOutcomeKind;
  /** Present only for `recoverable_tool_denial`. */
  recoverable?: RecoveryGuidance;
  /** rc.9: present only for `policy_denial`. The thing to tell the human. */
  policy?: PolicyDenialOutcome;
  /**
   * The worker's message with progress narration removed. `undefined` when
   * nothing substantive was left -- which is precisely when there is nothing to
   * show a human, and the old code showed them the narration anyway.
   */
  explanation?: string;
  /** Which of the human-decidable categories fired. Metrics only. */
  blockerKind?: string;
}

/**
 * Denials that name their own remedy.
 *
 * Matched against the guard's real reason strings (`src/safety/bash-guard.ts`),
 * not invented ones. A denial absent from this table is NOT treated as
 * recoverable: "command X not in whitelist" tells the worker what it may not do
 * and nothing about what it may, so pretending we know the alternative would be
 * the same guessing this module exists to stop.
 */
const RECOVERIES: Array<{ category: string; match: RegExp; remedy: string }> = [
  {
    category: "inline_code",
    match: /inline code via|write a script file instead/i,
    remedy:
      `Write the code to a file under \`${HARNESS_SCRATCH_DIR}/\` with the file-writing tool and run that file with a normal interpreter invocation. ` +
      "Leave it there when you are done -- that directory is excluded from git and the harness deletes it for you. Do not try to `rm` it; deletion is denied, and you do not need it.",
  },
  {
    category: "git_push",
    match: /git push is not permitted/i,
    remedy:
      "Do not push. Commit your work to the current branch and stop there -- the harness pushes the branch and opens the pull request for you.",
  },
];

/** A heredoc is recognised from the command text; the guard has no rule named for it. */
const HEREDOC_RE = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Sentences that announce an action instead of reporting one.
 *
 * Deliberately anchored on the announcing construction rather than on keywords
 * like "check", so "I checked the headers and they are wrong" survives while
 * "Now let me check the headers" does not.
 */
const PROGRESS_RE: RegExp[] = [
  /^(?:ok(?:ay)?|right|good|great|perfect)?[,\s]*(?:now|next|then|first(?:ly)?|second(?:ly)?|finally|also)?[,\s]*let(?:'s| us| me)\b/i,
  /^(?:ok(?:ay)?|right)?[,\s]*(?:now|next|then|first(?:ly)?|finally)?[,\s]*i(?:'m| am) (?:now )?going to\s+(?!not\b)/i,
  /^(?:ok(?:ay)?|right)?[,\s]*(?:now|next|then|first(?:ly)?|finally)[,\s]+i(?:'ll| will)\s+(?!not\b)/i,
  /^i(?:'ll| will)\s+now\s+(?!not\b)/i,
  /*
   * rc.10 (audit 5578): the BARE "I'll ..." form.
   *
   * The two rules above require a leading adverb or an explicit "now", on the
   * reasoning that an unguarded "I will" would swallow "I will not do this" and
   * turn the clearest refusal a worker can write into an unfinished sentence.
   * The `(?!not\b)` lookahead already answers that, and the "I'm going to"
   * rule above has made the adverb optional the whole time -- so "I'm going to
   * inspect the contracts" was narration and "I'll inspect the contracts" was a
   * finding, which is a difference in grammar and not in meaning.
   *
   * The observe prerequisite of session aad3fc57 reported, in full: "I'll split
   * the read-only probe across repository conventions/specification, identity/
   * audit contracts, SDK capabilities, and test fixtures, then consolidate
   * exact paths, line ranges, excerpts, and blockers." It survived stripping,
   * was recorded as the sub-task's findings, and was handed to two dependent
   * workers under the heading "These are the VERBATIM reports".
   */
  /^i(?:'ll| will)\s+(?!not\b)/i,
  /^(?:now|next|then|first(?:ly)?|finally)\b[^.!?]*\bi(?:'ll| will|'m going to| am going to)\s+(?!not\b)/i,
  /^(?:time to|moving on to|proceeding to|continuing with|starting with)\b/i,
];

/** The worker declined the work itself, as opposed to fumbling a command. */
const REFUSAL_RE: RegExp[] = [
  /\bi\s+(?:will|would|shall)\s+not\s+(?:implement|complete|continue|proceed|perform|do|make)\b/i,
  /\bi\s+won't\s+(?:implement|complete|continue|proceed|perform|do|make)\b/i,
  /\bi\s+(?:will|would|shall)\s+not\b[^.!?]{0,120}\bthis\s+way\b/i,
  /\bi\s+refuse\b/i,
  /\brefus(?:e|es|ed|ing)\s+to\b/i,
  /\bi(?:'m| am)\s+not\s+(?:going\s+to|willing\s+to|able\s+to\s+justify)\b/i,
  /\bi\s+decline\b/i,
  /\bdeclin(?:e|ing)\s+to\s+(?:make|do|implement|proceed)/i,
  /\bthis\s+(?:would\s+)?violat(?:e|es)\b/i,
  /\bagainst\s+(?:policy|my\s+guidelines|the\s+guidelines)\b/i,
  /\bshould\s+not\s+be\s+(?:done|implemented|made)\b/i,
  // A reasoned skip on a contradicted premise. b58 already treats this as an
  // escalating outcome (it only splits the audit event), so it has to land in
  // the refusal bucket -- retrying a worker that has just argued the task is
  // built on a false finding would spend two more turns to hear it again.
  // Mirrors INVALID_PREMISE_RE in loop.ts.
  /\b(?:premise\s+(?:is\s+)?contradict|contradict\w*\s+(?:the\s+)?premise|premise\s+(?:is\s+)?(?:false|invalid|not\s+met|does\s+not\s+hold)|finding\s+(?:is\s+)?invalid|invalid\s*[:\-]?\s*premise|premise\s+not\s+satisfied|conditional\s+premise)/i,
];

/**
 * Things a human, and only a human, can supply.
 *
 * Each entry describes an EXTERNAL prerequisite or a decision between
 * alternatives. None of them can be satisfied by the worker trying again, which
 * is the test for belonging here.
 */
const BLOCKERS: Array<{ kind: string; match: RegExp }> = [
  {
    kind: "missing_credential",
    match:
      /\b(?:credential|api[\s-]?key|access[\s-]?token|auth[\s-]?token|secret|password|service[\s-]?account)\b[^.!?]*\b(?:missing|absent|not\s+(?:set|available|provided|configured|present)|required|need(?:ed)?|unavailable)\b|\b(?:missing|no|without)\b[^.!?]*\b(?:credential|api[\s-]?key|access[\s-]?token|secret)\b/i,
  },
  { kind: "needs_human_input", match: /\bi\s+need\s+(?:you|the\s+(?:user|operator|human)|someone)\s+to\b/i },
  { kind: "needs_human_input", match: /\bplease\s+(?:provide|confirm|clarify|decide|specify)\b/i },
  { kind: "needs_approval", match: /\brequires?\s+(?:your\s+|human\s+|explicit\s+|operator\s+)?approval\b/i },
  { kind: "destructive_confirmation", match: /\b(?:destructive|irreversible|data[\s-]loss)\b[^.!?]*\bconfirm/i },
  {
    kind: "incompatible_criteria",
    match:
      /\b(?:acceptance\s+criteria|requirements?)\b[^.!?]*\b(?:conflict|contradict|incompatible|mutually\s+exclusive)\b|\b(?:conflicting|contradictory|mutually\s+exclusive)\b[^.!?]*\b(?:acceptance\s+criteria|requirements?)\b/i,
  },
  {
    kind: "external_resource_unavailable",
    match: /\b(?:external|upstream|third[\s-]party|remote)\b[^.!?]*\b(?:unavailable|unreachable|down|not\s+accessible)\b/i,
  },
  { kind: "decision_requested", match: /\b(?:should\s+i|do\s+you\s+want|which\s+(?:one|of)|would\s+you\s+prefer)\b[^?]*\?/i },
];

/**
 * Break a message into the units worth judging separately.
 *
 * Sentence level, not line level. The observed failure was a single sentence on
 * a single line, and a message can just as easily pair one narrated intention
 * with one real finding -- stitching those together is how a "blocker
 * explanation" gets assembled out of fragments that never claimed to be one.
 */
export function splitFragments(text: string): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * rc.10: fold typographic punctuation onto its ASCII equivalent before matching.
 *
 * Every pattern in this module spells the apostrophe `'`, and models routinely
 * emit U+2019. The observe report of session aad3fc57 began "I’ll split the
 * read-only probe ..." with a right single quotation mark, so it matched none
 * of the `let's` / `I'll` / `I'm going to` rules -- not because the shape was
 * unknown but because of one character. Audit 5578 stored the result as
 * findings and two dependent workers planned against it.
 *
 * Normalising at the point of comparison only. Callers keep the original text,
 * so an explanation quoted back to an operator keeps the worker's own
 * typography.
 */
function normaliseTypography(text: string): string {
  return (text ?? "")
    .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-");
}

/** Is this fragment an announcement rather than a result? */
export function isProgressFragment(fragment: string): boolean {
  // Strip list bullets and numbering so "- Next, I'll check X" is seen.
  const t = normaliseTypography(fragment).replace(/^[-*+\u2022]\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
  if (!t) return true;
  // A trailing colon introduces something. On the last fragment of a message
  // nothing follows it, so it introduced nothing.
  if (/:$/.test(t)) return true;
  return PROGRESS_RE.some((re) => re.test(t));
}

/**
 * What is left once the announcements are removed.
 *
 * Empty means the worker reported no result at all -- and therefore that there
 * is nothing to quote at a human, however long the message was.
 */
export function stripProgressNarration(text: string): string {
  return splitFragments(text).filter((f) => !isProgressFragment(f)).join(" ").trim();
}

/** The first denial that names a way forward, if any. */
export function recoverableDenialFrom(denied: DeniedToolCall[] | undefined): RecoveryGuidance | undefined {
  for (const d of denied ?? []) {
    const reason = (d.reason ?? "").trim();
    const title = (d.title ?? "").trim();
    if (!reason && !title) continue;

    if (d.denial?.recovery?.retryable) {
      return {
        category: d.denial.recovery.code,
        code: d.denial.recovery.code,
        reason: reason || d.denial.message,
        title: title || undefined,
        remedy: d.denial.recovery.instruction,
      };
    }

    const known = RECOVERIES.find((r) => r.match.test(reason));
    if (known) return { category: known.category, reason, title: title || undefined, remedy: known.remedy };

    if (HEREDOC_RE.test(title) || /heredoc|here[\s-]document/i.test(reason)) {
      return {
        category: "heredoc",
        reason,
        title: title || undefined,
        remedy:
          `Do not feed a heredoc into an interpreter. Write the script to \`${HARNESS_SCRATCH_DIR}/\` with the file-writing tool and run it from there. ` +
          "Leave it behind -- that directory is excluded from git and the harness cleans it up.",
      };
    }

    // The guard said what to do instead, in words this table has not seen
    // before. Quoting it back is better than discarding a stated remedy.
    if (/\binstead\b/i.test(reason)) {
      return { category: "guided", reason, title: title || undefined, remedy: `Follow the denial's own instruction: ${reason}` };
    }
  }
  return undefined;
}

/**
 * rc.9: the deterministic policy denial in this turn, if there is one.
 *
 * Structured only. It deliberately does NOT fall back to reading `reason`,
 * because a guess about English is exactly what put the incident's operator in
 * front of the wrong question. A backend that supplies no structured verdict
 * keeps its pre-rc.9 behaviour rather than getting a fabricated one.
 *
 * Counts every denial sharing the same code+rule+paths, so the operator can be
 * told "this was refused twice" instead of being shown only the first attempt.
 */
export function policyDenialFrom(denied: DeniedToolCall[] | undefined): PolicyDenialOutcome | undefined {
  const structured = (denied ?? []).filter((d) => d.denial && DETERMINISTIC_DENIAL_CODES.has(d.denial.code));
  if (structured.length === 0) return undefined;

  const first = structured[0]!.denial!;
  const key = (g: GuardDenial) => `${g.code}|${g.rule ?? ""}|${(g.paths ?? []).join(",")}`;
  const firstKey = key(first);
  return {
    code: first.code,
    rule: first.rule,
    paths: [...(first.paths ?? [])],
    tool: first.kind,
    message: first.message,
    attempts: structured.filter((d) => key(d.denial!) === firstKey).length,
  };
}

/**
 * The Claude SDK backend does not populate `deniedToolCalls` -- it hands the
 * denial to the model as text and keeps no structured copy. When the worker
 * quotes that text back at us, it is still evidence of a recoverable denial,
 * and the alternative is treating an identical situation differently depending
 * on which backend ran it.
 */
function denialQuotedInMessage(text: string): RecoveryGuidance | undefined {
  for (const r of RECOVERIES) {
    const m = r.match.exec(text);
    if (!m) continue;
    const fragment = splitFragments(text).find((f) => r.match.test(f)) ?? m[0];
    return { category: r.category, reason: fragment.slice(0, 500), remedy: r.remedy };
  }
  return undefined;
}

/**
 * Decide what a zero-commit turn actually was.
 *
 * Precedence, strongest claim first:
 *
 *   1. An explicit refusal. The worker addressed the task and declined it; that
 *      is a position a human has to overrule, and it outranks any denial that
 *      happened along the way.
 *   2. A genuine blocker. Something external is missing.
 *   3. A recoverable denial. The guard already said what to do instead.
 *   4. Progress only. The turn ended mid-thought.
 *   5. Incomplete. Nothing happened and nothing was explained.
 *
 * Refusal and blocker are the only two that may reach a human.
 */
export function classifyWorkerOutcome(input: {
  finalMessage?: string;
  commitSha?: string;
  deniedToolCalls?: DeniedToolCall[];
  /** Active, amended task scope. Used only to interpret path-limited negation. */
  taskContext?: { filesLikelyTouched?: string[]; intent?: string };
}): WorkerOutcome {
  const text = (input.finalMessage ?? "").trim();
  const substantive = stripProgressNarration(text);
  const explanation = substantive.length > 0 ? substantive : undefined;
  // rc.10: match against the typography-normalised form for the same reason
  // isProgressFragment does -- "I won’t do this" is a refusal, and a right
  // single quotation mark must not be the difference. The text handed back in
  // `explanation` is the worker's own, unchanged.
  const matchable = normaliseTypography(substantive);

  const refusesRequiredPath = (input.taskContext?.filesLikelyTouched ?? []).some(
    (path) =>
      path.trim().length > 0 &&
      matchable.includes(path) &&
      /\bi\s+(?:will|would|shall)\s+not\s+(?:read|create|modify|edit|touch|write)\b/i.test(matchable),
  );
  if (substantive && (REFUSAL_RE.some((re) => re.test(matchable)) || refusesRequiredPath)) {
    return { kind: "refusal", explanation };
  }

  if (substantive) {
    const blocker = BLOCKERS.find((b) => b.match.test(matchable));
    if (blocker) return { kind: "genuine_blocker", blockerKind: blocker.kind, explanation };
  }

  const recoverable = recoverableDenialFrom(input.deniedToolCalls) ?? denialQuotedInMessage(text);
  if (recoverable) return { kind: "recoverable_tool_denial", recoverable, explanation };

  /*
   * rc.9: a deterministic policy denial, below the two human-decidable prose
   * outcomes and below a denial the harness can fix by itself.
   *
   * It sits here rather than at the top deliberately. An explicit refusal is
   * still a position a human must overrule, and a denial that named its own
   * remedy is still something to retry rather than interrupt anybody about --
   * both were rc.2 decisions and neither is what went wrong.
   *
   * What went wrong is everything BELOW this line. The incident's turn matched
   * no refusal and no blocker, and no RECOVERIES entry matches "is denylisted",
   * so at rc.8 the strongest available fact -- a policy said no, twice -- lost
   * to `incomplete`, the bucket for "nothing happened and nothing was
   * explained". That licensed a retry that could not succeed and a question
   * built from planning prose.
   */
  const policy = policyDenialFrom(input.deniedToolCalls);
  if (policy) return { kind: "policy_denial", policy, explanation };

  if (text.length > 0 && !substantive) return { kind: "progress_only" };

  return { kind: "incomplete", explanation };
}

/**
 * rc.9: never repeat the backend's claim that a human refused something.
 *
 * OpenCode reports a denied permission to the model as:
 *
 *   "The user rejected permission to use this specific tool call."
 *
 * No user was asked. The ACP adapter answered the permission request on the
 * harness's behalf by selecting the `reject_once` option, which is the only
 * vocabulary the protocol offers, and the backend describes that choice in the
 * only terms it has. The model then repeats the sentence in its final message,
 * and that message has a route to the operator's screen.
 *
 * Telling somebody they rejected a thing they were never shown is worse than
 * saying nothing: it sends them looking for a decision they did not make. The
 * text is corrected wherever it would be quoted.
 */
const FALSE_USER_REJECTION =
  /\b(?:the\s+)?user\s+(?:rejected|denied|refused)\s+(?:the\s+)?permission[^.]*\.?/gi;

export function correctFalseUserRejection(text: string): string {
  return (text ?? "").replace(
    FALSE_USER_REJECTION,
    "the harness safety guard denied the tool call (no human was asked).",
  );
}

/**
 * rc.9: the question to put to a human when a policy blocked the work.
 *
 * The rc.8 clarification for this exact situation read, in full:
 *
 *   Sub-task 11 ("Document Safe Deployment And Review Artefacts") could not
 *   proceed. The worker's explanation: I'll inspect the named documentation
 *   sections, help companion conventions, [...] evidence requirements, and.
 *   How should it proceed?
 *
 * Truncated mid-sentence, and not one word of it is true about why the work
 * stopped. The harness had the real reason in an audit row written twenty
 * seconds earlier. So this builder is not a nicer paraphrase of the same
 * inputs -- it is built from the structured denial and does not consult the
 * worker's narrative at all, except as clearly-labelled secondary context.
 *
 * It must state: the rule, the affected paths, the tool, how many attempts were
 * spent, and what decision is actually being asked for.
 */
export function buildPolicyDenialClarification(params: {
  seq: number;
  title: string;
  policy: PolicyDenialOutcome;
  /** The worker's own words, if any survived narration-stripping. */
  workerNote?: string;
  /**
   * rc.10: work this turn DID land before the refusal.
   *
   * Audit 5601 asked the operator to treat a policy block as a possible path
   * mistake, because a partial commit existed and the mismatch branch owned
   * that case. Both things are true at once and the question has to say so:
   * the commit is real and is being kept, and the missing part is missing
   * because a rule refused it.
   */
  partialWork?: { commitSha: string | null; committed: string[]; unmet: string[] };
}): string {
  const { policy } = params;
  const paths = policy.paths.length > 0 ? policy.paths.map((p) => `\`${p}\``).join(", ") : "the requested path";
  const lines = [
    `Sub-task ${params.seq} ("${params.title}") was BLOCKED BY HARNESS SAFETY POLICY, not by the worker.`,
    "",
    `What was refused: ${policy.tool ?? "a tool call"} on ${paths}.`,
  ];
  const partial = params.partialWork;
  if (partial && (partial.committed.length > 0 || partial.commitSha)) {
    lines.push(
      "",
      `Work already done is KEPT: commit ${partial.commitSha ?? "(recorded)"}` +
        (partial.committed.length > 0 ? ` covering ${partial.committed.map((f) => `\`${f}\``).join(", ")}` : "") +
        ".",
      partial.unmet.length > 0
        ? `Still unmet: ${partial.unmet.map((f) => `\`${f}\``).join(", ")}. This is NOT a wrong-path mistake -- ` +
          `the write above was refused by the rule named below.`
        : "The remainder of the sub-task is unmet for the same reason.",
    );
  }
  if (policy.rule) lines.push(`Which rule: \`${policy.rule}\` in the safety path denylist.`);
  lines.push(
    `Attempts: ${policy.attempts}. The same call was refused each time -- this denial is deterministic, ` +
      `so retrying cannot change it.`,
    "",
    policy.message,
    "",
    "Your options: authorise the specific path if it is genuinely a tracked template (see " +
      "`safety.path_denylist_exceptions`), tell the worker to achieve the sub-task without touching that " +
      'path, answer "skip" to drop this sub-task, or "abort".',
  );
  if (params.workerNote) {
    // Last, and labelled. At rc.8 this text WAS the whole question.
    lines.push("", `For context, the worker's own last words (not the reason it stopped): ${params.workerNote}`);
  }
  return lines.join("\n");
}

/**
 * The operator's answer, addressed to the sub-task that asked the question.
 *
 * A resumed run does not call the lead, so anything written only into the
 * brief's acceptance criteria is never read: the worker is re-dispatched with
 * the same prompt that stopped it, hits the same wall, and asks again. The
 * answer has to arrive as a dispatch hint on that one sub-task.
 */
export function buildClarificationResumeHint(params: { question?: string; answer: string }): string {
  const lines = [
    "RESUMING THIS SUB-TASK AFTER AN OPERATOR DECISION.",
    "",
    "You stopped here and a human was asked to decide. They have answered, and their",
    "answer is binding: implement it as written, do not re-litigate it, and do not ask",
    "the same question again.",
    "",
  ];
  if (params.question) lines.push(`Question put to the operator: ${params.question.trim()}`);
  lines.push(`Operator's decision: ${params.answer.trim()}`);
  lines.push("");
  lines.push(
    "Everything else about this sub-task is unchanged, and the work already committed on",
    "this branch stands -- you are continuing it, not starting again. Pick up from where",
    "you stopped and finish, applying the decision above.",
  );
  return lines.join("\n");
}

/**
 * Did a research/observe turn report anything?
 *
 * An observe sub-task has no commit, so `verify: []` is the correct contract
 * and "the worker ended its turn" was the entire completion test. That makes it
 * the one place where narration is not merely unhelpful but actively harmful:
 * the report is `finalMessage` verbatim, and `observe-handoff.ts` hands it to
 * later sub-tasks under the heading "These are the VERBATIM reports". So "Now
 * let me check the workbook headers" is promoted to a finding, and the next
 * worker plans against it.
 *
 * Deliberately narrow. Emptiness is NOT insufficiency here: an observe turn
 * that says nothing hands nothing downstream (`recordObserveReport` drops it),
 * whereas narration passes the non-empty test and travels. Only the case that
 * travels is blocked.
 */
export function observeReportIsNarration(finalMessage: string | undefined): boolean {
  const text = (finalMessage ?? "").trim();
  if (!text) return false;
  return stripProgressNarration(text).length === 0;
}

/** Why an observe turn has no findings to hand on. */
export interface ObserveEvidenceVerdict {
  /** True when the turn inspected nothing, whatever its message says. */
  empty: boolean;
  /** Machine-readable: `no_reads`, `denied_only`. */
  code?: "no_reads" | "denied_only";
  /** Operator- and worker-facing, one sentence. */
  reason?: string;
  /** The denial that stopped it reading, when there was one. */
  deniedReason?: string;
}

/**
 * rc.10 (F4) -- did this observe turn actually look at anything?
 *
 * Client Offboarding smoke test, session aad3fc57, sub-task 1. Audits 5572
 * through 5575 record four denied `task` calls -- the worker tried to launch
 * nested agents, which focused workers may not do. Audit 5576 records what it
 * did instead: `unguardedReads: 0`, no files, no commit, and a 280-character
 * promise about what it was going to read. 5577 marked the prerequisite
 * completed with `verify_count: 0`, 5578 stored the promise as the report, and
 * 5579 and 5587 handed it to the two sub-tasks that depended on it.
 *
 * WHY THIS IS NOT ANOTHER TEXT RULE. The narration detector is a judgement
 * about English and will always have an edge: this message evaded it because a
 * bare "I'll ..." was not in the table and "No files ... will be modified" is a
 * scope disclaimer rather than an announcement. The tool-call counters are not
 * a judgement about anything. A turn that made no tool call, wrote no file and
 * made no commit inspected nothing, and a report of findings from a turn that
 * inspected nothing is not a report of findings in any language.
 *
 * WHICH COUNTER. `allowedToolCalls`, not `unguardedReads`. The incident row
 * showed `unguardedReads: 0` and that reads as "did nothing", but the field
 * counts only the reads the path denylist could NOT be applied to -- on a
 * backend that supplies read paths (Codex does) a turn that read a hundred
 * files reports 0. Keying the gate on it would fail every observe sub-task on
 * that backend, and would get quietly stricter as enforcement improved, which
 * is the wrong direction for a counter to move. `allowedToolCalls` counts every
 * permission request the guard let through, of any kind, so a probe that
 * searched with `rg` or read with paths counts as having looked. A non-zero
 * `unguardedReads` is still accepted as positive evidence on its own, because
 * it can only be non-zero if a read happened.
 *
 * A read-only sub-task still needs no commit -- that is the point of observe
 * mode and it is unaffected. What it cannot do is skip the reading.
 *
 * Neither counter being a number means the backend does not report them. That
 * is not evidence of zero, so the check declines to fire and the turn keeps its
 * pre-rc.10 treatment.
 */
export function observeEvidenceVerdict(result: {
  allowedToolCalls?: number;
  unguardedReads?: number;
  filesChanged?: string[];
  commitSha?: string | null;
  deniedToolCalls?: DeniedToolCall[];
}): ObserveEvidenceVerdict {
  const allowed = typeof result.allowedToolCalls === "number" ? result.allowedToolCalls : undefined;
  const unguarded = typeof result.unguardedReads === "number" ? result.unguardedReads : undefined;
  if (allowed === undefined && unguarded === undefined) return { empty: false };
  if ((allowed ?? 0) > 0) return { empty: false };
  if ((unguarded ?? 0) > 0) return { empty: false };
  if ((result.filesChanged ?? []).length > 0) return { empty: false };
  if (result.commitSha) return { empty: false };

  const denials = (result.deniedToolCalls ?? []).filter((d) => (d?.reason ?? d?.title ?? "").trim().length > 0);
  if (denials.length > 0) {
    const first = denials[0]!;
    return {
      empty: true,
      code: "denied_only",
      reason:
        `every tool call this turn made was denied (${denials.length}) and none was allowed, ` +
        `so the turn produced no findings`,
      deniedReason: (first.reason ?? first.title ?? "").trim().slice(0, 300),
    };
  }
  return {
    empty: true,
    code: "no_reads",
    reason: "the turn made no tool call, read nothing, wrote nothing and committed nothing, so it produced no findings",
  };
}

/**
 * rc.10 (F4): the corrective hint for an observe turn that inspected nothing.
 *
 * When the turn was denied its way of working, the useful instruction is the
 * permitted route -- which for audits 5572-5575 is "read the files yourself
 * rather than delegating". Telling that worker to "stop narrating" would be
 * describing a symptom at it.
 */
export function buildObserveEvidenceHint(params: {
  verdict: ObserveEvidenceVerdict;
  intent: string;
  attempt: number;
  maxAttempts: number;
}): string {
  const parts: string[] = [];
  if (params.verdict.code === "denied_only") {
    parts.push(
      `Every tool call in your previous turn was DENIED and you read no files, so that turn produced nothing. ` +
        (params.verdict.deniedReason ? `The guard said: "${params.verdict.deniedReason}". ` : "") +
        `Do not delegate this to a sub-agent. Read the files yourself with the direct read and search tools.`,
    );
  } else {
    parts.push(
      "Your previous turn read no files, wrote nothing and committed nothing. Whatever it reported, it " +
        "cannot have found anything, and the harness checks the tool calls rather than the prose.",
    );
  }
  parts.push(
    `THE DELIVERABLE IS THE REPORT, and it is handed verbatim to the sub-tasks that depend on this one. ` +
      `Answer this probe -- ${params.intent} -- with what you FOUND: exact paths, identifiers, versions, ` +
      `excerpts and, where something is missing, the fact that it is absent. Nothing is committed by this ` +
      `sub-task, so reading is the whole job.`,
    `Do not end your turn describing what you are about to look at. This is attempt ${params.attempt} of ${params.maxAttempts}.`,
  );
  return parts.join("\n\n");
}

/**
 * The verification contract in plain sentences.
 *
 * The retry prompt has to restate what will actually be checked. Dumping the
 * contract JSON invites the worker to reason about the harness's schema
 * instead of about the repository; naming the observable facts keeps the
 * conversation on what has to be true in Git when the turn ends.
 */
export function describeContractForRetry(
  contract: ReadonlyArray<{ kind: string; path?: string; branch?: string; state?: string }> | undefined,
): string {
  const parts: string[] = [];
  for (const c of contract ?? []) {
    switch (c.kind) {
      case "commit_made":
        parts.push("a new commit exists on this branch");
        break;
      case "file_written":
        parts.push(`the file \`${c.path}\` exists on disk and is non-empty`);
        break;
      case "file_committed":
        parts.push(`the file \`${c.path}\` appears in a commit on this branch`);
        break;
      case "branch_pushed":
      case "remote_branch_exists":
        parts.push("the branch exists on origin");
        break;
      case "pr_opened":
        parts.push("a pull request has been opened");
        break;
      case "pr_state":
        parts.push(`the pull request is ${c.state}`);
        break;
      case "file_pushed":
        parts.push(`\`${c.path}\` is present on the pushed branch`);
        break;
      case "file_in_pr":
        parts.push(`\`${c.path}\` appears in the pull request's files`);
        break;
      case "commit_sha_matches":
        parts.push("local HEAD matches the remote branch tip");
        break;
      default:
        parts.push(c.kind);
    }
  }
  // Deduplicate: a contract naming four files produces four distinct clauses,
  // but repeated `commit_made` entries would otherwise repeat verbatim.
  const seen = new Set<string>();
  const unique = parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return unique.length > 0 ? unique.join("; ") : "the sub-task's declared observable outputs exist in Git";
}

/**
 * The corrective prompt for a retry.
 *
 * Built to the rc.2 brief: quote the denial verbatim, name the permitted route,
 * restate the observable contract, forbid ending on narration, and say when the
 * worker is allowed to stop. The verbatim quote matters -- a paraphrase of a
 * guard message is another chance to describe a rule slightly wrong.
 */
export function buildProtocolRetryHint(params: {
  outcome: WorkerOutcome;
  /** What the harness will check, in the worker's own contract language. */
  contractSummary: string;
  /** Files the previous turn left dirty, if any. */
  uncommittedFiles?: string[];
  attempt: number;
  maxAttempts: number;
}): string {
  const parts: string[] = [];
  const r = params.outcome.recoverable;

  if (r) {
    parts.push(
      `A command in your previous turn was DENIED by the harness safety guard, which said: "${r.reason}". ` +
        `This is recoverable and does not change the task. ${r.remedy}`,
    );
  } else if (params.outcome.kind === "progress_only") {
    parts.push(
      "Your previous turn ended by describing what you were about to do next, and then stopped. " +
        "Nothing was committed, so none of it happened.",
    );
  } else {
    parts.push(
      "Your previous turn produced ZERO filesystem changes and ZERO commits, whatever its final message claimed. Git is authoritative.",
    );
  }

  const wrote = params.uncommittedFiles ?? [];
  if (wrote.length > 0) {
    parts.push(
      `The harness inspected Git: these files are written but uncommitted: ${wrote.join(", ")}. Finish any remaining edits, then \`git add\` and \`git commit\` them.`,
    );
  }

  parts.push(`OBSERVABLE CONTRACT -- the harness will verify exactly this, by inspecting Git: ${params.contractSummary}`);
  parts.push(
    "Do NOT end your turn with a description of what you intend to do. Continue working until one of three things is true: " +
      "the work is complete and committed, you have hit a blocker only a human can clear (name it explicitly and say what you need), " +
      "or you are refusing the task (say so explicitly and why). " +
      `This is attempt ${params.attempt} of ${params.maxAttempts}.`,
  );
  return parts.join("\n\n");
}
