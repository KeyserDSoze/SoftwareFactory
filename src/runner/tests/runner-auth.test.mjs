import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { chmod, link, mkdtemp, mkdir, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { withAdmissionLock } from "../admission.mjs";
import { isPrivateRunnerApiKeyFile, loadRunnerApiKeyFile } from "../runner-auth.mjs";

const origin = "http://localhost:5173";
const oldKey = "runner-old-key-abcdefghijklmnopqrstuvwxyz1234567";
const newKey = "runner-new-key-abcdefghijklmnopqrstuvwxyz1234567";
const job = { label:"Rotating key", files:{
  "src/backend/domain/Item.cs":"namespace Demo; public record Item(int Id);",
  "src/backend/applications/Api/Api.csproj":"<Project></Project>",
},steps:["dotnet-build"] };

async function atomic(file, value) {
  const temp = file + ".next";
  await writeFile(temp, value, {flag:"wx",mode:0o600});
  await rename(temp, file);
}
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),"sf-key-rotation-"));
  const dataDir=path.join(root,"data"), dir=path.join(root,"secret");
  await mkdir(dataDir);await mkdir(dir,{mode:0o700});
  const file=path.join(dir,"runner-key");
  await writeFile(file,oldKey+"\n",{mode:0o600});
  const servers=Array.from({length:2},()=>createRunnerServer({
    apiKey:"",apiKeyFile:file,allowedOrigins:[origin],dataDir,
  }));
  for(const server of servers){server.listen(0,"127.0.0.1");await once(server,"listening");}
  const urls=servers.map(s=>"http://127.0.0.1:"+s.address().port);
  const call=async(i,key,route="/v1/capabilities",payload=undefined)=>{
    const response=await fetch(urls[i]+route,{
      method:payload===undefined?"GET":"POST",
      headers:{Origin:origin,Authorization:"Bearer "+key,
        ...(payload===undefined?{}:{"Content-Type":"application/json"})},
      ...(payload===undefined?{}:{body:JSON.stringify(payload)}),
    });
    return {status:response.status,body:await response.json()};
  };
  const close=async()=>{await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));
    await rm(root,{recursive:true,force:true});};
  return {file,root,dataDir,urls,call,close};
}
test("file-backed key: ownership, mode, ASCII, links and atomic rename",async()=>{
  const f=await fixture();
  try {
    const s=await stat(f.file);
    assert.equal(isPrivateRunnerApiKeyFile(s,s.uid),true);
    assert.equal(isPrivateRunnerApiKeyFile(s,s.uid+1),false);
    assert.equal(isPrivateRunnerApiKeyFile({...s,isFile:()=>true,nlink:2}),false);
    assert.equal(await loadRunnerApiKeyFile(f.file),oldKey);
    await atomic(f.file,newKey);
    assert.equal(await loadRunnerApiKeyFile(f.file),newKey);
    for(const bad of ["a".repeat(31),"b".repeat(258),
      "x".repeat(40)+"\n\n","x".repeat(40)+"\r\n",
      "x".repeat(40)+"é","x".repeat(40)+" y"]){
      await atomic(f.file,bad);
      await assert.rejects(loadRunnerApiKeyFile(f.file),{code:"RUNNER_AUTH_UNAVAILABLE"});
    }
    await atomic(f.file,oldKey);
    const hard=f.file+".hard";await link(f.file,hard);
    await assert.rejects(loadRunnerApiKeyFile(f.file),{code:"RUNNER_AUTH_UNAVAILABLE"});
    await rm(hard);
    const backup=f.file+".backup";await rename(f.file,backup);await symlink(backup,f.file);
    await assert.rejects(loadRunnerApiKeyFile(f.file),{code:"RUNNER_AUTH_UNAVAILABLE"});
    await rm(f.file);await rename(backup,f.file);await chmod(f.file,0o644);
    await assert.rejects(loadRunnerApiKeyFile(f.file),{code:"RUNNER_AUTH_UNAVAILABLE"});
  }finally{await f.close();}
});

test("both API replicas hot-rotate and fail closed; liveness remains public",async()=>{
  const f=await fixture();
  try {
    for(let i=0;i<2;i++){
      assert.equal((await f.call(i,oldKey)).status,200);
      assert.equal((await f.call(i,newKey)).status,401);
    }
    await atomic(f.file,newKey+"\n");
    for(let i=0;i<2;i++){
      assert.equal((await f.call(i,oldKey)).status,401);
      assert.equal((await f.call(i,newKey)).status,200);
    }
    await chmod(f.file,0o666);
    for(let i=0;i<2;i++){
      const response=await f.call(i,newKey);
      assert.equal(response.status,503);
      assert.deepEqual(response.body,{error:"runner_auth_unavailable"});
    }
    await rm(f.file);
    assert.equal((await f.call(0,newKey)).status,503);
    assert.equal((await fetch(f.urls[0]+"/healthz")).status,200);
    await atomic(f.file,newKey);
    assert.equal((await f.call(1,newKey)).status,200);
  }finally{await f.close();}
});

test("revocation while POST waits for admission lock never allocates job",async()=>{
  const f=await fixture();
  try {
    let entered,unlock;
    const gate=new Promise(r=>{entered=r;});
    const release=new Promise(r=>{unlock=r;});
    const held=withAdmissionLock(f.dataDir,async()=>{entered();await release;},2000);
    await gate;
    const pending=f.call(0,oldKey,"/v1/jobs",job);
    await new Promise(r=>setTimeout(r,125));
    await atomic(f.file,newKey);
    unlock();await held;
    const denied=await pending;
    assert.equal(denied.status,401);
    assert.deepEqual(denied.body,{error:"unauthorized"});
    const ids=await readdir(path.join(f.dataDir,"jobs"));
    assert.equal(ids.filter(id=>!id.startsWith(".")).length,0);
    const accepted=await f.call(1,newKey,"/v1/jobs",job);
    assert.equal(accepted.status,202);
    assert.ok(accepted.body.id);
  }finally{await f.close();}
});

test("inline compatibility and mutually exclusive runner credential configuration",async()=>{
  const f=await fixture();
  try{
    assert.throws(()=>createRunnerServer({apiKey:oldKey,apiKeyFile:f.file,
      dataDir:f.dataDir,allowedOrigins:[origin]}),/only one runner API credential source/i);
    assert.throws(()=>createRunnerServer({apiKey:"",apiKeyFile:"relative/key",
      dataDir:f.dataDir,allowedOrigins:[origin]}),/absolute path/i);
    assert.throws(()=>createRunnerServer({apiKey:"",apiKeyFile:f.file,
      dataDir:f.dataDir,allowedOrigins:[origin],
      repairOperators:JSON.stringify([{id:"op",key:newKey,roles:["review"]}])}),
      /inline repair operator/i);
    const inline=createRunnerServer({apiKey:oldKey,apiKeyFile:"",
      allowedOrigins:[origin],dataDir:f.dataDir});
    inline.listen(0,"127.0.0.1");await once(inline,"listening");
    try{
      const r=await fetch("http://127.0.0.1:"+inline.address().port+"/v1/capabilities",
        {headers:{Origin:origin,Authorization:"Bearer "+oldKey}});
      assert.equal(r.status,200);
    }finally{await new Promise(r=>inline.close(r));}
  }finally{await f.close();}
});
