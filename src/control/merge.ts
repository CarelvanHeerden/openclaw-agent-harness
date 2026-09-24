import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ControlRepository } from "./repository.js";
import { evaluatePrReadiness, type PrReadinessInput } from "./readiness.js";

export interface VerifiedMergeAuthorization {
  readonly version: 2; readonly id: string; readonly runId: string; readonly actorIdentity: string; readonly conversationIdentity: string;
  readonly repository: string; readonly baseRef: string; readonly prNumber: number; readonly expectedHeadSha: string;
  readonly publishedSha: string; readonly readinessDigest: string; readonly nonce: string; readonly issuedAt: number; readonly expiresAt: number; readonly bindingDigest: string;
}
export interface MergeInspection {
  readonly repository: string; readonly baseRef: string; readonly prNumber: number; readonly headSha: string; readonly open: boolean; readonly merged: boolean; readonly mergeSha?: string;
  readonly readiness: PrReadinessInput;
}
export interface MergeProvider {
  inspect(input:{runId:string;repository:string;prNumber:number;readinessDigest:string}):Promise<MergeInspection>;
  merge(input:{runId:string;repository:string;prNumber:number;expectedHeadSha:string;idempotencyKey:string}):Promise<{mergeSha:string}>;
  verifyMerged(input:{runId:string;repository:string;prNumber:number;mergeSha:string}):Promise<boolean>;
}
export type MergeServiceResult = Readonly<
 | {status:"merged";mergeSha:string}
 | {status:"already_merged";mergeSha?:string}
 | {status:"merge_in_progress"}
 | {status:"refused";code:"merge_attestation_required"|"stale_pr_head"|"pr_identity_mismatch"|"readiness_changed"|"authorization_expired"|"authorization_replayed"}
 | {status:"merge_failed";code:"provider_failure"|"verification_failed"}>;
