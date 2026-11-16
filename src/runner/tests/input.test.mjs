import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { constants } from "node:fs";
import { open, chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite, jobDirectory, readReport, validateRequest } from "../common.mjs";
import { recordJobEvidence, verifyJobEvidence } from "../evidence.mjs";
import { MAX_RUNNER_INPUT_BYTES, isStableRunnerInputSnapshot,
  isTrustedRunnerInputFile, readRunnerInput } from "../input.mjs";
import { executeJob, runWorker } from "../worker.mjs";
import { createRunnerServer } from "../api.mjs";
import { beginRepairSession } from "../coordinator.mjs";
import { portableEvidenceBundle, verifyEvidenceExport } from "../evidence.mjs";

const id = "00000000-0000-4000-a000-000000000053";
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-worker-input-"));
  const dir = jobDirectory(dataDir, id);
  await mkdir(dir, { recursive: true });
  const checked = validateRequest({
    label: "Snapshot safety",
    files: {
      "src/backend/domain/Item.cs": "namespace Demo; public record Item(int Value);",
      "src/backend/applications/Api/Api.csproj": "<Project><PropertyGroup><TargetFramework>net11.0</TargetFramework></PropertyGroup></Project>",
    },
    steps: ["dotnet-build"],
  });
  const file = path.join(dir, "input.json");
  const body = JSON.stringify(checked.request);
  await writeFile(file, body, { mode: 0o600 });
  await atomicWrite(path.join(dir, "report.json"), {
    id, state: "queued", digest: checked.digest, label: checked.request.label,
    acceptedAt: new Date().toISOString(), steps: checked.request.steps, results: [],
  });
  await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
  return { dataDir, dir, checked, file, body,
    close: () => rm(dataDir, { recursive: true, force: true }) };
}

test("worker input uses a bounded owner-verified regular inode and preserves 0644 legacy files", async () => {
  const f = await fixture();
  try {
    const value = await readRunnerInput(f.dataDir, id);
    assert.deepEqual(value, f.checked.request);
    const fd = await open(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await fd.stat();
      assert.equal(isTrustedRunnerInputFile(current, current.uid), true);
      assert.equal(isTrustedRunnerInputFile(current, current.uid + 1), false);
      assert.equal(isTrustedRunnerInputFile({ ...current, isFile: () => true, nlink: 2 }), false);
      assert.equal(isStableRunnerInputSnapshot(current, { ...current, mtimeMs: current.mtimeMs + 1 }), false);
      assert.equal(isStableRunnerInputSnapshot(current, { ...current, ctimeMs: current.ctimeMs + 1 }), false);
      assert.equal(isStableRunnerInputSnapshot(current, { ...current, ino: current.ino + 1 }), false);
    } finally { await fd.close(); }
    await chmod(f.file, 0o644);
    assert.deepEqual(await readRunnerInput(f.dataDir, id), f.checked.request);
  } finally { await f.close(); }
});

test("worker input fails closed on symlinks, hardlinks, write permissions, size and malformed JSON", async () => {
  const f = await fixture();
  try {
    const hard = path.join(f.dir, "duplicate");
    await link(f.file, hard);
    await assert.rejects(readRunnerInput(f.dataDir, id), { code: "RUNNER_INPUT_INVALID" });
    await rm(hard);
    const old = path.join(f.dir, "old-input");
    await rename(f.file, old);
    await symlink(old, f.file);
    await assert.rejects(readRunnerInput(f.dataDir, id), { code: "RUNNER_INPUT_INVALID" });
    await rm(f.file);
    await rename(old, f.file);
    await chmod(f.file, 0o666);
    await assert.rejects(readRunnerInput(f.dataDir, id), { code: "RUNNER_INPUT_INVALID" });
    await chmod(f.file, 0o600);
    await writeFile(f.file, Buffer.alloc(MAX_RUNNER_INPUT_BYTES + 1));
    await assert.rejects(readRunnerInput(f.dataDir, id), { code: "RUNNER_INPUT_INVALID" });
    await writeFile(f.file, "{not json");
    await assert.rejects(readRunnerInput(f.dataDir, id), { code: "RUNNER_INPUT_INVALID" });
    await writeFile(f.file, f.body);
    assert.deepEqual(await readRunnerInput(f.dataDir, id), f.checked.request);
  } finally { await f.close(); }
});

test("a descriptor unlinked by atomic rename is invalid, and a new pathname is reverified", async () => {
  const f = await fixture();
  try {
    const fd = await open(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await fd.stat();
      const replacement = f.file + ".new";
      await writeFile(replacement, f.body, { mode: 0o600 });
      await rename(replacement, f.file);
      const after = await fd.stat();
      assert.equal(after.nlink, 0, "old inode was unlinked by atomic replacement");
      assert.equal(isStableRunnerInputSnapshot(before, after), false);
    } finally { await fd.close(); }
    assert.deepEqual(await readRunnerInput(f.dataDir, id), f.checked.request);
  } finally { await f.close(); }
});

