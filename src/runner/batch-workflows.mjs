/** Atomic opt-in batch admission into an existing enforced runner DAG (#103).
 * Independent job submission and AI execution are NOT triggered by this
 * endpoint. Sources are kept only in private job input.json files; the
 * durable v2 workflow manifest contains digests, not content.
 *
 * POSIX rename and the shared admission lock provide publication safety.
 * A .pending-* guard in workflows forces all workers to stop on a partial
 * publish after an API crash, rather than running an ungoverned job.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, jobDirectory, jobId, MAX_REQUEST_BYTES, validateRequest } from "./common.mjs";
import { recordJobEvidence } from "./evidence.mjs";
import { verifiedAdmissionReport, admissionRateLimitRetryAfter,
  parseIdempotencyKey, withAdmissionLock } from "./admission.mjs";
import { getWorkflow, loadGuardedIndex } from "./workflows.mjs";

const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TASK_ID = /^[a-z][a-z0-9-]{1,31}$/;
const ROLES = new Set(["project_manager", "tester", "test_architect",
  "devops_engineer", "code_reviewer", "fullstack_developer", "fix_developer",
  "release_manager", "security_engineer"]);
export const MAX_BATCH_BODY_BYTES = MAX_REQUEST_BYTES * 6 + 8192;
const issue = code => Object.assign(new Error(code), { code });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (value, fields) => value && typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...fields].sort().join(",");

function parseBatch(input) {
  if (!exact(input, ["consent", "enforced", "label", "tasks"]) ||
      input.consent !== true || input.enforced !== true ||
      typeof input.label !== "string" ||
      input.label.trim().length < 2 || input.label.trim().length > 120 ||
      !Array.isArray(input.tasks) || input.tasks.length < 2 || input.tasks.length > 6)
    throw issue("WORKFLOW_INVALID");
  const seen = new Set(), tasks = [];
  for (const task of input.tasks) {
    if (!exact(task, ["id", "role", "dependsOn", "request"]) ||
        typeof task.id !== "string" || !TASK_ID.test(task.id) ||
        seen.has(task.id) || !ROLES.has(task.role) ||
        !Array.isArray(task.dependsOn) || task.dependsOn.length > 3 ||
        task.dependsOn.some(d => typeof d !== "string" || !seen.has(d)) ||
        new Set(task.dependsOn).size !== task.dependsOn.length)
      throw issue("WORKFLOW_INVALID");
    let checked;
    try {
      if (Buffer.byteLength(JSON.stringify(task.request)) > MAX_REQUEST_BYTES)
        throw issue("WORKFLOW_INVALID");
      checked = validateRequest(task.request);
    } catch { throw issue("WORKFLOW_INVALID"); }
    seen.add(task.id);
    tasks.push({ id: task.id, role: task.role,
      dependsOn: [...task.dependsOn], checked });
  }
  const label = input.label.trim();
  const identity = { label, tasks: tasks.map(t =>
    ({ id: t.id, role: t.role, dependsOn: t.dependsOn, digest: t.checked.digest })) };
  return { label, tasks, signature: hash(identity) };
}
const manifestRoot = dataDir => path.join(dataDir, "workflows");
async function trustedDirectory(dir) {
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.geteuid?.() ||
      (info.mode & 0o077) !== 0) throw issue("WORKFLOW_INTEGRITY");
}
async function ensurePrivateDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await trustedDirectory(dir);
}
function canonicalManifestSignature(record) {
  return hash({ label: record.label, tasks: record.tasks.map(t =>
    ({ id: t.id, role: t.role, dependsOn: t.dependsOn, digest: t.digest })) });
}
async function verifyCapacity({ dataDir, count, tenant, maxQueued, maxRetained,
  maxAcceptedPerMinute }) {
  const rows = await readdir(path.join(dataDir, "jobs"), { withFileTypes: true });
  // A partially committed batch or unexpected directory must never be
  // ignored as "free capacity" just because it lacks a complete report.
  const ids = rows.filter(x => JOB_ID.test(x.name)).map(x => x.name);
  if (rows.some(x => x.name !== ".admission" && !JOB_ID.test(x.name)))
    throw issue("ADMISSION_INTEGRITY");
  let active = 0, tenantActive = 0, tenantRetained = 0;
  const times = [], tenantTimes = [];
  for (const id of ids) {
    const report = await verifiedAdmissionReport(dataDir, id);
    if (report.id !== id ||
        !["queued", "running", "passed", "failed", "incomplete"].includes(report.state))
      throw issue("ADMISSION_INTEGRITY");
    const owned = tenant ? report.tenantId === tenant.id : report.tenantId === undefined;
    const running = ["queued", "running"].includes(report.state);
    if (running) active++;
    if (maxAcceptedPerMinute > 0) times.push(report.acceptedAt);
    if (tenant && owned) {
      tenantRetained++;
      if (running) tenantActive++;
      tenantTimes.push(report.acceptedAt);
    }
  }
  const check = currentTenant => {
    if (ids.length + count > maxRetained || active + count > maxQueued ||
        (tenant && (tenantRetained + count > currentTenant.maxRetained ||
          tenantActive + count > currentTenant.maxQueued)))
      throw issue("QUEUE_FULL");
    const rate = (values, limit) => limit === 0 ? null :
      limit < count ? 60 :
        admissionRateLimitRetryAfter(values, Date.now(), limit - count + 1);
    const globalRetry = rate(times, maxAcceptedPerMinute);
    const tenantRetry = tenant ? rate(tenantTimes, currentTenant.maxAcceptedPerMinute) : null;
    if (globalRetry !== null || tenantRetry !== null)
      throw Object.assign(issue("RATE_LIMIT"), {
        retryAfter: Math.max(globalRetry ?? 0, tenantRetry ?? 0),
      });
  };
  return check;
}
function assertLimits({ maxQueued, maxRetained, maxAcceptedPerMinute, waitMs }) {
  if (!Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > 100 ||
      !Number.isInteger(maxRetained) || maxRetained < 1 || maxRetained > 100 ||
      !Number.isInteger(maxAcceptedPerMinute) || maxAcceptedPerMinute < 0 ||
      maxAcceptedPerMinute > 100 || !Number.isInteger(waitMs) ||
      waitMs < 0 || waitMs > 10000) throw Error("Invalid runner batch limits");
}

/** Retry (even after a lost HTTP response) is bound to request digests and
 * owner, and returns the verified CURRENT state rather than a fake receipt.
 * A stale .pending-* guard prevents replay and processing until operator
 * reconciliation. No auto-expiration, so crashes never silently unlock jobs.
 */
