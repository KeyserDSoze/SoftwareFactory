import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { executeJob, runWorker } from "../worker.mjs";
import { mayStartGuardedJob, loadGuardedIndex } from "../workflows.mjs";
import { readReport } from "../common.mjs";

const apiKey = "enforced-workflow-test-key-abcdefghijklmnopqrstuvwxyz";
const origin = "http://localhost:5173";
const source = { "src/backend/domain/Invoice.cs":
  "namespace Demo; public sealed record Invoice(int Amount);" };
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-enforced-"));
  const servers = Array.from({ length: 2 }, () =>
    createRunnerServer({ apiKey, allowedOrigins: [origin], dataDir, maxQueued: 8 }));
  for (const s of servers) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
  const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
  async function request(i, method, endpoint, body, options = {}) {
    const response = await fetch(urls[i] + endpoint, {
      method,
      headers: { Origin: origin, Authorization: "Bearer " + apiKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const submit = async (i = 0) => {
    const result = await request(i, "POST", "/v1/jobs",
      { label: "Guarded runner job", files: source, steps: ["dotnet-build"] });
    assert.equal(result.status, 202);
    return result.body;
  };
  const manifest = (a,b) => ({ consent: true, enforced: true,
    label: "Enforced worker DAG",
    tasks: [
      { id: "compile", role: "devops_engineer",
        jobId: a.id, digest: a.digest, dependsOn: [] },
      { id: "verify", role: "tester",
        jobId: b.id, digest: b.digest, dependsOn: ["compile"] },
    ] });
  const register = (i, body, idempotencyKey = randomUUID()) =>
    request(i, "POST", "/v1/workflows", body, { "Idempotency-Key": idempotencyKey });
  const get = (i, id) => request(i, "GET", "/v1/workflows/" + id);
  const execution = (onStep, result = "passed") => ({
    dataDir, workspaceRoot: path.join(dataDir, "workspace"),
    createStepPlan: step => ({ step }),
    executeStep: async (plan, jobId, step) => {
      onStep?.(jobId);
      return { step, state: result, exitCode: result === "passed" ? 0 : 2,
        durationMs: 4, timedOut: false };
    },
  });
  const close = async () => {
    await Promise.all(servers.map(s => new Promise(ok => s.close(ok))));
    await rm(dataDir, { recursive: true, force: true });
  };
  return { dataDir, servers, request, submit, manifest, register, get, execution, close };
}

test("enforced DAG prevents dependent start before verified predecessor, then resumes after completion", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit(1);
    const key = randomUUID();
    const created = await f.register(0, f.manifest(a,b), key);
    assert.equal(created.status, 201);
    assert.equal(created.body.version, 2);
    assert.equal(created.body.enforced, true);
    assert.deepEqual(created.body.tasks.map(t => t.status), ["queued","blocked"]);
    const read = await f.get(1, created.body.id);
    assert.equal(read.status, 200);
    assert.equal(read.body.enforced, true);
    assert.equal((await mayStartGuardedJob(f.dataDir, b.id)), false);
    let ran = 0;
    const opts = f.execution(() => ran++);
    assert.equal((await executeJob(b.id, opts)).state, "queued");
    assert.equal(ran, 0, "no Docker/step executor call before dependency verified");
    assert.equal((await readReport(f.dataDir, b.id)).state, "queued");
    assert.equal((await executeJob(a.id, opts)).state, "passed");
    await new Promise(resolve => setTimeout(resolve, 8));
    assert.equal((await mayStartGuardedJob(f.dataDir, b.id)), true);
    assert.equal((await executeJob(b.id, opts)).state, "passed");
    assert.equal(ran, 2);
    const complete = await f.get(0, created.body.id);
    assert.equal(complete.status, 200);
    assert.equal(complete.body.status, "passed");
    assert.deepEqual(complete.body.tasks.map(t => t.status), ["passed", "passed"]);
    const replay = await f.register(1, f.manifest(a,b), key);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, created.body.id);
    const clash = await f.register(0, { ...f.manifest(a,b), label: "changed" }, key);
    assert.equal(clash.status, 409);
  } finally { await f.close(); }
});

test("a failed first task keeps dependent queued; another workflow cannot reuse an enforced job", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const plan = f.manifest(a,b);
    const created = await f.register(0, plan);
    assert.equal(created.status, 201);
    const conflict = await f.register(1, { ...plan, label: "Another plan" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "workflow_conflict");
    assert.equal((await executeJob(a.id, f.execution(null, "failed"))).state, "failed");
    let called = 0;
    assert.equal((await executeJob(b.id, f.execution(() => called++))).state, "queued");
    assert.equal(called, 0);
    const board = await f.get(1, created.body.id);
    assert.equal(board.status, 200);
    assert.deepEqual(board.body.tasks.map(x => x.status), ["failed","blocked"]);
  } finally { await f.close(); }
});

