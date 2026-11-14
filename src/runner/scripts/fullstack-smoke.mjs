/**
 * GitHub-hosted CI ONLY: real Chromium -> React/Vite -> ASP.NET Core.
 * Unique --internal Docker bridge without published host ports.
 * Do not put this Docker host-socket orchestrator in the public runner API.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, randomBytes } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { planStep, runDockerStep, PLAYWRIGHT_VERSION } from "../docker.mjs";

const exec = promisify(execFile);
const root = path.resolve(process.argv[2] || "src/frontend/generated-fixture");
const uid = process.getuid?.(), gid = process.getgid?.();
if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw Error("Linux UID/GID required");
if (root.includes(",") || /[\r\n:]/.test(root)) throw Error("Unsafe workspace path for Docker bind");
const network = "sf-int-" + randomUUID().replaceAll("-", "").slice(0, 16);
const apiName = network + "-api", webName = network + "-web", dbName = network + "-db";
const dbPassword = randomBytes(24).toString("hex");
const runId = randomUUID();
const mount = "type=bind,src=" + root + ",dst=/work";
const framework = (await readFile(path.join(root, "src/backend/applications/Api/Api.csproj"), "utf8"))
  .match(/<TargetFramework>net(10|11)\.0<\/TargetFramework>/)?.[1];
if (!framework) throw Error("Unsupported .NET target framework");
await access(path.join(root, "src/backend/applications/Api/bin/Release/net" + framework + ".0/Api.dll"));
await access(path.join(root, "src/frontend/web/node_modules/.bin/playwright"));
const names = ["src/frontend/web/package.json", "src/frontend/web/playwright.config.ts",
  "src/frontend/web/e2e/smoke.spec.ts"];
const files = Object.fromEntries(await Promise.all(names.map(async name =>
  [name, await readFile(path.join(root, name), "utf8")])));
const common = [
  "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
  "--pids-limit=128", "--memory=1024m", "--cpus=1",
  "--user=" + uid + ":" + gid, "--tmpfs=/tmp:rw,nosuid,nodev,size=128m",
  "--mount", mount, "--workdir=/work", "--network", network,
  "--env=HOME=/tmp", "--env=DOTNET_CLI_HOME=/tmp", "--env=CI=true",
];
async function docker(args, opts = {}) {
  return (await exec("docker", args, {
    timeout: opts.timeout || 20_000, maxBuffer: 256_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      DOCKER_HOST: process.env.DOCKER_HOST || "unix:///var/run/docker.sock" },
  })).stdout.trim();
}
const logs = async name => {
  try { return (await docker(["logs", "--tail", "65", name])).slice(-6000); }
  catch(e) { return String(e.stderr || e.message).slice(-1500); }
};
let networkCreated = false, startedApi = false, startedWeb = false, startedDb = false;
try {
  await docker(["network", "create", "--driver", "bridge", "--internal",
    "--label", "softwarefactory.ci=integration", network]);
  networkCreated = true;
  const inspect = JSON.parse(await docker(["network", "inspect", network]));
  assert.equal(inspect[0].Internal, true, "Network must deny external routing");
  assert.equal(inspect[0].Driver, "bridge");
  await docker(["run", "-d", "--name", dbName, "--network", network,
    "--network-alias", "db", "--memory=768m", "--cpus=1", "--pids-limit=128",
    "--security-opt=no-new-privileges", "--env=POSTGRES_USER=app",
    "--env=POSTGRES_DB=app", "--env=POSTGRES_PASSWORD=" + dbPassword,
    "postgres:17-alpine"]);
  startedDb = true;
  let databaseReady = false;
  for (let attempt = 0; attempt < 55; attempt++) {
    try {
      await docker(["exec", dbName, "pg_isready", "-U", "app", "-d", "app"], { timeout: 6000 });
      databaseReady = true;
      break;
    } catch { await sleep(800); }
  }
  if (!databaseReady) throw Error("PostgreSQL readiness timed out");

  await docker(["run", "-d", "--name", apiName, "--network-alias", "api",
    ...common,
    "--env=ASPNETCORE_URLS=http://0.0.0.0:8080",
    "--env=ASPNETCORE_ENVIRONMENT=Development",
    "--env=Database__Provider=postgresql",
    "--env=Database__ConnectionString=Host=db;Port=5432;Database=app;Username=app;Password=" + dbPassword,
    "mcr.microsoft.com/dotnet/aspnet:" + framework + ".0",
    "dotnet", "src/backend/applications/Api/bin/Release/net" + framework + ".0/Api.dll"]);
  startedApi = true;
  await docker(["run", "-d", "--name", webName, "--network-alias", "web",
    ...common,
    "--env=VITE_API_URL=http://api:8080", "--env=NPM_CONFIG_CACHE=/tmp/.npm",
    "node:22-bookworm-slim",
    "npm", "run", "dev", "--prefix", "src/frontend/web", "--",
    "--host", "0.0.0.0", "--port", "4173", "--strictPort"]);
  startedWeb = true;
  let ready = false;
  for (let attempt = 0; attempt < 55; attempt++) {
    try {
      await docker(["exec", webName, "node", "-e",
        'Promise.all(["http://api:8080/health","http://web:4173"].map(u=>fetch(u,{signal:AbortSignal.timeout(2000)}))).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))'
      ], { timeout: 6000 });
      ready = true;
      break;
    } catch {
      await sleep(800);
    }
  }
  if (!ready) throw Error("Private-network API/Vite readiness timed out");
  const basePlan = planStep("playwright", files, root, {
    RUNNER_CONTAINER_UID: uid + ":" + gid,
    RUNNER_PLAYWRIGHT_IMAGE: "mcr.microsoft.com/playwright:v" + PLAYWRIGHT_VERSION + "-noble",
  });
  if (basePlan.skip) throw Error("Playwright plan skipped: " + basePlan.skip);
  const args = [...basePlan.args];
  const networkFlag = args.indexOf("--network");
  assert.ok(networkFlag >= 0 && args[networkFlag + 1] === "none");
  args[networkFlag + 1] = network;
  args.splice(args.indexOf(basePlan.image), 0,
    "--env=E2E_MODE=integration",
    "--env=E2E_DATABASE=postgresql",
    "--env=E2E_API_ORIGIN=http://api:8080",
    "--env=E2E_WEB_ORIGIN=http://web:4173",
    "--env=E2E_WEB_SERVER_EXTERNAL=true",
  );
  assert.ok(!args.some(a => a.startsWith("-p") || a.startsWith("--publish")));
  const outcome = await runDockerStep({ ...basePlan, args }, runId, "fullstack");
  if (outcome.state !== "passed" || !/4 passed/.test(outcome.stdout)) {
    console.error("FULLSTACK_INTEGRATION_FAILED", JSON.stringify(outcome, null, 2));
    throw Error("Playwright integration did not pass all 4 assertions, including PostgreSQL persistence");
  }
  console.log("FULLSTACK_POSTGRES_PASS: 4 Chromium tests, live ASP.NET Core and PostgreSQL CRUD on private Docker network");
} catch(e) {
  console.error("FULLSTACK_INTEGRATION_ERROR:", String(e.message || e));
  if (startedApi) console.error("API logs:", await logs(apiName));
  if (startedWeb) console.error("Web logs:", await logs(webName));
  if (startedDb) console.error("DB logs:", await logs(dbName));
  process.exitCode = 1;
} finally {
  if (startedWeb) await docker(["rm", "-f", webName]).catch(() => {});
  if (startedApi) await docker(["rm", "-f", apiName]).catch(() => {});
  if (startedDb) await docker(["rm", "-f", dbName]).catch(() => {});
  if (networkCreated) await docker(["network", "rm", network]).catch(e => {
    console.error("Cleanup network failed:", String(e.message));
    process.exitCode = 1;
  });
}
