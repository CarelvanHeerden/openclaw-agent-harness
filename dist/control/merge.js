import { createHash, randomUUID } from "node:crypto";
import { evaluatePrReadiness } from "./readiness.js";
function stable(value) { if (Array.isArray(value))
    return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`; return JSON.stringify(value); }
export function mergeAuthorizationDigest(input) { return createHash("sha256").update(`control-plane-merge/v2:${stable(input)}`).digest("hex"); }
export function createVerifiedMergeAuthorization(input) { const unsigned = Object.freeze({ version: 2, id: input.id ?? randomUUID(), runId: input.runId, actorIdentity: input.actorIdentity, conversationIdentity: input.conversationIdentity, repository: input.repository, baseRef: input.baseRef, prNumber: input.prNumber, expectedHeadSha: input.expectedHeadSha, publishedSha: input.publishedSha, readinessDigest: input.readinessDigest, nonce: input.nonce, issuedAt: input.issuedAt, expiresAt: input.expiresAt }); if (!unsigned.actorIdentity || !unsigned.conversationIdentity || !unsigned.repository || !unsigned.baseRef || !unsigned.nonce || !unsigned.readinessDigest)
    throw new Error("Incomplete merge authorization"); if (!Number.isSafeInteger(unsigned.prNumber) || unsigned.prNumber < 1 || unsigned.expiresAt <= unsigned.issuedAt || unsigned.expectedHeadSha !== unsigned.publishedSha)
    throw new Error("Invalid merge authorization"); return Object.freeze({ ...unsigned, bindingDigest: mergeAuthorizationDigest(unsigned) }); }
export class InternalMergeService {
    db;
    repository;
    provider;
    now;
    constructor(db, repository, provider, now = Date.now) {
        this.db = db;
        this.repository = repository;
        this.provider = provider;
        this.now = now;
    }
    registerAuthorization(a) { const { bindingDigest, ...unsigned } = a; if (mergeAuthorizationDigest(unsigned) !== bindingDigest)
        throw new Error("Invalid merge authorization binding"); this.db.prepare(`INSERT INTO control_merge_authorizations (id,run_id,actor_identity,conversation_identity,repository_identity,base_ref,pr_number,expected_head_sha,binding_digest,nonce,issued_at,expires_at,consumed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(a.id, a.runId, a.actorIdentity, a.conversationIdentity, a.repository, a.baseRef, a.prNumber, a.expectedHeadSha, a.bindingDigest, a.nonce, a.issuedAt, a.expiresAt); }
    async merge(id) {
        const now = this.now();
        const auth = this.db.prepare(`SELECT * FROM control_merge_authorizations WHERE id=?`).get(id);
        if (!auth)
            return Object.freeze({ status: "refused", code: "merge_attestation_required" });
        if (Number(auth.expires_at) < now)
            return Object.freeze({ status: "refused", code: "authorization_expired" });
        const run = this.repository.getRun(String(auth.run_id));
        if (!run || (run.state !== "pr_ready" && run.state !== "awaiting_merge" && run.state !== "done"))
            return Object.freeze({ status: "refused", code: "merge_attestation_required" });
        const repository = String(auth.repository_identity), baseRef = String(auth.base_ref), prNumber = Number(auth.pr_number), expectedHeadSha = String(auth.expected_head_sha);
        const proposal = this.db.prepare(`SELECT published_sha,readiness_digest,generation FROM control_proposals WHERE run_id=?`).get(run.id);
        if (!proposal || proposal.published_sha !== expectedHeadSha || !proposal.readiness_digest)
            return Object.freeze({ status: "refused", code: "readiness_changed" });
        const readinessRow = this.db.prepare(`SELECT input_json,content_digest FROM control_readiness_attestations WHERE run_id=? ORDER BY generation DESC LIMIT 1`).get(run.id);
        if (!readinessRow || readinessRow.content_digest !== proposal.readiness_digest)
            return Object.freeze({ status: "refused", code: "readiness_changed" });
        let inspection;
        try {
            inspection = await this.provider.inspect({ repository, prNumber });
        }
        catch {
            return Object.freeze({ status: "merge_failed", code: "provider_failure" });
        }
        const existing = this.db.prepare(`SELECT id,status,provider_merge_sha,merge_provider_idempotency FROM control_engine_merge_intents WHERE change_id=?`).get(run.id);
        if (existing?.status === "merged" && existing.provider_merge_sha && await this.provider.verifyMerged({ repository, prNumber, mergeSha: existing.provider_merge_sha }))
            return Object.freeze({ status: "already_merged", mergeSha: existing.provider_merge_sha });
        if (inspection.merged) {
            const mergeSha = inspection.mergeSha ?? existing?.provider_merge_sha ?? undefined;
            if (mergeSha && await this.provider.verifyMerged({ repository, prNumber, mergeSha })) {
                this.completeRun(run.id, existing?.id, mergeSha);
                return Object.freeze({ status: "already_merged", mergeSha });
            }
            return Object.freeze({ status: "merge_failed", code: "verification_failed" });
        }
        if (!inspection.open || inspection.repository !== repository || inspection.baseRef !== baseRef || inspection.prNumber !== prNumber)
            return Object.freeze({ status: "refused", code: "pr_identity_mismatch" });
        if (inspection.headSha !== expectedHeadSha)
            return Object.freeze({ status: "refused", code: "stale_pr_head" });
        const live = evaluatePrReadiness(inspection.readiness, now);
        if (!live.ready || live.verifiedSha !== expectedHeadSha)
            return Object.freeze({ status: "refused", code: "readiness_changed" });
        const stored = evaluatePrReadiness(JSON.parse(readinessRow.input_json), live.checkedAt);
        if (!stored.ready || stored.verifiedSha !== expectedHeadSha)
            return Object.freeze({ status: "refused", code: "readiness_changed" });
        const priorConsumed = auth.consumed_at === null ? null : Number(auth.consumed_at);
        const consumed = this.db.prepare(`UPDATE control_merge_authorizations SET consumed_at=COALESCE(consumed_at,?) WHERE id=? AND (consumed_at IS NULL OR consumed_at=?)`).run(now, id, priorConsumed);
        if (Number(consumed.changes) !== 1)
            return Object.freeze({ status: "refused", code: "authorization_replayed" });
        let intent = existing;
        if (!intent) {
            const intentId = randomUUID(), key = `control-merge:${run.id}:${expectedHeadSha}`;
            this.db.prepare(`INSERT INTO control_engine_merge_intents (id,change_id,authorization_id,expected_head_sha,merge_provider_idempotency,status,created_at,updated_at) VALUES (?,?,?,?,?,'authorized',?,?)`).run(intentId, run.id, id, expectedHeadSha, key, now, now);
            intent = { id: intentId, status: "authorized", provider_merge_sha: null, merge_provider_idempotency: key };
        }
        try {
            const merged = await this.provider.merge({ repository, prNumber, expectedHeadSha, idempotencyKey: intent.merge_provider_idempotency });
            this.db.prepare(`UPDATE control_engine_merge_intents SET provider_merge_sha=?,status='authorized',updated_at=? WHERE id=?`).run(merged.mergeSha, this.now(), intent.id);
            if (!await this.provider.verifyMerged({ repository, prNumber, mergeSha: merged.mergeSha })) {
                this.db.prepare(`UPDATE control_engine_merge_intents SET status='verification_failed',updated_at=? WHERE id=?`).run(this.now(), intent.id);
                return Object.freeze({ status: "merge_failed", code: "verification_failed" });
            }
            this.completeRun(run.id, intent.id, merged.mergeSha);
            return Object.freeze({ status: "merged", mergeSha: merged.mergeSha });
        }
        catch {
            this.db.prepare(`UPDATE control_engine_merge_intents SET status='merge_failed',updated_at=? WHERE id=?`).run(this.now(), intent.id);
            return Object.freeze({ status: "merge_failed", code: "provider_failure" });
        }
    }
    completeRun(runId, intentId, mergeSha) { if (intentId)
        this.db.prepare(`UPDATE control_engine_merge_intents SET status='merged',provider_merge_sha=?,updated_at=? WHERE id=?`).run(mergeSha, this.now(), intentId); let current = this.repository.getRun(runId); if (current?.state === "pr_ready")
        current = this.repository.transition({ runId, expectedVersion: current.version, to: "awaiting_merge", actor: "merge_service", reason: "merge_authorized", at: this.now() }); if (current?.state === "awaiting_merge")
        this.repository.transition({ runId, expectedVersion: current.version, to: "done", actor: "merge_service", reason: "merge_verified", at: this.now() }); }
}
//# sourceMappingURL=merge.js.map