test("enforced enrollment fails closed if worker already claimed/started a queued job", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const claim = path.join(f.dataDir, "jobs", a.id, ".claim");
    await mkdir(claim);
    const claimed = await f.register(0, f.manifest(a,b));
    assert.equal(claimed.status, 409);
    assert.equal(claimed.body.error, "workflow_not_queued");
    await rm(claim, { recursive: true });
    let release;
    let signal;
    const entered = new Promise(ok => signal = ok);
    const blocking = new Promise(ok => release = ok);
    const started = executeJob(a.id, { ...f.execution(), executeStep: async (plan,id,step) => {
      signal();
      await blocking;
      return { step, state: "passed", exitCode: 0, timedOut: false, durationMs: 4 };
    } });
    await entered;
    const late = await f.register(1, f.manifest(a,b));
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "workflow_not_queued");
    release();
    assert.equal((await started).state, "passed");
  } finally { await f.close(); }
});

test("two workers cannot execute a guarded job twice; policy survives API restart", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const created = await f.register(0, f.manifest(a,b));
    assert.equal(created.status, 201);
    let runs = 0, release;
    let notify;
    const entered = new Promise(ok => notify = ok);
    const pause = new Promise(ok => release = ok);
    const opts = { ...f.execution(), executeStep: async (plan,id,step) => {
      runs++; notify(); await pause;
      return { step, state:"passed", exitCode:0, durationMs:4, timedOut:false };
    } };
    const first = executeJob(a.id, opts);
    await entered;
    const second = await executeJob(a.id, opts);
    assert.ok(["queued","running"].includes(second.state));
    assert.equal(runs, 1);
    release();
    assert.equal((await first).state, "passed");
    const other = await f.get(1, created.body.id);
    assert.equal(other.status, 200);
    assert.equal(other.body.enforced, true);
    await new Promise(resolve => setTimeout(resolve, 8));
    assert.equal((await executeJob(b.id, f.execution())).state, "passed");
  } finally { await f.close(); }
});

test("corrupt guarded manifest blocks every worker claim, without changing job evidence", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const created = await f.register(0, f.manifest(a,b));
    assert.equal(created.status, 201);
    const file = path.join(f.dataDir, "workflows", created.body.id + ".json");
    const original = await readFile(file);
    await writeFile(file, original.toString("utf8").replace('"enforced": true','"enforced": false'));
    await assert.rejects(loadGuardedIndex(f.dataDir), { code: "WORKFLOW_INTEGRITY" });
    await assert.rejects(executeJob(a.id, f.execution()), { code: "WORKFLOW_INTEGRITY" });
    assert.equal((await readReport(f.dataDir, a.id)).state, "queued");
    await writeFile(file, original);
    assert.equal((await loadGuardedIndex(f.dataDir)).has(a.id), true);
  } finally { await f.close(); }
});

test("legacy manifest remains observational and never imposes worker gating", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const old = { ...f.manifest(a,b) }; delete old.enforced;
    const created = await f.register(0, old);
    assert.equal(created.status, 201);
    assert.equal(created.body.version, 1);
    assert.equal(created.body.enforced, undefined);
    const index = await loadGuardedIndex(f.dataDir);
    assert.equal(index.has(b.id), false);
    assert.equal((await executeJob(b.id, f.execution())).state, "passed");
    assert.equal((await f.get(1, created.body.id)).body.status, "out_of_order");
  } finally { await f.close(); }
});

test("worker polling selects runnable upstream rather than older blocked dependent", async () => {
  const f = await fixture();
  try {
    const b = await f.submit(), a = await f.submit();
    const created = await f.register(0, f.manifest(a,b));
    assert.equal(created.status, 201);
    const selected = [];
    let cycles = 0;
    await runWorker({
      dataDir: f.dataDir, workspaceRoot: path.join(f.dataDir,"workspace"),
      pollMs: 1, stop: () => cycles++ >= 1,
      executeQueuedJob: async id => {
        selected.push(id);
        await executeJob(id, f.execution());
      },
    });
    assert.deepEqual(selected, [a.id]);
    assert.equal((await readReport(f.dataDir,b.id)).state, "queued");
  } finally { await f.close(); }
});


