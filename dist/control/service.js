import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createAuthorityEnvelope } from "./authority.js";
import { createVerifiedMergeAuthorization } from "./merge.js";
import { evaluatePrReadiness } from "./readiness.js";
export const CONTROL_PLANE_CONTRACT_VERSION = "control-plane-contract/v2";
export const CONFIRM_DOMAIN = "control-plane-confirm/v2";
export const MERGE_DOMAIN = "control-plane-merge/v2";
function stable(value) { if (Array.isArray(value))
    return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`; return JSON.stringify(value); }
export function controlDigest(domain, binding) { return createHash("sha256").update(`${domain}\n${stable(binding)}`).digest("hex"); }
function digest(value) { return createHash("sha256").update(stable(value)).digest("hex"); }
function contextIdentity(context) { const actor = (context.requesterSenderId ?? "").trim(); const conversation = (context.conversationId ?? "").trim(); if (!actor)
    throw new ControlError("trusted_actor_required", "An authenticated requester is required."); if (!conversation)
    throw new ControlError("trusted_conversation_required", "An authenticated conversation is required."); return { actor, conversation }; }
function parseList(value) { try {
    return JSON.parse(value);
}
catch {
    return [];
} }
export class ControlError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ControlError";
    }
}
export class ControlPlaneService {
    deps;
    now;
    ttl;
    dispatchLeaseMs;
    recoveryTimer;
    constructor(deps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.ttl = deps.confirmationTtlMs ?? 900_000;
        this.dispatchLeaseMs = deps.dispatchLeaseMs ?? 300_000;
        queueMicrotask(() => void this.recoverDispatches());
        this.recoveryTimer = setInterval(() => void this.recoverDispatches(), Math.max(10, Math.floor(this.dispatchLeaseMs / 3)));
        this.recoveryTimer.unref?.();
    }
    dispose() { clearInterval(this.recoveryTimer); }
    async prepare(input, context) {
        const { actor, conversation } = contextIdentity(context);
        const request = input.request?.trim();
        const repository = input.repository?.trim().toLowerCase();
        if (!request || request.length > 100_000)
            throw new ControlError("invalid_request", "A bounded change request is required.");
        if (!/^[^/\s]+\/[^/\s]+$/.test(repository))
            throw new ControlError("invalid_repository", "Repository must be owner/name.");
        const resolved = await this.deps.resolveRepository({ repository, baseRef: input.baseRef, actorIdentity: actor });
        const crystallised = await this.deps.crystallise(request);
        if (crystallised.kind === "reject")
            throw new ControlError("request_rejected", crystallised.reason || "The request cannot be prepared.");
        const assumptions = [];
        let confirmable = crystallised.kind === "brief";
        const brief = crystallised.kind === "brief" ? structuredClone(crystallised.brief) : { title: "Unresolved change request", motivation: request.slice(0, 500), acceptanceCriteria: ["No implementation may start until the unresolved decision is supplied."], filesLikelyTouched: [], outOfScope: ["All implementation"], repoHint: resolved.repositoryIdentity, riskLevel: "medium" };
        if (!confirmable)
            assumptions.push("The request has an unresolved product decision and must be prepared again.");
        const scope = [...new Set((input.scope?.filter(Boolean).length ? input.scope : brief.filesLikelyTouched).filter(Boolean))];
        if (scope.length === 0)
            scope.push("**/*");
        const excluded = [...new Set((input.excludedScope ?? brief.outOfScope).filter(Boolean))];
        if ([...scope, ...excluded].some(p => p.startsWith("/") || p.includes("\\") || p.split("/").includes("..")))
            throw new ControlError("path_violation", "Scope paths must be repository-relative.");
        const maxBudget = this.deps.maximumBudgetUsd ?? 50;
        const budget = Math.min(input.budgetUsd ?? Math.min(12, maxBudget), maxBudget);
        if (!Number.isFinite(budget) || budget <= 0)
            throw new ControlError("invalid_budget", "The budget must be positive.");
        const maxTime = this.deps.maximumTimeSeconds ?? 14_400;
        const time = Math.min(input.timeLimitSeconds ?? 3600, maxTime);
        if (!Number.isSafeInteger(time) || time <= 0)
            throw new ControlError("invalid_time_limit", "The time limit must be positive.");
        const now = this.now();
        const id = `chg_${randomBytes(18).toString("base64url")}`;
        const briefDigest = digest(brief);
        const credentialRouteDigest = digest(resolved.credentialRoute);
        const cycles = Math.max(1, Math.floor(this.deps.maximumCycles ?? 3));
        const retries = Math.max(0, Math.floor(this.deps.maximumRetries ?? 10));
        const authority = createAuthorityEnvelope({ version: 1, requesterId: actor, conversationId: conversation, repository: resolved.repositoryIdentity, baseRef: resolved.baseRef, briefDigest, policyDigest: resolved.policyDigest, scope: { paths: scope }, allowedActions: ["implement", "retry", "repair", "test", "commit", "push_feature_branch", "open_pull_request", "update_pull_request", "deploy"], limits: { budgetUsd: budget, activeTimeMs: time * 1000, cycles, retries }, issuedAt: now, expiresAt: now + Math.max(this.ttl, time * 1000), nonce: randomBytes(18).toString("base64url") });
        let run = this.deps.repository.createRun({ id, authority, createdAt: now });
        run = this.deps.repository.transition({ runId: id, expectedVersion: run.version, to: "awaiting_confirmation", actor: "control_service", reason: "prepared", at: now });
        this.deps.db.prepare(`INSERT INTO control_proposals (run_id,generation,confirmable,base_revision,brief_json,scope_json,excluded_scope_json,credential_route_digest,security_class,assumptions_json,proposal_expires_at,policy_version,minimum_runtime_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 1, confirmable ? 1 : 0, resolved.baseRevision, JSON.stringify(brief), JSON.stringify(scope), JSON.stringify(excluded), credentialRouteDigest, resolved.securityClass, JSON.stringify(assumptions), now + this.ttl, CONTROL_PLANE_CONTRACT_VERSION, this.deps.minimumRuntimeVersion ?? "2.0.0-rc.13", now, now);
        return { ok: true, changeId: id, state: "prepared", confirmable, summary: brief.title, repository: resolved.repositoryIdentity, baseRef: resolved.baseRef, baseRevision: resolved.baseRevision, scope, excludedScope: excluded, budget: { currency: "USD", maximum: budget.toFixed(2) }, timeLimitSeconds: time, risk: resolved.securityClass, assumptions, confirmation: { expiresAt: new Date(now + this.ttl).toISOString(), reviewDigest: this.confirmBindingDigest(id) } };
    }
    async confirm(changeId, context) {
        const { actor, conversation } = contextIdentity(context);
        const run = this.deps.repository.getRun(changeId);
        const proposal = this.proposal(changeId);
        if (!run || !proposal)
            throw new ControlError("change_not_found", "The prepared change was not found.");
        if (run.state !== "awaiting_confirmation")
            throw new ControlError(run.state === "autonomous_run" || run.state === "pr_ready" || run.state === "done" ? "already_confirmed" : "stale_confirmation", "This proposal can no longer be confirmed.");
        if (!proposal.confirmable)
            throw new ControlError("proposal_not_confirmable", "Prepare a new change with all required decisions stated.");
        const att = this.requireAttestation("confirm_change", context);
        if (actor !== run.requesterId || att.actorIdentity !== run.requesterId)
            throw new ControlError("wrong_actor", "The confirmation must come from the preparing requester.");
        if (conversation !== run.conversationId || att.conversationIdentity !== run.conversationId)
            throw new ControlError("wrong_conversation", "The confirmation must come from the preparing conversation.");
        const now = this.now();
        if (att.issuedAt <= proposal.created_at || att.expiresAt < now || att.issuedAt > now || proposal.proposal_expires_at < now)
            throw new ControlError("stale_confirmation", "The confirmation expired.");
        const expected = this.confirmBindingDigest(changeId, att);
        if (att.bindingDigest !== expected)
            throw new ControlError("stale_confirmation", "The proposal changed after review.");
        try {
            this.consumeAttestation(changeId, att, now);
            const current = this.deps.repository.getRun(changeId);
            if (!current || current.version !== run.version || current.state !== "awaiting_confirmation")
                throw new ControlError("stale_confirmation", "The proposal changed after review.");
            this.deps.repository.transition({ runId: changeId, expectedVersion: run.version, to: "autonomous_run", actor: "host_confirmation", reason: "confirmed", at: now });
            this.deps.db.prepare(`INSERT INTO control_dispatch_intents (run_id,status,created_at,updated_at) VALUES (?,'pending',?,?)`).run(changeId, now, now);
        }
        catch (error) {
            if (/UNIQUE constraint/i.test(String(error)))
                throw new ControlError("confirmation_replayed", "This confirmation was already used.");
            throw error;
        }
        void this.dispatch(changeId);
        return { ok: true, changeId, state: "running", summary: "Change confirmed and running autonomously." };
    }
    result(changeId, context) { const { actor, conversation } = contextIdentity(context); const run = this.deps.repository.getRun(changeId); const p = this.proposal(changeId); if (!run || !p || run.requesterId !== actor || run.conversationId !== conversation)
        throw new ControlError("change_not_found", "The change was not found."); const publicState = run.state === "awaiting_confirmation" ? "prepared" : run.state === "autonomous_run" ? "running" : run.state === "done" ? "merged" : run.state; const result = { ok: true, changeId, state: publicState, summary: p.terminal_summary ?? this.summary(run.state), createdAt: new Date(run.createdAt).toISOString(), updatedAt: new Date(run.updatedAt).toISOString() }; if (run.state === "pr_ready" && p.pr_url)
        result.pullRequest = { url: p.pr_url }; if (run.state === "failed")
        result.code = run.terminalCode ?? "execution_failed"; return result; }
    async merge(changeId, context) { const { actor, conversation } = contextIdentity(context); const run = this.deps.repository.getRun(changeId); const p = this.proposal(changeId); if (!run || !p)
        throw new ControlError("change_not_found", "The change was not found."); if (run.state === "done")
        throw new ControlError("already_merged", "This change was already merged."); if (run.state !== "pr_ready" || !p.pr_number || !p.published_sha || !p.readiness_digest)
        throw new ControlError("not_pr_ready", "This change is not ready to merge."); const att = this.requireAttestation("merge_change", context); if (actor !== run.requesterId || att.actorIdentity !== run.requesterId)
        throw new ControlError("wrong_actor", "The merge must come from the preparing requester."); if (conversation !== run.conversationId || att.conversationIdentity !== run.conversationId)
        throw new ControlError("wrong_conversation", "The merge must come from the preparing conversation."); const now = this.now(); if (att.issuedAt <= run.updatedAt || att.expiresAt < now || att.issuedAt > now)
        throw new ControlError("stale_pr_head", "The merge confirmation expired."); const expected = this.mergeBindingDigest(changeId, att); if (att.bindingDigest !== expected)
        throw new ControlError("stale_pr_head", "The pull request changed after review."); this.consumeAttestation(changeId, att, now); const auth = createVerifiedMergeAuthorization({ id: `merge_${randomUUID()}`, runId: changeId, actorIdentity: actor, conversationIdentity: conversation, repository: run.repository, baseRef: run.baseRef, prNumber: p.pr_number, expectedHeadSha: p.published_sha, publishedSha: p.published_sha, readinessDigest: p.readiness_digest, nonce: att.nonce, issuedAt: att.issuedAt, expiresAt: att.expiresAt }); this.deps.mergeService.registerAuthorization(auth); const outcome = await this.deps.mergeService.merge(auth.id); if (outcome.status === "merged" || outcome.status === "already_merged")
        return { ok: true, changeId, state: "merged", summary: "Pull request merged.", ...(outcome.mergeSha ? { mergeSha: outcome.mergeSha } : {}) }; throw new ControlError(outcome.code, outcome.status === "refused" ? "Merge readiness changed; merge refused." : "The merge did not complete."); }
    async dispatch(changeId) { const now = this.now(); const owner = `controller:${randomUUID()}`; const claimed = this.deps.db.prepare(`UPDATE control_dispatch_intents SET status='running',lease_owner=?,lease_fence=lease_fence+1,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE run_id=? AND status IN ('pending','running') AND (status='pending' OR lease_expires_at<?)`).run(owner, now + this.dispatchLeaseMs, now, changeId, now); if (Number(claimed.changes) !== 1)
        return; const intent = this.deps.db.prepare(`SELECT lease_fence FROM control_dispatch_intents WHERE run_id=?`).get(changeId); let lease; let heartbeat; try {
        lease = this.deps.engine.acquire(changeId);
        heartbeat = setInterval(() => { const at = this.now(); if (!lease)
            return; const renewed = this.deps.repository.renewLease(changeId, lease.ownerId, lease.fence, this.dispatchLeaseMs, at); if (renewed)
            this.deps.db.prepare(`UPDATE control_dispatch_intents SET lease_expires_at=?,updated_at=? WHERE run_id=? AND status='running' AND lease_owner=? AND lease_fence=?`).run(at + this.dispatchLeaseMs, at, changeId, owner, intent.lease_fence); }, Math.max(10, Math.floor(this.dispatchLeaseMs / 3)));
        heartbeat.unref?.();
        const run = this.deps.repository.getRun(changeId);
        const p = this.proposal(changeId);
        const assertCurrent = () => { const row = this.deps.db.prepare(`SELECT status,lease_owner,lease_fence,lease_expires_at FROM control_dispatch_intents WHERE run_id=?`).get(changeId); if (!row || row.status !== "running" || row.lease_owner !== owner || row.lease_fence !== intent.lease_fence || row.lease_expires_at <= this.now() || !this.deps.repository.validateLease(lease, this.now()))
            throw new Error(`stale_dispatch:${changeId}`); };
        const input = await this.deps.executeEngine({ changeId, brief: JSON.parse(p.brief_json), actorIdentity: run.requesterId, conversationIdentity: run.conversationId, repositoryIdentity: run.repository, baseRef: run.baseRef, baseRevision: p.base_revision, budgetUsd: run.authorityEnvelope.limits.budgetUsd, timeLimitSeconds: Math.floor(run.authorityEnvelope.limits.activeTimeMs / 1000), scope: parseList(p.scope_json), excludedScope: parseList(p.excluded_scope_json), credentialRouteDigest: p.credential_route_digest, lease, assertCurrent, checkpoint: (sha, payload) => { assertCurrent(); this.deps.engine.checkpoint(changeId, lease, sha, payload); } });
        assertCurrent();
        const readiness = evaluatePrReadiness(input, this.now());
        this.persistDispatchCompletion(changeId, owner, intent.lease_fence, lease, p, input, readiness);
        if (heartbeat)
            clearInterval(heartbeat);
    }
    catch (error) {
        if (heartbeat)
            clearInterval(heartbeat);
        if (String(error).includes("stale_dispatch") || String(error).includes("stale_write"))
            return;
        const shipped = this.deps.db.prepare(`SELECT status,pr_number,final_pr_url,published_sha,published_at FROM sessions WHERE id=?`).get(changeId);
        if (shipped?.pr_number && shipped.published_sha && shipped.published_at && shipped.final_pr_url) {
            this.deps.db.prepare(`UPDATE control_dispatch_intents SET status='pending',last_error=?,completed_at=NULL,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE run_id=? AND lease_owner=? AND lease_fence=?`).run(String(error).slice(0, 500), this.now(), changeId, owner, intent.lease_fence);
            if (lease && this.deps.repository.validateLease(lease, this.now()))
                this.deps.repository.releaseLease(changeId, lease.ownerId, lease.fence, this.now());
            return;
        }
        const run = this.deps.repository.getRun(changeId);
        if (run?.state === "autonomous_run" && lease && this.deps.repository.validateLease(lease, this.now()))
            this.deps.repository.transitionFenced({ runId: changeId, expectedVersion: run.version, to: "failed", actor: "autonomous_engine", reason: "execution_failed", terminalCode: "execution_failed", lease, at: this.now() });
        this.deps.db.prepare(`UPDATE control_proposals SET terminal_summary='The change did not complete.',updated_at=? WHERE run_id=?`).run(this.now(), changeId);
        this.deps.db.prepare(`UPDATE control_dispatch_intents SET status='failed',last_error=?,completed_at=?,updated_at=? WHERE run_id=? AND lease_owner=? AND lease_fence=?`).run(String(error).slice(0, 500), this.now(), this.now(), changeId, owner, intent.lease_fence);
    } }
    persistDispatchCompletion(changeId, owner, intentFence, lease, p, input, readiness) { const at = this.now(), generation = p.generation + 1; this.deps.db.exec("BEGIN IMMEDIATE"); try {
        const live = this.deps.db.prepare(`SELECT r.state,r.version,l.owner_id,l.fence,l.expires_at,l.authority_hash,d.status,d.lease_owner,d.lease_fence,d.lease_expires_at FROM control_runs r JOIN run_leases l ON l.run_id=r.id JOIN control_dispatch_intents d ON d.run_id=r.id WHERE r.id=?`).get(changeId);
        if (!live || live.state !== "autonomous_run" || live.owner_id !== lease.ownerId || Number(live.fence) !== lease.fence || Number(live.expires_at) <= at || live.authority_hash !== lease.authorityHash || live.status !== "running" || live.lease_owner !== owner || Number(live.lease_fence) !== intentFence || Number(live.lease_expires_at) <= at)
            throw new Error(`stale_dispatch:${changeId}`);
        this.deps.db.prepare(`INSERT INTO control_readiness_results (run_id,lease_fence,ready,verified_sha,failures_json,created_at) VALUES (?,?,?,?,?,?)`).run(changeId, lease.fence, readiness.ready ? 1 : 0, readiness.ready ? readiness.verifiedSha : null, JSON.stringify(readiness.ready ? [] : readiness.failures), at);
        this.deps.db.prepare(`INSERT INTO control_readiness_attestations (content_digest,run_id,generation,policy_version,ready,verified_sha,input_json,failures_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(readiness.contentDigest, changeId, generation, readiness.policyVersion, readiness.ready ? 1 : 0, readiness.ready ? readiness.verifiedSha : null, JSON.stringify(input), JSON.stringify(readiness.ready ? [] : readiness.failures), readiness.checkedAt);
        this.deps.db.prepare(`UPDATE control_proposals SET generation=?,pr_number=?,pr_url=?,published_sha=?,readiness_digest=?,spend_usd=?,terminal_summary=?,updated_at=? WHERE run_id=?`).run(generation, input.pullRequest.number ?? null, input.pullRequest.url ?? null, input.publication?.sha ?? null, readiness.contentDigest, input.spendUsd, readiness.ready ? null : `Readiness failed: ${readiness.failures.join(", ")}`, at, changeId);
        const changed = this.deps.db.prepare(`UPDATE control_runs SET state=?,version=version+1,updated_at=?,terminal_code=? ,pull_request_url=COALESCE(?,pull_request_url) WHERE id=? AND state='autonomous_run' AND version=?`).run(readiness.ready ? "pr_ready" : "failed", at, readiness.ready ? null : (readiness.failures[0] ?? "readiness_failed"), input.pullRequest.url ?? null, changeId, Number(live.version));
        if (Number(changed.changes) !== 1)
            throw new Error(`stale_write:${changeId}`);
        this.deps.db.prepare(`INSERT INTO control_state_events (run_id,from_state,to_state,from_version,to_version,actor,reason,created_at) VALUES (?,'autonomous_run',?,?,?,?,?,?)`).run(changeId, readiness.ready ? "pr_ready" : "failed", Number(live.version), Number(live.version) + 1, "autonomous_engine", readiness.ready ? "strict_readiness_passed" : readiness.failures.join(","), at);
        this.deps.db.prepare(`UPDATE control_dispatch_intents SET status=?,completed_at=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE run_id=? AND lease_owner=? AND lease_fence=?`).run(readiness.ready ? "completed" : "failed", at, at, changeId, owner, intentFence);
        this.deps.db.exec("COMMIT");
    }
    catch (error) {
        try {
            this.deps.db.exec("ROLLBACK");
        }
        catch { }
        throw error;
    } }
    async recoverDispatches() { try {
        const rows = this.deps.db.prepare(`SELECT run_id FROM control_dispatch_intents WHERE status='pending' OR (status='running' AND lease_expires_at<?)`).all(this.now());
        for (const row of rows)
            await this.dispatch(row.run_id);
    }
    catch { /* database may be closing */ } }
    proposal(id) { return this.deps.db.prepare(`SELECT * FROM control_proposals WHERE run_id=?`).get(id) ?? null; }
    requireAttestation(operation, context) { const att = context.trustedControlAttestation; if (!att || att.version !== 2 || att.provenance !== "host_verified" || att.operation !== operation)
        throw new ControlError(operation === "merge_change" ? "merge_attestation_required" : "confirmation_attestation_required", "An independently verified host attestation is required."); return att; }
    consumeAttestation(id, att, now) { this.deps.db.prepare(`INSERT INTO control_host_attestations (id,run_id,operation_kind,provenance,actor_identity,conversation_identity,host_event_id,nonce,binding_digest,issued_at,expires_at,consumed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), id, att.operation, att.provenance, att.actorIdentity, att.conversationIdentity, att.hostEventId, att.nonce, att.bindingDigest, att.issuedAt, att.expiresAt, now); }
    confirmBindingDigest(id, att) { const run = this.deps.repository.getRun(id); const p = this.proposal(id); if (!run || !p)
        return ""; return controlDigest(CONFIRM_DOMAIN, { changeId: id, version: run.version, repository: run.repository, baseRef: run.baseRef, baseRevision: p.base_revision, briefDigest: run.briefDigest, policyDigest: run.policyDigest, scope: p.scope_json, excludedScope: p.excluded_scope_json, credentialRouteDigest: p.credential_route_digest, budgetUsd: run.authorityEnvelope.limits.budgetUsd, timeLimitMs: run.authorityEnvelope.limits.activeTimeMs, proposalExpiresAt: p.proposal_expires_at, ...(att ? { actorIdentity: att.actorIdentity, conversationIdentity: att.conversationIdentity, hostEventId: att.hostEventId, nonce: att.nonce, issuedAt: att.issuedAt, expiresAt: att.expiresAt } : {}) }); }
    mergeBindingDigest(id, att) { const run = this.deps.repository.getRun(id); const p = this.proposal(id); if (!run || !p)
        return ""; return controlDigest(MERGE_DOMAIN, { changeId: id, version: run.version, repository: run.repository, baseRef: run.baseRef, prNumber: p.pr_number, publishedSha: p.published_sha, readinessDigest: p.readiness_digest, actorIdentity: att.actorIdentity, conversationIdentity: att.conversationIdentity, hostEventId: att.hostEventId, nonce: att.nonce, issuedAt: att.issuedAt, expiresAt: att.expiresAt }); }
    summary(state) { return state === "awaiting_confirmation" ? "Ready for confirmation." : state === "autonomous_run" ? "The change is in progress." : state === "pr_ready" ? "The pull request is ready." : state === "done" ? "The pull request was merged." : "The change did not complete."; }
}
//# sourceMappingURL=service.js.map