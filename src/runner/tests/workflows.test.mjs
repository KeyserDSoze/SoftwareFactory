import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, link, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { withAdmissionLock } from "../admission.mjs";
import { readReport } from "../common.mjs";
import { recordJobEvidence } from "../evidence.mjs";

const key = "multi-job-workflow-test-key-abcdefghijklmnopqrstuvwxyz";
const origin = "http://localhost:5173";
const files = { "src/backend/domain/Invoice.cs": "namespace A; public record Invoice(int Value);" };
async function fixture(opts = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-workflows-"));
  const servers = Array.from({ length: 2 }, () =>
    createRunnerServer({ apiKey: key, allowedOrigins: [origin], dataDir, ...opts }));
  for (const s of servers) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
  const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
  const call = async (i, method, url, body, headers = {}) => {
    const res = await fetch(urls[i] + url, {
      method,
      headers: { Origin: origin, Authorization: "Bearer " + key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  const submit = async (i = 0) => {
    const res = await call(i, "POST", "/v1/jobs", { label: "PM test", files, steps: ["dotnet-build"] });
    assert.equal(res.status, 202);
    return res.body;
  };
  const pass = async (receipt, state = "passed") => {
    const r = await readReport(dataDir, receipt.id);
    await recordJobEvidence(dataDir, receipt.id, { ...r,
      state: "running", startedAt: new Date().toISOString() }, "started");
    const running = await readReport(dataDir, receipt.id);
    await recordJobEvidence(dataDir, receipt.id, {
      ...running, results: [{ step: "dotnet-build",
        state, exitCode: state === "passed" ? 0 : 1,
        durationMs: 10, timedOut: false }],
    }, "step");
    const step = await readReport(dataDir, receipt.id);
    await recordJobEvidence(dataDir, receipt.id, { ...step, state,
      finishedAt: new Date().toISOString() }, "finished");
  };
  const close = async () => {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  };
  return { dataDir, servers, call, submit, pass, close };
}
function manifest(a, b) {
  return { consent: true, label: "Build then regression tests", tasks: [
    { id: "build", role: "devops_engineer", jobId: a.id, digest: a.digest, dependsOn: [] },
    { id: "test", role: "tester", jobId: b.id, digest: b.digest, dependsOn: ["build"] },
  ] };
}
const post = (f, i, body, key = randomUUID()) =>
  f.call(i, "POST", "/v1/workflows", body, { "Idempotency-Key": key });
const get = (f, i, id) => f.call(i, "GET", "/v1/workflows/" + id);

test("multi-job manifest survives two API instances; a downstream queued job is blocked, not passed", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit(1), idempotency = randomUUID();
    const created = await post(f, 0, manifest(a,b), idempotency);
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.tasks.map(t => t.status), ["queued","blocked"]);
    assert.deepEqual(created.body.tasks[1].dependsOn, ["build"]);
    assert.equal(created.body.tasks[1].role, "tester");
    assert.equal(JSON.stringify(created.body).includes("Invoice.cs"), false);
    assert.equal(JSON.stringify(created.body).includes(key), false);
    const read = await get(f, 1, created.body.id);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.tasks, created.body.tasks);
    await f.pass(a);
    const next = await get(f, 1, created.body.id);
    assert.equal(next.status, 200);
    assert.deepEqual(next.body.tasks.map(t => t.status), ["passed","queued"]);
    await f.pass(b);
    const done = await get(f, 0, created.body.id);
    assert.equal(done.body.status, "passed");
    assert.deepEqual(done.body.tasks.map(t => t.status), ["passed","passed"]);
    const replay = await post(f, 1, manifest(a,b), idempotency);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, created.body.id);
    assert.equal(replay.body.status, "passed");
    const conflict = await post(f, 1, { ...manifest(a,b), label: "changed" }, idempotency);
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { error: "workflow_conflict" });
  } finally { await f.close(); }
});

test("multi-job DAG never hides out-of-order execution or failed prerequisites", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const created = await post(f, 0, manifest(a,b));
    await f.pass(b);
    const early = await get(f, 0, created.body.id);
    assert.equal(early.body.status, "out_of_order");
    assert.deepEqual(early.body.tasks.map(x => x.status), ["queued","out_of_order"]);
    await f.pass(a, "failed");
    const failed = await get(f, 1, created.body.id);
    assert.equal(failed.body.status, "out_of_order");
    assert.deepEqual(failed.body.tasks.map(x => x.status), ["failed","out_of_order"]);
  } finally { await f.close(); }
});

