import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chmod, link, mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { jobDirectory, readReport, validateRequest, isAllowedFile, authenticate, scrub, atomicWrite } from "../common.mjs";
import { createRunnerServer } from "../api.mjs";
import { planStep, planWebDependencies, validateNpmManifest, isInfrastructureFailure } from "../docker.mjs";
import { executeJob, runWorker, recoverUnclaimedJob } from "../worker.mjs";
import { recordJobEvidence, verifyJobEvidence, verifyEvidenceExport, verifyJobEvidenceForRead, retryEvidenceRead, isSafeJobEvidenceFile } from "../evidence.mjs";
import { withAdmissionLock, admissionRateLimitRetryAfter } from "../admission.mjs";

const key = "1234567890abcdef1234567890abcdef1234567890abcdef";
const origin = "http://localhost:5173";
const code = {
  "src/backend/applications/Api/Api.csproj": "<Project><PropertyGroup><TargetFramework>net11.0</TargetFramework></PropertyGroup></Project>",
  "src/backend/applications/Api/Program.cs": 'Console.WriteLine("ok");',
  "src/frontend/web/package.json": '{"scripts":{"build":"vite build"}}',
  "src/frontend/web/src/App.tsx": "export default function App() { return null; }",
};
function job(steps = ["dotnet-build"]) { return { label: "Smoke test", files: code, steps }; }
let dir, server, url;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sf-runner-test-"));
  server = createRunnerServer({ apiKey: key, allowedOrigins: [origin], dataDir: dir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (dir) await rm(dir, { recursive: true, force: true });
});
function request(endpoint, options = {}) {
  return fetch(url + endpoint, { ...options, headers: { Origin: origin, Authorization: "Bearer " + key,
    ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
}
test("strict file allowlist excludes secrets, path traversal and symlink payloads", () => {
  assert.equal(isAllowedFile("src/backend/domain/Invoice.cs"), true);
  assert.equal(isAllowedFile("src/frontend/web/e2e/login.spec.ts"), true);
  assert.equal(isAllowedFile("src/backend/infrastructure/Migrations/0001_create_work_items.sql"), true);
  for (const unsafe of ["../../etc/passwd", "src/backend/domain/../.env", ".github/workflows/ci.yml",
    "src/frontend/web/.npmrc", "src/frontend/web/src/.hidden.ts", "/root/.ssh/id_rsa",
    "src/backend/domain/A.csproj/../../.env", "src/backend/domain/A\\foo.cs",
    "src/backend/infrastructure/Migrations/secret.sql",
    "src/backend/infrastructure/Migrations/../../.env",
    "src/backend/domain/0001_create_work_items.sql"])
    assert.equal(isAllowedFile(unsafe), false, unsafe);
  assert.throws(() => validateRequest({ ...job(), files: { "src/backend/domain/foo.cs": "github_pat_abcdefghijklmnopqrstuvwxyz123456789" } }), /credential/);
  assert.throws(() => validateRequest({ ...job(), steps: ["dotnet-build", "dotnet-build"] }), /duplicated/);
  assert.throws(() => validateRequest({ ...job(), files: { "src/backend/domain/X.cs": "a".repeat(101000) } }), /contents/);
  assert.equal(authenticate("Bearer " + key, key), true);
  assert.equal(authenticate("Bearer wrong", key), false);
  assert.doesNotMatch(scrub("Bearer abcdef1234"), /abcdef/);
});
test("API denies unauthenticated calls and cross-origin requests", async () => {
  const bad = await fetch(url + "/v1/capabilities", { headers: { Origin: origin } });
  assert.equal(bad.status, 401);
  const cross = await fetch(url + "/v1/capabilities", { headers: { Origin: "https://evil.example", Authorization: "Bearer " + key } });
  assert.equal(cross.status, 403);
  const opts = await request("/v1/jobs", { method: "OPTIONS" });
  assert.equal(opts.status, 204);
  assert.equal(opts.headers.get("access-control-allow-origin"), origin);
  assert.match(opts.headers.get("access-control-allow-headers") || "", /Idempotency-Key/);
  assert.equal((await request("/v1/capabilities")).status, 200);
});
test("API accepts a bounded immutable snapshot and returns only status", async () => {
  const accepted = await request("/v1/jobs", { method: "POST", body: JSON.stringify(job()) });
  assert.equal(accepted.status, 202);
  const receipt = await accepted.json();
  assert.match(receipt.digest, /^[a-f0-9]{64}$/);
  const status = await request("/v1/jobs/" + receipt.id);
  assert.equal(status.status, 200);
  const report = await status.json();
  assert.equal(report.state, "queued");
  assert.equal(report.results.length, 0);
  const input = JSON.parse(await readFile(path.join(jobDirectory(dir, receipt.id), "input.json"), "utf8"));
  assert.equal(validateRequest(input).digest, receipt.digest);
  assert.equal(report.fileCount, 4);
  assert.equal(report.evidence.count, 1);
  const exportResponse = await request("/v1/jobs/" + receipt.id + "/evidence");
  assert.equal(exportResponse.status, 200);
  const journal = await exportResponse.json();
  assert.equal(journal.count, 1);
  assert.equal(journal.head, report.evidence.head);
  assert.deepEqual(journal.report, report, "portable export includes the full verified report");
  assert.equal(verifyEvidenceExport(journal).report.id, receipt.id);
  assert.equal(journal.entries[0].kind, "accepted");
  assert.equal(journal.entries[0].report.digest, receipt.digest);
});
test("API rejects tampered report, edited journal, missing journal and unauthenticated export", async () => {
  const accepted = await request("/v1/jobs", { method: "POST", body: JSON.stringify(job()) });
  assert.equal(accepted.status, 202);
  const { id } = await accepted.json();
  const d = jobDirectory(dir, id);
  const reportPath = path.join(d, "report.json");
  const journalPath = path.join(d, "evidence.jsonl");
  const report = await readFile(reportPath, "utf8");
  const journal = await readFile(journalPath, "utf8");
  try {
    const anon = await fetch(url + "/v1/jobs/" + id + "/evidence", { headers: { Origin: origin } });
    assert.equal(anon.status, 401);
    await writeFile(reportPath, report.replace('"state": "queued"', '"state": "passed"'));
    assert.equal((await request("/v1/jobs/" + id)).status, 409);
    assert.equal((await request("/v1/jobs/" + id + "/evidence")).status, 409);
    await writeFile(reportPath, report);
    const forged = JSON.parse(journal);
    forged.report.label = "forged";
    await writeFile(journalPath, JSON.stringify(forged) + "\n");
    assert.equal((await request("/v1/jobs/" + id)).status, 409);
    await writeFile(journalPath, "");
    assert.equal((await request("/v1/jobs/" + id)).status, 409);
    await writeFile(journalPath, journal);
    assert.equal((await request("/v1/jobs/" + id)).status, 200);
    await rm(journalPath);
    assert.equal((await request("/v1/jobs/" + id)).status, 409);
  } finally {
    await writeFile(reportPath, report);
    await writeFile(journalPath, journal);
  }
});


test("job evidence requires inode-bound regular owned single-link files across two APIs", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-evidence-inode-"));
  const servers = [0, 1].map(() => createRunnerServer({
    apiKey: key, allowedOrigins: [origin], dataDir,
  }));
  try {
    for (const s of servers) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
    const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
    const auth = { Origin: origin, Authorization: "Bearer " + key };
    const get = (i, pathName) => fetch(urls[i] + pathName, { headers: auth });
    const accepted = await fetch(urls[0] + "/v1/jobs", {
      method: "POST", body: JSON.stringify(job()),
      headers: { ...auth, "Content-Type": "application/json" },
    });
    assert.equal(accepted.status, 202);
    const id = (await accepted.json()).id;
    const dir = jobDirectory(dataDir, id);
    const report = path.join(dir, "report.json");
    const journal = path.join(dir, "evidence.jsonl");
    const originalReport = await readFile(report);
    const originalJournal = await readFile(journal);
    const valid = await verifyJobEvidence(dataDir, id);
    assert.equal(valid.report.id, id);
    const fd = await open(report, "r");
    try {
      const st = await fd.stat();
      assert.equal(isSafeJobEvidenceFile(st, st.uid), true);
      assert.equal(isSafeJobEvidenceFile(st, st.uid + 1), false);
      assert.equal(isSafeJobEvidenceFile({ ...st, isFile: () => true, nlink: 2 }), false);
      await atomicWrite(report, valid.report);
      assert.equal((await fd.stat()).nlink, 0,
        "a report inode unlinked by rename must never be accepted");
      assert.equal(isSafeJobEvidenceFile(await fd.stat()), false);
    } finally { await fd.close(); }
    const assertCorrupt = async () => {
      for (let i = 0; i < 2; i++) {
        const urlPath = "/v1/jobs/" + id + (i ? "/evidence" : "");
        const read = await get(i, urlPath);
        assert.equal(read.status, 409, "unsafe evidence must fail closed");
        assert.deepEqual(await read.json(), { error: "evidence_invalid" });
      }
      const blocked = await fetch(urls[0] + "/v1/jobs", {
        method: "POST", body: JSON.stringify(job()),
        headers: { ...auth, "Content-Type": "application/json",
          "Idempotency-Key": randomUUID() },
      });
      assert.equal(blocked.status, 503, "unsafe retained sibling blocks admission");
      assert.deepEqual(await blocked.json(), { error: "admission_integrity" });
    };
    const cases = [
      { file: report, payload: originalReport },
      { file: journal, payload: originalJournal },
    ];
    for (const { file, payload } of cases) {
      const backup = file + ".saved";
      await rm(file);
      await writeFile(backup, payload, { mode: 0o600 });
      await symlink(backup, file);
      await assertCorrupt();
      await rm(file);
      await rm(backup);
      await writeFile(file, payload, { mode: 0o600 });

      const hardlink = file + ".hardlink";
      await link(file, hardlink);
      await assertCorrupt();
      await rm(hardlink);

      await chmod(file, 0o666);
      await assertCorrupt();
      await chmod(file, 0o600);

      await writeFile(file, Buffer.alloc(4_000_001, 0x20));
      await assertCorrupt();
      await writeFile(file, payload);
      assert.equal((await get(0, "/v1/jobs/" + id)).status, 200,
        "restoring verified evidence must recover the job");
    }
    const replay = await get(1, "/v1/jobs/" + id + "/evidence");
    assert.equal(replay.status, 200);
    assert.equal(verifyEvidenceExport(await replay.json()).report.id, id);
    await rm(report);
    assert.equal((await get(0, "/v1/jobs/" + id)).status, 404,
      "only genuinely missing report remains a 404");
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("HTTP evidence read retries only transient journal/report skew and always rejects lasting corruption", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-evidence-read-retry-"));
  const servers = [0, 1].map(() => createRunnerServer({
    apiKey: key, allowedOrigins: [origin], dataDir,
  }));
  try {
    for (const s of servers) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
    const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
    const get = (index, suffix) => fetch(urls[index] + suffix, {
      headers: { Origin: origin, Authorization: "Bearer " + key },
    });
    const accepted = await fetch(urls[0] + "/v1/jobs", {
      method: "POST", body: JSON.stringify(job()),
      headers: { Origin: origin, Authorization: "Bearer " + key,
        "Content-Type": "application/json" },
    });
    assert.equal(accepted.status, 202);
    const id = (await accepted.json()).id;
    const reportPath = path.join(jobDirectory(dataDir, id), "report.json");
    const journalPath = path.join(jobDirectory(dataDir, id), "evidence.jsonl");
    const queued = await readFile(reportPath, "utf8");
    const current = await readReport(dataDir, id);
    await recordJobEvidence(dataDir, id, {
      ...current, state: "running", startedAt: new Date().toISOString(),
      summary: "Worker started",
    }, "started");
    const running = await readFile(reportPath, "utf8");
    const journal = await readFile(journalPath, "utf8");

    // Real skew: the new journal was already durably appended, but the last
    // report rename has not occurred yet. The strict verifier MUST reject it.
    await writeFile(reportPath, queued);
    await assert.rejects(verifyJobEvidence(dataDir, id),
      { code: "EVIDENCE_INVALID" });
    let reads = 0;
    const retried = await retryEvidenceRead(async () => {
      reads++;
      try { return await verifyJobEvidence(dataDir, id); }
      catch (error) {
        if (reads === 1) await writeFile(reportPath, running);
        throw error;
      }
    });
    assert.equal(reads, 2, "the first invalid read must be retried");
    assert.equal(retried.report.state, "running");

    // Both HTTP GET routes must fail closed on a *lasting* journal/report
    // skew and succeed after an actual worker-style atomic report rename.
    // A 15ms setTimeout race used to restore the report in-place, which could
    // exceed the bounded retry window on a busy CI host and cause false
    // flakes without exercising the worker's actual atomicWrite contract.
    // The unit-level retry test above already proves first-failure retries.
    for (let index = 0; index < 2; index++) {
      await atomicWrite(reportPath, JSON.parse(queued));
      const route = "/v1/jobs/" + id + (index === 0 ? "" : "/evidence");
      assert.equal((await get(index, route)).status, 409,
        "a persistently stale report must not yield a false success");
      await atomicWrite(reportPath, JSON.parse(running));
      const response = await get(index, route);
      assert.equal(response.status, 200);
      const body = await response.json();
      if (index === 0) assert.equal(body.state, "running");
      else assert.equal(verifyEvidenceExport(body).report.state, "running");
    }
    // A permanently corrupt journal remains 409 for both endpoints, even
    // after the bounded retry budget has elapsed; no silent repair is allowed.
    await writeFile(journalPath, journal.slice(0, -1));
    assert.equal((await get(0, "/v1/jobs/" + id)).status, 409);
    assert.equal((await get(1, "/v1/jobs/" + id + "/evidence")).status, 409);
    let attempts = 0;
    await assert.rejects(retryEvidenceRead(async () => {
      attempts++;
      throw Object.assign(new Error("invalid"), { code: "EVIDENCE_INVALID" });
    }), { code: "EVIDENCE_INVALID" });
    assert.equal(attempts, 3, "persistent tampering never becomes a success");
    attempts = 0;
    await assert.rejects(retryEvidenceRead(async () => {
      attempts++;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }), { code: "ENOENT" });
    assert.equal(attempts, 1, "missing reports must not incur a retry");
    assert.equal((await get(0, "/v1/jobs/" + randomUUID())).status, 404);
    await writeFile(journalPath, journal);
    assert.equal((await verifyJobEvidenceForRead(dataDir, id)).report.state, "running");
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("two API instances serialize quota admission and replay the same idempotent receipt", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-admission-data-"));
  const work = await mkdtemp(path.join(tmpdir(), "sf-admission-work-"));
  const first = createRunnerServer({ apiKey: key, allowedOrigins: [origin], dataDir,
    maxQueued: 1, maxRetained: 2 });
  const second = createRunnerServer({ apiKey: key, allowedOrigins: [origin], dataDir,
    maxQueued: 1, maxRetained: 2 });
  try {
    for (const server of [first, second]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const urls = [first, second].map(server => "http://127.0.0.1:" + server.address().port);
    const send = (index, requestKey, payload = job()) => fetch(urls[index] + "/v1/jobs", {
      method: "POST", body: JSON.stringify(payload),
      headers: { Origin: origin, Authorization: "Bearer " + key,
        "Content-Type": "application/json", "Idempotency-Key": requestKey },
    });
    const retryKey = randomUUID();
    const simultaneous = await Promise.all(Array.from({ length: 6 },
      (_, i) => send(i % 2, retryKey)));
    assert.ok(simultaneous.every(x => x.status === 202), "all concurrent identical retries must succeed");
    const receipts = await Promise.all(simultaneous.map(response => response.json()));
    assert.equal(new Set(receipts.map(r => r.id)).size, 1);
    const id = receipts[0].id;
    assert.equal((await readdir(path.join(dataDir, "jobs"))).filter(x => !x.startsWith(".")).length, 1);
    assert.equal((await verifyJobEvidence(dataDir, id)).report.idempotencyKeyHash.length, 64);

    const full = await send(0, randomUUID());
    assert.equal(full.status, 429, "new UUID cannot bypass maxQueued=1");
    assert.equal((await full.json()).error, "queue_full");
    const changed = await send(1, retryKey, { ...job(), label: "Different snapshot" });
    assert.equal(changed.status, 409, "same UUID cannot be reused for another payload");
    assert.equal((await changed.json()).error, "idempotency_conflict");
    const invalid = await send(1, "bad-key");
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error, "invalid_idempotency_key");

    const completed = await executeJob(id, { dataDir, workspaceRoot: work,
      executeStep: async plan => ({
        step: "dotnet-build", state: "passed", exitCode: 0,
        durationMs: 1, image: plan.image, stdout: "", stderr: "",
      }),
    });
    assert.equal(completed.state, "passed");
    const replayFinished = await send(1, retryKey);
    assert.equal(replayFinished.status, 202);
    const finishedReceipt = await replayFinished.json();
    assert.equal(finishedReceipt.id, id, "completed job still reuses its receipt");
    assert.equal(finishedReceipt.state, "passed",
      "replay reports the verified current state, never a fabricated queue state");

    const newKey = randomUUID();
    const next = await send(0, newKey);
    assert.equal(next.status, 202);
    const nextId = (await next.json()).id;
    assert.notEqual(nextId, id);
    assert.equal((await send(1, randomUUID())).status, 429, "queued job consumes all active slots");
    await executeJob(nextId, { dataDir, workspaceRoot: work,
      executeStep: async plan => ({
        step: "dotnet-build", state: "passed", exitCode: 0,
        durationMs: 1, image: plan.image, stdout: "", stderr: "",
      }),
    });
    assert.equal((await send(0, randomUUID())).status, 429,
      "retained completed jobs still count towards the disk cap");
    await withAdmissionLock(dataDir, async () => {
      await rm(jobDirectory(dataDir, id), { recursive: true, force: true });
    });
    const afterRetention = await send(1, retryKey);
    assert.equal(afterRetention.status, 202);
    assert.notEqual((await afterRetention.json()).id, id,
      "same key is no longer retained once its job was deleted");
  } finally {
    await Promise.all([first, second].map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("two independent API instances never exceed maxQueued under distinct simultaneous requests", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-transactional-"));
  const servers = [0, 1].map(() => createRunnerServer({
    apiKey: key, allowedOrigins: [origin], dataDir, maxQueued: 1, maxRetained: 100,
  }));
  try {
    for (const s of servers) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
    const endpoints = servers.map(s => "http://127.0.0.1:" + s.address().port);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      fetch(endpoints[i % 2] + "/v1/jobs", {
        method: "POST", body: JSON.stringify(job()),
        headers: { Origin: origin, Authorization: "Bearer " + key,
          "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      })));
    assert.equal(responses.filter(r => r.status === 202).length, 1,
      "only one of eight concurrent requests may claim the capacity");
    assert.equal(responses.filter(r => r.status === 429).length, 7);
    assert.equal((await readdir(path.join(dataDir, "jobs"))).filter(x => !x.startsWith(".")).length, 1);
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("global minute rate gate expires at 60 seconds and counts future timestamps conservatively", () => {
  const now = Date.parse("2026-11-16T12:00:00.000Z");
  const iso = offset => new Date(now + offset).toISOString();
  assert.equal(admissionRateLimitRetryAfter([iso(-60_000), iso(-30_000)],
    now, 2), null, "entry exactly one minute old expires");
  assert.equal(admissionRateLimitRetryAfter([iso(-50_000), iso(-1_000)],
    now, 2), 10);
  assert.equal(admissionRateLimitRetryAfter([iso(-50_000), iso(-1_000)],
    now + 10_000, 2), null);
  // A previously configured limit may be lowered while 3 verified recent
  // jobs remain. With cap=1, the *third* expiration opens the next slot,
  // not the first expiration at T+10s.
  const history = [iso(-50_000), iso(-30_000), iso(-10_000)];
  assert.equal(admissionRateLimitRetryAfter(history, now, 1), 50);
  assert.equal(admissionRateLimitRetryAfter([...history].reverse(), now, 1), 50,
    "the hint cannot depend on filesystem enumeration order");
  assert.equal(admissionRateLimitRetryAfter(history, now, 2), 30);
  assert.equal(admissionRateLimitRetryAfter(history, now, 3), 10);
  assert.equal(admissionRateLimitRetryAfter(history, now, 4), null);
  assert.equal(admissionRateLimitRetryAfter(history, now + 10_000, 1), 40);
  assert.equal(admissionRateLimitRetryAfter(history, now + 30_000, 1), 20);
  assert.equal(admissionRateLimitRetryAfter(history, now + 50_000, 1), null,
    "after enough entries expire, a new job is admissible");
  assert.equal(admissionRateLimitRetryAfter([iso(-30_000), iso(-30_000),
    iso(-30_000)], now, 1), 30, "identical acceptedAt timestamps are counted");
  assert.equal(admissionRateLimitRetryAfter([iso(-50_000), iso(120_000)],
    now, 1), 60, "a future-dated retained job cannot evade a reduced cap");
  assert.equal(admissionRateLimitRetryAfter([iso(120_000)], now, 1), 60,
    "clock drift must not evade the limit; HTTP hint remains bounded");
  assert.equal(admissionRateLimitRetryAfter(["garbage"], now, 0), null,
    "opt-out preserves legacy behavior");
  for (const bad of ["garbage", "2026-11-16T12:00:00Z",
    "2026-13-16T12:00:00.000Z", null])
    assert.throws(() => admissionRateLimitRetryAfter([bad], now, 1),
      { code: "ADMISSION_INTEGRITY" });
  for (const bad of [-1, 1.5, 101, NaN])
    assert.throws(() => createRunnerServer({ apiKey: key, allowedOrigins: [origin],
      maxAcceptedPerMinute: bad }), /RUNNER_MAX_ACCEPTED_PER_MINUTE/);
});

test("lowered admission rate cap advertises the LAST required expiration across API replicas", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-rate-reduced-"));
  const servers = [0, 1].map(() => createRunnerServer({
    apiKey: key, allowedOrigins: [origin], dataDir,
    maxQueued: 8, maxRetained: 10, maxAcceptedPerMinute: 1,
  }));
  try {
    // Recreate three valid SHA-chain-backed historical acceptances. A restart
    // with a lower cap must count ALL of them, not trust the old configuration.
    const now = Date.now(), checked = validateRequest(job());
    const offsets = [-50_000, -30_000, -10_000];
    for (const offset of offsets) {
      const id = randomUUID();
      await mkdir(jobDirectory(dataDir, id), { recursive: true, mode: 0o700 });
      const report = { id, schemaVersion: 1, label: checked.request.label,
        digest: checked.digest, state: "queued",
        acceptedAt: new Date(now + offset).toISOString(),
        startedAt: null, finishedAt: null, fileCount: checked.fileCount,
        bytes: checked.bytes, steps: checked.request.steps, results: [],
        summary: "In attesa del worker",
      };
      await recordJobEvidence(dataDir, id, report, "accepted");
      assert.equal((await verifyJobEvidence(dataDir, id)).report.acceptedAt, report.acceptedAt);
    }
    for (const s of servers) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
    const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
    const submit = index => fetch(urls[index] + "/v1/jobs", {
      method: "POST", body: JSON.stringify(job()),
      headers: { Origin: origin, Authorization: "Bearer " + key,
        "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    });
    const responses = await Promise.all([submit(0), submit(1)]);
    for (const response of responses) {
      assert.equal(response.status, 429, "lowering cap must not admit an extra job");
      assert.deepEqual(await response.json(), { error: "rate_limited" });
      const seconds = Number(response.headers.get("Retry-After"));
      assert.ok(seconds >= 49 && seconds <= 50,
        "three retained jobs and cap=1 need the newest job to expire, not the oldest: " + seconds);
    }
    assert.equal((await readdir(path.join(dataDir, "jobs")))
      .filter(name => !name.startsWith(".")).length, 3,
      "denied submissions must not allocate snapshots or alter valid evidence");
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("minute admission rate is global across two APIs, while idempotent replay is free", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-runner-rate-"));
  const work = await mkdtemp(path.join(tmpdir(), "sf-runner-rate-work-"));
  const servers = [0, 1].map(() => createRunnerServer({
    apiKey: key, allowedOrigins: [origin], dataDir,
    maxQueued: 8, maxRetained: 10, maxAcceptedPerMinute: 2,
  }));
  try {
    for (const s of servers) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
    const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
    const submit = (index, requestKey, payload = job()) => fetch(urls[index] + "/v1/jobs", {
      method: "POST", body: JSON.stringify(payload),
      headers: { Origin: origin, Authorization: "Bearer " + key,
        "Content-Type": "application/json", "Idempotency-Key": requestKey },
    });
    const keys = Array.from({ length: 6 }, () => randomUUID());
    const response = await Promise.all(keys.map((k, i) => submit(i % 2, k)));
    const receipts = await Promise.all(response.map(async (r, i) =>
      ({ status: r.status, data: await r.json(), key: keys[i], retryAfter: r.headers.get("retry-after") })));
    const allowed = receipts.filter(r => r.status === 202);
    const denied = receipts.filter(r => r.status === 429);
    assert.equal(allowed.length, 2, "global cap across both API instances");
    assert.equal(denied.length, 4);
    for (const rejected of denied) {
      assert.equal(rejected.data.error, "rate_limited");
      assert.ok(Number(rejected.retryAfter) >= 1 && Number(rejected.retryAfter) <= 60);
    }
    assert.equal((await readdir(path.join(dataDir, "jobs"))).filter(n => !n.startsWith(".")).length, 2);
    const first = allowed[0];
    const replay = await submit(1, first.key);
    assert.equal(replay.status, 202, "idempotent retry precedes minute gate");
    assert.equal((await replay.json()).id, first.data.id);
    const conflicting = await submit(0, first.key, { ...job(), label: "Mutated replay" });
    assert.equal(conflicting.status, 409, "same idempotency key with altered source still conflicts");
    assert.equal((await conflicting.json()).error, "idempotency_conflict");
    for (const item of allowed) {
      const complete = await executeJob(item.data.id, { dataDir, workspaceRoot: work,
        executeStep: async plan => ({ step: "dotnet-build", state: "passed",
          exitCode: 0, durationMs: 1, image: plan.image, stdout: "", stderr: "" }),
      });
      assert.equal(complete.state, "passed");
    }
    const limitedAfterCompletion = await submit(0, randomUUID());
    assert.equal(limitedAfterCompletion.status, 429,
      "recent terminal jobs still count, even though no slot is active");
    assert.equal((await limitedAfterCompletion.json()).error, "rate_limited");
    const again = await submit(1, first.key);
    assert.equal(again.status, 202);
    assert.equal((await again.json()).state, "passed");
    assert.equal((await readdir(path.join(dataDir, "jobs"))).filter(n => !n.startsWith(".")).length,
      2, "no new job directory on rate rejection");
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("stale admission lock and corrupt persisted job fail closed without disk quota bypass", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-admission-locked-"));
  const s = createRunnerServer({ apiKey: key, allowedOrigins: [origin], dataDir,
    maxQueued: 2, admissionWaitMs: 100 });
  try {
    s.listen(0, "127.0.0.1"); await once(s, "listening");
    const endpoint = "http://127.0.0.1:" + s.address().port + "/v1/jobs";
    const submit = () => fetch(endpoint, {
      method: "POST", body: JSON.stringify(job()),
      headers: { Origin: origin, Authorization: "Bearer " + key,
        "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    });
    const jobsRoot = path.join(dataDir, "jobs");
    await mkdir(jobsRoot, { recursive: true });
    await mkdir(path.join(jobsRoot, ".admission"));
    const busy = await submit();
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("retry-after"), "2");
    assert.equal((await busy.json()).error, "admission_busy");
    assert.ok((await readdir(jobsRoot)).includes(".admission"), "lock is never stolen by TTL");
    await rm(path.join(jobsRoot, ".admission"), { recursive: true });
    const corruptDir = jobDirectory(dataDir, randomUUID());
    await mkdir(corruptDir);
    const corrupt = await submit();
    assert.equal(corrupt.status, 503);
    assert.equal((await corrupt.json()).error, "admission_integrity");
    await withAdmissionLock(dataDir, async () => rm(corruptDir, { recursive: true }));
    assert.equal((await submit()).status, 202, "admission recovers after manual reconciliation");
  } finally {
    await new Promise(resolve => s.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("admission verifies every retained sibling before quotas and idempotent retries", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-admission-evidence-"));
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "sf-admission-evidence-work-"));
  const servers = [0, 1].map(() => createRunnerServer({
    apiKey: key, allowedOrigins: [origin], dataDir, maxQueued: 1, maxRetained: 4,
  }));
  try {
    for (const s of servers) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
    const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
    const submit = (index, token) => fetch(urls[index] + "/v1/jobs", {
      method: "POST", body: JSON.stringify(job()),
      headers: { Origin: origin, Authorization: "Bearer " + key,
        "Content-Type": "application/json", "Idempotency-Key": token },
    });
    const originalKey = randomUUID();
    const accepted = await submit(0, originalKey);
    assert.equal(accepted.status, 202);
    const id = (await accepted.json()).id;
    const reportPath = path.join(jobDirectory(dataDir, id), "report.json");
    const journalPath = path.join(jobDirectory(dataDir, id), "evidence.jsonl");
    const originalReport = await readFile(reportPath, "utf8");
    const originalJournal = await readFile(journalPath, "utf8");

    // A forged terminal state would previously evade maxQueued=1 because only
    // report.json was scanned. The hash-chain must reject it instead.
    await writeFile(reportPath, originalReport.replace('"state": "queued"', '"state": "passed"'));
    const forged = await submit(1, randomUUID());
    assert.equal(forged.status, 503);
    assert.equal((await forged.json()).error, "admission_integrity");
    assert.equal((await submit(0, originalKey)).status, 503);
    await writeFile(reportPath, originalReport);

    // Existing report with a truncated journal cannot be ignored even when
    // the new request has a distinct idempotency key.
    await writeFile(journalPath, originalJournal.slice(0, -1));
    const truncated = await submit(0, randomUUID());
    assert.equal(truncated.status, 503);
    assert.equal((await truncated.json()).error, "admission_integrity");
    await writeFile(journalPath, originalJournal);
    assert.equal((await submit(1, randomUUID())).status, 429,
      "after restoration the real queued state still consumes the quota");

    const completed = await executeJob(id, {
      dataDir, workspaceRoot,
      executeStep: async plan => ({
        step: "dotnet-build", state: "passed", exitCode: 0,
        durationMs: 1, image: plan.image, stdout: "", stderr: "",
      }),
    });
    assert.equal(completed.state, "passed");
    const replay = await submit(1, originalKey);
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), { id, digest: completed.digest, state: "passed" });

    // Even replaying a VALID completed job cannot hide a corrupt sibling.
    const second = await submit(0, randomUUID());
    assert.equal(second.status, 202);
    const otherId = (await second.json()).id;
    const otherJournal = path.join(jobDirectory(dataDir, otherId), "evidence.jsonl");
    const saved = await readFile(otherJournal, "utf8");
    await writeFile(otherJournal, saved.slice(0, -1));
    const invalidSibling = await submit(1, originalKey);
    assert.equal(invalidSibling.status, 503);
    assert.equal((await invalidSibling.json()).error, "admission_integrity");
    await writeFile(otherJournal, saved);
    const safeReplay = await submit(0, originalKey);
    assert.equal(safeReplay.status, 202);
    assert.equal((await safeReplay.json()).state, "passed");
    assert.equal((await readdir(path.join(dataDir, "jobs"))).filter(x => !x.startsWith(".")).length,
      2, "no extra job admitted during corrupt evidence");
  } finally {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("API validates schema and never accepts files outside allowlist", async () => {
  const res = await request("/v1/jobs", { method: "POST", body: JSON.stringify({
    label: "bad", files: { ".env": "TOKEN=secret" }, steps: ["dotnet-build"],
  }) });
  assert.equal(res.status, 422);
  const problem = await res.json();
  assert.equal(problem.error, "invalid_request");
  const missing = await request("/v1/jobs/01234567-89ab-cdef-0123-456789abcdef");
  assert.equal(missing.status, 404);
});
test("docker plans use fixed commands, no network, limits and no socket exposure", () => {
  const work = "/srv/softwarefactory/workspaces/abc123";
  const plan = planStep("dotnet-build", code, work);
  assert.equal(plan.image, "mcr.microsoft.com/dotnet/sdk:11.0");
  assert.deepEqual(plan.command.slice(0, 2), ["dotnet","build"]);
  assert.ok(plan.args.includes("none"));
  assert.ok(plan.args.includes("--cap-drop=ALL"));
  assert.ok(plan.args.includes("--read-only"));
  assert.ok(plan.args.includes("--pids-limit=128"));
  assert.ok(!plan.args.join(" ").includes("docker.sock"));
  assert.equal(planStep("dotnet-test", code, work).skip.includes("No tests"), true);
  assert.equal(planStep("playwright", code, work).skip.includes("No Playwright"), true);
  assert.deepEqual(planStep("web-build", code, work).command, ["npm", "run", "build", "--prefix", "src/frontend/web"]);
  assert.equal(planWebDependencies(code, work).command.includes("--offline"), true);
  assert.ok(planWebDependencies(code, work).args.includes("none"));
  assert.ok(!planStep("web-build", code, work).args.join(" ").includes("bridge"));
  assert.ok(planStep("web-build", code, work).args.includes("--user=0:0"));
  assert.ok(planStep("web-build", code, work, { RUNNER_CONTAINER_UID: "1001:1001" }).args.includes("--user=1001:1001"));
  assert.throws(() => planStep("web-build", code, work, { RUNNER_CONTAINER_UID: "0:0 --privileged" }), /Invalid container user/);
  assert.throws(() => planStep("run-any-command", code, work), /Unsupported/);
});
test("worker writes real step receipts and skips missing tests without false success", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-test-data-"));
  const work = await mkdtemp(path.join(tmpdir(), "sf-test-work-"));
  const id = "01234567-89ab-4def-a234-0123456789ab";
  try {
    const d = jobDirectory(dataDir, id);
    await mkdir(d, { recursive: true });
    const checked = validateRequest(job(["dotnet-build", "dotnet-test"]));
    await writeFile(path.join(d, "input.json"), JSON.stringify(checked.request));
    await atomicWrite(path.join(d, "report.json"), { id, digest: checked.digest, state: "queued",
      label: "test", acceptedAt: new Date().toISOString(), results: [], steps: checked.request.steps });
    await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
    let invoked = 0;
    const report = await executeJob(id, { dataDir, workspaceRoot: work, executeStep: async plan => {
      invoked++; assert.ok(plan.args.includes("--network")); return { step: "dotnet-build", state: "passed", exitCode: 0,
        durationMs: 42, image: plan.image, stdout: "Build succeeded.", stderr: "" };
    } });
    assert.equal(invoked, 1);
    assert.equal(report.state, "incomplete");
    assert.deepEqual(report.results.map(s => s.state), ["passed", "skipped"]);
    assert.equal((await readReport(dataDir,id)).state,"incomplete");
    assert.equal((await readdir(work)).length, 0);
    const verified = await verifyJobEvidence(dataDir, id);
    assert.deepEqual(verified.entries.map(x => x.kind),
      ["accepted", "started", "step", "step", "finished"]);
    assert.equal(verified.report.state, "incomplete");
  } finally { await rm(dataDir, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); }
});


test("atomic claim guarantees one execution even with two worker instances", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-lock-data-"));
  const work = await mkdtemp(path.join(tmpdir(), "sf-lock-work-"));
  const id = "00000000-0000-4000-a000-000000000018";
  let release = () => {};
  try {
    const dir = jobDirectory(dataDir, id);
    const checked = validateRequest(job(["dotnet-build"]));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "input.json"), JSON.stringify(checked.request));
    await atomicWrite(path.join(dir, "report.json"), {
      id, digest: checked.digest, label: "atomic", state: "queued",
      acceptedAt: new Date().toISOString(), results: [], steps: checked.request.steps,
    });
    await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
    let notify;
    const started = new Promise(resolve => { notify = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const executeStep = async plan => {
      calls++; notify(); await hold;
      return { step: "dotnet-build", state: "passed", exitCode: 0,
        durationMs: 2, image: plan.image, stdout: "ok", stderr: "" };
    };
    const first = executeJob(id, { dataDir, workspaceRoot: work, executeStep });
    await started;
    assert.equal((await readReport(dataDir, id)).state, "running");
    assert.ok((await readdir(dir)).includes(".claim"));
    const second = await executeJob(id, { dataDir, workspaceRoot: work, executeStep });
    assert.equal(second.state, "running");
    assert.equal(calls, 1);
    await runWorker({ dataDir, workspaceRoot: work, pollMs: 1,
      stop: (() => { let n = 0; return () => n++ > 0; })(),
      executeQueuedJob: () => { throw Error("claimed job cannot be selected"); } });
    assert.equal((await readReport(dataDir, id)).state, "running");
    release();
    assert.equal((await first).state, "passed");
    assert.equal(calls, 1);
    assert.ok(!(await readdir(dir)).includes(".claim"), "claim released on completion");
    assert.equal((await executeJob(id, { dataDir, workspaceRoot: work, executeStep })).state, "passed");
    assert.equal(calls, 1);
  } finally {
    release();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("orphan claim blocks execution, does not starve queue, and never becomes passed", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-orphan-data-"));
  const work = await mkdtemp(path.join(tmpdir(), "sf-orphan-work-"));
  const orphan = "00000000-0000-4000-a000-000000000019";
  const next = "00000000-0000-4000-a000-000000000020";
  try {
    for (const [id, state] of [[orphan, "running"], [next, "queued"]]) {
      const dir = jobDirectory(dataDir, id);
      const checked = validateRequest(job(["dotnet-build"]));
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "input.json"), JSON.stringify(checked.request));
      await atomicWrite(path.join(dir, "report.json"), { id, digest: checked.digest,
        state: "queued", label: "orphan", acceptedAt: new Date().toISOString(),
        results: [], steps: checked.request.steps });
      const initial = await readReport(dataDir, id);
      await recordJobEvidence(dataDir, id, initial, "accepted");
      if (state === "running") await recordJobEvidence(dataDir, id, {
        ...initial, state: "running", startedAt: new Date().toISOString(), summary: "test start",
      }, "started");
    }
    await mkdir(path.join(jobDirectory(dataDir, orphan), ".claim"));
    let processed = [];
    await runWorker({ dataDir, workspaceRoot: work, pollMs: 1,
      stop: (() => { let n = 0; return () => n++ > 0; })(),
      executeQueuedJob: async id => { processed.push(id); } });
    assert.deepEqual(processed, [next], "orphan must not block an available queued job");
    assert.equal((await readReport(dataDir, orphan)).state, "running");
    assert.equal((await executeJob(orphan, { dataDir, workspaceRoot: work,
      executeStep: () => { throw Error("must not execute orphan"); } })).state, "running");
    await rm(path.join(jobDirectory(dataDir, orphan), ".claim"), { recursive: true });
    await runWorker({ dataDir, workspaceRoot: work, pollMs: 1,
      stop: (() => { let n = 0; return () => n++ > 0; })(),
      executeQueuedJob: async () => {} });
    assert.equal((await readReport(dataDir, orphan)).state, "incomplete",
      "manual removal of orphan claim allows incomplete recovery, never automatic retry");
    // A real completed journal must not be overwritten by an out-of-date recovery.
    const raceId = "00000000-0000-4000-a000-000000000021";
    const raceDir = jobDirectory(dataDir, raceId);
    await mkdir(raceDir, { recursive: true });
    await atomicWrite(path.join(raceDir, "report.json"), {
      id: raceId, digest: (await readReport(dataDir, orphan)).digest,
      state: "queued", label: "race", acceptedAt: new Date().toISOString(),
      results: [], steps: ["dotnet-build"],
    });
    const fresh = await readReport(dataDir, raceId);
    await recordJobEvidence(dataDir, raceId, fresh, "accepted");
    await recordJobEvidence(dataDir, raceId, { ...fresh, state: "running",
      startedAt: new Date().toISOString(), summary: "started" }, "started");
    const running = await readReport(dataDir, raceId);
    await recordJobEvidence(dataDir, raceId, { ...running, state: "passed",
      finishedAt: new Date().toISOString(), summary: "completed" }, "finished");
    assert.equal(await recoverUnclaimedJob(dataDir, raceId), false,
      "recovery scanner must not overwrite a job that finished after its first read");
    assert.equal((await verifyJobEvidence(dataDir, raceId)).report.state, "passed");
    assert.ok(!(await readdir(raceDir)).includes(".claim"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("journal detects valid-prefix truncation, forged step exit code and redacts output", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-audit-data-"));
  const work = await mkdtemp(path.join(tmpdir(), "sf-audit-work-"));
  const id = "00000000-0000-4000-a000-000000000022";
  try {
    const d = jobDirectory(dataDir, id);
    const checked = validateRequest(job(["dotnet-build"]));
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "input.json"), JSON.stringify(checked.request));
    await atomicWrite(path.join(d, "report.json"), {
      id, digest: checked.digest, label: "audit", state: "queued",
      acceptedAt: new Date().toISOString(), results: [], steps: checked.request.steps,
    });
    await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
    const finished = await executeJob(id, {
      dataDir, workspaceRoot: work,
      executeStep: async plan => ({ step: "dotnet-build", state: "passed", exitCode: 0,
        durationMs: 4, image: plan.image, stdout: "token=example-secret", stderr: "" }),
    });
    assert.equal(finished.state, "passed");
    const verified = await verifyJobEvidence(dataDir, id);
    assert.deepEqual(verified.entries.map(entry => entry.kind),
      ["accepted", "started", "step", "finished"]);
    assert.doesNotMatch(JSON.stringify(verified.entries), /example-secret/);
    const file = path.join(d, "evidence.jsonl");
    const complete = await readFile(file, "utf8");
    const validPrefix = complete.split("\n").slice(0, -2).join("\n") + "\n";
    await writeFile(file, validPrefix);
    await assert.rejects(verifyJobEvidence(dataDir, id), /integrity/);
    await writeFile(file, complete);
    await atomicWrite(path.join(d, "report.json"), {
      ...finished, results: [{ ...finished.results[0], exitCode: 7 }],
    });
    await assert.rejects(verifyJobEvidence(dataDir, id), /integrity/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("npm preparation permits only registry semver dependencies and never runs lifecycle scripts", () => {
  const work = "/srv/softwarefactory/workspaces/test-1";
  const deps = {
    ...code, "src/frontend/web/package.json": JSON.stringify({
      scripts: { install: "echo THIS_MUST_NOT_RUN", build: "vite build" },
      dependencies: { react: "^19.2.0" }, devDependencies: { vite: "^7.1.0" },
    }),
  };
  const offline = planWebDependencies(deps, work, {});
  assert.ok(offline.command.includes("--ignore-scripts"));
  assert.ok(offline.command.includes("--offline"));
  assert.ok(offline.args.includes("none"));
  assert.ok(!offline.command.join(" ").includes("THIS_MUST_NOT_RUN"));
  const online = planWebDependencies(deps, work, { RUNNER_ALLOW_NET_DEPS: "true" });
  assert.ok(online.args.includes("bridge"));
  assert.ok(!online.command.includes("--offline"));
  assert.ok(online.command.includes("--registry=https://registry.npmjs.org/"));
  assert.ok(!planStep("web-build", deps, work).args.includes("bridge"));
  assert.throws(() => planWebDependencies(deps, work, {
    RUNNER_ALLOW_NET_DEPS: "true", RUNNER_NPM_REGISTRY: "http://untrusted.example",
  }), /HTTPS/);
  assert.throws(() => validateNpmManifest(JSON.stringify({ dependencies: { bad: "git+ssh://attacker" } })), /Unsafe/);
  assert.throws(() => validateNpmManifest(JSON.stringify({ dependencies: { bad: "file:../../secrets" } })), /Unsafe/);
  assert.throws(() => validateNpmManifest(JSON.stringify({ workspaces: ["../../"] })), /Unsupported/);
  assert.throws(() => validateNpmManifest(JSON.stringify({ overrides: { "a": "1.0.0" } })), /Unsupported/);
});
test("dependency errors are incomplete, not code defects to repair with AI", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-prep-data-"));
  const work = await mkdtemp(path.join(tmpdir(), "sf-prep-work-"));
  const id = "01234567-89ab-4def-a234-0123456789ac";
  try {
    const d = jobDirectory(dataDir, id);
    await mkdir(d, { recursive: true });
    const checked = validateRequest(job(["web-build", "web-test"]));
    await writeFile(path.join(d, "input.json"), JSON.stringify(checked.request));
    await atomicWrite(path.join(d, "report.json"), {
      id, digest: checked.digest, state: "queued", label: "prep-failure",
      acceptedAt: new Date().toISOString(), results: [], steps: checked.request.steps,
    });
    await recordJobEvidence(dataDir, id, await readReport(dataDir, id), "accepted");
    const calls = [];
    const report = await executeJob(id, { dataDir, workspaceRoot: work, executeStep: async (plan, job, step) => {
      calls.push(step);
      return { step, state: "failed", exitCode: 1, durationMs: 20,
        image: plan.image, stdout: "", stderr: "npm error code ENOTCACHED" };
    } });
    assert.deepEqual(calls, ["npm-prepare"]);
    assert.equal(report.state, "incomplete");
    assert.equal(report.preparation.state, "failed");
    assert.deepEqual(report.results.map(x => x.state), ["skipped", "skipped"]);
    assert.ok(report.summary.includes("NOT a pass"));
  } finally { await rm(dataDir, { recursive: true, force: true }); await rm(work, { recursive: true, force: true }); }
  assert.equal(isInfrastructureFailure({
    state: "failed", exitCode: 125, stderr: "Cannot connect to the Docker daemon", stdout: "",
  }), true);
  assert.equal(isInfrastructureFailure({
    state: "failed", exitCode: 1, stderr: "src/App.tsx(4,2): error TS1005", stdout: "",
  }), false);
  assert.equal(isInfrastructureFailure({
    state: "failed", exitCode: 125, stderr: "invalid Docker --mount argument", stdout: "",
  }), true);
});

test("Playwright step uses matching pinned browser image and no network", () => {
  const work = "/srv/softwarefactory/workspaces/playwright-test";
  const pwFiles = {
    ...code,
    "src/frontend/web/package.json": JSON.stringify({
      scripts: { "test:e2e": "playwright test" },
      devDependencies: { "@playwright/test": "1.64.1" },
    }),
    "src/frontend/web/playwright.config.ts": "export default {};",
    "src/frontend/web/e2e/smoke.spec.ts": "import { test } from '@playwright/test'; test('ok', async () => {});",
  };
  const planned = planStep("playwright", pwFiles, work);
  assert.equal(planned.image, "mcr.microsoft.com/playwright:v1.64.1-noble");
  assert.equal(planned.skip, undefined);
  assert.ok(planned.args.includes("none"), "browser job must not have network egress");
  assert.ok(planned.args.includes("--init"));
  assert.ok(planned.command.join(" ").includes("./node_modules/.bin/playwright test"));
  assert.ok(!planned.command.join(" ").includes("npx"));
  const mismatch = {
    ...pwFiles,
    "src/frontend/web/package.json": JSON.stringify({
      devDependencies: { "@playwright/test": "^1.64.1" },
    }),
  };
  assert.match(planStep("playwright", mismatch, work).skip, /pinned to 1[.]64[.]1/);
  assert.match(planStep("playwright", pwFiles, work, {
    RUNNER_PLAYWRIGHT_IMAGE: "mcr.microsoft.com/playwright:v1.55.0-noble",
  }).skip, /differ/);
  assert.match(planStep("playwright", { ...pwFiles, "src/frontend/web/playwright.config.ts": undefined },
    work).skip, /configuration/);
  assert.equal(isInfrastructureFailure({
    state: "failed", exitCode: 1, stdout: "",
    stderr: "browserType.launch: Executable doesn't exist at /ms-playwright/...",
  }), true);
  assert.equal(isInfrastructureFailure({
    state: "failed", exitCode: 1, stdout: "Error: expect(locator).toBeVisible() failed", stderr: "",
  }), false);
});
