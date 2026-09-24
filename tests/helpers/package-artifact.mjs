import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createManagedTemp } from "../../scripts/managed-temp.mjs";

function run(command, args, cwd, env = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", ...env },
    timeout: 300_000,
  });
}

/**
 * Pack the exact committed HEAD from an isolated checkout with an independent
 * dependency tree. A reflink is copy-on-write and a normal copy is the fallback,
 * so parallel mutation tests cannot race through shared hard-link inodes. The
 * caller must invoke cleanup in a finally block.
 */
export function packIsolatedHead(root, prefix = "oah-package-artifact-") {
  // Keep the staging tree on the repository filesystem: node_modules is close
  // to 1 GB, and same-filesystem reflinks avoid duplicate allocation where supported.
  const managedTemp = createManagedTemp(dirname(root), `.${prefix}`);
  const temp = managedTemp.path;
  const cleanup = managedTemp.cleanup;
  try {
    const source = join(temp, "source");
    const packDir = join(temp, "pack");
    mkdirSync(packDir);
    run("git", ["clone", "--quiet", "--shared", root, source], temp);
    run("cp", ["-a", "--reflink=auto", join(root, "node_modules"), join(source, "node_modules")], temp);
    const packed = JSON.parse(run("npm", ["pack", source, "--json", "--pack-destination", packDir], temp, {
      npm_config_cache: join(temp, "npm-cache"),
    }));
    const artifact = packed[0] ?? Object.values(packed)[0];
    if (!artifact?.filename) throw new Error("npm pack did not report an artifact filename");
    return {
      temp,
      source,
      packDir,
      artifact,
      tarball: join(packDir, basename(artifact.filename)),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
