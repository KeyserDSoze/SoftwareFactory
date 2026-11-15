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

/** Operator registry rotation: every request reads a new fd, so an atomic
 * same-filesystem rename takes effect without an API restart or a stale cache.
 * The API service owns this secret; it must never be mounted in the worker.
 */
export async function loadRepairOperatorsFile(filePath, runnerKey) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) ||
      filePath.includes("\0")) throw unavailable();
  let fd;
  try {
    fd = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size < 1 || stat.size > MAX_FILE_BYTES) throw unavailable();
    // Bounded even if an administrator modifies a file in place. Rotate only
    // with atomic rename: in-place writes could yield a transient 503.
    const chunks = [];
    let total = 0;
    while (total <= MAX_FILE_BYTES) {
      const chunk = Buffer.alloc(Math.min(2048, MAX_FILE_BYTES + 1 - total));
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_FILE_BYTES) throw unavailable();
    return configureRepairOperators(Buffer.concat(chunks).toString("utf8"), runnerKey)
      ?? (() => { throw unavailable(); })();
  } catch {
    // Not distinguishable to external callers: missing, symlink, permissions,
    // malformed JSON and interrupted replacement all fail closed.
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
