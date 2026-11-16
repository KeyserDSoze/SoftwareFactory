import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite, jobDirectory, readReport, validateRequest } from "../common.mjs";
import { recordJobEvidence, verifyJobEvidence, verifyEvidenceExport } from "../evidence.mjs";
import { createRunnerServer } from "../api.mjs";
import { beginRepairSession } from "../coordinator.mjs";
import { executeJob, runWorker } from "../worker.mjs";

const origin = "http://localhost:5173";
const key = "runner-after-start-error-abcdefghijklmnopqrstuvwxyz";
const job = () => validateRequest({
  label: "Infrastructure worker regression",
  files: {
    "src/backend/applications/Api/Api.csproj": "<Project><PropertyGroup><TargetFramework>net11.0</TargetFramework></PropertyGroup></Project>",
    "src/backend/domain/Record.cs": "namespace Demo; public record Record(int Value);",
  },
  steps: ["dotnet-build"],
});
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-worker-errors-"));
  const work = path.join(dataDir, "workspace");
  const id = randomUUID();
  const dir = jobDirectory(dataDir, id);
  await mkdir(dir, { recursive: true });
  const checked = job();
  await writeFile(path.join(dir, "input.json"), JSON.stringify(checked.request), { mode: 0o600 });
  await atomicWrite(path.join(dir, "report.json"), {
    id, digest: checked.digest, label: checked.request.label,
    state: "queued", acceptedAt: new Date().toISOString(),
    steps: checked.request.steps, results: [],
  });
  await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
  return { dataDir, work, dir, id, checked,
    close: () => rm(dataDir, { recursive: true, force: true }) };
}

test("after-start workspace, planner and Docker exceptions never become false code failures", async () => {
  const cases = ["workspace", "planner", "step"];
  for (const scenario of cases) {
    const f = await fixture();
    let calls = 0;
    try {
      let workspaceRoot = f.work;
      const options = {
        dataDir: f.dataDir,
        createStepPlan: undefined,
        executeStep: async () => {
          calls++;
          throw new Error("token=private-job-secret-no-output");
        },
      };
      if (scenario === "workspace") {
        workspaceRoot = path.join(f.dataDir, "not-a-directory");
        await writeFile(workspaceRoot, "obstruct directory creation", { mode: 0o600 });
      } else if (scenario === "planner") {
        options.createStepPlan = () => {
          throw new Error("password=private-planner-secret-no-output");
        };
      }
      const result = await executeJob(f.id, {
        ...options, workspaceRoot,
      });
      assert.equal(result.state, "incomplete", scenario);
      assert.ok(Number.isFinite(Date.parse(result.startedAt)), scenario);
      assert.ok(Number.isFinite(Date.parse(result.finishedAt)), scenario);
      assert.deepEqual(result.results, [], scenario);
      assert.equal(calls, scenario === "step" ? 1 : 0, scenario);
      assert.match(result.summary, /no code-test failure was verified/i);
      assert.doesNotMatch(JSON.stringify(result),
        /private-job-secret-no-output|private-planner-secret-no-output|not-a-directory/i);
      const verified = await verifyJobEvidence(f.dataDir, f.id);
      assert.equal(verified.report.state, "incomplete");
      assert.deepEqual(verified.entries.map(e => e.kind),
        ["accepted", "started", "finished"]);
      assert.equal((await readdir(f.work).catch(error =>
        error.code === "ENOENT" ? [] : Promise.reject(error))).length, 0,
        "workspace cleanup still runs after exceptions");
      await assert.rejects(beginRepairSession(f.dataDir, {
        failedJobId: f.id,
        proposalId: randomUUID(),
        paths: ["src/backend/domain/Record.cs"],
        consent: true,
      }, "editor"), { code: "REPAIR_NOT_FAILED" });
    } finally { await f.close(); }
  }
});

