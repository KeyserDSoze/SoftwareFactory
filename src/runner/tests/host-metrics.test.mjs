import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createRunnerServer } from "../api.mjs";
import { atomicWrite } from "../common.mjs";
import { cpuUsagePercent, collectWorkerMetrics, validateWorkerMetrics, readWorkerMetrics,
  startWorkerMetrics } from "../host-metrics.mjs";

const key = "0123456789abcdef".repeat(3), origin = "https://keyserdsoze.github.io";
const stamp = () => new Date().toISOString();
const snapshot = () => ({
  version: 1, measuredAt: stamp(), cpuPercent: 25.5,
  memoryUsedBytes: 300, memoryTotalBytes: 500,
  diskUsedBytes: null, diskTotalBytes: null, uptimeSeconds: 900, cpuTemperatureC: null,
});
test("real CPU time deltas, not fake 100% defaults", () => {
  assert.equal(cpuUsagePercent(null, { idle: 1, total: 2 }), null);
  assert.equal(cpuUsagePercent({ idle: 100, total: 200 }, { idle: 130, total: 300 }), 70);
  assert.equal(cpuUsagePercent({ idle: 1, total: 2 }, { idle: 1, total: 2 }), null);
});
test("sampler uses bounded aggregate host-visible values; missing sensors are null", async () => {
  const cpu = [{ times: { user: 100, nice: 0, sys: 20, idle: 80, irq: 0 } }];
  const first = await collectWorkerMetrics({
    dataDir: "/tmp", cpus: () => cpu, totalmem: () => 1000,
    freemem: () => 250, uptime: () => 123.4, sensor: async () => undefined,
    statfsFn: async () => { throw Error("unavailable"); },
  });
  assert.equal(first.snapshot.cpuPercent, null);
  assert.equal(first.snapshot.memoryUsedBytes, 750);
  assert.equal(first.snapshot.uptimeSeconds, 123);
  assert.equal(first.snapshot.diskTotalBytes, null);
  assert.equal(first.snapshot.cpuTemperatureC, null);
  assert.deepEqual(Object.keys(first.snapshot).sort(), Object.keys(snapshot()).sort());
});
test("schema validation rejects unknown fields, stale/future timestamps, garbage and impossible values", () => {
  const valid = snapshot();
  assert.deepEqual(validateWorkerMetrics(valid), valid);
  for (const value of [
    { ...snapshot(), authToken: "secret" },
    { ...snapshot(), cpuPercent: 180 },
    { ...snapshot(), memoryUsedBytes: 600 },
    { ...snapshot(), diskUsedBytes: 12, diskTotalBytes: null },
    { ...snapshot(), cpuTemperatureC: -1 },
    { ...snapshot(), measuredAt: new Date(Date.now() - 90_000).toISOString() },
    { ...snapshot(), measuredAt: new Date(Date.now() + 1000).toISOString() },
    { ...snapshot(), measuredAt: "bad" },
  ]) assert.throws(() => validateWorkerMetrics(value));
});
test("owner-only worker file: read returns snapshot; missing, symlink, oversized fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sf-host-resource-"));
  try {
    const file = join(dir, "worker-metrics.json");
    await assert.rejects(readWorkerMetrics(dir));
    await atomicWrite(file, snapshot());
    assert.equal((await readWorkerMetrics(dir)).memoryUsedBytes, 300);
    await rm(file);
    await symlink("/etc/hosts", file);
    await assert.rejects(readWorkerMetrics(dir));
    await rm(file);
    await writeFile(file, JSON.stringify({ ...snapshot(), host: "redacted" }).repeat(100));
    await assert.rejects(readWorkerMetrics(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("worker sampler publishes periodically and stops; never includes credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sf-worker-metrics-"));
  let calls = 0, service;
  try {
    service = await startWorkerMetrics({ dataDir: dir, intervalMs: 50, collect: async () => ({
      cpuState: { total: ++calls, idle: 0 }, snapshot: snapshot(),
    }) });
    await service.tick();
    const read = await readWorkerMetrics(dir);
    assert.equal(read.memoryTotalBytes, 500);
    assert.equal(JSON.stringify(read).includes(key), false);
  } finally {
    await service?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("authenticated API returns telemetry without revealing it to unauthenticated or wrong origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sf-metrics-api-"));
  const server = createRunnerServer({ apiKey: key, allowedOrigins: [origin], dataDir: dir });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = "http://127.0.0.1:" + server.address().port + "/v1/host-metrics";
    const get = (k, o = origin) => fetch(url, { headers: { Origin: o, ...(k ? { Authorization: "Bearer " + k } : {}) } });
    assert.equal((await get()).status, 401);
    assert.equal((await get(key, "https://evil.example")).status, 403);
    assert.equal((await get(key)).status, 503);
    await atomicWrite(join(dir, "worker-metrics.json"), snapshot());
    const response = await get(key);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal((await response.json()).memoryUsedBytes, 300);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
