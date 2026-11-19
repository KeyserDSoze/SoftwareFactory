import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rename, readdir, chmod, link, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { mutateAgentTaskLease } from "../agent-handoffs.mjs";
import { withAdmissionLock } from "../admission.mjs";

const rootKey="agent-lease-root-key-abcdefghijklmnopqrstuvwxyz";
const pm="agent.pm-worker."+"P".repeat(44);
const reviewer="agent.reviewer-1."+"R".repeat(44);
const wrongRole="agent.pm-worker."+"W".repeat(44);
const otherTenant="agent.pm-worker."+"T".repeat(44);
const origin="http://localhost:5173";
function actors(pmKey=pm) {
  return { version:1, actors:[
    {id:"pm-worker",tenantId:null,role:"project_manager",key:pmKey},
    {id:"reviewer-1",tenantId:null,role:"code_reviewer",key:reviewer},
    {id:"pm-worker",tenantId:null,role:"tester",key:wrongRole},
    {id:"pm-worker",tenantId:"alpha",role:"project_manager",key:otherTenant},
  ] };
}
const manifest=()=>({consent:true,label:"Actor-owned agent tasks",budgetUnits:10,tasks:[
  {id:"plan",role:"project_manager",owner:"pm-worker",dependsOn:[],
    estimatedUnits:3,maxAttempts:2},
  {id:"review",role:"code_reviewer",owner:"reviewer-1",dependsOn:["plan"],
    estimatedUnits:4,maxAttempts:1},
]});
async function fixture({withTenant=false}={}) {
  const base=await mkdtemp(path.join(tmpdir(),"sf-agent-lease-"));
  const dataDir=path.join(base,"data");
  const registry=path.join(base,"actors.json");
  await writeFile(registry,JSON.stringify(actors()),{mode:0o600});
  const tenantsFile=path.join(base,"tenants.json");
  const alpha="alpha."+"a".repeat(40),bravo="bravo."+"b".repeat(40);
  if (withTenant) await writeFile(tenantsFile,JSON.stringify({
    version:1,tenants:[
      {id:"alpha",key:alpha,maxQueued:4,maxRetained:10,maxAcceptedPerMinute:0},
      {id:"bravo",key:bravo,maxQueued:4,maxRetained:10,maxAcceptedPerMinute:0},
    ],
  }),{mode:0o600});
  const servers=Array.from({length:2},()=>createRunnerServer({
    dataDir,allowedOrigins:[origin],apiKey:withTenant?"":rootKey,
    tenantsFile:withTenant?tenantsFile:"",agentActorsFile:registry,
  }));
  for(const s of servers){s.listen(0,"127.0.0.1");await once(s,"listening");}
  const urls=servers.map(s=>"http://127.0.0.1:"+s.address().port);
  const call=async(index,method,route,body,token=rootKey)=>{
    const reply=await fetch(urls[index]+route,{
      method,headers:{Origin:origin,Authorization:"Bearer "+token,
        ...(body===undefined?{}:{"Content-Type":"application/json","Idempotency-Key":randomUUID()})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
    return {status:reply.status,body:await reply.json()};
  };
  const create=async(ownerKey=withTenant?alpha:rootKey)=>{
    const r=await call(0,"POST","/v1/agent-handoffs",manifest(),ownerKey);
    assert.equal(r.status,201,JSON.stringify(r.body));
    return r.body;
  };
  const lease=(index,id,taskId,action,token,extras={})=>
    call(index,"POST","/v1/agent-task-leases",
      {action,handoffId:id,taskId,...extras},token);
  const close=async()=>{
    await Promise.all(servers.map(s=>new Promise(ok=>s.close(ok))));
    await rm(base,{recursive:true,force:true});
  };
  return {base,dataDir,registry,tenantsFile,alpha,bravo,servers,call,create,lease,close};
}
test("separate actor bearer, parallel claim fencing, revoke of late token, bounded attempts",async()=>{
  const f=await fixture();
  try {
    const board=await f.create();
    const id=board.id;
    const p={ttlSeconds:60};
    const [a,b]=await Promise.all([
      f.lease(0,id,"plan","claim",pm,p),
      f.lease(1,id,"plan","claim",pm,p),
    ]);
    const created=[a,b].find(x=>x.status===200),conflict=[a,b].find(x=>x.status===409);
    assert.ok(created,JSON.stringify({a,b}));
    assert.ok(conflict,JSON.stringify({a,b}));
    assert.equal(created.body.generation,1);
    assert.equal(created.body.attempts,1);
    assert.equal(created.body.evidence,"not_started");
    assert.equal(conflict.body.error,"lease_conflict");
    const read=await f.call(1,"GET","/v1/agent-handoffs/"+id);
    assert.equal(read.status,200);
    assert.equal(read.body.executions,0);
    assert.deepEqual(read.body.tasks.map(x=>x.state),["leased","blocked"]);
    assert.equal(read.body.tasks[0].fencingVersion,1);
    assert.equal(read.body.tasks[0].attempts,1);
    assert.equal(read.body.tasks[0].evidence,"not_started");
    assert.equal(JSON.stringify(read.body).includes(created.body.leaseId),false);

    assert.equal((await f.lease(0,id,"plan","claim",rootKey,p)).status,401);
    assert.equal((await f.lease(0,id,"plan","claim",wrongRole,p)).status,404);
    assert.equal((await f.lease(0,id,"plan","claim",reviewer,p)).status,404);
    assert.equal((await f.lease(0,id,"review","claim",reviewer,p)).body.error,"dependency_blocked");

    const keep=await f.lease(1,id,"plan","renew",pm,{ttlSeconds:120,leaseId:created.body.leaseId});
    assert.equal(keep.status,200,JSON.stringify(keep.body));
    assert.equal(keep.body.generation,1);
    assert.ok(Date.parse(keep.body.expiresAt)>Date.parse(created.body.expiresAt));
    const release=await f.lease(0,id,"plan","release",pm,{leaseId:created.body.leaseId});
    assert.equal(release.status,200);
    assert.equal(release.body.state,"released");
    assert.equal((await f.lease(0,id,"plan","renew",pm,
      {ttlSeconds:60,leaseId:created.body.leaseId})).body.error,"lease_stale");
    const second=await f.lease(1,id,"plan","claim",pm,p);
    assert.equal(second.status,200,JSON.stringify(second.body));
    assert.equal(second.body.generation,2);
    assert.equal(second.body.attempts,2);
    assert.notEqual(second.body.leaseId,created.body.leaseId);
    assert.equal((await f.lease(0,id,"plan","release",pm,
      {leaseId:created.body.leaseId})).body.error,"lease_stale");
    assert.equal((await f.lease(1,id,"plan","release",pm,
      {leaseId:second.body.leaseId})).status,200);
    const exhausted=await f.lease(1,id,"plan","claim",pm,p);
    assert.equal(exhausted.status,429);
    assert.equal(exhausted.body.error,"lease_capacity");
    const after=await f.call(1,"GET","/v1/agent-handoffs/"+id);
    assert.equal(after.body.tasks[0].state,"attempts_exhausted");
    assert.equal(after.body.tasks[0].evidence,"not_started");
    const raw=await readFile(path.join(f.dataDir,"agent-handoffs",id+".json"),"utf8");
    assert.equal(raw.includes(pm),false);
    assert.equal(raw.includes(rootKey),false);
  }finally{await f.close();}
});

test("expiry and restart keep monotonic generation; old lease never authorizes a late ack",async()=>{
  const f=await fixture();
  try {
    const board=await f.create();
    const actor={id:"pm-worker",tenantId:null,role:"project_manager"};
    let now=Date.now();
    const make=(action,leaseId)=>mutateAgentTaskLease({
      dataDir:f.dataDir,actor,request:{
        handoffId:board.id,taskId:"plan",action,
        ...(action==="release"?{}:{ttlSeconds:30}),
        ...(leaseId?{leaseId}:{}),
      },nowMs:()=>now,
    });
    const first=await make("claim");
    assert.equal(first.generation,1);
    now+=30_001;
    const stale=await assert.rejects(make("renew",first.leaseId),{code:"HANDOFF_LEASE_STALE"});
    const second=await make("claim");
    assert.equal(second.generation,2);
    assert.notEqual(second.leaseId,first.leaseId);
    await assert.rejects(make("release",first.leaseId),{code:"HANDOFF_LEASE_STALE"});
    // A fresh process reads the same durable epoch and refuses an exhausted
    // claim after the last lease has expired.
    now+=30_001;
    await assert.rejects(make("claim"),{code:"HANDOFF_LEASE_EXHAUSTED"});
  }finally{await f.close();}
});

test("actor key rotation while waiting on POSIX lock revokes claim before durability",async()=>{
  const f=await fixture();
  try {
    const board=await f.create();
    let release,started;
    const paused=new Promise(ok=>release=ok),entered=new Promise(ok=>started=ok);
    const holding=withAdmissionLock(f.dataDir,async()=>{started();await paused;});
    await entered;
    const attempt=f.lease(0,board.id,"plan","claim",pm,{ttlSeconds:60});
    await new Promise(ok=>setTimeout(ok,80));
    const changed=f.registry+".next";
    const fresh="agent.pm-worker."+"N".repeat(44);
    await writeFile(changed,JSON.stringify(actors(fresh)),{mode:0o600,flag:"wx"});
    await rename(changed,f.registry);
    release();await holding;
    assert.equal((await attempt).status,401);
    const reading=await f.call(1,"GET","/v1/agent-handoffs/"+board.id);
    assert.equal(reading.body.tasks[0].attempts,0);
    assert.equal((await f.lease(0,board.id,"plan","claim",pm,{ttlSeconds:60})).status,401);
    assert.equal((await f.lease(1,board.id,"plan","claim",fresh,{ttlSeconds:60})).status,200);
  }finally{await f.close();}
});

test("tenant/role/owner segmentation blocks cross-tenant task claims",async()=>{
  const f=await fixture({withTenant:true});
  try {
    const a=await f.create(f.alpha);
    assert.equal((await f.lease(0,a.id,"plan","claim",pm,{ttlSeconds:60})).status,404);
    assert.equal((await f.lease(0,a.id,"plan","claim",otherTenant,{ttlSeconds:60})).status,200);
    assert.equal((await f.call(1,"GET","/v1/agent-handoffs/"+a.id,undefined,f.bravo)).status,404);
    assert.equal((await f.call(1,"GET","/v1/agent-handoffs/"+a.id,undefined,f.alpha)).status,200);
    assert.equal((await f.call(1,"POST","/v1/agent-task-leases",
      {action:"claim",handoffId:a.id,taskId:"review",ttlSeconds:60},f.alpha)).status,401);
  }finally{await f.close();}
});

test("invalid scopes, claims and journal tamper never become a completed task",async()=>{
  const f=await fixture();
  try {
    const a=await f.create();
    for(const bad of [
      {action:"claim",handoffId:a.id,taskId:"plan",ttlSeconds:4},
      {action:"complete",handoffId:a.id,taskId:"plan",ttlSeconds:60},
      {action:"claim",handoffId:a.id,taskId:"plan",ttlSeconds:60,owner:"pm-worker"},
      {action:"renew",handoffId:a.id,taskId:"plan",leaseId:"not-a-uuid",ttlSeconds:60},
    ]) {
      const r=await f.call(0,"POST","/v1/agent-task-leases",bad,pm);
      assert.equal(r.status,422,JSON.stringify(r.body));
    }
    const claim=await f.lease(0,a.id,"plan","claim",pm,{ttlSeconds:60});
    assert.equal(claim.status,200);
    const file=path.join(f.dataDir,"agent-handoffs",a.id+".json");
    const raw=await readFile(file,"utf8");
    const record=JSON.parse(raw);
    record.events[0].generation=999;
    await writeFile(file,JSON.stringify(record),{mode:0o600});
    assert.equal((await f.call(0,"GET","/v1/agent-handoffs/"+a.id)).status,409);
    assert.equal((await f.lease(0,a.id,"plan","renew",pm,
      {ttlSeconds:120,leaseId:claim.body.leaseId})).status,404);
  }finally{await f.close();}
});

test("actor registry symlink, widened permissions and hardlink deny ALL lease auth",async()=>{
  const f=await fixture();
  try {
    const board=await f.create();
    const claim=()=>f.lease(0,board.id,"plan","claim",pm,{ttlSeconds:60});
    await chmod(f.registry,0o644);
    assert.equal((await claim()).status,503);
    await chmod(f.registry,0o600);
    const duplicate=f.registry+".hardlink";
    await link(f.registry,duplicate);
    assert.equal((await claim()).status,503);
    await rm(duplicate);
    const location=f.registry+".source";
    await rename(f.registry,location);
    await symlink(location,f.registry);
    assert.equal((await claim()).status,503);
  }finally{await f.close();}
});
