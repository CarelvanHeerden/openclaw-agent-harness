import { randomUUID } from "node:crypto";
import { authorityEnvelopeDigest, createAuthorityEnvelope } from "./authority.js";
import { assertControlTransition, ControlCasConflictError } from "./state-machine.js";
function mapRun(row) {
    const authority = createAuthorityEnvelope(JSON.parse(row.authority_envelope_json));
    return Object.freeze({
        id: row.id,
        state: row.state,
        version: row.version,
        requesterId: row.requester_id,
        conversationId: row.conversation_id,
        repository: row.repository,
        baseRef: row.base_ref,
        briefDigest: row.brief_digest,
        policyDigest: row.policy_digest,
        authorityEnvelope: authority,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.terminal_code ? { terminalCode: row.terminal_code } : {}),
        ...(row.pull_request_url ? { pullRequestUrl: row.pull_request_url } : {}),
    });
}
export class ControlRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    createRun(input) {
        const authority = createAuthorityEnvelope(input.authority);
        const id = input.id ?? randomUUID();
        const at = input.createdAt ?? Date.now();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db.prepare(`INSERT INTO control_runs (
        id, state, version, requester_id, conversation_id, repository, base_ref,
        brief_digest, policy_digest, authority_envelope_json, created_at, updated_at
      ) VALUES (?, 'draft', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, authority.requesterId, authority.conversationId, authority.repository, authority.baseRef, authority.briefDigest, authority.policyDigest, JSON.stringify(authority), at, at);
            this.db.prepare(`INSERT INTO control_state_events
        (run_id, from_state, to_state, from_version, to_version, actor, reason, created_at)
        VALUES (?, NULL, 'draft', NULL, 0, 'system', 'created', ?)`).run(id, at);
            this.db.exec("COMMIT");
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch { /* preserve original error */ }
            throw error;
        }
        return this.getRun(id);
    }
    getRun(runId) {
        const row = this.db.prepare("SELECT * FROM control_runs WHERE id = ?").get(runId);
        return row ? mapRun(row) : null;
    }
    transition(input) {
        const at = input.at ?? Date.now();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.db.prepare("SELECT state, version FROM control_runs WHERE id = ?").get(input.runId);
            if (!current || current.version !== input.expectedVersion)
                throw new ControlCasConflictError(input.runId, input.expectedVersion);
            assertControlTransition(current.state, input.to);
            const result = this.db.prepare(`UPDATE control_runs
        SET state = ?, version = version + 1, updated_at = ?,
            terminal_code = COALESCE(?, terminal_code),
            pull_request_url = COALESCE(?, pull_request_url)
        WHERE id = ? AND version = ? AND state = ?`)
                .run(input.to, at, input.terminalCode ?? null, input.pullRequestUrl ?? null, input.runId, input.expectedVersion, current.state);
            if (Number(result.changes) !== 1)
                throw new ControlCasConflictError(input.runId, input.expectedVersion);
            this.db.prepare(`INSERT INTO control_state_events
        (run_id, from_state, to_state, from_version, to_version, actor, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(input.runId, current.state, input.to, current.version, current.version + 1, input.actor, input.reason, at);
            this.db.exec("COMMIT");
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch { /* preserve original error */ }
            throw error;
        }
        return this.getRun(input.runId);
    }
    listStateEvents(runId) {
        const rows = this.db.prepare(`SELECT id, run_id, from_state, to_state, from_version, to_version, actor, reason, created_at
      FROM control_state_events WHERE run_id = ? ORDER BY id`).all(runId);
        return Object.freeze(rows.map((row) => Object.freeze({
            id: Number(row.id), runId: String(row.run_id), fromState: row.from_state,
            toState: row.to_state, fromVersion: row.from_version === null ? null : Number(row.from_version),
            toVersion: Number(row.to_version), actor: String(row.actor), reason: String(row.reason), createdAt: Number(row.created_at),
        })));
    }
    consume(nonce, envelopeDigest, consumedAt) {
        try {
            this.db.prepare(`INSERT INTO automation_decisions
        (run_id, envelope_nonce, envelope_digest, outcome, reason, created_at)
        VALUES (NULL, ?, ?, 'approve', 'in_envelope', ?)`)
                .run(nonce, envelopeDigest, consumedAt);
            return true;
        }
        catch (error) {
            if (/UNIQUE constraint failed: automation_decisions\.envelope_nonce/i.test(String(error)))
                return false;
            throw error;
        }
    }
    recordDecision(runId, envelope, decision, at = Date.now()) {
        this.db.prepare(`INSERT INTO automation_decisions
      (run_id, envelope_nonce, envelope_digest, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(runId, envelope.nonce, authorityEnvelopeDigest(envelope), decision.outcome, decision.reason, at);
    }
    acquireLease(runId, ownerId, ttlMs, now = Date.now(), authorityHash) {
        if (!ownerId || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
            throw new Error("Lease owner and positive integer TTL are required");
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.db.prepare("SELECT owner_id, fence, acquired_at, expires_at, authority_hash FROM run_leases WHERE run_id = ?").get(runId);
            if (current && current.owner_id !== ownerId && current.expires_at > now) {
                this.db.exec("COMMIT");
                return null;
            }
            const fence = (current?.fence ?? 0) + 1;
            const expiresAt = now + ttlMs;
            this.db.prepare(`INSERT INTO run_leases (run_id, owner_id, fence, acquired_at, expires_at, authority_hash)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET owner_id=excluded.owner_id, fence=excluded.fence,
          acquired_at=excluded.acquired_at, expires_at=excluded.expires_at,
          authority_hash=excluded.authority_hash`)
                .run(runId, ownerId, fence, now, expiresAt, authorityHash ?? current?.authority_hash ?? null);
            this.db.exec("COMMIT");
            return Object.freeze({ runId, ownerId, fence, acquiredAt: now, expiresAt, ...(authorityHash ? { authorityHash } : {}) });
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch { /* preserve original error */ }
            throw error;
        }
    }
    renewLease(runId, ownerId, fence, ttlMs, now = Date.now()) {
        const result = this.db.prepare(`UPDATE run_leases SET expires_at = ?
      WHERE run_id = ? AND owner_id = ? AND fence = ? AND expires_at > ?`)
            .run(now + ttlMs, runId, ownerId, fence, now);
        return Number(result.changes) === 1;
    }
    releaseLease(runId, ownerId, fence, now = Date.now()) {
        const result = this.db.prepare(`UPDATE run_leases SET owner_id = NULL, expires_at = ?
      WHERE run_id = ? AND owner_id = ? AND fence = ?`)
            .run(now, runId, ownerId, fence);
        return Number(result.changes) === 1;
    }
    validateLease(lease, now = Date.now()) {
        const row = this.db.prepare(`SELECT owner_id, fence, expires_at, authority_hash FROM run_leases WHERE run_id = ?`).get(lease.runId);
        return Boolean(row && row.owner_id === lease.ownerId && row.fence === lease.fence && row.expires_at > now &&
            (!lease.authorityHash || row.authority_hash === lease.authorityHash));
    }
    transitionFenced(input) {
        const at = input.at ?? Date.now();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const lease = this.db.prepare(`SELECT owner_id, fence, expires_at, authority_hash FROM run_leases WHERE run_id = ?`).get(input.runId);
            if (!lease || lease.owner_id !== input.lease.ownerId || lease.fence !== input.lease.fence || lease.expires_at <= at ||
                (input.lease.authorityHash && lease.authority_hash !== input.lease.authorityHash)) {
                throw new Error(`stale_write:${input.runId}`);
            }
            const current = this.db.prepare("SELECT state, version FROM control_runs WHERE id = ?").get(input.runId);
            if (!current || current.version !== input.expectedVersion)
                throw new ControlCasConflictError(input.runId, input.expectedVersion);
            assertControlTransition(current.state, input.to);
            const changed = this.db.prepare(`UPDATE control_runs
        SET state = ?, version = version + 1, updated_at = ?, terminal_code = COALESCE(?, terminal_code),
            pull_request_url = COALESCE(?, pull_request_url)
        WHERE id = ? AND version = ? AND state = ?
          AND EXISTS (SELECT 1 FROM run_leases WHERE run_id = ? AND owner_id = ? AND fence = ?
            AND expires_at > ? AND (? IS NULL OR authority_hash = ?))`)
                .run(input.to, at, input.terminalCode ?? null, input.pullRequestUrl ?? null, input.runId, input.expectedVersion, current.state, input.runId, input.lease.ownerId, input.lease.fence, at, input.lease.authorityHash ?? null, input.lease.authorityHash ?? null);
            if (Number(changed.changes) !== 1)
                throw new Error(`stale_write:${input.runId}`);
            this.db.prepare(`INSERT INTO control_state_events
        (run_id, from_state, to_state, from_version, to_version, actor, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(input.runId, current.state, input.to, current.version, current.version + 1, input.actor, input.reason, at);
            this.db.exec("COMMIT");
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch { /* preserve original error */ }
            throw error;
        }
        return this.getRun(input.runId);
    }
    recordEngineDecision(runId, lease, decision, at = Date.now()) {
        const code = decision.outcome === "continue" ? decision.kind : decision.code;
        const detail = decision.outcome === "continue" ? decision.auditCode : decision.reason;
        const result = this.db.prepare(`INSERT INTO control_engine_decisions
      (run_id, lease_fence, outcome, decision_code, detail, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM run_leases WHERE run_id = ? AND owner_id = ? AND fence = ? AND expires_at > ?
          AND (? IS NULL OR authority_hash = ?)
      )`).run(runId, lease.fence, decision.outcome, code, detail, at, runId, lease.ownerId, lease.fence, at, lease.authorityHash ?? null, lease.authorityHash ?? null);
        if (Number(result.changes) !== 1)
            throw new Error(`stale_write:${runId}`);
    }
    recordReadiness(runId, lease, result, at = Date.now()) {
        const changed = this.db.prepare(`INSERT INTO control_readiness_results
      (run_id, lease_fence, ready, verified_sha, failures_json, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM run_leases WHERE run_id = ? AND owner_id = ? AND fence = ? AND expires_at > ?
          AND (? IS NULL OR authority_hash = ?)
      )`).run(runId, lease.fence, result.ready ? 1 : 0, result.ready ? result.verifiedSha : null, JSON.stringify(result.ready ? [] : result.failures), at, runId, lease.ownerId, lease.fence, at, lease.authorityHash ?? null, lease.authorityHash ?? null);
        if (Number(changed.changes) !== 1)
            throw new Error(`stale_write:${runId}`);
    }
    writeVerifiedCheckpoint(runId, lease, checkpointSha, payloadDigest, at = Date.now()) {
        if (!lease.authorityHash)
            throw new Error(`missing_authority_hash:${runId}`);
        if (!/^[a-f0-9]{40,64}$/.test(checkpointSha) || !/^[a-f0-9]{64}$/.test(payloadDigest)) {
            throw new Error("Invalid verified checkpoint digest");
        }
        const changed = this.db.prepare(`INSERT INTO control_verified_checkpoints
      (run_id, lease_fence, authority_hash, checkpoint_sha, payload_digest, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM run_leases WHERE run_id = ? AND owner_id = ? AND fence = ? AND expires_at > ? AND authority_hash = ?
      )`).run(runId, lease.fence, lease.authorityHash, checkpointSha, payloadDigest, at, runId, lease.ownerId, lease.fence, at, lease.authorityHash);
        if (Number(changed.changes) !== 1)
            throw new Error(`stale_write:${runId}`);
    }
}
//# sourceMappingURL=repository.js.map