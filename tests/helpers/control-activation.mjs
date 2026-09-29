import { authorityEnvelopeDigest } from "../../dist/control/authority.js";

let sequence = 0;

export function transitionToAutonomous(db, repo, run, at) {
  const suffix = `${run.id}-${++sequence}`;
  const attestationId = `test-attestation-${suffix}`;
  db.prepare(`INSERT INTO control_host_attestations
    (id,run_id,operation_kind,provenance,actor_identity,conversation_identity,host_event_id,nonce,binding_digest,issued_at,expires_at,consumed_at)
    VALUES (?,?,'confirm_change','host_verified',?,?,?,?,?,?,?,?)`).run(
      attestationId,
      run.id,
      run.requesterId,
      run.conversationId,
      `test-event-${suffix}`,
      `test-nonce-${suffix}`,
      "d".repeat(64),
      at - 1,
      at + run.authorityEnvelope.limits.activeTimeMs,
      at,
    );
  db.prepare(`INSERT INTO control_authority_activations
    (run_id,run_version,attestation_id,authority_digest,activated_at,execution_expires_at,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(
      run.id,
      run.version + 1,
      attestationId,
      authorityEnvelopeDigest(run.authorityEnvelope),
      at,
      at + run.authorityEnvelope.limits.activeTimeMs,
      at,
    );
  return repo.transition({
    runId: run.id,
    expectedVersion: run.version,
    to: "autonomous_run",
    actor: "test-host",
    reason: "confirmed",
    at,
  });
}