test("an unsafe input never reaches the Docker step or creates a passed receipt", async () => {
  const f = await fixture();
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "sf-worker-input-work-"));
  try {
    const backup = f.file + ".backup";
    await rename(f.file, backup);
    await symlink(backup, f.file);
    let executions = 0;
    const executeStep = async (_plan, _jobId, step) => {
      executions++;
      return { step, state: "passed", exitCode: 0, durationMs: 1,
        stdout: "", stderr: "" };
    };
    await assert.rejects(executeJob(id, {
      dataDir: f.dataDir, workspaceRoot, executeStep,
    }), { code: "RUNNER_INPUT_INVALID" });
    assert.equal(executions, 0);
    assert.equal((await verifyJobEvidence(f.dataDir, id)).report.state, "queued");
    await rm(f.file);
    await rename(backup, f.file);
    const report = await executeJob(id, {
      dataDir: f.dataDir, workspaceRoot, executeStep,
    });
    assert.equal(report.state, "passed");
    assert.equal(executions, 1);
  } finally {
    await f.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});


test("worker polling rejects invalid queued input as incomplete, not a code-test failure", async () => {
  for (const badInput of ["symlink", "permissions", "digest"]) {
    const f = await fixture();
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "sf-rejected-input-work-"));
    let executions = 0;
    try {
      if (badInput === "symlink") {
        const original = f.file + ".backup";
        await rename(f.file, original);
        await symlink(original, f.file);
      } else if (badInput === "permissions") {
        await chmod(f.file, 0o666);
      } else {
        await writeFile(f.file, JSON.stringify({
          ...f.checked.request, label: "changed-after-admission",
        }));
      }
      const executeStep = async () => {
        executions++;
        throw Error("No Docker step may execute for rejected queued input");
      };
      const runOnePoll = () => runWorker({
        dataDir: f.dataDir, workspaceRoot, pollMs: 1,
        heartbeatIntervalMs: 60_000,
        stop: (() => { let polls = 0; return () => polls++ > 0; })(),
        executeQueuedJob: (jobId, options) =>
          executeJob(jobId, { ...options, executeStep }),
      });
      await runOnePoll();
      const verified = await verifyJobEvidence(f.dataDir, id);
      assert.equal(verified.report.state, "incomplete", badInput);
      assert.equal(verified.report.startedAt ?? null, null, badInput);
      assert.deepEqual(verified.report.results, [], badInput);
      assert.ok(Number.isFinite(Date.parse(verified.report.finishedAt)));
      assert.deepEqual(verified.entries.map(entry => entry.kind),
        ["accepted", "rejected"], badInput);
      assert.match(verified.report.summary, /before any code tests/i);
      assert.doesNotMatch(verified.report.summary, /changed-after-admission|input\\.json|Item\\.cs/);
      assert.equal(executions, 0);
      // Recovery of a rejected terminal job must not re-run it, even if
      // the original unsafe input is restored while the worker keeps polling.
      if (badInput === "symlink") {
        await rm(f.file);
        await rename(f.file + ".backup", f.file);
      } else if (badInput === "permissions") {
        await chmod(f.file, 0o600);
      } else {
        await writeFile(f.file, f.body);
      }
      await runOnePoll();
      assert.equal(executions, 0);
      assert.deepEqual((await verifyJobEvidence(f.dataDir, id)).entries
        .map(entry => entry.kind), ["accepted", "rejected"]);
    } finally {
      await f.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
});

test("rejected job remains API-verifiable but cannot be a failed-test AI repair root", async () => {
  const f = await fixture();
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "sf-rejected-api-work-"));
  const key = "runner-rejected-proof-key-abcdefghijklmnopqrstuvwxyz";
  const server = createRunnerServer({
    apiKey: key, apiKeyFile: "", tenantsFile: "",
    allowedOrigins: ["http://localhost:5173"], dataDir: f.dataDir,
  });
  try {
    await chmod(f.file, 0o666);
    await runWorker({
      dataDir: f.dataDir, workspaceRoot, pollMs: 1,
      heartbeatIntervalMs: 60_000,
      stop: (() => { let polls = 0; return () => polls++ > 0; })(),
      executeQueuedJob: (jobId, options) => executeJob(jobId, {
        ...options, executeStep: () => { throw Error("Unexpected Docker step"); },
      }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = "http://127.0.0.1:" + server.address().port;
    const request = async endpoint => {
      const response = await fetch(base + endpoint, {
        headers: { Origin: "http://localhost:5173",
          Authorization: "Bearer " + key },
      });
      return { status: response.status, body: await response.json() };
    };
    const report = await request("/v1/jobs/" + id);
    assert.equal(report.status, 200);
    assert.equal(report.body.state, "incomplete");
    const evidence = await request("/v1/jobs/" + id + "/evidence");
    assert.equal(evidence.status, 200);
    assert.equal(verifyEvidenceExport(evidence.body).report.state, "incomplete");
    assert.deepEqual(verifyEvidenceExport(evidence.body).entries.map(e => e.kind),
      ["accepted", "rejected"]);
    // The repair coordinator independently enforces a failed *code step*
    // receipt; a rejected/empty result never qualifies, irrespective of UI.
    await assert.rejects(beginRepairSession(f.dataDir, {
      failedJobId: id,
      proposalId: "00000000-0000-4000-a000-000000000054",
      paths: ["src/backend/domain/Item.cs"],
      consent: true,
    }, "editor"), { code: "REPAIR_NOT_FAILED" });
  } finally {
    if (server.listening)
      await new Promise(resolve => server.close(resolve));
    await f.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
