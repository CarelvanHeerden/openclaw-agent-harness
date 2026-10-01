import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

interface ArmedWrite {
  readonly fd: number;
  readonly path: string;
  readonly content: string;
  readonly device: number;
  readonly inode: number;
  readonly created: boolean;
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Owns ACP delegated writes through a descriptor acquired before permission is
 * returned. Replacing the pathname after approval cannot redirect the write:
 * bytes go only to the already-opened inode, and a stale pathname is refused.
 */
export class StableWriteBroker {
  private readonly root: string;
  private readonly pending = new Map<string, ArmedWrite>();

  constructor(worktreePath: string) {
    this.root = realpathSync(resolve(worktreePath));
    if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error("stable writes require O_NOFOLLOW support");
  }

  arm(rawPath: string, content: string): void {
    const path = this.resolveTarget(rawPath);
    const parent = dirname(path);
    const physicalParent = realpathSync(parent);
    this.assertWithin(physicalParent, true);
    const parentBefore = statSync(physicalParent);
    let created = false;
    let initial: Stats | undefined;
    try {
      initial = lstatSync(path) as Stats;
      if (initial.isSymbolicLink() || !initial.isFile()) throw new Error("stable write target must be a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      created = true;
    }

    const old = this.pending.get(path);
    if (old) this.discard(old);
    const flags = constants.O_WRONLY | constants.O_NOFOLLOW |
      (created ? constants.O_CREAT | constants.O_EXCL : 0);
    const fd = openSync(path, flags, 0o600);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile()) throw new Error("stable write descriptor is not a regular file");
      if (initial && !sameIdentity(initial, opened)) throw new Error("stable write target changed before descriptor acquisition");
      const parentAfter = statSync(physicalParent);
      if (!sameIdentity(parentBefore, parentAfter)) throw new Error("stable write parent changed before descriptor acquisition");
      this.pending.set(path, { fd, path, content, device: opened.dev, inode: opened.ino, created });
    } catch (error) {
      closeSync(fd);
      if (created) {
        try { unlinkSync(path); } catch { /* best effort removal of our empty placeholder */ }
      }
      throw error;
    }
  }

  commit(rawPath: string, content: string): void {
    const path = this.resolveTarget(rawPath);
    const armed = this.pending.get(path);
    if (!armed || armed.content !== content) throw new Error("delegated write did not match one exact approved mutation");
    this.pending.delete(path);
    try {
      const before = fstatSync(armed.fd);
      if (!sameIdentity(before, { dev: armed.device, ino: armed.inode })) throw new Error("stable write descriptor identity changed");
      ftruncateSync(armed.fd, 0);
      const bytes = Buffer.from(content, "utf8");
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(armed.fd, bytes, offset, bytes.length - offset, offset);
      fsyncSync(armed.fd);
      const live = lstatSync(path);
      if (live.isSymbolicLink() || !sameIdentity(live, { dev: armed.device, ino: armed.inode })) {
        throw new Error("stable write pathname changed after approval; mutation was not redirected");
      }
    } finally {
      closeSync(armed.fd);
    }
  }

  close(): void {
    for (const armed of this.pending.values()) this.discard(armed);
    this.pending.clear();
  }

  private resolveTarget(rawPath: string): string {
    const raw = rawPath.trim();
    if (!raw || /^[A-Za-z]:/.test(raw) || /^(?:\\\\|\/\/)/.test(raw)) throw new Error("ambiguous Windows path is not a stable write target");
    const lexical = resolve(this.root, raw.replaceAll("\\", "/"));
    const target = join(realpathSync(dirname(lexical)), basename(lexical));
    this.assertWithin(target);
    return target;
  }

  private assertWithin(target: string, allowRoot = false): void {
    const rel = relative(this.root, target);
    if ((!rel && !allowRoot) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error("stable write target escapes the worktree");
    }
  }

  private discard(armed: ArmedWrite): void {
    try {
      const opened = fstatSync(armed.fd);
      closeSync(armed.fd);
      if (!armed.created) return;
      const live = lstatSync(armed.path);
      if (!live.isSymbolicLink() && sameIdentity(opened, live)) unlinkSync(armed.path);
    } catch {
      try { closeSync(armed.fd); } catch { /* already closed */ }
    }
  }
}
