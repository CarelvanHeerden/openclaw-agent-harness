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
export const PINNED_OPENCODE_VERSION = "1.18.23";
export const PINNED_OPENCODE_PACKAGE = `opencode-ai@${PINNED_OPENCODE_VERSION}`;
/** Versions we have real captured transcripts for. */
export const CAPTURED_OPENCODE_VERSIONS = ["1.18.11"];
function parts(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!m)
        return undefined;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}
/**
 * Compare what launched against what we pinned.
 *
 * `unknown` — including an agent that reports no version at all — warns rather
 * than passes. An agent that will not say what it is is precisely the case
 * where a recorded diagnostic is worth having.
 */
export function assessOpenCodeVersion(reported, expected = PINNED_OPENCODE_VERSION) {
    const base = { reported, expected };
    if (!reported || !reported.trim()) {
        return {
            ...base,
            relation: "unknown",
            warn: true,
            message: `the agent did not report a version; expected ${expected}. ` +
                `Behaviour is unverified against this build — the startup permission probe is what actually gates it.`,
        };
    }
    if (reported.trim() === expected)
        return { ...base, relation: "exact", warn: false };
    const a = parts(reported);
    const b = parts(expected);
    if (!a || !b) {
        return {
            ...base,
            relation: "unknown",
            warn: true,
            message: `could not parse agent version '${reported}' (expected ${expected}).`,
        };
    }
    const relation = a[0] !== b[0] ? "major" : a[1] !== b[1] ? "minor" : "patch";
    const severity = relation === "major"
        ? "A major-version difference is very likely to change protocol behaviour."
        : relation === "minor"
            ? "A minor-version difference may change tool routing or permission behaviour."
            : "A patch difference is usually harmless.";
    return {
        ...base,
        relation,
        warn: true,
        message: `running opencode ${reported}, pinned at ${expected}. ${severity} ` +
            `The startup permission probe is what actually gates safety here, not this version check.`,
    };
}
//# sourceMappingURL=opencode-version.js.map