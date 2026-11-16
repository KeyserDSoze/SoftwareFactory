import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite, jobDirectory, readReport, validateRequest } from "../common.mjs";
import { recordJobEvidence, verifyJobEvidence } from "../evidence.mjs";
import { runDockerStep } from "../docker.mjs";
import { executeJob } from "../worker.mjs";
import { beginRepairSession } from "../coordinator.mjs";

function stubDocker(code = 0) {
  const spawnProcess = (_bin, _args, _opts) => {
    spawnProcess.calls++;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit("close", code));
    return child;
  };
  spawnProcess.calls = 0;
  return spawnProcess;
}
const mockPlan = { image: "node:22-bookworm-slim", command: ["node", "-e", "process.exit(0)"],
  args: ["run", "--rm", "--network", "none", "node:22-bookworm-slim", "node"],
  timeoutMs: 5000 };

test("every real Docker invocation requires an exact fresh rootless probe", async () => {
  const spawnProcess = stubDocker();
  const id = randomUUID();
  for (const negative of [false, undefined, "true", null]) {
    await assert.rejects(runDockerStep(mockPlan, id, "web-build", {
      probeDocker: async () => negative, spawnProcess,
    }), /Docker rootless execution guard unavailable/);
    assert.equal(spawnProcess.calls, 0, "No Docker command on non-true probe");
  }
  await assert.rejects(runDockerStep(mockPlan, id, "web-build", {
    probeDocker: async () => { throw Error("token=secret docker.sock password=private"); },
    spawnProcess,
  }), error => error.message === "Docker rootless execution guard unavailable");
  assert.equal(spawnProcess.calls, 0);
  let probes = 0;
  const result = await runDockerStep(mockPlan, id, "web-build", {
    probeDocker: async () => { probes++; return true; },
    spawnProcess,
  });
  assert.equal(result.state, "passed");
  assert.equal(result.exitCode, 0);
  assert.equal(probes, 1);
  assert.equal(spawnProcess.calls, 1);
  // Positive readiness on a previous invocation must never authorize the
  // next step: the Docker daemon may be replaced or become unavailable.
  await assert.rejects(runDockerStep(mockPlan, id, "web-test", {
    probeDocker: async () => { probes++; return false; },
    spawnProcess,
  }), /Docker rootless execution guard unavailable/);
  assert.equal(probes, 2);
  assert.equal(spawnProcess.calls, 1);
});

const checked = validateRequest({
  label: "Rootless execution guard",
  files: {
    "src/backend/applications/Api/Api.csproj":
      "<Project><PropertyGroup><TargetFramework>net11.0</TargetFramework></PropertyGroup></Project>",
    "tests/backend/Tests.csproj":
      "<Project><PropertyGroup><TargetFramework>net11.0</TargetFramework></PropertyGroup></Project>",
  },
  steps: ["dotnet-build", "dotnet-test"],
});
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-docker-rootless-guard-"));
  const workspaceRoot = path.join(dataDir, "work");
  const id = randomUUID();
  const dir = jobDirectory(dataDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "input.json"), JSON.stringify(checked.request),
    { mode: 0o600 });
  await atomicWrite(path.join(dir, "report.json"), {
    id, digest: checked.digest, state: "queued", label: checked.request.label,
    acceptedAt: new Date().toISOString(), steps: checked.request.steps, results: [],
  });
  await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
  return { id, dataDir, workspaceRoot, close: () =>
    rm(dataDir, { recursive: true, force: true }) };
}

test("daemon disappears after first code step: worker reports incomplete, no second Docker call or AI repair", async () => {
  const f = await fixture();
  let probes = 0;
  const spawnProcess = stubDocker();
  try {
    const report = await executeJob(f.id, {
      dataDir: f.dataDir, workspaceRoot: f.workspaceRoot,
      executeStep: (plan, jobId, step) => runDockerStep(plan, jobId, step, {
        probeDocker: async () => ++probes === 1, spawnProcess,
      }),
    });
    assert.equal(probes, 2);
    assert.equal(spawnProcess.calls, 1, "only first step reaches Docker");
    assert.equal(report.state, "incomplete");
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].state, "passed");
    assert.match(report.summary, /no code-test failure was verified/);
    assert.doesNotMatch(JSON.stringify(report), /docker.sock|token=secret/);
    const verified = await verifyJobEvidence(f.dataDir, f.id);
    assert.equal(verified.report.state, "incomplete");
    assert.deepEqual(verified.entries.map(e => e.kind),
      ["accepted", "started", "step", "finished"]);
    await assert.rejects(beginRepairSession(f.dataDir, {
      failedJobId: f.id, proposalId: randomUUID(),
      paths: ["src/backend/applications/Api/Api.csproj"], consent: true,
    }, "editor"), { code: "REPAIR_NOT_FAILED" });
  } finally { await f.close(); }
});

test("rootful or unavailable daemon cannot launch the first requested step", async () => {
  const f = await fixture();
  const spawnProcess = stubDocker();
  try {
    const report = await executeJob(f.id, {
      dataDir: f.dataDir, workspaceRoot: f.workspaceRoot,
      executeStep: (plan, jobId, step) => runDockerStep(plan, jobId, step, {
        probeDocker: async () => false, spawnProcess,
      }),
    });
    assert.equal(report.state, "incomplete");
    assert.deepEqual(report.results, []);
    assert.equal(spawnProcess.calls, 0);
    const verified = await verifyJobEvidence(f.dataDir, f.id);
    assert.deepEqual(verified.entries.map(e => e.kind),
      ["accepted", "started", "finished"]);
  } finally { await f.close(); }
});
