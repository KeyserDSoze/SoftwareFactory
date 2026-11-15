import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { jobDirectory, readReport, validateRequest, isAllowedFile, authenticate, scrub, atomicWrite } from "../common.mjs";
import { createRunnerServer } from "../api.mjs";
import { planStep, planWebDependencies, validateNpmManifest, isInfrastructureFailure } from "../docker.mjs";
import { executeJob, runWorker } from "../worker.mjs";

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
        state, label: "orphan", acceptedAt: new Date().toISOString(), results: [], steps: checked.request.steps });
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
    assert.equal((await readReport(dataDir, orphan)).state, "failed",
      "manual removal of orphan claim allows failure recovery, never automatic retry");
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