test("multi-job admission rejects invalid graphs, forged evidence and missing consent", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const base = manifest(a,b);
    const variants = [
      { ...base, consent: false }, { ...base, tasks: [base.tasks[0]] },
      { ...base, tasks: [base.tasks[0], { ...base.tasks[1], dependsOn: ["test"] }] },
      { ...base, tasks: [base.tasks[0], { ...base.tasks[1], jobId: a.id }] },
      { ...base, tasks: [base.tasks[0], { ...base.tasks[1], role: "arbitrary_shell" }] },
      { ...base, tasks: [base.tasks[0], { ...base.tasks[1], digest: "0".repeat(64) }] },
      { ...base, unexpected: "hi" },
    ];
    for (const [i, body] of variants.entries()) {
      const got = await post(f, i%2, body);
      assert.equal(got.status, i === 5 ? 409 : 422, JSON.stringify(got));
    }
    const missing = await f.call(1,"POST","/v1/workflows",base);
    assert.equal(missing.status, 422);
    const denied = await f.call(0,"POST","/v1/workflows",base,
      { Authorization:"Bearer wrong", "Idempotency-Key":randomUUID() });
    assert.equal(denied.status, 401);
    const cross = await f.call(0,"POST","/v1/workflows",base,
      { Origin: "https://evil.example", "Idempotency-Key":randomUUID() });
    assert.equal(cross.status, 403);
    const c = await post(f, 0, base);
    assert.equal(c.status, 201);
    const file = path.join(f.dataDir, "workflows", c.body.id + ".json");
    const original = await readFile(file);
    await writeFile(file, original.toString("utf8").replace('"label": "Build then regression tests"',
      '"label": "tampered"'));
    assert.equal((await get(f,0,c.body.id)).status,409);
    await writeFile(file,original);
    const alias = file + ".alias";
    await link(file,alias);
    assert.equal((await get(f,0,c.body.id)).status,409);
    await rm(alias);
    await rm(file);
    await symlink(alias,file);
    assert.equal((await get(f,0,c.body.id)).status,409);
    await rm(file);
    await writeFile(file, original, { mode: 0o600 });
    await chmod(file,0o644);
    assert.equal((await get(f,0,c.body.id)).status,409);
    await chmod(file,0o600);
    assert.equal((await get(f,1,c.body.id)).status,200);
  } finally { await f.close(); }
});

test("registration rejects contradictory step journals even if report claims passed", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const r = await readReport(f.dataDir,a.id);
    await recordJobEvidence(f.dataDir,a.id,{ ...r,state:"running",
      startedAt:new Date().toISOString() },"started");
    const running=await readReport(f.dataDir,a.id);
    await recordJobEvidence(f.dataDir,a.id,{ ...running,state:"passed",
      finishedAt:new Date().toISOString(),
      results:[{ step:"dotnet-build", state:"passed",exitCode:0,durationMs:1 }] },"finished");
    const bad = await post(f,0,manifest(a,b));
    assert.equal(bad.status,409);
    assert.equal(bad.body.error,"workflow_integrity");
  } finally { await f.close(); }
});


test("dependency started early stays out-of-order even after both jobs ultimately pass", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const created = await post(f, 0, manifest(a,b));
    assert.equal(created.status, 201);
    await f.pass(b); // started before build, and even finished before build
    await f.pass(a);
    const after = await get(f, 1, created.body.id);
    assert.equal(after.status, 200);
    assert.equal(after.body.status, "out_of_order");
    assert.deepEqual(after.body.tasks.map(t => t.status), ["passed","out_of_order"]);
  } finally { await f.close(); }
});

