import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(ROOT, "openclaw.plugin.json"), "utf8"));

function makePackage(root, version, stale = false) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "openclaw-agent-harness",
      version,
      type: "module",
      files: ["openclaw.plugin.json", "skills"],
    }),
  );
  writeFileSync(join(root, "openclaw.plugin.json"), JSON.stringify({ skills: manifest.skills }));
  for (const skillDir of manifest.skills) {
    const destination = join(root, skillDir);
    mkdirSync(destination, { recursive: true });
    if (stale) {
      writeFileSync(join(destination, "SKILL.md"), `stale ${version} ${skillDir}\n`);
    } else {
      cpSync(join(ROOT, skillDir, "SKILL.md"), join(destination, "SKILL.md"));
    }
  }
}

function pack(packageRoot, destination) {
  const output = execFileSync(
    "npm",
    ["pack", "--silent", "--pack-destination", destination],
    { cwd: packageRoot, encoding: "utf8" },
  ).trim();
  return join(destination, basename(output.split(/\r?\n/).at(-1)));
}

test("rc13: upgrading the package replaces every installed skill", () => {
  const temp = mkdtempSync(join(tmpdir(), "oah-skill-upgrade-"));
  const oldPackage = join(temp, "old");
  const newPackage = join(temp, "new");
  const tarballs = join(temp, "tarballs");
  const installRoot = join(temp, "install");
  mkdirSync(tarballs);
  mkdirSync(installRoot);

  try {
    makePackage(oldPackage, "2.0.0-rc.12", true);
    makePackage(newPackage, "2.0.0-rc.13");
    const oldTarball = pack(oldPackage, tarballs);
    const newTarball = pack(newPackage, tarballs);

    writeFileSync(join(installRoot, "package.json"), JSON.stringify({ private: true }));
    execFileSync("npm", ["install", "--ignore-scripts", "--omit=dev", oldTarball], {
      cwd: installRoot,
      stdio: "pipe",
    });
    execFileSync("npm", ["install", "--ignore-scripts", "--omit=dev", newTarball], {
      cwd: installRoot,
      stdio: "pipe",
    });

    const installedRoot = join(installRoot, "node_modules", "openclaw-agent-harness");
    const installedPackage = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
    assert.equal(installedPackage.version, "2.0.0-rc.13");
    for (const skillDir of manifest.skills) {
      const expected = readFileSync(join(ROOT, skillDir, "SKILL.md"));
      const installed = readFileSync(join(installedRoot, skillDir, "SKILL.md"));
      assert.deepEqual(installed, expected, `${skillDir}/SKILL.md was refreshed by the update`);
      assert.doesNotMatch(installed.toString("utf8"), /^stale /);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
