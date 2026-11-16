/** Persistent, operator-declared repair checkpoints.
 * Never executes AI, changes sources or submits Docker jobs.
 * Serialized on the same shared POSIX volume as admission; no TTL lock takeover.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { atomicWrite, ALLOWED_STEPS } from "./common.mjs";
import { withAdmissionLock } from "./admission.mjs";
import { verifyJobEvidence } from "./evidence.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const ACTOR = /^[a-z][a-z0-9_-]{1,31}$/;
const ZERO = "0".repeat(64);
const MAX_SESSIONS = 100;
const MAX_SESSION_BYTES = 64_000;
const issue = code => Object.assign(new Error(code), { code });
const digest = data => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object) &&
  Object.keys(object).sort().join(",") === [...keys].sort().join(",");

function allowedEditPath(value) {
  return typeof value === "string" && value.length <= 180 &&
    /^src\/backend\/(?:applications\/Api|business|domain|infrastructure)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z][A-Za-z0-9_-]*\.cs$/.test(value) ||
    typeof value === "string" && value.length <= 180 &&
    /^src\/frontend\/web\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z][A-Za-z0-9_-]*\.(?:ts|tsx|css)$/.test(value) ||
    typeof value === "string" && value.length <= 180 &&
    /^src\/frontend\/web\/e2e\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z][A-Za-z0-9_-]*\.spec\.ts$/.test(value);
}
function allowedPaths(paths) {
  return Array.isArray(paths) && paths.length >= 1 && paths.length <= 8 &&
    paths.every(allowedEditPath) && new Set(paths).size === paths.length &&
    isDeepStrictEqual(paths, [...paths].sort());
}
function requiredSteps(paths, rootSteps) {
  if (!Array.isArray(rootSteps) || !rootSteps.length ||
      rootSteps.some(s => !ALLOWED_STEPS.includes(s)) ||
      new Set(rootSteps).size !== rootSteps.length) throw issue("REPAIR_INTEGRITY");
  const required = new Set(rootSteps);
  for (const p of paths) {
    if (p.endsWith(".cs")) required.add("dotnet-build");
    if (p.startsWith("src/frontend/web/src/")) required.add("web-build");
    if (p.startsWith("src/frontend/web/e2e/")) required.add("playwright");
  }
  return ALLOWED_STEPS.filter(s => required.has(s));
}
function legitimateFailure(report) {
  return report.state === "failed" && Array.isArray(report.results) &&
    report.results.some(r => ALLOWED_STEPS.includes(r.step) &&
      r.state === "failed" && Number.isInteger(r.exitCode) &&
      r.exitCode !== 0 && r.timedOut !== true);
}
function legitimatePass(report, expectedDigest, mandatorySteps) {
  return report.state === "passed" && report.digest === expectedDigest &&
    Array.isArray(report.steps) && Array.isArray(report.results) &&
    report.steps.length === report.results.length &&
    mandatorySteps.every(step => report.steps.includes(step)) &&
    report.results.every((r, i) => r.step === report.steps[i] &&
      r.state === "passed" && r.exitCode === 0 &&
      r.timedOut !== true && typeof r.durationMs === "number" &&
      Number.isFinite(r.durationMs) && r.durationMs >= 0);
}
function baseDirectory(dataDir) { return path.join(dataDir, "repair-sessions"); }
function sessionFile(dataDir, id) {
  if (!UUID.test(id)) throw issue("REPAIR_INVALID");
  return path.join(baseDirectory(dataDir), id + ".json");
}
function checkpoint(record, kind, data, actorId, at = new Date().toISOString()) {
  if (!ACTOR.test(actorId)) throw issue("REPAIR_INVALID");
  const previousHash = record.head;
  const event = { sequence: record.events.length + 1, previousHash,
    kind, at, actorId, data };
  const hash = digest(event);
  return { ...record, head: hash, events: [...record.events, { ...event, hash }] };
}

/** Reconstruct state solely from hashed events. A forged or partial checkpoint
 * cannot alter the projection without failing local integrity checks.
 * As with the runner journal, local hashes are not a remote notarization.
 */
