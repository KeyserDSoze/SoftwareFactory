import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { jobDirectory, readReport } from "../common.mjs";
import { recordJobEvidence } from "../evidence.mjs";
import { getRepairSession, verifyRepairSession } from "../coordinator.mjs";

const apiKey = "runner-integration-key-abcdefghijklmnopqrstuvwxyz";
const editorKey = "editor-key-abcdefghijklmnopqrstuvwxyz1234567890";
const reviewerKey = "reviewer-key-abcdefghijklmnopqrstuvwxyz1234567890";
const approverKey = "approver-key-abcdefghijklmnopqrstuvwxyz1234567890";
const supervisorKey = "supervisor-key-abcdefghijklmnopqrstuvwxyz1234567890";
const backupProposerKey = "backup-proposer-key-abcdefghijklmnopqrstuvwxyz1234567890";
const repairOperators = JSON.stringify([
  { id: "editor", key: editorKey, roles: ["propose"] },
  { id: "reviewer", key: reviewerKey, roles: ["review"] },
  { id: "approver", key: approverKey, roles: ["approve"] },
  { id: "supervisor", key: supervisorKey, roles: ["propose","review","approve"] },
  { id: "backup", key: backupProposerKey, roles: ["propose"] },
]);
const origin = "http://localhost:5173";
const proposalId = "00000000-0000-4000-a000-000000000025";
const otherProposal = "00000000-0000-4000-a000-000000000026";
const backend = "src/backend/domain/Invoice.cs";
const frontend = "src/frontend/web/src/Invoice.tsx";
const code = {
  "src/backend/applications/Api/Api.csproj": "<Project></Project>",
  "src/backend/domain/Invoice.cs": "namespace Demo; public record Invoice(int A);",
};
async function fixture(maxQueued = 4) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-coordinator-"));
  const servers = [0, 1].map(() => createRunnerServer({
    apiKey, allowedOrigins: [origin], dataDir, maxQueued, repairOperators,
  }));
  for (const s of servers) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
  const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
  const call = async (index, endpoint, body = undefined, extra = {}) => {
    const repair = endpoint.startsWith("/v1/repair-sessions");
    const roleKey = !repair ? apiKey :
      body?.action === "review" ? reviewerKey :
      body?.action === "record_approval" ? approverKey : editorKey;
    const response = await fetch(urls[index] + endpoint, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, Authorization: "Bearer " + roleKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  async function submit(files = code, steps = ["dotnet-build"]) {
    const x = await call(0, "/v1/jobs", { label: "Repair integration", files, steps });
    assert.equal(x.status, 202);
    return x.body;
  }
  async function complete(receipt, state, steps = ["dotnet-build"]) {
    const current = await readReport(dataDir, receipt.id);
    const started = { ...current, state: "running",
      startedAt: new Date().toISOString() };
    await recordJobEvidence(dataDir, receipt.id, started, "started");
    const running = await readReport(dataDir, receipt.id);
    const result = { ...running, state, finishedAt: new Date().toISOString(),
      results: steps.map((step, i) => ({
        step, state: state === "passed" ? "passed" : "failed",
        exitCode: state === "passed" ? 0 : 1, timedOut: false, durationMs: 6,
      })) };
    await recordJobEvidence(dataDir, receipt.id, result, "finished");
    return result;
  }
  async function close() {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  }
  return { dataDir, servers, urls, call, submit, complete, close };
}
function begin(failedJobId, paths = [backend]) {
  return { failedJobId, proposalId, paths, consent: true };
}
function patch(digest, paths = [backend]) {
  return { action: "patch", consent: true, digest, paths };
}
const reviewed = { action: "review", verdict: "pass", consent: true };
const approval = id => ({ action: "record_approval", consent: true, confirmSessionId: id });
const pathFor = id => "/v1/repair-sessions/" + id;
const next = id => pathFor(id) + "/checkpoints";

test("two API processes persist a retry-safe repair session, enforce review/retest and record approval only", async () => {
  const f = await fixture();
  try {
    const failed = await f.submit();
    await f.complete(failed, "failed");
    const concurrent = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      f.call(i % 2, "/v1/repair-sessions", begin(failed.id))));
    // Shared POSIX admission deliberately returns 503 + Retry-After under
    // contention: that is a safe refusal, not a duplicate or broken session.
    // A fresh operator retry must recover the same idempotent session ID.
    const created = await Promise.all(concurrent.map(async (result, i) =>
      result.status === 503 && result.body.error === "admission_busy"
        ? f.call(i % 2, "/v1/repair-sessions", begin(failed.id)) : result));
    assert.ok(created.every(x => x.status === 201),
      "All admissions must converge: " +
      JSON.stringify(created.map(x => [x.status, x.body.error ?? null])));
    const ids = new Set(created.map(x => x.body.id));
    assert.equal(ids.size, 1, "the same failure/proposal must have one durable coordinator ID");
    const id = created[0].body.id;
    assert.equal(created[0].body.state, "awaiting_patch");
    assert.deepEqual(created[0].body.requiredSteps, ["dotnet-build"]);
    const report = await f.call(1, pathFor(id));
    assert.equal(report.status, 200);
    assert.equal(report.body.checkpointCount, 1);
    assert.deepEqual(report.body.audit, [{ sequence: 1, kind: "started", actorId: "editor" }]);
    assert.equal(Object.hasOwn(report.body, "files"), false);
    assert.equal(JSON.stringify(report.body).includes("runner-integration-key"), false);
    const wrongStart = await f.call(0, "/v1/repair-sessions",
      { ...begin(failed.id), proposalId: otherProposal });
    assert.equal(wrongStart.status, 409);
    assert.equal(wrongStart.body.error, "repair_conflict");

    const newJob = await f.submit({ ...code,
      [backend]: "namespace Demo; public record Invoice(int B);" });
    const stepBeforeReview = await f.call(0, next(id), {
      action: "retest", consent: true, jobId: newJob.id,
    });
    assert.equal(stepBeforeReview.status, 409);
    const repair = await f.call(0, next(id), patch(newJob.digest));
    assert.equal(repair.status, 200);
    assert.equal(repair.body.state, "awaiting_review");
    assert.equal((await f.call(1, next(id), patch(newJob.digest))).status, 409,
      "two clients cannot consume the same repair slot");
    assert.equal((await f.call(1, next(id), reviewed)).body.state, "awaiting_retest");
    assert.equal((await f.call(0, next(id), approval(id))).status, 409);
    assert.equal((await f.call(1, next(id), {
      action: "retest", consent: true, jobId: newJob.id,
    })).status, 409, "queued job is not a successful retest");
    await f.complete(newJob, "passed");
    const accepted = await f.call(1, next(id), {
      action: "retest", consent: true, jobId: newJob.id,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.state, "awaiting_approval");
    assert.equal(accepted.body.attempts.length, 1);
    const badApproval = await f.call(0, next(id), approval(failed.id));
    assert.equal(badApproval.status, 409);
    const approved = await f.call(0, next(id), approval(id));
    assert.equal(approved.status, 200);
    assert.equal(approved.body.state, "recorded_approval");
    assert.equal(approved.body.checkpointCount, 5);
    assert.deepEqual(approved.body.audit.map(a => a.actorId),
      ["editor", "editor", "reviewer", "editor", "approver"]);
    assert.ok(!JSON.stringify(approved.body).includes(editorKey));
    assert.ok(!JSON.stringify(approved.body).includes(reviewerKey));
    assert.ok(!JSON.stringify(approved.body).includes(approverKey));
    assert.equal((await f.call(0, next(id), approval(id))).status, 409);
    assert.equal((await f.call(1, pathFor(id))).body.state, "recorded_approval");
    assert.deepEqual((await readReport(f.dataDir, failed.id)).state, "failed");
    assert.deepEqual((await readReport(f.dataDir, newJob.id)).state, "passed");
  } finally { await f.close(); }
});

