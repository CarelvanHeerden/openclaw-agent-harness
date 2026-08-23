// "2180 tests as of 1.0.0-rc.1", still sitting in the README at 1.0.0-rc.2.
//
// The rc.2 bump updated the status line at the top of the README and missed two
// other places further down that pinned a count to a version. Nothing failed,
// because nothing was checking — the number is only wrong relative to a version
// string ten lines away, and no test knew the two were related.
//
// Checking the count itself would mean running the suite to count the suite, so
// this checks the half that is cheap and that actually broke: the version a
// claim is pinned to must be the version being shipped. Bump the version and
// this fails until you revisit the claim, which is the moment you would notice
// the count had moved too.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** `as of 1.0.0-rc.2` / `as of \`1.0.0-rc.2\``, wherever it appears. */
const AS_OF = /as of\s+`?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`?/g;

test("every 'as of <version>' claim in the README names the shipped version", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const claims = [...readme.matchAll(AS_OF)].map((m) => m[1]);
  assert.ok(claims.length > 0, "expected the README to pin at least one claim to a version");
  for (const claimed of claims) {
    assert.equal(
      claimed,
      pkg.version,
      `README claims something is true "as of ${claimed}" but package.json ships ${pkg.version}. ` +
        `Re-check the claim (a test count usually moved too), then update the version it cites.`,
    );
  }
});

test("the README status line names the shipped version", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const status = /\*Status:[^*]*\*\s*Version\s*`([^`]+)`/.exec(readme);
  assert.ok(status, "expected a '*Status: ...* Version `x.y.z`' line near the top of the README");
  assert.equal(status[1], pkg.version, "the README status line has fallen behind package.json");
});
