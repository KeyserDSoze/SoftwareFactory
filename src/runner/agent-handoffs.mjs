/** Persistent declarations, fenced actor leases, and human-supervised PM
 * artifact-digest checkpoints. No AI/test execution, no provider billing,
 * no unsigned receipt interpreted as a passing technical test.
 * POSIX local volume + shared admission lock; not NFS/multi-host fencing.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./common.mjs";
import { parseIdempotencyKey, withAdmissionLock } from "./admission.mjs";
import { verifyJobEvidenceForRead } from "./evidence.mjs";
import { projectVerifiedJobPlan } from "./pm-job-plan.mjs";
import { readRunnerInput } from "./input.mjs";
import { validateRequest } from "./common.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const TASK = /^[a-z][a-z0-9-]{1,31}$/;
const ACTOR = /^[a-z][a-z0-9_-]{1,31}$/;
const TENANT = /^[a-z][a-z0-9-]{2,31}$/;
const ROLES = new Set(["project_manager", "tester", "test_architect",
  "devops_engineer", "code_reviewer", "fullstack_developer",
  "fix_developer", "release_manager", "security_engineer"]);
const MAX_MANIFESTS = 64;
const MAX_RECORD_BYTES = 64_000;
const MAX_LEASE_EVENTS = 64;
const GENESIS = "0".repeat(64);
const TEST_STEPS = new Set(["dotnet-test","web-test","playwright"]);
// Per-read only: never persist raw source data or snapshot descriptors in a handoff.
const SOURCE_SNAPSHOTS = Symbol("runner-source-snapshots");
// Even a human-supplied label must not become a secret-bearing manifest.
const CREDENTIAL_MARKER = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[a-zA-Z0-9_]{15,}|gh[pousr]_[a-zA-Z0-9]{20,}|Bearer\s+\S+|(?:api[_-]?key|password|secret|token)\s*[=:]\s*\S+/i;
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
      CREDENTIAL_MARKER.test(input.label) ||
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
  const base = ["version","id","createdAt","tenantId","consent","label",
    "budgetUnits","tasks","idempotencyHash","requestHash","hash"];
  const withEvents = Object.hasOwn(data ?? {}, "events") ||
    Object.hasOwn(data ?? {}, "head");
  if (!(withEvents ? exact(data, [...base,"events","head"]) : exact(data,base)) ||
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
  verifyLeaseHistory(data); // Check full event chain on EVERY read and replay.
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
    let offset=0;
    while (offset<buf.length) {
      const {bytesRead} = await fd.read(buf,offset,buf.length-offset,offset);
      if (!bytesRead) throw issue("HANDOFF_INTEGRITY");
      offset+=bytesRead;
    }
    const after = await fd.stat();
    if (!safe(after) ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.size !== after.size)
      throw issue("HANDOFF_INTEGRITY");
    const record=validateRecord(JSON.parse(buf.toString("utf8")),id);
    const snapshots=await verifyTechnicalProofs(dataDir,record);
    Object.defineProperty(record,SOURCE_SNAPSHOTS,{value:snapshots});
    return record;
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
// A digest of upstream evidence metadata, not of source code or AI review.
// Every manifest read rechecks the original runner journal for Tester proofs.
function reviewDependencyContext(record,leases,task) {
  if (task.role!=="code_reviewer") return null;
  const dependencies=task.dependsOn.map(taskId=>{
    const state=leases.get(taskId);
    if (state?.testVerified) return {
      taskId,evidence:"verified_runner_journal",
      jobId:state.testVerified.jobId,digest:state.testVerified.jobDigest,
      head:state.testVerified.jobHead,count:state.testVerified.jobCount,
      step:state.testVerified.step,
    };
    if (state?.approved) return {
      taskId,evidence:"human_approved_digest",
      digest:state.submission.digest,approvedBy:state.approvedBy,
    };
    return {taskId,evidence:"not_started"};
  });
  // No dependencies means there is no verifiable context to bind.
  const recorded=dependencies.length>0 &&
    dependencies.every(dep=>dep.evidence!=="not_started");
  return {
    status:recorded?"inputs_recorded":"awaiting_inputs",
    fingerprint:recorded?hash({
      scope:"agent-review-context-v1",handoffId:record.id,
      taskId:task.id,dependencies,
    }):null,
    dependencies,
  };
}
/** A review source descriptor comes ONLY from checked local runner inputs for
 * direct upstream Tester tasks, never from an agent-supplied digest. This is
 * evidence of a test's input files, NOT evidence of a review being performed.
 */
