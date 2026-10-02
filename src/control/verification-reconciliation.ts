import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ReviewFinding } from "../orchestrator/adversary.js";

export interface VerificationResolutionEvidence {
  readonly kind: "resolved_by_remote_ci";
  readonly findingFingerprint: string;
  readonly reviewDigest: string;
  readonly findingTitle: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly candidateSha: string;
  readonly remoteCheck: string;
  readonly conclusion: "success";
  readonly observedAt: number;
  readonly evidenceDigest: string;
}

export function isTypecheckEquivalentCheck(name:string):boolean {
  const canonical=name.trim().toLowerCase().replace(/[^a-z0-9]+/g,"");
  return canonical==="typescriptcheck"||canonical==="typecheck"||canonical==="tsc";
}

export function verificationResolutionDigest(value:Omit<VerificationResolutionEvidence,"evidenceDigest">):string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function reconcileLocalVerificationWithRemoteCi(input:{
  findings:readonly ReviewFinding[];
  repository:string;
  pullRequestNumber:number;
  candidateSha:string;
  ciSha:string;
  policyStatus:"readable"|"denied"|"indeterminate";
  policyChecks:readonly string[];
  successfulChecks:readonly string[];
  observedAt:number;
  reviewDigest:string;
}):{unresolvedFindings:ReviewFinding[];resolutions:VerificationResolutionEvidence[]} {
  const exactSha=/^[a-f0-9]{40}$/i.test(input.candidateSha)&&input.candidateSha===input.ciSha;
  const equivalent=exactSha&&input.policyStatus==="readable"
    ? input.policyChecks.find((check)=>isTypecheckEquivalentCheck(check)&&input.successfulChecks.includes(check))
    : undefined;
  const unresolvedFindings:ReviewFinding[]=[];
  const resolutions:VerificationResolutionEvidence[]=[];
  for(const finding of input.findings){
    const unavailableTypecheck=
      finding.source==="harness_env" &&
      finding.localVerification?.kind==="typecheck" &&
      finding.localVerification.state==="unavailable";
    if(!unavailableTypecheck||!equivalent||!finding.fingerprint||!/^[a-f0-9]{64}$/.test(input.reviewDigest)){
      unresolvedFindings.push(finding);
      continue;
    }
    const unsigned:Omit<VerificationResolutionEvidence,"evidenceDigest">={
      kind:"resolved_by_remote_ci",
      findingFingerprint:finding.fingerprint,
      reviewDigest:input.reviewDigest,
      findingTitle:finding.title,
      repository:input.repository,
      pullRequestNumber:input.pullRequestNumber,
      candidateSha:input.candidateSha,
      remoteCheck:equivalent,
      conclusion:"success",
      observedAt:input.observedAt,
    };
    resolutions.push({...unsigned,evidenceDigest:verificationResolutionDigest(unsigned)});
  }
  return{unresolvedFindings,resolutions};
}

export function reconcileBoundLocalVerificationWithRemoteCi(
  reviewBound:boolean,
  input:Parameters<typeof reconcileLocalVerificationWithRemoteCi>[0],
):ReturnType<typeof reconcileLocalVerificationWithRemoteCi> {
  return reviewBound
    ? reconcileLocalVerificationWithRemoteCi(input)
    : {unresolvedFindings:[...input.findings],resolutions:[]};
}

export function persistVerificationResolutions(
  db:DatabaseSync,
  sessionId:string,
  resolutions:readonly VerificationResolutionEvidence[],
):void {
  if(resolutions.length===0)return;
  db.exec("BEGIN IMMEDIATE");
  try{
    for(const resolution of resolutions){
      db.prepare(`INSERT INTO verification_resolutions (evidence_digest,session_id,finding_fingerprint,candidate_sha,evidence_json,created_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(session_id,finding_fingerprint,candidate_sha) DO UPDATE SET evidence_digest=excluded.evidence_digest,evidence_json=excluded.evidence_json,created_at=excluded.created_at`)
        .run(resolution.evidenceDigest,sessionId,resolution.findingFingerprint,resolution.candidateSha,JSON.stringify(resolution),resolution.observedAt);
      const updated=db.prepare(`UPDATE findings SET state='resolved_by_remote_ci',updated_at=? WHERE session_id=? AND fingerprint=? AND state IN ('environment_blocked','resolved_by_remote_ci')`)
        .run(resolution.observedAt,sessionId,resolution.findingFingerprint);
      if(Number(updated.changes)!==1)throw new Error(`verification_resolution_finding_missing:${resolution.findingFingerprint}`);
    }
    db.exec("COMMIT");
  }catch(error){
    try{db.exec("ROLLBACK")}catch{}
    throw error;
  }
}
