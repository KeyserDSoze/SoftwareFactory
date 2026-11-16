/** Minimal worker liveness signal on the shared runner volume.
 * Not a check of Docker rootless mode, command execution, or remote attestation.
 * Never place credentials, Docker paths, job inputs or host PIDs in this file.
 */
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./common.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const FILE = "worker-heartbeat.json";
const stale = () => new Error("Worker heartbeat unavailable");
export const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 5000;

export function isPrivateWorkerHeartbeatFile(stat, effectiveUid = process.geteuid?.()) {
  return Number.isSafeInteger(effectiveUid) && effectiveUid >= 0 &&
    stat.isFile() && stat.uid === effectiveUid && stat.nlink === 1 &&
    (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= 1024;
}
function parseTime(value) {
  if (typeof value !== "string" || !ISO.test(value)) throw stale();
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) throw stale();
  return millis;
}

/** This validates an already-open inode (O_NOFOLLOW + fstat), not a path
 * checked before opening. The current worker and API must share mapped UID.
 */
export async function readWorkerHeartbeat(dataDir, maxAgeMs = 30_000, nowMs = undefined) {
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 10_000 || maxAgeMs > 300_000)
    throw stale();
  const fd = await open(path.join(dataDir, FILE),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await fd.stat();
    if (!isPrivateWorkerHeartbeatFile(info)) throw stale();
    const raw = await fd.readFile("utf8");
    if (Buffer.byteLength(raw, "utf8") > 1024) throw stale();
    let value;
    try { value = JSON.parse(raw); } catch { throw stale(); }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "instanceId,startedAt,updatedAt,version" ||
        value.version !== 1 || !UUID.test(value.instanceId)) throw stale();
    const started = parseTime(value.startedAt), updated = parseTime(value.updatedAt);
    const now = nowMs ?? Date.now();
    if (!Number.isFinite(now) || started > updated ||
        updated > now || now - updated > maxAgeMs) throw stale();
    return value;
  } finally {
    await fd.close();
  }
}

/** Single non-overlapping timer independent of runWorker's long Docker await.
 * A write failure is observable as eventual 503 readiness, not a forged ready.
 * One worker is expected per volume; stale heartbeats expire after process exit.
 */
export async function startWorkerHeartbeat({
  dataDir, intervalMs = DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
  onError = () => console.error("Runner worker heartbeat update failed"),
} = {}) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir) ||
      !Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000)
    throw new Error("Invalid worker heartbeat configuration");
  const startedAt = new Date().toISOString(), instanceId = randomUUID();
  let pending = null;
  const tick = () => {
    if (pending) return pending;
    const task = atomicWrite(path.join(dataDir, FILE), {
      version: 1, instanceId, startedAt, updatedAt: new Date().toISOString(),
    });
    pending = task;
    void task.finally(() => { if (pending === task) pending = null; }).catch(() => {});
    return task;
  };
  await tick();
  const timer = setInterval(() => { void tick().catch(onError); }, intervalMs);
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      if (pending) await pending;
    },
  };
}
