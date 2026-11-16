/** The immutable job source snapshot must be read from a verified inode, not a path. */
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { jobDirectory } from "./common.mjs";

// JSON escaping can expand the normalized 1.1MB source payload considerably.
export const MAX_RUNNER_INPUT_BYTES = 8_000_000;
const invalid = () => Object.assign(new Error("runner_input_invalid"),
  { code: "RUNNER_INPUT_INVALID" });

export function isTrustedRunnerInputFile(stat, effectiveUid = process.geteuid?.()) {
  return Number.isSafeInteger(effectiveUid) && effectiveUid >= 0 &&
    stat?.isFile?.() === true && stat.uid === effectiveUid &&
    stat.nlink === 1 && (stat.mode & 0o022) === 0 &&
    Number.isSafeInteger(stat.size) && stat.size > 0 &&
    stat.size <= MAX_RUNNER_INPUT_BYTES;
}

export function isStableRunnerInputSnapshot(before, after) {
  return isTrustedRunnerInputFile(before) && isTrustedRunnerInputFile(after) &&
    before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mode === after.mode &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** Fail closed for symlink, hardlink, unlinked/replaced inode, bad owner or
 * permissions, mutation during reading, and oversized/malformed input. Never
 * include the source or host file path in an error returned to the poller.
 */
export async function readRunnerInput(dataDir, id) {
  if (typeof constants.O_NOFOLLOW !== "number") throw invalid();
  let fd;
  try {
    fd = await open(path.join(jobDirectory(dataDir, id), "input.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await fd.stat();
    if (!isTrustedRunnerInputFile(before)) throw invalid();
    const chunks = [];
    let total = 0;
    while (total < before.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, before.size - total));
      const { bytesRead } = await fd.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) throw invalid();
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await fd.stat();
    if (!isStableRunnerInputSnapshot(before, after)) throw invalid();
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw invalid();
  } finally {
    await fd?.close().catch(() => {});
  }
}
