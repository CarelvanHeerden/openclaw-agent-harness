/**
 * rc.9 -- turning a backend's idea of "a path" into something a policy can judge.
 *
 * StitchGuard, session f7c4e585, 2026-09-14 19:35:17. A worker's `apply_patch`
 * touching four files was denied with:
 *
 *   edit path '.env.example, README.md, docs/deployment-runbook.md,
 *              docs/slack/client-offboarding-app-manifest.yaml' is denylisted
 *
 * One path, four files in it. That single string is the whole story of this
 * module, because it exposed three separate defects at once:
 *
 *  1. `apply_patch` carries NO per-file path. Its entire input is a `patchText`
 *     blob whose `*** Update File:` directives name the targets, and nothing in
 *     the harness read them. The guard was judging a display string.
 *
 *  2. A combined string is judged as one path, and the denylist is anchored, so
 *     the verdict depends on the ORDER of the files in it. `.env.example,
 *     README.md` was denied because the pattern `.env.*` compiles to
 *     `^\.env\..*$` and `.*` happily swallows ", README.md". Reverse it to
 *     `README.md, .env.production` and nothing matches: ALLOWED. The one
 *     denial that did fire fired by accident.
 *
 *  3. `/repo/.env.production` was allowed outright, because the wildcard branch
 *     of the matcher tested the pattern against the whole string while the
 *     literal branch had a `p.endsWith("/" + pat)` case. A pattern with a `*`
 *     in it simply did not understand directories.
 *
 * The rules here follow from that:
 *
 *   - Prefer a STRUCTURED source of paths (patch directives) over a string the
 *     backend assembled for a human to read.
 *   - Canonicalise before judging: separators, `.`/`..`, absolute vs
 *     repo-relative, and -- when the caller can resolve them -- symlink targets.
 *   - When a string might encode more than one path, REFUSE. Do not split on
 *     commas: a comma is a legal character in a filename, and guessing wrong in
 *     the permissive direction is how `README.md, .env.production` got through.
 *
 * Nothing here loosens the denylist. The one relaxation in this file is the
 * authorised-template exception, which is opt-in, exact-match only, and paired
 * with a content check -- see {@link templateExceptionApplies}.
 */

import { redactTokenShapes } from "../state/interaction-log.js";

/** Canonical forms of one raw path, or a refusal that the caller must honour. */
export interface PathResolution {
  /** The string as the backend supplied it. */
  raw: string;
  /**
   * Every canonical form policy must be evaluated against -- the lexical path
   * plus, when a resolver was supplied, its symlink target. Judging only one of
   * them is how a symlink escapes. Empty only when `refuse` is set.
   */
  candidates: string[];
  /**
   * Set when the string could not be resolved to an unambiguous path. The
   * caller MUST deny: this is the fail-closed channel, not a warning.
   */
  refuse?: string;
}

export interface ResolveOptions {
  /** Absolute repo root. Paths inside it are made repo-relative before matching. */
  repoRoot?: string;
  /**
   * Resolves symlinks, e.g. `fs.realpathSync`. Optional because the pure guard
   * has no filesystem. Throwing for a MISSING path is expected and ignored (a
   * patch creating a new file has no target yet); throwing for any other reason
   * is a refusal, because "I could not tell what this points at" is not a pass.
   */
  realpath?: (p: string) => string;
}

/**
 * Does this string plausibly encode more than one path?
 *
 * Deliberately conservative in the REFUSING direction, because the alternative
 * -- splitting and hoping -- is what this module exists to prevent. A comma is
 * legal in a filename, so `my,file.txt` must still resolve normally. What is
 * not plausible as a single filename is a comma followed by a space followed by
 * something that itself looks like a path, repeated.
 */
export function looksLikeMultiplePaths(raw: string): boolean {
  if (!raw.includes(", ")) return false;
  const parts = raw.split(", ");
  if (parts.length < 2) return false;
  /*
   * Every part must be non-empty and contain no whitespace.
   *
   * An earlier version of this also required each part to end in a short file
   * extension, and that let `README.md, .env.production` through -- the second
   * part ends in `.production`, ten characters, so the string was judged as one
   * innocent path and ALLOWED. Exactly the probe result this module exists to
   * close, reintroduced by a cleverer test.
   *
   * Whitespace is the better signal, and it is the one that distinguishes a
   * machine-assembled list from a human filename: `Report, Final Version.pdf`
   * has a space in its second part and resolves normally, while every element
   * of a joined path list does not.
   */
  return parts.every((p) => p.length > 0 && !/\s/.test(p));
}

