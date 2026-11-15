import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureRepairOperators, authenticateRepairOperator,
  mayRecordRepairAction } from "../operator-auth.mjs";
import { createRunnerServer } from "../api.mjs";
import { verifyRepairSession, advanceRepairSession, getRepairSession } from "../coordinator.mjs";

const globalKey = "global-runner-credential-abcdefghijklmnopqrstuvwxyz";
const proposeKey = "propose-secret-abcdefghijklmnopqrstuvwxyz123456";
const reviewKey = "review-secret-abcdefghijklmnopqrstuvwxyz1234567";
const approveKey = "approve-secret-abcdefghijklmnopqrstuvwxyz123456";
const config = () => JSON.stringify([
  { id: "operator_a", key: proposeKey, roles: ["propose"] },
  { id: "operator_b", key: reviewKey, roles: ["review"] },
  { id: "operator_c", key: approveKey, roles: ["approve"] },
]);

test("operator registry validates exact shape, role scopes and compares secrets separately from job token", () => {
  const registry = configureRepairOperators(config(), globalKey);
  assert.equal(registry.length, 3);
  const auth = token => authenticateRepairOperator("Bearer " + token, registry);
  assert.deepEqual(auth(proposeKey), { id: "operator_a", roles: ["propose"] });
  assert.deepEqual(auth(reviewKey), { id: "operator_b", roles: ["review"] });
  assert.equal(auth(globalKey), null);
  assert.equal(auth("x".repeat(64)), null);
  assert.equal(authenticateRepairOperator("Basic " + proposeKey, registry), null);
  assert.equal(authenticateRepairOperator("Bearer " + proposeKey + " ", registry), null);
  assert.equal(authenticateRepairOperator(undefined, registry), null);
  assert.equal(mayRecordRepairAction(auth(proposeKey), "begin"), true);
  assert.equal(mayRecordRepairAction(auth(proposeKey), "patch"), true);
  assert.equal(mayRecordRepairAction(auth(proposeKey), "retest"), true);
  assert.equal(mayRecordRepairAction(auth(proposeKey), "review"), false);
  assert.equal(mayRecordRepairAction(auth(reviewKey), "review"), true);
  assert.equal(mayRecordRepairAction(auth(reviewKey), "record_approval"), false);
  assert.equal(mayRecordRepairAction(auth(approveKey), "record_approval"), true);
  assert.equal(mayRecordRepairAction(auth(approveKey), "patch"), false);
  assert.equal(mayRecordRepairAction(auth(approveKey), "unexpected"), false);
  assert.ok(!JSON.stringify(registry).includes(proposeKey));
});

test("malformed, duplicated or overly broad operator credentials fail at API startup", () => {
  for (const entries of [
    [],
    [{ id: "operator_a", key: proposeKey, roles: [] }],
    [{ id: "operator_a", key: "too-short", roles: ["propose"] }],
    [{ id: "operator_a", key: globalKey, roles: ["propose"] }],
    [{ id: "operator_a", key: proposeKey, roles: ["administrator"] }],
    [{ id: "operator_a", key: proposeKey, roles: ["propose","propose"] }],
    [{ id: "OPERATOR", key: proposeKey, roles: ["propose"] }],
    [{ id: "operator_a", key: proposeKey, roles: ["propose"], extra: true }],
    [{ id: "operator_a", key: proposeKey, roles: ["propose"] },
      { id: "operator_a", key: reviewKey, roles: ["review"] }],
    [{ id: "operator_a", key: proposeKey, roles: ["propose"] },
      { id: "operator_b", key: proposeKey, roles: ["review"] }],
  ]) assert.throws(() => configureRepairOperators(JSON.stringify(entries), globalKey),
    /RUNNER_REPAIR_OPERATORS_JSON/);
  assert.throws(() => configureRepairOperators("{invalid", globalKey),
    /RUNNER_REPAIR_OPERATORS_JSON/);
  assert.throws(() => configureRepairOperators("x".repeat(11000), globalKey),
    /RUNNER_REPAIR_OPERATORS_JSON/);
  assert.equal(configureRepairOperators("", globalKey), null);
});

test("repair endpoint is disabled without registry, while ordinary execution capability remains available", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-no-operators-"));
  const server = createRunnerServer({
    apiKey: globalKey, repairOperators: "", dataDir: dir,
    allowedOrigins: ["http://localhost:5173"],
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = "http://127.0.0.1:" + server.address().port;
    const headers = { Origin: "http://localhost:5173",
      Authorization: "Bearer " + globalKey };
    const capabilities = await fetch(url + "/v1/capabilities", { headers });
    assert.equal(capabilities.status, 200);
    const repair = await fetch(url + "/v1/repair-sessions", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(repair.status, 503);
    assert.deepEqual(await repair.json(), { error: "repair_auth_unconfigured" });
    assert.equal((await fetch(url + "/v1/repair-sessions/00000000-0000-4000-a000-000000000027",
      { headers })).status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy local checkpoint without actor remains verifiable but unattributed; actor tampering invalidates chain", async () => {
  const id = "00000000-0000-4000-a000-000000000027";
  const proposalId = "00000000-0000-4000-a000-000000000028";
  const jobId = "00000000-0000-4000-a000-000000000029";
  const rootDigest = "a".repeat(64);
  const record = {
    version: 1, id, createdAt: "2026-11-15T12:00:00Z", rootJobId: jobId,
    rootDigest, proposalId, paths: ["src/backend/domain/Invoice.cs"],
    requiredSteps: ["dotnet-build"], state: "awaiting_patch",
    attempts: [], events: [], head: "0".repeat(64),
  };
  const recordEvent = actorId => {
    const event = {
      sequence: 1, previousHash: "0".repeat(64), kind: "started",
      at: record.createdAt,
      ...(actorId ? { actorId } : {}),
      data: {
        rootJobId: jobId, rootDigest, proposalId,
        paths: record.paths, rootSteps: ["dotnet-build"],
      },
    };
    const hash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const original = { ...record, events: [{ ...event, hash }], head: hash };
    return original;
  };
  assert.equal(verifyRepairSession(recordEvent(null)).state, "awaiting_patch");
  assert.equal(verifyRepairSession(recordEvent("operator_a")).state, "awaiting_patch");
  const edited = recordEvent("operator_a");
  edited.events[0].actorId = "operator_b";
  assert.throws(() => verifyRepairSession(edited), /REPAIR_INTEGRITY/);
  const dir = await mkdtemp(path.join(tmpdir(), "sf-legacy-repair-"));
  try {
    const target = path.join(dir, "repair-sessions");
    await mkdir(target, { recursive: true });
    const file = path.join(target, id + ".json");
    const historic = JSON.stringify(recordEvent(null), null, 2) + "\n";
    await writeFile(file, historic);
    const readable = await getRepairSession(dir, id);
    assert.equal(readable.state, "awaiting_patch");
    assert.deepEqual(readable.audit, [
      { sequence: 1, kind: "started", actorId: null },
    ]);
    await assert.rejects(
      advanceRepairSession(dir, id, {
        action: "patch", consent: true, digest: "b".repeat(64),
        paths: record.paths,
      }, "operator_a"),
      { code: "REPAIR_LEGACY_READONLY" },
    );
    assert.equal(await readFile(file, "utf8"), historic,
      "a legacy record cannot gain an author through an API mutation");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
