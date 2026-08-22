// The floor tests, and the assumption none of them meant to make.
//
// Twenty-nine test files each assert that the shipped version is at or above
// the release that file was written for. Every one of them arrived at the same
// implementation independently:
//
//   const betaNum = (v) => parseInt(/beta\.(\d+)/.exec(v)?.[1] ?? "0", 10);
//   assert.ok(betaNum(pkg.version) >= 86);
//
// which reads as "at least beta.86" but means "is a beta, and its number is at
// least 86". The second clause is the one nobody wrote down, and it makes the
// suite refuse every version that is not a beta — including the 1.0.0 the betas
// were leading to. A release-candidate bump turned 29 green tests red without
// touching a line of behaviour.
//
// This is the second time the shape has bitten. beta.70's original assertion
// spelled the floor as an alternation over two-digit betas, so the first
// three-digit release broke it; the fix was copied into each file separately,
// which is why there are 29 closures to change instead of one.
//
// So the floor lives here once, and it is expressed the way the tests always
// meant it: where does this version sort relative to `0.1.0-beta.N`? A version
// that sorts above the entire beta line clears every floor, because it is by
// definition later than all of them.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

function parse(version) {
  const m = SEMVER.exec(String(version ?? "").trim());
  if (!m) return null;
  return {
    release: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : null,
  };
}

function comparePre(a, b) {
  // Semver 11.4: a version with a prerelease sorts below the same release
  // without one, and identifiers are compared left to right, numeric before
  // alphanumeric.
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Semver precedence: -1, 0 or 1. Unparseable sorts below everything. */
export function compareSemver(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa.release[i] !== pb.release[i]) return pa.release[i] < pb.release[i] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

const BETA = /^0\.1\.0-beta\.(\d+)$/;

/**
 * The number to compare a `>= N` floor against.
 *
 * A `0.1.0-beta.N` yields N. Anything sorting above the whole beta line —
 * `0.1.0` itself, `1.0.0-rc.1`, `1.0.0` — yields Infinity, so it clears every
 * floor without each test needing to know the scheme changed. Anything below,
 * or unparseable, yields -1 so a floor still fails rather than passing blind.
 */
export function betaOrdinal(version) {
  const raw = String(version ?? "").trim();
  const beta = BETA.exec(raw);
  if (beta) return Number(beta[1]);
  if (!parse(raw)) return -1;
  return compareSemver(raw, "0.1.0-beta.0") >= 0 ? Infinity : -1;
}

/** `pluginVersion: "..."` out of the text of `src/version.ts`. */
export function pluginVersionOf(versionTsSource) {
  return /pluginVersion:\s*"([^"]+)"/.exec(String(versionTsSource ?? ""))?.[1] ?? "";
}
