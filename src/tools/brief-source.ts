/**
 * beta.120 (brief fidelity): read the user's specification from disk instead of
 * trusting a calling agent to reproduce it.
 *
 * WHY THIS EXISTS. On the b119 take-2 smoke, OpenClaw was handed a 10,710-byte
 * markdown spec by the user and passed the harness a ~40-line paraphrase it had
 * written itself. The paraphrase changed the feature: `performedAt` (the date a
 * DR test was RUN) became `scheduledAt` (a date a test is PLANNED for), the
 * status vocabulary changed, and `exerciseType` / `nextDueAt` / `period` /
 * `results` / `relatedControlId` / the whole storage section were dropped. The
 * harness then built exactly what it was asked for -- correctly -- and the run
 * was worthless, twice, at ~$18 and ~2h each.
 *
 * The harness's own crystalliser is NOT the lossy step: the identical spec, read
 * off disk by scripts/local-drive.mjs and passed as bytes, crystallised with
 * every one of those fields intact. The loss happened in the hop between the
 * user's file and the tool call, because that hop was an LLM's recollection.
 * This module removes the hop.
 *
 * SECURITY. A path supplied by a calling agent is read by a process holding
 * GitHub tokens, and its contents end up in a brief, in model prompts, and in a
 * PR body -- i.e. potentially in public. So reads are refused unless the file
 * sits inside an operator-configured root (`brief.request_file_roots`), and the
 * feature is OFF until those roots are configured. Symlinks are resolved before
 * the root check so a link inside a root cannot reach outside it.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";

export interface RequestFileLimits {
  /** Absolute (or `~`-prefixed) directories a request file may be read from. Empty disables the feature. */
  allowedRoots: string[];
  /** Hard cap on file size. */
  maxBytes: number;
}

export type RequestFileRejection =
  | "disabled"
  | "not_absolute"
  | "outside_allowed_roots"
  | "not_found"
  | "not_a_file"
  | "too_large"
  | "binary"
  | "empty"
  | "denied_name"
  | "unreadable";

export type RequestFileResult =
  | { ok: true; text: string; bytes: number; resolvedPath: string }
  | { ok: false; code: RequestFileRejection; message: string };

/**
 * Filenames that are never a coding brief and frequently hold credentials. The
 * root allowlist is the real control; this is a second line so that pointing a
 * root at a home directory cannot trivially exfiltrate a token.
 */
const DENIED_BASENAMES: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^credentials(\.json)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
];

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith(`~${sep}`) || p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * True when `candidate` is the root itself or sits beneath it. Compares on path
 * segments so `/srv/briefs-secret` does not match a `/srv/briefs` root.
 */
export function isInsideRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const withSep = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(withSep);
}

interface FsLike {
  realpathSync: (p: string) => string;
  statSync: (p: string) => { isFile: () => boolean; size: number };
  readFileSync: (p: string, enc: "utf8") => string;
}

const REAL_FS: FsLike = {
  realpathSync: (p) => realpathSync(p),
  statSync: (p) => statSync(p),
  readFileSync: (p, enc) => readFileSync(p, enc),
};

/**
 * Read a user specification from disk, refusing anything that is not plainly a
 * brief sitting in an allowed location.
 */
