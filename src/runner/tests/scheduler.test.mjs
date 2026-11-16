import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite, jobDirectory, readReport, validateRequest } from "../common.mjs";
import { recordJobEvidence, verifyJobEvidence } from "../evidence.mjs";
import { rememberStartedJob, selectNextQueuedJob } from "../scheduler.mjs";
import { runWorker } from "../worker.mjs";

const queued = (id, tenantId, acceptedAt) => ({ id, tenantId, acceptedAt });
const iso = milliseconds => new Date(milliseconds).toISOString();
const later = Date.parse("2026-11-16T12:00:00.000Z");

test("tenant scheduler selects never-served first, then least recently started, with per-tenant FIFO", () => {
  const jobs = [
    queued("00000000-0000-4000-a000-000000000001", "alpha", iso(later - 10_000)),
    queued("00000000-0000-4000-a000-000000000002", "alpha", iso(later - 9_000)),
    queued("00000000-0000-4000-a000-000000000003", "bravo", iso(later - 5_000)),
  ];
  const history = new Map();
  assert.equal(selectNextQueuedJob([]), null);
  assert.equal(selectNextQueuedJob(jobs, history).id, jobs[0].id,
    "when none has run yet, select the oldest pending job");
  rememberStartedJob(history, { tenantId: "alpha", startedAt: iso(later) });
  assert.equal(selectNextQueuedJob(jobs, history).id, jobs[2].id,
    "newly arrived tenant B must not wait for all of A");
  rememberStartedJob(history, { tenantId: "bravo", startedAt: iso(later + 1000) });
  assert.equal(selectNextQueuedJob(jobs, history).id, jobs[0].id,
    "least recently served tenant A wins; FIFO within A");
  rememberStartedJob(history, { tenantId: "alpha", startedAt: iso(later + 2000) });
  assert.equal(selectNextQueuedJob(jobs, history).id, jobs[2].id);
  assert.equal(selectNextQueuedJob(jobs.slice(0, 2), history).id, jobs[0].id);
});

test("scheduler uses only real starts, last verified timestamp and deterministic legacy FIFO", () => {
  const history = new Map();
  rememberStartedJob(history, { tenantId: "alpha", startedAt: null });
  rememberStartedJob(history, { tenantId: "alpha", startedAt: "bad" });
  rememberStartedJob(history, { tenantId: "alpha", startedAt: iso(later + 5000) });
  rememberStartedJob(history, { tenantId: "alpha", startedAt: iso(later + 1000) });
  assert.equal(history.size, 1);
  assert.equal(history.get("alpha"), later + 5000);
  rememberStartedJob(history, { state: "incomplete", tenantId: "bravo", startedAt: null,
    finishedAt: iso(later + 9000) });
  assert.equal(history.has("bravo"), false, "rejected queued jobs do not count as service");
  const legacy = [
    queued("00000000-0000-4000-a000-000000000010", undefined, iso(later + 1000)),
    queued("00000000-0000-4000-a000-000000000012", undefined, iso(later)),
    queued("00000000-0000-4000-a000-000000000011", undefined, iso(later)),
  ];
  assert.equal(selectNextQueuedJob(legacy, history).id,
    "00000000-0000-4000-a000-000000000011",
    "only legacy entries remain FIFO with UUID tie break");
  const mixed = [legacy[0], queued("00000000-0000-4000-a000-000000000015",
    "bravo", iso(later + 2000))];
  rememberStartedJob(history, { startedAt: iso(later) });
  assert.equal(selectNextQueuedJob(mixed, history).tenantId, "bravo",
    "legacy jobs count as one group; never-served tenant gets a turn");
});

