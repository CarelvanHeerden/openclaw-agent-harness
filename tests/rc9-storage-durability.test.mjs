import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateStoreSync } from "../dist/state/store.js";
test("canonical control storage survives close and reopen",()=>{const dir=mkdtempSync(join(tmpdir(),"control-storage-")),path=join(dir,"state.db");let s=openStateStoreSync(path);s.db.prepare(`INSERT INTO control_metadata(key,value,updated_at) VALUES('receipt','durable',1)`).run();s.close();s=openStateStoreSync(path);assert.equal(s.db.prepare(`SELECT value FROM control_metadata WHERE key='receipt'`).get().value,"durable");for(const table of ["control_runs","control_proposals","control_host_attestations","control_dispatch_intents","control_readiness_attestations","control_merge_authorizations","control_engine_merge_intents"])assert.equal(s.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name=?").get(table).n,1,table);assert.equal(s.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='control_changes'").get().n,0);s.close();rmSync(dir,{recursive:true,force:true});});
