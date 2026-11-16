import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink, chmod, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { atomicWrite } from "../common.mjs";
import { startWorkerHeartbeat, readWorkerHeartbeat, readDockerExecutionReadiness,
  isPrivateWorkerHeartbeatFile } from "../heartbeat.mjs";

const key = "runner-heartbeat-integration-key-abcdefghijklmnopqrstuvwxyz";
const origin = "http://localhost:5173";

test("heartbeat is an owner-only regular single-inode file owned by effective UID", () => {
  const stat = { isFile: () => true, mode: 0o100600, nlink: 1, uid: 1000, size: 160 };
  assert.equal(isPrivateWorkerHeartbeatFile(stat, 1000), true);
  assert.equal(isPrivateWorkerHeartbeatFile(stat, 1001), false);
  assert.equal(isPrivateWorkerHeartbeatFile(stat, undefined), false);
  assert.equal(isPrivateWorkerHeartbeatFile({ ...stat, nlink: 2 }, 1000), false);
  assert.equal(isPrivateWorkerHeartbeatFile({ ...stat, mode: 0o100644 }, 1000), false);
  assert.equal(isPrivateWorkerHeartbeatFile({ ...stat, size: 1100 }, 1000), false);
  assert.equal(isPrivateWorkerHeartbeatFile({ ...stat, isFile: () => false }, 1000), false);
});

