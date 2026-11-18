/** Explicitly registered multi-job PM dependency manifest (#100).
 * The runner continues to schedule jobs independently. This module NEVER
 * starts jobs or invokes AI: dependencies are checked against retained
 * inode-bound job evidence and violations are reported, not hidden.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./common.mjs";
import { withAdmissionLock, parseIdempotencyKey } from "./admission.mjs";
import { verifyJobEvidenceForRead } from "./evidence.mjs";
import { projectVerifiedJobPlan } from "./pm-job-plan.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const TASK_ID = /^[a-z][a-z0-9-]{1,31}$/;
const TENANT = /^[a-z][a-z0-9-]{2,31}$/;
const ROLES = new Set(["project_manager", "tester", "test_architect",
  "devops_engineer", "code_reviewer", "fullstack_developer", "fix_developer",
  "release_manager", "security_engineer"]);
const CAPACITY = 64;
const MAX_BYTES = 8192;
const fault = code => Object.assign(new Error(code), { code });
const sha = data => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const exact = (obj, keys) => obj && typeof obj === "object" &&
  !Array.isArray(obj) && Object.keys(obj).sort().join(",") === [...keys].sort().join(",");

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 6)
    throw fault("WORKFLOW_INVALID");
  const seen = new Set(), jobs = new Set();
  for (const task of tasks) {
    if (!exact(task, ["id", "role", "jobId", "digest", "dependsOn"]) ||
        typeof task.id !== "string" || !TASK_ID.test(task.id) ||
        seen.has(task.id) || !ROLES.has(task.role) || !UUID.test(task.jobId) ||
        !SHA.test(task.digest) || jobs.has(task.jobId) ||
        !Array.isArray(task.dependsOn) || task.dependsOn.length > 3 ||
        task.dependsOn.some(dep => typeof dep !== "string" || !seen.has(dep)) ||
        new Set(task.dependsOn).size !== task.dependsOn.length)
      throw fault("WORKFLOW_INVALID");
    seen.add(task.id);
    jobs.add(task.jobId);
  }
}
function normalizedInput(input) {
  // v1 manifests remain observational. Explicit opt-in uses immutable v2.
  const guarded = exact(input, ["consent", "label", "tasks", "enforced"]) &&
    input.enforced === true;
  if (!(exact(input, ["consent", "label", "tasks"]) || guarded) ||
      input.consent !== true || typeof input.label !== "string" ||
      input.label.trim().length < 2 || input.label.trim().length > 120)
    throw fault("WORKFLOW_INVALID");
  validateTasks(input.tasks);
  return { label: input.label.trim(), tasks: input.tasks.map(t => ({
    id: t.id, role: t.role, jobId: t.jobId, digest: t.digest,
    dependsOn: [...t.dependsOn],
  })), ...(guarded ? { enforced: true } : {}) };
}
function rootDir(dataDir) { return path.join(dataDir, "workflows"); }
function manifestPath(dataDir, id) {
  if (!UUID.test(id)) throw fault("WORKFLOW_INVALID");
  return path.join(rootDir(dataDir), id + ".json");
}
function verifyRecord(record, id) {
  const guarded = record?.version === 2 && record.enforced === true;
  const expected = ["version", "id", "createdAt", "tenantId",
    "label", "tasks", "idempotencyHash", "hash"];
  if (!(guarded ? exact(record, [...expected, "enforced"]) :
    exact(record, expected) && record.version === 1) ||
      record.id !== id || !UUID.test(id) ||
      (record.tenantId !== null && (typeof record.tenantId !== "string" ||
        !TENANT.test(record.tenantId))) ||
      !SHA.test(record.idempotencyHash) || !SHA.test(record.hash) ||
      typeof record.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(record.createdAt) ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      new Date(record.createdAt).toISOString() !== record.createdAt)
    throw fault("WORKFLOW_INTEGRITY");
  try { normalizedInput({ consent: true, label: record.label, tasks: record.tasks,
    ...(guarded ? { enforced: true } : {}) }); }
  catch { throw fault("WORKFLOW_INTEGRITY"); }
  const { hash, ...payload } = record;
  if (sha(payload) !== hash || Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES)
    throw fault("WORKFLOW_INTEGRITY");
  return record;
}
/** Validate the opened file descriptor, both before and after the read.
 * Never follow symlinks or accept hardlinks, swapped inodes, or writable files.
 */