test("real failed code-step result remains failed; incomplete after-start never auto-retries", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const runOne = async () => runWorker({
      dataDir: f.dataDir, workspaceRoot: f.work,
      heartbeatIntervalMs: 60_000, pollMs: 1,
      stop: (() => { let n = 0; return () => n++ > 0; })(),
      executeQueuedJob: (jobId, options) => executeJob(jobId, {
        ...options,
        executeStep: async () => {
          calls++;
          throw new Error("secret=do-not-persist");
        },
      }),
    });
    await runOne();
    const result = await verifyJobEvidence(f.dataDir, f.id);
    assert.equal(result.report.state, "incomplete");
    assert.equal(calls, 1);
    await runOne();
    assert.equal(calls, 1, "incomplete terminal report cannot be automatically reexecuted");
    assert.equal((await verifyJobEvidence(f.dataDir, f.id)).entries.length, 3);
  } finally { await f.close(); }

  const successfulFailure = await fixture();
  try {
    const report = await executeJob(successfulFailure.id, {
      dataDir: successfulFailure.dataDir, workspaceRoot: successfulFailure.work,
      executeStep: async (_plan, _id, step) => ({
        step, state: "failed", exitCode: 7, timedOut: false,
        durationMs: 8, stdout: "Compiler error", stderr: "",
      }),
    });
    assert.equal(report.state, "failed", "actual code failure remains failed");
    assert.deepEqual(report.results.map(s => s.state), ["failed"]);
    assert.equal((await verifyJobEvidence(successfulFailure.dataDir, successfulFailure.id))
      .report.state, "failed");
  } finally { await successfulFailure.close(); }
});


test("worker journals ambiguous timeouts as incomplete and preserves manual cleanup evidence", async () => {
  for (const cleanupVerified of [false, true]) {
    const f = await fixture();
    try {
      const report = await executeJob(f.id, {
        dataDir: f.dataDir, workspaceRoot: f.work,
        executeStep: async (_plan, _id, step) => ({
          step, state: "failed", exitCode: null, timedOut: true,
          cleanupVerified, durationMs: 20, stdout: "", stderr: "",
        }),
      });
      assert.equal(report.state, "incomplete");
      assert.equal(report.results[0].timedOut, true);
      assert.equal(report.results[0].cleanupVerified, cleanupVerified);
      assert.equal(report.results[0].state, "skipped");
      if (!cleanupVerified) assert.match(report.summary, /manually reconcile/);
      const evidence = await verifyJobEvidence(f.dataDir, f.id);
      assert.equal(evidence.report.state, "incomplete");
      assert.deepEqual(evidence.report.results, report.results);
      assert.deepEqual(evidence.entries.map(entry => entry.kind),
        ["accepted", "started", "step", "finished"]);
      await assert.rejects(beginRepairSession(f.dataDir, {
        failedJobId: f.id, proposalId: randomUUID(),
        paths: ["src/backend/domain/Record.cs"], consent: true,
      }, "editor"), { code: "REPAIR_NOT_FAILED" });
    } finally { await f.close(); }
  }
});

test("a post-start infrastructure exception is API-verifiable as incomplete evidence", async () => {
  const f = await fixture();
  const server = createRunnerServer({
    apiKey: key, apiKeyFile: "", tenantsFile: "", dataDir: f.dataDir,
    allowedOrigins: [origin],
  });
  try {
    await executeJob(f.id, {
      dataDir: f.dataDir, workspaceRoot: f.work,
      createStepPlan: () => { throw Error("password=redacted"); },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = "http://127.0.0.1:" + server.address().port;
    async function request(pathname) {
      const response = await fetch(base + pathname, {
        headers: { Origin: origin, Authorization: "Bearer " + key },
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    const report = await request("/v1/jobs/" + f.id);
    assert.equal(report.state, "incomplete");
    const exportData = await request("/v1/jobs/" + f.id + "/evidence");
    assert.equal(verifyEvidenceExport(exportData).report.state, "incomplete");
    assert.deepEqual(exportData.entries.map(e => e.kind),
      ["accepted", "started", "finished"]);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await f.close();
  }
});
