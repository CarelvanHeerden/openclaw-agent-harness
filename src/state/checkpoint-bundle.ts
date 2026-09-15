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

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { redactTokenShapes } from "./interaction-log.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

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

function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

export function checkpointDirFor(root: string, sessionId: string): string {
  return join(root, "checkpoints", sessionId);
}

/**
 * Take a durable checkpoint.
 *
 * Never throws for an expected failure -- a checkpoint that cannot be taken must
 * be RECORDED as not taken, not swallowed and not crash the run. The returned
 * manifest carries the reason either way.
 */
export async function createCheckpoint(opts: CheckpointOptions): Promise<CheckpointResult> {
  const git = opts.git ?? defaultGitRunner;
  const now = opts.now ?? (() => Date.now());
  const createdAt = now();
  const dir = checkpointDirFor(opts.checkpointRoot, opts.sessionId);

  const base: CheckpointManifest = {
    version: 1,
    sessionId: opts.sessionId,
    cycle: opts.cycle,
    subTaskId: opts.subTaskId ?? null,
    trigger: opts.trigger ?? "sub_task_complete",
    branch: opts.branch,
    tip: null,
    commitCount: 0,
    recoverable: false,
    bundleFile: null,
    bundleBytes: 0,
    bundleSha256: null,
    createdAt,
  };

  const fail = (why: string): CheckpointResult => {
    const manifest = { ...base, error: redactTokenShapes(why) };
    let manifestPath: string | null = null;
    try {
      mkdirSync(dir, { recursive: true });
      manifestPath = join(dir, `${createdAt}-failed.json`);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      manifestPath = null; // if we cannot even record the failure, say so by omission
    }
    return { manifest, manifestPath, durable: false };
  };

  if (!existsSync(opts.worktreePath)) {
    return fail(`worktree ${opts.worktreePath} does not exist, so there is nothing to checkpoint`);
  }

  // What are we actually bundling? Resolve the tip first: a branch with no
  // commits is a legitimate state and must produce an honest metadata-only
  // checkpoint rather than a mystery failure.
  const revParse = await git(["rev-parse", "--verify", `${opts.branch}^{commit}`], opts.worktreePath);
  if (revParse.code !== 0) {
    return fail(`branch ${opts.branch} has no commit in ${opts.worktreePath}: ${revParse.stderr.trim()}`);
  }
  const tip = revParse.stdout.trim();

  const range = opts.since ? `${opts.since}..${opts.branch}` : opts.branch;
  const countArgs = opts.since ? ["rev-list", "--count", range] : ["rev-list", "--count", opts.branch];
  const counted = await git(countArgs, opts.worktreePath);
  const commitCount = counted.code === 0 ? Number.parseInt(counted.stdout.trim(), 10) || 0 : 0;

  if (commitCount === 0) {
    // Honest metadata-only checkpoint. Explicitly not recoverable code.
    const manifest = { ...base, tip, commitCount: 0, recoverable: false };
    try {
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${createdAt}-metadata.json`);
      writeFileSync(p, JSON.stringify(manifest, null, 2));
      return { manifest, manifestPath: p, durable: false };
    } catch (err) {
      return fail(`could not write metadata checkpoint: ${String(err)}`);
    }
  }

  let bundlePath: string;
  let tmpPath: string;
  try {
    mkdirSync(dir, { recursive: true });
    bundlePath = join(dir, `${createdAt}-${tip.slice(0, 12)}.bundle`);
    tmpPath = `${bundlePath}.tmp`;
  } catch (err) {
    return fail(`checkpoint directory ${dir} is not writable: ${String(err)}`);
  }

  // Write to .tmp. A crash here leaves no manifest, which reads as "no
  // checkpoint" -- and the next attempt overwrites the debris.
  const created = await git(["bundle", "create", tmpPath, range], opts.worktreePath);
  if (created.code !== 0 || !existsSync(tmpPath)) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    return fail(`git bundle create failed: ${created.stderr.trim() || `exit ${created.code}`}`);
  }

  // Verify BEFORE publishing. This is the whole point of the module.
  const verified = await git(["bundle", "verify", tmpPath], opts.worktreePath);
  if (verified.code !== 0) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    return fail(`bundle did not verify, so it is not a checkpoint: ${verified.stderr.trim() || `exit ${verified.code}`}`);
  }

  let bytes = 0;
  let digest: string;
  try {
    bytes = statSync(tmpPath).size;
    digest = sha256File(tmpPath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    return fail(`could not digest the bundle: ${String(err)}`);
  }
  if (bytes === 0) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    return fail("bundle verified but is empty, which cannot be right");
  }

  try {
    renameSync(tmpPath, bundlePath);
  } catch (err) {
    try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    return fail(`could not publish the bundle: ${String(err)}`);
  }

  const manifest: CheckpointManifest = {
    ...base,
    tip,
    commitCount,
    recoverable: true,
    bundleFile: basename(bundlePath),
    bundleBytes: bytes,
    bundleSha256: digest,
  };

  // Manifest last, by rename, so a manifest's existence means the bundle
  // beside it is complete and verified.
  const manifestPath = join(dir, `${createdAt}-${tip.slice(0, 12)}.json`);
  try {
    const tmpManifest = `${manifestPath}.tmp`;
    writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2));
    renameSync(tmpManifest, manifestPath);
  } catch (err) {
    return fail(`bundle is on disk but its manifest could not be published: ${String(err)}`);
  }

  return { manifest, manifestPath, durable: true };
}

/**
 * Read a manifest and re-prove it.
 *
 * Returns null for anything that is not a complete, self-consistent, present
 * checkpoint. Callers get "there is no checkpoint" rather than a half-truth:
 * a manifest whose bundle was deleted, truncated or swapped is worse than none,
 * because it invites a restore that will not work.
 */
export function loadCheckpoint(manifestPath: string): CheckpointManifest | null {
  let manifest: CheckpointManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CheckpointManifest;
  } catch {
    return null;
  }
  if (!manifest || manifest.version !== 1) return null;
  if (manifest.error) return null;
  if (!manifest.recoverable || !manifest.bundleFile || !manifest.bundleSha256) return null;

  const bundlePath = join(dirname(manifestPath), manifest.bundleFile);
  if (!existsSync(bundlePath)) return null;
  try {
    if (statSync(bundlePath).size !== manifest.bundleBytes) return null;
    if (sha256File(bundlePath) !== manifest.bundleSha256) return null;
  } catch {
    return null;
  }
  return manifest;
}

/** The newest checkpoint for a session that still proves out, or null. */
export function latestCheckpoint(
  checkpointRoot: string,
  sessionId: string,
  listDir?: (p: string) => string[],
): { manifest: CheckpointManifest; manifestPath: string } | null {
  const dir = checkpointDirFor(checkpointRoot, sessionId);
  let names: string[];
  try {
    names = (listDir ? listDir(dir) : readdirSync(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return null;
  }
  const candidates = names
    .map((n) => join(dir, n))
    .map((p) => ({ p, m: loadCheckpoint(p) }))
    .filter((x): x is { p: string; m: CheckpointManifest } => x.m !== null)
    .sort((a, b) => b.m.createdAt - a.m.createdAt);
  const best = candidates[0];
  return best ? { manifest: best.m, manifestPath: best.p } : null;
}

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
export async function restoreCheckpoint(
  manifestPath: string,
  targetDir: string,
  git: GitRunner = defaultGitRunner,
): Promise<RestoreResult> {
  const manifest = loadCheckpoint(manifestPath);
  if (!manifest) {
    return { ok: false, path: null, tip: null, reason: `${manifestPath} is not a usable checkpoint` };
  }
  if (existsSync(targetDir)) {
    return { ok: false, path: null, tip: null, reason: `refusing to restore over the existing ${targetDir}` };
  }
  const bundlePath = join(dirname(manifestPath), manifest.bundleFile!);

  const parent = dirname(targetDir);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (err) {
    return { ok: false, path: null, tip: null, reason: `cannot create ${parent}: ${String(err)}` };
  }

  const cloned = await git(["clone", "--branch", manifest.branch, bundlePath, targetDir], parent);
  if (cloned.code !== 0) {
    return { ok: false, path: null, tip: null, reason: `clone from bundle failed: ${cloned.stderr.trim()}` };
  }

  // Prove the tip is actually there. A clone that succeeds but lands on the
  // wrong commit is the failure mode a restore is supposed to rule out.
  const head = await git(["rev-parse", "--verify", "HEAD"], targetDir);
  const got = head.stdout.trim();
  if (head.code !== 0 || got !== manifest.tip) {
    return {
      ok: false,
      path: targetDir,
      tip: got || null,
      reason: `restored HEAD ${got || "(none)"} is not the checkpointed tip ${manifest.tip}`,
    };
  }
  return { ok: true, path: targetDir, tip: got };
}
