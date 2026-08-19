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
{
    ok: true;
    kind: "first";
    attested: boolean;
    login?: string;
}
/** The presented token authenticates as the same account as before. */
 | {
    ok: true;
    kind: "match";
    login: string;
}
/** A different account, or one that cannot be established. */
 | {
    ok: false;
    kind: "mismatch" | "unattested";
    recorded: string;
    presented?: string;
    message: string;
};
/**
 * Decide whether a presented token may be stored against a route.
 *
 * `recordedLogin` is what the existing credential authenticated as, absent for
 * a brand-new route. `presentedLogin` is what the incoming token just
 * authenticated as, absent when the provider did not disclose it.
 */
export declare function checkTokenIdentity(recordedLogin: string | undefined, presentedLogin: string | undefined): IdentityVerdict;
//# sourceMappingURL=identity.d.ts.map