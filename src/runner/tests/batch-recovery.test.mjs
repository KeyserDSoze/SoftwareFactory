import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { executeJob } from "../worker.mjs";
import { loadGuardedIndex } from "../workflows.mjs";
import { readReport } from "../common.mjs";
import { reconcilePendingBatch } from "../batch-recovery.mjs";

const key = "batch-recovery-key-abcdefghijk12345678900";
const origin = "http://localhost:5173";
const original = { consent: true, enforced: true, label: "Pending recovery", tasks: [
  { id: "build", role: "devops_engineer", dependsOn: [], request: {
    label:"Build",files:{"src/backend/domain/X.cs":"namespace X; public class X {}"},
    steps:["dotnet-build"],
  }},
  { id: "test", role: "tester", dependsOn: ["build"], request: {
    label:"Test",files:{"src/backend/domain/X.cs":"namespace X; public class X {}"},
    steps:["dotnet-build"],
  }},
]};
async function fixture() {
  const dataDir=await mkdtemp(path.join(tmpdir(),"sf-batch-recover-"));
  const server=createRunnerServer({
    apiKey:key,allowedOrigins:[origin],dataDir,maxQueued:6,maxRetained:10,
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const base="http://127.0.0.1:"+server.address().port;
  const create=async()=> {
    const response=await fetch(base+"/v1/workflows/batch",{method:"POST",
      headers:{Origin:origin,Authorization:"Bearer "+key,"Content-Type":"application/json",
        "Idempotency-Key":randomUUID()},body:JSON.stringify(original)});
    assert.equal(response.status,201);
    return response.json();
  };
  const get=async id => {
    const response=await fetch(base+"/v1/workflows/"+id,{
      headers:{Origin:origin,Authorization:"Bearer "+key}});
    return {status:response.status,body:await response.json()};
  };
  const execute=async id=>executeJob(id,{dataDir,workspaceRoot:path.join(dataDir,"workspace"),
    createStepPlan: step=>({step}),
    executeStep: async(plan,id,step)=>({step,state:"passed",exitCode:0,durationMs:5,timedOut:false})});
  const close=async()=>{
    await new Promise(resolve=>server.close(resolve));
    await rm(dataDir,{recursive:true,force:true});
  };
  return {dataDir,server,create,get,execute,close};
}
async function makePending(dataDir, id, { removeManifest=false, moveToStage=[] } = {}) {
  const recordPath=path.join(dataDir,"workflows",id+".json");
  const record=JSON.parse(await readFile(recordPath,"utf8"));
  const pending=path.join(dataDir,"workflows",".pending-"+id);
  const stage=path.join(dataDir,"workflow-staging",id);
  await mkdir(pending,{mode:0o700});
  const intent={
    version:1,id,tenantId:record.tenantId,
    jobs:record.tasks.map(t=>({id:t.jobId,digest:t.digest})),
    manifestHash:record.hash,
  };
  await writeFile(path.join(pending,"intent.json"),JSON.stringify(intent),{mode:0o600});
  for(const index of moveToStage){
    const task=record.tasks[index];
    await mkdir(path.join(stage,"jobs"),{recursive:true,mode:0o700});
    await rename(path.join(dataDir,"jobs",task.jobId),
      path.join(stage,"jobs",task.jobId));
  }
  if(removeManifest)await rm(recordPath);
  return {record,intent,pending,stage};
}

test("operator finalize verifies committed manifest and every queued journal, then removes only guard",async()=>{
  const f=await fixture();
  try{
    const board=await f.create(), id=board.id;
    const {pending}=await makePending(f.dataDir,id);
    await assert.rejects(loadGuardedIndex(f.dataDir),{code:"WORKFLOW_INTEGRITY"});
    const blocked=await f.execute(board.tasks[0].jobId);
    assert.fail("worker should never start with pending guard: "+blocked.state);
  }catch(error){
    if(error.code!=="WORKFLOW_INTEGRITY")throw error;
    // A marker is intentionally treated as a hard stop, not an incomplete test.
  }finally{await f.close();}
});

test("operator finalize recovers fully published batch without discarding its jobs",async()=>{
  const f=await fixture();
  try{
    const board=await f.create(), id=board.id;
    await makePending(f.dataDir,id);
    const recovered=await reconcilePendingBatch({dataDir:f.dataDir,id,action:"finalize"});
    assert.deepEqual(recovered,{version:1,id,action:"finalize",jobCount:2});
    assert.equal((await f.get(id)).status,200);
    assert.equal((await loadGuardedIndex(f.dataDir)).size,2);
    assert.equal((await readReport(f.dataDir,board.tasks[0].jobId)).state,"queued");
    assert.equal((await f.execute(board.tasks[0].jobId)).state,"passed");
  }finally{await f.close();}
});

test("abort removes only never-started jobs after simulated first rename, leaving no executable orphan",async()=>{
  const f=await fixture();
  try{
    const board=await f.create(), id=board.id;
    const {pending}=await makePending(f.dataDir,id,
      {removeManifest:true,moveToStage:[1]});
    await assert.rejects(loadGuardedIndex(f.dataDir),{code:"WORKFLOW_INTEGRITY"});
    const aborted=await reconcilePendingBatch({dataDir:f.dataDir,id,action:"abort"});
    assert.deepEqual(aborted,{version:1,id,action:"abort",jobCount:2});
    const stat=await Promise.all([
      f.get(id),
      readFile(path.join(pending,"intent.json")).then(()=>true,()=>false),
      readReport(f.dataDir,board.tasks[0].jobId).then(()=>true,()=>false),
      readReport(f.dataDir,board.tasks[1].jobId).then(()=>true,()=>false),
    ]);
    assert.equal(stat[0].status,404);
    assert.deepEqual(stat.slice(1),[false,false,false]);
    assert.equal((await loadGuardedIndex(f.dataDir)).size,0);
  }finally{await f.close();}
});

test("abort is repeatable after interruption during directory cleanup",async()=>{
  const f=await fixture();
  try{
    const board=await f.create(),id=board.id;
    await makePending(f.dataDir,id,{removeManifest:true});
    await rm(path.join(f.dataDir,"jobs",board.tasks[0].jobId),{recursive:true});
    const outcome=await reconcilePendingBatch({dataDir:f.dataDir,id,action:"abort"});
    assert.equal(outcome.action,"abort");
    assert.equal((await loadGuardedIndex(f.dataDir)).size,0);
  }finally{await f.close();}
});

test("abort fails closed for committed manifest; finalize fails closed on corrupted intent",async()=>{
  const f=await fixture();
  try{
    const board=await f.create(),id=board.id;
    const {pending,intent}=await makePending(f.dataDir,id);
    await assert.rejects(
      reconcilePendingBatch({dataDir:f.dataDir,id,action:"abort"}),
      {code:"BATCH_RECOVERY_BLOCKED"});
    assert.equal((await readReport(f.dataDir,board.tasks[0].jobId)).state,"queued");
    await writeFile(path.join(pending,"intent.json"),
      JSON.stringify({...intent,manifestHash:"a".repeat(64)}));
    await assert.rejects(
      reconcilePendingBatch({dataDir:f.dataDir,id,action:"finalize"}),
      {code:"BATCH_RECOVERY_BLOCKED"});
    await assert.rejects(loadGuardedIndex(f.dataDir),{code:"WORKFLOW_INTEGRITY"});
  }finally{await f.close();}
});

test("operator cannot abort jobs already started or claimed, even with a stale precommit manifest",async()=>{
  const f=await fixture();
  try{
    const board=await f.create(),id=board.id;
    assert.equal((await f.execute(board.tasks[0].jobId)).state,"passed");
    await makePending(f.dataDir,id,{removeManifest:true});
    await assert.rejects(
      reconcilePendingBatch({dataDir:f.dataDir,id,action:"abort"}),
      {code:"BATCH_RECOVERY_BLOCKED"});
    assert.equal((await readReport(f.dataDir,board.tasks[0].jobId)).state,"passed");
  }finally{await f.close();}
});


test("operator discards only uncommitted staging from a crash BEFORE any publish marker", async () => {
  const f=await fixture();
  try{
    const id=randomUUID(),staging=path.join(f.dataDir,"workflow-staging",id,"jobs");
    const partial=randomUUID();
    await mkdir(path.join(staging,partial),{recursive:true,mode:0o700});
    await writeFile(path.join(staging,partial,"input.json"),"{incomplete",
      {mode:0o600});
    await mkdir(path.join(f.dataDir,"workflows"),{mode:0o700});
    const response=await reconcilePendingBatch({
      dataDir:f.dataDir,id,action:"discard-stage",
    });
    assert.deepEqual(response,{version:1,id,action:"discard-stage",jobCount:1});
    await assert.rejects(readFile(path.join(staging,partial,"input.json")),
      {code:"ENOENT"});
  }finally{await f.close();}
});

test("discard-stage never erases a committed batch, pending guard, or a staged job also published live", async () => {
  const f=await fixture();
  try{
    const board=await f.create(),id=board.id;
    const stage=path.join(f.dataDir,"workflow-staging",id,"jobs");
    await mkdir(stage,{recursive:true,mode:0o700});
    await assert.rejects(
      reconcilePendingBatch({dataDir:f.dataDir,id,action:"discard-stage"}),
      {code:"BATCH_RECOVERY_BLOCKED"}); // manifest present
    await rm(path.join(f.dataDir,"workflows",id+".json"));
    await mkdir(path.join(stage,board.tasks[0].jobId),{mode:0o700});
    await assert.rejects(
      reconcilePendingBatch({dataDir:f.dataDir,id,action:"discard-stage"}),
      {code:"BATCH_RECOVERY_BLOCKED"}); // live job with same ID
    const marker=path.join(f.dataDir,"workflows",".pending-"+id);
    await mkdir(marker,{mode:0o700});
    await assert.rejects(
      reconcilePendingBatch({dataDir:f.dataDir,id,action:"discard-stage"}),
      {code:"BATCH_RECOVERY_BLOCKED"}); // pending guard
    assert.equal((await readReport(f.dataDir,board.tasks[0].jobId)).state,"queued");
  }finally{await f.close();}
});
