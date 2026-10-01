import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

interface ArmedWrite {
  readonly path: string;
  readonly content: string;
  readonly parentPath: string;
  readonly parentDevice: number;
  readonly parentInode: number;
  readonly targetFd?: number;
  readonly targetDevice?: number;
  readonly targetInode?: number;
  readonly targetMode: number;
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Owns ACP delegated writes through an identity acquired before permission is
 * returned. The approved inode is never mutated in place: commit writes a new
 * inode and atomically replaces the checked worktree pathname. A hard link
 * created after approval therefore retains the old bytes rather than carrying
 * a harness mutation outside the worktree.
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
    let initial: Stats | undefined;
    try {
      initial = lstatSync(path) as Stats;
      if (initial.isSymbolicLink() || !initial.isFile()) throw new Error("stable write target must be a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const old = this.pending.get(path);
    if (old) this.discard(old);
    const targetFd = initial ? openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) : undefined;
    try {
      const opened = targetFd === undefined ? undefined : fstatSync(targetFd);
      if (opened && !opened.isFile()) throw new Error("stable write descriptor is not a regular file");
      if (initial && (!opened || !sameIdentity(initial, opened))) throw new Error("stable write target changed before descriptor acquisition");
      const parentAfter = statSync(physicalParent);
      if (!sameIdentity(parentBefore, parentAfter)) throw new Error("stable write parent changed before descriptor acquisition");
      this.pending.set(path, {
        path,
        content,
        parentPath: physicalParent,
        parentDevice: parentAfter.dev,
        parentInode: parentAfter.ino,
        targetFd,
        targetDevice: opened?.dev,
        targetInode: opened?.ino,
        targetMode: initial ? initial.mode & 0o777 : 0o600,
      });
    } catch (error) {
      if (targetFd !== undefined) closeSync(targetFd);
      throw error;
    }
  }

  commit(rawPath: string, content: string): void {
    const path = this.resolveTarget(rawPath);
    const armed = this.pending.get(path);
    if (!armed || armed.content !== content) throw new Error("delegated write did not match one exact approved mutation");
    this.pending.delete(path);
    let staged: { fd: number; path: string; device: number; inode: number } | undefined;
    try {
      this.assertParentUnchanged(armed);
      this.assertTargetUnchanged(armed);
      staged = this.createStage(armed);
      const bytes = Buffer.from(content, "utf8");
      const stagedBeforeWrite = fstatSync(staged.fd);
      if (!sameIdentity(stagedBeforeWrite, { dev: staged.device, ino: staged.inode }) || stagedBeforeWrite.nlink !== 1) {
        throw new Error("stable write staging inode acquired an external alias");
      }
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(staged.fd, bytes, offset, bytes.length - offset, offset);
      fsyncSync(staged.fd);
      const stagedBeforeRename = fstatSync(staged.fd);
      if (!sameIdentity(stagedBeforeRename, { dev: staged.device, ino: staged.inode }) || stagedBeforeRename.nlink !== 1) {
        throw new Error("stable write staging inode acquired an external alias");
      }
      this.assertParentUnchanged(armed);
      this.assertTargetUnchanged(armed);
      renameSync(staged.path, armed.path);
      const live = lstatSync(armed.path);
      if (live.isSymbolicLink() || !sameIdentity(live, { dev: staged.device, ino: staged.inode })) throw new Error("stable write atomic replacement failed");
      this.assertParentUnchanged(armed);
    } finally {
      this.discard(armed);
      if (staged) this.discardStage(staged);
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

  private assertParentUnchanged(armed: ArmedWrite): void {
    const live = statSync(armed.parentPath);
    if (!sameIdentity(live, { dev: armed.parentDevice, ino: armed.parentInode })) {
      throw new Error("stable write parent changed after approval");
    }
  }

  private assertTargetUnchanged(armed: ArmedWrite): void {
    let live: Stats | undefined;
    try {
      live = lstatSync(armed.path) as Stats;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (armed.targetFd === undefined) {
      if (live) throw new Error("stable write pathname changed after approval");
      return;
    }
    const opened = fstatSync(armed.targetFd);
    if (
      !live ||
      live.isSymbolicLink() ||
      !live.isFile() ||
      !sameIdentity(opened, { dev: armed.targetDevice!, ino: armed.targetInode! }) ||
      !sameIdentity(live, opened)
    ) {
      throw new Error("stable write pathname changed after approval");
    }
  }

  private createStage(armed: ArmedWrite): { fd: number; path: string; device: number; inode: number } {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const path = join(armed.parentPath, `.oah-write-${randomBytes(18).toString("hex")}`);
      try {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, armed.targetMode);
        fchmodSync(fd, armed.targetMode);
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1) {
          closeSync(fd);
          try { unlinkSync(path); } catch { /* best effort */ }
          throw new Error("stable write staging inode is not private");
        }
        return { fd, path, device: opened.dev, inode: opened.ino };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
    throw new Error("stable write could not allocate a private staging inode");
  }

  private discard(armed: ArmedWrite): void {
    if (armed.targetFd === undefined) return;
    try {
      closeSync(armed.targetFd);
    } catch { /* already closed */ }
  }

  private discardStage(staged: { fd: number; path: string; device: number; inode: number }): void {
    try { closeSync(staged.fd); } catch { /* already closed */ }
    try {
      const live = lstatSync(staged.path);
      if (!live.isSymbolicLink() && sameIdentity(live, { dev: staged.device, ino: staged.inode })) unlinkSync(staged.path);
    } catch { /* renamed or already removed */ }
  }
}
