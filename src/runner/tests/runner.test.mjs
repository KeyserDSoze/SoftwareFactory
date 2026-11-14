import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { jobDirectory, readReport, validateRequest, isAllowedFile, authenticate, scrub, atomicWrite } from "../common.mjs";
import { createRunnerServer } from "../api.mjs";
import { planStep } from "../docker.mjs";
import { executeJob } from "../worker.mjs";

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
  for (const unsafe of ["../../etc/passwd", "src/backend/domain/../.env", ".github/workflows/ci.yml",
    "src/frontend/web/.npmrc", "src/frontend/web/src/.hidden.ts", "/root/.ssh/id_rsa",
    "src/backend/domain/A.csproj/../../.env", "src/backend/domain/A\\foo.cs"])
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
  assert.equal(planStep("web-build", code, work).command[2].includes("npm install --offline"), true);
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