test("global runner key cannot mutate repair sessions; operator roles deny cross-scope writes", async () => {
  const f = await fixture();
  try {
    const failed = await f.submit();
    await f.complete(failed, "failed");
    const start = "/v1/repair-sessions";
    const noOperator = await f.call(0, start, begin(failed.id), {
      Authorization: "Bearer " + apiKey,
    });
    assert.equal(noOperator.status, 401, "global runner credential must not be an operator");
    const forbiddenStart = await f.call(0, start, begin(failed.id), {
      Authorization: "Bearer " + reviewerKey,
    });
    assert.equal(forbiddenStart.status, 403);
    const made = await f.call(0, start, begin(failed.id));
    assert.equal(made.status, 201);
    const id = made.body.id;
    assert.equal((await f.call(0, pathFor(id), undefined, {
      Authorization: "Bearer " + apiKey,
    })).status, 401);
    assert.equal((await f.call(0, pathFor(id))).status, 200);
    const patched = await f.call(0, next(id), patch("e".repeat(64)), {
      Authorization: "Bearer " + approverKey,
    });
    assert.equal(patched.status, 403);
    assert.equal((await f.call(0, next(id), patch("e".repeat(64)))).status, 200);
    const reviewDenied = await f.call(0, next(id), reviewed, {
      Authorization: "Bearer " + editorKey,
    });
    assert.equal(reviewDenied.status, 403);
    assert.equal((await f.call(0, next(id), reviewed)).status, 200);
    assert.equal((await f.call(0, next(id), approval(id), {
      Authorization: "Bearer " + reviewerKey,
    })).status, 403);
    assert.equal((await f.call(0, pathFor(id))).body.state, "awaiting_retest");
  } finally { await f.close(); }
});

