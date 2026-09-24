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
  inspect(input:{repository:string;prNumber:number}):Promise<MergeInspection>;
  merge(input:{repository:string;prNumber:number;expectedHeadSha:string;idempotencyKey:string}):Promise<{mergeSha:string}>;
  verifyMerged(input:{repository:string;prNumber:number;mergeSha:string}):Promise<boolean>;
}
export type MergeServiceResult = Readonly<
 | {status:"merged";mergeSha:string}
 | {status:"already_merged";mergeSha?:string}
 | {status:"refused";code:"merge_attestation_required"|"stale_pr_head"|"pr_identity_mismatch"|"readiness_changed"|"authorization_expired"|"authorization_replayed"}
 | {status:"merge_failed";code:"provider_failure"|"verification_failed"}>;
function stable(value:unknown):string{if(Array.isArray(value))return`[${value.map(stable).join(",")}]`;if(value&&typeof value==="object")return`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;return JSON.stringify(value);}
export function mergeAuthorizationDigest(input:Omit<VerifiedMergeAuthorization,"bindingDigest">):string{return createHash("sha256").update(`control-plane-merge/v2:${stable(input)}`).digest("hex");}
export function createVerifiedMergeAuthorization(input:Omit<VerifiedMergeAuthorization,"version"|"id"|"bindingDigest">&{id?:string}):VerifiedMergeAuthorization{const unsigned=Object.freeze({version:2 as const,id:input.id??randomUUID(),runId:input.runId,actorIdentity:input.actorIdentity,conversationIdentity:input.conversationIdentity,repository:input.repository,baseRef:input.baseRef,prNumber:input.prNumber,expectedHeadSha:input.expectedHeadSha,publishedSha:input.publishedSha,readinessDigest:input.readinessDigest,nonce:input.nonce,issuedAt:input.issuedAt,expiresAt:input.expiresAt});if(!unsigned.actorIdentity||!unsigned.conversationIdentity||!unsigned.repository||!unsigned.baseRef||!unsigned.nonce||!unsigned.readinessDigest)throw new Error("Incomplete merge authorization");if(!Number.isSafeInteger(unsigned.prNumber)||unsigned.prNumber<1||unsigned.expiresAt<=unsigned.issuedAt||unsigned.expectedHeadSha!==unsigned.publishedSha)throw new Error("Invalid merge authorization");return Object.freeze({...unsigned,bindingDigest:mergeAuthorizationDigest(unsigned)});}

export class InternalMergeService {
  constructor(private readonly db:DatabaseSync,private readonly repository:ControlRepository,private readonly provider:MergeProvider,private readonly now:()=>number=Date.now){}

  registerAuthorizationAndIntent(a:VerifiedMergeAuthorization, now=this.now()): string {
    const {bindingDigest,...unsigned}=a;
    if(mergeAuthorizationDigest(unsigned)!==bindingDigest)throw new Error("Invalid merge authorization binding");
    const intentId=randomUUID(), key=`control-merge:${a.runId}:${a.expectedHeadSha}`;
    this.db.prepare(`INSERT INTO control_merge_authorizations (id,run_id,actor_identity,conversation_identity,repository_identity,base_ref,pr_number,expected_head_sha,binding_digest,nonce,issued_at,expires_at,consumed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(a.id,a.runId,a.actorIdentity,a.conversationIdentity,a.repository,a.baseRef,a.prNumber,a.expectedHeadSha,a.bindingDigest,a.nonce,a.issuedAt,a.expiresAt);
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
    const rows=this.db.prepare(`SELECT authorization_id FROM control_engine_merge_intents WHERE status IN ('authorized','merging','merge_failed','verification_failed') ORDER BY created_at`).all() as Array<{authorization_id:string}>;
    for(const row of rows) await this.merge(row.authorization_id).catch(()=>undefined);
  }

  async merge(id:string):Promise<MergeServiceResult>{
    const now=this.now();
    const auth=this.db.prepare(`SELECT * FROM control_merge_authorizations WHERE id=?`).get(id) as Record<string,unknown>|undefined;
    if(!auth)return Object.freeze({status:"refused",code:"merge_attestation_required"});
    if(Number(auth.expires_at)<now&&auth.consumed_at===null)return Object.freeze({status:"refused",code:"authorization_expired"});
    const run=this.repository.getRun(String(auth.run_id));
    if(!run||(run.state!=="awaiting_merge"&&run.state!=="done"&&!(run.state==="failed"&&run.terminalCode==="merge_failed")))return Object.freeze({status:"refused",code:"merge_attestation_required"});
    const repository=String(auth.repository_identity),baseRef=String(auth.base_ref),prNumber=Number(auth.pr_number),expectedHeadSha=String(auth.expected_head_sha);
    const proposal=this.db.prepare(`SELECT published_sha,readiness_digest FROM control_proposals WHERE run_id=?`).get(run.id) as {published_sha:string|null;readiness_digest:string|null}|undefined;
    if(!proposal||proposal.published_sha!==expectedHeadSha||!proposal.readiness_digest)return Object.freeze({status:"refused",code:"readiness_changed"});
    const readinessRow=this.db.prepare(`SELECT input_json,content_digest FROM control_readiness_attestations WHERE run_id=? ORDER BY generation DESC LIMIT 1`).get(run.id) as {input_json:string;content_digest:string}|undefined;
    if(!readinessRow||readinessRow.content_digest!==proposal.readiness_digest)return Object.freeze({status:"refused",code:"readiness_changed"});
    const intent=this.db.prepare(`SELECT id,status,provider_merge_sha,merge_provider_idempotency,authorization_id FROM control_engine_merge_intents WHERE change_id=?`).get(run.id) as {id:string;status:string;provider_merge_sha:string|null;merge_provider_idempotency:string;authorization_id:string}|undefined;
    if(!intent||intent.authorization_id!==id)return Object.freeze({status:"refused",code:"merge_attestation_required"});
    if(intent.status==="merged"&&intent.provider_merge_sha&&await this.provider.verifyMerged({repository,prNumber,mergeSha:intent.provider_merge_sha})) return Object.freeze({status:"already_merged",mergeSha:intent.provider_merge_sha});
    let inspection:MergeInspection;try{inspection=await this.provider.inspect({repository,prNumber});}catch{this.failRun(run.id,intent.id,"provider_failure");return Object.freeze({status:"merge_failed",code:"provider_failure"});}
    if(inspection.merged){const mergeSha=inspection.mergeSha??intent.provider_merge_sha??undefined;if(mergeSha&&await this.provider.verifyMerged({repository,prNumber,mergeSha})){this.completeRun(run.id,intent.id,mergeSha);return Object.freeze({status:"already_merged",mergeSha});}this.failRun(run.id,intent.id,"verification_failed");return Object.freeze({status:"merge_failed",code:"verification_failed"});}
    if(!inspection.open||inspection.repository!==repository||inspection.baseRef!==baseRef||inspection.prNumber!==prNumber)return Object.freeze({status:"refused",code:"pr_identity_mismatch"});
    if(inspection.headSha!==expectedHeadSha)return Object.freeze({status:"refused",code:"stale_pr_head"});
    const live=evaluatePrReadiness(inspection.readiness,now);if(!live.ready||live.verifiedSha!==expectedHeadSha)return Object.freeze({status:"refused",code:"readiness_changed"});
    const stored=evaluatePrReadiness(JSON.parse(readinessRow.input_json) as PrReadinessInput,now);if(!stored.ready||stored.verifiedSha!==expectedHeadSha)return Object.freeze({status:"refused",code:"readiness_changed"});
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current=this.db.prepare(`SELECT consumed_at FROM control_merge_authorizations WHERE id=?`).get(id) as {consumed_at:number|null}|undefined;
      const currentIntent=this.db.prepare(`SELECT status FROM control_engine_merge_intents WHERE id=? AND authorization_id=?`).get(intent.id,id) as {status:string}|undefined;
      if(!current||!currentIntent||!["authorized","merging","merge_failed","verification_failed"].includes(currentIntent.status))throw new Error("authorization_replayed");
      if(current.consumed_at===null)this.db.prepare(`UPDATE control_merge_authorizations SET consumed_at=? WHERE id=? AND consumed_at IS NULL`).run(now,id);
      this.db.prepare(`UPDATE control_engine_merge_intents SET status='merging',updated_at=? WHERE id=?`).run(now,intent.id);
      this.db.exec("COMMIT");
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}return Object.freeze({status:"refused",code:"authorization_replayed"});}
    try{
      const merged=await this.provider.merge({repository,prNumber,expectedHeadSha,idempotencyKey:intent.merge_provider_idempotency});
      this.db.prepare(`UPDATE control_engine_merge_intents SET provider_merge_sha=?,updated_at=? WHERE id=?`).run(merged.mergeSha,this.now(),intent.id);
      if(!await this.provider.verifyMerged({repository,prNumber,mergeSha:merged.mergeSha})){this.failRun(run.id,intent.id,"verification_failed");return Object.freeze({status:"merge_failed",code:"verification_failed"});}
      this.completeRun(run.id,intent.id,merged.mergeSha);return Object.freeze({status:"merged",mergeSha:merged.mergeSha});
    }catch{this.failRun(run.id,intent.id,"provider_failure");return Object.freeze({status:"merge_failed",code:"provider_failure"});}
  }

  private failRun(runId:string,intentId:string,code:"provider_failure"|"verification_failed"):void{
    const at=this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare(`UPDATE control_engine_merge_intents SET status=?,updated_at=? WHERE id=?`).run(code==="provider_failure"?"merge_failed":"verification_failed",at,intentId);
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
      this.db.prepare(`UPDATE control_engine_merge_intents SET status='merged',provider_merge_sha=?,updated_at=? WHERE id=?`).run(mergeSha,at,intentId);
      const current=this.db.prepare(`SELECT state,version,terminal_code FROM control_runs WHERE id=?`).get(runId) as {state:string;version:number;terminal_code:string|null}|undefined;
      if(current?.state==="awaiting_merge"||(current?.state==="failed"&&current.terminal_code==="merge_failed")){
        this.db.prepare(`UPDATE control_runs SET state='done',version=version+1,terminal_code=NULL,updated_at=? WHERE id=? AND state=? AND version=?`).run(at,runId,current.state,current.version);
        this.db.prepare(`INSERT INTO control_state_events (run_id,from_state,to_state,from_version,to_version,actor,reason,created_at) VALUES (?,?,'done',?,?,'merge_service','merge_verified',?)`).run(runId,current.state,current.version,current.version+1,at);
      }
      this.db.exec("COMMIT");
    }catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }
}