export function verifyRepairSession(record) {
  try {
    if (!exact(record, ["version","id","createdAt","rootJobId","rootDigest","proposalId",
      "paths","requiredSteps","state","attempts","events","head"]) ||
      record.version !== 1 || !UUID.test(record.id) ||
      !UUID.test(record.rootJobId) || !UUID.test(record.proposalId) ||
      !DIGEST.test(record.rootDigest) || !allowedPaths(record.paths) ||
      !Array.isArray(record.events) || record.events.length < 1 ||
      record.events.length > 12 || !DIGEST.test(record.head) ||
      typeof record.createdAt !== "string" ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      JSON.stringify(record).length > 64_000)
      throw issue("REPAIR_INTEGRITY");
    const mandatory = requiredSteps(record.paths, record.events[0]?.data?.rootSteps);
    if (!isDeepStrictEqual(mandatory, record.requiredSteps)) throw issue("REPAIR_INTEGRITY");
    let head = ZERO, state = "", attempts = [];
    for (const [i, event] of record.events.entries()) {
      // Legacy checkpoints from #25 have no actorId and remain readable;
      // every newly written event is bound to a non-secret operator ID.
      if (!(exact(event, ["sequence","previousHash","kind","at","data","hash"]) ||
            exact(event, ["sequence","previousHash","kind","at","actorId","data","hash"])) ||
          (event.actorId !== undefined && !ACTOR.test(event.actorId)) ||
          event.sequence !== i + 1 || event.previousHash !== head ||
          !DIGEST.test(event.hash) ||
          !Number.isFinite(Date.parse(event.at)) ||
          typeof event.kind !== "string")
        throw issue("REPAIR_INTEGRITY");
      const { hash, ...withoutHash } = event;
      if (digest(withoutHash) !== hash) throw issue("REPAIR_INTEGRITY");
      head = hash;
      const d = event.data;
      if (i === 0) {
        if (event.kind !== "started" ||
            !exact(d, ["rootJobId","rootDigest","proposalId","paths","rootSteps"]) ||
            d.rootJobId !== record.rootJobId ||
            d.rootDigest !== record.rootDigest ||
            d.proposalId !== record.proposalId ||
            !isDeepStrictEqual(d.paths, record.paths))
          throw issue("REPAIR_INTEGRITY");
        state = "awaiting_patch";
      } else if (event.kind === "patch") {
        if (!["awaiting_patch","retest_failed","review_blocked"].includes(state) ||
            attempts.length >= 2 || !exact(d, ["digest","paths"]) ||
            !DIGEST.test(d.digest) || d.digest === record.rootDigest ||
            attempts.some(x => x.digest === d.digest) ||
            !isDeepStrictEqual(d.paths, record.paths))
          throw issue("REPAIR_INTEGRITY");
        attempts.push({ digest: d.digest, verdict: null, retestJobId: null, retestState: null });
        state = "awaiting_review";
      } else if (event.kind === "review") {
        if (state !== "awaiting_review" || !exact(d, ["verdict"]) ||
            !["pass","changes_required"].includes(d.verdict))
          throw issue("REPAIR_INTEGRITY");
        attempts[attempts.length - 1].verdict = d.verdict;
        state = d.verdict === "pass" ? "awaiting_retest" : "review_blocked";
      } else if (event.kind === "retest_passed" || event.kind === "retest_failed") {
        if (state !== "awaiting_retest" || !exact(d, ["jobId"]) ||
            !UUID.test(d.jobId) || d.jobId === record.rootJobId ||
            attempts.some(a => a.retestJobId === d.jobId))
          throw issue("REPAIR_INTEGRITY");
        attempts[attempts.length - 1].retestJobId = d.jobId;
        attempts[attempts.length - 1].retestState =
          event.kind === "retest_passed" ? "passed" : "failed";
        state = event.kind === "retest_passed" ? "awaiting_approval" : "retest_failed";
      } else if (event.kind === "record_approval") {
        if (state !== "awaiting_approval" || !exact(d, ["sessionId"]) ||
            d.sessionId !== record.id) throw issue("REPAIR_INTEGRITY");
        state = "recorded_approval";
      } else throw issue("REPAIR_INTEGRITY");
    }
    enforceActorSeparation(record.events, "REPAIR_INTEGRITY");
    if (head !== record.head || state !== record.state ||
        !isDeepStrictEqual(attempts, record.attempts) ||
        record.events[0].at !== record.createdAt)
      throw issue("REPAIR_INTEGRITY");
    return record;
  } catch { throw issue("REPAIR_INTEGRITY"); }
}

/**
 * Authorization invariants apply to BOTH new checkpoints and historical
 * verification. Legacy journals can be inspected but never retroactively
 * acquire an author or an independently reviewed approval.
 */