test("enforced DAG refuses a dependency with missing journal; a corrupt hardlink pauses worker claims", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const created = await f.register(0, f.manifest(a,b));
    assert.equal(created.status, 201);
    const file = path.join(f.dataDir,"workflows",created.body.id+".json");
    const alias=file+".hardlink";
    await link(file,alias);
    await assert.rejects(loadGuardedIndex(f.dataDir),{code:"WORKFLOW_INTEGRITY"});
    await rm(alias);
    await rm(path.join(f.dataDir,"jobs",a.id,"evidence.jsonl"));
    await assert.rejects(executeJob(b.id,f.execution()),{code:"WORKFLOW_EVIDENCE"});
    assert.equal((await readReport(f.dataDir,b.id)).state,"queued");
  } finally { await f.close(); }
});

test("enforced workflows keep tenant ownership, auth revocation and mode rollback fail-closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"sf-enforced-tenant-"));
  const dataDir=path.join(root,"data"), registryFile=path.join(root,"tenants.json");
  await mkdir(dataDir,{mode:0o700});
  const alpha="alpha."+"A".repeat(40), alphaNew="alpha."+"N".repeat(40);
  const bravo="bravo."+"B".repeat(40);
  const registry=a=>({ version:1,tenants:[
    {id:"alpha",key:a,maxQueued:4,maxRetained:8,maxAcceptedPerMinute:0},
    {id:"bravo",key:bravo,maxQueued:4,maxRetained:8,maxAcceptedPerMinute:0},
  ] });
  await writeFile(registryFile,JSON.stringify(registry(alpha)),{mode:0o600});
  const servers=Array.from({length:2},()=>createRunnerServer({
    apiKey:"",apiKeyFile:"",tenantsFile:registryFile,allowedOrigins:[origin],
    dataDir,maxQueued:8,maxRetained:16,
  }));
  try {
    for(const s of servers){s.listen(0,"127.0.0.1");await once(s,"listening");}
    const urls=servers.map(s=>"http://127.0.0.1:"+s.address().port);
    async function call(i,key,method,endpoint,body,extra={}){
      const result=await fetch(urls[i]+endpoint,{method,headers:{
        Origin:origin,Authorization:"Bearer "+key,
        ...(body===undefined?{}:{"Content-Type":"application/json"}),...extra,
      },...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:result.status,body:await result.json()};
    }
    async function submit(i,key){
      const x=await call(i,key,"POST","/v1/jobs",{
        label:"Tenant guarded job",files:source,steps:["dotnet-build"],
      });assert.equal(x.status,202);return x.body;
    }
    const a=await submit(0,alpha),b=await submit(1,alpha);
    const foreign=await submit(0,bravo);
    const manifest={consent:true,enforced:true,label:"Tenant safe workflow",tasks:[
      {id:"build",role:"devops_engineer",jobId:a.id,digest:a.digest,dependsOn:[]},
      {id:"test",role:"tester",jobId:b.id,digest:b.digest,dependsOn:["build"]},
    ]};
    const created=await call(0,alpha,"POST","/v1/workflows",manifest,{
      "Idempotency-Key":randomUUID(),
    });
    assert.equal(created.status,201);
    assert.equal(created.body.enforced,true);
    const endpoint="/v1/workflows/"+created.body.id;
    assert.equal((await call(1,alpha,"GET",endpoint)).status,200);
    assert.equal((await call(1,bravo,"GET",endpoint)).status,404);
    const attack={...manifest,tasks:[manifest.tasks[0],{
      ...manifest.tasks[1],jobId:foreign.id,digest:foreign.digest,
    }]};
    const foreignRegistration=await call(0,alpha,"POST","/v1/workflows",attack,{
      "Idempotency-Key":randomUUID(),
    });
    assert.equal(foreignRegistration.status,404);
    const legacy=createRunnerServer({
      apiKey,tenantsFile:"",apiKeyFile:"",allowedOrigins:[origin],dataDir,
    });
    legacy.listen(0,"127.0.0.1");await once(legacy,"listening");
    try{
      const rr=await fetch("http://127.0.0.1:"+legacy.address().port+endpoint,{
        headers:{Origin:origin,Authorization:"Bearer "+apiKey},
      });
      assert.equal(rr.status,404);
    } finally {await new Promise(resolve=>legacy.close(resolve));}
    const temp=registryFile+".new";
    await writeFile(temp,JSON.stringify(registry(alphaNew)),{mode:0o600,flag:"wx"});
    await rename(temp,registryFile);
    assert.equal((await call(0,alpha,"GET",endpoint)).status,401);
    assert.equal((await call(1,alphaNew,"GET",endpoint)).status,200);
  } finally {
    await Promise.all(servers.map(s=>new Promise(ok=>s.close(ok))));
    await rm(root,{recursive:true,force:true});
  }
});
