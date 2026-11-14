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
import { atomicWrite, jobDirectory, readReport, validateRequest } from "../common.mjs";
import { executeJob } from "../worker.mjs";

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
  const report = await executeJob(id, { dataDir, workspaceRoot: work, environment: {
    RUNNER_NODE_IMAGE: "node:22-bookworm-slim", RUNNER_ALLOW_NET_DEPS: "false",
    RUNNER_CONTAINER_UID: process.getuid() + ":" + process.getgid(),
  } });
  assert.equal(report.digest, checked.digest);
  assert.deepEqual((await readReport(dataDir, id)).results, report.results);
  assert.equal((await readdir(work)).length, 0, "No build workspace should survive the job");
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

  console.log("REAL_DOCKER_SMOKE_PASS: actual networkless build, intentional failure and offline dependency block verified");
} finally {
  await rm(dataDir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}
