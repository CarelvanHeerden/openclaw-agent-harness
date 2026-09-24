import type { DatabaseSync } from "node:sqlite";
export interface StateMigration {
    readonly id: string;
    readonly sql: string;
}
export declare const STATE_MIGRATIONS: readonly StateMigration[];
export declare function applyStateMigrations(db: DatabaseSync, migrations?: readonly StateMigration[]): void;
//# sourceMappingURL=migrations.d.ts.map