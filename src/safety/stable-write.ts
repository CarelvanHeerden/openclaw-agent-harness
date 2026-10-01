import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

interface StagedWrite {
  readonly fd: number;
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
}

interface ArmedWrite {
  readonly path: string;
  readonly content: string;
  readonly parentPath: string;
  readonly parentFd: number;
  readonly parentDevice: number;
  readonly parentInode: number;
  readonly targetFd?: number;
  readonly targetDevice?: number;
  readonly targetInode?: number;
  readonly targetMode: number;
  readonly staged: StagedWrite;
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Owns ACP delegated writes through an identity acquired before permission is
 * returned. The exact approved bytes are written and synced to a fresh inode
 * before permission is returned. Commit performs no byte writes: it revalidates
 * every bound identity and atomically replaces the checked worktree pathname.
 * A hard link created after approval therefore cannot carry a later harness
 * mutation outside the worktree.
 */
export class StableWriteBroker {
  private readonly root: string;
  private readonly pending = new Map<string, ArmedWrite>();

  constructor(worktreePath: string, private readonly sync: (fd: number) => void = fsyncSync) {
    this.root = realpathSync(resolve(worktreePath));
    if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
      throw new Error("stable writes require O_NOFOLLOW and O_DIRECTORY support");
    }
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
    let parentFd: number | undefined;
    let targetFd: number | undefined;
    let staged: StagedWrite | undefined;
    try {
      parentFd = openSync(physicalParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const parentOpened = fstatSync(parentFd);
      if (!parentOpened.isDirectory() || !sameIdentity(parentBefore, parentOpened)) {
        throw new Error("stable write parent changed before descriptor acquisition");
      }
      targetFd = initial ? openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) : undefined;
      const opened = targetFd === undefined ? undefined : fstatSync(targetFd);
      if (opened && !opened.isFile()) throw new Error("stable write descriptor is not a regular file");
      if (initial && (!opened || !sameIdentity(initial, opened))) throw new Error("stable write target changed before descriptor acquisition");
      const parentAfter = statSync(physicalParent);
      if (!sameIdentity(parentBefore, parentAfter)) throw new Error("stable write parent changed before descriptor acquisition");
      const targetMode = initial ? initial.mode & 0o777 : 0o600;
      staged = this.createStage(physicalParent, targetMode, content);
      const armed: ArmedWrite = {
        path,
        content,
        parentPath: physicalParent,
        parentFd,
        parentDevice: parentAfter.dev,
        parentInode: parentAfter.ino,
        targetFd,
        targetDevice: opened?.dev,
        targetInode: opened?.ino,
        targetMode,
        staged,
      };
      this.assertParentUnchanged(armed);
      this.assertTargetUnchanged(armed);
      this.assertStageUnchanged(armed);
      this.sync(parentFd);
      this.pending.set(path, armed);
    } catch (error) {
      if (staged) this.discardStage(staged);
      if (targetFd !== undefined) closeSync(targetFd);
      if (parentFd !== undefined) closeSync(parentFd);
      throw error;
    }
  }

  commit(rawPath: string, content: string): void {
    const path = this.resolveTarget(rawPath);
    const armed = this.pending.get(path);
    if (!armed || armed.content !== content) throw new Error("delegated write did not match one exact approved mutation");
    this.pending.delete(path);
    try {
      this.assertParentUnchanged(armed);
      this.assertTargetUnchanged(armed);
      this.assertStageUnchanged(armed);
      this.assertParentUnchanged(armed);
      this.assertTargetUnchanged(armed);
      renameSync(armed.staged.path, armed.path);
      this.sync(armed.parentFd);
      const live = lstatSync(armed.path);
      if (live.isSymbolicLink() || !sameIdentity(live, { dev: armed.staged.device, ino: armed.staged.inode })) {
        throw new Error("stable write atomic replacement failed");
      }
      this.assertParentUnchanged(armed);
    } finally {
      this.discard(armed);
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
    const opened = fstatSync(armed.parentFd);
    const live = statSync(armed.parentPath);
    if (
      !opened.isDirectory() ||
      !sameIdentity(opened, { dev: armed.parentDevice, ino: armed.parentInode }) ||
      !sameIdentity(live, opened)
    ) {
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

  private assertStageUnchanged(armed: ArmedWrite): void {
    const opened = fstatSync(armed.staged.fd);
    const live = lstatSync(armed.staged.path);
    const expected = Buffer.from(armed.content, "utf8");
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== armed.staged.size ||
      !sameIdentity(opened, { dev: armed.staged.device, ino: armed.staged.inode }) ||
      live.isSymbolicLink() ||
      !live.isFile() ||
      !sameIdentity(live, opened) ||
      !this.readStage(armed.staged).equals(expected)
    ) {
      throw new Error("stable write staged content or identity changed after approval");
    }
  }

  private createStage(parentPath: string, targetMode: number, content: string): StagedWrite {
    const bytes = Buffer.from(content, "utf8");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const path = join(parentPath, `.oah-write-${randomBytes(18).toString("hex")}`);
      try {
        const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, targetMode);
        try {
          fchmodSync(fd, targetMode);
          const before = fstatSync(fd);
          if (!before.isFile() || before.nlink !== 1) throw new Error("stable write staging inode is not private");
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
          this.sync(fd);
          const opened = fstatSync(fd);
          const staged = { fd, path, device: opened.dev, inode: opened.ino, size: bytes.length };
          if (
            !opened.isFile() ||
            opened.nlink !== 1 ||
            opened.size !== bytes.length ||
            !this.readStage(staged).equals(bytes)
          ) {
            throw new Error("stable write staging inode did not retain the approved bytes");
          }
          return staged;
        } catch (error) {
          closeSync(fd);
          try { unlinkSync(path); } catch { /* best effort */ }
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
    throw new Error("stable write could not allocate a private staging inode");
  }

  private readStage(staged: StagedWrite): Buffer {
    const bytes = Buffer.alloc(staged.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(staged.fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("stable write staged content was truncated");
      offset += count;
    }
    return bytes;
  }

  private discard(armed: ArmedWrite): void {
    const removed = this.discardStage(armed.staged);
    if (removed) {
      try { this.sync(armed.parentFd); } catch { /* parent may have been replaced */ }
    }
    if (armed.targetFd !== undefined) {
      try {
        closeSync(armed.targetFd);
      } catch { /* already closed */ }
    }
    try {
      closeSync(armed.parentFd);
    } catch { /* already closed */ }
  }

  private discardStage(staged: StagedWrite): boolean {
    try { closeSync(staged.fd); } catch { /* already closed */ }
    try {
      const live = lstatSync(staged.path);
      if (!live.isSymbolicLink() && sameIdentity(live, { dev: staged.device, ino: staged.inode })) {
        unlinkSync(staged.path);
        return true;
      }
    } catch { /* renamed or already removed */ }
    return false;
  }
}
