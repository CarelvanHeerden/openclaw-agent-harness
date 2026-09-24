import type { DatabaseSync } from "node:sqlite";

const TERMINAL = new Set(["done", "failed", "aborted", "cancelled", "accounting_incomplete"]);

function versionParts(version: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(version.trim());
  if (!match) return [0, 0, 0, 0];
  return match.slice(1).map((part, index) => index === 3 && part === undefined ? Number.MAX_SAFE_INTEGER : Number(part ?? 0));
}

export function compareRuntimeVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i]! !== right[i]!) return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

export interface DowngradeBlocker {
  sessionId: string;
  status: string;
  minimumRuntimeVersion: string;
}

/**
 * A version marker is diagnostic, not a lock older code can enforce. The only
 * safe default is to refuse downgrade while an incompatible session is live.
 */
export function downgradeBlockers(
  db: DatabaseSync,
  targetVersion: string,
): DowngradeBlocker[] {
  const legacy = db.prepare(
    `SELECT id, status, minimum_runtime_version
       FROM sessions
      WHERE minimum_runtime_version IS NOT NULL AND minimum_runtime_version != ''`,
  ).all() as Array<{ id: string; status: string; minimum_runtime_version: string }>;
  let control: Array<{ id: string; status: string; minimum_runtime_version: string }> = [];
  try {
    control = db.prepare(`SELECT r.id, r.state AS status, p.minimum_runtime_version
      FROM control_runs r JOIN control_proposals p ON p.run_id=r.id
      WHERE p.minimum_runtime_version != ''`).all() as Array<{ id: string; status: string; minimum_runtime_version: string }>;
  } catch { /* pre-control-plane database */ }
  const rows = [...legacy, ...control];
  return rows
    .filter((row) => !TERMINAL.has(row.status))
    .filter((row) => compareRuntimeVersions(targetVersion, row.minimum_runtime_version) < 0)
    .map((row) => ({
      sessionId: row.id,
      status: row.status,
      minimumRuntimeVersion: row.minimum_runtime_version,
    }));
}

export function assertDowngradeSafe(db: DatabaseSync, targetVersion: string): void {
  const blockers = downgradeBlockers(db, targetVersion);
  if (blockers.length === 0) return;
  throw new Error(
    `downgrade to ${targetVersion} refused: ${blockers.length} incompatible nonterminal session(s): ` +
    blockers.map((row) => `${row.sessionId} (${row.status}, requires ${row.minimumRuntimeVersion})`).join(", "),
  );
}
