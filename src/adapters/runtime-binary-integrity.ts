import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

interface NativePackageEntry {
  version: string;
  integrity: string;
  entries: string[];
}
interface NativeManifest { version: number; packages: Record<string, NativePackageEntry> }

export interface VerifiedRuntimeBinary {
  command: string;
  packageName: string;
  digest: string;
  cleanup(): void;
}

function expectedDigest(entry: NativePackageEntry, relativeBinary: string): string {
  const suffix = `  ${relativeBinary}`;
  const line = entry.entries.find((candidate) => candidate.endsWith(suffix));
  if (!line || !/^[a-f0-9]{64}  /.test(line)) throw new Error(`runtime integrity manifest is missing ${relativeBinary}`);
  return line.slice(0, 64);
}

function verifiedBytes(path: string, expected: string): Buffer {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) throw new Error(`runtime executable is not a regular file: ${path}`);
    const bytes = readFileSync(fd);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`runtime executable integrity check failed: ${path}`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function snapshot(bytes: Buffer, parent: string, prefix: string, filename: string): { command: string; cleanup(): void } {
  const directory = mkdtempSync(resolve(parent, prefix));
  chmodSync(directory, 0o700);
  const command = resolve(directory, filename);
  writeFileSync(command, bytes, { flag: "wx", mode: 0o500 });
  const metadata = lstatSync(command);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error("runtime executable snapshot is not a regular file");
  }
  return { command, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function loadManifest(pluginRoot: string, filename: string): NativeManifest {
  const path = resolve(pluginRoot, "scripts", filename);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`runtime integrity manifest is not a regular file: ${path}`);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as NativeManifest;
  if (manifest.version !== 1 || !manifest.packages) throw new Error(`invalid runtime integrity manifest: ${path}`);
  return manifest;
}

export function verifyClaudeRuntime(pluginRoot: string, snapshotParent: string): VerifiedRuntimeBinary {
  const requireFromPlugin = createRequire(resolve(pluginRoot, "package.json"));
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const isMusl = process.platform === "linux" && report?.header?.glibcVersionRuntime === undefined;
  const suffix = process.platform === "linux" ? `linux-${process.arch}${isMusl ? "-musl" : ""}` : `${process.platform}-${process.arch}`;
  const packageName = `@anthropic-ai/claude-agent-sdk-${suffix}`;
  const relativeBinary = process.platform === "win32" ? "claude.exe" : "claude";
  const packageRoot = dirname(requireFromPlugin.resolve(`${packageName}/package.json`));
  const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { version?: string };
  const manifest = loadManifest(pluginRoot, "claude-native-package-manifest.json");
  const entry = manifest.packages[packageName];
  if (!entry || entry.version !== packageJson.version) throw new Error(`Claude runtime package is not covered by the integrity manifest: ${packageName}`);
  const digest = expectedDigest(entry, relativeBinary);
  const bytes = verifiedBytes(resolve(packageRoot, relativeBinary), digest);
  return { ...snapshot(bytes, snapshotParent, ".oah-verified-claude-", basename(relativeBinary)), packageName, digest };
}

export function verifyOpenCodeRuntime(pluginRoot: string, snapshotParent: string): VerifiedRuntimeBinary {
  const requireFromPlugin = createRequire(resolve(pluginRoot, "package.json"));
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const base = `opencode-${platform}-${process.arch}`;
  const candidates = process.arch === "x64" ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`] : [base, `${base}-musl`];
  const manifest = loadManifest(pluginRoot, "opencode-native-package-manifest.json");
  for (const packageName of candidates) {
    const entry = manifest.packages[packageName];
    if (!entry) continue;
    try {
      const packageRoot = dirname(requireFromPlugin.resolve(`${packageName}/package.json`));
      const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { version?: string };
      if (entry.version !== packageJson.version) throw new Error(`OpenCode runtime version is not authenticated: ${packageName}`);
      const relativeBinary = `bin/${platform === "windows" ? "opencode.exe" : "opencode"}`;
      const digest = expectedDigest(entry, relativeBinary);
      const bytes = verifiedBytes(resolve(packageRoot, relativeBinary), digest);
      return { ...snapshot(bytes, snapshotParent, ".oah-verified-opencode-", basename(relativeBinary)), packageName, digest };
    } catch (error) {
      if (String(error).includes("Cannot find module")) continue;
      throw error;
    }
  }
  throw new Error(`OpenCode runtime package is not covered by the integrity manifest for ${platform}-${process.arch}`);
}
