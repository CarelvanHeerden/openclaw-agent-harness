import { createHash, randomUUID } from "node:crypto";
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
    return JSON.stringify(value);
}
export function mergeAuthorizationDigest(input) {
    return createHash("sha256").update(`control-plane-merge/v1:${stable(input)}`).digest("hex");
}
export function createVerifiedMergeAuthorization(input) {
    const unsigned = Object.freeze({
        version: 1,
        id: input.id ?? randomUUID(),
        runId: input.runId,
        actorIdentity: input.actorIdentity,
        conversationIdentity: input.conversationIdentity,
        repository: input.repository,
        baseRef: input.baseRef,
        prNumber: input.prNumber,
        expectedHeadSha: input.expectedHeadSha,
        nonce: input.nonce,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
    });
    if (!unsigned.actorIdentity || !unsigned.conversationIdentity || !unsigned.repository || !unsigned.baseRef || !unsigned.nonce)
        throw new Error("Incomplete merge authorization");
    if (!Number.isSafeInteger(unsigned.prNumber) || unsigned.prNumber < 1 || unsigned.expiresAt <= unsigned.issuedAt)
        throw new Error("Invalid merge authorization");
    return Object.freeze({ ...unsigned, bindingDigest: mergeAuthorizationDigest(unsigned) });
}
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
    registerAuthorization(authorization) {
        const { bindingDigest, ...unsigned } = authorization;
        if (mergeAuthorizationDigest(unsigned) !== bindingDigest)
            throw new Error("Invalid merge authorization binding");
        this.db.prepare(`INSERT INTO control_merge_authorizations
      (id, run_id, actor_identity, conversation_identity, repository_identity, base_ref, pr_number,
       expected_head_sha, binding_digest, nonce, issued_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
            .run(authorization.id, authorization.runId, authorization.actorIdentity, authorization.conversationIdentity, authorization.repository, authorization.baseRef, authorization.prNumber, authorization.expectedHeadSha, authorization.bindingDigest, authorization.nonce, authorization.issuedAt, authorization.expiresAt);
    }
    async merge(authorizationId) {
        const now = this.now();
        const auth = this.db.prepare(`SELECT * FROM control_merge_authorizations WHERE id = ?`).get(authorizationId);
        if (!auth)
            return Object.freeze({ status: "refused", code: "merge_attestation_required" });
        if (auth.consumed_at !== null)
            return Object.freeze({ status: "refused", code: "authorization_replayed" });
        if (Number(auth.expires_at) < now)
            return Object.freeze({ status: "refused", code: "authorization_expired" });
        const run = this.repository.getRun(String(auth.run_id));
        if (!run || (run.state !== "pr_ready" && run.state !== "awaiting_merge"))
            return Object.freeze({ status: "refused", code: "merge_attestation_required" });
        const consumed = this.db.prepare(`UPDATE control_merge_authorizations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?`)
            .run(now, authorizationId, now);
        if (Number(consumed.changes) !== 1)
            return Object.freeze({ status: "refused", code: "authorization_replayed" });
        const repository = String(auth.repository_identity);
        const baseRef = String(auth.base_ref);
        const prNumber = Number(auth.pr_number);
        const expectedHeadSha = String(auth.expected_head_sha);
        const inspection = await this.provider.inspect({ repository, prNumber });
        if (inspection.merged)
            return Object.freeze({ status: "already_merged" });
        if (!inspection.open || inspection.repository !== repository || inspection.baseRef !== baseRef || inspection.prNumber !== prNumber) {
            return Object.freeze({ status: "refused", code: "pr_identity_mismatch" });
        }
        if (inspection.headSha !== expectedHeadSha)
            return Object.freeze({ status: "refused", code: "stale_pr_head" });
        if (inspection.finalVerdict !== "pass")
            return Object.freeze({ status: "refused", code: "review_not_passed" });
        if (inspection.blockingFindings !== 0)
            return Object.freeze({ status: "refused", code: "blocking_findings" });
        if (!inspection.requiredCi.registered || inspection.requiredCi.status !== "success" || inspection.requiredCi.sha !== expectedHeadSha) {
            return Object.freeze({ status: "refused", code: "required_ci_not_green" });
        }
        const intentId = randomUUID();
        const idempotencyKey = `control-merge:${run.id}:${expectedHeadSha}`;
        try {
            this.db.prepare(`INSERT INTO control_engine_merge_intents
        (id, change_id, authorization_id, expected_head_sha, merge_provider_idempotency, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'authorized', ?, ?)`)
                .run(intentId, run.id, authorizationId, expectedHeadSha, idempotencyKey, now, now);
        }
        catch (error) {
            if (/UNIQUE constraint failed: control_engine_merge_intents\.change_id/i.test(String(error))) {
                const prior = this.db.prepare(`SELECT status, provider_merge_sha FROM control_engine_merge_intents WHERE change_id = ?`).get(run.id);
                return Object.freeze({ status: "already_merged", ...(prior.provider_merge_sha ? { mergeSha: prior.provider_merge_sha } : {}) });
            }
            throw error;
        }
        try {
            const merged = await this.provider.merge({ repository, prNumber, expectedHeadSha, idempotencyKey });
            const verified = await this.provider.verifyMerged({ repository, prNumber, mergeSha: merged.mergeSha });
            if (!verified) {
                this.db.prepare(`UPDATE control_engine_merge_intents SET status='verification_failed', provider_merge_sha=?, updated_at=? WHERE id=?`)
                    .run(merged.mergeSha, this.now(), intentId);
                return Object.freeze({ status: "merge_failed", code: "verification_failed" });
            }
            this.db.prepare(`UPDATE control_engine_merge_intents SET status='merged', provider_merge_sha=?, updated_at=? WHERE id=?`)
                .run(merged.mergeSha, this.now(), intentId);
            const current = this.repository.getRun(run.id);
            if (current?.state === "pr_ready") {
                const awaiting = this.repository.transition({ runId: run.id, expectedVersion: current.version, to: "awaiting_merge", actor: "merge_service", reason: "merge_authorized", at: this.now() });
                this.repository.transition({ runId: run.id, expectedVersion: awaiting.version, to: "done", actor: "merge_service", reason: "merge_verified", at: this.now() });
            }
            else if (current?.state === "awaiting_merge") {
                this.repository.transition({ runId: run.id, expectedVersion: current.version, to: "done", actor: "merge_service", reason: "merge_verified", at: this.now() });
            }
            return Object.freeze({ status: "merged", mergeSha: merged.mergeSha });
        }
        catch {
            this.db.prepare(`UPDATE control_engine_merge_intents SET status='merge_failed', updated_at=? WHERE id=?`).run(this.now(), intentId);
            return Object.freeze({ status: "merge_failed", code: "provider_failure" });
        }
    }
}
//# sourceMappingURL=merge.js.map