/** Collapse `.`/`..`/duplicate separators without touching the filesystem. */
function lexicalNormalise(p: string): string {
  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // A leading `..` on a relative path must survive: it still names a real
      // location, and dropping it would silently retarget the check.
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (absolute ? "/" : "") + out.join("/");
}

/**
 * Turn one backend-supplied path string into the canonical forms policy judges.
 *
 * Never throws. A string it cannot make sense of comes back with `refuse` set,
 * which the guard turns into a denial.
 */
export function resolvePathForPolicy(raw: string, opts: ResolveOptions = {}): PathResolution {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { raw, candidates: [], refuse: "empty path" };

  if (looksLikeMultiplePaths(trimmed)) {
    const n = trimmed.split(", ").filter((s) => s.trim()).length;
    return {
      raw,
      candidates: [],
      refuse:
        `path string appears to name ${n} files rather than one ` +
        `(${JSON.stringify(trimmed.slice(0, 200))}); the harness will not guess which policy applies to which file`,
    };
  }

  // A NUL or newline in a path is never legitimate here and is a classic way to
  // make two different readers disagree about where the string ends.
  if (/[\0\n\r]/.test(trimmed)) {
    return { raw, candidates: [], refuse: "path contains a newline or NUL byte" };
  }

  const root = opts.repoRoot ? lexicalNormalise(opts.repoRoot.trim()) : "";
  const canonical = new Set<string>();

  const add = (p: string): void => {
    const norm = lexicalNormalise(p);
    if (!norm) return;
    canonical.add(norm);
    // Judge an in-repo absolute path by its repo-relative form too, because
    // that is the form denylist patterns are written in.
    if (root && norm.startsWith(root + "/")) canonical.add(norm.slice(root.length + 1));
  };

  add(trimmed);
  // A relative path also has an absolute identity; `/etc/`-style patterns only
  // ever match that one.
  if (root && !trimmed.startsWith("/")) add(`${root}/${trimmed}`);

  if (opts.realpath) {
    for (const c of [...canonical]) {
      const probe = c.startsWith("/") ? c : root ? `${root}/${c}` : "";
      if (!probe) continue;
      try {
        add(opts.realpath(probe));
      } catch (err) {
        // ENOENT is ordinary: a patch that CREATES a file has no target yet, and
        // refusing those would break every new-file edit. Anything else means we
        // genuinely cannot see what this path points at.
        const code = (err as { code?: string } | null)?.code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          return { raw, candidates: [], refuse: `cannot resolve '${c}' safely: ${String(err)}` };
        }
      }
    }
  }

  const candidates = [...canonical];
  if (candidates.length === 0) return { raw, candidates: [], refuse: "path normalised to nothing" };
  return { raw, candidates };
}

/**
 * The paths an `apply_patch` will actually touch, read from its own directives.
 *
 * This is the structured source the incident lacked. The OpenAI apply_patch
 * envelope names every target explicitly:
 *
 *   *** Begin Patch
 *   *** Update File: docs/runbook.md
 *   *** Add File: docs/new.md
 *   *** Delete File: docs/old.md
 *   *** Move to: docs/renamed.md
 *   *** End Patch
 *
 * A `Move to:` is recorded as well as its source: a rename out of a protected
 * path is still a write to it, and a rename INTO one is a write to the
 * destination.
 *
 * Returns [] when the text carries no directives at all -- the caller must
 * treat that as "no path exposed" and fail closed, exactly as before.
 */
