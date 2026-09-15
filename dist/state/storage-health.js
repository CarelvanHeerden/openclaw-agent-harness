/**
 * rc.9 -- does the work this database claims to have still exist?
 *
 * StitchGuard, session f7c4e585, 2026-09-14 ~19:42. A container restart, and
 * then two startup checks that both reported success:
 *
 *   5431  harness.worktrees_preflight  {ok:true, created:false}
 *   5432  harness.worktree_heal        {scanned:0, removed:0, errors:[]}
 *
 * Both were telling the truth about what they measure, and together they were
 * profoundly misleading. The worktrees root is a tmpfs mount, so the restart
 * took every worktree with it -- and the bare object cache too, because the git
 * adapter puts `.repos/<owner>/<repo>.git` INSIDE the worktrees root. Nine
 * recorded commits existed nowhere else. Meanwhile the state DB sat on a
 * host-backed virtiofs mount and survived perfectly, still holding a paused
 * session, a worktree path and all nine SHAs.
 *
 * The healer could not see any of that because it only ever walks ONE way:
 * enumerate the directories on disk, look each one up in the database, decide
 * whether to reap it. An empty root means the loop body never runs. `scanned:0`
 * is not "nothing to check", it is "nothing left to check WITH".
 *
 * This module walks the other way -- from the rows that claim work to the disk
 * that should be holding it -- and writes down what it finds. Two rules:
 *
 *   - It NEVER deletes anything. Reconciliation is diagnosis. Deletion stays
 *     with the healer, whose protections (live loops, paused sessions, in-flight
 *     allocations, worktrees an abort deliberately preserved) are unchanged.
 *   - "I could not tell" is recorded as `unknown`, never as `ok`. A writable
 *     directory is not a durable one, and that conflation is the incident.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
/**
 * Statuses whose rows CLAIM live local state.
 *
 * A terminal session's missing worktree is ordinary housekeeping, not a
 * finding -- reporting it would bury the real one under every run the machine
 * has ever completed. `awaiting_clarification` is in the list because that is
 * precisely what the incident session was, and it is the state most likely to
 * outlive a restart: it is designed to wait for a human.
 */
const WORK_BEARING_STATUSES = new Set([
    "planning",
    "executing",
    "reviewing",
    "finalising",
    "awaiting_clarification",
    "interrupted",
    "paused",
]);
export function claimsLocalStorage(status) {
    return WORK_BEARING_STATUSES.has((status ?? "").trim());
}
/** The bare object cache the git adapter would use for a repo. */
export function bareCachePathFor(worktreesRoot, repoFullName) {
    const [owner, repo] = (repoFullName ?? "").split("/");
    return join(worktreesRoot, ".repos", owner ?? "", `${repo ?? ""}.git`);
}
/**
 * Walk session rows -> disk and report what is missing.
 *
 * Ordered cheapest-first and short-circuiting: there is no point asking git
 * about commits in a directory that is not there.
 */
export async function reconcileSessionsToDisk(sessions, deps) {
    const exists = deps.exists ?? ((p) => existsSync(p));
    const out = [];
    for (const s of sessions) {
        if (!claimsLocalStorage(s.status))
            continue;
        const wt = (s.worktreePath ?? "").trim();
        if (!wt) {
            out.push({
                sessionId: s.id,
                state: "unknown",
                reason: `session is ${s.status} but records no worktree path, so its local state cannot be verified`,
                missingCommits: [],
            });
            continue;
        }
        if (!exists(wt)) {
            out.push({
                sessionId: s.id,
                state: "missing_worktree",
                reason: `the recorded worktree ${wt} no longer exists` +
                    (s.recordedCommits.length > 0
                        ? `, and this session recorded ${s.recordedCommits.length} commit(s) that may have existed only there`
                        : ""),
                missingCommits: [...s.recordedCommits],
            });
            continue;
        }
        const bare = bareCachePathFor(deps.worktreesRoot, s.repo);
        if (!exists(bare)) {
            // The worktree survived but its object store did not. Git cannot read a
            // worktree whose objects are gone, so this is as fatal as the first case
            // and much easier to miss, because `ls` still shows files.
            out.push({
                sessionId: s.id,
                state: "missing_objects",
                reason: `the worktree ${wt} exists but its git object store ${bare} does not; the checkout is unusable`,
                missingCommits: [...s.recordedCommits],
            });
            continue;
        }
        if (s.recordedCommits.length === 0)
            continue;
        if (!deps.unreachableCommits) {
            out.push({
                sessionId: s.id,
                state: "unknown",
                reason: `${s.recordedCommits.length} recorded commit(s) could not be checked: no git probe is wired`,
                missingCommits: [],
            });
            continue;
        }
        try {
            const missing = await deps.unreachableCommits(wt, [...s.recordedCommits]);
            if (missing.length > 0) {
                out.push({
                    sessionId: s.id,
                    state: "missing_commits",
                    reason: `${missing.length} of ${s.recordedCommits.length} recorded commit(s) are not present in ${wt} ` +
                        `(${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""})`,
                    missingCommits: missing,
                });
            }
        }
        catch (err) {
            out.push({
                sessionId: s.id,
                state: "unknown",
                reason: `commit reachability check failed for ${wt}: ${String(err)}`,
                missingCommits: [],
            });
        }
    }
    return out;
}
/**
 * Is this checkpoint root capable of outliving the worktrees it protects?
 *
 * A checkpoint stored inside the worktrees root is not a checkpoint. That is
 * not a hypothetical: it is precisely the shape of the incident, where the bare
 * object cache -- the only other copy of every commit -- lived at
 * `<worktrees_root>/.repos/...` and died with the mount it was nested in.
 */
