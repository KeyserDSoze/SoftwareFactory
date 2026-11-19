import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { mutateAgentTaskCheckpoint } from "../agent-handoffs.mjs";
import { withAdmissionLock } from "../admission.mjs";

const rootKey="pm-checkpoint-runner-admin-key-abcdefghijklmnopqrstuvwxyz";
const pm="agent.pm-worker."+"P".repeat(48);
const human="agent.human-1."+"H".repeat(48);
const anotherHuman="agent.human-2."+"A".repeat(48);
const pmImpersonator="agent.pm-worker."+"I".repeat(48);
const reviewer="agent.reviewer-1."+"R".repeat(48);
const origin="http://localhost:5173";
const digest="a".repeat(64);
const otherDigest="b".repeat(64);
const taskManifest=()=>({
  consent:true,label:"Human supervised PM planning checkpoints",
  budgetUnits:7,
  tasks:[
    {id:"plan",role:"project_manager",owner:"pm-worker",dependsOn:[],
      estimatedUnits:3,maxAttempts:2},
    {id:"review",role:"code_reviewer",owner:"reviewer-1",dependsOn:["plan"],
      estimatedUnits:4,maxAttempts:1},
  ],
});
function actorRegistry(pmCredential=pm) {
  return {version:1,actors:[
    {id:"pm-worker",role:"project_manager",tenantId:null,key:pmCredential},
    {id:"pm-worker",role:"checkpoint_approver",tenantId:null,key:pmImpersonator},
    {id:"human-1",role:"checkpoint_approver",tenantId:null,key:human},
    {id:"human-2",role:"checkpoint_approver",tenantId:null,key:anotherHuman},
    {id:"reviewer-1",role:"code_reviewer",tenantId:null,key:reviewer},
    {id:"human-1",role:"checkpoint_approver",tenantId:"alpha",
      key:"agent.human-1."+"T".repeat(48)},
    {id:"pm-worker",role:"project_manager",tenantId:"alpha",
      key:"agent.pm-worker."+"M".repeat(48)},
  ]};
}
async function fixture({tenants=false}={}) {
  const base=await mkdtemp(path.join(tmpdir(),"sf-pm-checkpoint-"));
  const dataDir=path.join(base,"data");
  const actorFile=path.join(base,"actors.json");
  const tenantsFile=path.join(base,"tenants.json");
  await writeFile(actorFile,JSON.stringify(actorRegistry()),{mode:0o600});
  const tenantKey="alpha."+"a".repeat(40);
  if (tenants) await writeFile(tenantsFile,JSON.stringify({version:1,tenants:[
    {id:"alpha",key:tenantKey,maxQueued:4,maxRetained:10,maxAcceptedPerMinute:0},
  ]}),{mode:0o600});
  const servers=Array.from({length:2},()=>createRunnerServer({
    apiKey:tenants?"":rootKey,
    dataDir,allowedOrigins:[origin],agentActorsFile:actorFile,
    tenantsFile:tenants?tenantsFile:"",
  }));
  for (const server of servers) {
    server.listen(0,"127.0.0.1"); await once(server,"listening");
  }
  const urls=servers.map(s=>"http://127.0.0.1:"+s.address().port);
  const request=async(server,method,route,body,bearer=rootKey)=>{
    const response=await fetch(urls[server]+route,{method,headers:{
      Origin:origin,Authorization:"Bearer "+bearer,
      ...(body===undefined?{}:{"Content-Type":"application/json",
        "Idempotency-Key":randomUUID()}),
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const create=async()=>{
    const answer=await request(0,"POST","/v1/agent-handoffs",
      taskManifest(),tenants?tenantKey:rootKey);
    assert.equal(answer.status,201,JSON.stringify(answer.body));
    return answer.body;
  };
  const claim=(server,id,task="plan",bearer=pm)=>
    request(server,"POST","/v1/agent-task-leases",{
      action:"claim",handoffId:id,taskId:task,ttlSeconds:90,
    },bearer);
  const submit=(server,id,leaseId,submissionId,bearer=pm,units=2,artifactDigest=digest)=>
    request(server,"POST","/v1/agent-task-checkpoints",{
      action:"submit",handoffId:id,taskId:"plan",leaseId,submissionId,
      artifactDigest,reportedUnits:units,
    },bearer);
  const approve=(server,id,submissionId,bearer=human,artifactDigest=digest)=>
    request(server,"POST","/v1/agent-task-checkpoints",{
      action:"approve",handoffId:id,taskId:"plan",submissionId,artifactDigest,
    },bearer);
  const view=(server,id,bearer=tenants?tenantKey:rootKey)=>
    request(server,"GET","/v1/agent-handoffs/"+id,undefined,bearer);
  const close=async()=>{
    await Promise.all(servers.map(s=>new Promise(done=>s.close(done))));
    await rm(base,{recursive:true,force:true});
  };
  return {base,dataDir,actorFile,tenantsFile,tenantKey,servers,
    request,create,claim,submit,approve,view,close};
}
test("human-approved PM digest unblocks review, never pretends technical test passed",async()=>{
  const f=await fixture();
  try {
    const board=await f.create(),id=board.id;
    assert.equal(board.approvedReportedUnits,0);
    const lease=await f.claim(0,id);
    assert.equal(lease.status,200,JSON.stringify(lease.body));
    const submissionId=randomUUID();
    const submitted=await f.submit(0,id,lease.body.leaseId,submissionId);
    assert.equal(submitted.status,201,JSON.stringify(submitted.body));
    assert.equal(submitted.body.state,"awaiting_human_approval");
    assert.equal(submitted.body.reportedUnits,2);
    assert.equal(submitted.body.evidence,"not_started");
    const pending=await f.view(1,id);
    assert.equal(pending.status,200);
    assert.equal(pending.body.approvedReportedUnits,0);
    assert.deepEqual(pending.body.tasks.map(t=>t.state),
      ["awaiting_human_approval","blocked"]);
    assert.equal(pending.body.tasks[0].submissionId,submissionId);
    assert.equal(pending.body.tasks[0].artifactDigest,digest);
    assert.equal(JSON.stringify(pending.body).includes(lease.body.leaseId),false);
    assert.equal((await f.claim(1,id,"review",reviewer)).status,409);
    assert.equal((await f.approve(1,id,submissionId,rootKey)).status,401);
    assert.equal((await f.approve(1,id,submissionId,pm)).status,403);
    assert.equal((await f.approve(1,id,submissionId,pmImpersonator)).status,404);
    const approved=await f.approve(1,id,submissionId,human);
    assert.equal(approved.status,201,JSON.stringify(approved.body));
    assert.equal(approved.body.state,"human_approved_checkpoint");
    assert.equal(approved.body.evidence,"human_approved_digest");
    const result=await f.view(0,id);
    assert.equal(result.body.status,"declared");
    assert.equal(result.body.executions,0);
    assert.equal(result.body.approvedReportedUnits,2);
    assert.equal(result.body.tasks[0].state,"human_approved_checkpoint");
    assert.equal(result.body.tasks[0].approvedBy,"human-1");
    assert.equal(result.body.tasks[0].evidence,"human_approved_digest");
    assert.equal(result.body.tasks[1].state,"ready");
    assert.equal(result.body.tasks[1].evidence,"not_started");
    assert.equal((await f.claim(1,id,"review",reviewer)).status,200);
    const after=await f.view(0,id);
    assert.equal(after.body.tasks[1].state,"leased");
    assert.equal(after.body.tasks[1].evidence,"not_started");
    assert.equal(JSON.stringify(after.body).includes('"passed"'),false);
    const raw=await readFile(path.join(f.dataDir,"agent-handoffs",id+".json"),"utf8");
    for (const value of [human,pm,rootKey,lease.body.leaseId.slice(0,8)+"Bearer"])
      assert.equal(raw.includes(value),false);
  } finally { await f.close(); }
});

test("lost-ack submit and parallel approval replay do not double-charge reported units",async()=>{
  const f=await fixture();
  try {
    const id=(await f.create()).id;
    const claim=await f.claim(0,id);
    const submissionId=randomUUID();
    const a=await f.submit(0,id,claim.body.leaseId,submissionId);
    const b=await f.submit(1,id,claim.body.leaseId,submissionId);
    assert.deepEqual([a.status,b.status],[201,200]);
    assert.equal(b.body.created,false);
    assert.equal((await f.submit(0,id,claim.body.leaseId,submissionId,pm,3)).status,409);
    const approvals=await Promise.all([
      f.approve(0,id,submissionId,human),
      f.approve(1,id,submissionId,human),
    ]);
    assert.deepEqual(approvals.map(v=>v.status).sort(),[200,201]);
    assert.equal(approvals.filter(v=>v.body.created).length,1);
    assert.equal((await f.approve(0,id,submissionId,anotherHuman)).status,409);
    assert.equal((await f.approve(0,id,submissionId,human,otherDigest)).status,409);
    assert.equal((await f.submit(0,id,claim.body.leaseId,submissionId)).status,409);
    assert.equal((await f.claim(0,id)).status,409);
    const read=await f.view(1,id);
    assert.equal(read.body.approvedReportedUnits,2);
    assert.equal(read.body.tasks[0].reportedUnits,2);
    const events=JSON.parse(await readFile(path.join(f.dataDir,"agent-handoffs",id+".json"),"utf8")).events;
    assert.deepEqual(events.map(e=>e.kind),["claim","submit","approve"]);
  }finally{await f.close();}
});

test("malformed, unleased, over-budget or reviewer/tester submission fails closed",async()=>{
  const f=await fixture();
  try {
    const id=(await f.create()).id;
    const marker=randomUUID();
    const fail=async(body,bearer=pm)=>{
      const res=await f.request(0,"POST","/v1/agent-task-checkpoints",body,bearer);
      assert.notEqual(res.status,200,JSON.stringify(res.body));
      assert.notEqual(res.status,201,JSON.stringify(res.body));
      return res;
    };
    assert.equal((await fail({action:"submit",handoffId:id,taskId:"plan",
      leaseId:randomUUID(),submissionId:marker,artifactDigest:digest,reportedUnits:2})).status,409);
    const lease=(await f.claim(0,id)).body;
    for(const extra of [
      {reportedUnits:0},{reportedUnits:1.5},
      {reportedUnits:-1},{reportedUnits:251},
      {artifactDigest:"not-a-sha"},{passed:true},{idempotencyKey:"X"},
    ]){
      const body={action:"submit",handoffId:id,taskId:"plan",
        leaseId:lease.leaseId,submissionId:marker,artifactDigest:digest,reportedUnits:2,...extra};
      const rejected=await fail(body);
      assert.ok([409,422].includes(rejected.status),JSON.stringify(rejected));
    }
    assert.equal((await fail({action:"submit",handoffId:id,taskId:"review",
      leaseId:lease.leaseId,submissionId:marker,artifactDigest:digest,reportedUnits:2},reviewer)).status,403);
    const read=await f.view(0,id);
    assert.equal(read.body.approvedReportedUnits,0);
    assert.equal(read.body.tasks[1].state,"blocked");
    assert.equal(read.body.tasks[0].evidence,"not_started");
  }finally { await f.close(); }
});

test("expired or released PM lease cannot submit or approve stale digest",async()=>{
  const f=await fixture();
  try {
    const id=(await f.create()).id;
    const first=await f.claim(0,id);
    const submissionId=randomUUID();
    await f.submit(0,id,first.body.leaseId,submissionId);
    const release=await f.request(0,"POST","/v1/agent-task-leases",{
      action:"release",handoffId:id,taskId:"plan",leaseId:first.body.leaseId,
    },pm);
    assert.equal(release.status,200);
    assert.equal((await f.approve(1,id,submissionId)).status,409);
    const next=await f.claim(1,id);
    assert.equal(next.status,200);
    assert.equal(next.body.generation,2);
    assert.equal((await f.approve(1,id,submissionId)).status,409);
    assert.equal((await f.submit(0,id,first.body.leaseId,submissionId)).status,409);
    const separate={id:"pm-worker",role:"project_manager",tenantId:null};
    await assert.rejects(mutateAgentTaskCheckpoint({
      dataDir:f.dataDir,actor:separate,request:{
        action:"submit",handoffId:id,taskId:"plan",
        leaseId:next.body.leaseId,submissionId:randomUUID(),
        artifactDigest:digest,reportedUnits:2,
      },nowMs:()=>Date.parse(next.body.expiresAt)+1,
    }),{code:"HANDOFF_LEASE_STALE"});
    assert.equal((await f.view(0,id)).body.approvedReportedUnits,0);
  }finally { await f.close(); }
});

test("approval key rotated while blocked by POSIX lock cannot commit signoff",async()=>{
  const f=await fixture();
  try {
    const id=(await f.create()).id;
    const lease=await f.claim(0,id),submissionId=randomUUID();
    await f.submit(0,id,lease.body.leaseId,submissionId);
    let release,entered;
    const pause=new Promise(ok=>release=ok),ready=new Promise(ok=>entered=ok);
    const lock=withAdmissionLock(f.dataDir,async()=>{entered();await pause;});
    await ready;
    const approval=f.approve(0,id,submissionId,human);
    await new Promise(ok=>setTimeout(ok,75));
    const changed=f.actorFile+".new";
    await writeFile(changed,JSON.stringify({
      ...actorRegistry(),actors:actorRegistry().actors.filter(a=>a.id!=="human-1"||a.tenantId!==null),
    }),{mode:0o600,flag:"wx"});
    await rename(changed,f.actorFile);
    release(); await lock;
    assert.equal((await approval).status,401);
    const state=await f.view(1,id);
    assert.equal(state.body.tasks[0].state,"awaiting_human_approval");
    assert.equal(state.body.approvedReportedUnits,0);
  }finally{await f.close();}
});

test("cross-tenant approver cannot sign unrelated PM digest",async()=>{
  const f=await fixture({tenants:true});
  try {
    const id=(await f.create()).id;
    const producer="agent.pm-worker."+"M".repeat(48);
    const reviewerTenant="agent.human-1."+"T".repeat(48);
    const lease=await f.claim(0,id,"plan",producer);
    assert.equal(lease.status,200);
    const subId=randomUUID();
    assert.equal((await f.submit(0,id,lease.body.leaseId,subId,producer)).status,201);
    assert.equal((await f.approve(0,id,subId,human)).status,404);
    assert.equal((await f.approve(1,id,subId,reviewerTenant)).status,201);
    assert.equal((await f.view(0,id)).status,401);
    assert.equal((await f.view(0,id,f.tenantKey)).body.approvedReportedUnits,2);
  }finally{await f.close();}
});

test("hash chain catches forged approval and unrelated source or credential fields",async()=>{
  const f=await fixture();
  try {
    const id=(await f.create()).id,claim=await f.claim(0,id);
    const subId=randomUUID();
    await f.submit(0,id,claim.body.leaseId,subId);
    const p=path.join(f.dataDir,"agent-handoffs",id+".json");
    const old=JSON.parse(await readFile(p,"utf8"));
    // Self-reported source text must never be accepted as a field.
    const rejection=await f.request(0,"POST","/v1/agent-task-checkpoints",{
      action:"approve",handoffId:id,taskId:"plan",submissionId:subId,
      artifactDigest:digest,source:"potential secret",
    },human);
    assert.equal(rejection.status,422);
    old.events[1].reportedUnits=999;
    await writeFile(p,JSON.stringify(old),{mode:0o600});
    assert.equal((await f.view(0,id)).status,409);
    assert.equal((await f.approve(1,id,subId)).status,404);
  }finally{await f.close();}
});

test("valid checkpoint state is persistent over independent API instances and unavailable for zero-length proof",async()=>{
  const f=await fixture();
  try {
    const id=(await f.create()).id,lease=await f.claim(0,id);
    const subId=randomUUID();
    assert.equal((await f.submit(0,id,lease.body.leaseId,subId)).status,201);
    const second=await f.view(1,id);
    assert.equal(second.body.tasks[0].state,"awaiting_human_approval");
    assert.equal((await f.approve(1,id,subId,human,"0")).status,409);
    assert.equal((await f.approve(1,id,subId)).status,201);
    const after=await f.view(0,id);
    assert.equal(after.body.tasks[0].state,"human_approved_checkpoint");
  } finally {await f.close();}
});
