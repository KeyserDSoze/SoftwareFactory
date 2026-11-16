import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, chmod, link, mkdir, open, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerServer } from "../api.mjs";
import { isPrivateRepairOperatorFile, isStableRepairOperatorSnapshot,
  loadRepairOperatorsFile, reauthorizeRepairMutation } from "../operator-auth.mjs";
import { beginRepairSession, advanceRepairSession } from "../coordinator.mjs";
import { readReport } from "../common.mjs";
import { recordJobEvidence } from "../evidence.mjs";

const runnerKey = "runner-job-secret-abcdefghijklmnopqrstuvwxyz12345678";
const originalKey = "operator-original-secret-abcdefghijklmnopqrstuvwxyz";
const rotatedKey = "operator-rotated-secret-abcdefghijklmnopqrstuvwxyz1";
const reviewerKey = "operator-reviewer-secret-abcdefghijklmnopqrstuvwxyz";
const rotatedReviewerKey = "operator-reviewer-rotated-secret-abcdefghijklmnopqrstuvwxyz";
const origin = "http://localhost:5173";
const proposalId = "00000000-0000-4000-a000-000000000031";
const source = {
  "src/backend/applications/Api/Api.csproj": "<Project></Project>",
  "src/backend/domain/Item.cs": "namespace Demo; public record Item(int A);",
};
const entries = (key = originalKey, active = true, reviewKey = reviewerKey) => [
  ...(active ? [{ id: "editor", key, roles: ["propose"] }] : []),
  { id: "reviewer", key: reviewKey, roles: ["review"] },
];
const render = value => JSON.stringify(value);
async function saveAtomic(file, text) {
  const tmp = file + ".new";
  await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
  await rename(tmp, file);
}
async function environment() {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-operator-rotation-"));
  const file = path.join(dir, "operators.json");
  const dataDir = path.join(dir, "data");
  await mkdir(dataDir);
  const servers = [0, 1].map(() => createRunnerServer({
    apiKey: runnerKey, repairOperators: "", repairOperatorsFile: file,
    allowedOrigins: [origin], dataDir,
  }));
  for (const s of servers) { s.listen(0, "127.0.0.1"); await once(s, "listening"); }
  const urls = servers.map(s => "http://127.0.0.1:" + s.address().port);
  const request = async (index, pathname, key = originalKey, body) => {
    const resp = await fetch(urls[index] + pathname, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, Authorization: "Bearer " + key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: render(body) }),
    });
    return { status: resp.status, body: await resp.json() };
  };
  const close = async () => {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, file, dataDir, request, close };
}

