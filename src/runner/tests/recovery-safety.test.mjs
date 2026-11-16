import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite, jobDirectory, readReport, validateRequest } from "../common.mjs";
import { recordJobEvidence, verifyJobEvidence, verifyEvidenceExport } from "../evidence.mjs";
import { createRunnerServer } from "../api.mjs";
import { beginRepairSession } from "../coordinator.mjs";
import { executeJob, recoverUnclaimedJob, runWorker, needsTimeoutReconciliation } from "../worker.mjs";
import { reconcileRunnerContainers } from "../orphans.mjs";

const origin = "http://localhost:5173";
const key = "runner-recovery-evidence-abcdefghijklmnopqrstuvwxyz";
const ago = () => new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const check = () => validateRequest({
  label: "Worker recovery must not invent test failures",
  files: {
    "src/backend/applications/Api/Api.csproj":
      "<Project><PropertyGroup><TargetFramework>net11.0</TargetFramework></PropertyGroup></Project>",
    "src/backend/domain/Record.cs": "namespace Demo; public record Record(int Value);",
  },
  steps: ["dotnet-build"],
});
async function createFixture(dataDir, {
  id = randomUUID(), started = true, stepResult = null,
  preparation = null,
  finished = null, terminalKind = "finished", terminalState = "passed",
} = {}) {
  const dir = jobDirectory(dataDir, id), checked = check();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, "input.json"), JSON.stringify(checked.request),
    { mode: 0o600 });
  await atomicWrite(path.join(dir, "report.json"), {
    id, digest: checked.digest, label: checked.request.label,
    acceptedAt: ago(), state: "queued", steps: ["dotnet-build"], results: [],
  });
  await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
  if (started) {
    const accepted = await readReport(dataDir, id);
    await recordJobEvidence(dataDir, id, {
      ...accepted, state: "running", startedAt: ago(),
      summary: "Worker started",
    }, "started");
    if (preparation) {
      const running = await readReport(dataDir, id);
      await recordJobEvidence(dataDir, id, {
        ...running, preparation,
      }, "preparation");
    }
    if (stepResult) {
      const running = await readReport(dataDir, id);
      await recordJobEvidence(dataDir, id, {
        ...running, results: [stepResult],
      }, "step");
    }
  }
  if (finished) {
    const latest = await readReport(dataDir, id);
    await recordJobEvidence(dataDir, id, {
      ...latest, state: terminalState, finishedAt: finished,
      summary: "Legacy or normally finished fixture",
    }, terminalKind);
  }
  return { id, dir };
}
const failedStep = { step: "dotnet-build", state: "failed",
  exitCode: 7, timedOut: false, durationMs: 12, stdout: "compiler error", stderr: "" };
const passedStep = { step: "dotnet-build", state: "passed",
  exitCode: 0, timedOut: false, durationMs: 14, stdout: "", stderr: "" };

test("interrupted running job is recovered ONCE as incomplete, not a provable code failure", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-safe-recovered-"));
  const server = createRunnerServer({ apiKey: key, apiKeyFile: "",
    tenantsFile: "", dataDir, allowedOrigins: [origin] });
  try {
    for (const result of [null, passedStep, failedStep]) {
      const { id, dir } = await createFixture(dataDir, { stepResult: result });
      await mkdir(path.join(dir, ".claim"), { mode: 0o700 });
      assert.equal(await recoverUnclaimedJob(dataDir, id), false,
        "claim remains an exclusive fence to recovery");
      assert.equal((await verifyJobEvidence(dataDir, id)).report.state, "running");
      await rm(path.join(dir, ".claim"), { recursive: true });
      assert.equal(await recoverUnclaimedJob(dataDir, id), true);
      const verified = await verifyJobEvidence(dataDir, id);
      assert.equal(verified.report.state, "incomplete");
      assert.equal(verified.entries.at(-1).kind, "recovered");
      assert.match(verified.report.summary, /manually reconcile orphaned Docker containers/);
      assert.deepEqual(verified.report.results, result ? [result] : [],
        "previously journaled tests remain visible, never silently discarded");
      assert.equal(await recoverUnclaimedJob(dataDir, id), false);
      assert.equal((await verifyJobEvidence(dataDir, id)).entries.length,
        result ? 4 : 3, "recovery cannot append twice");
      const rerun = await executeJob(id, { dataDir,
        workspaceRoot: path.join(dataDir, "workspaces"),
        executeStep: async () => { throw Error("must not rerun"); } });
      assert.equal(rerun.state, "incomplete");
      await assert.rejects(beginRepairSession(dataDir, {
        failedJobId: id, proposalId: randomUUID(),
        paths: ["src/backend/domain/Record.cs"], consent: true,
      }, "editor"), { code: "REPAIR_NOT_FAILED" });
      const preview = await reconcileRunnerContainers({
        dataDir, jobId: id, runDocker: async args => {
          if (args[0] === "ps") return "";
          throw Error("No Docker inspect/delete is needed for a missing orphan");
        },
      });
      assert.equal(preview.eligible, true, "operator-only reconciliation remains possible");
      assert.equal(preview.applied, false);
    }
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = "http://127.0.0.1:" + server.address().port;
    const entries = await readdir(path.join(dataDir, "jobs"));
    const id = entries.find(s => !s.startsWith("."));
    const headers = { Origin: origin, Authorization: "Bearer " + key };
    const reportResponse = await fetch(base + "/v1/jobs/" + id, { headers });
    assert.equal(reportResponse.status, 200);
    assert.equal((await reportResponse.json()).state, "incomplete");
    const evidence = await fetch(base + "/v1/jobs/" + id + "/evidence", { headers });
    assert.equal(evidence.status, 200);
    const exportData = await evidence.json();
    assert.equal(verifyEvidenceExport(exportData).report.state, "incomplete");
    assert.equal(exportData.entries.at(-1).kind, "recovered");
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});


