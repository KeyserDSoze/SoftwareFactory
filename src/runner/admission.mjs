/** Global filesystem admission lock and bounded retry-safe job registration.
 * The disk is assumed to have atomic POSIX mkdir semantics (not arbitrary NFS).
 * Never take over a stale lock by age: a process may still own an admission.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { atomicWrite, jobDirectory, jobId, readReport } from "./common.mjs";
import { recordJobEvidence, verifyJobEvidence } from "./evidence.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const issue = code => Object.assign(new Error(code), { code });
export function parseIdempotencyKey(header) {
  if (header === undefined) return null;
  if (typeof header !== "string" || !UUID.test(header)) throw issue("INVALID_IDEMPOTENCY_KEY");
  // Only a one-way fingerprint of this non-secret UUID is ever persisted.
  return createHash("sha256").update(header.toLowerCase()).digest("hex");
}

export async function withAdmissionLock(dataDir, operation, waitMs = 1500) {
  const root = path.join(dataDir, "jobs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, ".admission");
  const started = Date.now();
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - started >= waitMs) throw issue("ADMISSION_BUSY");
      await sleep(25);
    }
  }
  try { return await operation(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

/** Lock is held across quota scan, duplicate lookup, and committed job creation.
 * The key fingerprint lives in the original report and thus in its journal;
 * retention deletes it with the job (no unbounded secondary idempotency index).
 */
export async function admitRunnerJob({
  dataDir, checked, idempotencyKey = null,
  maxQueued = 4, maxRetained = 100, waitMs = 1500,
}) {
  if (!Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > 100 ||
      !Number.isInteger(maxRetained) || maxRetained < 1 || maxRetained > 100 ||
      !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000)
    throw new Error("Invalid runner admission limits");
  const fingerprint = parseIdempotencyKey(idempotencyKey ?? undefined);
  return withAdmissionLock(dataDir, async () => {
    const entries = await readdir(path.join(dataDir, "jobs"), { withFileTypes: true });
    const ids = entries.filter(entry => JOB_ID.test(entry.name)).map(entry => entry.name);
    let active = 0, matching = null;
    for (const id of ids) {
      let report;
      try { report = await readReport(dataDir, id); }
      catch {
        // No capacity can be freed by removing or corrupting a report.
        throw issue("ADMISSION_INTEGRITY");
      }
      if (report.id !== id || !["queued", "running", "passed", "failed", "incomplete"].includes(report.state))
        throw issue("ADMISSION_INTEGRITY");
      if (fingerprint && report.idempotencyKeyHash === fingerprint) {
        if (matching) throw issue("ADMISSION_INTEGRITY");
        matching = report;
      }
      if (report.state === "queued" || report.state === "running") active++;
    }
    // Retries are returned *before* capacity checks, even if the queue is full.
    if (matching) {
      if (matching.digest !== checked.digest) throw issue("IDEMPOTENCY_CONFLICT");
      try { await verifyJobEvidence(dataDir, matching.id); }
      catch { throw issue("ADMISSION_INTEGRITY"); }
      return { id: matching.id, digest: matching.digest, state: "queued" };
    }
    if (ids.length >= maxRetained || active >= maxQueued) throw issue("QUEUE_FULL");
    const id = jobId(), dir = jobDirectory(dataDir, id);
    await mkdir(dir, { mode: 0o700 });
    // If a write fails after mkdir, retain this directory for operator inspection:
    // the quota must NOT be bypassable by partially-written job records.
    await writeFile(path.join(dir, "input.json"), JSON.stringify(checked.request),
      { flag: "wx", mode: 0o600 });
    const report = { id, schemaVersion: 1, label: checked.request.label, digest: checked.digest,
      state: "queued", acceptedAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, fileCount: checked.fileCount, bytes: checked.bytes,
      steps: checked.request.steps, results: [], summary: "In attesa del worker",
      ...(fingerprint ? { idempotencyKeyHash: fingerprint } : {}),
    };
    await atomicWrite(path.join(dir, "report.json"), report);
    await recordJobEvidence(dataDir, id, report, "accepted");
    return { id, digest: checked.digest, state: "queued" };
  }, waitMs);
}
