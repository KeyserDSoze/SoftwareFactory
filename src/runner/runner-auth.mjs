/** Optional owner-only, hot-rotatable job API secret. Never mount in the worker. */
import { open } from "node:fs/promises";
import { constants } from "node:fs";

const MAX_BYTES = 257;
const unavailable = () => Object.assign(new Error("runner_auth_unavailable"),
  { code: "RUNNER_AUTH_UNAVAILABLE" });

export function isPrivateRunnerApiKeyFile(stat, effectiveUid = process.geteuid?.()) {
  return Number.isSafeInteger(effectiveUid) && effectiveUid >= 0 &&
    stat?.isFile?.() === true && stat.uid === effectiveUid &&
    stat.nlink === 1 && (stat.mode & 0o077) === 0 &&
    Number.isSafeInteger(stat.size) && stat.size >= 32 && stat.size <= MAX_BYTES;
}

/** Open a NEW inode per request. Single FD for metadata and bounded contents;
 * never cache a prior credential when file was replaced or made insecure.
 */
export async function loadRunnerApiKeyFile(filename) {
  if (typeof constants.O_NOFOLLOW !== "number") throw unavailable();
  let fd;
  try {
    fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await fd.stat();
    if (!isPrivateRunnerApiKeyFile(before)) throw unavailable();
    const chunks = [];
    let total = 0;
    while (total <= MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(128, MAX_BYTES + 1 - total));
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total !== before.size || total > MAX_BYTES) throw unavailable();
    const after = await fd.stat();
    if (!isPrivateRunnerApiKeyFile(after) ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs)
      throw unavailable();
    const value = Buffer.concat(chunks, total).toString("utf8");
    // openssl rand -hex 32 > file ends with one LF. Do not trim controls.
    if (!/^[\x21-\x7e]{32,256}\n?$/.test(value)) throw unavailable();
    return value.endsWith("\n") ? value.slice(0, -1) : value;
  } catch { throw unavailable(); }
  finally { await fd?.close().catch(() => {}); }
}
