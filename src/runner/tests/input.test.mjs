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
import { executeJob } from "../worker.mjs";

const id = "00000000-0000-4000-a000-000000000053";
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-worker-input-"));
  const dir = jobDirectory(dataDir, id);
  await mkdir(dir, { recursive: true });
  const checked = validateRequest({
    label: "Snapshot safety",
    files: { "src/backend/domain/Item.cs": "namespace Demo; public record Item(int Value);" },
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
