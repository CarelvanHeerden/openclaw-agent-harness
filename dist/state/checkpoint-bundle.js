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
export const defaultGitRunner = (args, cwd) => new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
});
function sha256File(p) {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
}
/**
 * rc.10: serialise a manifest with redaction applied to the WHOLE document.
 *
 * rc.9 redacted only the `error` string, on the assumption that a secret could
 * only arrive via a git failure message. That is one field's worth of a
 * property that should hold for the file. A manifest also persists a branch
 * name and a session id, and a checkpoint manifest is a diagnostic artefact
 * that gets copied into tickets and pasted into chat during a recovery -- the
 * moment anyone is reading one, something has already gone wrong.
 *
 * Redacting at the serialisation boundary makes "no manifest contains a
 * credential" true by construction rather than by remembering to wrap each new
 * field someone adds later.
 */
function serialiseManifest(manifest) {
    return redactTokenShapes(JSON.stringify(manifest, null, 2));
}
export function checkpointDirFor(root, sessionId) {
    return join(root, "checkpoints", sessionId);
}
/**
 * Take a durable checkpoint.
 *
 * Never throws for an expected failure -- a checkpoint that cannot be taken must
 * be RECORDED as not taken, not swallowed and not crash the run. The returned
 * manifest carries the reason either way.
 */
export async function createCheckpoint(opts) {
    const git = opts.git ?? defaultGitRunner;
    const now = opts.now ?? (() => Date.now());
    const createdAt = now();
    const dir = checkpointDirFor(opts.checkpointRoot, opts.sessionId);
    const base = {
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
    const fail = (why) => {
        const manifest = { ...base, error: redactTokenShapes(why) };
        let manifestPath = null;
        try {
            mkdirSync(dir, { recursive: true });
            manifestPath = join(dir, `${createdAt}-failed.json`);
            writeFileSync(manifestPath, serialiseManifest(manifest));
        }
        catch {
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
            writeFileSync(p, serialiseManifest(manifest));
            return { manifest, manifestPath: p, durable: false };
        }
        catch (err) {
            return fail(`could not write metadata checkpoint: ${String(err)}`);
        }
    }
    let bundlePath;
    let tmpPath;
    try {
        mkdirSync(dir, { recursive: true });
        bundlePath = join(dir, `${createdAt}-${tip.slice(0, 12)}.bundle`);
        tmpPath = `${bundlePath}.tmp`;
    }
    catch (err) {
        return fail(`checkpoint directory ${dir} is not writable: ${String(err)}`);
    }
    // Write to .tmp. A crash here leaves no manifest, which reads as "no
    // checkpoint" -- and the next attempt overwrites the debris.
    const created = await git(["bundle", "create", tmpPath, range], opts.worktreePath);
    if (created.code !== 0 || !existsSync(tmpPath)) {
        try {
            rmSync(tmpPath, { force: true });
        }
        catch { /* best effort */ }
        return fail(`git bundle create failed: ${created.stderr.trim() || `exit ${created.code}`}`);
    }
    // Verify BEFORE publishing. This is the whole point of the module.
    const verified = await git(["bundle", "verify", tmpPath], opts.worktreePath);
    if (verified.code !== 0) {
        try {
            rmSync(tmpPath, { force: true });
        }
        catch { /* best effort */ }
        return fail(`bundle did not verify, so it is not a checkpoint: ${verified.stderr.trim() || `exit ${verified.code}`}`);
    }
    let bytes = 0;
    let digest;
    try {
        bytes = statSync(tmpPath).size;
        digest = sha256File(tmpPath);
    }
    catch (err) {
        try {
            rmSync(tmpPath, { force: true });
        }
        catch { /* best effort */ }
        return fail(`could not digest the bundle: ${String(err)}`);
    }
    if (bytes === 0) {
        try {
            rmSync(tmpPath, { force: true });
        }
        catch { /* best effort */ }
        return fail("bundle verified but is empty, which cannot be right");
    }
    try {
        renameSync(tmpPath, bundlePath);
    }
    catch (err) {
        try {
            rmSync(tmpPath, { force: true });
        }
        catch { /* best effort */ }
        return fail(`could not publish the bundle: ${String(err)}`);
    }
    const manifest = {
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
        writeFileSync(tmpManifest, serialiseManifest(manifest));
        renameSync(tmpManifest, manifestPath);
    }
    catch (err) {
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
export function loadCheckpoint(manifestPath) {
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    }
    catch {
        return null;
    }
    if (!manifest || manifest.version !== 1)
        return null;
    if (manifest.error)
        return null;
    if (!manifest.recoverable || !manifest.bundleFile || !manifest.bundleSha256)
        return null;
    const bundlePath = join(dirname(manifestPath), manifest.bundleFile);
    if (!existsSync(bundlePath))
        return null;
    try {
        if (statSync(bundlePath).size !== manifest.bundleBytes)
            return null;
        if (sha256File(bundlePath) !== manifest.bundleSha256)
            return null;
    }
    catch {
        return null;
    }
    return manifest;
}
/** The newest checkpoint for a session that still proves out, or null. */
export function latestCheckpoint(checkpointRoot, sessionId, listDir) {
    const dir = checkpointDirFor(checkpointRoot, sessionId);
    let names;
    try {
        names = (listDir ? listDir(dir) : readdirSync(dir)).filter((n) => n.endsWith(".json"));
    }
    catch {
        return null;
    }
    const candidates = names
        .map((n) => join(dir, n))
        .map((p) => ({ p, m: loadCheckpoint(p) }))
        .filter((x) => x.m !== null)
        .sort((a, b) => b.m.createdAt - a.m.createdAt);
    const best = candidates[0];
    return best ? { manifest: best.m, manifestPath: best.p } : null;
}
/**
 * Restore a checkpoint into a fresh directory.
 *
 * Deliberately restores to somewhere NEW. The incident's recovery instinct is
 * to put things back where they were, and that is exactly how you overwrite the
 * one remaining copy of something. The caller decides what to do with the
 * result; this function only proves the bundle really does hold the work.
 */
export async function restoreCheckpoint(manifestPath, targetDir, git = defaultGitRunner) {
    const manifest = loadCheckpoint(manifestPath);
    if (!manifest) {
        return { ok: false, path: null, tip: null, reason: `${manifestPath} is not a usable checkpoint` };
    }
    if (existsSync(targetDir)) {
        return { ok: false, path: null, tip: null, reason: `refusing to restore over the existing ${targetDir}` };
    }
    const bundlePath = join(dirname(manifestPath), manifest.bundleFile);
    const parent = dirname(targetDir);
    try {
        mkdirSync(parent, { recursive: true });
    }
    catch (err) {
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
//# sourceMappingURL=checkpoint-bundle.js.map