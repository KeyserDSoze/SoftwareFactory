/** Persistent DECLARATION ONLY for a multi-role PM handoff (#107).
 * Nothing here starts AI tasks, holds a task lease or attests test execution.
 * POSIX local volume + shared admission lock; do not assume NFS fencing.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./common.mjs";
import { parseIdempotencyKey, withAdmissionLock } from "./admission.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const TASK = /^[a-z][a-z0-9-]{1,31}$/;
const ACTOR = /^[a-z][a-z0-9_-]{1,31}$/;
const TENANT = /^[a-z][a-z0-9-]{2,31}$/;
const ROLES = new Set(["project_manager", "tester", "test_architect",
  "devops_engineer", "code_reviewer", "fullstack_developer",
  "fix_developer", "release_manager", "security_engineer"]);
const MAX_MANIFESTS = 64;
const MAX_RECORD_BYTES = 8192;
export const MAX_HANDOFF_BODY_BYTES = 6144;
const issue = code => Object.assign(new Error(code), { code });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (object, keys) => object && typeof object === "object" &&
  !Array.isArray(object) &&
  Object.keys(object).sort().join(",") === [...keys].sort().join(",");

function normalize(input) {
  if (!exact(input, ["consent","label","budgetUnits","tasks"]) ||
      input.consent !== true || typeof input.label !== "string" ||
      input.label.trim().length < 2 || input.label.trim().length > 120 ||
      /[\u0000-\u001f\u007f]/.test(input.label) ||
      !Number.isInteger(input.budgetUnits) ||
      input.budgetUnits < 1 || input.budgetUnits > 1000 ||
      !Array.isArray(input.tasks) || input.tasks.length < 2 ||
      input.tasks.length > 8) throw issue("HANDOFF_INVALID");
  const seen = new Set(), tasks = [];
  let reserved = 0;
  for (const task of input.tasks) {
    if (!exact(task, ["id","role","owner","dependsOn","estimatedUnits","maxAttempts"]) ||
        typeof task.id !== "string" || !TASK.test(task.id) ||
        seen.has(task.id) || !ROLES.has(task.role) ||
        typeof task.owner !== "string" || !ACTOR.test(task.owner) ||
        !Array.isArray(task.dependsOn) || task.dependsOn.length > 3 ||
        task.dependsOn.some(dep => typeof dep !== "string" || !seen.has(dep)) ||
        new Set(task.dependsOn).size !== task.dependsOn.length ||
        !Number.isInteger(task.estimatedUnits) ||
        task.estimatedUnits < 1 || task.estimatedUnits > 250 ||
        !Number.isInteger(task.maxAttempts) ||
        task.maxAttempts < 1 || task.maxAttempts > 3)
      throw issue("HANDOFF_INVALID");
    reserved += task.estimatedUnits;
    seen.add(task.id);
    tasks.push({ id: task.id, role: task.role, owner: task.owner,
      dependsOn: [...task.dependsOn], estimatedUnits: task.estimatedUnits,
      maxAttempts: task.maxAttempts });
  }
  if (reserved > input.budgetUnits) throw issue("HANDOFF_BUDGET");
  return { label: input.label.trim(), budgetUnits: input.budgetUnits, tasks };
}
const directory = dataDir => path.join(dataDir, "agent-handoffs");
function filePath(dataDir, id) {
  if (!UUID.test(id)) throw issue("HANDOFF_INVALID");
  return path.join(directory(dataDir), id + ".json");
}
async function trustedDirectory(dir) {
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.uid !== process.geteuid?.() ||
      (stat.mode & 0o077) !== 0) throw issue("HANDOFF_INTEGRITY");
}
async function ensureRoot(dataDir) {
  const root = directory(dataDir);
  await mkdir(root, { recursive:true, mode:0o700 });
  await trustedDirectory(root);
}
function validateRecord(data, id) {
  if (!exact(data, ["version","id","createdAt","tenantId","consent","label",
    "budgetUnits","tasks","idempotencyHash","requestHash","hash"]) ||
    data.version !== 1 || data.id !== id ||
    (data.tenantId !== null &&
      (typeof data.tenantId !== "string" || !TENANT.test(data.tenantId))) ||
    data.consent !== true || !SHA.test(data.idempotencyHash) ||
    !SHA.test(data.requestHash) || !SHA.test(data.hash) ||
    typeof data.createdAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.createdAt) ||
    !Number.isFinite(Date.parse(data.createdAt)) ||
    new Date(data.createdAt).toISOString() !== data.createdAt)
    throw issue("HANDOFF_INTEGRITY");
  let normalized;
  try { normalized = normalize({ consent:true,label:data.label,
    budgetUnits:data.budgetUnits,tasks:data.tasks }); }
  catch { throw issue("HANDOFF_INTEGRITY"); }
  if (normalized.label !== data.label ||
      hash(normalized) !== data.requestHash) throw issue("HANDOFF_INTEGRITY");
  const {hash:stored,...withoutHash} = data;
  if (hash(withoutHash) !== stored ||
      Buffer.byteLength(JSON.stringify(data)) > MAX_RECORD_BYTES)
    throw issue("HANDOFF_INTEGRITY");
  return data;
}
/** O_NOFOLLOW + one link + stable fd snapshots: never trust a JSON filename
 * whose inode/permissions could be swapped while reading.
 */