test("transient ledger snapshot files are retried but permanent corruption always blocks every replay", async () => {
  const f = await fixture();
  try {
    const failed = await f.submit();
    await f.complete(failed, "failed");
    const root = path.join(f.dataDir, "repair-sessions");
    await mkdir(root, { recursive: true });
    const temporary = path.join(root, "unfinished-write.tmp");
    await writeFile(temporary, "temporary");
    const cleanup = new Promise(resolve => setTimeout(async () => {
      await rm(temporary, { force: true });
      resolve();
    }, 15));
    const admitted = await f.call(0, "/v1/repair-sessions", begin(failed.id));
    await cleanup;
    assert.equal(admitted.status, 201,
      "bounded rescan must recover after a temporary entry disappears");
    const id = admitted.body.id;
    const corrupt = path.join(root, "broken-entry.tmp");
    await writeFile(corrupt, "malformed persistent data");
    const replay = await f.call(1, "/v1/repair-sessions", begin(failed.id));
    assert.equal(replay.status, 409,
      "a matching session cannot mask an unrelated corrupt sibling");
    assert.equal(replay.body.error, "repair_integrity");
    assert.equal((await f.call(0, pathFor(id))).status, 200,
      "the existing valid session remains readable and was not deleted");
  } finally { await f.close(); }
});

