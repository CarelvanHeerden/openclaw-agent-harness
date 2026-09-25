/**
 * Canonical, fail-closed repository allow-list matching.
 *
 * GitHub and GitLab repository identities are case-insensitive, but repository
 * authorization must still compare exactly one owner and one repository name.
 * Do not accept URLs, paths, encoded separators, Unicode lookalikes, or extra
 * path segments as aliases for an allowed repository.
 */
type CanonicalRepository = {
    owner: string;
    repository: string;
};
export declare function canonicalRepositoryIdentity(value: string): CanonicalRepository | null;
export declare function isRepositoryAllowed(repoFullName: string, allowed: string[]): boolean;
export {};
//# sourceMappingURL=repository-allowlist.d.ts.map