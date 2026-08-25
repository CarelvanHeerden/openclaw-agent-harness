/**
 * Operator guidance on a revise: what to DO, not just what to ignore.
 *
 * ROOT CAUSE this closes. `harness_revise` builds its brief entirely from the
 * prior session's stored adversary findings. `dropFindings` lets the caller say
 * which findings to EXCLUDE, so the only steer a human had was subtractive.
 * Nothing in the revise input could say what the fix should actually do.
 *
 * That is fine while a finding states the required behaviour. It fails when a
 * finding correctly identifies a SYMPTOM and understates the remedy, because
 * every cycle re-reads the same stored text and a worker satisfies it the
 * cheapest way available.
 *
 * StitchGuard PR #1084 is the shape. The finding read "external monitors cannot
 * filter the list API by status=DUE_FOR_RENEWAL server-side". Twice, a worker
 * "addressed" it by adding a code comment explaining the limitation -- which is
 * a true and responsive reading of those words. Nothing in the revise input
 * said "translate the value into a `reviewDate < now()` predicate instead of
 * rejecting it". A human eventually wrote the six lines by hand, after three
 * cycles and $25.48.
 *
 * The pattern here is `harness_answer`'s qualified confirmation: a free-text
 * operator reply is folded into the brief as a labelled, authoritative
 * correction that supersedes anything contradicting it. Guidance is the same
 * idea aimed at a revise, and it lands in `acceptanceCriteria` for the same
 * reason -- that array is what reaches the lead planner, the worker system
 * prompts and the adversary's spec-fidelity check.
 *
 * ONE THING IT DELIBERATELY CANNOT DO: weaken the gate. Guidance adds required
 * intent. It does not drop a finding and does not lower a severity -- that
 * stays the explicit, indexed job of `dropFindings`, where the operator has to
 * name what they are excluding and it shows up in the audit trail as an
 * exclusion. A steer that could also quietly retire findings would be a much
 * larger authority than "here is what I actually want built", and the two
 * belong on separate switches. The wording below says so in the prompt, because
 * the models are the only thing that could conflate them: structurally, a
 * severity is assigned by the adversary on a fresh review each cycle and never
 * read back out of the brief.
 *
 * Pure and dependency-free so the behaviour is testable directly, rather than
 * asserted against the source of a tool closure that cannot be imported.
 */

/** The prefix every folded-in guidance line carries, in the brief and on the PR. */
export const OPERATOR_GUIDANCE_LABEL = "OPERATOR GUIDANCE FOR THIS REVISE";

/**
 * Trim and flatten free text into the single line the brief will carry.
 *
 * Whitespace runs -- including newlines -- collapse to single spaces. Guidance
 * becomes ONE element of `acceptanceCriteria` and one blockquote on the PR, so
 * embedded newlines would either be lost on join or, worse, read as additional
 * criteria in a numbered list the operator never wrote. Flattening keeps what
 * they said identical everywhere it is rendered.
 *
 * Returns `undefined` for anything with no content, so an empty or
 * whitespace-only string is the same as not passing the parameter at all rather
 * than injecting an empty authoritative instruction.
 */
export function normaliseGuidance(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const flattened = raw.replace(/\s+/g, " ").trim();
  return flattened.length > 0 ? flattened : undefined;
}

/**
 * The acceptance-criteria line. Read by the lead, every worker, and the
 * adversary.
 *
 * Three jobs, in order: carry the operator's words verbatim; make them outrank
 * a cheap reading of a finding; and state plainly that they cannot retire a
 * finding or a severity.
 */
export function guidanceAcceptanceLine(text: string): string {
  return (
    `${OPERATOR_GUIDANCE_LABEL} (free-text direction from the human who requested it, written after reading the findings below): ${text} ` +
    `This is AUTHORITATIVE about what the fix must achieve, and supersedes anything below that contradicts it. ` +
    `Where a finding names a symptom without stating the behaviour required to resolve it, this states that behaviour -- implement it. ` +
    `A change that satisfies a finding's wording without delivering this -- documenting the limitation, commenting on it, renaming around it -- does NOT count as addressing that finding. ` +
    `This ADDS intent and cannot subtract: it does not drop any finding and does not lower any finding's severity. ` +
    `Every finding below must still be addressed at the severity shown; excluding one is a separate, explicit operator action (dropFindings), which this text is not.`
  );
}

/**
 * The PR echo, so the steer is visible to a human on the timeline next to the
 * review it applies to.
 *
 * This goes in the review COMMENT rather than the PR body on purpose. A revise
 * updates an existing PR, and `createPullRequest` only writes a body on first
 * open -- beta.75 added the per-review comment for exactly this reason. On a
 * fresh PR the guidance is already in the body, because the body renders
 * `acceptanceCriteria` and the line above is one of them.
 */
export function guidanceCommentSection(text: string): string[] {
  return [
    `### Operator guidance for this revise`,
    ``,
    `> ${text}`,
    ``,
    `_Authoritative for this revise: it adds required intent. It does not drop findings or lower severities -- that stays \`dropFindings\`._`,
    ``,
  ];
}
