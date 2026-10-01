/**
 * Owns ACP delegated writes through an identity acquired before permission is
 * returned. The approved inode is never mutated in place: commit writes a new
 * inode and atomically replaces the checked worktree pathname. A hard link
 * created after approval therefore retains the old bytes rather than carrying
 * a harness mutation outside the worktree.
 */
export declare class StableWriteBroker {
    private readonly root;
    private readonly pending;
    constructor(worktreePath: string);
    arm(rawPath: string, content: string): void;
    commit(rawPath: string, content: string): void;
    close(): void;
    private resolveTarget;
    private assertWithin;
    private assertParentUnchanged;
    private assertTargetUnchanged;
    private createStage;
    private discard;
    private discardStage;
}
//# sourceMappingURL=stable-write.d.ts.map