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

/** One denial, as the ACP adapter records it. */
export interface DeniedToolCall {
  kind?: string | null;
  title?: string;
  reason?: string;
}

export type WorkerOutcomeKind =
  /** A guard denial whose reason names a permitted alternative. Retry it. */
  | "recoverable_tool_denial"
  /** The turn ended describing what it was about to do. Retry it. */
  | "progress_only"
  /** Something only a human can settle. Ask. */
  | "genuine_blocker"
  /** The worker declined the work on its merits. Ask. */
  | "refusal"
  /** Nothing happened and the worker said nothing useful about why. Retry it. */
  | "incomplete";

export interface RecoveryGuidance {
  /** Coarse bucket for metrics: `inline_code`, `heredoc`, `git_push`, `guided`. */
  category: string;
  /** The guard's own words, verbatim. The retry prompt quotes these. */
  reason: string;
  /** The command that was denied, when the backend reported one. */
  title?: string;
  /** The permitted route to the same result, in the imperative. */
  remedy: string;
}

export interface WorkerOutcome {
  kind: WorkerOutcomeKind;
  /** Present only for `recoverable_tool_denial`. */
  recoverable?: RecoveryGuidance;
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
      "Write the code to a temporary script file with the file-writing tool, run that file with a normal interpreter invocation, then delete it.",
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
  // The bare "I will ..." form needs a leading adverb or an explicit "now".
  // Without that guard it swallows "I will not do this", turning the clearest
  // refusal the worker can write into an unfinished sentence -- the precise
  // inversion of the bug being fixed.
  /^(?:ok(?:ay)?|right)?[,\s]*(?:now|next|then|first(?:ly)?|finally)[,\s]+i(?:'ll| will)\s+(?!not\b)/i,
  /^i(?:'ll| will)\s+now\s+(?!not\b)/i,
  /^(?:now|next|then|first(?:ly)?|finally)\b[^.!?]*\bi(?:'ll| will|'m going to| am going to)\s+(?!not\b)/i,
  /^(?:time to|moving on to|proceeding to|continuing with|starting with)\b/i,
];

/** The worker declined the work itself, as opposed to fumbling a command. */
const REFUSAL_RE: RegExp[] = [
  /\bi\s+(?:will|would|shall)\s+not\b/i,
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

/** Is this fragment an announcement rather than a result? */
export function isProgressFragment(fragment: string): boolean {
  // Strip list bullets and numbering so "- Next, I'll check X" is seen.
  const t = fragment.replace(/^[-*+\u2022]\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
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

    const known = RECOVERIES.find((r) => r.match.test(reason));
    if (known) return { category: known.category, reason, title: title || undefined, remedy: known.remedy };

    if (HEREDOC_RE.test(title) || /heredoc|here[\s-]document/i.test(reason)) {
      return {
        category: "heredoc",
        reason,
        title: title || undefined,
        remedy:
          "Do not feed a heredoc into an interpreter. Create the script with the file-writing tool, run it, then delete it.",
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
}): WorkerOutcome {
  const text = (input.finalMessage ?? "").trim();
  const substantive = stripProgressNarration(text);
  const explanation = substantive.length > 0 ? substantive : undefined;

  if (substantive && REFUSAL_RE.some((re) => re.test(substantive))) {
    return { kind: "refusal", explanation };
  }

  if (substantive) {
    const blocker = BLOCKERS.find((b) => b.match.test(substantive));
    if (blocker) return { kind: "genuine_blocker", blockerKind: blocker.kind, explanation };
  }

  const recoverable = recoverableDenialFrom(input.deniedToolCalls) ?? denialQuotedInMessage(text);
  if (recoverable) return { kind: "recoverable_tool_denial", recoverable, explanation };

  if (text.length > 0 && !substantive) return { kind: "progress_only" };

  return { kind: "incomplete", explanation };
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
