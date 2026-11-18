import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGuardedIndex } from "../workflows.mjs";
import { reconcilePendingBatch } from "../batch-recovery.mjs";
import { readReport } from "../common.mjs";
import { executeJob } from "../worker.mjs";

const childScript = fileURLToPath(new URL("./fixtures/batch-crash-child.mjs", import.meta.url));
const exists = async p => stat(p).then(() => true, e => {
  if (e.code === "ENOENT") return false;
  throw e;
});
const worker = (dataDir, id) => executeJob(id, {
  dataDir, workspaceRoot: path.join(dataDir, "workspace"),
  createStepPlan: step => ({ step }),
  executeStep: async (_plan, _id, step) =>
    ({ step, state: "passed", exitCode: 0, durationMs: 4, timedOut: false }),
});

async function killAt(dataDir, phase) {
  const child = fork(childScript, [dataDir, phase], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errorOutput = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => errorOutput += chunk);
  try {
    const message = await Promise.race([
      new Promise((resolve, reject) => {
        child.once("message", resolve);
        child.once("exit", (code, signal) =>
          reject(new Error("child exited before checkpoint " + phase +
            ": " + code + "/" + signal + " " + errorOutput)));
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("crash checkpoint timeout: " + phase)), 12_000)),
    ]);
    assert.equal(message.error, undefined, message.error);
    assert.equal(message.phase, phase);
    const died = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    const [exitCode, signal] = await died;
    assert.equal(exitCode, null);
    assert.equal(signal, "SIGKILL");
    // A real SIGKILL leaves the POSIX admission lock. The local operator
    // has stopped ALL processes, inspected the owner, and releases it here.
    // The production runner NEVER takes over a stale lock by age.
    const lock = path.join(dataDir, "jobs", ".admission");
    assert.equal(await exists(lock), true);
    await rm(lock, { recursive: true });
    return message.workflowId;
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}

test("SIGKILL matrix at every publish boundary: no partial job can run and offline recovery is explicit", async () => {
  for (const phase of ["staged", "guarded", "moved-1", "moved-2", "manifest"]) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "sf-batch-kill-"));
    try {
      const id = await killAt(dataDir, phase);
      const root = path.join(dataDir, "workflows");
      const marker = path.join(root, ".pending-" + id);
      const manifest = path.join(root, id + ".json");
      const staging = path.join(dataDir, "workflow-staging", id);
      if (phase === "staged") {
        assert.equal(await exists(marker), false);
        assert.equal(await exists(manifest), false);
        assert.equal(await exists(staging), true);
        const jobs = await readdir(path.join(dataDir, "jobs"));
        assert.equal(jobs.length, 0, "no live jobs before guard publication");
        assert.equal((await loadGuardedIndex(dataDir)).size, 0);
        const cleared = await reconcilePendingBatch({
          dataDir, id, action: "discard-stage",
        });
        assert.deepEqual(cleared, {version:1,id,action:"discard-stage",jobCount:2});
        assert.equal(await exists(staging), false);
        continue;
      }
      assert.equal(await exists(marker), true);
      await assert.rejects(loadGuardedIndex(dataDir), { code:"WORKFLOW_INTEGRITY" });
      const live = (await readdir(path.join(dataDir, "jobs")))
        .filter(name => name !== ".admission");
      if (live.length)
        await assert.rejects(worker(dataDir, live[0]), {code:"WORKFLOW_INTEGRITY"});
      if (phase === "manifest") {
        assert.equal(await exists(manifest), true);
        const done = await reconcilePendingBatch({
          dataDir, id, action: "finalize",
        });
        assert.deepEqual(done,{version:1,id,action:"finalize",jobCount:2});
        assert.equal((await loadGuardedIndex(dataDir)).size, 2);
        assert.equal((await readdir(path.join(dataDir, "jobs"))).length, 2);
        for (const jobId of await readdir(path.join(dataDir, "jobs")))
          assert.equal((await readReport(dataDir, jobId)).state, "queued");
      } else {
        assert.equal(await exists(manifest), false);
        const done = await reconcilePendingBatch({dataDir,id,action:"abort"});
        assert.deepEqual(done,{version:1,id,action:"abort",jobCount:2});
        assert.equal((await readdir(path.join(dataDir,"jobs"))).length,0);
        assert.equal((await loadGuardedIndex(dataDir)).size, 0);
      }
      assert.equal(await exists(marker), false);
    } finally {
      await rm(dataDir, { recursive:true, force:true });
    }
  }
});
