import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { withAdmissionLock } from "../admission.mjs";
import { loadRunnerTenantsFile, isPrivateRunnerTenantsFile,
  authenticateRunnerTenant } from "../tenants.mjs";
import { verifyEvidenceExport, verifyJobEvidence } from "../evidence.mjs";

const origin = "http://localhost:5173";
const alphaKey = "alpha." + "A".repeat(40);
const alphaNew = "alpha." + "N".repeat(40);
const bravoKey = "bravo." + "B".repeat(40);
const job = () => ({ label: "Tenant job", files: {
  "src/backend/domain/Item.cs": "namespace Demo; public record Item(int Value);",
  "src/backend/applications/Api/Api.csproj": "<Project></Project>",
}, steps: ["dotnet-build"] });
const tenant = (id, key, maxQueued = 2, maxRetained = 5, maxAcceptedPerMinute = 0) =>
  ({ id, key, maxQueued, maxRetained, maxAcceptedPerMinute });
const registry = (alpha = tenant("alpha", alphaKey),
  bravo = tenant("bravo", bravoKey)) => ({ version: 1, tenants: [alpha, bravo] });

async function replace(file, body) {
  const temp = file + ".new";
  await writeFile(temp, typeof body === "string" ? body : JSON.stringify(body),
    { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}
async function fixture(initial = registry()) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-tenants-"));
  const dataDir = path.join(root, "data"), dir = path.join(root, "secret");
  await mkdir(dataDir); await mkdir(dir, { mode: 0o700 });
  const file = path.join(dir, "tenants.json");
  await writeFile(file, JSON.stringify(initial), { mode: 0o600 });
  const servers = Array.from({ length: 2 }, () => createRunnerServer({
    apiKey: "", apiKeyFile: "", tenantsFile: file,
    allowedOrigins: [origin], dataDir, maxQueued: 6, maxRetained: 20,
  }));
  for (const server of servers) {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
  }
  const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
  const request = async (i, key, pathname = "/v1/capabilities",
    body = undefined, idempotencyKey = undefined) => {
    const response = await fetch(urls[i] + pathname, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, Authorization: "Bearer " + key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, retry: response.headers.get("Retry-After"),
      body: await response.json() };
  };
  return { root, dataDir, file, urls, request,
    close: async () => {
      await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
      await rm(root, { recursive: true, force: true });
    } };
}

test("tenant registry enforces safe inode, stable UTF8 JSON, unique prefixed keys and quotas", async () => {
  const f = await fixture();
  try {
    const s = await stat(f.file);
    assert.equal(isPrivateRunnerTenantsFile(s, s.uid), true);
    assert.equal(isPrivateRunnerTenantsFile(s, s.uid + 1), false);
    assert.equal(isPrivateRunnerTenantsFile({ ...s, isFile: () => true, nlink: 2 }), false);
    const loaded = await loadRunnerTenantsFile(f.file);
    assert.equal(loaded.length, 2);
    assert.equal(authenticateRunnerTenant("Bearer " + alphaKey, loaded).id, "alpha");
    assert.equal(authenticateRunnerTenant("Bearer " + bravoKey, loaded).id, "bravo");
    assert.equal(authenticateRunnerTenant("Bearer " + alphaNew, loaded), null);
    const bad = [
      { version: 1, tenants: [tenant("alpha", bravoKey)] },
      { version: 1, tenants: [tenant("alpha", alphaKey),
        tenant("alpha", alphaNew)] },
      { version: 1, tenants: [tenant("alpha", alphaKey, 0)] },
      { version: 1, tenants: [tenant("alpha", alphaKey, 2, 1)] },
      { version: 1, tenants: [tenant("alpha", alphaKey, 2, 5, 101)] },
      { version: 1, tenants: [tenant("alpha", alphaKey), {
        ...tenant("bravo", bravoKey), unexpected: true }] },
      { version: 2, tenants: [tenant("alpha", alphaKey)] },
      { version: 1, tenants: [] },
      "x".repeat(16_385),
    ];
    for (const invalid of bad) {
      await replace(f.file, invalid);
      await assert.rejects(loadRunnerTenantsFile(f.file),
        { code: "TENANT_AUTH_UNAVAILABLE" });
    }
    await replace(f.file, registry());
    const hard = f.file + ".hard";
    await link(f.file, hard);
    await assert.rejects(loadRunnerTenantsFile(f.file),
      { code: "TENANT_AUTH_UNAVAILABLE" });
    await rm(hard);
    const moved = f.file + ".saved";
    await rename(f.file, moved); await symlink(moved, f.file);
    await assert.rejects(loadRunnerTenantsFile(f.file),
      { code: "TENANT_AUTH_UNAVAILABLE" });
    await rm(f.file); await rename(moved, f.file);
    await chmod(f.file, 0o644);
    await assert.rejects(loadRunnerTenantsFile(f.file),
      { code: "TENANT_AUTH_UNAVAILABLE" });
    await chmod(f.file, 0o600);
    assert.equal((await loadRunnerTenantsFile(f.file)).length, 2);
  } finally { await f.close(); }
});

test("tenant clients cannot read foreign reports or evidence and idempotency is tenant-bound", async () => {
  const f = await fixture(registry(tenant("alpha", alphaKey, 1), tenant("bravo", bravoKey, 1)));
  try {
    const shared = randomUUID();
    const a = await f.request(0, alphaKey, "/v1/jobs", { ...job(), tenantId: "bravo" }, shared);
    assert.equal(a.status, 202);
    const tooManyA = await f.request(1, alphaKey, "/v1/jobs", job(), randomUUID());
    assert.equal(tooManyA.status, 429);
    assert.deepEqual(tooManyA.body, { error: "queue_full" });
    const b = await f.request(1, bravoKey, "/v1/jobs", job(), shared);
    assert.equal(b.status, 202, "alpha's quota and idempotency key cannot block bravo");
    assert.notEqual(a.body.id, b.body.id);
    const aReplay = await f.request(1, alphaKey, "/v1/jobs", job(), shared);
    assert.equal(aReplay.status, 202);
    assert.deepEqual(aReplay.body, a.body);
    for (const [key, owned, foreign] of [
      [alphaKey, a.body.id, b.body.id],
      [bravoKey, b.body.id, a.body.id],
    ]) {
      const local = await f.request(0, key, "/v1/jobs/" + owned);
      assert.equal(local.status, 200);
      assert.equal(local.body.tenantId, key.split(".")[0]);
      const evidence = await f.request(1, key, "/v1/jobs/" + owned + "/evidence");
      assert.equal(evidence.status, 200);
      assert.equal(verifyEvidenceExport(evidence.body).report.tenantId, key.split(".")[0]);
      assert.equal((await f.request(0, key, "/v1/jobs/" + foreign)).status, 404);
      assert.equal((await f.request(1, key, "/v1/jobs/" + foreign + "/evidence")).status, 404);
    }
    assert.equal((await verifyJobEvidence(f.dataDir, a.body.id)).report.tenantId, "alpha");
    assert.equal((await verifyJobEvidence(f.dataDir, b.body.id)).report.tenantId, "bravo");
    assert.equal((await f.request(0, "not-valid-key", "/v1/jobs/" + a.body.id)).status, 401);
    assert.equal((await f.request(0, alphaKey, "/v1/repair-sessions")).status, 404);
  } finally { await f.close(); }
});

test("per-tenant rolling minute limit is independent and live quotas apply after rotation", async () => {
  const f = await fixture(registry(tenant("alpha", alphaKey, 3, 5, 1),
    tenant("bravo", bravoKey, 3, 5, 1)));
  try {
    const first = await f.request(0, alphaKey, "/v1/jobs", job(), randomUUID());
    assert.equal(first.status, 202);
    const blocked = await f.request(1, alphaKey, "/v1/jobs", job(), randomUUID());
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, { error: "rate_limited" });
    assert.ok(Number(blocked.retry) >= 1);
    const other = await f.request(0, bravoKey, "/v1/jobs", job(), randomUUID());
    assert.equal(other.status, 202);
    await replace(f.file, registry(tenant("alpha", alphaNew, 1, 5, 0),
      tenant("bravo", bravoKey, 3, 5, 1)));
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.request(i, alphaKey)).status, 401);
      assert.equal((await f.request(i, alphaNew)).status, 200);
      assert.equal((await f.request(i, alphaNew, "/v1/jobs/" + first.body.id)).status, 200);
      assert.equal((await f.request(i, bravoKey)).status, 200);
    }
    const afterLowered = await f.request(0, alphaNew, "/v1/jobs", job(), randomUUID());
    assert.equal(afterLowered.status, 429);
    assert.deepEqual(afterLowered.body, { error: "queue_full" });
    await chmod(f.file, 0o666);
    for (let i = 0; i < 2; i++) {
      const down = await f.request(i, bravoKey);
      assert.equal(down.status, 503);
      assert.deepEqual(down.body, { error: "tenant_auth_unavailable" });
    }
    await rm(f.file);
    assert.equal((await f.request(1, alphaNew)).status, 503);
    assert.equal((await fetch(f.urls[0] + "/healthz")).status, 200);
  } finally { await f.close(); }
});

