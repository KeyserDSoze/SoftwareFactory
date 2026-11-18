import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, chmod, link, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { withAdmissionLock } from "../admission.mjs";

const key="handoff-test-global-key-abcdefghijklmnopqrstuvwxyz";
const origin="http://localhost:5173";
const input=()=>({
  consent:true,label:"PM role handoff only",budgetUnits:10,
  tasks:[
    {id:"plan",role:"project_manager",owner:"pm-worker",
      dependsOn:[],estimatedUnits:3,maxAttempts:2},
    {id:"review",role:"code_reviewer",owner:"reviewer-1",
      dependsOn:["plan"],estimatedUnits:4,maxAttempts:1},
  ],
});
async function fixture({tenantsFile="",globalKey=key}={}){
  const dataDir=await mkdtemp(path.join(tmpdir(),"sf-handoff-"));
  const servers=[0,1].map(()=>createRunnerServer({
    dataDir,allowedOrigins:[origin],apiKey:tenantsFile?"":globalKey,
    tenantsFile,
  }));
  for(const server of servers){server.listen(0,"127.0.0.1");await once(server,"listening");}
  const urls=servers.map(server=>"http://127.0.0.1:"+server.address().port);
  const request=async(i,method,url,body,{auth=globalKey,idempotencyKey=randomUUID(),originOverride}={})=>{
    const result=await fetch(urls[i]+url,{method,headers:{
      Origin:originOverride??origin,Authorization:"Bearer "+auth,
      ...(body===undefined?{}:{"Content-Type":"application/json","Idempotency-Key":idempotencyKey}),
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:result.status,body:await result.json()};
  };
  const create=(i=0,body=input(),options={})=>request(i,"POST","/v1/agent-handoffs",body,options);
  const get=(i,id,options={})=>request(i,"GET","/v1/agent-handoffs/"+id,undefined,options);
  const close=async()=>{
    await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
    await rm(dataDir,{recursive:true,force:true});
  };
  const recordPath=id=>path.join(dataDir,"agent-handoffs",id+".json");
  return {dataDir,servers,create,get,request,recordPath,close};
}

test("declared DAG persists without executing agents, no made-up passed evidence",async()=>{
  const f=await fixture();
  try{
    const result=await f.create();
    assert.equal(result.status,201,JSON.stringify(result.body));
    assert.equal(result.body.created,true);
    assert.equal(result.body.status,"declared");
    assert.equal(result.body.executions,0);
    assert.equal(result.body.budgetUnits,10);
    assert.equal(result.body.reservedUnits,7);
    assert.deepEqual(result.body.tasks.map(t=>t.state),["ready","blocked"]);
    assert.deepEqual(result.body.tasks.map(t=>t.evidence),["not_started","not_started"]);
    assert.equal("passed" in result.body,false);
    const read=await f.get(1,result.body.id);
    assert.equal(read.status,200);
    assert.equal(read.body.created,undefined);
    assert.equal(read.body.status,"declared");
    assert.deepEqual(read.body.tasks.map(t=>t.dependsOn),[[],["plan"]]);
    const serialized=await readFile(f.recordPath(result.body.id),"utf8");
    assert.equal(serialized.includes("password"),false);
    assert.equal(serialized.includes("Bearer "),false);
    assert.equal(serialized.includes(key),false);
    assert.equal((await readdir(path.join(f.dataDir,"jobs"))).length,0);
  }finally{await f.close();}
});

test("concurrent API retry with same key is idempotent and content conflicts reject",async()=>{
  const f=await fixture();
  try{
    const id=randomUUID();
    const [a,b]=await Promise.all([
      f.create(0,input(),{idempotencyKey:id}),
      f.create(1,input(),{idempotencyKey:id}),
    ]);
    assert.deepEqual([a.status,b.status].sort(),[200,201],JSON.stringify({a,b}));
    assert.equal(a.body.id,b.body.id);
    const conflicting=await f.create(1,{...input(),budgetUnits:12},{idempotencyKey:id});
    assert.equal(conflicting.status,409);
    assert.equal(conflicting.body.error,"handoff_conflict");
    assert.equal((await readdir(path.join(f.dataDir,"agent-handoffs"))).length,1);
    // simulate process restart: use a third API instance with same dataDir
    const srv=createRunnerServer({dataDir:f.dataDir,apiKey:key,allowedOrigins:[origin]});
    try{
      srv.listen(0,"127.0.0.1");await once(srv,"listening");
      const response=await fetch("http://127.0.0.1:"+srv.address().port+"/v1/agent-handoffs",{
        method:"POST",headers:{Origin:origin,Authorization:"Bearer "+key,
          "Content-Type":"application/json","Idempotency-Key":id},
        body:JSON.stringify(input()),
      });
      assert.equal(response.status,200);
      assert.equal((await response.json()).id,a.body.id);
    }finally{await new Promise(resolve=>srv.close(resolve));}
  }finally{await f.close();}
});

test("strict DAG/owner/cost/role checks fail before a record can be created",async()=>{
  const f=await fixture();
  try {
    const good=input(),bad=[
      {...good,consent:false}, {...good,unknown:true},
      {...good,label:"Bearer "+ "S".repeat(45)},
      {...good,label:"github_pat_"+"a".repeat(35)},
      {...good,label:"secret = "+"a".repeat(40)},
      {...good,budgetUnits:6}, {...good,budgetUnits:2.5},
      {...good,tasks:good.tasks.slice(0,1)},
      {...good,tasks:[good.tasks[0],{...good.tasks[1],id:"plan"}]},
      {...good,tasks:[good.tasks[0],{...good.tasks[1],dependsOn:["review"]}]},
      {...good,tasks:[good.tasks[0],{...good.tasks[1],dependsOn:["missing"]}]},
      {...good,tasks:[good.tasks[0],{...good.tasks[1],role:"arbitrary_shell"}]},
      {...good,tasks:[good.tasks[0],{...good.tasks[1],owner:"admin; rm -rf /"}]},
      {...good,tasks:[good.tasks[0],{...good.tasks[1],prompt:"private source"}]},
      {...good,tasks:[good.tasks[0],{...good.tasks[1],maxAttempts:9}]},
      {...good,tasks:[good.tasks[0],{...good.tasks[1],estimatedUnits:251}]},
    ];
    for(const proposal of bad){
      const r=await f.create(0,proposal);
      assert.equal(r.status, proposal.budgetUnits===6?422:422,JSON.stringify(r.body));
    }
    const noKey=await f.request(0,"POST","/v1/agent-handoffs",input(),
      {idempotencyKey:"not-uuid"});
    assert.equal(noKey.status,422);
    assert.equal((await readdir(path.join(f.dataDir,"agent-handoffs")).catch(e=>e.code==="ENOENT"?[]:Promise.reject(e))).length,0);
    const unauth=await f.create(0,input(),{auth:"a".repeat(32)});
    assert.equal(unauth.status,401);
    const invalidOrigin=await f.create(0,input(),{originOverride:"https://untrusted.test"});
    assert.equal(invalidOrigin.status,403);
  }finally{await f.close();}
});

test("all retained manifests verified before granting replay: tamper, symlink and hardlink are rejected",async()=>{
  const f=await fixture();
  try {
    const first=await f.create(), id=first.body.id;
    assert.equal(first.status,201);
    const original=await readFile(f.recordPath(id),"utf8");
    await writeFile(f.recordPath(id),original.replace('"budgetUnits": 10','"budgetUnits": 999'),{mode:0o600});
    assert.equal((await f.get(0,id)).status,409);
    const denied=await f.create(1);
    assert.equal(denied.status,409);
    await writeFile(f.recordPath(id),original,{mode:0o600});
    await chmod(f.recordPath(id),0o644);
    assert.equal((await f.get(0,id)).status,409);
    await chmod(f.recordPath(id),0o600);
    const copied=path.join(f.dataDir,"copied-record");
    await link(f.recordPath(id),copied);
    assert.equal((await f.get(0,id)).status,409);
    await rm(copied);
    const target=path.join(f.dataDir,"target.json");
    await writeFile(target,original,{mode:0o600});
    await rm(f.recordPath(id));
    await symlink(target,f.recordPath(id));
    assert.equal((await f.get(0,id)).status,409);
    assert.equal((await f.create(0)).status,409);
  }finally{await f.close();}
});

test("missing record and cross-tenant permission do not reveal task names or ownership",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"sf-handoff-registry-"));
  const pathToRegistry=path.join(root,"tenants.json");
  const alpha="alpha."+"a".repeat(40),bravo="bravo."+"b".repeat(40);
  const registry=keyAlpha=>JSON.stringify({version:1,tenants:[
    {id:"alpha",key:keyAlpha,maxQueued:4,maxRetained:20,maxAcceptedPerMinute:0},
    {id:"bravo",key:bravo,maxQueued:4,maxRetained:20,maxAcceptedPerMinute:0},
  ]});
  await writeFile(pathToRegistry,registry(alpha),{mode:0o600});
  const f=await fixture({tenantsFile:pathToRegistry,globalKey:""});
  try {
    const idem=randomUUID();
    const a=await f.create(0,input(),{auth:alpha,idempotencyKey:idem});
    assert.equal(a.status,201,JSON.stringify(a.body));
    assert.equal((await f.get(1,a.body.id,{auth:bravo})).status,404);
    const b=await f.create(1,input(),{auth:bravo,idempotencyKey:idem});
    assert.equal(b.status,201,"idempotency keys are tenant-scoped");
    assert.notEqual(a.body.id,b.body.id);
    const changed=pathToRegistry+".new";
    await writeFile(changed,registry("alpha."+"x".repeat(40)),{flag:"wx",mode:0o600});
    await rename(changed,pathToRegistry);
    assert.equal((await f.get(0,a.body.id,{auth:alpha})).status,401);
    const read=await f.get(0,a.body.id,{auth:"alpha."+"x".repeat(40)});
    assert.equal(read.status,200);
    assert.equal(read.body.id,a.body.id);
    assert.equal((await f.get(0,b.body.id,{auth:"alpha."+"x".repeat(40)})).status,404);
  }finally{await f.close();await rm(root,{recursive:true,force:true});}
});

