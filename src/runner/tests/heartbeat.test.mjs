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
import { startWorkerHeartbeat, readWorkerHeartbeat,
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
      const absent = await request(i, "/v1/readiness");
      assert.equal(absent.status, 503);
      assert.equal((await absent.json()).error, "worker_unavailable");
      assert.equal(absent.headers.get("retry-after"), "5");
      assert.equal((await request(i, "/v1/capabilities")).status, 200,
        "job API stays available while worker is offline");
    }
    heartbeat = await startWorkerHeartbeat({ dataDir, intervalMs: 20 });
    const first = await readWorkerHeartbeat(dataDir);
    assert.equal(first.version, 1);
    assert.ok(!JSON.stringify(first).includes(key), "no credential in readiness file");
    assert.ok(!JSON.stringify(first).includes("docker.sock"));
    assert.ok(!JSON.stringify(first).includes("pid"));
    for (let i = 0; i < 2; i++) {
      const ready = await request(i, "/v1/readiness");
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { status: "ready", worker: "responsive" });
      assert.equal(ready.headers.get("cache-control"), "no-store");
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
