import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OWNER_FILE = ".oah-temp-owner.json";
const active = new Set();
let installed = false;

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function cleanupAll() {
  for (const path of [...active]) {
    active.delete(path);
    rmSync(path, { recursive: true, force: true });
  }
}

const signalNumber = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
const handlers = Object.fromEntries(Object.entries(signalNumber).map(([signal, number]) => [signal, () => {
  cleanupAll();
  process.exit(128 + number);
}]));

function installHandlers() {
  if (installed) return;
  installed = true;
  process.once("exit", cleanupAll);
  for (const [signal, handler] of Object.entries(handlers)) process.once(signal, handler);
}

function removeHandlersIfIdle() {
  if (!installed || active.size) return;
  installed = false;
  process.off("exit", cleanupAll);
  for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
}

export function pruneManagedTemps(parent, prefix, { staleAfterMs = 600_000, now = Date.now() } = {}) {
  if (!existsSync(parent)) return [];
  const removed = [];
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue;
    const path = join(parent, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let owner = {};
    try { owner = JSON.parse(readFileSync(join(path, OWNER_FILE), "utf8")); } catch {}
    if (processExists(Number(owner.pid))) continue;
    const createdAt = Number(owner.createdAt) || stat.mtimeMs;
    if (now - createdAt < staleAfterMs) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}

export function createManagedTemp(parent, prefix, options) {
  pruneManagedTemps(parent, prefix, options);
  const path = mkdtempSync(join(parent, prefix));
  writeFileSync(join(path, OWNER_FILE), `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
  active.add(path);
  installHandlers();
  let cleaned = false;
  return {
    path,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      active.delete(path);
      rmSync(path, { recursive: true, force: true });
      removeHandlersIfIdle();
    },
  };
}
