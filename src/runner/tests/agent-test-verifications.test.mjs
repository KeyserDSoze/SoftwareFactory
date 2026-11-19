import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { validateRequest } from "../common.mjs";
import { admitRunnerJob, withAdmissionLock } from "../admission.mjs";
import { executeJob } from "../worker.mjs";
import { verifyJobEvidenceForRead } from "../evidence.mjs";

const rootKey="journal-test-root-key-abcdefghijklmnopqrstuvwxyz";
const actorKey="agent.tester-one."+"T".repeat(48);
const reviewerKey="agent.reviewer-one."+"R".repeat(48);
const wrongRoleKey="agent.tester-one."+"W".repeat(48);
const foreignKey="agent.tester-one."+"F".repeat(48);
const origin="http://localhost:5173";
const draft=()=>({
  consent:true,label:"Journal verified tester handoff",
  budgetUnits:4,tasks:[
    {id:"test",role:"tester",owner:"tester-one",
      dependsOn:[],estimatedUnits:2,maxAttempts:2},
    {id:"review",role:"code_reviewer",owner:"reviewer-one",
      dependsOn:["test"],estimatedUnits:2,maxAttempts:1},
  ],
});
const request=steps=>validateRequest({label:"Actual worker journal proof",
  files:{"src/backend/domain/X.cs":"namespace X; public class X {}"},
  steps,
});
async function fixture({multiTenant=false}={}) {
  const base=await mkdtemp(path.join(tmpdir(),"sf-journal-link-"));
  const dataDir=path.join(base,"data"),workDir=path.join(base,"workspace");
  const actorFile=path.join(base,"actors.json"),tenantFile=path.join(base,"tenants.json");
  const tenantKey="alpha."+"a".repeat(40),bravo="bravo."+"b".repeat(40);
  await writeFile(actorFile,JSON.stringify({version:1,actors:[
    {id:"tester-one",role:"tester",tenantId:null,key:actorKey},
    {id:"reviewer-one",role:"code_reviewer",tenantId:null,key:reviewerKey},
    {id:"tester-one",role:"code_reviewer",tenantId:null,key:wrongRoleKey},
    {id:"tester-one",role:"tester",tenantId:"alpha",key:foreignKey},
  ]}),{mode:0o600});
  if(multiTenant)await writeFile(tenantFile,JSON.stringify({version:1,tenants:[
    {id:"alpha",key:tenantKey,maxQueued:4,maxRetained:15,maxAcceptedPerMinute:0},
    {id:"bravo",key:bravo,maxQueued:4,maxRetained:15,maxAcceptedPerMinute:0},
  ]}),{mode:0o600});
  const servers=[0,1].map(()=>createRunnerServer({
    apiKey:multiTenant?"":rootKey,
    tenantsFile:multiTenant?tenantFile:"",
    dataDir,allowedOrigins:[origin],agentActorsFile:actorFile,
  }));
  for(const s of servers){s.listen(0,"127.0.0.1");await once(s,"listening");}
  const url=servers.map(s=>"http://127.0.0.1:"+s.address().port);
  const call=async(i,method,endpoint,body,token=multiTenant?tenantKey:rootKey)=>{
    const res=await fetch(url[i]+endpoint,{method,headers:{
      Origin:origin,Authorization:"Bearer "+token,
      ...(body===undefined?{}:{"Content-Type":"application/json"}),
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:res.status,body:await res.json()};
  };
  const board=async()=> {
    const r=await call(0,"POST","/v1/agent-handoffs",draft());
    // Hand-off registration needs an explicit idempotency key.
    return r;
  };
  const create=async()=> {
    const r=await fetch(url[0]+"/v1/agent-handoffs",{
      method:"POST",headers:{Origin:origin,
        Authorization:"Bearer "+(multiTenant?tenantKey:rootKey),
        "Content-Type":"application/json","Idempotency-Key":randomUUID()},
      body:JSON.stringify(draft()),
    });
    const data=await r.json();
    assert.equal(r.status,201,JSON.stringify(data));
    return data.id;
  };
  const claim=(i,id,taskId="test",token=multiTenant?foreignKey:actorKey)=>
    call(i,"POST","/v1/agent-task-leases",
      {action:"claim",handoffId:id,taskId,ttlSeconds:90},token);
  const verify=(i,id,lease,job,overrides={},token=multiTenant?foreignKey:actorKey)=>
    call(i,"POST","/v1/agent-task-verifications",{
      handoffId:id,taskId:"test",leaseId:lease,
      submissionId:randomUUID(),jobId:job.report.id,jobDigest:job.report.digest,
      jobHead:job.head,jobCount:job.entries.length,step:"dotnet-test",
      ...overrides,
    },token);
  const view=(i,id,token=multiTenant?tenantKey:rootKey)=>
    call(i,"GET","/v1/agent-handoffs/"+id,undefined,token);
  const run=async({steps=["dotnet-test"],state="passed",tenantId=multiTenant?"alpha":null}={})=>{
    const checked=request(steps);
    const admit=await admitRunnerJob({
      dataDir,checked,tenant:tenantId?{
        id:tenantId,maxQueued:4,maxRetained:15,maxAcceptedPerMinute:0,
      }:null,
    });
    if(state==="queued")return verifyJobEvidenceForRead(dataDir,admit.id);
    const report=await executeJob(admit.id,{
      dataDir,workspaceRoot:workDir,
      createStepPlan:step=>({step}),
      executeStep:async(_plan,_id,step)=>({
        step,state,exitCode:state==="passed"?0:state==="failed"?1:undefined,
        durationMs:3,timedOut:false,
        ...(state==="skipped"?{reason:"dependency setup not available"}:{}),
      }),
    });
    assert.equal(report.state,state==="skipped"?"incomplete":state);
    return verifyJobEvidenceForRead(dataDir,admit.id);
  };
  const close=async()=>{
    await Promise.all(servers.map(s=>new Promise(ok=>s.close(ok))));
    await rm(base,{recursive:true,force:true});
  };
  return {base,dataDir,actorFile,tenantFile,tenantKey,bravo,call,create,
    claim,verify,view,run,close};
}
test("real worker journal binding: tester completes only a passed code-test and reviewer becomes claimable",async()=>{
  const f=await fixture();
  try{
    const id=await f.create();
    const lease=await f.claim(0,id);
    assert.equal(lease.status,200,JSON.stringify(lease.body));
    assert.equal((await f.claim(1,id,"review",reviewerKey)).status,409);
    await sleep(16); // job acceptedAt must be after the task's lease claim
    const job=await f.run();
    const submissionId=randomUUID();
    const [a,b]=await Promise.all([
      f.verify(0,id,lease.body.leaseId,job,{submissionId}),
      f.verify(1,id,lease.body.leaseId,job,{submissionId}),
    ]);
    assert.deepEqual([a.status,b.status].sort(),[200,201],JSON.stringify({a,b}));
    assert.equal(a.body.state,"runner_verified_test");
    assert.equal(a.body.jobId,job.report.id);
    assert.equal(a.body.evidence.head,job.head);
    const current=await f.view(1,id);
    assert.equal(current.status,200,JSON.stringify(current.body));
    assert.equal(current.body.verifiedTestJobs,1);
    assert.equal(current.body.executions,0);
    assert.equal(current.body.approvedReportedUnits,0);
    assert.deepEqual(current.body.tasks.map(t=>t.state),["runner_verified_test","ready"]);
    assert.equal(current.body.tasks[0].evidence,"verified_runner_journal");
    assert.equal(current.body.tasks[0].testEvidence.step,"dotnet-test");
    assert.equal(JSON.stringify(current.body).includes(lease.body.leaseId),false);
    assert.equal(JSON.stringify(current.body).includes('"passed"'),false);
    assert.equal((await f.claim(1,id,"review",reviewerKey)).status,200);
    assert.equal((await f.claim(0,id,"test")).status,409);
    const raw=await readFile(path.join(f.dataDir,"agent-handoffs",id+".json"),"utf8");
    assert.equal(raw.includes(actorKey),false);
    assert.equal(raw.includes(rootKey),false);
  }finally{await f.close();}
});
test("missing, queued, failed and skipped worker jobs never verify a Tester task",async()=>{
  const f=await fixture();
  try{
    const id=await f.create(),lease=await f.claim(0,id);
    assert.equal(lease.status,200);
    await sleep(14);
    for(const state of ["queued","failed","skipped"]){
      const job=await f.run({state});
      const res=await f.verify(0,id,lease.body.leaseId,job);
      assert.equal(res.status,409,JSON.stringify(res));
      assert.equal(res.body.error,"test_evidence_invalid");
    }
    const invalid=await f.verify(0,id,lease.body.leaseId,
      {report:{id:randomUUID(),digest:"a".repeat(64)},
        head:"b".repeat(64),entries:[{}]});
    assert.equal(invalid.status,409);
    const current=await f.view(1,id);
    assert.equal(current.body.tasks[0].state,"leased");
    assert.equal(current.body.tasks[1].state,"blocked");
    assert.equal(current.body.verifiedTestJobs,0);
  }finally{await f.close();}
});
test("forged report digest, journal head, count, step and unauthorized roles fail closed",async()=>{
  const f=await fixture();
  try {
    const id=await f.create(),lease=await f.claim(0,id);
    await sleep(16);
    const job=await f.run();
    const overrides=[
      {jobDigest:"a".repeat(64)}, {jobHead:"f".repeat(64)},
      {jobCount:99},{step:"web-test"},
      {step:"dotnet-build"},
      {passed:true},{apiKey:"secret"},
    ];
    for(const change of overrides){
      const r=await f.verify(0,id,lease.body.leaseId,job,change);
      assert.ok([409,422].includes(r.status),JSON.stringify(r));
    }
    assert.equal((await f.verify(0,id,lease.body.leaseId,job,{},rootKey)).status,401);
    assert.equal((await f.verify(0,id,lease.body.leaseId,job,{},reviewerKey)).status,403);
    assert.equal((await f.verify(0,id,lease.body.leaseId,job,{},wrongRoleKey)).status,404);
  }finally{await f.close();}
});
test("old job predating claim, stale lease and no reused proof between handoffs",async()=>{
  const f=await fixture();
  try{
    const old=await f.run();
    await sleep(16);
    const id=await f.create(),lease=await f.claim(0,id);
    assert.equal((await f.verify(0,id,lease.body.leaseId,old)).status,409);
    const otherId=await f.create(),second=await f.claim(1,otherId);
    await sleep(16);
    const passed=await f.run();
    assert.equal((await f.verify(0,id,lease.body.leaseId,passed)).status,201);
    assert.equal((await f.verify(1,otherId,second.body.leaseId,passed)).status,409);
    const reply=await f.call(0,"POST","/v1/agent-task-leases",{
      action:"release",handoffId:otherId,taskId:"test",leaseId:second.body.leaseId,
    },actorKey);
    assert.equal(reply.status,200);
    assert.equal((await f.verify(1,otherId,second.body.leaseId,passed)).status,409);
  }finally{await f.close();}
});
test("tenant-bound verification refuses a different tenant's passed job or root actor",async()=>{
  const f=await fixture({multiTenant:true});
  try{
    const id=await f.create();
    const lease=await f.claim(0,id);
    assert.equal(lease.status,200);
    await sleep(16);
    const foreign=await f.run({tenantId:"bravo"});
    const r=await f.verify(0,id,lease.body.leaseId,foreign);
    assert.equal(r.status,409);
    assert.equal((await f.verify(0,id,lease.body.leaseId,foreign,{},actorKey)).status,404);
    assert.equal((await f.verify(0,id,lease.body.leaseId,foreign,{},f.tenantKey)).status,401);
    const valid=await f.run({tenantId:"alpha"});
    assert.equal((await f.verify(0,id,lease.body.leaseId,valid)).status,201);
    assert.equal((await f.view(1,id,f.bravo)).status,404);
    assert.equal((await f.view(1,id,f.tenantKey)).body.verifiedTestJobs,1);
  }finally{await f.close();}
});
test("journal corruption and retention invalidate handoff reads after completion",async()=>{
  const f=await fixture();
  try{
    const id=await f.create(),lease=await f.claim(0,id);
    await sleep(16);
    const job=await f.run();
    assert.equal((await f.verify(0,id,lease.body.leaseId,job)).status,201);
    const file=path.join(f.dataDir,"jobs",job.report.id,"evidence.jsonl");
    await writeFile(file,"tampered\n",{mode:0o600});
    const read=await f.view(0,id);
    assert.notEqual(read.status,200);
    assert.equal((await f.claim(1,id,"review",reviewerKey)).status,404);
    // An operator may eventually remove the retained evidence; this also
    // removes ability to claim technical proof while preservation is absent.
    await rm(path.join(f.dataDir,"jobs",job.report.id),{recursive:true,force:true});
    assert.notEqual((await f.view(0,id)).status,200);
  }finally{await f.close();}
});
test("revoked actor during lock, local job fake verdict and byte-limited request cannot certify",async()=>{
  const f=await fixture();
  try{
    const id=await f.create(),lease=await f.claim(0,id);
    await sleep(16);
    const job=await f.run();
    let release,started;
    const blocked=new Promise(resolve=>release=resolve),
      entered=new Promise(resolve=>started=resolve);
    const lock=withAdmissionLock(f.dataDir,async()=>{started();await blocked;});
    await entered;
    const pending=f.verify(0,id,lease.body.leaseId,job);
    await sleep(80);
    const old=JSON.parse(await readFile(f.actorFile,"utf8"));
    const newFile=f.actorFile+".new";
    await writeFile(newFile,JSON.stringify({
      ...old,actors:old.actors.filter(a=>a.key!==actorKey),
    }),{mode:0o600,flag:"wx"});
    await rename(newFile,f.actorFile);
    release();await lock;
    assert.equal((await pending).status,401);
    assert.equal((await f.view(0,id)).body.verifiedTestJobs,0);
    const huge=await f.verify(0,id,lease.body.leaseId,job,{fake:"x".repeat(1400)});
    assert.equal(huge.status,401); // now revoked, cannot inspect data
  }finally{await f.close();}
});