export function pathsFromPatchText(patchText: string): string[] {
  if (typeof patchText !== "string" || !patchText.includes("***")) return [];
  const out: string[] = [];
  const re = /^\*\*\*\s+(Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patchText)) !== null) {
    const p = m[2]?.trim();
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ *
 * The authorised-template exception
 * ------------------------------------------------------------------ */

/**
 * A PEM armour header, matched without writing the literal marker: `[A-Z ]+`
 * covers the `RSA `/`OPENSSH `/`EC ` variants and the bare form.
 */
const PEM_ARMOUR = /-{5}BEGIN [A-Z ]+KEY-{5}/;

/** `NAME=value` on an added line, captured so the value can be judged. */
const ASSIGNMENT = /^[+]?\s*([A-Z0-9_]{3,})\s*=\s*["']?([A-Za-z0-9+/_\-]{32,}={0,2})["']?\s*$/;

/**
 * Does a long value look like a real credential rather than a placeholder?
 *
 * Length alone is not enough, and getting this wrong in the strict direction is
 * not harmless: the first version of this check refused
 * `CLIENT_OFFBOARDING_SLACK_SIGNING_SECRET=example-client-offboarding-signing-secret`,
 * which is precisely the placeholder line a template is FOR. Refusing that
 * would have re-broken the case this whole exception exists to unblock.
 *
 * Real tokens carry character-class variety that hyphenated English does not.
 * This is a heuristic and is the second line of defence -- the named shapes in
 * `redactTokenShapes` are the first, and they do the real work.
 */
function looksHighEntropy(value: string): boolean {
  if (value.endsWith("=")) return true; // base64 padding
  if (/^[0-9a-f]{32,}$/i.test(value)) return true; // hex digest / hex token
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

export interface SecretScan {
  /** True when the added lines contain something that must never be committed. */
  found: boolean;
  /** Human-readable, and safe: names the SHAPE, never the value. */
  detail?: string;
}

/**
 * Scan the ADDED lines of a patch for secret material.
 *
 * Only added lines: a patch that merely moves an existing line around is not
 * introducing anything, and scanning context lines would refuse every edit to a
 * file that already contains a placeholder.
 *
 * Known token shapes are detected by running the line through the interaction
 * log's redactor and seeing whether it changed. That keeps ONE list of secret
 * shapes in the codebase -- a second copy here would inevitably drift, and the
 * drift would be silent in the permissive direction.
 *
 * Never returns the offending value, only its shape and line number, because
 * this text is destined for an operator-visible clarification.
 */
export function scanPatchForSecrets(patchText: string): SecretScan {
  if (typeof patchText !== "string" || patchText.length === 0) return { found: false };
  const lines = patchText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (redactTokenShapes(line) !== line) {
      return { found: true, detail: `added line ${i + 1} contains a recognised credential shape` };
    }
    if (PEM_ARMOUR.test(line)) {
      return { found: true, detail: `added line ${i + 1} opens a PEM-armoured key block` };
    }
    const assignment = ASSIGNMENT.exec(line);
    if (assignment && looksHighEntropy(assignment[2]!)) {
      return { found: true, detail: `added line ${i + 1} assigns ${assignment[1]} a long high-entropy value` };
    }
  }
  return { found: false };
}

/**
 * May this denylisted path be edited after all?
 *
 * The exception is deliberately the narrowest thing that solves the real case:
 *
 *   - EXACT repo-relative paths only. No globs, no directories, no `*.example`.
 *     `.env.example` is a decision about one file, not about a shape of name.
 *   - EVERY resolved form must be authorised, so `../../.env.example` or a
 *     symlink pointing somewhere else does not inherit the authorisation.
 *   - Content is checked separately by {@link scanPatchForSecrets}. An
 *     authorisation to edit a template is not an authorisation to put a live
 *     credential in it.
 *
 * Empty `exceptions` means the exception does not exist, which is the default.
 */
export function templateExceptionApplies(
  resolution: Pick<PathResolution, "candidates">,
  exceptions: readonly string[],
): boolean {
  if (exceptions.length === 0) return false;
  const allowed = new Set(
    exceptions
      .map((e) => lexicalNormalise((e ?? "").trim()))
      .filter((e) => e.length > 0 && !e.includes("*") && !e.endsWith("/")),
  );
  if (allowed.size === 0) return false;
  return resolution.candidates.length > 0 && resolution.candidates.every((c) => allowed.has(c));
}
