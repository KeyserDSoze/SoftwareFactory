/**
 * Real Docker end-to-end smoke, only on an ephemeral CI machine.
 * This test intentionally uses the CI host Docker socket; the production API
 * and the untrusted test containers NEVER get a Docker socket.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { reconcileRunnerContainers, runnerContainerIdentity } from "../orphans.mjs";
import { atomicWrite, jobDirectory, readReport, validateRequest } from "../common.mjs";
import { executeJob } from "../worker.mjs";
import { runDockerStep } from "../docker.mjs";
import { recordJobEvidence, verifyJobEvidence } from "../evidence.mjs";

/** Trusted rootful CI exception to test real Docker behavior. Never expose as
 * a runner-worker env/config switch or permit untrusted job input to select it.
 * The deployed worker always uses runDockerStep's default rootless probe.
 */
async function ciRootfulSmokeProbe() {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Only hosted GitHub CI may bypass rootless for Docker smoke");
  assert.equal(process.env.CI, "true", "Only hosted GitHub CI may bypass rootless for Docker smoke");
  assert.notEqual(process.getuid?.(), 0, "Root-owned CI smoke forbidden");
  return true;
}

const dataDir = await mkdtemp(path.join(tmpdir(), "sf-real-runner-data-"));
const work = await mkdtemp(path.join(tmpdir(), "sf-real-runner-work-"));
const packageFor = (script, dependencies = {}) => JSON.stringify({
  private: true, name: "sf-smoke", version: "0.0.1",
  scripts: { build: script, test: script },
  dependencies,
});
async function submit(files, steps) {
  const id = randomUUID(), dir = jobDirectory(dataDir, id);
  await mkdir(dir, { recursive: true });
  const checked = validateRequest({ label: "Real Docker CI smoke", files, steps });
  await writeFile(path.join(dir, "input.json"), JSON.stringify(checked.request), { flag: "wx" });
  await atomicWrite(path.join(dir, "report.json"), {
    id, digest: checked.digest, state: "queued", label: checked.request.label,
    steps, acceptedAt: new Date().toISOString(), results: [],
  });
  await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
  const report = await executeJob(id, { dataDir, workspaceRoot: work,
    executeStep: (plan, jobId, step) => runDockerStep(plan, jobId, step, {
      probeDocker: ciRootfulSmokeProbe,
    }),
    environment: {
    RUNNER_NODE_IMAGE: "node:22-bookworm-slim", RUNNER_ALLOW_NET_DEPS: "false",
    RUNNER_CONTAINER_UID: process.getuid() + ":" + process.getgid(),
  } });
  assert.equal(report.digest, checked.digest);
  assert.deepEqual((await readReport(dataDir, id)).results, report.results);
  assert.equal((await readdir(work)).length, 0, "No build workspace should survive the job");
  assert.ok(!(await readdir(dir)).includes(".claim"), "Real Docker job must release its exclusive claim");
  const verified = await verifyJobEvidence(dataDir, id);
  assert.equal(verified.report.state, report.state);
  assert.equal(verified.head, report.evidence.head);
  assert.equal(verified.entries[0].kind, "accepted");
  assert.equal(verified.entries.at(-1).kind, "finished");
  return report;
}
try {
  const files = { "src/frontend/web/package.json": packageFor(
    "node -e \"console.log('CODE_TEST_OK')\""), "src/frontend/web/src/App.tsx": "export default function App() { return null; }",
  };
  const success = await submit(files, ["web-build", "web-test"]);
  assert.equal(success.state, "passed", JSON.stringify(success));
  assert.equal(success.preparation?.state, "passed");
  assert.deepEqual(success.results.map(r => r.state), ["passed", "passed"]);
  assert.ok(success.results.every(r => r.exitCode === 0 && r.stdout.includes("CODE_TEST_OK")));
  assert.ok(success.results.every(r => r.args === undefined));
  assert.ok(success.results.every(r => !r.command.includes("npm install")), "Tests must not install dependencies");

  const negative = await submit({ ...files, "src/frontend/web/package.json": packageFor(
    "node -e \"process.exit(17)\"") }, ["web-build"]);
  assert.equal(negative.state, "failed", JSON.stringify(negative));
  assert.equal(negative.preparation?.state, "passed");
  assert.equal(negative.results[0].exitCode, 17);

  const missing = await submit({ ...files, "src/frontend/web/package.json": packageFor(
    "node -e \"process.exit(0)\"", { "nonexistent-smoke-package-xyz": "^9999.0.0" }) }, ["web-build"]);
  assert.equal(missing.state, "incomplete", JSON.stringify(missing));
  assert.equal(missing.preparation?.state, "failed");
  assert.equal(missing.results[0].state, "skipped");
  assert.ok(missing.results[0].reason.includes("dependency setup"));

  // Real Docker isolation check: a labelled orphan can be removed manually,
  // while a separate unrelated container stays intact. No credentials exposed.
  const execDocker = promisify(execFileCallback);
  const docker = async args => (await execDocker("docker", args, { timeout: 15000 })).stdout;
  const orphanId = randomUUID(), foreignId = randomUUID();
  const orphanDir = jobDirectory(dataDir, orphanId);
  const checked = validateRequest({ label: "CI orphan", files, steps: ["web-build"] });
  await mkdir(orphanDir, { recursive: true });
  await writeFile(path.join(orphanDir, "input.json"), JSON.stringify(checked.request));
  await atomicWrite(path.join(orphanDir, "report.json"), {
    id: orphanId, label: "CI orphan", digest: checked.digest,
    steps: checked.request.steps, state: "queued",
    acceptedAt: new Date().toISOString(), results: [],
  });
  const accepted = await readReport(dataDir, orphanId);
  await recordJobEvidence(dataDir, orphanId, accepted, "accepted");
  await recordJobEvidence(dataDir, orphanId, {
    ...accepted, state: "running", startedAt: new Date().toISOString(),
  }, "started");
  await recordJobEvidence(dataDir, orphanId, {
    ...(await readReport(dataDir, orphanId)), state: "failed",
    finishedAt: new Date().toISOString(), summary: "CI simulated orphan",
  }, "finished");
  const identity = runnerContainerIdentity(orphanId, "web-build");
  const foreignName = "ci-foreign-" + foreignId;
  try {
    await docker(["create", "--name", identity.name,
      ...identity.labels.flatMap(([name, value]) => ["--label", name + "=" + value]),
      "node:22-bookworm-slim", "node", "-e", "process.exit(0)"]);
    await docker(["create", "--name", foreignName,
      "node:22-bookworm-slim", "node", "-e", "process.exit(0)"]);
    const preview = await reconcileRunnerContainers({ dataDir, jobId: orphanId, runDocker: docker });
    assert.equal(preview.applied, false);
    assert.equal(preview.eligible, true);
    assert.equal(preview.containers.length, 1);
    assert.equal(preview.containers[0].name, identity.name);
    await docker(["inspect", identity.name]); // no deletion during dry-run
    const applied = await reconcileRunnerContainers({
      dataDir, jobId: orphanId, apply: true, confirmJob: orphanId, runDocker: docker,
    });
    assert.equal(applied.removed.length, 1);
    await assert.rejects(docker(["inspect", identity.name]));
    await docker(["inspect", foreignName]); // foreign container must survive
    assert.equal((await verifyJobEvidence(dataDir, orphanId)).report.state, "failed");
  } finally {
    await docker(["rm", "-f", identity.name]).catch(() => {});
    await docker(["rm", "-f", foreignName]).catch(() => {});
  }

  console.log("REAL_DOCKER_SMOKE_PASS: actual networkless build, failure, offline dependency and labelled orphan cleanup verified");
} finally {
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}
