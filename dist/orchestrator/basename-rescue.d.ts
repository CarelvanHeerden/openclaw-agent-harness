/**
 * beta.105: UPSTREAM basename-anchored remap generation.
 *
 * b103's `rederiveContractPath` is a CONSUMER of remaps. It corrects a
 * contract path only when some EARLIER sub-task in the same run already
 * committed a file that taught the loop the substitution -- `src/app/(app)` ->
 * `src/app/(portal)`, say. When that lesson exists the machinery is excellent:
 * the b103 smoke fired nine rederives, every one of them correct, every one
 * written back to the plan.
 *
 * It has no producer. On the b103 smoke, seq 9 was the FIRST sub-task in the
 * run to touch anything under `src/components/`, so when the lead's fictional
 * `src/components/layout/sidebar.tsx` met the worker's correct
 * `src/components/ui/sidebar.tsx`, there was no prior lesson to apply, no
 * rederive fired at all, and the run escalated to a human. The answer was
 * mechanically obvious -- same basename, plan directory does not exist, the
 * committed file's directory does -- and the clarification cost an hour of
 * dead time before anyone read it.
 *
 * This module is the producer. It proposes a remap from the mismatch itself,
 * under conditions strict enough that a proposal is evidence rather than a
 * guess. It only PROPOSES; the caller applies it through the same b103
 * rederive-and-writeback path, so a rescued path is corrected in the contract
 * and in the plan exactly like a learned one.
 *
 * Pure: takes the mismatch and a repo directory listing, returns a proposal or
 * nothing. No git, no fs, no I/O.
 */
/** A remap this module is willing to vouch for, in rederive's own shape. */
export interface BasenameRescue {
    /**
     * beta.122: which producer vouched for this, since they justify themselves
     * differently -- `basename` matches the same file in another directory,
     * `directory` matches a file inside the directory the contract named.
     */
    kind?: "basename" | "directory";
    /** The fictional contract path. */
    from: string;
    /** The real path, taken from what the sub-task actually committed. */
    to: string;
    /** The directory substitution the correction implies, for the audit trail. */
    via: {
        from: string;
        to: string;
        basename: string;
    };
    /** Why this was safe to do without asking, for the audit trail. */
    reason: string;
}
/**
 * Would a rescue be safe here, and if so what is it?
 *
 * Returns `undefined` -- meaning "escalate to a human, as before" -- unless
 * ALL of the following hold. Each one is load-bearing:
 *
 * 1. Exactly one expected path and exactly one actual path. A multi-file
 *    mismatch can be a genuinely wrong sub-task rather than a naming drift,
 *    and there is no unambiguous pairing to infer a substitution from.
 * 2. The two paths share a basename. This is the anchor: it is what makes
 *    "the same file, somewhere else" the overwhelmingly likely reading.
 * 3. The paths actually differ. Nothing to rescue otherwise.
 * 4. The expected DIRECTORY does not exist anywhere in the repo. If it does
 *    exist, the plan named a real location and the worker put the file
 *    somewhere else -- that is a real disagreement about where work belongs and
 *    a human should see it.
 * 5. The actual directory DOES exist in the repo. Confirms the worker landed
 *    somewhere real rather than inventing a second fiction.
 *
 * `repoDirs` is the set of directories present in the repo, derived from a
 * tracked-file listing by the caller.
 */
export declare function proposeBasenameRescue(input: {
    expected: string[];
    actual: string[];
    repoDirs: Set<string>;
}): BasenameRescue | undefined;
/**
 * beta.122: the plan named a DIRECTORY where the contract needs a file.
 *
 * On the b121 smoke the lead planned sub-task 3 with
 * `verify: [{file_written, "prisma/migrations"}, {file_committed, ...}]`. The
 * worker did the work correctly and committed
 * `prisma/migrations/20260812120000_continuity_resilience/migration.sql` --
 * which is the only thing it COULD have committed, since a migration's
 * timestamped directory does not exist until the migration is created, so the
 * lead could not have named the file in advance. `file_written` stats the
 * contract path and requires a regular file, so a directory can never pass.
 *
 * The escalation that followed was a question with one possible answer: the
 * audit event already held `expected: [prisma/migrations]` and
 * `actual: [prisma/migrations/2026..._continuity_resilience/migration.sql]`,
 * a 1:1 mapping needing no human judgement. Worse, asking cost the run: the
 * operator's reply took the resume path, which renamed the branch and orphaned
 * the work.
 *
 * Conditions, all load-bearing:
 *
 * 1. Exactly one expected path -- with several, there is no unambiguous
 *    directory to attribute a committed file to.
 * 2. Exactly one committed file sits UNDER that path. Other files may have been
 *    committed (a migration sub-task legitimately touches the schema too); what
 *    must be unique is the candidate inside the named directory.
 * 3. The candidate is strictly nested (`expected + "/"`), so `src/app` never
 *    rescues to `src/app.tsx` -- a sibling with a suffix is a different file,
 *    not a file inside a directory.
 * 4. The expected path is not itself the committed file. Nothing to rescue.
 */
export declare function proposeDirectoryRescue(input: {
    expected: string[];
    actual: string[];
}): BasenameRescue | undefined;
/** The set of directories implied by a tracked-file listing, including "". */
export declare function repoDirsFromFiles(files: readonly string[]): Set<string>;
/** One line for the audit trail and the run log. */
export declare function describeBasenameRescue(r: BasenameRescue): string;
//# sourceMappingURL=basename-rescue.d.ts.map