/** Global filesystem admission lock and bounded retry-safe job registration.
 * The disk is assumed to have atomic POSIX mkdir semantics (not arbitrary NFS).
 * Never take over a stale lock by age: a process may still own an admission.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { atomicWrite, jobDirectory, jobId } from "./common.mjs";
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

/** A worker can be between fsync(journal) and atomic rename(report) while
 * holding its own .claim, not the API admission lock. Bounded retries tolerate
 * that short transition; persistent integrity failures never free capacity.
 */
export async function verifiedAdmissionReport(dataDir, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return (await verifyJobEvidence(dataDir, id)).report; }
    catch (error) {
      if (error.code !== "EVIDENCE_INVALID" || attempt === 2)
        throw issue("ADMISSION_INTEGRITY");
      await sleep(25);
    }
  }
  throw issue("ADMISSION_INTEGRITY");
}

/** Rate limiting uses only verified retained job timestamps. Expired jobs no
 * longer count; a future acceptedAt is counted conservatively, never silently
 * dropped. This is global per shared volume, not a tenant/IP rate limiter.
 * Returns null for capacity, else bounded Retry-After seconds.
 */
export function admissionRateLimitRetryAfter(acceptedAtValues, nowMs, maxPerMinute) {
  if (maxPerMinute === 0) return null;
  const recent = [];
  for (const acceptedAt of acceptedAtValues) {
    if (typeof acceptedAt !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(acceptedAt))
      throw issue("ADMISSION_INTEGRITY");
    const at = Date.parse(acceptedAt);
    if (!Number.isFinite(at) || new Date(at).toISOString() !== acceptedAt)
      throw issue("ADMISSION_INTEGRITY");
    if (at > nowMs - 60_000) recent.push(at);
  }
  if (recent.length < maxPerMinute) return null;
  // When an operator reduces the cap, there may already be MORE than the
  // new maximum in the verified 60s window. Expiring the oldest alone would
  // still leave the queue rate-limited. Wait for the (N - cap + 1)th
  // expiration, i.e. the element at zero-based index N - cap.
  // Sorting also makes the hint independent of filesystem enumeration order.
  recent.sort((a, b) => a - b);
  const enoughExpiredAt = recent[recent.length - maxPerMinute] + 60_000;
  return Math.min(60, Math.max(1,
    Math.ceil((enoughExpiredAt - nowMs) / 1000)));
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
  maxAcceptedPerMinute = 0, reauthorize = undefined, tenant = null,
}) {
  if (!Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > 100 ||
      !Number.isInteger(maxRetained) || maxRetained < 1 || maxRetained > 100 ||
      !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000 ||
      !Number.isInteger(maxAcceptedPerMinute) ||
      maxAcceptedPerMinute < 0 || maxAcceptedPerMinute > 100)
    throw new Error("Invalid runner admission limits");
  const fingerprint = parseIdempotencyKey(idempotencyKey ?? undefined);
  return withAdmissionLock(dataDir, async () => {
    let currentTenant = tenant;
    const refreshAuth = async () => {
      if (!reauthorize) return;
      const next = await reauthorize();
      if (tenant) {
        if (!next || next.id !== tenant.id) throw issue("TENANT_AUTH_REVOKED");
        currentTenant = next; // Quota changes must take effect under the lock.
      }
    };
    await refreshAuth();
    const entries = await readdir(path.join(dataDir, "jobs"), { withFileTypes: true });
    const ids = entries.filter(entry => JOB_ID.test(entry.name)).map(entry => entry.name);
    let active = 0, matching = null, tenantActive = 0, tenantRetained = 0;
    const acceptedAtValues = [], tenantAcceptedAt = [];
    for (const id of ids) {
      // Every retained sibling is verified, even if a matching retry key was
      // already found. A forged terminal state must never free quota.
      const report = await verifiedAdmissionReport(dataDir, id);
      if (report.id !== id || !["queued", "running", "passed", "failed", "incomplete"].includes(report.state))
        throw issue("ADMISSION_INTEGRITY");
      // A copied idempotency key from another tenant must not reveal its job,
      // nor block the original tenant with a false collision.
      const owned = tenant ? report.tenantId === tenant.id : report.tenantId === undefined;
      if (fingerprint && owned && report.idempotencyKeyHash === fingerprint) {
        if (matching) throw issue("ADMISSION_INTEGRITY");
        matching = report;
      }
      const activeState = report.state === "queued" || report.state === "running";
      if (activeState) active++;
      if (maxAcceptedPerMinute > 0) acceptedAtValues.push(report.acceptedAt);
      if (tenant && owned) {
        tenantRetained++;
        if (activeState) tenantActive++;
        tenantAcceptedAt.push(report.acceptedAt);
      }
    }
    await refreshAuth(); // Scan may take time; fence idempotent replays.
    // Retries are returned *before* capacity checks, even if the queue is full.
    if (matching) {
      if (matching.digest !== checked.digest) throw issue("IDEMPOTENCY_CONFLICT");
      // Verified in the complete scan above: a replay returns the CURRENT
      // state, not a fictitious new queued job. This is not test attestation.
      return { id: matching.id, digest: matching.digest, state: matching.state };
    }
    const enforceQuotas = () => {
      if (ids.length >= maxRetained || active >= maxQueued ||
          (tenant && (tenantRetained >= currentTenant.maxRetained ||
            tenantActive >= currentTenant.maxQueued))) throw issue("QUEUE_FULL");
      const now = Date.now();
      const globalRetry = admissionRateLimitRetryAfter(
        acceptedAtValues, now, maxAcceptedPerMinute);
      const tenantRetry = tenant
        ? admissionRateLimitRetryAfter(
          tenantAcceptedAt, now, currentTenant.maxAcceptedPerMinute) : null;
      if (globalRetry !== null || tenantRetry !== null)
        throw Object.assign(issue("RATE_LIMIT"), {
          retryAfter: Math.max(globalRetry ?? 0, tenantRetry ?? 0),
        });
    };
    enforceQuotas();
    await refreshAuth(); // Revalidate current key and current quota before mkdir.
    enforceQuotas();
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
      ...(tenant ? { tenantId: tenant.id } : {}),
      ...(fingerprint ? { idempotencyKeyHash: fingerprint } : {}),
    };
    await atomicWrite(path.join(dir, "report.json"), report);
    await recordJobEvidence(dataDir, id, report, "accepted");
    return { id, digest: checked.digest, state: "queued" };
  }, waitMs);
}
