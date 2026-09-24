export interface VerifiedRuntimeBinary {
    command: string;
    packageName: string;
    digest: string;
    cleanup(): void;
}
export declare function verifyClaudeRuntime(pluginRoot: string, snapshotParent: string): VerifiedRuntimeBinary;
export declare function verifyOpenCodeRuntime(pluginRoot: string, snapshotParent: string): VerifiedRuntimeBinary;
//# sourceMappingURL=runtime-binary-integrity.d.ts.map