test("tenant workflow ownership, registry key rotation, and legacy rollback remain isolated", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-workflow-tenant-"));
  const tenantFile = path.join(dir, "tenants.json");
  const alpha = "alpha." + "a".repeat(40);
  const changed = "alpha." + "c".repeat(40);
  const bravo = "bravo." + "b".repeat(40);
  const registry = a => ({ version: 1, tenants: [
    { id:"alpha",key:a,maxQueued:4,maxRetained:8,maxAcceptedPerMinute:0 },
    { id:"bravo",key:bravo,maxQueued:4,maxRetained:8,maxAcceptedPerMinute:0 },
  ] });
  await writeFile(tenantFile, JSON.stringify(registry(alpha)), { mode: 0o600 });
  const servers = Array.from({length:2},()=>createRunnerServer({
    apiKey:"",tenantsFile:tenantFile,allowedOrigins:[origin],dataDir:dir,maxQueued:8,
  }));
  for (const srv of servers) { srv.listen(0,"127.0.0.1"); await once(srv,"listening"); }
  const urls = servers.map(x=>"http://127.0.0.1:"+x.address().port);
  const call = async (i,key,method,pathname,body,extra={}) => {
    const res = await fetch(urls[i]+pathname,{method,
      headers:{Origin:origin,Authorization:"Bearer "+key,
        ...(body===undefined?{}:{"Content-Type":"application/json"}),
        ...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return { status:res.status,body:await res.json() };
  };
  const submit = async (i,key) => {
    const r=await call(i,key,"POST","/v1/jobs",
      {label:"Tenant PM",files,steps:["dotnet-build"]});
    assert.equal(r.status,202); return r.body;
  };
  try {
    const a=await submit(0,alpha), b=await submit(1,alpha);
    const other=await submit(1,bravo);
    const payload=manifest(a,b);
    const created=await call(0,alpha,"POST","/v1/workflows",payload,
      {"Idempotency-Key":randomUUID()});
    assert.equal(created.status,201);
    const route="/v1/workflows/"+created.body.id;
    assert.equal((await call(1,alpha,"GET",route)).status,200);
    assert.equal((await call(1,bravo,"GET",route)).status,404);
    const cross=manifest(a,other);
    assert.equal((await call(1,alpha,"POST","/v1/workflows",cross,
      {"Idempotency-Key":randomUUID()})).status,404);
    // Another auth mode must never expose any tenant-owned manifests.
    const legacy=createRunnerServer({apiKey:key,tenantsFile:"",allowedOrigins:[origin],dataDir:dir});
    legacy.listen(0,"127.0.0.1"); await once(legacy,"listening");
    try {
      const response=await fetch("http://127.0.0.1:"+legacy.address().port+route,
        {headers:{Origin:origin,Authorization:"Bearer "+key}});
      assert.equal(response.status,404);
    } finally { await new Promise(resolve=>legacy.close(resolve)); }
    const temp=tenantFile+".next";
    await writeFile(temp, JSON.stringify(registry(changed)), {mode:0o600,flag:"wx"});
    await rename(temp,tenantFile);
    assert.equal((await call(0,alpha,"GET",route)).status,401);
    assert.equal((await call(1,changed,"GET",route)).status,200);
    assert.equal((await call(1,changed,"POST","/v1/workflows",payload,
      {"Idempotency-Key":randomUUID()})).status,201);
  } finally {
    await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));
    await rm(dir,{recursive:true,force:true});
  }
});


test("crash-recovered and rejected-before-start jobs remain incomplete, never passed", async () => {
  const f = await fixture();
  try {
    const a = await f.submit(), b = await f.submit();
    const created = await post(f, 0, manifest(a,b));
    assert.equal(created.status, 201);
    const queued = await readReport(f.dataDir, a.id);
    await recordJobEvidence(f.dataDir, a.id, { ...queued, state: "incomplete",
      finishedAt: new Date().toISOString(),
      summary: "Worker rejected queue entry without running code" }, "rejected");
    const afterReject = await get(f, 1, created.body.id);
    assert.equal(afterReject.status, 200);
    assert.deepEqual(afterReject.body.tasks.map(t=>t.status), ["incomplete","blocked"]);
    const next = await readReport(f.dataDir,b.id);
    await recordJobEvidence(f.dataDir,b.id,{ ...next,state:"running",
      startedAt:new Date().toISOString() },"started");
    const running=await readReport(f.dataDir,b.id);
    await recordJobEvidence(f.dataDir,b.id,{ ...running,state:"incomplete",
      finishedAt:new Date().toISOString(),
      summary:"Worker interrupted; no passing test" },"recovered");
    const recovered = await get(f, 0, created.body.id);
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body.tasks.map(t=>t.status), ["incomplete","out_of_order"]);
    assert.equal(recovered.body.status, "out_of_order");
  } finally { await f.close(); }
});


test("a dependent job rejected before worker start is incomplete, not falsely out-of-order", async () => {
  const f = await fixture();
  try {
    const a=await f.submit(),b=await f.submit();
    const created=await post(f,0,manifest(a,b));
    assert.equal(created.status,201);
    const queued=await readReport(f.dataDir,b.id);
    await recordJobEvidence(f.dataDir,b.id,{ ...queued,state:"incomplete",
      finishedAt:new Date().toISOString(),
      summary:"Rejected before tests due to invalid worker setup" },"rejected");
    const board=await get(f,1,created.body.id);
    assert.equal(board.status,200);
    assert.deepEqual(board.body.tasks.map(t=>t.status), ["queued","incomplete"]);
    assert.equal(board.body.status,"incomplete");
  } finally { await f.close(); }
});
