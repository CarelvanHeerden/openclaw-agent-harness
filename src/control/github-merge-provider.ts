import type { DatabaseSync } from "node:sqlite";
import type { MergeProvider } from "./merge.js";
import type { PrReadinessInput } from "./readiness.js";
import type { getCiSnapshot, getPullRequest, mergePullRequest } from "../adapters/github.js";

type PullRequest = Awaited<ReturnType<typeof getPullRequest>>;
type CiSnapshot = Awaited<ReturnType<typeof getCiSnapshot>>;
type MergeResult = Awaited<ReturnType<typeof mergePullRequest>>;
export interface BoundControlCredential { route: { apiBase?: string }; token: string; }
export interface ControlMergeProviderDependencies {
  db: DatabaseSync;
  resolveCredential(runId: string, repository: string, prNumber: number, requesterId: string): Promise<BoundControlCredential>;
  getPullRequest(input: { repoFullName: string; prNumber: number; ghToken: string; apiBase?: string }): Promise<PullRequest>;
  getCiSnapshot(input: { repoFullName: string; sha: string; ghToken: string; apiBase?: string }): Promise<CiSnapshot>;
  mergePullRequest(input: { repoFullName: string; prNumber: number; ghToken: string; apiBase?: string; method: "squash"; expectedHeadSha: string }): Promise<MergeResult>;
}

export function createControlMergeProvider(deps: ControlMergeProviderDependencies): MergeProvider {
  const bindingFor = (runId: string, repository: string, prNumber: number): { requesterId: string; proposal: Record<string, unknown> } => {
    const proposal = deps.db.prepare(`SELECT p.*, r.requester_id, r.repository, r.base_ref, s.published_at
      FROM control_proposals p JOIN control_runs r ON r.id=p.run_id LEFT JOIN sessions s ON s.id=p.run_id WHERE p.run_id=?`).get(runId) as Record<string, unknown> | undefined;
    if (!proposal) throw new Error("Control merge run binding is unavailable");
    if (String(proposal.repository) !== repository || Number(proposal.pr_number) !== prNumber) throw new Error("Control merge run binding mismatch");
    const requesterId = String(proposal.requester_id ?? "");
    if (!requesterId) throw new Error("Control requester is unavailable");
    return { requesterId, proposal };
  };
  return {
    inspect: async ({ runId, repository, prNumber, readinessDigest }) => {
      const { requesterId, proposal } = bindingFor(runId, repository, prNumber);
      if (String(proposal.readiness_digest) !== readinessDigest) throw new Error("Control readiness binding mismatch");
      const { route, token: ghToken } = await deps.resolveCredential(runId, repository, prNumber, requesterId);
      const pr = await deps.getPullRequest({ repoFullName: repository, prNumber, ghToken, apiBase: route.apiBase });
      const ci = await deps.getCiSnapshot({ repoFullName: repository, sha: pr.headSha, ghToken, apiBase: route.apiBase });
      const latest = deps.db.prepare(`SELECT input_json FROM control_readiness_attestations WHERE run_id=? AND content_digest=?`).get(runId, readinessDigest) as { input_json: string } | undefined;
      if (!latest) throw new Error("Control readiness binding is unavailable");
      const prior = JSON.parse(latest.input_json) as PrReadinessInput;
      return { repository, baseRef: pr.baseBranch, prNumber, headSha: pr.headSha, open: pr.state === "open" && !pr.merged, merged: pr.merged,
        ...(pr.mergeCommitSha ? { mergeSha: pr.mergeCommitSha } : {}), readiness: { ...prior, candidateSha: pr.headSha,
          publication: { sha: String(proposal.published_sha), observedAt: Number(proposal.published_at) },
          pullRequest: { repository, baseRef: pr.baseBranch, headSha: pr.headSha, open: pr.state === "open" && !pr.merged, number: prNumber, url: pr.htmlUrl },
          requiredCi: { registered: ci.statusReadable && ci.checksReadable && ci.checkNames.length > 0, requiredChecks: ci.checkNames,
            successfulChecks: ci.state === "success" ? ci.checkNames : [], sha: pr.headSha,
            status: (ci.state === "success" ? "success" : ci.state === "failure" ? "failure" : ci.state === "pending" ? "pending" : "indeterminate") as "success" | "failure" | "pending" | "indeterminate" } } };
    },
    merge: async ({ runId, repository, prNumber, expectedHeadSha }) => {
      const { requesterId } = bindingFor(runId, repository, prNumber);
      const { route, token: ghToken } = await deps.resolveCredential(runId, repository, prNumber, requesterId);
      const merged = await deps.mergePullRequest({ repoFullName: repository, prNumber, ghToken, apiBase: route.apiBase, method: "squash", expectedHeadSha });
      if (!merged.merged || !merged.sha) throw new Error(merged.message || "Provider did not merge the pull request");
      return { mergeSha: merged.sha };
    },
    verifyMerged: async ({ runId, repository, prNumber, mergeSha }) => {
      let requesterId: string; try { ({ requesterId } = bindingFor(runId, repository, prNumber)); } catch { return false; }
      const { route, token: ghToken } = await deps.resolveCredential(runId, repository, prNumber, requesterId);
      const pr = await deps.getPullRequest({ repoFullName: repository, prNumber, ghToken, apiBase: route.apiBase });
      return /^[a-f0-9]{40}$/i.test(mergeSha) && pr.merged && pr.mergeCommitSha === mergeSha;
    },
  };
}
