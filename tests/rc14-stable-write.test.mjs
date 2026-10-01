import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, fstatSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StableWriteBroker } from "../dist/safety/stable-write.js";

const fixture = () => mkdtempSync(join(tmpdir(), "stable-write-"));
const stagedPath = (root) => {
  const names=readdirSync(root).filter((name)=>name.startsWith(".oah-write-"));
  assert.equal(names.length,1);
  return join(root,names[0]);
};

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
    assert.equal(readFileSync(target,"utf8"),"old\n");
    assert.equal(readFileSync(stagedPath(root),"utf8"),"new\n");
    assert.throws(()=>broker.commit("README.md","different\n"),/exact approved mutation/);
    broker.commit("README.md","new\n");
    assert.equal(readFileSync(target,"utf8"),"new\n");
    assert.equal(statSync(target).mode&0o777,0o664);
    assert.equal(readdirSync(root).some((name)=>name.startsWith(".oah-write-")),false);
    broker.arm("created.txt","created\n");
    assert.equal(readFileSync(stagedPath(root),"utf8"),"created\n");
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

test("hard-linking staged bytes after approval refuses commit without a later alias mutation", () => {
  const root=fixture(),outside=fixture();
  try{
    const target=join(root,"README.md"),alias=join(outside,"alias.md");
    writeFileSync(target,"old\n");
    const broker=new StableWriteBroker(root);
    broker.arm("README.md","approved\n");
    const staged=stagedPath(root);
    assert.equal(readFileSync(staged,"utf8"),"approved\n");
    linkSync(staged,alias);
    assert.throws(()=>broker.commit("README.md","approved\n"),/staged content or identity changed/);
    assert.equal(readFileSync(target,"utf8"),"old\n");
    assert.equal(readFileSync(alias,"utf8"),"approved\n");
    assert.equal(readdirSync(root).some((name)=>name.startsWith(".oah-write-")),false);
    broker.close();
  }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test("tampering with staged bytes after approval refuses commit and cleans the stage", () => {
  const root=fixture();
  try{
    const target=join(root,"README.md");writeFileSync(target,"old\n");
    const broker=new StableWriteBroker(root);
    broker.arm("README.md","approved\n");
    writeFileSync(stagedPath(root),"tampered\n");
    assert.throws(()=>broker.commit("README.md","approved\n"),/staged content or identity changed/);
    assert.equal(readFileSync(target,"utf8"),"old\n");
    assert.equal(readdirSync(root).some((name)=>name.startsWith(".oah-write-")),false);
    broker.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("closing an abandoned approval removes its staged bytes without changing the target", () => {
  const root=fixture();
  try{
    const target=join(root,"README.md");writeFileSync(target,"old\n");
    const broker=new StableWriteBroker(root);
    broker.arm("README.md","approved\n");
    assert.equal(readFileSync(stagedPath(root),"utf8"),"approved\n");
    broker.close();
    assert.equal(readFileSync(target,"utf8"),"old\n");
    assert.equal(readdirSync(root).some((name)=>name.startsWith(".oah-write-")),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("approved bytes and directory entries are synced in publication order", () => {
  const root=fixture();
  try{
    const target=join(root,"README.md");writeFileSync(target,"old\n");
    const events=[];
    const broker=new StableWriteBroker(root,(fd)=>{
      const kind=fstatSync(fd).isDirectory()?"directory":"file";
      events.push({
        kind,
        target:readFileSync(target,"utf8"),
        stage:readdirSync(root).some((name)=>name.startsWith(".oah-write-")),
      });
      fsyncSync(fd);
    });
    broker.arm("README.md","approved\n");
    assert.deepEqual(events,[
      {kind:"file",target:"old\n",stage:true},
      {kind:"directory",target:"old\n",stage:true},
    ]);
    broker.commit("README.md","approved\n");
    assert.deepEqual(events[2],{kind:"directory",target:"approved\n",stage:false});
    broker.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("replacing the approved parent identity refuses publication", () => {
  const root=fixture();
  try{
    const parent=join(root,"sub"),moved=join(root,"moved");
    mkdirSync(parent);writeFileSync(join(parent,"README.md"),"old\n");
    const broker=new StableWriteBroker(root);
    broker.arm("sub/README.md","approved\n");
    const stageName=readdirSync(parent).find((name)=>name.startsWith(".oah-write-"));
    assert.ok(stageName);
    renameSync(parent,moved);
    mkdirSync(parent);
    linkSync(join(moved,"README.md"),join(parent,"README.md"));
    renameSync(join(moved,stageName),join(parent,stageName));
    assert.throws(()=>broker.commit("sub/README.md","approved\n"),/parent changed after approval/);
    assert.equal(readFileSync(join(parent,"README.md"),"utf8"),"old\n");
    assert.equal(readFileSync(join(moved,"README.md"),"utf8"),"old\n");
    broker.close();
  }finally{rmSync(root,{recursive:true,force:true});}
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