test("revocation while tenant job waits for shared admission lock fails without allocation", async () => {
  const f = await fixture();
  try {
    let unlock, entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    const release = new Promise(resolve => { unlock = resolve; });
    const locked = withAdmissionLock(f.dataDir, async () => {
      entered(); await release;
    }, 2000);
    await enteredPromise;
    const pending = f.request(0, alphaKey, "/v1/jobs", job(), randomUUID());
    await new Promise(resolve => setTimeout(resolve, 125));
    await replace(f.file, registry(tenant("alpha", alphaNew),
      tenant("bravo", bravoKey)));
    unlock(); await locked;
    const denied = await pending;
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.body, { error: "unauthorized" });
    assert.equal((await readdir(path.join(f.dataDir, "jobs")))
      .filter(name => !name.startsWith(".")).length, 0);
    assert.equal((await f.request(1, alphaNew, "/v1/jobs", job())).status, 202);
  } finally { await f.close(); }
});

test("legacy runner key mode remains usable; mixed tenant and repair credentials are rejected", async () => {
  const f = await fixture();
  try {
    const cfg = { dataDir: f.dataDir, allowedOrigins: [origin], tenantsFile: f.file };
    assert.throws(() => createRunnerServer({ ...cfg, apiKey: alphaKey }),
      /only one runner authentication source/i);
    assert.throws(() => createRunnerServer({ ...cfg, apiKey: "", apiKeyFile: f.file }),
      /only one runner authentication source/i);
    assert.throws(() => createRunnerServer({ ...cfg, apiKey: "",
      repairOperatorsFile: "/tmp/operators.json" }), /forbids repair operator/i);
    assert.throws(() => createRunnerServer({ ...cfg, apiKey: "",
      tenantsFile: "./tenants.json" }), /absolute path/i);
    const legacy = createRunnerServer({
      apiKey: "legacy-key-abcdefghijklmnopqrstuvwxyz-1234567890",
      apiKeyFile: "", tenantsFile: "", dataDir: f.dataDir, allowedOrigins: [origin],
    });
    legacy.listen(0, "127.0.0.1"); await once(legacy, "listening");
    try {
      const base = "http://127.0.0.1:" + legacy.address().port;
      const resp = await fetch(base + "/v1/capabilities", { headers: {
        Origin: origin, Authorization: "Bearer legacy-key-abcdefghijklmnopqrstuvwxyz-1234567890",
      } });
      assert.equal(resp.status, 200);
    } finally { await new Promise(resolve => legacy.close(resolve)); }
  } finally { await f.close(); }
});