export async function admitWorkflowBatch({ dataDir, input, idempotencyKey,
  maxQueued = 4, maxRetained = 100, maxAcceptedPerMinute = 0,
  waitMs = 1500, tenant = null, reauthorize }) {
  assertLimits({ maxQueued, maxRetained, maxAcceptedPerMinute, waitMs });
  const parsed = parseBatch(input);
  const keyHash = parseIdempotencyKey(idempotencyKey);
  if (!keyHash) throw issue("INVALID_IDEMPOTENCY_KEY");
  const fingerprint = createHash("sha256").update("batch-workflow:" + keyHash).digest("hex");
  const tenantId = tenant?.id ?? null;
  return withAdmissionLock(dataDir, async () => {
    let currentTenant = tenant;
    const refresh = async () => {
      if (!reauthorize) return;
      const next = await reauthorize();
      if (tenant && (!next || next.id !== tenant.id))
        throw issue("TENANT_AUTH_REVOKED");
      if (tenant) currentTenant = next;
    };
    await refresh();
    const root = manifestRoot(dataDir);
    await ensurePrivateDirectory(root);
    // A v1/v2 manifest, pending guard, or duplicate enforced job is verified
    // by the existing same-volume registry loader before any writes.
    const index = await loadGuardedIndex(dataDir);
    const records = new Map();
    for (const { record } of index.values()) records.set(record.id, record);
    let replay = null;
    for (const record of records.values()) {
      if (record.tenantId === tenantId && record.idempotencyHash === fingerprint) {
        if (replay) throw issue("WORKFLOW_INTEGRITY");
        replay = record;
      }
    }
    if (replay) {
      if (canonicalManifestSignature(replay) !== parsed.signature)
        throw issue("WORKFLOW_CONFLICT");
      await refresh();
      return { created: false, ...(await getWorkflow(dataDir, replay.id, tenantId, refresh)) };
    }
    const files = await readdir(root);
    if (files.length >= 64) throw issue("WORKFLOW_CAPACITY");
    const capacity = await verifyCapacity({
      dataDir, count: parsed.tasks.length, tenant: currentTenant,
      maxQueued, maxRetained, maxAcceptedPerMinute,
    });
    capacity(currentTenant);
    await refresh();
    capacity(currentTenant);

    const workflowId = randomUUID();
    const tasks = parsed.tasks.map(t => ({
      id: t.id, role: t.role, jobId: jobId(),
      digest: t.checked.digest, dependsOn: [...t.dependsOn],
    }));
    const manifest = {
      version: 2, id: workflowId, createdAt: new Date().toISOString(),
      tenantId, label: parsed.label, tasks, enforced: true,
      idempotencyHash: fingerprint,
    };
    const stageRoot = path.join(dataDir, "workflow-staging");
    await ensurePrivateDirectory(stageRoot);
    const stage = path.join(stageRoot, workflowId);
    await mkdir(path.join(stage, "jobs"), { recursive: true, mode: 0o700 });
    let guarded = false, committed = false;
    try {
      // Stage completed, privately owned job reports and evidence OUTSIDE
      // jobs/. The worker cannot enumerate or claim them.
      for (const [i, task] of tasks.entries()) {
        const checked = parsed.tasks[i].checked;
        const dir = jobDirectory(stage, task.jobId);
        await mkdir(dir, { mode: 0o700 });
        await writeFile(path.join(dir, "input.json"),
          JSON.stringify(checked.request), { flag: "wx", mode: 0o600 });
        const report = {
          id: task.jobId, schemaVersion: 1, label: checked.request.label,
          digest: task.digest, state: "queued",
          acceptedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
          fileCount: checked.fileCount, bytes: checked.bytes,
          steps: checked.request.steps, results: [],
          summary: "In attesa del worker",
          ...(tenant ? { tenantId } : {}),
        };
        await atomicWrite(path.join(dir, "report.json"), report);
        await recordJobEvidence(stage, task.jobId, report, "accepted");
      }
      await refresh();
      capacity(currentTenant); // fence quota / credentials after writing stages
      const pending = path.join(root, ".pending-" + workflowId);
      // This directory is an explicit worker-stop marker. On failure after
      // this point, keep it and all staged/moved data for manual recovery.
      await mkdir(pending, { mode: 0o700 });
      guarded = true;
      await atomicWrite(path.join(pending, "intent.json"), {
        version: 1, id: workflowId, tenantId, jobIds: tasks.map(t => t.jobId),
        digest: hash(manifest),
      });
      for (const task of tasks) {
        const target = jobDirectory(dataDir, task.jobId);
        try { await lstat(target); throw issue("ADMISSION_INTEGRITY"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await rename(jobDirectory(stage, task.jobId), target);
      }
      await atomicWrite(path.join(root, workflowId + ".json"), {
        ...manifest, hash: hash(manifest),
      });
      const projected = await getWorkflow(dataDir, workflowId, tenantId, refresh);
      await rm(pending, { recursive: true });
      committed = true;
      return { created: true, ...projected };
    } finally {
      // If the first move may have happened, NEVER remove the guard or
      // orphaned job records. Host operator must inspect and recover.
      if (!guarded || committed)
        await rm(stage, { recursive: true, force: true });
    }
  }, waitMs);
}