test("operator registry stat must match the effective API uid, not just owner-only mode bits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-registry-owner-"));
  const file = path.join(dir, "operators.json");
  try {
    await writeFile(file, render(entries()), { mode: 0o600 });
    const info = await stat(file);
    const uid = process.geteuid();
    assert.equal(info.uid, uid, "test fixture belongs to the current API user");
    assert.equal(isPrivateRepairOperatorFile(info, uid), true);
    const candidate = { ...info, isFile: () => true };
    assert.equal(isPrivateRepairOperatorFile({ ...candidate, uid: uid + 1 }, uid), false);
    assert.equal(isPrivateRepairOperatorFile(candidate, null), false);
    assert.equal(isPrivateRepairOperatorFile({ ...candidate, nlink: 2 }, uid), false);
    assert.equal(isPrivateRepairOperatorFile({ ...candidate, mode: info.mode | 0o044 }, uid), false);
    assert.equal(isPrivateRepairOperatorFile({ ...candidate, isFile: () => false }, uid), false);
    assert.equal(isPrivateRepairOperatorFile({ ...candidate, size: 10001 }, uid), false);
    assert.equal((await loadRepairOperatorsFile(file, runnerKey)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("operator registry file validates owner-only regular single-inode files and never reveals keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-private-registry-"));
  const file = path.join(dir, "operators.json");
  const content = render(entries());
  try {
    await assert.rejects(loadRepairOperatorsFile(file, runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    await writeFile(file, content, { mode: 0o600 });
    const loaded = await loadRepairOperatorsFile(file, runnerKey);
    assert.equal(loaded.length, 2);
    assert.ok(!JSON.stringify(loaded).includes(originalKey));
    await chmod(file, 0o644);
    await assert.rejects(loadRepairOperatorsFile(file, runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    await chmod(file, 0o400);
    assert.equal((await loadRepairOperatorsFile(file, runnerKey)).length, 2,
      "owner-read-only is acceptable");
    const hard = path.join(dir, "hardlink.json");
    await link(file, hard);
    await assert.rejects(loadRepairOperatorsFile(file, runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    await rm(hard);
    const sym = path.join(dir, "symlink.json");
    await symlink(file, sym);
    await assert.rejects(loadRepairOperatorsFile(sym, runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    await assert.rejects(loadRepairOperatorsFile(dir, runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    await assert.rejects(loadRepairOperatorsFile("relative/path.json", runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    await assert.rejects(loadRepairOperatorsFile(file + "\0", runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    await saveAtomic(file, "{}");
    await assert.rejects(loadRepairOperatorsFile(file, runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    await saveAtomic(file, render([{ id: "editor", key: runnerKey, roles: ["approve"] }]));
    await assert.rejects(loadRepairOperatorsFile(file, runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    await saveAtomic(file, render([{ id: "editor", key: originalKey, roles: ["propose"] },
      { id: "reviewer", key: originalKey, roles: ["review"] }]));
    await assert.rejects(loadRepairOperatorsFile(file, runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    await saveAtomic(file, "x".repeat(11000));
    await assert.rejects(loadRepairOperatorsFile(file, runnerKey),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("two API instances rotate and revoke operator keys on shared directory without restart, preserving audit", async () => {
  const f = await environment();
  try {
    const goodRoute = "/v1/repair-sessions";
    // Repair is fail-closed before provisioning. Existing job API stays usable.
    assert.deepEqual(await f.request(0, goodRoute), {
      status: 503, body: { error: "repair_auth_unavailable" },
    });
    assert.equal((await f.request(1, "/v1/capabilities", runnerKey)).status, 200);
    await saveAtomic(f.file, render(entries()));
    assert.equal((await f.request(0, goodRoute, runnerKey)).status, 401);
    const accepted = await f.request(0, "/v1/jobs", runnerKey,
      { label: "Rotating operator integration", files: source, steps: ["dotnet-build"] });
    assert.equal(accepted.status, 202);
    const started = await readReport(f.dataDir, accepted.body.id);
    await recordJobEvidence(f.dataDir, accepted.body.id, {
      ...started, state: "running", startedAt: "2026-11-16T10:00:00.000Z",
    }, "started");
    const running = await readReport(f.dataDir, accepted.body.id);
    await recordJobEvidence(f.dataDir, accepted.body.id, {
      ...running, state: "failed", finishedAt: "2026-11-16T10:00:01.000Z",
      results: [{ step: "dotnet-build", state: "failed", exitCode: 1,
        timedOut: false, durationMs: 1000 }],
    }, "finished");
    const begin = await f.request(0, goodRoute, originalKey, {
      failedJobId: accepted.body.id, proposalId,
      paths: ["src/backend/domain/Item.cs"], consent: true,
    });
    assert.equal(begin.status, 201, JSON.stringify(begin.body));
    const session = "/v1/repair-sessions/" + begin.body.id;
    const before = await f.request(1, session, originalKey);
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.audit, [
      { sequence: 1, kind: "started", actorId: "editor" },
    ]);
    const disk = await readFile(path.join(f.dataDir, "repair-sessions",
      begin.body.id + ".json"), "utf8");

    // Atomic replacement in the shared DIRECTORY (not a file bind mount) takes
    // effect on both running API instances on their very next request.
    await saveAtomic(f.file, render(entries(rotatedKey)));
    for (const index of [0, 1]) {
      assert.equal((await f.request(index, session, originalKey)).status, 401);
      assert.equal((await f.request(index, session, rotatedKey)).status, 200);
      assert.equal((await f.request(index, session, runnerKey)).status, 401);
    }
    // Same immutable actorId after rotation: history is not rewritten.
    const patch = await f.request(1, session + "/checkpoints", rotatedKey, {
      action: "patch", consent: true, digest: "b".repeat(64),
      paths: ["src/backend/domain/Item.cs"],
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    assert.deepEqual(patch.body.audit.map(x => x.actorId), ["editor", "editor"]);

    // Role change immediately removes the ability to mutate.
    await saveAtomic(f.file, render([
      { id: "editor", key: rotatedKey, roles: ["approve"] },
      { id: "reviewer", key: reviewerKey, roles: ["review"] },
    ]));
    assert.equal((await f.request(0, session + "/checkpoints", rotatedKey, {
      action: "retest", consent: true, jobId: accepted.body.id,
    })).status, 403);
    await saveAtomic(f.file, render(entries(rotatedKey, false)));
    for (const index of [0, 1]) {
      assert.equal((await f.request(index, session, rotatedKey)).status, 401);
      const reviewer = await f.request(index, session, reviewerKey);
      assert.equal(reviewer.status, 200);
      assert.equal(reviewer.body.state, "awaiting_review");
    }
    assert.equal((await readFile(path.join(f.dataDir, "repair-sessions",
      begin.body.id + ".json"), "utf8")).startsWith(disk.slice(0, 80)), true);
    assert.ok(!JSON.stringify(patch.body).includes(rotatedKey));
    assert.ok(!JSON.stringify(patch.body).includes(originalKey));
    assert.equal((await f.request(0, "/v1/capabilities", runnerKey)).status, 200);
  } finally { await f.close(); }
});

test("queued repair mutations recheck rotated credentials under admission lock", async () => {
  const f = await environment();
  try {
    await saveAtomic(f.file, render(entries()));
    const accepted = await f.request(0, "/v1/jobs", runnerKey, {
      label: "Queued repair reauthentication", files: source, steps: ["dotnet-build"],
    });
    assert.equal(accepted.status, 202);
    const before = await readReport(f.dataDir, accepted.body.id);
    await recordJobEvidence(f.dataDir, accepted.body.id, {
      ...before, state: "running", startedAt: "2026-11-16T10:00:00.000Z",
    }, "started");
    const running = await readReport(f.dataDir, accepted.body.id);
    await recordJobEvidence(f.dataDir, accepted.body.id, {
      ...running, state: "failed", finishedAt: "2026-11-16T10:00:01.000Z",
      results: [{ step: "dotnet-build", state: "failed", exitCode: 1,
        timedOut: false, durationMs: 1000 }],
    }, "finished");
    const input = { failedJobId: accepted.body.id, proposalId,
      paths: ["src/backend/domain/Item.cs"], consent: true };
    // The direct coordinator guard must run only while the lock is held,
    // before even the initial session file can be created.
    let checkedUnderLock = false;
    await assert.rejects(
      beginRepairSession(f.dataDir, input, "editor", undefined, async () => {
        await stat(path.join(f.dataDir, "jobs", ".admission"));
        checkedUnderLock = true;
        throw Object.assign(new Error("revoked"), { code: "REPAIR_AUTH_REVOKED" });
      }), { code: "REPAIR_AUTH_REVOKED" });
    assert.equal(checkedUnderLock, true);
    const session = await f.request(0, "/v1/repair-sessions", originalKey, input);
    assert.equal(session.status, 201, JSON.stringify(session.body));
    const route = "/v1/repair-sessions/" + session.body.id;
    const pathFile = path.join(f.dataDir, "repair-sessions", session.body.id + ".json");
    const initial = await readFile(pathFile, "utf8");
    // A revoked/scope-changed operator cannot mutate an existing ledger.
    await assert.rejects(advanceRepairSession(f.dataDir, session.body.id, {
      action: "patch", consent: true, digest: "d".repeat(64),
      paths: ["src/backend/domain/Item.cs"],
    }, "editor", async () => {
      await stat(path.join(f.dataDir, "jobs", ".admission"));
      await saveAtomic(f.file, render(entries(rotatedKey)));
      await reauthorizeRepairMutation(f.file, runnerKey,
        "Bearer " + originalKey, "editor", "patch");
    }), { code: "REPAIR_AUTH_REVOKED" });
    assert.equal(await readFile(pathFile, "utf8"), initial);
    assert.equal((await f.request(1, route, originalKey)).status, 401);
    // Same ID with a new credential can still continue after the rejected mutation.
    const patched = await f.request(1, route + "/checkpoints", rotatedKey, {
      action: "patch", consent: true, digest: "d".repeat(64),
      paths: ["src/backend/domain/Item.cs"],
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.audit.length, 2);
    const patchedDisk = await readFile(pathFile, "utf8");
    // Server-side HTTP request starts with a valid reviewer Bearer, but waits
    // for the shared lock while the private registry rotates.
    const lock = path.join(f.dataDir, "jobs", ".admission");
    await mkdir(lock, { mode: 0o700 });
    let pending;
    try {
      pending = f.request(0, route + "/checkpoints", reviewerKey,
        { action: "review", consent: true, verdict: "pass" });
      await sleep(100);
      await saveAtomic(f.file, render(entries(rotatedKey, true, rotatedReviewerKey)));
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
    assert.equal((await pending).status, 401);
    assert.equal(await readFile(pathFile, "utf8"), patchedDisk);
    const approvedReview = await f.request(1, route + "/checkpoints", rotatedReviewerKey,
      { action: "review", consent: true, verdict: "pass" });
    assert.equal(approvedReview.status, 200);
    assert.deepEqual(approvedReview.body.audit.map(x => x.actorId),
      ["editor", "editor", "reviewer"]);
    await saveAtomic(f.file, render([{ id: "editor", key: rotatedKey,
      roles: ["review"] }, { id: "reviewer", key: rotatedReviewerKey,
      roles: ["review"] }]));
    await assert.rejects(reauthorizeRepairMutation(f.file, runnerKey,
      "Bearer " + rotatedKey, "editor", "patch"), { code: "REPAIR_SCOPE_REVOKED" });
    await saveAtomic(f.file, "{broken");
    await assert.rejects(reauthorizeRepairMutation(f.file, runnerKey,
      "Bearer " + rotatedKey, "editor", "patch"), { code: "REPAIR_AUTH_UNAVAILABLE" });
    assert.equal((await f.request(0, "/v1/capabilities", runnerKey)).status, 200);
  } finally { await f.close(); }
});

test("registry failure and invalid replacement fail closed in both APIs without disabling normal jobs", async () => {
  const f = await environment();
  try {
    await saveAtomic(f.file, render(entries()));
    assert.equal((await f.request(0, "/v1/repair-sessions", originalKey)).status, 404);
    await saveAtomic(f.file, "{incomplete");
    for (const index of [0, 1]) {
      const err = await f.request(index, "/v1/repair-sessions", originalKey);
      assert.deepEqual(err, { status: 503, body: { error: "repair_auth_unavailable" } });
      assert.equal((await f.request(index, "/v1/capabilities", runnerKey)).status, 200);
    }
    await chmod(f.file, 0o666);
    assert.equal((await f.request(1, "/v1/repair-sessions", originalKey)).status, 503);
    await rm(f.file);
    assert.equal((await f.request(0, "/v1/repair-sessions", originalKey)).status, 503);
    await saveAtomic(f.file, render(entries()));
    assert.equal((await f.request(1, "/v1/repair-sessions", originalKey)).status, 404);
  } finally { await f.close(); }
});

test("ambiguous startup configuration rejects file+inline and nonabsolute file paths", () => {
  const base = { apiKey: runnerKey, allowedOrigins: [origin] };
  assert.throws(() => createRunnerServer({ ...base,
    repairOperators: render(entries()), repairOperatorsFile: "/run/secrets/operators.json",
  }), /only one repair operator source/);
  assert.throws(() => createRunnerServer({ ...base,
    repairOperators: "", repairOperatorsFile: "relative/operators.json",
  }), /absolute path/);
  assert.throws(() => createRunnerServer({ ...base,
    repairOperators: "", repairOperatorsFile: "/tmp/x\0bad",
  }), /absolute path/);
});


test("operator snapshot is pinned to one secure inode and unchanged permission, size and timestamps", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-operator-stable-"));
  const file = path.join(dir, "operators.json");
  try {
    await writeFile(file, render(entries()), { mode: 0o600 });
    const before = await stat(file);
    assert.equal(isStableRepairOperatorSnapshot(before, before), true);
    const fake = { ...before, isFile: () => true };
    for (const change of [
      { ino: before.ino + 1 }, { dev: before.dev + 1 },
      { size: before.size + 1 }, { mode: before.mode | 0o020 },
      { nlink: 2 }, { uid: before.uid + 1 },
      { ctimeMs: before.ctimeMs + 1 }, { mtimeMs: before.mtimeMs + 1 },
    ]) {
      assert.equal(isStableRepairOperatorSnapshot(before, { ...fake, ...change }), false,
        JSON.stringify(change));
    }
    assert.equal((await loadRepairOperatorsFile(file, runnerKey)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("operator registry rejects same-length valid in-place rewrite while reading and accepts atomic rename on next request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-operator-inplace-"));
  const file = path.join(dir, "operators.json");
  const old = render(entries());
  const updated = old.replace('"editor"', '"author"');
  assert.equal(updated.length, old.length);
  try {
    await writeFile(file, old, { mode: 0o600 });
    let mutated = false;
    const openFile = async (filename, flags) => {
      const descriptor = await open(filename, flags);
      return {
        stat: () => descriptor.stat(),
        read: async (...args) => {
          if (!mutated) {
            mutated = true;
            // Rewriting the open inode, not an atomic rename, must be denied
            // even if the final JSON is still valid and has the same length.
            const writer = await open(file, "r+");
            try { await writer.writeFile(updated); }
            finally { await writer.close(); }
          }
          return descriptor.read(...args);
        },
        close: () => descriptor.close(),
      };
    };
    await assert.rejects(loadRepairOperatorsFile(file, runnerKey, { openFile }),
      { code: "REPAIR_AUTH_UNAVAILABLE" });
    assert.equal(mutated, true);
    assert.equal((await loadRepairOperatorsFile(file, runnerKey))[0].id, "author");

    // Atomic rename swaps a whole credential file on the NEXT request.
    await saveAtomic(file, old);
    assert.equal((await loadRepairOperatorsFile(file, runnerKey))[0].id, "editor");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("operator registry rejects early EOF, appended bytes and permission/link changes during descriptor read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sf-operator-read-races-"));
  const file = path.join(root, "operators.json");
  const alias = path.join(root, "operators.hard");
  const original = render(entries());
  try {
    for (const fault of ["eof", "truncate", "append", "chmod", "link"]) {
      await rm(file, { force: true });
      await rm(alias, { force: true });
      await writeFile(file, original, { mode: 0o600 });
      let injected = false;
      const openFile = async (filename, flags) => {
        const descriptor = await open(filename, flags);
        return {
          stat: () => descriptor.stat(),
          read: async (...args) => {
            if (!injected) {
              injected = true;
              if (fault === "eof") return { bytesRead: 0 };
              if (fault === "truncate") await writeFile(file, "", { flag: "w" });
              if (fault === "append") await writeFile(file, " ", { flag: "a" });
              if (fault === "chmod") await chmod(file, 0o644);
              if (fault === "link") await link(file, alias);
            }
            return descriptor.read(...args);
          },
          close: () => descriptor.close(),
        };
      };
      await assert.rejects(loadRepairOperatorsFile(file, runnerKey, { openFile }),
        { code: "REPAIR_AUTH_UNAVAILABLE" }, fault);
      assert.equal(injected, true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