function enforceActorSeparation(events, failureCode) {
  const proposer = events[0]?.actorId;
  if (proposer === undefined) {
    // Never assign a new identity to the author of a pre-#27 session.
    if (failureCode !== "REPAIR_INTEGRITY")
      throw issue("REPAIR_LEGACY_READONLY");
    if (events.some(event => event.actorId !== undefined))
      throw issue("REPAIR_INTEGRITY"); // Mixed attributed/unattributed history.
    return; // Read-only legacy history from before #27.
  }
  if (!ACTOR.test(proposer)) throw issue(failureCode);
  let reviewer = null;
  for (const event of events.slice(1)) {
    if (!ACTOR.test(event.actorId)) throw issue(failureCode);
    if (event.kind === "patch") {
      if (event.actorId !== proposer) throw issue(failureCode);
      reviewer = null; // Each attempt requires its own independent review.
    } else if (event.kind === "review") {
      if (event.actorId === proposer) throw issue(failureCode);
      reviewer = event.actorId;
    } else if (event.kind === "retest_passed" || event.kind === "retest_failed") {
      if (event.actorId !== proposer) throw issue(failureCode);
    } else if (event.kind === "record_approval") {
      if (!reviewer || event.actorId === reviewer || event.actorId === proposer)
        throw issue(failureCode);
    }
  }
}

/** Validate the OPENED inode, never a pathname checked before a second open.
 * Existing legacy (#25) ledgers can be 0644: preserve their read-only
 * compatibility, but still require an owner-controlled regular single-link
 * file. New writer snapshots stay 0600 via atomicWrite.
 */
export function isPrivateRepairSessionFile(stat, effectiveUid = process.geteuid?.()) {
  return Number.isSafeInteger(effectiveUid) && effectiveUid >= 0 &&
    stat?.isFile?.() === true && stat.uid === effectiveUid &&
    stat.nlink === 1 && Number.isSafeInteger(stat.size) &&
    stat.size >= 1 && stat.size <= MAX_SESSION_BYTES;
}
/** A descriptor opened before an atomic rename can reference the now-unlinked
 * OLD inode (nlink=0). Never accept that inode as authoritative: reopen the
 * path a bounded number of times. Hardlinks (nlink>1) are never retried.
 */