function reviewSourceSnapshot(record,leases,task,context) {
  if (task.role!=="code_reviewer") return null;
  const testDeps=task.dependsOn.filter(id=>leases.get(id)?.testVerified);
  if (context?.status!=="inputs_recorded")
    return {status:"awaiting_inputs",digest:null,fingerprint:null};
  if (testDeps.length===0)
    return {status:"no_tested_source",digest:null,fingerprint:null};
  const digests=testDeps.map(id=>record[SOURCE_SNAPSHOTS]?.get(id));
  if (digests.some(digest=>!SHA.test(digest)))
    throw issue("HANDOFF_TEST_EVIDENCE");
  if (new Set(digests).size!==1)
    return {status:"conflicting_tested_sources",digest:null,fingerprint:null};
  const digest=digests[0];
  return {
    status:"runner_input_recorded",digest,
    fingerprint:hash({scope:"agent-review-source-v1",handoffId:record.id,
      taskId:task.id,reviewContext:context.fingerprint,digest}),
  };
}
function project(record) {
  // A lease is a capability, not evidence that an AI process executed or
  // completed anything. A dependent task stays blocked without a verified
  // completion protocol.
  const leases=verifyLeaseHistory(record);
  const now=Date.now();
  return {
    version:1, id:record.id, createdAt:record.createdAt,
    label:record.label, budgetUnits:record.budgetUnits,
    reservedUnits:record.tasks.reduce((n,t)=>n+t.estimatedUnits,0),
    // These are human-approved self-reported units, NOT verified provider billing.
    approvedReportedUnits:record.tasks.reduce((n,t)=>n+
      (leases.get(t.id)?.approved ? leases.get(t.id).submission.reportedUnits : 0),0),
    verifiedTestJobs:record.tasks.filter(t=>leases.get(t.id)?.testVerified).length,
    status:"declared", executions:0,
    tasks:record.tasks.map(task => {
      const lease=leases.get(task.id);
      const active=lease?.active && Date.parse(lease.expiresAt)>now;
      const dependenciesApproved=task.dependsOn.every(id=>
        leases.get(id)?.approved || leases.get(id)?.testVerified);
      const reviewContext=reviewDependencyContext(record,leases,task);
      const reviewSource=reviewSourceSnapshot(record,leases,task,reviewContext);
      const sourceConflict=reviewSource?.status==="conflicting_tested_sources";
      const pending=lease?.submission && !lease.approved && active;
      return {
        ...task, state:lease?.testVerified ? "runner_verified_test" :
          lease?.approved ? "human_approved_checkpoint" :
          (!dependenciesApproved || sourceConflict) ? "blocked" :
          active ? (pending ? "awaiting_human_approval" : "leased") :
          (lease?.attempts ?? 0) >= task.maxAttempts ? "attempts_exhausted" : "ready",
        attempts:lease?.attempts ?? 0,
        fencingVersion:lease?.generation ?? 0,
        leasedUntil:active ? lease.expiresAt : null,
        submissionId:pending ? lease.submission.id : null,
        artifactDigest:lease?.approved || pending ? lease.submission.digest : null,
        reportedUnits:lease?.approved ? lease.submission.reportedUnits : null,
        approvedBy:lease?.approved ? lease.approvedBy : null,
        testEvidence:lease?.testVerified ? {
          jobId:lease.testVerified.jobId,digest:lease.testVerified.jobDigest,
          head:lease.testVerified.jobHead,count:lease.testVerified.jobCount,
          step:lease.testVerified.step,
        } : null,
        reviewContext,reviewSource,
        evidence:lease?.testVerified ? "verified_runner_journal" :
          lease?.approved ? "human_approved_digest" : "not_started",
      };
    }),
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


/** Validate monotonic fencing and the full SHA-256 event chain using only
 * persisted values. SHA-256 detects accidental/casual tamper; an owner of
 * the host can forge a new chain. This is NOT a signed audit attestation.
 */
function verifyLeaseHistory(record) {
  const map=new Map(record.tasks.map(task=>[task.id,{
    attempts:0,generation:0,active:false,leaseId:null,expiresAt:null,
    actorId:null,at:null,claimAt:null,submission:null,
    approved:false,approvedBy:null,testVerified:null,
  }]));
  if (!Object.hasOwn(record,"events")) return map;
  if (!Array.isArray(record.events) || record.events.length < 1 ||
      record.events.length > MAX_LEASE_EVENTS || !SHA.test(record.head))
    throw issue("HANDOFF_INTEGRITY");
  let head=GENESIS,previousTime=0;
  for (const [i,event] of record.events.entries()) {
    const isCheckpoint=event?.kind==="submit" || event?.kind==="approve";
    const isTechnical=event?.kind==="test_verified";
    const allowedFields=["sequence","previousHash","kind","at","taskId",
      "actorId","generation","leaseId","expiresAt","hash",
      ...(isCheckpoint?["submissionId","artifactDigest","reportedUnits"]:[]),
      ...(isTechnical?["submissionId","jobId","jobDigest","jobHead",
        "jobCount","step"]:[])];
    if (!exact(event,allowedFields) ||
        event.sequence!==i+1 || event.previousHash!==head ||
        !["claim","renew","release","submit","approve","test_verified"].includes(event.kind) ||
        typeof event.at!=="string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at) ||
        !Number.isFinite(Date.parse(event.at)) ||
        new Date(event.at).toISOString()!==event.at ||
        Date.parse(event.at)<previousTime ||
        !UUID.test(event.leaseId) || !SHA.test(event.hash) ||
        !Number.isInteger(event.generation) || event.generation<1 ||
        typeof event.expiresAt!=="string" ||
        !Number.isFinite(Date.parse(event.expiresAt)) ||
        new Date(event.expiresAt).toISOString()!==event.expiresAt ||
        isCheckpoint && (!UUID.test(event.submissionId) ||
          !SHA.test(event.artifactDigest) ||
          !Number.isInteger(event.reportedUnits) || event.reportedUnits<1) ||
        isTechnical && (!UUID.test(event.submissionId) ||
          !UUID.test(event.jobId) || !SHA.test(event.jobDigest) ||
          !SHA.test(event.jobHead) || !Number.isInteger(event.jobCount) ||
          event.jobCount<1 || event.jobCount>48 ||
          !TEST_STEPS.has(event.step)))
      throw issue("HANDOFF_INTEGRITY");
    const task=record.tasks.find(task=>task.id===event.taskId);
    const state=map.get(event.taskId);
    if (!task || !state ||
        (event.kind==="approve"
          ? (!ACTOR.test(event.actorId) || event.actorId===task.owner)
          : task.owner!==event.actorId) ||
        hash(Object.fromEntries(Object.entries(event).filter(([k])=>k!=="hash")))!==event.hash)
      throw issue("HANDOFF_INTEGRITY");
    const at=Date.parse(event.at),expiration=Date.parse(event.expiresAt);
    if (event.kind==="claim") {
      if (state.approved || state.testVerified ||
          state.active && at<Date.parse(state.expiresAt) ||
          event.generation!==state.generation+1 ||
          state.at!==null && at<Date.parse(state.at) ||
          state.attempts>=task.maxAttempts ||
          expiration<=at || expiration>at+300000 ||
          task.dependsOn.some(dep=>!map.get(dep)?.approved &&
            !map.get(dep)?.testVerified))
        throw issue("HANDOFF_INTEGRITY");
      state.generation=event.generation;
      state.attempts++;
      state.leaseId=event.leaseId;
      state.expiresAt=event.expiresAt;
      state.actorId=event.actorId;
      state.active=true;
      state.claimAt=event.at;
      state.submission=null;
    } else if (event.kind==="renew") {
      if (!state.active || state.approved || state.testVerified ||
          state.generation!==event.generation ||
          state.leaseId!==event.leaseId ||
          state.actorId!==event.actorId ||
          at>=Date.parse(state.expiresAt) ||
          expiration<=Date.parse(state.expiresAt) ||
          expiration>at+300000)
        throw issue("HANDOFF_INTEGRITY");
      state.expiresAt=event.expiresAt;
    } else if (event.kind==="release") {
      if (!state.active || state.approved || state.testVerified ||
          state.generation!==event.generation ||
          state.leaseId!==event.leaseId ||
          state.actorId!==event.actorId ||
          at>=Date.parse(state.expiresAt) || expiration!==at)
        throw issue("HANDOFF_INTEGRITY");
      state.expiresAt=event.expiresAt;
      state.active=false;
      state.submission=null;
    } else if (event.kind==="test_verified") {
      if (task.role!=="tester" || !state.active || state.approved ||
          state.testVerified || state.submission ||
          state.generation!==event.generation ||
          state.leaseId!==event.leaseId || state.actorId!==event.actorId ||
          at>=Date.parse(state.expiresAt) ||
          expiration!==Date.parse(state.expiresAt) ||
          !state.claimAt || at<=Date.parse(state.claimAt))
        throw issue("HANDOFF_INTEGRITY");
      state.testVerified={
        id:event.submissionId,jobId:event.jobId,
        jobDigest:event.jobDigest,jobHead:event.jobHead,
        jobCount:event.jobCount,step:event.step,at:event.at,
      };
      state.active=false;
    } else if (event.kind==="submit") {
      if (task.role!=="project_manager" || !state.active || state.approved ||
          state.submission || state.generation!==event.generation ||
          state.leaseId!==event.leaseId || state.actorId!==event.actorId ||
          at>=Date.parse(state.expiresAt) || expiration!==Date.parse(state.expiresAt) ||
          event.reportedUnits>task.estimatedUnits)
        throw issue("HANDOFF_INTEGRITY");
      state.submission={id:event.submissionId,digest:event.artifactDigest,
        reportedUnits:event.reportedUnits};
    } else {
      if (task.role!=="project_manager" || !state.active ||
          state.approved || !state.submission ||
          state.generation!==event.generation ||
          state.leaseId!==event.leaseId ||
          at>=Date.parse(state.expiresAt) ||
          expiration!==Date.parse(state.expiresAt) ||
          state.submission.id!==event.submissionId ||
          state.submission.digest!==event.artifactDigest ||
          state.submission.reportedUnits!==event.reportedUnits)
        throw issue("HANDOFF_INTEGRITY");
      state.active=false;
      state.approved=true;
      state.approvedBy=event.actorId;
    }
    state.at=event.at;
    previousTime=at;
    head=event.hash;
  }
  if (record.head!==head) throw issue("HANDOFF_INTEGRITY");
  return map;
}
const leaseRequest = value => {
  const base=["action","handoffId","taskId"];
  const claim=exact(value,[...base,"ttlSeconds"]);
  const renewed=exact(value,[...base,"ttlSeconds","leaseId"]);
  const released=exact(value,[...base,"leaseId"]);
  if (!(claim||renewed||released) ||
      typeof value.handoffId!=="string" || !UUID.test(value.handoffId) ||
      typeof value.taskId!=="string" || !TASK.test(value.taskId) ||
      !(value.action==="claim" && claim ||
        value.action==="renew" && renewed ||
        value.action==="release" && released) ||
      value.action!=="release" &&
        (!Number.isInteger(value.ttlSeconds) || value.ttlSeconds<30 ||
          value.ttlSeconds>300) ||
      value.action!=="claim" &&
        (typeof value.leaseId!=="string" || !UUID.test(value.leaseId)))
    throw issue("HANDOFF_LEASE_INVALID");
  return value;
};
/** Mutation is fully serialized across runner API replicas. Only an
 * authenticated, role+tenant scoped actor may claim its explicitly
 * declared task. A lease has NO ability to submit code, run LLMs, or
 * assert pass/fail. Dependency tasks remain unclaimable until an actual
 * completion-evidence protocol exists.
 */
export async function mutateAgentTaskLease({
  dataDir,request,actor,reauthorize,waitMs=1500,
  nowMs=Date.now, // internal deterministic test seam; never from HTTP input
}) {
  const input=leaseRequest(request);
  if (!actor || !ACTOR.test(actor.id) || !ROLES.has(actor.role) ||
      !(actor.tenantId===null || TENANT.test(actor.tenantId)))
    throw issue("ACTOR_AUTH_REVOKED");
  return withAdmissionLock(dataDir,async()=>{
    await reauthorize?.();
    await trustedDirectory(directory(dataDir));
    let record;
    try { record=await readManifest(dataDir,input.handoffId); }
    catch(error) {
      if (error.code==="ENOENT") throw issue("HANDOFF_NOT_FOUND");
      throw error;
    }
    // Keep non-owners and other tenants indistinguishable from missing tasks.
    const task=record.tasks.find(t=>t.id===input.taskId);
    if (record.tenantId!==actor.tenantId || !task ||
        task.owner!==actor.id || task.role!==actor.role)
      throw issue("HANDOFF_NOT_FOUND");
    const states=verifyLeaseHistory(record);
    const state=states.get(task.id);
    const now=nowMs(),at=new Date(now).toISOString();
    if (record.events?.length>=MAX_LEASE_EVENTS) throw issue("HANDOFF_LEASE_CAPACITY");
    const active=state.active && Date.parse(state.expiresAt)>now;
    let generation,leaseId,expiresAt;
    if (state.approved || state.testVerified)
      throw issue("HANDOFF_LEASE_COMPLETED");
    if (input.action==="claim") {
      if (task.dependsOn.some(dep=>
        !states.get(dep)?.approved && !states.get(dep)?.testVerified) ||
          reviewSourceSnapshot(record,states,task,
            reviewDependencyContext(record,states,task))?.status===
              "conflicting_tested_sources")
        throw issue("HANDOFF_LEASE_BLOCKED");
      if (active) throw issue("HANDOFF_LEASE_CONFLICT");
      if (state.attempts>=task.maxAttempts) throw issue("HANDOFF_LEASE_EXHAUSTED");
      generation=state.generation+1;
      leaseId=randomUUID();
      expiresAt=new Date(now+input.ttlSeconds*1000).toISOString();
    } else {
      if (!active || input.leaseId!==state.leaseId)
        throw issue("HANDOFF_LEASE_STALE");
      generation=state.generation;
      leaseId=state.leaseId;
      expiresAt=input.action==="renew"
        ? new Date(now+input.ttlSeconds*1000).toISOString() : at;
      if (input.action==="renew" && Date.parse(expiresAt)<=Date.parse(state.expiresAt))
        throw issue("HANDOFF_LEASE_INVALID");
    }
    if (state.at && now<Date.parse(state.at)) throw issue("HANDOFF_INTEGRITY");
    const payload={
      sequence:(record.events?.length??0)+1,
      previousHash:record.head??GENESIS,
      kind:input.action,at,taskId:task.id,actorId:actor.id,
      generation,leaseId,expiresAt,
    };
    const event={...payload,hash:hash(payload)};
    const withoutHash={
      ...record,
      events:[...(record.events??[]),event],
      head:event.hash,
    };
    delete withoutHash.hash;
    const next={...withoutHash,hash:hash(withoutHash)};
    if (Buffer.byteLength(JSON.stringify(next))>MAX_RECORD_BYTES)
      throw issue("HANDOFF_LEASE_CAPACITY");
    // Credential rotation/revocation is observed again immediately before
    // durable commit, under the same lock that fences other API instances.
    await reauthorize?.();
    await atomicWrite(filePath(dataDir,record.id),next);
    await readManifest(dataDir,record.id);
    return {
      handoffId:record.id,taskId:task.id,action:input.action,
      generation,leaseId,expiresAt,
      attempts:input.action==="claim"?state.attempts+1:state.attempts,
      state:input.action==="release"?"released":"leased",
      evidence:"not_started",
    };
  },waitMs);
}


/** Manual sign-off of a PM planning artifact digest, not a test result.
 * The producer and an independent checkpoint_approver must BOTH authorize;
 * approver never receives the private leaseId. The SHA-256 digest is a
 * caller-provided identifier of an external artifact, NOT an off-host proof.
 */
function checkpointRequest(input) {
  const base=["action","handoffId","taskId","submissionId","artifactDigest"];
  const submit=exact(input,[...base,"leaseId","reportedUnits"]);
  const approve=exact(input,base);
  if (!(submit||approve) ||
      input.action!==(submit?"submit":"approve") ||
      typeof input.handoffId!=="string" || !UUID.test(input.handoffId) ||
      typeof input.taskId!=="string" || !TASK.test(input.taskId) ||
      typeof input.submissionId!=="string" || !UUID.test(input.submissionId) ||
      typeof input.artifactDigest!=="string" || !SHA.test(input.artifactDigest) ||
      submit && (!UUID.test(input.leaseId) ||
        !Number.isInteger(input.reportedUnits) || input.reportedUnits<1 ||
        input.reportedUnits>250))
    throw issue("HANDOFF_CHECKPOINT_INVALID");
  return input;
}
export async function mutateAgentTaskCheckpoint({
  dataDir,request,actor,reauthorize,waitMs=1500,
  nowMs=Date.now, // deterministic Node test hook; NEVER from HTTP request
}) {
  const input=checkpointRequest(request);
  if (!actor || !ACTOR.test(actor.id) ||
      !(actor.tenantId===null || typeof actor.tenantId==="string" &&
        TENANT.test(actor.tenantId)) ||
      !(input.action==="submit" ? actor.role==="project_manager" :
        actor.role==="checkpoint_approver"))
    throw issue("HANDOFF_CHECKPOINT_FORBIDDEN");
  return withAdmissionLock(dataDir,async()=>{
    await reauthorize?.();
    await trustedDirectory(directory(dataDir));
    let record;
    try { record=await readManifest(dataDir,input.handoffId); }
    catch(error) {
      if (error.code==="ENOENT") throw issue("HANDOFF_NOT_FOUND");
      throw error;
    }
    const task=record.tasks.find(t=>t.id===input.taskId);
    if (record.tenantId!==actor.tenantId || !task ||
        task.role!=="project_manager" ||
        (input.action==="submit" ?
          task.owner!==actor.id : actor.id===task.owner))
      throw issue("HANDOFF_NOT_FOUND");
    const states=verifyLeaseHistory(record),state=states.get(task.id);
    const now=nowMs(),at=new Date(now).toISOString();
    const active=state.active && Date.parse(state.expiresAt)>now;
    const sameSubmission=state.submission &&
      state.submission.id===input.submissionId &&
      state.submission.digest===input.artifactDigest;
    const response=created=>({
      version:1,handoffId:record.id,taskId:task.id,
      action:input.action,submissionId:input.submissionId,
      artifactDigest:input.artifactDigest,generation:state.generation,
      state:input.action==="submit"?"awaiting_human_approval":"human_approved_checkpoint",
      reportedUnits:input.action==="submit" ? input.reportedUnits :
        (state.submission?.reportedUnits ?? 0),
      evidence:input.action==="submit"?"not_started":"human_approved_digest",
      created,
    });
    // Idempotent lost-ack recovery: no second event or budget accounting.
    if (input.action==="submit" && active && sameSubmission &&
        input.leaseId===state.leaseId &&
        input.reportedUnits===state.submission.reportedUnits &&
        !state.approved) {
      await reauthorize?.(); return response(false);
    }
    if (input.action==="approve" && state.approved && sameSubmission &&
        state.approvedBy===actor.id) {
      await reauthorize?.(); return response(false);
    }
    if (state.approved || record.events?.length>=MAX_LEASE_EVENTS)
      throw issue(state.approved?"HANDOFF_CHECKPOINT_CONFLICT":"HANDOFF_LEASE_CAPACITY");
    if (!active) throw issue("HANDOFF_LEASE_STALE");
    if (input.action==="submit") {
      if (state.submission || input.leaseId!==state.leaseId ||
          input.reportedUnits>task.estimatedUnits)
        throw issue("HANDOFF_CHECKPOINT_CONFLICT");
    } else if (!sameSubmission || !state.submission)
      throw issue("HANDOFF_CHECKPOINT_CONFLICT");
    if (state.at && now<Date.parse(state.at)) throw issue("HANDOFF_INTEGRITY");
    const reportedUnits=input.action==="submit" ?
      input.reportedUnits : state.submission.reportedUnits;
    // Guard against double counting or integer overflow. These units are
    // reviewed self-reports, NOT attested provider billing.
    const existing=record.tasks.reduce((sum,t)=>
      sum+(states.get(t.id)?.approved ?
        states.get(t.id).submission.reportedUnits : 0),0);
    if (!Number.isSafeInteger(existing+reportedUnits) ||
        existing+reportedUnits>record.budgetUnits)
      throw issue("HANDOFF_CHECKPOINT_BUDGET");
    const payload={
      sequence:(record.events?.length??0)+1,
      previousHash:record.head??GENESIS,
      kind:input.action,at,taskId:task.id,actorId:actor.id,
      generation:state.generation,leaseId:state.leaseId,
      expiresAt:state.expiresAt,
      submissionId:input.submissionId,
      artifactDigest:input.artifactDigest,reportedUnits,
    };
    const event={...payload,hash:hash(payload)};
    const withoutHash={...record,
      events:[...(record.events??[]),event],head:event.hash};
    delete withoutHash.hash;
    const next={...withoutHash,hash:hash(withoutHash)};
    if (Buffer.byteLength(JSON.stringify(next))>MAX_RECORD_BYTES)
      throw issue("HANDOFF_LEASE_CAPACITY");
    await reauthorize?.(); // both producer and approver revocation under lock
    await atomicWrite(filePath(dataDir,record.id),next);
    const checked=await readManifest(dataDir,record.id);
    const verified=verifyLeaseHistory(checked).get(task.id);
    if (input.action==="submit" ? !verified.submission ||
        verified.approved : !verified.approved)
      throw issue("HANDOFF_INTEGRITY");
    return response(true);
  },waitMs);
}


/** A local successful Docker job, not an AI actor claim or a signed off-host
 * attestation. Rechecked on EVERY retained handoff read (and thus on claim).
 */
async function verifyTechnicalJob(dataDir,proof,task,tenantId,claimAt) {
  try {
    const verified=await verifyJobEvidenceForRead(dataDir,proof.jobId);
    const report=verified.report,plan=projectVerifiedJobPlan(verified);
    const time=value=>typeof value==="string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString()===value;
    const matched=plan.tasks.filter(t=>t.id===proof.step);
    if (report.id!==proof.jobId ||
        report.digest!==proof.jobDigest ||
        verified.head!==proof.jobHead ||
        verified.entries.length!==proof.jobCount ||
        (report.tenantId??null)!==tenantId ||
        report.state!=="passed" || plan.state!=="passed" ||
        verified.entries.at(-1)?.kind!=="finished" ||
        !TEST_STEPS.has(proof.step) || task.role!=="tester" ||
        matched.length!==1 || matched[0].status!=="passed" ||
        !plan.tasks.every(t=>t.status==="passed") ||
        !time(report.acceptedAt) || !time(report.startedAt) ||
        !time(report.finishedAt) || !time(claimAt) || !time(proof.at) ||
        Date.parse(report.acceptedAt)<=Date.parse(claimAt) ||
        Date.parse(report.startedAt)<Date.parse(report.acceptedAt) ||
        Date.parse(report.finishedAt)<Date.parse(report.startedAt) ||
        Date.parse(report.finishedAt)>Date.parse(proof.at))
      throw issue("HANDOFF_TEST_EVIDENCE");
    return verified;
  } catch { throw issue("HANDOFF_TEST_EVIDENCE"); }
}
async function verifyTechnicalProofs(dataDir,record) {
  const states=verifyLeaseHistory(record),snapshots=new Map();
  for (const task of record.tasks) {
    const state=states.get(task.id);
    if (!state.testVerified) continue;
    const verified=await verifyTechnicalJob(dataDir,state.testVerified,task,
      record.tenantId,state.claimAt);
    try {
      // The job report digest includes label AND requested steps. Reopen the
      // immutable, inode-checked input file and validate its canonical form
      // before deriving a separate source-only fingerprint.
      const input=await readRunnerInput(dataDir,state.testVerified.jobId);
      if (!exact(input,["schemaVersion","label","files","steps"]))
        throw Error("unexpected input fields");
      const checked=validateRequest(input);
      if (JSON.stringify(checked.request)!==JSON.stringify(input) ||
          checked.digest!==verified.report.digest ||
          checked.digest!==state.testVerified.jobDigest ||
          checked.fileCount!==verified.report.fileCount ||
          checked.bytes!==verified.report.bytes ||
          JSON.stringify(input.steps)!==JSON.stringify(verified.report.steps) ||
          !input.steps.includes(state.testVerified.step))
        throw Error("job input does not match verified report");
      snapshots.set(task.id,hash({
        scope:"runner-input-files-v1",files:checked.request.files,
      }));
    } catch { throw issue("HANDOFF_TEST_EVIDENCE"); }
  }
  return snapshots;
}
function testVerificationRequest(input) {
  if (!exact(input,["handoffId","taskId","leaseId","submissionId",
      "jobId","jobDigest","jobHead","jobCount","step"]) ||
      !UUID.test(input.handoffId) || !TASK.test(input.taskId) ||
      !UUID.test(input.leaseId) || !UUID.test(input.submissionId) ||
      !UUID.test(input.jobId) || !SHA.test(input.jobDigest) ||
      !SHA.test(input.jobHead) || !Number.isInteger(input.jobCount) ||
      input.jobCount<1 || input.jobCount>48 || !TEST_STEPS.has(input.step))
    throw issue("HANDOFF_TEST_INVALID");
  return input;
}
/** An actor may reference an existing test job, but cannot declare its
 * verdict. Only the worker's inode-checked SHA chain can grant completion.
 */
export async function verifyAgentTestTask({
  dataDir,request,actor,reauthorize,waitMs=1500,
  nowMs=Date.now, // deterministic test seam, NEVER accepted from HTTP input
}) {
  const input=testVerificationRequest(request);
  if (!actor || actor.role!=="tester" || !ACTOR.test(actor.id) ||
      !(actor.tenantId===null || typeof actor.tenantId==="string" &&
        TENANT.test(actor.tenantId)))
    throw issue("HANDOFF_TEST_FORBIDDEN");
  return withAdmissionLock(dataDir,async()=>{
    await reauthorize?.();
    await trustedDirectory(directory(dataDir));
    let record;
    try { record=await readManifest(dataDir,input.handoffId); }
    catch(error) {
      if (error.code==="ENOENT") throw issue("HANDOFF_NOT_FOUND");
      throw error;
    }
    const task=record.tasks.find(t=>t.id===input.taskId);
    if (record.tenantId!==actor.tenantId || !task ||
        task.role!=="tester" || task.owner!==actor.id)
      throw issue("HANDOFF_NOT_FOUND");
    const states=verifyLeaseHistory(record),state=states.get(task.id);
    const now=nowMs(),at=new Date(now).toISOString();
    const same=state.testVerified &&
      state.testVerified.id===input.submissionId &&
      state.testVerified.jobId===input.jobId &&
      state.testVerified.jobDigest===input.jobDigest &&
      state.testVerified.jobHead===input.jobHead &&
      state.testVerified.jobCount===input.jobCount &&
      state.testVerified.step===input.step &&
      state.leaseId===input.leaseId;
    const reply=created=>({
      version:1,handoffId:record.id,taskId:task.id,
      submissionId:input.submissionId,jobId:input.jobId,
      generation:state.generation,created,state:"runner_verified_test",
      evidence:{digest:input.jobDigest,head:input.jobHead,
        count:input.jobCount,step:input.step},
    });
    if (same) { await reauthorize?.(); return reply(false); }
    if (state.approved || state.testVerified)
      throw issue("HANDOFF_TEST_CONFLICT");
    if (!state.active || Date.parse(state.expiresAt)<=now ||
        state.leaseId!==input.leaseId ||
        state.at && now<Date.parse(state.at) ||
        !state.claimAt || now<=Date.parse(state.claimAt))
      throw issue("HANDOFF_LEASE_STALE");
    if (record.events?.length>=MAX_LEASE_EVENTS)
      throw issue("HANDOFF_LEASE_CAPACITY");
    const proof={
      id:input.submissionId,jobId:input.jobId,
      jobDigest:input.jobDigest,jobHead:input.jobHead,
      jobCount:input.jobCount,step:input.step,at,
    };
    await verifyTechnicalJob(dataDir,proof,task,record.tenantId,state.claimAt);
    // Two API replicas serialize a complete verified scan, preventing the
    // same job from satisfying two distinct Tester task assignments.
    const all=await listVerified(dataDir);
    if (all.some(other=>other.events?.some(event=>
      event.kind==="test_verified" && event.jobId===input.jobId)))
      throw issue("HANDOFF_TEST_CONFLICT");
    await reauthorize?.();
    // A long scan cannot commit a lease after it has expired. Bind the event
    // timestamp to the final validation, not to the initial API receipt.
    const commitNow=nowMs();
    if (commitNow<=Date.parse(state.claimAt) ||
        commitNow>=Date.parse(state.expiresAt) ||
        state.at && commitNow<Date.parse(state.at))
      throw issue("HANDOFF_LEASE_STALE");
    const commitAt=new Date(commitNow).toISOString();
    proof.at=commitAt;
    await verifyTechnicalJob(dataDir,proof,task,record.tenantId,state.claimAt);
    const eventBody={
      sequence:(record.events?.length??0)+1,
      previousHash:record.head??GENESIS,
      kind:"test_verified",at:commitAt,taskId:task.id,actorId:actor.id,
      generation:state.generation,leaseId:state.leaseId,
      expiresAt:state.expiresAt,submissionId:input.submissionId,
      jobId:input.jobId,jobDigest:input.jobDigest,jobHead:input.jobHead,
      jobCount:input.jobCount,step:input.step,
    };
    const event={...eventBody,hash:hash(eventBody)};
    const withoutHash={...record,events:[...(record.events??[]),event],head:event.hash};
    delete withoutHash.hash;
    const next={...withoutHash,hash:hash(withoutHash)};
    if (Buffer.byteLength(JSON.stringify(next))>MAX_RECORD_BYTES)
      throw issue("HANDOFF_LEASE_CAPACITY");
    await reauthorize?.();
    if (nowMs()>=Date.parse(state.expiresAt))
      throw issue("HANDOFF_LEASE_STALE");
    await atomicWrite(filePath(dataDir,record.id),next);
    await readManifest(dataDir,record.id);
    return reply(true);
  },waitMs);
}