export function readRequestFile(
  rawPath: string,
  limits: RequestFileLimits,
  fs: FsLike = REAL_FS,
): RequestFileResult {
  const roots = (limits.allowedRoots ?? []).filter((r) => typeof r === "string" && r.trim().length > 0);
  if (roots.length === 0) {
    return {
      ok: false,
      code: "disabled",
      message:
        "Reading a request from a file is disabled: no `brief.request_file_roots` are configured. Set that to the directory the user's brief files live in (e.g. the OpenClaw upload directory), or pass the full text as `request` instead.",
    };
  }

  const expanded = expandHome(rawPath);
  if (!isAbsolute(expanded)) {
    return { ok: false, code: "not_absolute", message: `requestPath must be absolute; got "${rawPath}".` };
  }

  // Resolve symlinks BEFORE the root check: a link planted inside an allowed
  // root must not become a read of /etc/shadow.
  let real: string;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    return { ok: false, code: "not_found", message: `No readable file at "${rawPath}".` };
  }

  const realRoots: string[] = [];
  for (const r of roots) {
    try {
      realRoots.push(fs.realpathSync(expandHome(r)));
    } catch {
      // A configured root that does not exist simply matches nothing.
    }
  }
  if (!realRoots.some((r) => isInsideRoot(real, r))) {
    return {
      ok: false,
      code: "outside_allowed_roots",
      message: `"${rawPath}" is outside every configured brief.request_file_roots entry (${roots.join(", ")}).`,
    };
  }

  const name = basename(real);
  if (DENIED_BASENAMES.some((re) => re.test(name))) {
    return { ok: false, code: "denied_name", message: `Refusing to read "${name}": that filename is on the credential denylist, not a brief.` };
  }

  let size: number;
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return { ok: false, code: "not_a_file", message: `"${rawPath}" is not a regular file.` };
    size = st.size;
  } catch {
    return { ok: false, code: "unreadable", message: `Could not stat "${rawPath}".` };
  }
  if (size > limits.maxBytes) {
    return {
      ok: false,
      code: "too_large",
      message: `"${rawPath}" is ${size} bytes; the cap is ${limits.maxBytes}. Trim the brief or raise brief.request_file_max_bytes.`,
    };
  }

  let text: string;
  try {
    text = fs.readFileSync(real, "utf8");
  } catch (err) {
    return { ok: false, code: "unreadable", message: `Could not read "${rawPath}": ${String(err)}` };
  }
  // A NUL byte means this is not the plain-text spec the caller thinks it is.
  if (text.includes("\u0000")) {
    return { ok: false, code: "binary", message: `"${rawPath}" looks binary, not a text brief.` };
  }
  if (text.trim().length === 0) {
    return { ok: false, code: "empty", message: `"${rawPath}" is empty.` };
  }

  return { ok: true, text, bytes: Buffer.byteLength(text, "utf8"), resolvedPath: real };
}

export interface ParaphraseDrift {
  /** Bytes of the authoritative on-disk spec. */
  fileBytes: number;
  /** Bytes of the `request` string the caller ALSO supplied. */
  paraphraseBytes: number;
  /** paraphraseBytes / fileBytes, rounded to 2dp. */
  ratio: number;
  /** Distinctive spec tokens present on disk but absent from the paraphrase. */
  droppedTerms: string[];
  /** True when the paraphrase is materially smaller or lost identifiers. */
  material: boolean;
}

/**
 * Identifier-shaped tokens: camelCase names, snake_case names, quoted paths and
 * table-ish names. These are the parts of a spec whose loss silently changes the
 * feature (`performedAt` -> `scheduledAt`), as opposed to prose the crystalliser
 * is meant to compress.
 */
const IDENTIFIER_RE = /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b|\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g;

/**
 * Compare a caller-supplied paraphrase against the authoritative file so the
 * audit log records, in numbers, that a paraphrase was offered and discarded.
 * Purely observational -- the file always wins.
 */
export function measureParaphraseDrift(fileText: string, paraphrase: string): ParaphraseDrift {
  const fileBytes = Buffer.byteLength(fileText, "utf8");
  const paraphraseBytes = Buffer.byteLength(paraphrase, "utf8");
  const fileTerms = new Set((fileText.match(IDENTIFIER_RE) ?? []).map((t) => t.toLowerCase()));
  const paraTerms = new Set((paraphrase.match(IDENTIFIER_RE) ?? []).map((t) => t.toLowerCase()));
  const dropped: string[] = [];
  for (const t of fileTerms) {
    if (!paraTerms.has(t)) dropped.push(t);
  }
  dropped.sort();
  const ratio = fileBytes > 0 ? Math.round((paraphraseBytes / fileBytes) * 100) / 100 : 1;
  return {
    fileBytes,
    paraphraseBytes,
    ratio,
    droppedTerms: dropped.slice(0, 40),
    material: ratio < 0.8 || dropped.length >= 5,
  };
}
