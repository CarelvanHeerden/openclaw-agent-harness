import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ControlRepository } from "./repository.js";
import { evaluatePrReadiness, type PrReadinessInput, type PrReadinessResult } from "./readiness.js";

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

interface IntentRow { id:string; change_id:string; authorization_id:string; expected_head_sha:string; merge_provider_idempotency:string; status:string; provider_merge_sha:string|null }
interface IntentLease { owner:string; fence:number; attempts:number }
interface PersistedReadiness { input:PrReadinessInput; result:PrReadinessResult }

export class InternalMergeService {
  private recoveryInFlight: Promise<void> | null = null;
  private static readonly INTENT_LEASE_MS = 300_000;
  private static readonly MAX_RECOVERY_ATTEMPTS = 12;
  private static readonly MAX_INSPECTIONS_PER_ATTEMPT = 5;
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
      const rows=this.db.prepare(`SELECT authorization_id FROM control_engine_merge_intents WHERE status IN ('authorized','merging') ORDER BY created_at LIMIT 25`).all() as Array<{authorization_id:string}>;
      await Promise.allSettled(rows.map((row)=>this.merge(row.authorization_id)));
    })().finally(()=>{this.recoveryInFlight=null;});
    return this.recoveryInFlight;
  }

  async merge(id:string):Promise<MergeServiceResult>{
    const intent=this.db.prepare(`SELECT * FROM control_engine_merge_intents WHERE authorization_id=?`).get(id) as unknown as IntentRow|undefined;
    if(!intent)return Object.freeze({status:"refused",code:"merge_attestation_required"});
    if(intent.status==="merged"&&intent.provider_merge_sha&&EXACT_PROVIDER_SHA.test(intent.provider_merge_sha)){
      const raw=this.db.prepare(`SELECT run_id,repository_identity,pr_number FROM control_merge_authorizations WHERE id=?`).get(id) as {run_id:string;repository_identity:string;pr_number:number}|undefined;
      if(raw&&await this.provider.verifyMerged({runId:raw.run_id,repository:raw.repository_identity,prNumber:raw.pr_number,mergeSha:intent.provider_merge_sha}))return Object.freeze({status:"already_merged",mergeSha:intent.provider_merge_sha});
    }
    if(intent.status==="merge_failed")return Object.freeze({status:"merge_failed",code:"provider_failure"});
    if(intent.status==="verification_failed")return Object.freeze({status:"merge_failed",code:"verification_failed"});
    const lease=this.acquireIntentLease(intent.id);
    if(!lease)return this.waitForIntent(intent.id,id);
    try{return await this.mergeLeased(id,intent,lease);}finally{this.releaseIntentLease(intent.id,lease);}
  }

  private async waitForIntent(intentId:string,authorizationId:string):Promise<MergeServiceResult>{
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      const current=this.db.prepare(`SELECT status,provider_merge_sha FROM control_engine_merge_intents WHERE id=?`).get(intentId) as {status:string;provider_merge_sha:string|null}|undefined;
      if(!current)return Object.freeze({status:"refused",code:"merge_attestation_required"});
      if(current.status==="merged"&&current.provider_merge_sha&&EXACT_PROVIDER_SHA.test(current.provider_merge_sha)){
        const auth=this.db.prepare(`SELECT run_id,repository_identity,pr_number FROM control_merge_authorizations WHERE id=?`).get(authorizationId) as {run_id:string;repository_identity:string;pr_number:number}|undefined;
        if(auth&&await this.provider.verifyMerged({runId:auth.run_id,repository:auth.repository_identity,prNumber:auth.pr_number,mergeSha:current.provider_merge_sha}))return Object.freeze({status:"already_merged",mergeSha:current.provider_merge_sha});
      }
      if(current.status==="merge_failed")return Object.freeze({status:"merge_failed",code:"provider_failure"});
      if(current.status==="verification_failed")return Object.freeze({status:"merge_failed",code:"verification_failed"});
      await sleep(10);
    }
    return Object.freeze({status:"merge_in_progress"});
  }

  private async mergeLeased(id:string,intent:IntentRow,lease:IntentLease):Promise<MergeServiceResult>{
    const now=this.now();
    const raw=this.db.prepare(`SELECT * FROM control_merge_authorizations WHERE id=?`).get(id) as Record<string,unknown>|undefined;
    const auth=raw&&this.verifyPersistedAuthorization(raw);
    if(!auth){this.failRun(intent.change_id,intent.id,"verification_failed",lease);return Object.freeze({status:"merge_failed",code:"verification_failed"});}
    if(auth.expiresAt<now&&raw!.consumed_at===null){this.terminalize(auth.runId,intent.id,"verification_failed","authority_expired",lease);return Object.freeze({status:"refused",code:"authorization_expired"});}
    const run=this.repository.getRun(auth.runId);
    if(!run||(run.state!=="awaiting_merge"&&run.state!=="done"))return Object.freeze({status:"refused",code:"merge_attestation_required"});
    const proposal=this.db.prepare(`SELECT published_sha,readiness_digest FROM control_proposals WHERE run_id=?`).get(run.id) as {published_sha:string|null;readiness_digest:string|null}|undefined;
    if(!proposal||proposal.published_sha!==auth.expectedHeadSha||proposal.readiness_digest!==auth.readinessDigest||intent.change_id!==auth.runId||intent.expected_head_sha!==auth.expectedHeadSha){this.refuseRun(run.id,intent.id,"readiness_changed",lease);return Object.freeze({status:"refused",code:"readiness_changed"});}
    const persisted=this.verifyPersistedReadiness(run.id,auth.readinessDigest);
    if(!persisted||!persisted.result.ready||persisted.result.verifiedSha!==auth.expectedHeadSha){this.refuseRun(run.id,intent.id,"readiness_changed",lease);return Object.freeze({status:"refused",code:"readiness_changed"});}
    if(lease.attempts>=InternalMergeService.MAX_RECOVERY_ATTEMPTS){this.failRun(run.id,intent.id,"provider_failure",lease);return Object.freeze({status:"merge_failed",code:"provider_failure"});}
    if(intent.status!=="authorized")return this.reconcileClaimedMerge(auth,intent.id,lease);

    let inspection:MergeInspection;
    try{inspection=await this.provider.inspect({runId:run.id,repository:auth.repository,prNumber:auth.prNumber,readinessDigest:auth.readinessDigest});}
    catch{return Object.freeze({status:"merge_in_progress"});}
    if(inspection.merged){
      const mergeSha=inspection.mergeSha??intent.provider_merge_sha??undefined;
      if(mergeSha&&EXACT_PROVIDER_SHA.test(mergeSha)&&await this.provider.verifyMerged({runId:run.id,repository:auth.repository,prNumber:auth.prNumber,mergeSha})&&this.completeRun(run.id,intent.id,mergeSha,lease))return Object.freeze({status:"already_merged",mergeSha});
      this.failRun(run.id,intent.id,"verification_failed",lease);return Object.freeze({status:"merge_failed",code:"verification_failed"});
    }
    if(!inspection.open||inspection.repository!==auth.repository||inspection.baseRef!==auth.baseRef||inspection.prNumber!==auth.prNumber){this.refuseRun(run.id,intent.id,"pr_identity_mismatch",lease);return Object.freeze({status:"refused",code:"pr_identity_mismatch"});}
    if(inspection.headSha!==auth.expectedHeadSha){this.refuseRun(run.id,intent.id,"stale_pr_head",lease);return Object.freeze({status:"refused",code:"stale_pr_head"});}
    const live=evaluatePrReadiness(inspection.readiness,now);
    if(!live.ready||live.verifiedSha!==auth.expectedHeadSha||!this.verifyPersistedReadiness(run.id,auth.readinessDigest)){this.refuseRun(run.id,intent.id,"readiness_changed",lease);return Object.freeze({status:"refused",code:"readiness_changed"});}

    this.db.exec("BEGIN IMMEDIATE");
    try{
      const claimed=this.db.prepare(`UPDATE control_engine_merge_intents SET status='merging',updated_at=? WHERE id=? AND authorization_id=? AND status='authorized' AND recovery_owner=? AND recovery_fence=? AND recovery_lease_expires_at>?`).run(now,intent.id,id,lease.owner,lease.fence,now);
      if(Number(claimed.changes)!==1)throw new Error("merge_claim_lost");
      const consumed=this.db.prepare(`UPDATE control_merge_authorizations SET consumed_at=? WHERE id=? AND consumed_at IS NULL`).run(now,id);
      if(Number(consumed.changes)!==1)throw new Error("authorization_replayed");
      this.db.exec("COMMIT");
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}if(error instanceof Error&&error.message==="merge_claim_lost")return Object.freeze({status:"merge_in_progress"});return Object.freeze({status:"refused",code:"authorization_replayed"});}

    try{
      const merged=await this.provider.merge({runId:run.id,repository:auth.repository,prNumber:auth.prNumber,expectedHeadSha:auth.expectedHeadSha,idempotencyKey:intent.merge_provider_idempotency});
      if(!EXACT_PROVIDER_SHA.test(merged.mergeSha)){this.failRun(run.id,intent.id,"verification_failed",lease);return Object.freeze({status:"merge_failed",code:"verification_failed"});}
      this.db.prepare(`UPDATE control_engine_merge_intents SET provider_merge_sha=?,updated_at=? WHERE id=? AND status='merging' AND recovery_owner=? AND recovery_fence=?`).run(merged.mergeSha,this.now(),intent.id,lease.owner,lease.fence);
      if(!this.verifyPersistedAuthorizationRow(id)||!this.verifyPersistedReadiness(run.id,auth.readinessDigest)||!await this.provider.verifyMerged({runId:run.id,repository:auth.repository,prNumber:auth.prNumber,mergeSha:merged.mergeSha})){this.failRun(run.id,intent.id,"verification_failed",lease);return Object.freeze({status:"merge_failed",code:"verification_failed"});}
      if(!this.completeRun(run.id,intent.id,merged.mergeSha,lease))return Object.freeze({status:"merge_in_progress"});
      return Object.freeze({status:"merged",mergeSha:merged.mergeSha});
    }catch{return this.reconcileClaimedMerge(auth,intent.id,lease);}
  }

  private async reconcileClaimedMerge(auth:VerifiedMergeAuthorization,intentId:string,lease:IntentLease):Promise<MergeServiceResult>{
    const deadline=Date.now()+5000;
    let inspections=0;
    while(true){
      if(!this.validIntentLease(intentId,lease)||!this.verifyPersistedAuthorizationRow(auth.id)||!this.verifyPersistedReadiness(auth.runId,auth.readinessDigest)){this.failRun(auth.runId,intentId,"verification_failed",lease);return Object.freeze({status:"merge_failed",code:"verification_failed"});}
      const current=this.db.prepare(`SELECT status,provider_merge_sha FROM control_engine_merge_intents WHERE id=?`).get(intentId) as {status:string;provider_merge_sha:string|null}|undefined;
      if(!current)return Object.freeze({status:"refused",code:"merge_attestation_required"});
      if(current.status==="merged"){
        if(current.provider_merge_sha&&EXACT_PROVIDER_SHA.test(current.provider_merge_sha)&&await this.provider.verifyMerged({runId:auth.runId,repository:auth.repository,prNumber:auth.prNumber,mergeSha:current.provider_merge_sha}))return Object.freeze({status:"already_merged",mergeSha:current.provider_merge_sha});
        return Object.freeze({status:"merge_failed",code:"verification_failed"});
      }
      if(current.status==="merge_failed")return Object.freeze({status:"merge_failed",code:"provider_failure"});
      if(current.status==="verification_failed")return Object.freeze({status:"merge_failed",code:"verification_failed"});
      let inspection:MergeInspection|undefined;
      try{inspection=await this.provider.inspect({runId:auth.runId,repository:auth.repository,prNumber:auth.prNumber,readinessDigest:auth.readinessDigest});}catch{}
      inspections++;
      if(inspection?.merged){
        const mergeSha=inspection.mergeSha;
        if(mergeSha&&EXACT_PROVIDER_SHA.test(mergeSha)&&await this.provider.verifyMerged({runId:auth.runId,repository:auth.repository,prNumber:auth.prNumber,mergeSha})&&this.completeRun(auth.runId,intentId,mergeSha,lease))return Object.freeze({status:"already_merged",mergeSha});
        this.failRun(auth.runId,intentId,"verification_failed",lease);return Object.freeze({status:"merge_failed",code:"verification_failed"});
      }
      if(inspections>=InternalMergeService.MAX_INSPECTIONS_PER_ATTEMPT||Date.now()>=deadline)return Object.freeze({status:"merge_in_progress"});
      await sleep(10);
    }
  }

  private verifyPersistedAuthorizationRow(id:string):boolean{const row=this.db.prepare(`SELECT * FROM control_merge_authorizations WHERE id=?`).get(id) as Record<string,unknown>|undefined;return Boolean(row&&this.verifyPersistedAuthorization(row));}
  private verifyPersistedAuthorization(row:Record<string,unknown>):VerifiedMergeAuthorization|null{
    try{
      const unsigned={version:2 as const,id:String(row.id),runId:String(row.run_id),actorIdentity:String(row.actor_identity),conversationIdentity:String(row.conversation_identity),repository:String(row.repository_identity),baseRef:String(row.base_ref),prNumber:Number(row.pr_number),expectedHeadSha:String(row.expected_head_sha),publishedSha:String(row.expected_head_sha),readinessDigest:String(row.readiness_digest),nonce:String(row.nonce),issuedAt:Number(row.issued_at),expiresAt:Number(row.expires_at)};
      if(mergeAuthorizationDigest(unsigned)!==String(row.binding_digest))return null;
      return Object.freeze({...unsigned,bindingDigest:String(row.binding_digest)});
    }catch{return null;}
  }

  private verifyPersistedReadiness(runId:string,contentDigest:string):PersistedReadiness|null{
    const row=this.db.prepare(`SELECT * FROM control_readiness_attestations WHERE run_id=? AND content_digest=?`).get(runId,contentDigest) as Record<string,unknown>|undefined;
    if(!row)return null;
    try{
      const input=JSON.parse(String(row.input_json)) as PrReadinessInput;
      const result=evaluatePrReadiness(input,Number(row.created_at));
      const failures=JSON.parse(String(row.failures_json)) as unknown;
      const expectedFailures=result.ready?[]:result.failures;
      if(result.contentDigest!==String(row.content_digest)||result.policyVersion!==String(row.policy_version)||(result.ready?1:0)!==Number(row.ready)||(result.ready?result.verifiedSha:null)!==(row.verified_sha??null)||stable(failures)!==stable(expectedFailures))return null;
      return {input,result};
    }catch{return null;}
  }

  private acquireIntentLease(intentId:string):IntentLease|null{
    const owner=randomUUID(),now=this.now();
    const changed=this.db.prepare(`UPDATE control_engine_merge_intents SET recovery_owner=?,recovery_fence=recovery_fence+1,recovery_lease_expires_at=?,recovery_attempts=recovery_attempts+1,updated_at=? WHERE id=? AND status IN ('authorized','merging') AND (recovery_owner IS NULL OR recovery_lease_expires_at<=?)`).run(owner,now+InternalMergeService.INTENT_LEASE_MS,now,intentId,now);
    if(Number(changed.changes)!==1)return null;
    const row=this.db.prepare(`SELECT recovery_fence,recovery_attempts FROM control_engine_merge_intents WHERE id=? AND recovery_owner=?`).get(intentId,owner) as {recovery_fence:number;recovery_attempts:number}|undefined;
    return row?{owner,fence:Number(row.recovery_fence),attempts:Number(row.recovery_attempts)}:null;
  }
  private validIntentLease(intentId:string,lease:IntentLease):boolean{const row=this.db.prepare(`SELECT 1 ok FROM control_engine_merge_intents WHERE id=? AND recovery_owner=? AND recovery_fence=? AND recovery_lease_expires_at>?`).get(intentId,lease.owner,lease.fence,this.now());return Boolean(row);}
  private releaseIntentLease(intentId:string,lease:IntentLease):void{this.db.prepare(`UPDATE control_engine_merge_intents SET recovery_owner=NULL,recovery_lease_expires_at=NULL WHERE id=? AND recovery_owner=? AND recovery_fence=?`).run(intentId,lease.owner,lease.fence);}

  private refuseRun(runId:string,intentId:string,code:"stale_pr_head"|"pr_identity_mismatch"|"readiness_changed",lease:IntentLease):boolean{return this.terminalize(runId,intentId,"verification_failed",code,lease);}
  private failRun(runId:string,intentId:string,code:"provider_failure"|"verification_failed",lease?:IntentLease):boolean{return this.terminalize(runId,intentId,code==="provider_failure"?"merge_failed":"verification_failed","merge_failed",lease);}
  private terminalize(runId:string,intentId:string,intentStatus:"merge_failed"|"verification_failed",runCode:string,lease?:IntentLease):boolean{
    const at=this.now();this.db.exec("BEGIN IMMEDIATE");
    try{
      const current=this.db.prepare(`SELECT state,version FROM control_runs WHERE id=?`).get(runId) as {state:string;version:number}|undefined;
      if(current?.state!=="awaiting_merge"){this.db.exec("COMMIT");return false;}
      const params:SQLInputValue[]=[intentStatus,at,intentId];
      let sql=`UPDATE control_engine_merge_intents SET status=?,updated_at=? WHERE id=? AND status IN ('authorized','merging')`;
      if(lease){sql+=` AND recovery_owner=? AND recovery_fence=? AND recovery_lease_expires_at>?`;params.push(lease.owner,lease.fence,at);}
      const intentChanged=this.db.prepare(sql).run(...params);
      if(Number(intentChanged.changes)!==1){this.db.exec("COMMIT");return false;}
      const runChanged=this.db.prepare(`UPDATE control_runs SET state='failed',version=version+1,terminal_code=?,updated_at=? WHERE id=? AND state='awaiting_merge' AND version=?`).run(runCode,at,runId,current.version);
      if(Number(runChanged.changes)!==1)throw new Error("terminal_generation_lost");
      this.db.prepare(`INSERT INTO control_state_events (run_id,from_state,to_state,from_version,to_version,actor,reason,created_at) VALUES (?,'awaiting_merge','failed',?,?,'merge_service',?,?)`).run(runId,current.version,current.version+1,runCode,at);
      this.db.prepare(`UPDATE control_proposals SET terminal_summary=?,updated_at=? WHERE run_id=?`).run(`Merge failed: ${runCode}`,at,runId);
      this.db.exec("COMMIT");return true;
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }

  private completeRun(runId:string,intentId:string,mergeSha:string,lease:IntentLease):boolean{
    const at=this.now();this.db.exec("BEGIN IMMEDIATE");
    try{
      const current=this.db.prepare(`SELECT state,version FROM control_runs WHERE id=?`).get(runId) as {state:string;version:number}|undefined;
      if(current?.state!=="awaiting_merge"){this.db.exec("COMMIT");return current?.state==="done";}
      const merged=this.db.prepare(`UPDATE control_engine_merge_intents SET status='merged',provider_merge_sha=?,updated_at=? WHERE id=? AND status IN ('authorized','merging') AND recovery_owner=? AND recovery_fence=? AND recovery_lease_expires_at>?`).run(mergeSha,at,intentId,lease.owner,lease.fence,at);
      if(Number(merged.changes)!==1){this.db.exec("COMMIT");return false;}
      const runChanged=this.db.prepare(`UPDATE control_runs SET state='done',version=version+1,terminal_code=NULL,updated_at=? WHERE id=? AND state='awaiting_merge' AND version=?`).run(at,runId,current.version);
      if(Number(runChanged.changes)!==1)throw new Error("terminal_generation_lost");
      this.db.prepare(`INSERT INTO control_state_events (run_id,from_state,to_state,from_version,to_version,actor,reason,created_at) VALUES (?,'awaiting_merge','done',?,?,'merge_service','merge_verified',?)`).run(runId,current.version,current.version+1,at);
      this.db.exec("COMMIT");return true;
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }
}