async function readManifest(dataDir, id) {
  if (typeof constants.O_NOFOLLOW !== "number") throw fault("WORKFLOW_INTEGRITY");
  let fd;
  try {
    fd = await open(manifestPath(dataDir, id), constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await fd.stat();
    const safe = st => st.isFile() && st.uid === process.geteuid?.() &&
      st.nlink === 1 && (st.mode & 0o077) === 0 &&
      Number.isSafeInteger(st.size) && st.size > 0 && st.size <= MAX_BYTES;
    if (!safe(before)) throw fault("WORKFLOW_INTEGRITY");
    const parts = []; let size = 0;
    while (size <= MAX_BYTES) {
      const buf = Buffer.alloc(Math.min(2048, MAX_BYTES + 1 - size));
      const { bytesRead } = await fd.read(buf, 0, buf.length, size);
      if (!bytesRead) break;
      parts.push(buf.subarray(0, bytesRead)); size += bytesRead;
    }
    const after = await fd.stat();
    if (!safe(after) || size !== before.size ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.ctimeMs !== after.ctimeMs ||
        before.mtimeMs !== after.mtimeMs)
      throw fault("WORKFLOW_INTEGRITY");
    return verifyRecord(JSON.parse(Buffer.concat(parts, size).toString("utf8")), id);
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw fault("WORKFLOW_INTEGRITY");
  } finally { await fd?.close().catch(() => {}); }
}

function ownsJob(report, tenantId) {
  return (report.tenantId ?? null) === tenantId &&
    (tenantId !== null || report.tenantId === undefined);
}
async function verifiedTaskPlans(dataDir, manifest, tenantId) {
  const plans = [];
  for (const task of manifest.tasks) {
    let verified;
    try { verified = await verifyJobEvidenceForRead(dataDir, task.jobId); }
    catch { throw fault("WORKFLOW_EVIDENCE"); }
    if (!ownsJob(verified.report, tenantId))
      throw fault("WORKFLOW_NOT_FOUND");
    if (verified.report.id !== task.jobId ||
        verified.report.digest !== task.digest)
      throw fault("WORKFLOW_EVIDENCE");
    try {
      const plan = projectVerifiedJobPlan(verified);
      const dates = [verified.report.startedAt, verified.report.finishedAt];
      const validDate = date => date === null || (typeof date === "string" &&
        Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date);
      const terminal = ["passed", "failed", "incomplete"].includes(verified.report.state);
      const terminalEvent = verified.entries.some(e =>
        ["finished", "rejected", "recovered"].includes(e.kind));
      // A job rejected while still queued never has a worker start. A job
      // recovered after a crash is terminal "incomplete", not passed/failed.
      const unstartedRejection = verified.report.state === "incomplete" &&
        verified.entries.some(e => e.kind === "rejected") && dates[0] === null;
      if (!dates.every(validDate) ||
          (verified.report.state === "queued" && (dates[0] !== null || dates[1] !== null)) ||
          (verified.report.state !== "queued" && dates[0] === null && !unstartedRejection) ||
          (terminal && (dates[1] === null || !terminalEvent)) ||
          (!terminal && dates[1] !== null) ||
          (verified.report.state === "passed" &&
            !verified.entries.some(e => e.kind === "finished")))
        throw fault("WORKFLOW_EVIDENCE");
      plans.push({ ...plan, startedAt: dates[0], finishedAt: dates[1] });
    } catch { throw fault("WORKFLOW_EVIDENCE"); }
  }
  return plans;
}
function projectManifest(manifest, plans) {
  const statuses = new Map();
  const tasks = manifest.tasks.map((task, i) => {
    const plan = plans[i];
    const resultState = plan.state;
    const dependenciesPassed = task.dependsOn.every(d => statuses.get(d) === "passed");
    // A rejected queued job is terminal but never started code execution.
    // Do not report an order violation on a job that never entered the worker.
    const started = plan.startedAt !== null;
    // Even if all predecessors eventually pass, a downstream job STARTED
    // before their finish timestamps violates the declared ordering.
    // Millisecond ties are not sufficient proof of dependency completion.
    const startedBeforeDependency = started && task.dependsOn.some(depId => {
      const depIndex = manifest.tasks.findIndex(t => t.id === depId);
      const finishedAt = plans[depIndex].finishedAt;
      return !finishedAt || !plan.startedAt ||
        Date.parse(plan.startedAt) <= Date.parse(finishedAt);
    });
    const status = startedBeforeDependency ? "out_of_order" :
      dependenciesPassed ? resultState : started ? "out_of_order" :
      resultState === "incomplete" ? "incomplete" : "blocked";
    statuses.set(task.id, status);
    return {
      id: task.id, role: task.role, jobId: task.jobId,
      dependsOn: [...task.dependsOn], status,
      evidence: { count: plan.evidence.count, head: plan.evidence.head },
    };
  });
  const status = tasks.every(t => t.status === "passed") ? "passed" :
    tasks.some(t => t.status === "out_of_order") ? "out_of_order" :
    tasks.some(t => t.status === "failed") ? "failed" :
    tasks.some(t => t.status === "incomplete") ? "incomplete" :
    "active";
  return { version: manifest.version, id: manifest.id, label: manifest.label,
    createdAt: manifest.createdAt, ...(manifest.enforced ? { enforced: true } : {}),
    status, tasks };
}

/** POST registration: require UUID idempotency, explicit consent, and all
 * jobs already admitted on the SAME tenant. The admission lock serializes
 * concurrent APIs and prevents a conflicting duplicate manifest.
 */
export async function registerWorkflow({ dataDir, input, tenantId = null,
  idempotencyKey, reauthorize }) {
  const payload = normalizedInput(input);
  if (tenantId !== null && !TENANT.test(tenantId)) throw fault("WORKFLOW_INVALID");
  const fingerprint = parseIdempotencyKey(idempotencyKey);
  if (!fingerprint) throw fault("WORKFLOW_INVALID");
  const signature = sha(payload);
  return withAdmissionLock(dataDir, async () => {
    if (reauthorize) await reauthorize();
    await mkdir(rootDir(dataDir), { recursive: true, mode: 0o700 });
    const files = await readdir(rootDir(dataDir), { withFileTypes: true });
    if (files.length > CAPACITY) throw fault("WORKFLOW_CAPACITY");
    let replay = null;
    const records = [];
    for (const file of files) {
      if (!file.isFile() || !/^[a-f0-9-]{36}\.json$/.test(file.name))
        throw fault("WORKFLOW_INTEGRITY");
      const record = await readManifest(dataDir, file.name.slice(0, -5));
      records.push(record);
      if (record.tenantId === tenantId && record.idempotencyHash === fingerprint) {
        if (replay) throw fault("WORKFLOW_INTEGRITY");
        replay = record;
      }
    }
    if (replay && sha({ label: replay.label, tasks: replay.tasks,
      ...(replay.enforced ? { enforced: true } : {}) }) !== signature)
      throw fault("WORKFLOW_CONFLICT");
    const manifest = replay ?? { version: payload.enforced ? 2 : 1, id: randomUUID(),
      createdAt: new Date().toISOString(), tenantId,
      ...payload, idempotencyHash: fingerprint };
    // Verify the ownership of EVERY job before exposing any workflow conflict
    // detail. Otherwise a mixed-tenant manifest can turn a foreign job into
    // a 409 oracle by colliding with an existing guarded workflow.
    const plans = await verifiedTaskPlans(dataDir, manifest, tenantId);
    if (!replay && payload.enforced) {
      // Prevent two enforced DAGs from claiming the same job. Read EVERY
      // retained sibling before accepting a new immutable policy.
      if (records.some(record => record.enforced &&
        record.tasks.some(task => payload.tasks.some(t => t.jobId === task.jobId))))
        throw fault("WORKFLOW_CONFLICT");
      for (const [i, task] of manifest.tasks.entries()) {
        if (plans[i].state !== "queued") throw fault("WORKFLOW_NOT_QUEUED");
        // Claim and manifest registration share the admission lock. A worker
        // already holding a claim cannot become silently enrolled.
        try {
          await lstat(path.join(dataDir, "jobs", task.jobId, ".claim"));
          throw fault("WORKFLOW_NOT_QUEUED");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    if (reauthorize) await reauthorize();
    if (!replay) {
      if (files.length >= CAPACITY) throw fault("WORKFLOW_CAPACITY");
      const record = { ...manifest, hash: sha(manifest) };
      await atomicWrite(manifestPath(dataDir, record.id), record);
    }
    return { created: !replay, ...projectManifest(manifest, plans) };
  });
}
export async function getWorkflow(dataDir, id, tenantId = null, reauthorize) {
  const record = await readManifest(dataDir, id);
  if (record.tenantId !== tenantId) throw fault("WORKFLOW_NOT_FOUND");
  const plans = await verifiedTaskPlans(dataDir, record, tenantId);
  if (reauthorize) await reauthorize();
  return projectManifest(record, plans);
}


/** Read all manifests before choosing a worker turn. Fail closed if ANY
 * manifest is unsafe, including a partially written or corrupt sibling.
 * This map is a performance hint; executeJob checks again under the lock.
 */
export async function loadGuardedIndex(dataDir) {
  const index = new Map(), dir = rootDir(dataDir);
  let files;
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== process.geteuid?.() ||
        (info.mode & 0o077) !== 0) throw fault("WORKFLOW_INTEGRITY");
    files = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return index;
    throw fault("WORKFLOW_INTEGRITY");
  }
  if (files.length > CAPACITY) throw fault("WORKFLOW_INTEGRITY");
  for (const file of files) {
    if (!file.isFile() || !/^[a-f0-9-]{36}\.json$/.test(file.name))
      throw fault("WORKFLOW_INTEGRITY");
    const record = await readManifest(dataDir, file.name.slice(0, -5));
    if (record.enforced) {
      for (const [position, task] of record.tasks.entries()) {
        if (index.has(task.jobId)) throw fault("WORKFLOW_INTEGRITY");
        index.set(task.jobId, { record, position });
      }
    }
  }
  return index;
}

/** True only if this queued job has no guarded policy, or its verified
 * predecessors have passed, without any out-of-order execution.
 * A successful receipt or terminal flag alone NEVER unlocks the worker.
 */
export async function mayStartGuardedJob(dataDir, jobId, index = undefined) {
  const guarded = index ?? await loadGuardedIndex(dataDir);
  const item = guarded.get(jobId);
  if (!item) return true; // Older, observational v1 jobs unchanged.
  const { record, position } = item;
  const plans = await verifiedTaskPlans(dataDir, record, record.tenantId);
  const board = projectManifest(record, plans);
  if (board.tasks[position]?.status !== "queued") return false;
  const task = record.tasks[position];
  for (const dependency of task.dependsOn) {
    const index = record.tasks.findIndex(t => t.id === dependency);
    const finishedAt = plans[index].finishedAt;
    // Same-millisecond starts are ambiguous and must not look ordered.
    if (!finishedAt || Date.now() <= Date.parse(finishedAt)) return false;
  }
  return true;
}

/** Trusted local maintenance helper: still validates manifest inode and hash. */
export { readManifest as readVerifiedWorkflowManifest };
