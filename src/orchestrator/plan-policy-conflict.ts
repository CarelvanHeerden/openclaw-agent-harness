/**
 * rc.10 (F3) -- does this plan require a write the safety policy will refuse?
 *
 * Client Offboarding smoke test, 15 September 2026. Sub-task 3 required
 * `.env.example`. The effective denylist contains `.env.*`, no exception was
 * configured, and nothing compared the two until a worker had already been
 * dispatched. Audit 5598 records the denial on the first attempt; after an
 * operator correction that changed the test path but not the policy, audit 5619
 * records the identical denial on the second. Between them the run spent
 * $1.62978 on sub-task 3, of which the final $0.4262756 bought a retry of work
 * that unchanged policy could only refuse again.
 *
 * The plan and the policy are both known before a single token is spent. This
 * compares them.
 *
 * DELIBERATELY ADVISORY ABOUT WHAT IT FINDS, STRICT ABOUT WHAT IT CLAIMS.
 * `filesLikelyTouched` is the lead's guess, so a conflict here is evidence that
 * a sub-task is heading for a wall, not proof that it must fail -- the worker
 * may satisfy the sub-task without touching the path at all. The caller decides
 * what to do; this module only reports, names the rule, and never mutates a
 * plan. It is pure: no fs, no git, no config lookup of its own.
 */

import { denylistRuleFor } from "../safety/bash-guard.js";
import { resolvePathForPolicy, templateExceptionApplies } from "../safety/path-policy.js";

export interface PlanPolicyConflict {
  seq: number;
  title: string;
  /** The planned path, as the plan wrote it. */
  path: string;
  /** The denylist entry that will refuse it. */
  rule: string;
  /**
   * True when an explicit `safety.path_denylist_exceptions` entry already
   * authorises this exact path, in which case there is no conflict to report.
   * Retained on the type so the caller can audit near-misses if it wants to.
   */
  authorised: boolean;
}

export interface PlanPolicyConflictInput {
  seq: number;
  title?: string;
  filesLikelyTouched?: string[] | null;
}

/**
 * Every planned write the effective policy would refuse.
 *
 * Mirrors the guard's own predicates rather than re-implementing them:
 * `denylistRuleFor` is the same function the ACP guard consults, and the
 * exception check is the same `templateExceptionApplies`. If those two ever
 * disagree with this, the bug is one function and not two policies.
 */
export function findPlanPolicyConflicts(
  subTasks: readonly PlanPolicyConflictInput[] | undefined,
  denylist: readonly string[],
  exceptions: readonly string[] = [],
): PlanPolicyConflict[] {
  if (!subTasks || subTasks.length === 0 || denylist.length === 0) return [];

  const out: PlanPolicyConflict[] = [];
  const seen = new Set<string>();
  for (const st of subTasks) {
    for (const raw of st.filesLikelyTouched ?? []) {
      const path = typeof raw === "string" ? raw.trim() : "";
      if (!path) continue;
      const rule = denylistRuleFor(path, denylist);
      if (!rule) continue;

      // An explicitly authorised template is not a conflict. Resolved
      // lexically only: this runs at plan time, before the worktree is
      // necessarily populated, so there is nothing to `realpath` against yet.
      // The guard still does the full resolution at write time, which is where
      // a symlink or a traversal would be caught.
      const authorised = templateExceptionApplies(resolvePathForPolicy(path), exceptions);
      if (authorised) continue;

      const key = `${st.seq}|${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ seq: st.seq, title: st.title ?? `sub-task ${st.seq}`, path, rule, authorised: false });
    }
  }
  return out;
}

/**
 * The decision to put to an operator, before the money is spent.
 *
 * Names the rule, the path and the sub-task, and asks for the one thing that
 * can actually resolve it. What it must not do is what the incident's
 * clarification did: describe a policy conflict as if the worker had made a
 * mistake about where a file goes.
 */
export function describePlanPolicyConflicts(conflicts: readonly PlanPolicyConflict[]): string {
  if (conflicts.length === 0) return "";
  const bySeq = new Map<number, PlanPolicyConflict[]>();
  for (const c of conflicts) {
    const list = bySeq.get(c.seq) ?? [];
    list.push(c);
    bySeq.set(c.seq, list);
  }

  const lines = [
    conflicts.length === 1
      ? "This plan requires a file the harness safety policy will REFUSE to write."
      : `This plan requires ${conflicts.length} files the harness safety policy will REFUSE to write.`,
    "",
  ];
  for (const [seq, list] of [...bySeq.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`Sub-task ${seq} ("${list[0]!.title}"):`);
    for (const c of list) lines.push(`  - \`${c.path}\` is blocked by the denylist rule \`${c.rule}\``);
  }
  lines.push(
    "",
    "Nothing has been dispatched for the affected sub-task, so no budget has been spent on it yet.",
    "",
    "Your options: authorise the exact path(s) via `safety.path_denylist_exceptions` if they are genuinely " +
      "tracked templates and a deployment change is approved separately, restate the sub-task so it achieves " +
      'its goal without writing the blocked path, answer "skip" to drop the sub-task, or "abort".',
    "",
    "Note that authorising a template path does not authorise putting a real credential in it: content is " +
      "scanned independently, and a secret in an authorised template is still refused.",
  );
  return lines.join("\n");
}
