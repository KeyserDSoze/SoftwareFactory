/** Opt-in multi-tenant API credential registry. Never mounted in the worker. */
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { authenticate } from "./common.mjs";

const MAX_BYTES = 16_384;
const ID = /^[a-z][a-z0-9-]{2,31}$/;
const unavailable = () => Object.assign(new Error("tenant_auth_unavailable"),
  { code: "TENANT_AUTH_UNAVAILABLE" });

export function isPrivateRunnerTenantsFile(stat, effectiveUid = process.geteuid?.()) {
  return Number.isSafeInteger(effectiveUid) && effectiveUid >= 0 &&
    stat?.isFile?.() === true && stat.uid === effectiveUid &&
    stat.nlink === 1 && (stat.mode & 0o077) === 0 &&
    Number.isSafeInteger(stat.size) && stat.size >= 32 && stat.size <= MAX_BYTES;
}

export function validateRunnerTenantRegistry(raw) {
  if (!raw || Array.isArray(raw) || typeof raw !== "object" ||
      Object.keys(raw).sort().join(",") !== "tenants,version" ||
      raw.version !== 1 || !Array.isArray(raw.tenants) ||
      raw.tenants.length < 1 || raw.tenants.length > 32) throw unavailable();
  const ids = new Set(), keys = new Set();
  const tenants = [];
  for (const entry of raw.tenants) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !==
          "id,key,maxAcceptedPerMinute,maxQueued,maxRetained" ||
        typeof entry.id !== "string" || !ID.test(entry.id) ||
        typeof entry.key !== "string" ||
        !entry.key.startsWith(entry.id + ".") ||
        !/^[a-z][a-z0-9-]{2,31}\.[a-zA-Z0-9_-]{32,128}$/.test(entry.key) ||
        !Number.isInteger(entry.maxQueued) || entry.maxQueued < 1 || entry.maxQueued > 100 ||
        !Number.isInteger(entry.maxRetained) || entry.maxRetained < entry.maxQueued ||
        entry.maxRetained > 100 ||
        !Number.isInteger(entry.maxAcceptedPerMinute) ||
        entry.maxAcceptedPerMinute < 0 || entry.maxAcceptedPerMinute > 100 ||
        ids.has(entry.id) || keys.has(entry.key))
      throw unavailable();
    ids.add(entry.id);
    keys.add(entry.key);
    tenants.push({ id: entry.id, key: entry.key,
      maxQueued: entry.maxQueued, maxRetained: entry.maxRetained,
      maxAcceptedPerMinute: entry.maxAcceptedPerMinute });
  }
  return tenants;
}

/** One file-descriptor per request: O_NOFOLLOW and owner-only metadata before
 * and after bounded read. No cache or fallback to any previous registry.
 */
export async function loadRunnerTenantsFile(filename) {
  if (typeof constants.O_NOFOLLOW !== "number") throw unavailable();
  let fd;
  try {
    fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await fd.stat();
    if (!isPrivateRunnerTenantsFile(before)) throw unavailable();
    const chunks = []; let total = 0;
    while (total <= MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(2048, MAX_BYTES + 1 - total));
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total !== before.size || total > MAX_BYTES) throw unavailable();
    const after = await fd.stat();
    if (!isPrivateRunnerTenantsFile(after) ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs)
      throw unavailable();
    return validateRunnerTenantRegistry(JSON.parse(Buffer.concat(chunks, total).toString("utf8")));
  } catch { throw unavailable(); }
  finally { await fd?.close().catch(() => {}); }
}

/** Inspect every candidate without early exit. Bearer keys are tenant-prefixed,
 * so a key for tenant A cannot be reassigned to tenant B in a new registry.
 * Never return or log the raw key after successful authentication.
 */
export function authenticateRunnerTenant(header, tenants) {
  let principal = null;
  for (const tenant of tenants) {
    if (authenticate(header, tenant.key)) {
      principal = { id: tenant.id, maxQueued: tenant.maxQueued,
        maxRetained: tenant.maxRetained,
        maxAcceptedPerMinute: tenant.maxAcceptedPerMinute };
    }
  }
  return principal;
}