test("key revocation during admission lock stops commit even if API initially authenticated",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"sf-handoff-revoke-"));
  const file=path.join(root,"tenants.json");
  const alpha="alpha."+"a".repeat(40);
  const registry=key=>JSON.stringify({version:1,tenants:[
    {id:"alpha",key,maxQueued:4,maxRetained:20,maxAcceptedPerMinute:0},
  ]});
  await writeFile(file,registry(alpha),{mode:0o600});
  const f=await fixture({tenantsFile:file,globalKey:""});
  try {
    let release,entered;
    const holding=new Promise(ok=>release=ok), signalled=new Promise(ok=>entered=ok);
    const task=withAdmissionLock(f.dataDir,async()=>{entered();await holding;});
    await signalled;
    const call=f.create(0,input(),{auth:alpha});
    await new Promise(ok=>setTimeout(ok,70));
    const change=file+".new";
    await writeFile(change,registry("alpha."+"z".repeat(40)),{mode:0o600,flag:"wx"});
    await rename(change,file);
    release();
    await task;
    const denied=await call;
    assert.equal(denied.status,401,JSON.stringify(denied.body));
    assert.equal((await readdir(path.join(f.dataDir,"agent-handoffs")).catch(e=>e.code==="ENOENT"?[]:Promise.reject(e))).length,0);
  }finally{await f.close();await rm(root,{recursive:true,force:true});}
});
