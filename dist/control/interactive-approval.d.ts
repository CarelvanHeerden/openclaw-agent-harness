import type { DatabaseSync } from "node:sqlite";
import type { HarnessPluginApi, HarnessToolContext } from "../index.js";
import { type ControlPlaneService } from "./service.js";
export declare const CONTROL_INTERACTIVE_NAMESPACE = "openclaw-agent-harness.control";
export declare class InteractiveControlApprovals {
    private readonly db;
    private readonly service;
    private readonly api;
    private readonly authorisedUsers;
    private readonly now;
    private readonly enabled;
    private readonly availabilityCode;
    private mergeTimer?;
    private readonly diagnostics;
    constructor(db: DatabaseSync, service: ControlPlaneService, api: HarnessPluginApi, authorisedUsers: readonly string[], now?: () => number);
    register(): () => void;
    presentConfirmation(changeId: string, context: HarnessToolContext): Promise<boolean>;
    presentMerge(changeId: string): Promise<boolean>;
    diagnostic(changeId: string): string;
    private presentPendingApprovals;
    private present;
    private handle;
    private storeBinding;
    private loadBinding;
    private unavailable;
}
//# sourceMappingURL=interactive-approval.d.ts.map