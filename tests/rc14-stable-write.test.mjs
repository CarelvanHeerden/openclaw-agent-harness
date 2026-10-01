import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StableWriteBroker } from "../dist/safety/stable-write.js";

const fixture = () => mkdtempSync(join(tmpdir(), "stable-write-"));

test("descriptor-bound writes cannot be redirected after permission", () => {
  const root=fixture(),outside=fixture();
  try{
    const target=join(root,"README.md"),victim=join(outside,"victim.md");
    writeFileSync(target,"old\n");writeFileSync(victim,"outside\n");
    const broker=new StableWriteBroker(root);
    broker.arm(target,"approved\n");
    unlinkSync(target);symlinkSync(victim,target);
    assert.throws(()=>broker.commit(target,"approved\n"),/pathname changed after approval/);
    assert.equal(readFileSync(victim,"utf8"),"outside\n");
    broker.close();
  }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test("stable writes require the exact approved content and preserve normal edits", () => {
  const root=fixture();
  try{
    const target=join(root,"README.md");writeFileSync(target,"old\n");
    chmodSync(target,0o664);
    const broker=new StableWriteBroker(root);
    broker.arm("README.md","new\n");
    assert.throws(()=>broker.commit("README.md","different\n"),/exact approved mutation/);
    broker.commit("README.md","new\n");
    assert.equal(readFileSync(target,"utf8"),"new\n");
    assert.equal(statSync(target).mode&0o777,0o664);
    broker.arm("created.txt","created\n");
    broker.commit("created.txt","created\n");
    assert.equal(readFileSync(join(root,"created.txt"),"utf8"),"created\n");
    broker.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("hard links created after approval cannot carry writes outside the worktree", () => {
  const root=fixture(),outside=fixture();
  try{
    const target=join(root,"README.md"),alias=join(outside,"alias.md");
    writeFileSync(target,"old\n");
    const broker=new StableWriteBroker(root);
    broker.arm("README.md","approved\n");
    linkSync(target,alias);
    broker.commit("README.md","approved\n");
    assert.equal(readFileSync(target,"utf8"),"approved\n");
    assert.equal(readFileSync(alias,"utf8"),"old\n");
    assert.notEqual(statSync(target).ino,statSync(alias).ino);
    broker.close();
  }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test("stable writes refuse a symlink before permission is returned", () => {
  const root=fixture(),outside=fixture();
  try{
    const victim=join(outside,"victim.md");writeFileSync(victim,"outside\n");symlinkSync(victim,join(root,"README.md"));
    const broker=new StableWriteBroker(root);
    assert.throws(()=>broker.arm("README.md","new\n"),/regular file/);
    assert.equal(readFileSync(victim,"utf8"),"outside\n");
    broker.close();
  }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