async function fixture(groups) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-fair-schedule-"));
  const work = path.join(dataDir, "workspaces");
  const checked = validateRequest({
    label: "Fairness test",
    files: {
      "src/backend/applications/Api/Api.csproj":
        "<Project><PropertyGroup><TargetFramework>net11.0</TargetFramework></PropertyGroup></Project>",
    },
    steps: ["dotnet-build"],
  });
  const jobs = [];
  const base = Date.now() - 30_000;
  try {
    for (let i = 0; i < groups.length; i++) {
      const id = randomUUID();
      const dir = jobDirectory(dataDir, id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(dir, "input.json"), JSON.stringify(checked.request),
        { mode: 0o600 });
      const tenantId = groups[i];
      await atomicWrite(path.join(dir, "report.json"), {
        id, schemaVersion: 1, digest: checked.digest, label: checked.request.label,
        state: "queued", acceptedAt: iso(base + i * 1000),
        startedAt: null, finishedAt: null, steps: ["dotnet-build"],
        results: [], ...(tenantId ? { tenantId } : {}),
      });
      await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
      jobs.push({ id, tenantId });
    }
    return { dataDir, work, jobs, close: () => rm(dataDir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}
async function pollOnce(f, processed, startBase) {
  await runWorker({
    dataDir: f.dataDir, workspaceRoot: f.work, pollMs: 1,
    heartbeatIntervalMs: 60_000,
    stop: (() => { let count = 0; return () => count++ > 0; })(),
    executeQueuedJob: async id => {
      processed.push(id);
      const { report } = await verifyJobEvidence(f.dataDir, id);
      const startedAt = iso(startBase + processed.length * 1000);
      const running = await recordJobEvidence(f.dataDir, id, {
        ...report, state: "running", startedAt, summary: "Fixture started",
      }, "started");
      await recordJobEvidence(f.dataDir, id, {
        ...running, state: "incomplete", finishedAt: iso(startBase + processed.length * 1000 + 1),
        summary: "Fixture intentionally skips code execution",
      }, "finished");
    },
  });
}

test("real verified job journal yields fair A-B-A-B-A worker turns instead of FIFO starvation", async () => {
  const f = await fixture(["alpha", "alpha", "alpha", "bravo", "bravo"]);
  const executed = [];
  const startBase = Date.now() - 15_000;
  try {
    for (let i = 0; i < f.jobs.length; i++) await pollOnce(f, executed, startBase);
    assert.deepEqual(executed, [f.jobs[0].id, f.jobs[3].id, f.jobs[1].id,
      f.jobs[4].id, f.jobs[2].id]);
    for (const { id, tenantId } of f.jobs) {
      const { report, entries } = await verifyJobEvidence(f.dataDir, id);
      assert.equal(report.state, "incomplete");
      assert.equal(report.tenantId, tenantId);
      assert.deepEqual(entries.map(e => e.kind), ["accepted", "started", "finished"]);
    }
    await pollOnce(f, executed, startBase);
    assert.equal(executed.length, 5, "terminal jobs cannot execute again");
  } finally { await f.close(); }
});

test("claimed oldest job is not selected, and pure legacy queues remain global FIFO", async () => {
  const f = await fixture(["alpha", "alpha", "bravo"]);
  const processed = [];
  const startBase = Date.now() - 15_000;
  const claim = path.join(jobDirectory(f.dataDir, f.jobs[0].id), ".claim");
  try {
    await mkdir(claim, { mode: 0o700 });
    await pollOnce(f, processed, startBase);
    assert.deepEqual(processed, [f.jobs[1].id],
      "claimed oldest job must not prevent another tenant or job executing");
    await rm(claim, { recursive: true });
    await pollOnce(f, processed, startBase);
    assert.deepEqual(processed, [f.jobs[1].id, f.jobs[2].id],
      "unserved bravo gets a turn despite alpha's older pending job");
    await pollOnce(f, processed, startBase);
    assert.deepEqual(processed, [f.jobs[1].id, f.jobs[2].id, f.jobs[0].id]);
  } finally { await f.close(); }

  const legacy = await fixture([undefined, undefined, undefined]);
  const order = [];
  try {
    for (let i = 0; i < legacy.jobs.length; i++)
      await pollOnce(legacy, order, startBase);
    assert.deepEqual(order, legacy.jobs.map(j => j.id),
      "no tenant ID: use existing global oldest-accepted FIFO");
  } finally { await legacy.close(); }
});