test("two APIs distinguish live HTTP liveness from authenticated worker readiness", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-worker-readiness-"));
  const file = path.join(dataDir, "worker-heartbeat.json");
  const servers = [0, 1].map(() => createRunnerServer({
    apiKey: key, allowedOrigins: [origin], dataDir,
    workerHeartbeatMaxAgeSeconds: 30,
  }));
  let heartbeat = null;
  try {
    for (const server of servers) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
    const request = (index, endpoint, authorized = true) =>
      fetch(urls[index] + endpoint, { headers: {
        Origin: origin, ...(authorized ? { Authorization: "Bearer " + key } : {}),
      } });
    for (let i = 0; i < 2; i++) {
      assert.equal((await request(i, "/healthz", false)).status, 200);
      assert.equal((await request(i, "/v1/readiness", false)).status, 401);
      assert.equal((await request(i, "/v1/execution-readiness", false)).status, 401);
      const noDocker = await request(i, "/v1/execution-readiness");
      assert.equal(noDocker.status, 503);
      assert.equal((await noDocker.json()).error, "docker_unavailable");
      const absent = await request(i, "/v1/readiness");
      assert.equal(absent.status, 503);
      assert.equal((await absent.json()).error, "worker_unavailable");
      assert.equal(absent.headers.get("retry-after"), "5");
      assert.equal((await request(i, "/v1/capabilities")).status, 200,
        "job API stays available while worker is offline");
    }
    heartbeat = await startWorkerHeartbeat({
      dataDir, intervalMs: 20, probeIntervalMs: 50,
      probeDocker: async () => false,
    });
    const first = await readWorkerHeartbeat(dataDir);
    assert.equal(first.version, 2);
    assert.ok(!JSON.stringify(first).includes(key), "no credential in readiness file");
    assert.ok(!JSON.stringify(first).includes("docker.sock"));
    assert.ok(!JSON.stringify(first).includes("pid"));
    for (let i = 0; i < 2; i++) {
      const ready = await request(i, "/v1/readiness");
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { status: "ready", worker: "responsive" });
      assert.equal(ready.headers.get("cache-control"), "no-store");
      assert.equal((await request(i, "/v1/execution-readiness")).status, 503,
        "worker liveness alone must not claim a rootless Docker daemon");
    }
    // A long awaited Docker operation must not suspend the independent timer.
    await sleep(130);
    const newer = await readWorkerHeartbeat(dataDir);
    assert.ok(Date.parse(newer.updatedAt) > Date.parse(first.updatedAt));
    assert.equal(newer.instanceId, first.instanceId);
    await heartbeat.stop();
    heartbeat = null;

    const old = new Date(Date.now() - 45_000).toISOString();
    await atomicWrite(file, { ...newer, startedAt: old, updatedAt: old });
    assert.equal((await request(1, "/v1/readiness")).status, 503,
      "stale worker heartbeat cannot falsely certify readiness");
    const future = new Date(Date.now() + 60_000).toISOString();
    await atomicWrite(file, { ...newer, updatedAt: future });
    assert.equal((await request(0, "/v1/readiness")).status, 503,
      "future timestamps and clock skew must fail closed");
    await writeFile(file, "{broken JSON", { mode: 0o600 });
    assert.equal((await request(1, "/v1/readiness")).status, 503);
    await atomicWrite(file, newer);
    await chmod(file, 0o644);
    assert.equal((await request(0, "/v1/readiness")).status, 503);
    await rm(file);
    await symlink(path.join(dataDir, "non-existing-target"), file);
    assert.equal((await request(1, "/v1/readiness")).status, 503);
    assert.equal((await request(0, "/healthz", false)).status, 200);
  } finally {
    if (heartbeat) await heartbeat.stop();
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("rootless daemon execution readiness is gated by a fresh probe on both API replicas", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-execution-readiness-"));
  const file = path.join(dataDir, "worker-heartbeat.json");
  let release = null;
  const blocked = new Promise(resolve => { release = resolve; });
  let mode = "blocked", calls = 0;
  const probeDocker = async () => {
    calls++;
    if (mode === "blocked") await blocked;
    return mode === "rootless";
  };
  const servers = [0, 1].map(() => createRunnerServer({
    apiKey: key, allowedOrigins: [origin], dataDir,
  }));
  let heartbeat = null;
  try {
    for (const server of servers) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
    const endpoints = servers.map(s => "http://127.0.0.1:" + s.address().port);
    const get = async (i, route) => fetch(endpoints[i] + route, {
      headers: { Origin: origin, Authorization: "Bearer " + key },
    });
    heartbeat = await startWorkerHeartbeat({
      dataDir, intervalMs: 20, probeIntervalMs: 60_000, probeDocker,
    });
    const start = await readWorkerHeartbeat(dataDir);
    assert.equal(start.docker.rootless, false);
    assert.equal(start.docker.checkedAt, null);
    assert.equal((await get(0, "/v1/execution-readiness")).status, 503);
    await sleep(90);
    const stillRunning = await readWorkerHeartbeat(dataDir);
    assert.ok(Date.parse(stillRunning.updatedAt) > Date.parse(start.updatedAt),
      "a blocked Docker probe must not suspend the heartbeat");
    assert.equal(calls, 1, "probe must not overlap itself");
    mode = "rootless";
    release();
    await heartbeat.checkDockerNow();
    for (let i = 0; i < 2; i++) {
      const ready = await get(i, "/v1/execution-readiness");
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { status: "ready", worker: "responsive", docker: "rootless" });
    }
    // The worker continues to replace its heartbeat atomically every 20ms.
    // Concurrent GETs must not compare a freshly renamed file to a clock
    // frozen BEFORE their asynchronous filesystem read (false HTTP 503).
    const beforeStress = await readWorkerHeartbeat(dataDir);
    for (let attempt = 0; attempt < 80; attempt++) {
      const ready = await get(attempt % 2, "/v1/execution-readiness");
      if (ready.status !== 200) {
        // Sanitized failure context only: no API keys, sockets or identifiers.
        let state = null, individuallyValid = false;
        try {
          const value = await readWorkerHeartbeat(dataDir);
          state = { rootless: value.docker?.rootless,
            heartbeatAgeMs: Date.now() - Date.parse(value.updatedAt),
            probeAgeMs: value.docker?.checkedAt === null ? null
              : Date.now() - Date.parse(value.docker.checkedAt) };
          individuallyValid = await readDockerExecutionReadiness(dataDir).then(
            () => true, () => false);
        } catch { state = { unreadable: true }; }
        assert.fail("positive daemon readiness had transient 503: " +
          JSON.stringify({ status: ready.status, state, individuallyValid }));
      }
      assert.equal(ready.status, 200);
      if (attempt % 8 === 0) await sleep(4);
    }
    const afterStress = await readWorkerHeartbeat(dataDir);
    assert.ok(Date.parse(afterStress.updatedAt) > Date.parse(beforeStress.updatedAt),
      "stress must overlap actual worker heartbeat updates");
    mode = "rootful";
    await heartbeat.checkDockerNow();
    for (let i = 0; i < 2; i++) {
      const denied = await get(i, "/v1/execution-readiness");
      assert.equal(denied.status, 503);
      assert.equal(denied.headers.get("retry-after"), "5");
      assert.equal((await denied.json()).error, "docker_unavailable");
      assert.equal((await get(i, "/v1/readiness")).status, 200);
    }
    mode = "rootless";
    await heartbeat.checkDockerNow();
    const current = await readWorkerHeartbeat(dataDir);
    assert.equal(current.docker.rootless, true);
    await heartbeat.stop();
    heartbeat = null;
    const past = new Date(Date.now() - 120_000).toISOString();
    const checked = new Date(Date.now() - 45_000).toISOString();
    await atomicWrite(file, { ...current, startedAt: past,
      updatedAt: new Date().toISOString(), docker: { rootless: true, checkedAt: checked } });
    await assert.rejects(readDockerExecutionReadiness(dataDir, 30_000),
      "a stale daemon probe must not be legitimized by a new heartbeat");
    assert.equal((await get(0, "/v1/execution-readiness")).status, 503);
    const v1 = { version: 1, instanceId: randomUUID(),
      startedAt: past, updatedAt: new Date().toISOString() };
    await atomicWrite(file, v1);
    assert.equal((await get(0, "/v1/readiness")).status, 200,
      "legacy heartbeat remains readable during rolling upgrades");
    assert.equal((await get(1, "/v1/execution-readiness")).status, 503,
      "legacy heartbeat can never attest Docker readiness");
    assert.ok(!JSON.stringify(current).includes(key), "never persist the job key");
    assert.ok(!JSON.stringify(current).includes("docker.sock"), "never persist socket locations");
  } finally {
    if (mode === "blocked") { mode = "rootful"; release(); }
    if (heartbeat) await heartbeat.stop();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("readiness age/config validation fails before serving and heartbeat parser is strict", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-heartbeat-canonical-"));
  try {
    for (const bad of [-1, 0, 9, 301, 1.5, NaN]) {
      assert.throws(() => createRunnerServer({ apiKey: key, allowedOrigins: [origin],
        dataDir, workerHeartbeatMaxAgeSeconds: bad }), /WORKER_HEARTBEAT_MAX_AGE_SECONDS/);
    }
    const now = new Date().toISOString();
    const good = { version: 1, instanceId: randomUUID(), startedAt: now, updatedAt: now };
    const file = path.join(dataDir, "worker-heartbeat.json");
    await atomicWrite(file, good);
    assert.equal((await readWorkerHeartbeat(dataDir)).version, 1);
    const current = { version: 2, instanceId: randomUUID(), startedAt: now,
      updatedAt: now, docker: { rootless: false, checkedAt: null } };
    await atomicWrite(file, current);
    assert.equal((await readWorkerHeartbeat(dataDir)).version, 2);
    for (const invalid of [
      { ...current, docker: { rootless: true, checkedAt: null } },
      { ...current, docker: { rootless: "true", checkedAt: now } },
      { ...current, docker: { rootless: true, checkedAt: new Date(Date.now() + 60_000).toISOString() } },
      { ...current, docker: { rootless: true, checkedAt: "bad-time" } },
      { ...current, docker: { rootless: false, checkedAt: now, socket: "must-not-appear" } },
    ]) {
      await atomicWrite(file, invalid);
      await assert.rejects(readWorkerHeartbeat(dataDir));
    }
    for (const value of [
      { ...good, instanceId: "not-a-uuid" },
      { ...good, version: 2 },
      { ...good, extra: "sensitive" },
      { ...good, updatedAt: "2026-11-16T02:00:00Z" },
      { ...good, startedAt: "2026-13-16T02:00:00.000Z" },
    ]) {
      await atomicWrite(file, value);
      await assert.rejects(readWorkerHeartbeat(dataDir));
    }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
