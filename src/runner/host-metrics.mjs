/**
 * Aggregate host-visible resource snapshot published by the worker, never the API.
 * Values are informational, not host attestation, power measurements or per-job isolation.
 * No hostnames, PID/process lists, paths, network details or secrets leave the worker.
 */
import os from "node:os";
import path from "node:path";
import { readdir, readFile, statfs, open } from "node:fs/promises";
import { constants } from "node:fs";
import { atomicWrite } from "./common.mjs";

const FILE = "worker-metrics.json";
const MAX_SIZE = 2048;
const bad = () => new Error("Host resource snapshot unavailable");
const inRange = (n, lo, hi) => typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
const readCpu = cpus => cpus.map(core => {
  const t = core.times;
  return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
}).reduce((a, x) => ({ idle: a.idle + x.idle, total: a.total + x.total }), { idle: 0, total: 0 });

export function cpuUsagePercent(previous, current) {
  if (!previous || !current) return null;
  const delta = current.total - previous.total, idle = current.idle - previous.idle;
  if (!Number.isFinite(delta) || delta <= 0 || !Number.isFinite(idle) || idle < 0 || idle > delta) return null;
  return Math.round(Math.max(0, Math.min(100, (1 - idle / delta) * 100)) * 10) / 10;
}
async function temperatureSensor(root = "/sys/class/thermal") {
  try {
    const entries = (await readdir(root)).filter(v => /^thermal_zone[0-9]{1,3}$/.test(v)).slice(0, 32);
    for (const entry of entries) {
      try {
        // A thermal zone can also be a battery, motherboard or WLAN sensor.
        // Only present a value as CPU temperature if the kernel labels it so.
        const type = (await readFile(path.join(root, entry, "type"), "utf8")).trim();
        if (!/cpu|x86_pkg_temp|coretemp|soc_thermal/i.test(type)) continue;
        const raw = (await readFile(path.join(root, entry, "temp"), "utf8")).trim();
        if (!/^-?[0-9]{1,7}$/.test(raw)) continue;
        const temp = Number(raw) / 1000;
        if (inRange(temp, 0, 125)) return Math.round(temp * 10) / 10;
      } catch { /* Optional sensor hidden or unavailable in sandbox */ }
    }
  } catch { /* Optional platform sysfs */ }
  return null;
}
export async function collectWorkerMetrics({ dataDir, previousCpu = null,
  cpus = os.cpus, totalmem = os.totalmem, freemem = os.freemem, uptime = os.uptime,
  statfsFn = statfs, sensor = temperatureSensor, now = () => new Date().toISOString() } = {}) {
  const currentCpu = readCpu(cpus());
  const memoryTotalBytes = totalmem(), memoryFreeBytes = freemem();
  if (!Number.isSafeInteger(memoryTotalBytes) || memoryTotalBytes <= 0 ||
      !Number.isSafeInteger(memoryFreeBytes) || memoryFreeBytes < 0 ||
      memoryFreeBytes > memoryTotalBytes)
    throw bad();
  let diskTotalBytes = null, diskUsedBytes = null;
  try {
    const s = await statfsFn(dataDir, { bigint: true });
    const total = s.blocks * s.bsize, used = (s.blocks - s.bfree) * s.bsize;
    if (total >= 0n && used >= 0n && used <= total &&
        total <= BigInt(Number.MAX_SAFE_INTEGER)) {
      diskTotalBytes = Number(total);
      diskUsedBytes = Number(used);
    }
  } catch { /* Disk metrics might not be supported in a container. */ }
  let cpuTemperatureC = null;
  try { cpuTemperatureC = await sensor(); } catch { /* Optional sensor */ }
  if (!inRange(cpuTemperatureC, 0, 125)) cpuTemperatureC = null;
  const seconds = uptime();
  return {
    cpuState: currentCpu,
    snapshot: {
      version: 1, measuredAt: now(),
      cpuPercent: cpuUsagePercent(previousCpu, currentCpu),
      memoryUsedBytes: memoryTotalBytes - memoryFreeBytes, memoryTotalBytes,
      diskUsedBytes, diskTotalBytes, uptimeSeconds: Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null,
      cpuTemperatureC,
    },
  };
}
export function validateWorkerMetrics(value, maxAgeMs = 30000, nowMs = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [
        "cpuPercent", "cpuTemperatureC", "diskTotalBytes", "diskUsedBytes",
        "measuredAt", "memoryTotalBytes", "memoryUsedBytes", "uptimeSeconds", "version",
      ].sort().join(",") || value.version !== 1)
    throw bad();
  const date = Date.parse(value.measuredAt);
  if (typeof value.measuredAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.measuredAt) ||
      !Number.isFinite(date) || new Date(date).toISOString() !== value.measuredAt ||
      date > nowMs || nowMs - date > maxAgeMs) throw bad();
  if (value.cpuPercent !== null && !inRange(value.cpuPercent, 0, 100)) throw bad();
  if (!inRange(value.memoryTotalBytes, 1, Number.MAX_SAFE_INTEGER) ||
      !inRange(value.memoryUsedBytes, 0, value.memoryTotalBytes)) throw bad();
  if (value.diskTotalBytes === null ? value.diskUsedBytes !== null :
      !inRange(value.diskTotalBytes, 0, Number.MAX_SAFE_INTEGER) ||
      !inRange(value.diskUsedBytes, 0, value.diskTotalBytes)) throw bad();
  if (value.uptimeSeconds !== null && !inRange(value.uptimeSeconds, 0, Number.MAX_SAFE_INTEGER)) throw bad();
  if (value.cpuTemperatureC !== null && !inRange(value.cpuTemperatureC, 0, 125)) throw bad();
  return value;
}
export async function readWorkerMetrics(dataDir, maxAgeMs = 30000) {
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 10000 || maxAgeMs > 300000) throw bad();
  const file = path.join(dataDir, FILE);
  // Do not follow hostile symlinks or accept hardlinks/partial writes.
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const s = await fd.stat();
    if (!s.isFile() || s.uid !== process.geteuid?.() || s.nlink !== 1 ||
        (s.mode & 0o077) !== 0 || s.size <= 0 || s.size > MAX_SIZE) throw bad();
    const raw = await fd.readFile("utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_SIZE) throw bad();
    return validateWorkerMetrics(JSON.parse(raw), maxAgeMs);
  } finally { await fd.close(); }
}
export async function startWorkerMetrics({ dataDir, intervalMs = 5000,
  collect = collectWorkerMetrics, write = atomicWrite, onError = () => {} } = {}) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir) ||
      !Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 60000)
    throw bad();
  let lastCpu = null, pending = null, stopped = false;
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    const task = (async () => {
      const { cpuState, snapshot } = await collect({ dataDir, previousCpu: lastCpu });
      if (stopped) return;
      lastCpu = cpuState;
      await write(path.join(dataDir, FILE), snapshot);
    })();
    pending = task;
    void task.finally(() => { if (pending === task) pending = null; }).catch(() => {});
    return task;
  };
  await tick();
  const timer = setInterval(() => { void tick().catch(onError); }, intervalMs);
  timer.unref?.();
  return { tick, async stop() {
    stopped = true; clearInterval(timer);
    if (pending) await pending.catch(() => {});
  } };
}
