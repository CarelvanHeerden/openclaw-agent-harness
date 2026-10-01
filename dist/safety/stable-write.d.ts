/**
 * Owns ACP delegated writes through an identity acquired before permission is
 * returned. The exact approved bytes are written and synced to a fresh inode
 * before permission is returned. Commit performs no byte writes: it revalidates
 * every bound identity and atomically replaces the checked worktree pathname.
 * A hard link created after approval therefore cannot carry a later harness
 * mutation outside the worktree.
 */
export declare class StableWriteBroker {
    private readonly sync;
    private readonly root;
    private readonly pending;
    constructor(worktreePath: string, sync?: (fd: number) => void);
    arm(rawPath: string, content: string): void;
    commit(rawPath: string, content: string): void;
    close(): void;
    private resolveTarget;
    private assertWithin;
    private assertParentUnchanged;
    private assertTargetUnchanged;
    private assertStageUnchanged;
    private createStage;
    private readStage;
    private discard;
    private discardStage;
}
//# sourceMappingURL=stable-write.d.ts.map