import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { jobDirectory, readReport } from "../common.mjs";
import { recordJobEvidence } from "../evidence.mjs";
import { projectVerifiedJobPlan } from "../pm-job-plan.mjs";

const key = "pm-test-global-key-abcdefghijklmnopqrstuvwxyz";
const origin = "http://localhost:5173";
const files = { "src/backend/domain/Example.cs": "namespace A; public class Example {}" };
const request = { label: "PM plan", files, steps: ["dotnet-build","web-build"] };

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-pm-plan-"));
  const server = createRunnerServer({ apiKey: key, allowedOrigins: [origin], dataDir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  const get = (pathName, headers = {}) => fetch(base + pathName, {
    headers: { Origin: origin, Authorization: "Bearer " + key, ...headers },
  });
  const submit = async (body = request) => {
    const res = await fetch(base + "/v1/jobs", {
      method: "POST", headers: { Origin: origin, Authorization: "Bearer " + key,
        "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(res.status, 202);
    return res.json();
  };
  const started = async id => {
    const r = await readReport(dataDir, id);
    await recordJobEvidence(dataDir, id, { ...r, state: "running",
      startedAt: new Date().toISOString() }, "started");
  };
  const nextStep = async (id, step, state, exitCode) => {
    const r = await readReport(dataDir, id);
    const results = [...r.results, { step, state, exitCode, durationMs: 5, timedOut: false }];
    await recordJobEvidence(dataDir, id, { ...r, results }, "step");
  };
  const finish = async (id, state) => {
    const r = await readReport(dataDir, id);
    await recordJobEvidence(dataDir, id, { ...r, state,
      finishedAt: new Date().toISOString() }, "finished");
  };
  const close = async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  };
  return { dataDir, get, submit, started, nextStep, finish, close };
}

test("PM job plan: queued and running are observational; step status requires a journal entry", async () => {
  const f = await fixture();
  try {
    const receipt = await f.submit();
    const route = "/v1/jobs/" + receipt.id + "/plan";
    const queued = await f.get(route);
    assert.equal(queued.status, 200);
    const q = await queued.json();
    assert.equal(q.version, 1);
    assert.equal(q.jobId, receipt.id);
    assert.equal(q.digest, receipt.digest);
    assert.deepEqual(q.tasks.map(x => [x.id, x.status, x.dependsOn]), [
      ["dotnet-build", "waiting", []], ["web-build", "waiting", ["dotnet-build"]],
    ]);
    assert.equal(JSON.stringify(q).includes("Example.cs"), false);
    assert.equal(JSON.stringify(q).includes(key), false);
    await f.started(receipt.id);
    const running = await (await f.get(route)).json();
    assert.deepEqual(running.tasks.map(t => t.status), ["waiting","waiting"]);
    await f.nextStep(receipt.id, "dotnet-build", "passed", 0);
    const after = await (await f.get(route)).json();
    assert.deepEqual(after.tasks.map(t => t.status), ["passed","waiting"]);
    assert.notEqual(after.evidence.head, q.evidence.head);
    assert.equal(after.evidence.count, 3);
  } finally { await f.close(); }
});

test("PM job plan: only journal-bound exit 0 steps pass; later failed/not run and setup skipped stay incomplete", async () => {
  const f = await fixture();
  try {
    const a = await f.submit();
    await f.started(a.id);
    await f.nextStep(a.id, "dotnet-build", "failed", 2);
    await f.finish(a.id, "failed");
    const failure = await (await f.get("/v1/jobs/" + a.id + "/plan")).json();
    assert.equal(failure.state, "failed");
    assert.deepEqual(failure.tasks.map(t => t.status), ["failed", "not_executed"]);
    const b = await f.submit({ label: "Skip", files, steps: ["web-build"] });
    await f.started(b.id);
    await f.nextStep(b.id, "web-build", "skipped", null);
    await f.finish(b.id, "incomplete");
    const incomplete = await (await f.get("/v1/jobs/" + b.id + "/plan")).json();
    assert.equal(incomplete.state, "incomplete");
    assert.equal(incomplete.tasks[0].status, "incomplete");
    assert.notEqual(incomplete.tasks[0].status, "passed");
  } finally { await f.close(); }
});

test("PM plan fail closed for missing per-step journal, contradictory passed, tampering and auth/origin", async () => {
  const f = await fixture();
  try {
    const a = await f.submit({ label: "Only dotnet", files, steps: ["dotnet-build"] });
    const route = "/v1/jobs/" + a.id + "/plan";
    assert.equal((await f.get(route, { Authorization: "Bearer invalid" })).status, 401);
    assert.equal((await f.get(route, { Origin: "https://evil.example" })).status, 403);
    await f.started(a.id);
    const current = await readReport(f.dataDir, a.id);
    await recordJobEvidence(f.dataDir, a.id, { ...current, state: "passed",
      finishedAt: new Date().toISOString(),
      results: [{ step: "dotnet-build", state: "passed", exitCode: 0, durationMs: 4 }] }, "finished");
    const broken = await f.get(route);
    assert.equal(broken.status, 409);
    assert.deepEqual(await broken.json(), { error: "plan_integrity" });
    const file = path.join(jobDirectory(f.dataDir, a.id), "report.json");
    const snapshot = await readFile(file, "utf8");
    await writeFile(file, snapshot.replace('"state": "passed"', '"state": "failed"'));
    const corrupt = await f.get(route);
    assert.equal(corrupt.status, 409);
    assert.deepEqual(await corrupt.json(), { error: "evidence_invalid" });
    await writeFile(file, snapshot);
    assert.throws(() => projectVerifiedJobPlan({ report: { id: a.id, digest: a.digest,
      state: "passed", steps: ["dotnet-build"], results: [], evidence: { head: "0".repeat(64), count: 1, version: 1 } },
      entries: [{ kind: "accepted" }], head: "0".repeat(64) }), e => e.code === "PM_PLAN_INTEGRITY");
  } finally { await f.close(); }
});