export function checkpointRootIsSafe(checkpointRoot, worktreesRoot) {
    const root = (checkpointRoot ?? "").trim();
    if (!root)
        return { ok: false, reason: "no checkpoint_root is configured, so committed work has no durable copy" };
    const norm = (p) => (p.endsWith("/") ? p.slice(0, -1) : p);
    const cr = norm(root);
    const wr = norm((worktreesRoot ?? "").trim());
    if (wr && (cr === wr || cr.startsWith(wr + "/"))) {
        return {
            ok: false,
            reason: `checkpoint_root ${cr} is inside the worktrees root ${wr}; whatever destroys the worktrees destroys the checkpoints with them`,
        };
    }
    return { ok: true };
}
/** Filesystems whose contents are definitionally lost on restart. */
const VOLATILE_FS = new Set(["tmpfs", "ramfs", "devtmpfs"]);
/**
 * What kind of storage is this path on?
 *
 * Honest about its own limits: `/proc/self/mountinfo` does not exist on macOS
 * and may be unreadable in a locked-down container, and in that case `volatile`
 * stays undefined rather than defaulting to "fine". The rc.8 preflight's
 * problem was not that it was wrong, it was that `ok:true` read as a broader
 * claim than "I created and deleted a file here".
 */
export function probeStorage(path, readMountInfo) {
    const probe = { path, exists: false };
    try {
        const st = statSync(path);
        probe.exists = true;
        probe.device = st.dev;
    }
    catch {
        return { ...probe, note: "path does not exist or is not stat-able" };
    }
    try {
        const parent = join(path, "..");
        probe.separateMount = statSync(parent).dev !== probe.device;
    }
    catch {
        /* a parent we cannot stat tells us nothing; leave it undefined */
    }
    let mountinfo;
    try {
        mountinfo = readMountInfo ? readMountInfo() : readMountInfoFromProc();
    }
    catch {
        probe.note = "mount table unavailable; filesystem type and durability are UNKNOWN";
        return probe;
    }
    // mountinfo columns: id parent major:minor root mountpoint opts... - fstype source
    let best = null;
    for (const line of mountinfo.split("\n")) {
        const sep = line.indexOf(" - ");
        if (sep < 0)
            continue;
        const point = line.slice(0, sep).split(/\s+/)[4];
        const fsType = line.slice(sep + 3).split(/\s+/)[0];
        if (!point || !fsType)
            continue;
        // The longest mountpoint that is a prefix of `path` is the one that owns it.
        if (path === point || path.startsWith(point.endsWith("/") ? point : point + "/")) {
            if (!best || point.length > best.point.length)
                best = { point, fsType };
        }
    }
    if (!best) {
        probe.note = "no matching mount entry; filesystem type and durability are UNKNOWN";
        return probe;
    }
    probe.fsType = best.fsType;
    probe.volatile = VOLATILE_FS.has(best.fsType);
    if (probe.volatile) {
        probe.note =
            `${best.fsType} at ${best.point} does not survive a restart; anything stored here is lost when the ` +
                `container stops, including any git object store nested under it`;
    }
    return probe;
}
/**
 * Linux's mount table. Absent on macOS and in some hardened containers, which
 * is why every caller treats a throw here as UNKNOWN rather than as fine.
 */
function readMountInfoFromProc() {
    return readFileSync("/proc/self/mountinfo", "utf8");
}
//# sourceMappingURL=storage-health.js.map