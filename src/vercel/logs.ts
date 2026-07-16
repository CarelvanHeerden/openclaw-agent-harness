/**
 * Vercel preview-deployment bridge.
 *
 * Given a repo + branch, waits (bounded) for a preview deployment to reach
 * READY / ERROR, then returns an excerpt of its runtime logs so the
 * adversary can review real behaviour, not just the diff.
 *
 * We treat READY as "ok" and ERROR (build or runtime) as "build_failed".
 * If no deployment appears in `preview_wait_seconds`, we return
 * `no_deploy_yet` and the adversary's runtime dimension is force-flagged
 * MEDIUM (see fable5-adversary.ts).
 *
 * Optional (config-driven): if `harness.vercel.enabled` is false, this
 * module is never called and adversary review skips runtime silently.
 */

export type RuntimeStatus = "ok" | "no_deploy_yet" | "build_failed" | "unavailable";

export interface RuntimeSnapshot {
  provider: "vercel" | "manual" | "local";
  status: RuntimeStatus;
  deploymentUrl?: string;
  logsExcerpt?: string;
  errorCount?: number;
  /** Present when provider="manual" (see harness_upload_logs tool). */
  uploadedAt?: number;
  uploadedBy?: string;
  source?: string;
  /**
   * beta.7 fix #1: local observable-side-effect verification results. When
   * the Vercel/manual runtime is unavailable, sub-task verification (branch
   * pushed, PR opened, file written, commit made) is surfaced here so the
   * adversary has hard "did the observable output actually happen?" data
   * instead of `runtime: no runtime data`.
   */
  localVerification?: Array<{ seq: number; ok: boolean; summary: string }>;
}

export interface FetchLogsInput {
  vercelToken: string;
  teamId?: string;
  projectId: string;
  branch: string;
  waitSeconds: number;
  pollIntervalMs?: number;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
}

const API = "https://api.vercel.com";

interface VercelDeployment {
  uid: string;
  url: string;
  state: "BUILDING" | "READY" | "ERROR" | "QUEUED" | "CANCELED";
  meta?: { githubCommitRef?: string; branchAlias?: string };
  created: number;
}

/**
 * Wait for the latest deployment on `branch` to reach a terminal state.
 * Returns the deployment record or null if the wait window elapses.
 */
export async function waitForPreview(input: FetchLogsInput): Promise<VercelDeployment | null> {
  const start = Date.now();
  const poll = input.pollIntervalMs ?? 10_000;
  while (Date.now() - start < input.waitSeconds * 1000) {
    const dep = await latestDeploymentForBranch(input);
    if (dep && (dep.state === "READY" || dep.state === "ERROR" || dep.state === "CANCELED")) {
      return dep;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  return null;
}

async function latestDeploymentForBranch(input: FetchLogsInput): Promise<VercelDeployment | null> {
  const qs = new URLSearchParams({ projectId: input.projectId, limit: "10" });
  if (input.teamId) qs.set("teamId", input.teamId);
  const res = await fetch(`${API}/v6/deployments?${qs}`, {
    headers: { Authorization: `Bearer ${input.vercelToken}`, "User-Agent": "openclaw-agent-harness/0.1" },
  });
  if (!res.ok) {
    input.logger.warn("[vercel] deployments list failed", { status: res.status });
    return null;
  }
  const j = (await res.json()) as { deployments?: VercelDeployment[] };
  const list = j.deployments ?? [];
  const forBranch = list.find(
    (d) => (d.meta?.githubCommitRef === input.branch) || (d.meta?.branchAlias === input.branch),
  );
  return forBranch ?? null;
}

/**
 * Fetch build + runtime logs for a deployment. We concat the last N lines
 * of each and return a bounded excerpt (adversary tokens are precious).
 */
export async function fetchBranchLogs(input: FetchLogsInput): Promise<RuntimeSnapshot> {
  let dep: VercelDeployment | null;
  try {
    dep = await waitForPreview(input);
  } catch (err) {
    input.logger.warn("[vercel] waitForPreview threw", { err: String(err) });
    return { provider: "vercel", status: "unavailable" };
  }
  if (!dep) return { provider: "vercel", status: "no_deploy_yet" };

  const status: RuntimeStatus =
    dep.state === "READY" ? "ok" : dep.state === "ERROR" ? "build_failed" : "unavailable";

  const events = await fetchEvents(input, dep.uid).catch((err) => {
    input.logger.warn("[vercel] events fetch failed", { err: String(err) });
    return [] as Array<{ text: string; type: string }>;
  });

  const errorCount = events.filter((e) => /error|exception|unhandled/i.test(e.text)).length;
  const excerpt = events.slice(-60).map((e) => `[${e.type}] ${e.text}`).join("\n").slice(0, 8000);

  return {
    provider: "vercel",
    status,
    deploymentUrl: `https://${dep.url}`,
    logsExcerpt: excerpt,
    errorCount,
  };
}

async function fetchEvents(input: FetchLogsInput, deploymentId: string): Promise<Array<{ text: string; type: string }>> {
  const qs = new URLSearchParams();
  if (input.teamId) qs.set("teamId", input.teamId);
  const res = await fetch(`${API}/v3/deployments/${deploymentId}/events?${qs}`, {
    headers: { Authorization: `Bearer ${input.vercelToken}`, "User-Agent": "openclaw-agent-harness/0.1" },
  });
  if (!res.ok) throw new Error(`vercel events ${res.status}`);
  // Vercel returns an array; some plans stream NDJSON — handle either.
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await res.json()) as Array<{ text?: string; payload?: { text?: string }; type: string }>;
    return j.map((e) => ({ text: e.text ?? e.payload?.text ?? "", type: e.type }));
  }
  const raw = await res.text();
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const j = JSON.parse(line);
        return { text: j.text ?? j.payload?.text ?? "", type: j.type ?? "log" };
      } catch {
        return { text: line, type: "log" };
      }
    });
}
