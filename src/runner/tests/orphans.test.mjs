import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite, jobDirectory, readReport, validateRequest } from "../common.mjs";
import { recordJobEvidence } from "../evidence.mjs";
import { planStep, runDockerStep } from "../docker.mjs";
import { reconcileRunnerContainers, runnerContainerIdentity, rootlessSecurityOptions } from "../orphans.mjs";

const jobId = "a1234567-1111-4111-8111-111111111111";
const otherJob = "a1234567-2222-4222-8222-222222222222";
const dockerId = "a".repeat(64);
const step = "web-build";
const source = { "src/frontend/web/package.json": '{"scripts":{"build":"vite build"}}' };
async function fixture(state = "failed") {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-orphan-test-"));
  const dir = jobDirectory(dataDir, jobId);
  await mkdir(dir, { recursive: true });
  const checked = validateRequest({ label: "orphan CI test", files: source, steps: [step] });
  await writeFile(path.join(dir, "input.json"), JSON.stringify(checked.request));
  await atomicWrite(path.join(dir, "report.json"), { id: jobId, digest: checked.digest,
    label: "orphan CI test", state: "queued", acceptedAt: new Date().toISOString(),
    steps: [step], results: [] });
  const accepted = await readReport(dataDir, jobId);
  await recordJobEvidence(dataDir, jobId, accepted, "accepted");
  if (state !== "queued") {
    await recordJobEvidence(dataDir, jobId, { ...accepted,
      state: "running", startedAt: new Date().toISOString() }, "started");
  }
  if (state !== "queued" && state !== "running") {
    const running = await readReport(dataDir, jobId);
    await recordJobEvidence(dataDir, jobId, {
      ...running, state, finishedAt: new Date().toISOString(),
    }, "finished");
  }
  return { dataDir, dir };
}
function container({ id = dockerId, name = null, labels = null, state = "running" } = {}) {
  return { Id: id, Name: "/" + (name || runnerContainerIdentity(jobId, step).name),
    Config: { Labels: labels || Object.fromEntries(runnerContainerIdentity(jobId, step).labels) },
    State: { Status: state } };
}
function dockerBackend(inspected = container()) {
  const calls = [];
  const exec = async args => {
    calls.push(args);
    if (args[0] === "ps") return dockerId.slice(0, 12) + "\n";
    if (args[0] === "inspect") return JSON.stringify([inspected]);
    if (args[0] === "rm") return args[2] + "\n";
    throw Error("Unexpected Docker command");
  };
  return { exec, calls };
}
test("daemon rootless identification fails closed for malformed or non-rootless Docker security options", () => {
  assert.equal(rootlessSecurityOptions(["name=seccomp,profile=builtin", "name=rootless"]), true);
  for (const invalid of [undefined, null, "name=rootless", {}, [], ["rootless"],
    ["name=notrootless"], ["name=rootless-but-not-really"], ["name=seccomp"]])
    assert.equal(rootlessSecurityOptions(invalid), false);
});
test("full UUID container names avoid first-eight-character collisions and expose no credentials", async () => {
  const identity = runnerContainerIdentity(jobId, step);
  assert.equal(identity.name, "sf-" + jobId + "-" + step);
  assert.notEqual(identity.name, runnerContainerIdentity(otherJob, step).name);
  assert.deepEqual(identity.labels, [
    ["softwarefactory.runner", "job"], ["softwarefactory.job-id", jobId],
    ["softwarefactory.step", step] ]);
  assert.throws(() => runnerContainerIdentity(jobId, "--privileged"), /Invalid/);
  assert.throws(() => runnerContainerIdentity("../unsafe", step), /Invalid/);
  const plan = planStep("web-build", source, "/srv/softwarefactory/test");
  let args;
  await runDockerStep(plan, jobId, step, { timeoutMs: 1000,
    // This test stubs spawnProcess and verifies argv only; it never connects
    // to Docker. Production execution must use the default rootless probe.
    probeDocker: async () => true,
    spawnProcess: (_binary, argv) => {
      args = argv;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });
  assert.ok(args.includes(identity.name));
  for (const [label, value] of identity.labels) assert.ok(args.includes(label + "=" + value));
  assert.ok(args.includes("--network") && args.includes("none"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(!args.join(" ").includes("docker.sock"));
});
test("orphan inspector defaults to dry run; explicit confirmation removes only the verified ID", async () => {
  const { dataDir } = await fixture();
  try {
    const backend = dockerBackend();
    const preview = await reconcileRunnerContainers({ dataDir, jobId, runDocker: backend.exec });
    assert.equal(preview.eligible, true);
    assert.equal(preview.applied, false);
    assert.equal(preview.containers.length, 1);
    assert.equal(backend.calls.filter(a => a[0] === "rm").length, 0);
    await assert.rejects(reconcileRunnerContainers({
      dataDir, jobId, apply: true, confirmJob: otherJob, runDocker: backend.exec,
    }), /confirm-job/);
    const applied = await reconcileRunnerContainers({
      dataDir, jobId, apply: true, confirmJob: jobId, runDocker: backend.exec,
    });
    assert.deepEqual(applied.removed, [dockerId]);
    assert.equal(backend.calls.filter(a => a[0] === "inspect").length, 3);
    assert.deepEqual(backend.calls.filter(a => a[0] === "rm"), [["rm", "-f", dockerId]]);
    assert.ok((await readdir(jobDirectory(dataDir, jobId))).includes("evidence.jsonl"));
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
test("cleanup denies queued, running, passed and claimed jobs without calling Docker", async () => {
  for (const state of ["queued", "running", "passed", "failed"]) {
    const { dataDir, dir } = await fixture(state);
    try {
      if (state === "failed") await mkdir(path.join(dir, ".claim"));
      const backend = dockerBackend();
      await assert.rejects(reconcileRunnerContainers({
        dataDir, jobId, apply: true, confirmJob: jobId, runDocker: backend.exec,
      }), /Cleanup denied/);
      assert.equal(backend.calls.length, 0);
      const preview = await reconcileRunnerContainers({ dataDir, jobId, runDocker: backend.exec });
      assert.equal(preview.eligible, false);
      assert.equal(preview.containers.length, 1);
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  }
});
test("spoofed labels, name, malformed Docker IDs and tampered evidence are rejected", async () => {
  const { dataDir, dir } = await fixture("incomplete");
  try {
    for (const item of [
      container({ labels: { "softwarefactory.runner": "job",
        "softwarefactory.job-id": otherJob, "softwarefactory.step": step } }),
      container({ name: "unrelated-container" }),
      container({ labels: { "softwarefactory.runner": "job",
        "softwarefactory.job-id": jobId, "softwarefactory.step": "unknown" } }),
    ]) {
      const backend = dockerBackend(item);
      await assert.rejects(reconcileRunnerContainers({
        dataDir, jobId, apply: true, confirmJob: jobId, runDocker: backend.exec,
      }), /labels\/name|identity/);
      assert.equal(backend.calls.some(a => a[0] === "rm"), false);
    }
    await assert.rejects(reconcileRunnerContainers({
      dataDir, jobId, runDocker: async argv => argv[0] === "ps" ? "bad-id\n" : "",
    }), /Unexpected Docker container IDs/);
    const saved = await readReport(dataDir, jobId);
    await atomicWrite(path.join(dir, "report.json"), { ...saved, state: "passed" });
    const backend = dockerBackend();
    await assert.rejects(reconcileRunnerContainers({
      dataDir, jobId, apply: true, confirmJob: jobId, runDocker: backend.exec,
    }), /integrity/);
    assert.equal(backend.calls.length, 0);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