const EXACT_PROVIDER_SHA = /^[a-f0-9]{40}$/i;
const sleep = (ms:number) => new Promise<void>((resolve)=>setTimeout(resolve,ms));
function stable(value:unknown):string{if(Array.isArray(value))return`[${value.map(stable).join(",")}]`;if(value&&typeof value==="object")return`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;return JSON.stringify(value);}
export function mergeAuthorizationDigest(input:Omit<VerifiedMergeAuthorization,"bindingDigest">):string{return createHash("sha256").update(`control-plane-merge/v2:${stable(input)}`).digest("hex");}
export function createVerifiedMergeAuthorization(input:Omit<VerifiedMergeAuthorization,"version"|"id"|"bindingDigest">&{id?:string}):VerifiedMergeAuthorization{const unsigned=Object.freeze({version:2 as const,id:input.id??randomUUID(),runId:input.runId,actorIdentity:input.actorIdentity,conversationIdentity:input.conversationIdentity,repository:input.repository,baseRef:input.baseRef,prNumber:input.prNumber,expectedHeadSha:input.expectedHeadSha,publishedSha:input.publishedSha,readinessDigest:input.readinessDigest,nonce:input.nonce,issuedAt:input.issuedAt,expiresAt:input.expiresAt});if(!unsigned.actorIdentity||!unsigned.conversationIdentity||!unsigned.repository||!unsigned.baseRef||!unsigned.nonce||!unsigned.readinessDigest)throw new Error("Incomplete merge authorization");if(!Number.isSafeInteger(unsigned.prNumber)||unsigned.prNumber<1||unsigned.expiresAt<=unsigned.issuedAt||unsigned.expectedHeadSha!==unsigned.publishedSha)throw new Error("Invalid merge authorization");return Object.freeze({...unsigned,bindingDigest:mergeAuthorizationDigest(unsigned)});}

export class InternalMergeService {
  private recoveryInFlight: Promise<void> | null = null;
  private static readonly MAX_RECOVERY_ATTEMPTS = 12;
  constructor(private readonly db:DatabaseSync,private readonly repository:ControlRepository,private readonly provider:MergeProvider,private readonly now:()=>number=Date.now){}

  registerAuthorizationAndIntent(a:VerifiedMergeAuthorization, now=this.now()): string {
    const {bindingDigest,...unsigned}=a;
    if(mergeAuthorizationDigest(unsigned)!==bindingDigest)throw new Error("Invalid merge authorization binding");
    const intentId=randomUUID(), key=`control-merge:${a.runId}:${a.expectedHeadSha}`;
    this.db.prepare(`INSERT INTO control_merge_authorizations (id,run_id,actor_identity,conversation_identity,repository_identity,base_ref,pr_number,expected_head_sha,readiness_digest,binding_digest,nonce,issued_at,expires_at,consumed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(a.id,a.runId,a.actorIdentity,a.conversationIdentity,a.repository,a.baseRef,a.prNumber,a.expectedHeadSha,a.readinessDigest,a.bindingDigest,a.nonce,a.issuedAt,a.expiresAt);
    this.db.prepare(`INSERT INTO control_engine_merge_intents (id,change_id,authorization_id,expected_head_sha,merge_provider_idempotency,status,created_at,updated_at) VALUES (?,?,?,?,?,'authorized',?,?)`).run(intentId,a.runId,a.id,a.expectedHeadSha,key,now,now);
    return intentId;
  }

  registerAuthorization(a:VerifiedMergeAuthorization):void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.registerAuthorizationAndIntent(a);
      const current=this.db.prepare(`SELECT state,version FROM control_runs WHERE id=?`).get(a.runId) as {state:string;version:number}|undefined;
      if(current?.state==="pr_ready"){
        this.db.prepare(`UPDATE control_runs SET state='awaiting_merge',version=version+1,updated_at=? WHERE id=? AND state='pr_ready' AND version=?`).run(this.now(),a.runId,current.version);
        this.db.prepare(`INSERT INTO control_state_events (run_id,from_state,to_state,from_version,to_version,actor,reason,created_at) VALUES (?,'pr_ready','awaiting_merge',?,?,'merge_service','merge_authorized',?)`).run(a.runId,current.version,current.version+1,this.now());
      }
      this.db.exec("COMMIT");
    } catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  async recoverPending():Promise<void>{
    if(this.recoveryInFlight)return this.recoveryInFlight;
    this.recoveryInFlight=(async()=>{
      const rows=this.db.prepare(`SELECT id,change_id,authorization_id,status,recovery_attempts FROM control_engine_merge_intents WHERE status IN ('authorized','merging') ORDER BY created_at LIMIT 25`).all() as Array<{id:string;change_id:string;authorization_id:string;status:string;recovery_attempts:number}>;
      await Promise.allSettled(rows.map(async(row)=>{
        {
          const attempts=Number(row.recovery_attempts??0)+1;
          this.db.prepare(`UPDATE control_engine_merge_intents SET recovery_attempts=?,updated_at=? WHERE id=? AND status IN ('authorized','merging')`).run(attempts,this.now(),row.id);
          if(attempts>InternalMergeService.MAX_RECOVERY_ATTEMPTS){this.failRun(row.change_id,row.id,"provider_failure");return;}
        }
        await this.merge(row.authorization_id);
      }));
    })().finally(()=>{this.recoveryInFlight=null;});
    return this.recoveryInFlight;
  }

  async merge(id:string):Promise<MergeServiceResult>{
    const now=this.now();
    const auth=this.db.prepare(`SELECT * FROM control_merge_authorizations WHERE id=?`).get(id) as Record<string,unknown>|undefined;
    if(!auth)return Object.freeze({status:"refused",code:"merge_attestation_required"});
    if(Number(auth.expires_at)<now&&auth.consumed_at===null)return Object.freeze({status:"refused",code:"authorization_expired"});
    const run=this.repository.getRun(String(auth.run_id));
    if(!run||(run.state!=="awaiting_merge"&&run.state!=="done"))return Object.freeze({status:"refused",code:"merge_attestation_required"});
    const repository=String(auth.repository_identity),baseRef=String(auth.base_ref),prNumber=Number(auth.pr_number),expectedHeadSha=String(auth.expected_head_sha),authorizedReadinessDigest=String(auth.readiness_digest);
    const proposal=this.db.prepare(`SELECT published_sha,readiness_digest FROM control_proposals WHERE run_id=?`).get(run.id) as {published_sha:string|null;readiness_digest:string|null}|undefined;
    if(!proposal||proposal.published_sha!==expectedHeadSha||proposal.readiness_digest!==authorizedReadinessDigest)return Object.freeze({status:"refused",code:"readiness_changed"});
    const readinessRow=this.db.prepare(`SELECT input_json,content_digest FROM control_readiness_attestations WHERE run_id=? AND content_digest=?`).get(run.id,authorizedReadinessDigest) as {input_json:string;content_digest:string}|undefined;
    if(!readinessRow||readinessRow.content_digest!==proposal.readiness_digest)return Object.freeze({status:"refused",code:"readiness_changed"});
    const intent=this.db.prepare(`SELECT id,status,provider_merge_sha,merge_provider_idempotency,authorization_id FROM control_engine_merge_intents WHERE change_id=?`).get(run.id) as {id:string;status:string;provider_merge_sha:string|null;merge_provider_idempotency:string;authorization_id:string}|undefined;
    if(!intent||intent.authorization_id!==id)return Object.freeze({status:"refused",code:"merge_attestation_required"});
    if(intent.status==="merged"&&intent.provider_merge_sha&&EXACT_PROVIDER_SHA.test(intent.provider_merge_sha)&&await this.provider.verifyMerged({runId:run.id,repository,prNumber,mergeSha:intent.provider_merge_sha})) return Object.freeze({status:"already_merged",mergeSha:intent.provider_merge_sha});
    if(intent.status!=="authorized") return this.reconcileClaimedMerge(run.id,intent.id,repository,prNumber,authorizedReadinessDigest,intent.status,intent.provider_merge_sha);
    let inspection:MergeInspection;try{inspection=await this.provider.inspect({runId:run.id,repository,prNumber,readinessDigest:authorizedReadinessDigest});}catch{return Object.freeze({status:"merge_in_progress"});}
    if(inspection.merged){const mergeSha=inspection.mergeSha??intent.provider_merge_sha??undefined;if(mergeSha&&EXACT_PROVIDER_SHA.test(mergeSha)&&await this.provider.verifyMerged({runId:run.id,repository,prNumber,mergeSha})){this.completeRun(run.id,intent.id,mergeSha);return Object.freeze({status:"already_merged",mergeSha});}this.failRun(run.id,intent.id,"verification_failed");return Object.freeze({status:"merge_failed",code:"verification_failed"});}
    if(!inspection.open||inspection.repository!==repository||inspection.baseRef!==baseRef||inspection.prNumber!==prNumber){this.refuseRun(run.id,intent.id,"pr_identity_mismatch");return Object.freeze({status:"refused",code:"pr_identity_mismatch"});}
    if(inspection.headSha!==expectedHeadSha){this.refuseRun(run.id,intent.id,"stale_pr_head");return Object.freeze({status:"refused",code:"stale_pr_head"});}
    const live=evaluatePrReadiness(inspection.readiness,now);if(!live.ready||live.verifiedSha!==expectedHeadSha){this.refuseRun(run.id,intent.id,"readiness_changed");return Object.freeze({status:"refused",code:"readiness_changed"});}
    const stored=evaluatePrReadiness(JSON.parse(readinessRow.input_json) as PrReadinessInput,now);if(!stored.ready||stored.verifiedSha!==expectedHeadSha){this.refuseRun(run.id,intent.id,"readiness_changed");return Object.freeze({status:"refused",code:"readiness_changed"});}
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claimed=this.db.prepare(`UPDATE control_engine_merge_intents SET status='merging',updated_at=? WHERE id=? AND authorization_id=? AND status='authorized'`).run(now,intent.id,id);
      if(claimed.changes!==1)throw new Error("merge_claim_lost");
      const consumed=this.db.prepare(`UPDATE control_merge_authorizations SET consumed_at=? WHERE id=? AND consumed_at IS NULL`).run(now,id);
      if(consumed.changes!==1)throw new Error("authorization_replayed");
      this.db.exec("COMMIT");
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}if(error instanceof Error&&error.message==="merge_claim_lost")return this.reconcileClaimedMerge(run.id,intent.id,repository,prNumber,authorizedReadinessDigest);return Object.freeze({status:"refused",code:"authorization_replayed"});}
    try{
      const merged=await this.provider.merge({runId:run.id,repository,prNumber,expectedHeadSha,idempotencyKey:intent.merge_provider_idempotency});
      if(!EXACT_PROVIDER_SHA.test(merged.mergeSha)){this.failRun(run.id,intent.id,"verification_failed");return Object.freeze({status:"merge_failed",code:"verification_failed"});}
      this.db.prepare(`UPDATE control_engine_merge_intents SET provider_merge_sha=?,updated_at=? WHERE id=? AND status='merging'`).run(merged.mergeSha,this.now(),intent.id);
      if(!await this.provider.verifyMerged({runId:run.id,repository,prNumber,mergeSha:merged.mergeSha})){this.failRun(run.id,intent.id,"verification_failed");return Object.freeze({status:"merge_failed",code:"verification_failed"});}
      this.completeRun(run.id,intent.id,merged.mergeSha);return Object.freeze({status:"merged",mergeSha:merged.mergeSha});
    }catch{return this.reconcileClaimedMerge(run.id,intent.id,repository,prNumber,authorizedReadinessDigest,"merging");}
  }

  private async reconcileClaimedMerge(runId:string,intentId:string,repository:string,prNumber:number,readinessDigest:string,knownStatus?:string,knownSha?:string|null):Promise<MergeServiceResult>{
    const deadline=Date.now()+5000;
    let status=knownStatus,providerMergeSha=knownSha;
    while(true){
      const current=this.db.prepare(`SELECT status,provider_merge_sha FROM control_engine_merge_intents WHERE id=?`).get(intentId) as {status:string;provider_merge_sha:string|null}|undefined;
      if(!current)return Object.freeze({status:"refused",code:"merge_attestation_required"});
      status=current.status;providerMergeSha=current.provider_merge_sha;
      if(status==="merged"){
        if(providerMergeSha&&EXACT_PROVIDER_SHA.test(providerMergeSha)&&await this.provider.verifyMerged({runId,repository,prNumber,mergeSha:providerMergeSha}))return Object.freeze({status:"already_merged",mergeSha:providerMergeSha});
        return Object.freeze({status:"merge_failed",code:"verification_failed"});
      }
      if(status==="merge_failed")return Object.freeze({status:"merge_failed",code:"provider_failure"});
      if(status==="verification_failed")return Object.freeze({status:"merge_failed",code:"verification_failed"});
      let inspection:MergeInspection|undefined;
      try{inspection=await this.provider.inspect({runId,repository,prNumber,readinessDigest});}catch{}
      if(inspection?.merged){
        const exactSha=inspection.mergeSha;
        if(exactSha&&EXACT_PROVIDER_SHA.test(exactSha)&&await this.provider.verifyMerged({runId,repository,prNumber,mergeSha:exactSha})){this.completeRun(runId,intentId,exactSha);return Object.freeze({status:"already_merged",mergeSha:exactSha});}
        this.failRun(runId,intentId,"verification_failed");return Object.freeze({status:"merge_failed",code:"verification_failed"});
      }
      if(Date.now()>=deadline)return Object.freeze({status:"merge_in_progress"});
      await sleep(10);
    }
  }

  private refuseRun(runId:string,intentId:string,code:"stale_pr_head"|"pr_identity_mismatch"|"readiness_changed"):void{
    const at=this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare(`UPDATE control_engine_merge_intents SET status='verification_failed',updated_at=? WHERE id=? AND status='authorized'`).run(at,intentId);
      const current=this.db.prepare(`SELECT state,version FROM control_runs WHERE id=?`).get(runId) as {state:string;version:number}|undefined;
      if(current?.state==="awaiting_merge"){
        this.db.prepare(`UPDATE control_runs SET state='failed',version=version+1,terminal_code=?,updated_at=? WHERE id=? AND state='awaiting_merge' AND version=?`).run(code,at,runId,current.version);
        this.db.prepare(`INSERT INTO control_state_events (run_id,from_state,to_state,from_version,to_version,actor,reason,created_at) VALUES (?,'awaiting_merge','failed',?,?,'merge_service',?,?)`).run(runId,current.version,current.version+1,code,at);
        this.db.prepare(`UPDATE control_proposals SET terminal_summary=?,updated_at=? WHERE run_id=?`).run(`Merge refused: ${code}`,at,runId);
      }
      this.db.exec("COMMIT");
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  private failRun(runId:string,intentId:string,code:"provider_failure"|"verification_failed"):void{
    const at=this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare(`UPDATE control_engine_merge_intents SET status=?,updated_at=? WHERE id=? AND status IN ('authorized','merging')`).run(code==="provider_failure"?"merge_failed":"verification_failed",at,intentId);
      const current=this.db.prepare(`SELECT state,version FROM control_runs WHERE id=?`).get(runId) as {state:string;version:number}|undefined;
      if(current?.state==="awaiting_merge"){
        this.db.prepare(`UPDATE control_runs SET state='failed',version=version+1,terminal_code='merge_failed',updated_at=? WHERE id=? AND state='awaiting_merge' AND version=?`).run(at,runId,current.version);
        this.db.prepare(`INSERT INTO control_state_events (run_id,from_state,to_state,from_version,to_version,actor,reason,created_at) VALUES (?,'awaiting_merge','failed',?,?,'merge_service',?,?)`).run(runId,current.version,current.version+1,code,at);
        this.db.prepare(`UPDATE control_proposals SET terminal_summary=?,updated_at=? WHERE run_id=?`).run(`Merge failed: ${code}`,at,runId);
      }
      this.db.exec("COMMIT");
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  private completeRun(runId:string,intentId:string,mergeSha:string):void{
    const at=this.now();this.db.exec("BEGIN IMMEDIATE");
    try{
      const merged=this.db.prepare(`UPDATE control_engine_merge_intents SET status='merged',provider_merge_sha=?,updated_at=? WHERE id=? AND status IN ('authorized','merging')`).run(mergeSha,at,intentId);
      if(merged.changes!==1){this.db.exec("COMMIT");return;}
      const current=this.db.prepare(`SELECT state,version FROM control_runs WHERE id=?`).get(runId) as {state:string;version:number}|undefined;
      if(current?.state==="awaiting_merge"){
        this.db.prepare(`UPDATE control_runs SET state='done',version=version+1,terminal_code=NULL,updated_at=? WHERE id=? AND state='awaiting_merge' AND version=?`).run(at,runId,current.version);
        this.db.prepare(`INSERT INTO control_state_events (run_id,from_state,to_state,from_version,to_version,actor,reason,created_at) VALUES (?,'awaiting_merge','done',?,?,'merge_service','merge_verified',?)`).run(runId,current.version,current.version+1,at);
      }
      this.db.exec("COMMIT");
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }
}
