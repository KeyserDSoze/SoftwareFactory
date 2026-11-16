import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { atomicWrite, jobDirectory, validateRequest, readReport } from "../common.mjs";
import { recordJobEvidence, verifyJobEvidence, portableEvidenceBundle,
  verifyEvidenceExport } from "../evidence.mjs";
import { reconcileRunnerContainers, runnerContainerIdentity } from "../orphans.mjs";
import { beginRepairSession } from "../coordinator.mjs";
import { runWorker } from "../worker.mjs";

const execFile = promisify(execFileCallback);
const firstId = "a".repeat(64), secondId = "b".repeat(64);
const expired = () => new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
const timeout = { step: "web-build", state: "skipped",
  timedOut: true, exitCode: null, cleanupVerified: false, reason: "timeout" };

async function fixture({ legacyRecovered = false, old = false,
  status = "incomplete", withTimeout = true, sharedDir = null } = {}) {
  const dataDir = sharedDir ?? await mkdtemp(path.join(tmpdir(), "sf-operator-finalize-"));
  const id = randomUUID(), dir = jobDirectory(dataDir, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const checked = validateRequest({ label: "Finalization test", files: {
    "src/frontend/web/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "src/frontend/web/src/index.tsx": "export const value = 1",
  }, steps: ["web-build"] });
  await writeFile(path.join(dir, "input.json"), JSON.stringify(checked.request),
    { mode: 0o600 });
  await atomicWrite(path.join(dir, "report.json"), {
    id, digest: checked.digest, state: "queued", label: checked.request.label,
    acceptedAt: old ? expired() : new Date().toISOString(),
    steps: ["web-build"], results: [],
  });
  await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
  await recordJobEvidence(dataDir, id, {
    ...(await readReport(dataDir, id)), state: "running", startedAt: expired(),
  }, "started");
  if (withTimeout || status === "failed") {
    await recordJobEvidence(dataDir, id, {
      ...(await readReport(dataDir, id)),
      results: [withTimeout ? timeout : {
        step: "web-build", state: "failed", exitCode: 7,
        timedOut: false, durationMs: 10, stdout: "compiler error", stderr: "",
      }],
    }, "step");
  }
  await recordJobEvidence(dataDir, id, {
    ...(await readReport(dataDir, id)), state: status,
    finishedAt: old ? expired() : new Date().toISOString(),
    summary: legacyRecovered ? "Legacy recovered" : "Timed out; cleanup unverified",
  }, legacyRecovered ? "recovered" : "finished");
  return { dataDir, dir, id, close: () =>
    rm(sharedDir ? dir : dataDir, { recursive: true, force: true }) };
}

function dockerFor(id, { contain = [], leave = false, fail = null } = {}) {
  const active = new Map(contain.map(({ full, step }) => [full, { step,
    name: runnerContainerIdentity(id, step).name }]));
  const calls = [];
  const runDocker = async args => {
    calls.push(args);
    if (fail === args[0]) throw Error("secret Docker error must not be persisted");
    if (args[0] === "ps")
      return [...active.keys()].map(full => full.slice(0, 12)).join("\n") +
        (active.size ? "\n" : "");
    if (args[0] === "inspect") {
      const full = [...active.keys()].find(x => x.startsWith(args[1]));
      if (!full) throw Error("Unknown container");
      const { step, name } = active.get(full);
      return JSON.stringify([{
        Id: full, Name: "/" + name,
        Config: { Labels: Object.fromEntries(runnerContainerIdentity(id, step).labels) },
        State: { Status: "created" },
      }]);
    }
    if (args[0] === "rm") {
      if (!active.has(args[2])) throw Error("No matching Docker ID");
      if (!leave) active.delete(args[2]);
      return args[2] + "\n";
    }
    throw Error("Unknown Docker command");
  };
  return { runDocker, active, calls };
}
const applied = (f, docker, more = {}) => reconcileRunnerContainers({
  dataDir: f.dataDir, jobId: f.id, apply: true,
  confirmJob: f.id, finalize: true, runDocker: docker.runDocker, ...more,
});

test("finalization with zero containers appends one verified event, preserves failed verdict", async () => {
  const f = await fixture();
  try {
    const backend = dockerFor(f.id);
    const before = await verifyJobEvidence(f.dataDir, f.id);
    const result = await applied(f, backend);
    assert.equal(result.finalized, true);
    assert.equal(result.applied, true);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(backend.calls.map(a => a[0]), ["ps", "ps"]);
    const after = await verifyJobEvidence(f.dataDir, f.id);
    assert.equal(after.entries.length, before.entries.length + 1);
    assert.equal(after.entries.at(-1).kind, "reconciled");
    assert.equal(after.report.state, "incomplete");
    assert.equal(after.report.digest, before.report.digest);
    assert.equal(after.report.finishedAt, before.report.finishedAt);
    assert.deepEqual(after.report.results, before.report.results);
    assert.equal(after.report.reconciliation.removedCount, 0);
    assert.equal(after.report.reconciliation.noRemaining, true);
    assert.ok(!JSON.stringify(after).includes("secret Docker"));
    assert.equal(verifyEvidenceExport(portableEvidenceBundle(after)).head, after.head);
    await assert.rejects(readFile(path.join(f.dir, ".claim")),
      { code: "ENOENT" }, "operator must release its exclusive claim");
  } finally { await f.close(); }
});

test("verified Docker full-ID removal and fresh empty-list query are required before event", async () => {
  const f = await fixture();
  try {
    const backend = dockerFor(f.id, { contain: [
      { full: firstId, step: "web-build" },
      { full: secondId, step: "npm-prepare" },
    ] });
    const result = await applied(f, backend);
    assert.deepEqual(result.removed, [firstId, secondId]);
    assert.equal(result.finalized, true);
    assert.equal(backend.active.size, 0);
    assert.deepEqual(backend.calls.map(c => c[0]),
      ["ps", "inspect", "inspect", "inspect", "rm",
        "inspect", "rm", "ps"]);
    const verified = await verifyJobEvidence(f.dataDir, f.id);
    assert.equal(verified.report.reconciliation.removedCount, 2);
    assert.equal(verified.entries.at(-1).kind, "reconciled");
    const previous = verified.entries.at(-2).report;
    assert.equal(previous.state, verified.report.state);
    assert.equal(previous.digest, verified.report.digest);
    assert.equal(verified.report.results[0].timedOut, true);
  } finally { await f.close(); }
});

test("a second finalize is refused; ordinary apply never emits a reconciled event", async () => {
  const f = await fixture();
  try {
    const backend = dockerFor(f.id);
    const normal = await reconcileRunnerContainers({
      dataDir: f.dataDir, jobId: f.id, apply: true,
      confirmJob: f.id, runDocker: backend.runDocker,
    });
    assert.equal(normal.finalized, false);
    assert.equal((await verifyJobEvidence(f.dataDir, f.id)).entries.at(-1).kind, "finished");
    await applied(f, backend);
    const count = (await verifyJobEvidence(f.dataDir, f.id)).entries.length;
    const invoked = backend.calls.length;
    await assert.rejects(applied(f, backend), /Cleanup denied/);
    assert.equal(backend.calls.length, invoked);
    assert.equal((await verifyJobEvidence(f.dataDir, f.id)).entries.length, count);
  } finally { await f.close(); }
});

test("finalization denied on leftover containers, failed Docker and malformed final ps", async () => {
  for (const variant of ["leftover", "docker-error", "malformed"]) {
    const f = await fixture();
    try {
      const backend = dockerFor(f.id, { contain: [
        { full: firstId, step: "web-build" },
      ], leave: variant === "leftover" });
      let psCount = 0;
      const runDocker = async args => {
        if (args[0] === "ps") {
          psCount++;
          if (psCount === 2 && variant === "docker-error")
            throw Error("private runner docker secret");
          if (psCount === 2 && variant === "malformed")
            return "not-a-valid-docker-ID\n";
        }
        return backend.runDocker(args);
      };
      await assert.rejects(applied(f, backend, { runDocker }),
        /Finalization denied|Unexpected Docker container IDs|private runner docker secret/);
      const evidence = await verifyJobEvidence(f.dataDir, f.id);
      assert.equal(evidence.entries.at(-1).kind, "finished");
      assert.equal(evidence.report.reconciliation, undefined);
      assert.deepEqual(await rm(path.join(f.dir, ".claim"))
        .then(() => "claim still exists").catch(e => e.code), "ENOENT");
    } finally { await f.close(); }
  }
});

test("two concurrent operators cannot both finalize or issue Docker rm", async () => {
  const f = await fixture();
  let unblock, arrived;
  const entered = new Promise(resolve => { arrived = resolve; });
  const release = new Promise(resolve => { unblock = resolve; });
  const backend = dockerFor(f.id, { contain: [{ full: firstId, step: "web-build" }] });
  try {
    let firstPs = true;
    const original = backend.runDocker;
    backend.runDocker = async args => {
      if (args[0] === "ps" && firstPs) {
        firstPs = false;
        arrived();
        await release;
      }
      return original(args);
    };
    const first = applied(f, backend);
    await entered;
    await assert.rejects(applied(f, backend), /Cleanup denied/);
    unblock();
    const result = await first;
    assert.equal(result.removed.length, 1);
    assert.equal(backend.calls.filter(c => c[0] === "rm").length, 1);
    assert.equal((await verifyJobEvidence(f.dataDir, f.id)).entries.at(-1).kind,
      "reconciled");
  } finally {
    unblock?.();
    await f.close();
  }
});

test("forged or changed reconciled verdict cannot be appended to verified journal", async () => {
  const f = await fixture();
  try {
    const base = (await verifyJobEvidence(f.dataDir, f.id)).report;
    const info = { version: 1, at: new Date().toISOString(),
      removedCount: 0, noRemaining: true };
    const invalid = [
      { ...base, state: "passed", reconciliation: info },
      { ...base, digest: "a".repeat(64), reconciliation: info },
      { ...base, results: [], reconciliation: info },
      { ...base, reconciliation: { ...info, noRemaining: false } },
      { ...base, reconciliation: { ...info, removedCount: 999 } },
      { ...base, reconciliation: { ...info, secret: "never" } },
      { ...base },
    ];
    for (const candidate of invalid) {
      await assert.rejects(recordJobEvidence(f.dataDir, f.id,
        candidate, "reconciled"), { code: "EVIDENCE_INVALID" });
      assert.equal((await verifyJobEvidence(f.dataDir, f.id)).entries.at(-1).kind,
        "finished");
    }
    const backend = dockerFor(f.id);
    await applied(f, backend);
    const latest = (await verifyJobEvidence(f.dataDir, f.id)).report;
    await assert.rejects(recordJobEvidence(f.dataDir, f.id, {
      ...latest, reconciliation: info,
    }, "reconciled"), { code: "EVIDENCE_INVALID" });
    await assert.rejects(recordJobEvidence(f.dataDir, f.id,
      latest, "step"), { code: "EVIDENCE_INVALID" });
    const mutated = { ...latest, state: "passed" };
    await atomicWrite(path.join(f.dir, "report.json"), mutated);
    await assert.rejects(verifyJobEvidence(f.dataDir, f.id), { code: "EVIDENCE_INVALID" });
  } finally { await f.close(); }
});

test("legacy recovered=failed never becomes repairable after reconciliation", async () => {
  const f = await fixture({
    status: "failed", legacyRecovered: true, withTimeout: false,
  });
  try {
    const backend = dockerFor(f.id);
    const options = { failedJobId: f.id, proposalId: randomUUID(),
      paths: ["src/frontend/web/src/index.tsx"], consent: true };
    await assert.rejects(beginRepairSession(f.dataDir, options, "editor"),
      { code: "REPAIR_NOT_FAILED" });
    await applied(f, backend);
    const verified = await verifyJobEvidence(f.dataDir, f.id);
    assert.deepEqual(verified.entries.slice(-2).map(x => x.kind),
      ["recovered", "reconciled"]);
    await assert.rejects(beginRepairSession(f.dataDir, options, "editor"),
      { code: "REPAIR_NOT_FAILED" });
  } finally { await f.close(); }
});

test("retention releases only finalized old recovered/timeout evidence", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-reconciled-retention-"));
  try {
    const recovered = await fixture({
      sharedDir: dataDir, old: true, legacyRecovered: true,
    });
    const unresolved = await fixture({ sharedDir: dataDir, old: true });
    const reconciled = await fixture({ sharedDir: dataDir, old: true });
    await applied(recovered, dockerFor(recovered.id));
    await applied(reconciled, dockerFor(reconciled.id));
    const runOnce = () => runWorker({
      dataDir, workspaceRoot: path.join(dataDir, "workspaces"), pollMs: 1,
      heartbeatIntervalMs: 60_000,
      stop: (() => { let n = 0; return () => n++ > 0; })(),
      executeQueuedJob: async () => { throw Error("No queued job expected"); },
    });
    const before = await verifyJobEvidence(dataDir, reconciled.id);
    assert.equal(before.entries.at(-1).kind, "reconciled");
    assert.equal((await verifyJobEvidence(dataDir, unresolved.id))
      .entries.at(-1).kind, "finished");
    await runOnce();
    for (const id of [recovered.id, reconciled.id])
      await assert.rejects(verifyJobEvidence(dataDir, id), { code: "ENOENT" },
        "operator-finalized old jobs may expire at their original finishedAt");
    const retained = await verifyJobEvidence(dataDir, unresolved.id);
    assert.equal(retained.entries.at(-1).kind, "finished");
    assert.equal(retained.report.results[0].cleanupVerified, false);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("invalid CLI finalize flags reject before Docker, no unconfirmed event", async () => {
  const cli = fileURLToPath(new URL("../orphans.mjs", import.meta.url));
  const args = [
    ["--job=" + randomUUID(), "--finalize"],
    ["--job=" + randomUUID(), "--apply", "--finalize"],
    ["--job=" + randomUUID(), "--finalize", "--finalize"],
    ["--job=" + randomUUID(), "--apply", "--confirm-job=" + randomUUID(),
      "--finalize", "--finalize"],
  ];
  for (const argv of args) {
    await assert.rejects(execFile(process.execPath, [cli, ...argv]),
      error => error.code === 1 && /requires --apply|Invalid arguments|confirm-job/.
        test(error.stderr || ""));
  }
});
