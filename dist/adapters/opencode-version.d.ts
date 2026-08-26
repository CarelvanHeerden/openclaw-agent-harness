/**
 * Which OpenCode the harness was built against, and what to do when the one
 * that actually launched is a different build.
 *
 * WHY WARN AND RUN, RATHER THAN REFUSE. A hard version match would be the
 * obvious choice and it is the wrong one here: OpenCode ships often, an
 * operator on a working setup would be broken by a patch release they did not
 * ask for, and the failure a strict pin protects against is not the one that
 * actually hurts. What hurts is a version that quietly stops routing tool calls
 * through `session/request_permission` — and M6's live probe already catches
 * that, at startup, by observation rather than by trusting a version string.
 *
 * So the probe is the safety property and this is the diagnostic. A mismatch is
 * recorded so that when something does misbehave, the first question — "what
 * were you running?" — is already answered in the audit log rather than
 * requiring a reproduction.
 */
/**
 * The build every capability claim in `docs/acp-capability-matrix.md` was
 * measured against.
 *
 * NOTE: the captured sessions in `probe/runs/` are OpenCode **1.18.11**, an
 * earlier build. They are kept and replayed because they are real wire
 * transcripts, and the protocol behaviour they show — including the
 * `fs/write_text_file` that arrives despite `fs: false` — is exactly what the
 * adapter has to survive. A newer pin does not make an older capture wrong; it
 * makes it a compatibility floor.
 */
export declare const PINNED_OPENCODE_VERSION = "1.18.23";
export declare const PINNED_OPENCODE_PACKAGE = "opencode-ai@1.18.23";
/** Versions we have real captured transcripts for. */
export declare const CAPTURED_OPENCODE_VERSIONS: readonly ["1.18.11"];
export type VersionRelation = "exact" | "patch" | "minor" | "major" | "unknown";
export interface VersionAssessment {
    reported?: string;
    expected: string;
    relation: VersionRelation;
    /** True when the operator should be told, i.e. anything but an exact match. */
    warn: boolean;
    message?: string;
}
/**
 * Compare what launched against what we pinned.
 *
 * `unknown` — including an agent that reports no version at all — warns rather
 * than passes. An agent that will not say what it is is precisely the case
 * where a recorded diagnostic is worth having.
 */
export declare function assessOpenCodeVersion(reported: string | undefined, expected?: string): VersionAssessment;
//# sourceMappingURL=opencode-version.d.ts.map