/**
 * rc.9 -- durable checkpoints for committed work.
 *
 * StitchGuard held nine commits and a tenth sub-task's worth of review fixes.
 * Every one of them lived in exactly one place: a worktree on a tmpfs mount,
 * whose bare object cache was nested INSIDE the same mount. Nothing had been
 * pushed, because pushing is a deliberate late step. A container restart, and
 * the only surviving artefact was a database describing them.
 *
 * `checkpoint()` in the store is a DB write. It records that a sub-task
 * finished and which cycle we are on. It has never moved a single git object
 * anywhere, and the word "checkpoint" quietly promised otherwise.
 *
 * A checkpoint here is a `git bundle`: one self-contained file holding the
 * actual objects, written to a location that is meant to outlive the worktree,
 * and -- the part that matters -- VERIFIED before anything records it as
 * durable. A bundle that does not verify is a bundle that will fail at 3am
 * during the one restore anybody ever needed.
 *
 * Three rules this module will not bend:
 *
 *   1. Nothing is durable until `git bundle verify` passes AND the digest of
 *      the bytes on disk matches the digest in the manifest.
 *   2. The manifest is published by rename() after the bundle is complete and
 *      verified. A crash mid-write leaves a `.tmp` file and no manifest, which
 *      reads as "no checkpoint" -- the safe direction.
 *   3. A checkpoint with no commits is recorded as metadata, never as
 *      recoverable code. That distinction is the difference between an honest
 *      progress report and the one this incident produced.
 */
export interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;
export declare const defaultGitRunner: GitRunner;
/**
 * What a checkpoint claims, in a form that survives the process that wrote it.
 *
 * `commitCount` and `recoverable` exist so a reader cannot mistake a bookkeeping
 * entry for retrievable code. Requirement: progress must never count a
 * metadata-only checkpoint as recoverable work.
 */
export interface CheckpointManifest {
    version: 1;
    sessionId: string;
    cycle: number;
    /** The sub-task this checkpoint was taken AFTER, when there was one. */
    subTaskId: string | null;
    /** Why the checkpoint was taken. `human_gate` is taken before we block. */
    trigger: "sub_task_complete" | "human_gate" | "manual";
    branch: string;
    /** Tip commit the bundle contains. Null only for a metadata-only checkpoint. */
    tip: string | null;
    /** Commits in the bundle. Zero means there is no code here to recover. */
    commitCount: number;
    /** True only when the bundle verified AND contains at least one commit. */
    recoverable: boolean;
    bundleFile: string | null;
    bundleBytes: number;
    /** sha256 of the bundle file as written. Re-checked on every load. */
    bundleSha256: string | null;
    createdAt: number;
    /** Populated when a checkpoint attempt failed. Present => not durable. */
    error?: string;
}
export interface CheckpointOptions {
    sessionId: string;
    cycle: number;
    subTaskId?: string | null;
    trigger?: CheckpointManifest["trigger"];
    /** The worktree holding the commits. */
    worktreePath: string;
    branch: string;
    /**
     * Where checkpoints live. MUST be on storage that outlives the worktree --
     * see docs/persistence-runbook.md. The harness cannot enforce that, but it
     * can and does refuse to call a checkpoint durable without verifying it.
     */
    checkpointRoot: string;
    /** Commits to bundle. Defaults to the whole branch. */
    since?: string | null;
    git?: GitRunner;
    now?: () => number;
}
export interface CheckpointResult {
    manifest: CheckpointManifest;
    manifestPath: string | null;
    /** The one field callers should branch on. */
    durable: boolean;
}
export declare function checkpointDirFor(root: string, sessionId: string): string;
/**
 * Take a durable checkpoint.
 *
 * Never throws for an expected failure -- a checkpoint that cannot be taken must
 * be RECORDED as not taken, not swallowed and not crash the run. The returned
 * manifest carries the reason either way.
 */
export declare function createCheckpoint(opts: CheckpointOptions): Promise<CheckpointResult>;
/**
 * Read a manifest and re-prove it.
 *
 * Returns null for anything that is not a complete, self-consistent, present
 * checkpoint. Callers get "there is no checkpoint" rather than a half-truth:
 * a manifest whose bundle was deleted, truncated or swapped is worse than none,
 * because it invites a restore that will not work.
 */
export declare function loadCheckpoint(manifestPath: string): CheckpointManifest | null;
/** The newest checkpoint for a session that still proves out, or null. */
export declare function latestCheckpoint(checkpointRoot: string, sessionId: string, listDir?: (p: string) => string[]): {
    manifest: CheckpointManifest;
    manifestPath: string;
} | null;
export interface RestoreResult {
    ok: boolean;
    /** Where the recovered objects now live. */
    path: string | null;
    tip: string | null;
    reason?: string;
}
/**
 * Restore a checkpoint into a fresh directory.
 *
 * Deliberately restores to somewhere NEW. The incident's recovery instinct is
 * to put things back where they were, and that is exactly how you overwrite the
 * one remaining copy of something. The caller decides what to do with the
 * result; this function only proves the bundle really does hold the work.
 */
export declare function restoreCheckpoint(manifestPath: string, targetDir: string, git?: GitRunner): Promise<RestoreResult>;
//# sourceMappingURL=checkpoint-bundle.d.ts.map