test("server enforces three distinct actor IDs even when one credential has all role scopes", async () => {
  const f = await fixture();
  try {
    const root = await f.submit();
    await f.complete(root, "failed");
    const started = await f.call(0, "/v1/repair-sessions", begin(root.id));
    assert.equal(started.status, 201);
    const id = started.body.id;
    const changed = await f.submit({ ...code,
      [backend]: "namespace Demo; public record Invoice(int StrictActor);" });
    const patchByOtherProposer = await f.call(1, next(id), patch(changed.digest), {
      Authorization: "Bearer " + supervisorKey,
    });
    assert.equal(patchByOtherProposer.status, 409);
    assert.equal(patchByOtherProposer.body.error, "repair_actor_conflict");
    assert.equal((await f.call(0, next(id), patch(changed.digest))).status, 200);
    // Reviewer is independent; this credential also has propose+approve scopes.
    const independent = await f.call(1, next(id), reviewed, {
      Authorization: "Bearer " + supervisorKey,
    });
    assert.equal(independent.status, 200);
    assert.equal(independent.body.state, "awaiting_retest");
    await f.complete(changed, "passed");
    const retestByDifferentProposer = await f.call(0, next(id), {
      action: "retest", consent: true, jobId: changed.id,
    }, { Authorization: "Bearer " + backupProposerKey });
    assert.equal(retestByDifferentProposer.status, 409);
    assert.equal(retestByDifferentProposer.body.error, "repair_actor_conflict");
    assert.equal((await f.call(1, next(id), {
      action: "retest", consent: true, jobId: changed.id,
    })).body.state, "awaiting_approval");
    const reviewerApprovesOwnReview = await f.call(0, next(id), approval(id), {
      Authorization: "Bearer " + supervisorKey,
    });
    assert.equal(reviewerApprovesOwnReview.status, 409);
    assert.equal(reviewerApprovesOwnReview.body.error, "repair_actor_conflict");
    assert.equal((await f.call(1, next(id), approval(id), {
      Authorization: "Bearer " + approverKey,
    })).status, 200);
    const final = await f.call(0, pathFor(id));
    assert.equal(final.status, 200);
    assert.equal(final.body.state, "recorded_approval");
    assert.deepEqual(final.body.audit.map(e => e.actorId),
      ["editor", "editor", "supervisor", "editor", "approver"]);
  } finally { await f.close(); }
});

