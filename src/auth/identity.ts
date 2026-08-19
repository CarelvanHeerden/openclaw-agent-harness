/**
 * Token-attested identity.
 *
 * `harness_onboard` takes the requester as an ARGUMENT, and nothing in an
 * agent-relayed call proves the caller is that person. The DM flow already
 * protects capture -- a prompt opens in the named user's own DM, so a caller
 * cannot read someone else's token -- but it does not protect storage: a caller
 * can submit THEIR token under SOMEONE ELSE'S id, and that person's later
 * commits would then push with it.
 *
 * The token itself settles the argument. Validation calls `GET /user`, which
 * returns the login the token authenticates as, so a stored credential can
 * record its owner and a later submission can be checked against it. That
 * needs no Slack scope and no trust in the relaying agent.
 *
 * Fail-closed: if a route has a recorded login and the presented token does not
 * disclose one, the swap is refused. Being unable to attest is not the same as
 * attesting a match.
 *
 * Pure -- no network -- so the policy is testable without a provider.
 */

export type IdentityVerdict =
  /** No prior login recorded: first credential for this route. */
  | { ok: true; kind: "first"; attested: boolean; login?: string }
  /** The presented token authenticates as the same account as before. */
  | { ok: true; kind: "match"; login: string }
  /** A different account, or one that cannot be established. */
  | { ok: false; kind: "mismatch" | "unattested"; recorded: string; presented?: string; message: string };

/**
 * Provider logins are case-insensitive, and both GitHub and GitLab echo back
 * whatever case the account was created with.
 */
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Decide whether a presented token may be stored against a route.
 *
 * `recordedLogin` is what the existing credential authenticated as, absent for
 * a brand-new route. `presentedLogin` is what the incoming token just
 * authenticated as, absent when the provider did not disclose it.
 */
export function checkTokenIdentity(
  recordedLogin: string | undefined,
  presentedLogin: string | undefined,
): IdentityVerdict {
  const recorded = recordedLogin?.trim();
  const presented = presentedLogin?.trim();

  if (!recorded) {
    // Nothing to compare against yet. Accept, and report whether an owner could
    // be recorded at all -- an unattested first credential can never be checked
    // on the way in later, which the caller should say out loud.
    return { ok: true, kind: "first", attested: !!presented, login: presented || undefined };
  }

  if (!presented) {
    return {
      ok: false,
      kind: "unattested",
      recorded,
      message:
        `This credential belongs to '${recorded}', and the token you supplied did not identify its account, ` +
        `so it cannot be shown to be the same one. Nothing was changed.`,
    };
  }

  if (!same(recorded, presented)) {
    return {
      ok: false,
      kind: "mismatch",
      recorded,
      presented,
      message:
        `This credential belongs to '${recorded}', but the token you supplied authenticates as '${presented}'. ` +
        `Storing it would make that account's commits appear under the wrong person. Nothing was changed.`,
    };
  }

  return { ok: true, kind: "match", login: presented };
}