async function readManifest(dataDir,id) {
  if (typeof constants.O_NOFOLLOW !== "number") throw issue("HANDOFF_INTEGRITY");
  let fd;
  try {
    fd = await open(filePath(dataDir,id),constants.O_RDONLY|constants.O_NOFOLLOW);
    const before = await fd.stat();
    const safe = st => st.isFile() && st.uid === process.geteuid?.() &&
      st.nlink === 1 && (st.mode & 0o077) === 0 &&
      Number.isSafeInteger(st.size) && st.size > 1 &&
      st.size <= MAX_RECORD_BYTES;
    if (!safe(before)) throw issue("HANDOFF_INTEGRITY");
    const buf = Buffer.alloc(before.size);
    const {bytesRead} = await fd.read(buf,0,buf.length,0);
    const after = await fd.stat();
    if (bytesRead !== buf.length || !safe(after) ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.size !== after.size)
      throw issue("HANDOFF_INTEGRITY");
    return validateRecord(JSON.parse(buf.toString("utf8")),id);
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    throw issue("HANDOFF_INTEGRITY");
  } finally { await fd?.close().catch(()=>{}); }
}
async function listVerified(dataDir) {
  await ensureRoot(dataDir);
  const entries = await readdir(directory(dataDir),{withFileTypes:true});
  if (entries.length > MAX_MANIFESTS ||
      entries.some(entry => !entry.isFile() ||
        !/^[a-f0-9-]{36}\.json$/.test(entry.name) ||
        !UUID.test(entry.name.slice(0,-5))))
    throw issue("HANDOFF_INTEGRITY");
  const records = [];
  for (const entry of entries)
    records.push(await readManifest(dataDir,entry.name.slice(0,-5)));
  return records;
}
function project(record) {
  // No "passed", "executed", or "leased" status without real evidence.
  return {
    version:1, id:record.id, createdAt:record.createdAt,
    label:record.label, budgetUnits:record.budgetUnits,
    reservedUnits:record.tasks.reduce((n,t)=>n+t.estimatedUnits,0),
    status:"declared", executions:0,
    tasks:record.tasks.map(task => ({
      ...task, state:task.dependsOn.length ? "blocked" : "ready",
      evidence:"not_started",
    })),
  };
}
export async function registerAgentHandoff({
  dataDir,input,idempotencyKey,tenantId=null,reauthorize,waitMs=1500,
}) {
  const normalized = normalize(input);
  const key = parseIdempotencyKey(idempotencyKey);
  if (!key) throw issue("INVALID_IDEMPOTENCY_KEY");
  if (tenantId !== null && !TENANT.test(tenantId)) throw issue("HANDOFF_INVALID");
  const fingerprint = hash({ scope:"agent-handoff-v1",key });
  const requestHash = hash(normalized);
  return withAdmissionLock(dataDir,async()=>{
    await reauthorize?.();
    const records = await listVerified(dataDir);
    const matches = records.filter(r => r.tenantId === tenantId &&
      r.idempotencyHash === fingerprint);
    if (matches.length > 1) throw issue("HANDOFF_INTEGRITY");
    if (matches.length === 1) {
      if (matches[0].requestHash !== requestHash) throw issue("HANDOFF_CONFLICT");
      await reauthorize?.();
      return {created:false,...project(matches[0])};
    }
    if (records.length >= MAX_MANIFESTS) throw issue("HANDOFF_CAPACITY");
    await reauthorize?.(); // freshly loaded tenant key under the shared lock
    const id = randomUUID();
    const payload = {
      version:1,id,createdAt:new Date().toISOString(),
      tenantId,consent:true,...normalized,idempotencyHash:fingerprint,
      requestHash,
    };
    const record = {...payload,hash:hash(payload)};
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES)
      throw issue("HANDOFF_INVALID");
    await atomicWrite(filePath(dataDir,id),record);
    const checked = await readManifest(dataDir,id);
    return {created:true,...project(checked)};
  },waitMs);
}
export async function getAgentHandoff(dataDir,id,tenantId=null,reauthorize) {
  if (!UUID.test(id)) throw issue("HANDOFF_NOT_FOUND");
  try {
    await reauthorize?.();
    await trustedDirectory(directory(dataDir));
    const record = await readManifest(dataDir,id);
    if (record.tenantId !== tenantId) throw issue("HANDOFF_NOT_FOUND");
    await reauthorize?.();
    return project(record);
  } catch(error) {
    if (error.code === "ENOENT" || error.code === "HANDOFF_NOT_FOUND")
      throw issue("HANDOFF_NOT_FOUND");
    throw error;
  }
}