test("retention never deletes unverified Docker timeout evidence, including npm prepare and legacy", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-retain-timeout-"));
  const unresolved = { step: "dotnet-build", state: "skipped",
    timedOut: true, exitCode: null, cleanupVerified: false };
  const legacy = { step: "dotnet-build", state: "skipped",
    timedOut: true, exitCode: null };
  const cleaned = { step: "dotnet-build", state: "skipped",
    timedOut: true, exitCode: null, cleanupVerified: true };
  try {
    const oldStep = await createFixture(dataDir, {
      stepResult: unresolved, finished: ago(), terminalState: "incomplete",
    });
    const oldLegacy = await createFixture(dataDir, {
      stepResult: legacy, finished: ago(), terminalState: "incomplete",
    });
    const oldPrep = await createFixture(dataDir, {
      preparation: { ...unresolved, step: "npm-prepare" },
      finished: ago(), terminalState: "incomplete",
    });
    const oldCleaned = await createFixture(dataDir, {
      stepResult: cleaned, finished: ago(), terminalState: "incomplete",
    });
    const oldNormal = await createFixture(dataDir, {
      stepResult: passedStep, finished: ago(), terminalState: "passed",
    });
    const runOnce = () => runWorker({
      dataDir, workspaceRoot: path.join(dataDir, "workspaces"), pollMs: 1,
      heartbeatIntervalMs: 60_000,
      stop: (() => { let n = 0; return () => n++ > 0; })(),
      executeQueuedJob: async () => { throw Error("unexpected job"); },
    });
    for (const candidate of [oldStep, oldLegacy, oldPrep]) {
      const verified = await verifyJobEvidence(dataDir, candidate.id);
      assert.equal(needsTimeoutReconciliation(verified.report), true);
    }
    assert.equal(needsTimeoutReconciliation(
      (await verifyJobEvidence(dataDir, oldCleaned.id)).report), false);
    await runOnce();
    for (const candidate of [oldStep, oldLegacy, oldPrep]) {
      const verified = await verifyJobEvidence(dataDir, candidate.id);
      assert.equal(verified.report.state, "incomplete");
      assert.equal(verified.entries.at(-1).kind, "finished");
      await assert.rejects(beginRepairSession(dataDir, {
        failedJobId: candidate.id, proposalId: randomUUID(),
        paths: ["src/backend/domain/Record.cs"], consent: true,
      }, "editor"), { code: "REPAIR_NOT_FAILED" });
    }
    for (const candidate of [oldCleaned, oldNormal])
      await assert.rejects(verifyJobEvidence(dataDir, candidate.id),
        { code: "ENOENT" }, "verified cleanup or normal jobs can expire");
    // Repeated worker polling must not silently remove unresolved evidence.
    const previous = (await verifyJobEvidence(dataDir, oldStep.id)).head;
    await runOnce();
    assert.equal((await verifyJobEvidence(dataDir, oldStep.id)).head, previous);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("retention preserves ALL recovered journals (including historical failed), deletes ordinary expired terminal jobs", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-retain-recovered-"));
  try {
    const recovered = await createFixture(dataDir, { stepResult: passedStep });
    assert.equal(await recoverUnclaimedJob(dataDir, recovered.id), true);
    // A historical recovered event with the old 'failed' verdict remains
    // readable; it must not disappear just because an upgraded worker polls.
    const historic = await createFixture(dataDir, {
      terminalKind: "recovered", terminalState: "failed", finished: ago(),
      stepResult: failedStep,
    });
    await assert.rejects(beginRepairSession(dataDir, {
      failedJobId: historic.id, proposalId: randomUUID(),
      paths: ["src/backend/domain/Record.cs"], consent: true,
    }, "editor"), { code: "REPAIR_NOT_FAILED" },
    "old recovered=failed journals must not be accepted as true code failures");
    const expired = await createFixture(dataDir, {
      terminalKind: "finished", terminalState: "passed", finished: ago(),
      stepResult: passedStep,
    });
    const notExpired = await createFixture(dataDir, {
      terminalKind: "finished", terminalState: "passed",
      finished: new Date().toISOString(), stepResult: passedStep,
    });
    // Simulate a recovered job whose last event is older than retention,
    // without rewriting a real already-closed hash-chain.
    const oldNewRecovery = await createFixture(dataDir, {
      terminalKind: "recovered", terminalState: "incomplete", finished: ago(),
    });
    await runWorker({
      dataDir, workspaceRoot: path.join(dataDir, "workspaces"),
      pollMs: 1, heartbeatIntervalMs: 60_000,
      stop: (() => { let n = 0; return () => n++ > 0; })(),
      executeQueuedJob: async () => { throw Error("no queued jobs expected"); },
    });
    for (const id of [recovered.id, historic.id, oldNewRecovery.id, notExpired.id]) {
      const verified = await verifyJobEvidence(dataDir, id);
      assert.ok(["incomplete", "failed", "passed"].includes(verified.report.state));
    }
    await assert.rejects(verifyJobEvidence(dataDir, expired.id),
      { code: "ENOENT" }, "normal expired job should be removed by retention");
    // A subsequent poll must not retry, change or delete the recovered journal.
    const before = (await verifyJobEvidence(dataDir, recovered.id)).head;
    await runWorker({
      dataDir, workspaceRoot: path.join(dataDir, "workspaces"),
      pollMs: 1, heartbeatIntervalMs: 60_000,
      stop: (() => { let n = 0; return () => n++ > 0; })(),
      executeQueuedJob: async () => { throw Error("no queued jobs expected"); },
    });
    assert.equal((await verifyJobEvidence(dataDir, recovered.id)).head, before);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
