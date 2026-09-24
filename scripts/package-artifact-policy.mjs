import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function publishedPackageBytes(sourceBytes) {
  const manifest = JSON.parse(Buffer.isBuffer(sourceBytes) ? sourceBytes.toString("utf8") : sourceBytes);
  delete manifest.scripts;
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function contentManifest(packageRoot, files) {
  const entries = files.map((file) => {
    const digest = createHash("sha256").update(readFileSync(resolve(packageRoot, file))).digest("hex");
    return `${digest}  ${file}`;
  });
  return {
    files: entries.length,
    digest: createHash("sha256").update(entries.join("\n")).digest("hex"),
    entries,
  };
}
