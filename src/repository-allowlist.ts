/**
 * Canonical, fail-closed repository allow-list matching.
 *
 * GitHub and GitLab repository identities are case-insensitive, but repository
 * authorization must still compare exactly one owner and one repository name.
 * Do not accept URLs, paths, encoded separators, Unicode lookalikes, or extra
 * path segments as aliases for an allowed repository.
 */

type CanonicalRepository = { owner: string; repository: string };
type CanonicalAllowEntry = CanonicalRepository | { owner: string; repository: "*" };

const ASCII_REPOSITORY_COMPONENT = /^[A-Za-z0-9._-]+$/;

function canonicalComponent(value: string): string | null {
  if (!ASCII_REPOSITORY_COMPONENT.test(value) || value === "." || value === "..") return null;
  return value.toLowerCase();
}

export function canonicalRepositoryIdentity(value: string): CanonicalRepository | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const owner = canonicalComponent(parts[0]!);
  const repository = canonicalComponent(parts[1]!);
  if (!owner || !repository || repository === "*") return null;
  return { owner, repository };
}

function canonicalAllowEntry(value: string): CanonicalAllowEntry | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const owner = canonicalComponent(parts[0]!);
  if (!owner) return null;
  if (parts[1] === "*") return { owner, repository: "*" };
  const repository = canonicalComponent(parts[1]!);
  if (!repository || repository === "*") return null;
  return { owner, repository };
}

export function isRepositoryAllowed(repoFullName: string, allowed: string[]): boolean {
  const repository = canonicalRepositoryIdentity(repoFullName);
  if (!repository || !Array.isArray(allowed)) return false;
  return allowed.some((configured) => {
    const allowedRepo = canonicalAllowEntry(configured);
    if (!allowedRepo || allowedRepo.owner !== repository.owner) return false;
    if (allowedRepo.repository === "*") return true;
    return allowedRepo.repository === repository.repository;
  });
}
