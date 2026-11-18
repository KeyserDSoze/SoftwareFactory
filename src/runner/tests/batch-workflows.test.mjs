import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createRunnerServer } from "../api.mjs";
import { executeJob } from "../worker.mjs";
import { loadGuardedIndex } from "../workflows.mjs";
import { readReport } from "../common.mjs";
import { withAdmissionLock } from "../admission.mjs";

const key = "batch-test-global-key-abcdefghijklmnopqrstu";
const origin = "http://localhost:5173";
const file = { "src/backend/domain/Test.cs": "namespace Tests; public record Test(int Value);" };
function batch() {
  return { consent: true, enforced: true, label: "PM guarded build and test",
    tasks: [
      { id: "build", role: "devops_engineer", dependsOn: [],
        request: { label: "Build", files: file, steps: ["dotnet-build"] } },
      { id: "verify", role: "tester", dependsOn: ["build"],
        request: { label: "Verify", files: file, steps: ["dotnet-build"] } },
    ],
  };
}
async function fixture({ maxQueued = 8, maxRetained = 20,
  maxAcceptedPerMinute = 0, tenantsFile = "" } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-batch-"));
  const servers = Array.from({ length: 2 }, () => createRunnerServer({
    apiKey: tenantsFile ? "" : key, tenantsFile,
    allowedOrigins: [origin], dataDir,
    maxQueued, maxRetained, maxAcceptedPerMinute,
  }));
  for (const server of servers) { server.listen(0, "127.0.0.1"); await once(server,"listening"); }
  const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
  async function request(i, method, route, body, { auth = key, idempotencyKey, headers = {} } = {}) {
    const response = await fetch(urls[i] + route, {
      method, headers: {
        Origin: origin, Authorization: "Bearer " + auth,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}), ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function register(input = batch(), id = randomUUID(), index = 0, auth = key) {
    return request(index, "POST", "/v1/workflows/batch", input,
      { auth, idempotencyKey: id });
  }
  const close = async () => {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  };
  const options = () => ({
    dataDir, workspaceRoot: path.join(dataDir, "execution"),
    createStepPlan: step => ({ step }),
    executeStep: async (plan, id, step) =>
      ({ step, state: "passed", exitCode: 0, durationMs: 5, timedOut: false }),
  });
  return { dataDir, servers, request, register, options, close };
}

test("batch creates two fully journalled queued jobs and immutable enforced plan; worker obeys DAG", async () => {
  const f = await fixture();
  try {
    const response = await f.register();
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.enforced, true);
    assert.equal(response.body.version, 2);
    assert.deepEqual(response.body.tasks.map(t=>t.status), ["queued","blocked"]);
    const [a,b] = response.body.tasks;
    assert.ok(a.jobId !== b.jobId);
    const storage=await readFile(path.join(f.dataDir,"workflows",response.body.id+".json"),"utf8");
    assert.equal(storage.includes("namespace Tests"),false);
    assert.equal(storage.includes(key),false);
    assert.equal(storage.includes("files"),false);
    assert.equal((await readReport(f.dataDir, a.jobId)).state,"queued");
    assert.equal((await readReport(f.dataDir, b.jobId)).state,"queued");
    assert.equal((await f.request(1,"GET","/v1/jobs/"+a.jobId)).status,200);
    assert.equal((await f.request(1,"GET","/v1/jobs/"+b.jobId)).status,200);
    const first=await executeJob(b.jobId, f.options());
    assert.equal(first.state,"queued","dependency must block worker before step invocation");
    assert.equal((await executeJob(a.jobId,f.options())).state,"passed");
    await new Promise(ok=>setTimeout(ok,8));
    assert.equal((await executeJob(b.jobId,f.options())).state,"passed");
    const finished=await f.request(0,"GET","/v1/workflows/"+response.body.id);
    assert.equal(finished.status,200);
    assert.equal(finished.body.status,"passed");
    assert.deepEqual(finished.body.tasks.map(t=>t.status),["passed","passed"]);
  } finally { await f.close(); }
});

test("lost acknowledgment replay on second API verifies same manifest and current journal", async () => {
  const f=await fixture();
  try {
    const uuid=randomUUID(), input=batch();
    const first=await f.register(input,uuid);
    assert.equal(first.status,201);
    const second=await f.register(input,uuid,1);
    assert.equal(second.status,200,JSON.stringify(second.body));
    assert.equal(second.body.id,first.body.id);
    const conflict=await f.register({ ...input,label:"Tampered label" },uuid,1);
    assert.equal(conflict.status,409);
    assert.equal(conflict.body.error,"workflow_conflict");
    assert.equal((await readdir(path.join(f.dataDir,"jobs"))).length,2);
    assert.equal((await readdir(path.join(f.dataDir,"workflows"))).length,1);
    const blocked=await executeJob(first.body.tasks[1].jobId,f.options());
    assert.equal(blocked.state,"queued");
  } finally { await f.close(); }
});

test("invalid DAG, missing consent, dangerous paths and sources fail before any job is visible", async () => {
  const f=await fixture();
  try {
    const safe=batch(), variants=[
      { ...safe, consent: false },
      { ...safe, enforced: false },
      { ...safe, extra: true },
      { ...safe, tasks:[safe.tasks[0]] },
      { ...safe, tasks:[safe.tasks[0], { ...safe.tasks[1],dependsOn:["verify"] }] },
      { ...safe, tasks:[safe.tasks[0], { ...safe.tasks[1],role:"shell_runner" }] },
      { ...safe, tasks:[safe.tasks[0], { ...safe.tasks[1],
        request:{...safe.tasks[1].request,files:{"../../root":"bad"}} }] },
      { ...safe, tasks:[safe.tasks[0], { ...safe.tasks[1],
        request:{...safe.tasks[1].request,files:{"src/backend/domain/B.cs":"github_pat_"+ "z".repeat(35)}} }] },
    ];
    for(const body of variants) {
      const result=await f.register(body);
      assert.equal(result.status,422, JSON.stringify(result.body));
    }
    const directory = await readdir(path.join(f.dataDir, "jobs"))
      .catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
    assert.equal(directory.length, 0, "invalid admission must not allocate a job");
    const missing=await f.request(0,"POST","/v1/workflows/batch",safe);
    assert.equal(missing.status,422);
    const denied=await f.request(0,"POST","/v1/workflows/batch",safe,
      { auth: "invalid",idempotencyKey:randomUUID() });
    assert.equal(denied.status,401);
    const cross=await f.request(1,"POST","/v1/workflows/batch",safe,
      { idempotencyKey:randomUUID(),headers:{Origin:"https://evil.invalid"}});
    assert.equal(cross.status,403);
  } finally { await f.close(); }
});

test("batch consumes every slot: global, tenant and rolling-minute quota are not bypassed", async () => {
  const one=await fixture({maxQueued:1});
  try {
    const rejected=await one.register();
    assert.equal(rejected.status,429);
    assert.equal(rejected.body.error,"queue_full");
    assert.equal((await readdir(path.join(one.dataDir,"jobs"))).length,0);
  } finally { await one.close(); }
  const rate=await fixture({maxAcceptedPerMinute:1});
  try {
    const rejected=await rate.register();
    assert.equal(rejected.status,429);
    assert.equal(rejected.body.error,"rate_limited");
  } finally { await rate.close(); }
  const f=await fixture({maxQueued:2});
  try {
    const first=await f.register();
    assert.equal(first.status,201);
    const second=await f.register();
    assert.equal(second.status,429);
    assert.equal(second.body.error,"queue_full");
    assert.equal((await readdir(path.join(f.dataDir,"jobs"))).length,2);
  } finally { await f.close(); }
});

test("pending commit guard blocks all worker claims until an operator safely reconciles", async () => {
  const f=await fixture();
  try {
    const response=await f.register();
    assert.equal(response.status,201);
    const fake=path.join(f.dataDir,"workflows",".pending-"+randomUUID());
    await mkdir(fake,{mode:0o700});
    const job=response.body.tasks[0].jobId;
    try {
      await assert.rejects(executeJob(job,f.options()),{code:"WORKFLOW_INTEGRITY"});
      assert.equal((await readReport(f.dataDir,job)).state,"queued");
      const second=await f.register();
      assert.equal(second.status,409);
      assert.equal(second.body.error,"workflow_integrity");
    } finally { await rm(fake,{recursive:true,force:true}); }
    assert.equal((await executeJob(job,f.options())).state,"passed");
  } finally { await f.close(); }
});

test("batch honors tenant owner, rotated key, independent quota and avoids cross-tenant replays", async () => {
  const root=await mkdtemp(path.join(tmpdir(),"sf-batch-tenants-"));
  const registry=path.join(root,"tenant-keys.json");
  const alpha="alpha."+"a".repeat(40), alphaNew="alpha."+"n".repeat(40);
  const bravo="bravo."+"b".repeat(40);
  const tenants=ak=>({version:1,tenants:[
    {id:"alpha",key:ak,maxQueued:2,maxRetained:5,maxAcceptedPerMinute:0},
    {id:"bravo",key:bravo,maxQueued:2,maxRetained:5,maxAcceptedPerMinute:0},
  ]});
  await writeFile(registry,JSON.stringify(tenants(alpha)),{mode:0o600});
  const f=await fixture({tenantsFile:registry,maxQueued:6,maxRetained:10});
  try {
    const uuid=randomUUID(), input=batch();
    const first=await f.register(input,uuid,0,alpha);
    assert.equal(first.status,201,JSON.stringify(first.body));
    assert.equal((await f.request(1,"GET","/v1/workflows/"+first.body.id,undefined,{auth:bravo})).status,404);
    const foreign=await f.register(input,uuid,1,bravo);
    assert.equal(foreign.status,201,"fingerprints are independently scoped by tenant");
    assert.notEqual(foreign.body.id,first.body.id);
    const quota=await f.register(input,randomUUID(),0,alpha);
    assert.equal(quota.status,429);
    const tmp=registry+".next";
    await writeFile(tmp,JSON.stringify(tenants(alphaNew)),{mode:0o600,flag:"wx"});
    await rename(tmp,registry);
    assert.equal((await f.register(input,uuid,0,alpha)).status,401);
    const replay=await f.register(input,uuid,1,alphaNew);
    assert.equal(replay.status,200);
    assert.equal(replay.body.id,first.body.id);
  } finally {await f.close();await rm(root,{recursive:true,force:true});}
});

test("registration waits for admission lock and denies revoked tenant without publishing queued jobs",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"sf-batch-revoke-"));
  const registry=path.join(root,"tenants.json");
  const alpha="alpha."+"a".repeat(40), changed="alpha."+"z".repeat(40);
  const tenant=key=>({version:1,tenants:[{id:"alpha",key,
    maxQueued:3,maxRetained:6,maxAcceptedPerMinute:0}]});
  await writeFile(registry,JSON.stringify(tenant(alpha)),{mode:0o600});
  const f=await fixture({tenantsFile:registry,maxQueued:4,maxRetained:9});
  try {
    let release, entered;
    const hold=new Promise(ok=>release=ok);
    const locked=new Promise(ok=>entered=ok);
    const task=withAdmissionLock(f.dataDir,async()=>{entered();await hold;});
    await locked;
    const request=f.register(batch(),randomUUID(),0,alpha);
    await new Promise(ok=>setTimeout(ok,65));
    const next=registry+".new";
    await writeFile(next,JSON.stringify(tenant(changed)),{mode:0o600,flag:"wx"});
    await rename(next,registry);
    release();
    await task;
    const denied=await request;
    assert.equal(denied.status,401,JSON.stringify(denied.body));
    assert.equal((await readdir(path.join(f.dataDir,"jobs"))).length,0);
  } finally {await f.close(); await rm(root,{recursive:true,force:true});}
});
