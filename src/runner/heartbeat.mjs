/** Minimal worker liveness signal on the shared runner volume.
 * Not a check of Docker rootless mode, command execution, or remote attestation.
 * Never place credentials, Docker paths, job inputs or host PIDs in this file.
 */
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./common.mjs";
import { probeRootlessDocker } from "./docker-probe.mjs";

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
        ![1, 2].includes(value.version) || !UUID.test(value.instanceId)) throw stale();
    // Version 1 remains readable for rolling upgrades and worker-only
    // readiness; it cannot ever assert Docker execution readiness.
    const expected = value.version === 1
      ? "instanceId,startedAt,updatedAt,version"
      : "docker,instanceId,startedAt,updatedAt,version";
    if (Object.keys(value).sort().join(",") !== expected) throw stale();
    const started = parseTime(value.startedAt), updated = parseTime(value.updatedAt);
    const now = nowMs ?? Date.now();
    if (!Number.isFinite(now) || started > updated ||
        updated > now || now - updated > maxAgeMs) throw stale();
    if (value.version === 2) {
      const docker = value.docker;
      if (!docker || typeof docker !== "object" || Array.isArray(docker) ||
          Object.keys(docker).sort().join(",") !== "checkedAt,rootless" ||
          typeof docker.rootless !== "boolean" ||
          (docker.checkedAt === null && docker.rootless !== false))
        throw stale();
      if (docker.checkedAt !== null) {
        const probed = parseTime(docker.checkedAt);
        if (probed < started || probed > updated || probed > now)
          throw stale();
      }
    }
    return value;
  } finally {
    await fd.close();
  }
}

/** Worker responsiveness is not Docker readiness. For execution readiness
 * both the worker heartbeat and the latest successful rootless daemon probe
 * must be fresh. Version 1 remains worker-only, never Docker-ready.
 */
export async function readDockerExecutionReadiness(dataDir, maxAgeMs = 30_000, nowMs = undefined) {
  // Do not freeze the wall clock before the asynchronous file read. A worker
  // may atomically publish a newer heartbeat while this GET is in progress;
  // comparing it to a pre-I/O timestamp would falsely reject it as "future".
  // Explicit injected clocks remain fixed for deterministic negative tests.
  const record = await readWorkerHeartbeat(dataDir, maxAgeMs, nowMs);
  const now = nowMs ?? Date.now();
  if (record.version !== 2 || record.docker.rootless !== true ||
      record.docker.checkedAt === null ||
      now - parseTime(record.docker.checkedAt) > maxAgeMs)
    throw stale();
  return true;
}

/** Two non-overlapping timers independent of runWorker's long Docker await.
 * A write or probe failure eventually causes 503, not a forged ready.
 * One worker is expected per volume; stale heartbeats expire after process exit.
 */
export async function startWorkerHeartbeat({
  dataDir, intervalMs = DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
  probeIntervalMs = 10_000, probeDocker = probeRootlessDocker,
  onError = () => console.error("Runner worker heartbeat update failed"),
} = {}) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir) ||
      !Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000 ||
      !Number.isInteger(probeIntervalMs) || probeIntervalMs < 10 ||
      probeIntervalMs > 60_000 || typeof probeDocker !== "function")
    throw new Error("Invalid worker heartbeat configuration");
  const startedAt = new Date().toISOString(), instanceId = randomUUID();
  let pending = null, probing = null, closed = false;
  let docker = { rootless: false, checkedAt: null };
  const tick = () => {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    const task = atomicWrite(path.join(dataDir, FILE), {
      version: 2, instanceId, startedAt, updatedAt: new Date().toISOString(),
      docker,
    });
    pending = task;
    void task.finally(() => { if (pending === task) pending = null; }).catch(() => {});
    return task;
  };
  const checkDockerNow = () => {
    if (closed) return Promise.resolve();
    if (probing) return probing;
    const task = (async () => {
      let rootless = false;
      try { rootless = (await probeDocker()) === true; }
      catch { /* No daemon error content is safe to log or persist. */ }
      if (closed) return;
      docker = { rootless, checkedAt: new Date().toISOString() };
      // Do not race an outstanding heartbeat rename with a newer probe result.
      if (pending) await pending;
      if (!closed) await tick();
    })();
    probing = task;
    void task.finally(() => { if (probing === task) probing = null; }).catch(() => {});
    return task;
  };
  await tick();
  // Probing is asynchronous; a slow daemon must not block worker startup,
  // the polling loop or the independent 5-second Node heartbeat timer.
  void checkDockerNow().catch(onError);
  const timer = setInterval(() => { void tick().catch(onError); }, intervalMs);
  const probeTimer = setInterval(() => { void checkDockerNow().catch(onError); }, probeIntervalMs);
  timer.unref?.();
  probeTimer.unref?.();
  return {
    checkDockerNow,
    async stop() {
      closed = true;
      clearInterval(timer);
      clearInterval(probeTimer);
      if (probing) await probing.catch(() => {});
      if (pending) await pending;
    },
  };
}