test("multi-role proposer cannot review own patch, even on retry after a second failure", async () => {
  const f = await fixture();
  try {
    const failed = await f.submit({ ...code, [backend]: "record A" });
    await f.complete(failed, "failed");
    const created = await f.call(0, "/v1/repair-sessions", begin(failed.id), {
      Authorization: "Bearer " + supervisorKey,
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const patchReceipt = await f.submit({ ...code, [backend]: "record B" });
    const patchWithWrongActor = await f.call(0, next(id), patch(patchReceipt.digest), {
      Authorization: "Bearer " + editorKey,
    });
    assert.equal(patchWithWrongActor.status, 409);
    assert.equal(patchWithWrongActor.body.error, "repair_actor_conflict");
    const patchOk = await f.call(0, next(id), patch(patchReceipt.digest), {
      Authorization: "Bearer " + supervisorKey,
    });
    assert.equal(patchOk.status, 200);
    const selfReview = await f.call(0, next(id), reviewed, {
      Authorization: "Bearer " + supervisorKey,
    });
    assert.equal(selfReview.status, 409);
    assert.equal(selfReview.body.error, "repair_actor_conflict");
    assert.equal((await f.call(1, pathFor(id))).body.state, "awaiting_review");
    const otherReviewer = await f.call(0, next(id), reviewed);
    assert.equal(otherReviewer.status, 200);
    await f.complete(patchReceipt, "failed");
    assert.equal((await f.call(1, next(id), {
      action: "retest", consent: true, jobId: patchReceipt.id,
    }, { Authorization: "Bearer " + supervisorKey })).body.state, "retest_failed");
    const newReceipt = await f.submit({ ...code, [backend]: "record C" });
    assert.equal((await f.call(0, next(id), patch(newReceipt.digest), {
      Authorization: "Bearer " + supervisorKey,
    })).body.state, "awaiting_review");
    assert.equal((await f.call(0, next(id), reviewed, {
      Authorization: "Bearer " + supervisorKey,
    })).status, 409);
    assert.equal((await f.call(1, pathFor(id))).body.attempts.length, 2);
  } finally { await f.close(); }
});

test("retest failed permits attempt 2 but never a third, cannot mismatch steps/digest/paths", async () => {
  const f = await fixture();
  try {
    const failed = await f.submit(code, ["dotnet-test"]);
    await f.complete(failed, "failed", ["dotnet-test"]);
    const session = await f.call(0, "/v1/repair-sessions",
      begin(failed.id, [backend, frontend]));
    assert.equal(session.status, 201);
    const id = session.body.id;
    assert.deepEqual(session.body.requiredSteps, ["dotnet-build", "dotnet-test", "web-build"]);
    const bad = await f.call(0, next(id), patch("0".repeat(64), [backend]));
    assert.equal(bad.status, 409);

    const tests = ["dotnet-build", "dotnet-test", "web-build"];
    const first = await f.submit({ ...code, [backend]: "record Invoice1" }, tests);
    assert.equal((await f.call(0, next(id), patch(first.digest, [backend, frontend]))).status, 200);
    assert.equal((await f.call(0, next(id), reviewed)).status, 200);
    const missing = await f.submit({ ...code, [backend]: "record InvoiceWrong" }, ["dotnet-test"]);
    await f.complete(missing, "passed", ["dotnet-test"]);
    assert.equal((await f.call(0, next(id),
      { action: "retest", consent: true, jobId: missing.id })).status, 409);
    await f.complete(first, "failed", tests);
    assert.equal((await f.call(0, next(id),
      { action: "retest", consent: true, jobId: first.id })).body.state, "retest_failed");
    const second = await f.submit({ ...code, [backend]: "record Invoice2" }, tests);
    assert.equal((await f.call(0, next(id), patch(second.digest, [backend, frontend]))).body.state,
      "awaiting_review");
    assert.equal((await f.call(0, next(id), reviewed)).body.state, "awaiting_retest");
    await f.complete(second, "failed", tests);
    assert.equal((await f.call(0, next(id),
      { action: "retest", consent: true, jobId: second.id })).body.state, "retest_failed");
    assert.equal((await f.call(0, next(id), patch("c".repeat(64), [backend, frontend]))).status, 409);
    assert.equal((await f.call(0, pathFor(id))).body.attempts.length, 2);
  } finally { await f.close(); }
});

test("repair coordinator fails closed for unauthenticated access, invalid states, corrupt history and held lock", async () => {
  const f = await fixture();
  try {
    const queued = await f.submit();
    assert.equal((await f.call(0, "/v1/repair-sessions", begin(queued.id))).status, 409);
    const failed = await f.submit({ ...code, [backend]: "record Invoice3" });
    await f.complete(failed, "failed");
    const response = await fetch(f.urls[0] + "/v1/repair-sessions", {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(begin(failed.id)),
    });
    assert.equal(response.status, 401);
    const foreign = await fetch(f.urls[0] + "/v1/repair-sessions", {
      method: "POST", headers: { Origin: "https://attacker.example",
        "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(begin(failed.id)),
    });
    assert.equal(foreign.status, 403);
    assert.equal((await f.call(0, "/v1/repair-sessions", {
      ...begin(failed.id), consent: false,
    })).status, 422);
    assert.equal((await f.call(0, "/v1/repair-sessions", {
      ...begin(failed.id), paths: ["src/frontend/web/package.json"],
    })).status, 422);
    assert.equal((await f.call(0, "/v1/repair-sessions", {
      ...begin(failed.id), paths: ["../../etc/passwd"],
    })).status, 422);
    const lock = path.join(f.dataDir, "jobs", ".admission");
    await mkdir(lock);
    const blocked = await f.call(0, "/v1/repair-sessions", begin(failed.id));
    assert.equal(blocked.status, 503);
    assert.equal(blocked.headers.get("retry-after"), "2");
    await rm(lock, { recursive: true });
    const valid = await f.call(0, "/v1/repair-sessions", begin(failed.id));
    assert.equal(valid.status, 201);
    const id = valid.body.id;
    const file = path.join(f.dataDir, "repair-sessions", id + ".json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(verifyRepairSession(stored).state, "awaiting_patch");
    stored.events[0].data.rootDigest = "f".repeat(64);
    await writeFile(file, JSON.stringify(stored));
    const tampered = await f.call(1, pathFor(id));
    assert.equal(tampered.status, 409);
    assert.equal(tampered.body.error, "repair_integrity");
    assert.equal((await f.call(0, "/v1/repair-sessions",
      begin("00000000-0000-4000-a000-000000000099"))).status, 409,
      "corrupt coordinator data must block new admissions");
  } finally { await f.close(); }
});
