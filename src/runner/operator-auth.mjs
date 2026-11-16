/** Scoped runner checkpoint credentials, not human identity proof or a replacement for OIDC.
 * This registry is server-side only; never echo or persist the actual keys.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const ROLES = new Set(["propose", "review", "approve"]);
const ID = /^[a-z][a-z0-9_-]{1,31}$/;
const SECRET = /^[\x21-\x7e]{32,256}$/;
const deny = () => { throw new Error("Invalid RUNNER_REPAIR_OPERATORS_JSON configuration"); };
const fingerprint = token => createHash("sha256").update(token).digest();
const MAX_FILE_BYTES = 10000;
const unavailable = () => Object.assign(new Error("repair_operator_registry_unavailable"),
  { code: "REPAIR_AUTH_UNAVAILABLE" });

/** All registry metadata is checked on the OPEN file descriptor, not a path
 * that an attacker or atomic rotation might replace between stat and read.
 * A readable mode-0600 file owned by another identity is not an API secret.
 */
export function isPrivateRepairOperatorFile(stat, effectiveUid = process.geteuid?.()) {
  return Number.isSafeInteger(effectiveUid) && effectiveUid >= 0 &&
    stat?.isFile?.() === true && stat.uid === effectiveUid &&
    stat.nlink === 1 && (stat.mode & 0o077) === 0 &&
    stat.size >= 1 && stat.size <= MAX_FILE_BYTES;
}

/** Operator registry rotation: every request reads a new fd, so an atomic
 * same-filesystem rename takes effect without an API restart or a stale cache.
 * The API service owns this secret; it must never be mounted in the worker.
 */
/** All security metadata must stay stable across the complete read from
 * the SAME O_NOFOLLOW file descriptor. This is not a path-level TOCTOU check:
 * atomic rename rotation is allowed, but editing the opened inode is not.
 */
export function isStableRepairOperatorSnapshot(before, after,
  effectiveUid = process.geteuid?.()) {
  return isPrivateRepairOperatorFile(before, effectiveUid) &&
    isPrivateRepairOperatorFile(after, effectiveUid) &&
    before.dev === after.dev && before.ino === after.ino &&
    before.uid === after.uid && before.gid === after.gid &&
    before.nlink === after.nlink && before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** openFile is an internal Node-only deterministic test seam. The HTTP/API
 * configuration NEVER passes it; no client can bypass the descriptor checks.
 */
export async function loadRepairOperatorsFile(filePath, runnerKey, {
  openFile = open,
} = {}) {
  if (typeof constants.O_NOFOLLOW !== "number" ||
      typeof filePath !== "string" || !path.isAbsolute(filePath) ||
      filePath.includes("\0")) throw unavailable();
  let fd;
  try {
    fd = await openFile(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await fd.stat();
    if (!isPrivateRepairOperatorFile(before)) throw unavailable();
    // Read exactly the pinned size, not "until EOF": an in-place truncate,
    // append, or rewrite must not yield a usable mixed credential registry.
    const chunks = [];
    let total = 0;
    while (total < before.size) {
      const chunk = Buffer.alloc(Math.min(2048, before.size - total));
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, total);
      if (!Number.isInteger(bytesRead) || bytesRead <= 0 ||
          bytesRead > chunk.length) throw unavailable();
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const after = await fd.stat();
    if (total !== before.size ||
        !isStableRepairOperatorSnapshot(before, after)) throw unavailable();
    return configureRepairOperators(Buffer.concat(chunks, total).toString("utf8"), runnerKey)
      ?? (() => { throw unavailable(); })();
  } catch {
    // Missing, symlink, changed metadata, incomplete read, malformed JSON,
    // and interrupted rotation are indistinguishable to external callers.
    throw unavailable();
  } finally {
    await fd?.close().catch(() => {});
  }
}

export function configureRepairOperators(source, runnerKey) {
  if (source === undefined || source === null || source === "")
    return null; // Repair routes remain fail-closed when no operator registry is configured.
  if (typeof source !== "string" || source.length > 10000) deny();
  let entries;
  try { entries = JSON.parse(source); } catch { deny(); }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 12) deny();
  const ids = new Set(), tokens = new Set();
  const operators = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "id,key,roles" ||
        typeof entry.id !== "string" || !ID.test(entry.id) ||
        typeof entry.key !== "string" || !SECRET.test(entry.key) ||
        entry.key === runnerKey || !Array.isArray(entry.roles) ||
        entry.roles.length < 1 || entry.roles.length > 3 ||
        entry.roles.some(role => !ROLES.has(role)) ||
        new Set(entry.roles).size !== entry.roles.length ||
        ids.has(entry.id) || tokens.has(entry.key)) deny();
    ids.add(entry.id);
    tokens.add(entry.key);
    operators.push(Object.freeze({
      id: entry.id, roles: Object.freeze([...entry.roles]),
      keyHash: fingerprint(entry.key),
    }));
  }
  return Object.freeze(operators);
}

export function authenticateRepairOperator(authorization, registry) {
  if (!registry || typeof authorization !== "string" ||
      !/^Bearer [\x21-\x7e]{32,256}$/.test(authorization))
    return null;
  const supplied = fingerprint(authorization.slice(7));
  let found = null;
  for (const operator of registry) {
    // Every valid token has a fixed SHA-256 length; never compare raw secrets.
    if (timingSafeEqual(supplied, operator.keyHash)) found = operator;
  }
  return found ? { id: found.id, roles: [...found.roles] } : null;
}

export function mayRecordRepairAction(operator, action) {
  if (!operator) return false;
  const scope = action === "begin" || action === "patch" || action === "retest"
    ? "propose" : action === "review" ? "review" :
      action === "record_approval" ? "approve" : null;
  return scope !== null && operator.roles.includes(scope);
}

/** Recheck a file-backed operator capability at the start of the ledger's
 * exclusive write section. Never persist or echo the supplied authorization.
 * Not a transaction with concurrent host-side registry replacement.
 */
export async function reauthorizeRepairMutation(filePath, runnerKey, authorization, actorId, action) {
  const registry = await loadRepairOperatorsFile(filePath, runnerKey);
  const current = authenticateRepairOperator(authorization, registry);
  if (!current) throw Object.assign(new Error("repair_authorization_revoked"),
    { code: "REPAIR_AUTH_REVOKED" });
  if (current.id !== actorId || !mayRecordRepairAction(current, action))
    throw Object.assign(new Error("repair_scope_revoked"),
      { code: "REPAIR_SCOPE_REVOKED" });
}
