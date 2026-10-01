/**
 * Owns ACP delegated writes through a descriptor acquired before permission is
 * returned. Replacing the pathname after approval cannot redirect the write:
 * bytes go only to the already-opened inode, and a stale pathname is refused.
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
    private discard;
}
//# sourceMappingURL=stable-write.d.ts.map