export function isRotatedRepairSessionFile(stat) {
  return stat?.isFile?.() === true && stat.nlink === 0;
}
async function readSession(dataDir, id) {
  const file = sessionFile(dataDir, id);
  if (typeof constants.O_NOFOLLOW !== "number") throw issue("REPAIR_INTEGRITY");
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await fd.stat();
      if (isRotatedRepairSessionFile(before)) throw issue("REPAIR_SNAPSHOT_ROTATED");
      if (!isPrivateRepairSessionFile(before)) throw issue("REPAIR_INTEGRITY");
      const chunks = [];
      let total = 0;
      // Read a maximum of MAX_SESSION_BYTES + 1 from the validated FD, not
      // an unbounded readFile(path) which can follow a swapped symlink.
      while (total <= MAX_SESSION_BYTES) {
        const chunk = Buffer.alloc(Math.min(8192, MAX_SESSION_BYTES + 1 - total));
        const { bytesRead } = await fd.read(chunk, 0, chunk.length, total);
        if (!bytesRead) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      if (total !== before.size || total > MAX_SESSION_BYTES)
        throw issue("REPAIR_INTEGRITY");
      const after = await fd.stat();
      if (isRotatedRepairSessionFile(after)) throw issue("REPAIR_SNAPSHOT_ROTATED");
      if (!isPrivateRepairSessionFile(after) ||
          before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs)
        throw issue("REPAIR_INTEGRITY");
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8")); }
      catch { throw issue("REPAIR_INTEGRITY"); }
      // A valid hash-chain for session B must never be served or mutated
      // through the filename and API endpoint belonging to session A.
      if (parsed?.id !== id) throw issue("REPAIR_INTEGRITY");
      return verifyRepairSession(parsed);
    } catch (error) {
      if (error.code === "ENOENT") throw error; // Preserve GET 404.
      if (error.code !== "REPAIR_SNAPSHOT_ROTATED" || attempt === 2)
        throw issue("REPAIR_INTEGRITY");
    } finally {
      await fd?.close().catch(() => {});
    }
    await sleep(15);
  }
  throw issue("REPAIR_INTEGRITY");
}
const overview = r => ({
  version: r.version, id: r.id, rootJobId: r.rootJobId, rootDigest: r.rootDigest,
  proposalId: r.proposalId, paths: r.paths, requiredSteps: r.requiredSteps,
  state: r.state, attempts: r.attempts, checkpointCount: r.events.length,
  checkpointHead: r.head, createdAt: r.createdAt,
  audit: r.events.map(e => ({ sequence: e.sequence, kind: e.kind,
    actorId: e.actorId ?? null })),
});
export async function getRepairSession(dataDir, id) {
  return overview(await readSession(dataDir, id));
}
async function locked(dataDir, action, reauthorize) {
  // A queued mutation must not use an operator authorization captured before
  // waiting for the shared lock. The registry is rechecked inside this lock.
  return withAdmissionLock(dataDir, async () => {
    if (reauthorize) await reauthorize();
    return action();
  }, 1500);
}
export async function beginRepairSession(
  dataDir, input, actorId, timestamp = () => new Date().toISOString(),
  reauthorize = undefined,
) {
  if (!ACTOR.test(actorId)) throw issue("REPAIR_INVALID");
  if (!exact(input, ["failedJobId","proposalId","paths","consent"]) ||
      input.consent !== true || !UUID.test(input.failedJobId) ||
      !UUID.test(input.proposalId) || !allowedPaths(input.paths))
    throw issue("REPAIR_INVALID");
  return locked(dataDir, async () => {
    const root = baseDirectory(dataDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    let entries;
    // On shared volumes, an atomic snapshot writer may briefly expose a
    // temporary entry to a directory scan. Retry only a bounded integrity
    // read; no record is accepted unless the entire rescan verifies.
    // Persistent corruption must still fail closed after three attempts.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        entries = await readdir(root, { withFileTypes: true });
        if (entries.length > MAX_SESSIONS) throw issue("REPAIR_CAPACITY");
        let matching = null;
        for (const entry of entries) {
          if (!entry.isFile() || !/^[-a-f0-9]{36}\.json$/.test(entry.name))
            throw issue("REPAIR_INTEGRITY");
          let existing;
          try { existing = await readSession(dataDir, entry.name.slice(0, -5)); }
          catch (error) {
            if (error.code === "ENOENT") throw issue("REPAIR_INTEGRITY");
            throw error;
          }
          if (existing.rootJobId === input.failedJobId) {
            if (existing.proposalId !== input.proposalId ||
                !isDeepStrictEqual(existing.paths, input.paths))
              throw issue("REPAIR_CONFLICT");
            matching = existing;
          }
        }
        // Never allow an early matching record to conceal a corrupt sibling.
        // Validate every directory entry before returning even a replayed ID.
        if (matching) return overview(matching);
        break;
      } catch (error) {
        if (error.code !== "REPAIR_INTEGRITY" || attempt === 2) throw error;
        await sleep(30);
      }
    }
    if (entries.length === MAX_SESSIONS) throw issue("REPAIR_CAPACITY");
    const rootEvidence = await verifyJobEvidence(dataDir, input.failedJobId);
    // Legacy global operator approvals have no tenant-scoped consent policy.
    // Even after an accidental mode rollback, tenant jobs cannot enter repair.
    if (rootEvidence.report.tenantId !== undefined) throw issue("REPAIR_EVIDENCE");
    // Older workers could record a crash-recovered job as "failed" even
    // though the final code-test verdict was never committed. Recovered is
    // an interrupted execution, NOT repairable, including legacy reports.
    if (rootEvidence.entries.some(entry => entry.kind === "recovered") ||
        !legitimateFailure(rootEvidence.report)) throw issue("REPAIR_NOT_FAILED");
    const report = rootEvidence.report;
    const id = randomUUID();
    // One instant for the persisted session and its first hashed event.
    // Two Date calls can straddle a millisecond and spuriously fail integrity.
    const createdAt = timestamp();
    const required = requiredSteps(input.paths, report.steps);
    const start = { version: 1, id, createdAt,
      rootJobId: input.failedJobId, rootDigest: report.digest,
      proposalId: input.proposalId, paths: input.paths, requiredSteps: required,
      state: "awaiting_patch", attempts: [], head: ZERO, events: [] };
    const next = checkpoint(start, "started", {
      rootJobId: report.id, rootDigest: report.digest,
      proposalId: input.proposalId, paths: input.paths, rootSteps: report.steps,
    }, actorId, createdAt);
    verifyRepairSession(next);
    await atomicWrite(sessionFile(dataDir, id), next);
    return overview(next);
  }, reauthorize);
}
export async function advanceRepairSession(dataDir, id, input, actorId, reauthorize = undefined) {
  if (!ACTOR.test(actorId)) throw issue("REPAIR_INVALID");
  if (!UUID.test(id) || !input || typeof input !== "object" ||
      Array.isArray(input) || input.consent !== true ||
      typeof input.action !== "string")
    throw issue("REPAIR_INVALID");
  return locked(dataDir, async () => {
    const current = await readSession(dataDir, id);
    let kind, data;
    if (input.action === "patch") {
      if (!exact(input, ["action","consent","digest","paths"]) ||
          !DIGEST.test(input.digest) || !allowedPaths(input.paths))
        throw issue("REPAIR_INVALID");
      kind = "patch"; data = { digest: input.digest, paths: input.paths };
    } else if (input.action === "review") {
      if (!exact(input, ["action","consent","verdict"]) ||
          !["pass","changes_required"].includes(input.verdict))
        throw issue("REPAIR_INVALID");
      kind = "review"; data = { verdict: input.verdict };
    } else if (input.action === "retest") {
      if (!exact(input, ["action","consent","jobId"]) || !UUID.test(input.jobId))
        throw issue("REPAIR_INVALID");
      if (current.state !== "awaiting_retest")
        throw issue("REPAIR_TRANSITION");
      let test, testEntries;
      try {
        const verified = await verifyJobEvidence(dataDir, input.jobId);
        test = verified.report;
        testEntries = verified.entries;
      }
      catch (error) {
        if (error.code === "EVIDENCE_INVALID" || error.code === "ENOENT")
          throw issue("REPAIR_EVIDENCE");
        throw error;
      }
      const target = current.attempts.at(-1);
      if (test.tenantId !== undefined ||
          test.id !== input.jobId || test.digest !== target.digest ||
          test.id === current.rootJobId ||
          test.steps?.some(step => !ALLOWED_STEPS.includes(step)))
        throw issue("REPAIR_EVIDENCE");
      const passed = legitimatePass(test, target.digest, current.requiredSteps);
      const failed = !testEntries.some(entry => entry.kind === "recovered") &&
        legitimateFailure(test) &&
        current.requiredSteps.every(step => test.steps?.includes(step)) &&
        test.results.every((r, i) => r.step === test.steps[i] &&
          r.state !== "skipped" && r.timedOut !== true);
      if (!passed && !failed) throw issue("REPAIR_EVIDENCE");
      kind = passed ? "retest_passed" : "retest_failed";
      data = { jobId: input.jobId };
    } else if (input.action === "record_approval") {
      if (!exact(input, ["action","consent","confirmSessionId"]) ||
          input.confirmSessionId !== id || current.state !== "awaiting_approval")
        throw issue("REPAIR_TRANSITION");
      const last = current.attempts.at(-1);
      let result;
      try { result = (await verifyJobEvidence(dataDir, last.retestJobId)).report; }
      catch { throw issue("REPAIR_EVIDENCE"); }
      if (result.tenantId !== undefined ||
          !legitimatePass(result, last.digest, current.requiredSteps))
        throw issue("REPAIR_EVIDENCE");
      kind = "record_approval"; data = { sessionId: id };
    } else throw issue("REPAIR_INVALID");
    const next = checkpoint(current, kind, data, actorId);
    // Replay the event sequence to derive all state and attempt projections.
    const projected = projectEvents(next);
    verifyRepairSession(projected);
    await atomicWrite(sessionFile(dataDir, id), projected);
    return overview(projected);
  }, reauthorize);
}
function projectEvents(next) {
  enforceActorSeparation(next.events, "REPAIR_ACTOR_CONFLICT");
  let state = "awaiting_patch", attempts = [];
  for (const event of next.events.slice(1)) {
    const d = event.data;
    if (event.kind === "patch") {
      if (!["awaiting_patch","retest_failed","review_blocked"].includes(state) ||
          attempts.length >= 2 || d.digest === next.rootDigest ||
          !DIGEST.test(d.digest) || !isDeepStrictEqual(d.paths, next.paths) ||
          attempts.some(a => a.digest === d.digest))
        throw issue("REPAIR_TRANSITION");
      attempts.push({ digest: d.digest, verdict: null, retestJobId: null, retestState: null });
      state = "awaiting_review";
    } else if (event.kind === "review") {
      if (state !== "awaiting_review") throw issue("REPAIR_TRANSITION");
      attempts.at(-1).verdict = d.verdict;
      state = d.verdict === "pass" ? "awaiting_retest" : "review_blocked";
    } else if (event.kind === "retest_passed" || event.kind === "retest_failed") {
      if (state !== "awaiting_retest" || d.jobId === next.rootJobId ||
          attempts.some(a => a.retestJobId === d.jobId))
        throw issue("REPAIR_TRANSITION");
      attempts.at(-1).retestJobId = d.jobId;
      attempts.at(-1).retestState = event.kind === "retest_passed" ? "passed" : "failed";
      state = event.kind === "retest_passed" ? "awaiting_approval" : "retest_failed";
    } else if (event.kind === "record_approval") {
      if (state !== "awaiting_approval") throw issue("REPAIR_TRANSITION");
      state = "recorded_approval";
    }
  }
  return { ...next, state, attempts };
}
