/**
 * GitHub-hosted CI ONLY: real Chromium -> React/Vite -> ASP.NET Core.
 * Unique --internal Docker bridge without published host ports.
 * Do not put this Docker host-socket orchestrator in the public runner API.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, randomBytes } from "node:crypto";
import { access, readFile, writeFile, mkdtemp, chmod, rm, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { setTimeout as sleep } from "node:timers/promises";
import { planStep, runDockerStep, PLAYWRIGHT_VERSION } from "../docker.mjs";
import { verifyFullstackPlaywrightOutcome } from "./fullstack-playwright-gate.mjs";

const exec = promisify(execFile);
const root = path.resolve(process.argv[2] || "src/frontend/generated-fixture");
const uid = process.getuid?.(), gid = process.getgid?.();
if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw Error("Linux UID/GID required");
if (root.includes(",") || /[\r\n:]/.test(root)) throw Error("Unsafe workspace path for Docker bind");
const network = "sf-int-" + randomUUID().replaceAll("-", "").slice(0, 16);
const apiName = network + "-api", webName = network + "-web", dbName = network + "-db", idpName = network + "-identity", cspName = network + "-csp";
const tlsIdpName = network + "-identity-tls", tlsApiName = network + "-api-tls",
  untrustedApiName = network + "-api-untrusted";
const dbPassword = randomBytes(24).toString("hex");
const idpControl = randomBytes(40).toString("hex");
const tlsIdpControl = randomBytes(40).toString("hex");
const idpFixturePath = path.resolve("src/runner/scripts/oidc-ci-provider.mjs");
const transportPath = path.resolve("src/runner/scripts/oidc-ci-transport.mjs");
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
let networkCreated = false, startedApi = false, startedWeb = false, startedDb = false,
  startedIdp = false, startedCsp = false, startedTlsIdp = false,
  startedTlsApi = false, startedUntrustedApi = false, tlsDirectory = null;
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

  await docker(["run", "-d", "--name", idpName, "--network", network,
    "--network-alias", "identity", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--memory=256m", "--cpus=1", "--pids-limit=96",
    "--user=" + uid + ":" + gid, "--tmpfs=/tmp:rw,nosuid,nodev,size=32m",
    "--mount", "type=bind,src=" + idpFixturePath + ",dst=/provider.mjs,readonly",
    "--mount", "type=bind,src=" + transportPath + ",dst=/oidc-ci-transport.mjs,readonly",
    "--env=CI=true", "--env=OIDC_CI_SECRET=" + idpControl,
    "--env=OIDC_ISSUER=http://identity:8999", "--env=OIDC_CLIENT_ID=factory-web",
    "--env=OIDC_AUDIENCE=factory-client",
    "--env=OIDC_REDIRECT_URI=http://127.0.0.1:4173/auth/callback",
    "--env=OIDC_ALLOWED_ORIGIN=http://127.0.0.1:4173",
    "node:22-bookworm-slim", "node", "/provider.mjs"]);
  startedIdp = true;
  let idpReady = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await docker(["exec", idpName, "node", "-e",
        'fetch("http://127.0.0.1:8999/.well-known/openid-configuration",{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'],
        { timeout: 6000 });
      idpReady = true; break;
    } catch { await sleep(500); }
  }
  if (!idpReady) throw Error("Ephemeral OIDC issuer readiness timed out");

  await docker(["run", "-d", "--name", apiName, "--network-alias", "api",
    ...common,
    "--env=ASPNETCORE_URLS=http://0.0.0.0:8080",
    "--env=ASPNETCORE_ENVIRONMENT=Development",
    "--env=Auth__Mode=oidc",
    "--env=Auth__Authority=http://identity:8999",
    "--env=Auth__Audience=factory-client",
    "--env=Database__Provider=postgresql",
    "--env=Database__ConnectionString=Host=db;Port=5432;Database=app;Username=app;Password=" + dbPassword,
    "mcr.microsoft.com/dotnet/aspnet:" + framework + ".0",
    "dotnet", "src/backend/applications/Api/bin/Release/net" + framework + ".0/Api.dll"]);
  startedApi = true;
  await docker(["run", "-d", "--name", webName, "--network-alias", "web",
    ...common,
    "--env=VITE_API_URL=http://api:8080",
    "--env=VITE_OIDC_AUTHORITY=http://identity:8999",
    "--env=VITE_OIDC_CLIENT_ID=factory-web",
    "--env=VITE_OIDC_AUDIENCE=factory-client",
    "--mount", "type=bind,src=" + path.resolve("src/runner/scripts/oidc-protocol-smoke.mjs") + ",dst=/ci-protocol.mjs,readonly",
    "--mount", "type=bind,src=" + path.resolve("src/runner/scripts/oidc-api-rollover-smoke.mjs") + ",dst=/ci-api-rollover.mjs,readonly",
    "--env=NPM_CONFIG_CACHE=/tmp/.npm",
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
  async function mint(subject, role, type = "") {
    const code = 'const u="http://identity:8999/__ci/mint?sub="+encodeURIComponent(process.argv[1])+"&role="+encodeURIComponent(process.argv[2])+"&type="+encodeURIComponent(process.argv[3]);fetch(u,{headers:{"x-ci-secret":process.env.OIDC_CI_SECRET}}).then(async r=>{if(!r.ok)throw Error("mint status "+r.status);process.stdout.write((await r.json()).access_token)}).catch(()=>process.exit(1))';
    return await docker(["exec", "-e", "OIDC_CI_SECRET=" + idpControl,
      webName, "node", "-e", code, subject, role, type], { timeout: 12000 });
  }

  // Use the exact CSP builder shipped by the scaffold. Never expose host ports.
  const webRoot = path.join(root, "src/frontend/web");
  const cspEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, CI: "true", SF_CSP_INTERNAL_TEST: "true",
    VITE_API_URL: "http://api:8080", VITE_OIDC_AUTHORITY: "http://identity:8999",
    VITE_OIDC_CLIENT_ID: "factory-web", VITE_OIDC_AUDIENCE: "factory-client",
  };
  const cspArgs = ["scripts/build-nginx.mjs"];
  const cspOptions = { cwd: webRoot, env: cspEnv, timeout: 10000 };
  await exec("node", cspArgs, cspOptions);
  for (const unsafe of [
    { VITE_API_URL: 'https://api.example.com"; add_header X-Evil true' },
    { VITE_OIDC_AUTHORITY: "http://remote.example" },
    { VITE_OIDC_AUTHORITY: "https://issuer.example/realm?redirect=unsafe" },
  ]) {
    await assert.rejects(exec("node", cspArgs, {
      ...cspOptions, env: { ...cspEnv, SF_CSP_INTERNAL_TEST: "false", ...unsafe },
    }), "Unsafe CSP origin must fail at build time");
  }
  const cspConfig = await readFile(path.join(webRoot, "nginx.conf"), "utf8");
  assert.match(cspConfig, /script-src 'self'/);
  assert.match(cspConfig, /connect-src 'self' http:\/\/api:8080 http:\/\/identity:8999/);
  assert.doesNotMatch(cspConfig, /script-src[^;]*unsafe-inline/);
  await access(path.join(webRoot, "dist/index.html"));
  // Validate the real configuration before starting a long-lived Nginx process.
  // Keep all host ports closed and mount only a read-only config and compiled dist.
  await docker(["run", "--rm", "--network", network, "--read-only",
    "--tmpfs=/var/cache/nginx:rw,nosuid,nodev,size=16m",
    "--tmpfs=/var/run:rw,nosuid,nodev,size=4m",
    "--mount", "type=bind,src=" + path.join(webRoot, "nginx.conf") + ",dst=/etc/nginx/conf.d/default.conf,readonly",
    "--mount", "type=bind,src=" + path.join(webRoot, "dist") + ",dst=/usr/share/nginx/html,readonly",
    "--entrypoint=nginx", "nginx:1.27-alpine", "-t"], { timeout: 10000 });
  await docker(["run", "-d", "--name", cspName, "--network", network,
    "--network-alias", "secure-web", "--read-only", "--cap-drop=ALL",
    "--cap-add=NET_BIND_SERVICE", "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=CHOWN",
    // Official Nginx master needs these to bind 80 and switch worker UID.
    "--security-opt=no-new-privileges", "--memory=160m", "--cpus=0.5", "--pids-limit=64",
    "--tmpfs=/var/cache/nginx:rw,nosuid,nodev,size=16m",
    "--tmpfs=/var/run:rw,nosuid,nodev,size=4m",
    "--mount", "type=bind,src=" + path.join(webRoot, "nginx.conf") + ",dst=/etc/nginx/conf.d/default.conf,readonly",
    "--mount", "type=bind,src=" + path.join(webRoot, "dist") + ",dst=/usr/share/nginx/html,readonly",
    "nginx:1.27-alpine"]);
  startedCsp = true;
  let cspReady = false;
  let cspProbeFailure = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await docker(["exec", webName, "node", "-e",
        'fetch("http://secure-web/auth/callback",{signal:AbortSignal.timeout(2000)}).then(r=>{if(r.ok&&r.headers.get("content-security-policy"))return process.exit(0);console.error("NGINX_PROBE_STATUS",r.status,"csp",Boolean(r.headers.get("content-security-policy")));process.exit(1)}).catch(e=>{console.error("NGINX_PROBE_ERROR",e.cause?.code||e.name);process.exit(1)})'
      ], { timeout: 6000 });
      cspReady = true; break;
    } catch (error) {
      cspProbeFailure = String(error.stderr || error.message).slice(-800);
      await sleep(400);
    }
  }
  if (!cspReady) {
    const cspState = await docker(["inspect", "--format", "{{.State.Status}} exit={{.State.ExitCode}}", cspName])
      .catch(error => String(error.message).slice(-200));
    const nginxLocal = await docker(["exec", cspName, "wget", "-q", "-O", "/dev/null",
      "http://127.0.0.1/auth/callback"])
      .then(() => "ok", error => String(error.stderr || error.message).slice(-400));
    throw Error("Nginx CSP readiness timed out: state=" + cspState + ", localhost=" + nginxLocal
      + ", remote=" + cspProbeFailure);
  }

  const editorToken = await mint("owner-a", "editor");
  const readerToken = await mint("owner-a", "reader");
  const otherToken = await mint("owner-b", "editor");
  const badAudienceToken = await mint("owner-a", "editor", "wrong-audience");
  const expiredToken = await mint("owner-a", "editor", "expired");
  const missingRoleToken = await mint("owner-a", "none");
  const emptySubjectToken = await mint("owner-a", "editor", "empty-sub");
  const missingSubjectToken = await mint("owner-a", "editor", "missing-sub");
  const basePlan = planStep("playwright", files, root, {
    RUNNER_CONTAINER_UID: uid + ":" + gid,
    RUNNER_PLAYWRIGHT_IMAGE: "mcr.microsoft.com/playwright:v" + PLAYWRIGHT_VERSION + "-noble",
  });
  if (basePlan.skip) throw Error("Playwright plan skipped: " + basePlan.skip);
  const args = [...basePlan.args];
  // The private Factory integration launches two concurrent Chromium tabs to
  // verify BroadcastChannel propagation. Increase ONLY this CI fixture's
  // resources, not the public rootless runner's default execution limits.
  for (const [original, ciOverride] of [
    ["--memory=1024m", "--memory=2048m"],
    ["--pids-limit=128", "--pids-limit=256"],
    ["--shm-size=256m", "--shm-size=512m"],
  ]) {
    const index = args.indexOf(original);
    assert.ok(index >= 0, "Expected default Playwright sandbox resource flag " + original);
    args[index] = ciOverride;
  }
  const networkFlag = args.indexOf("--network");
  assert.ok(networkFlag >= 0 && args[networkFlag + 1] === "none");
  args[networkFlag + 1] = network;
  args.splice(args.indexOf(basePlan.image), 0,
    "--env=E2E_MODE=integration",
    "--env=E2E_CSP_ORIGIN=http://secure-web",
    "--env=E2E_DATABASE=postgresql",
    "--env=E2E_AUTH_MODE=oidc",
    "--env=E2E_AUTH_TOKEN=" + editorToken,
    "--env=E2E_READER_TOKEN=" + readerToken,
    "--env=E2E_OTHER_TOKEN=" + otherToken,
    "--env=E2E_BAD_AUD_TOKEN=" + badAudienceToken,
    "--env=E2E_EXPIRED_TOKEN=" + expiredToken,
    "--env=E2E_MISSING_ROLE_TOKEN=" + missingRoleToken,
    "--env=E2E_EMPTY_SUB_TOKEN=" + emptySubjectToken,
    "--env=E2E_MISSING_SUB_TOKEN=" + missingSubjectToken,
    "--env=E2E_API_ORIGIN=http://api:8080",
    "--env=E2E_WEB_ORIGIN=http://127.0.0.1:4173",
    "--env=VITE_API_URL=http://api:8080",
    "--env=VITE_OIDC_AUTHORITY=http://identity:8999",
    "--env=VITE_OIDC_CLIENT_ID=factory-web",
    "--env=VITE_OIDC_AUDIENCE=factory-client",
    "--env=E2E_WEB_SERVER_EXTERNAL=false",
  );
  assert.ok(!args.some(a => a.startsWith("-p") || a.startsWith("--publish")));
  // Trusted rootful GitHub-hosted CI exception for the fullstack test only.
  // Production runner-worker uses the default rootless guard on every step.
  const ciRootfulSmokeProbe = async () => {
    assert.equal(process.env.GITHUB_ACTIONS, "true");
    assert.equal(process.env.CI, "true");
    assert.notEqual(uid, 0);
    return true;
  };
  const outcome = await runDockerStep({ ...basePlan, args }, runId, "fullstack", {
    probeDocker: ciRootfulSmokeProbe,
  });
  let verifiedBrowserTests;
  try {
    verifiedBrowserTests = verifyFullstackPlaywrightOutcome(
      files["src/frontend/web/e2e/smoke.spec.ts"], outcome);
  } catch {
    console.error("FULLSTACK_INTEGRATION_FAILED", JSON.stringify(outcome, null, 2));
    const snippet = typeof outcome.stdout === "string"
      ? outcome.stdout.match(/OIDC_BROWSER_STAGE[^\\n]*/g) || [] : [];
    console.error("OIDC_BROWSER_DIAGNOSTICS", snippet.slice(-4));
    throw Error("Playwright integration did not pass every declared scenario, including OIDC browser refresh, CORS and PostgreSQL persistence");
  }
  for (const [action, min] of [["create", 2], ["update", 1], ["delete", 2]]) {
    const count = Number(await docker(["exec", dbName, "psql", "-U", "app", "-d", "app",
      "-tAc", "SELECT count(*) FROM work_item_audit WHERE owner_id='owner-a' AND action='" + action + "'"]));
    assert.ok(count >= min, "Transactional PostgreSQL audit missing " + action + " events");
  }
  const secretArg = 'fetch("http://identity:8999/__ci/stats",{headers:{"x-ci-secret":process.env.OIDC_CI_SECRET}}).then(r=>r.json()).then(s=>process.stdout.write(JSON.stringify(s))).catch(()=>process.exit(1))';
  const idpStats = JSON.parse(await docker(["exec", "-e", "OIDC_CI_SECRET=" + idpControl,
    webName, "node", "-e", secretArg]));
  assert.ok(idpStats.redeemed >= 1, "OIDC PKCE authorization code never redeemed");
  assert.ok(idpStats.refreshed >= 1, "OIDC browser never used refresh-token rotation");
  assert.ok(idpStats.logout >= 1, "OIDC browser never reached federated logout endpoint");
  // Run before the standalone protocol smoke: this must exercise the API's first
  // hot JWKS refresh while its original key is still cached in the same process.
  const rolloverPath = path.resolve("src/runner/scripts/oidc-api-rollover-smoke.mjs");
  await access(rolloverPath);
  const rollover = await docker(["exec", "-e", "OIDC_CI_SECRET=" + idpControl,
    webName, "node", "/ci-api-rollover.mjs"], { timeout: 60000 });
  assert.match(rollover, /OIDC_API_JWKS_ROLLOVER_PASS/);
  console.log(rollover);
  const protocolPath = path.resolve("src/runner/scripts/oidc-protocol-smoke.mjs");
  await access(protocolPath);
  const protocol = await docker(["exec", "-e", "OIDC_CI_SECRET=" + idpControl,
    webName, "node", "/ci-protocol.mjs"], { timeout: 20000 });
  assert.match(protocol, /OIDC_PROTOCOL_SMOKE_PASS/);
  console.log(protocol);
  // Production-only HTTPS/JWKS exercise: a fresh private CA and issuer SAN
  // are created OUTSIDE the generated workspace. Only the private CI network
  // sees these containers; no host ports and no TLS validation bypasses.
  tlsDirectory = await mkdtemp(path.join(tmpdir(), "sf-ci-oidc-tls-"));
  const caKey = path.join(tlsDirectory, "ca.key");
  const caCrt = path.join(tlsDirectory, "ca.crt");
  const serverKey = path.join(tlsDirectory, "server.key");
  const serverReq = path.join(tlsDirectory, "server.csr");
  const serverCrt = path.join(tlsDirectory, "server.crt");
  const extensions = path.join(tlsDirectory, "server.ext");
  await writeFile(extensions,
    "subjectAltName=DNS:identity-tls\nextendedKeyUsage=serverAuth\n" +
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n",
    { mode: 0o600 });
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048",
    "-nodes", "-days", "1", "-sha256", "-keyout", caKey,
    "-out", caCrt, "-subj", "/CN=SoftwareFactory ephemeral CI CA"],
    { timeout: 25000, maxBuffer: 10000 });
  await exec("openssl", ["req", "-new", "-newkey", "rsa:2048",
    "-nodes", "-sha256", "-keyout", serverKey,
    "-out", serverReq, "-subj", "/CN=identity-tls"],
    { timeout: 25000, maxBuffer: 10000 });
  await exec("openssl", ["x509", "-req", "-in", serverReq,
    "-CA", caCrt, "-CAkey", caKey, "-CAcreateserial",
    "-out", serverCrt, "-days", "1", "-sha256", "-extfile", extensions],
    { timeout: 15000, maxBuffer: 10000 });
  await exec("openssl", ["verify", "-CAfile", caCrt, serverCrt],
    { timeout: 10000, maxBuffer: 10000 });
  await Promise.all([caKey, serverKey, serverReq, extensions].map(file =>
    chmod(file, 0o600)));
  // No CA private key is ever mounted into a container.
  // CA certificate and server private key share this private mount, but the
  // CA private key stays on the host and is never used by any service.
  const tlsOnly = path.join(tlsDirectory, "runtime");
  await mkdir(tlsOnly, { mode: 0o700 });
  for (const file of ["ca.crt", "server.crt", "server.key"]) {
    const from = path.join(tlsDirectory, file);
    const into = path.join(tlsOnly, file);
    await copyFile(from, into);
    await chmod(into, file.endsWith(".key") ? 0o600 : 0o644);
  }
  const tlsMount = "type=bind,src=" + tlsOnly + ",dst=/ci-tls,readonly";
  await docker(["run", "-d", "--name", tlsIdpName, "--network", network,
    "--network-alias", "identity-tls", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--pids-limit=96", "--memory=256m", "--cpus=1",
    "--user=" + uid + ":" + gid, "--tmpfs=/tmp:rw,nosuid,nodev,size=32m",
    "--mount", "type=bind,src=" + idpFixturePath + ",dst=/provider.mjs,readonly",
    "--mount", "type=bind,src=" + transportPath + ",dst=/oidc-ci-transport.mjs,readonly",
    "--mount", tlsMount,
    "--env=CI=true", "--env=NODE_EXTRA_CA_CERTS=/ci-tls/ca.crt",
    "--env=OIDC_CI_SECRET=" + tlsIdpControl,
    "--env=OIDC_ISSUER=https://identity-tls:9443",
    "--env=OIDC_CLIENT_ID=factory-web", "--env=OIDC_AUDIENCE=factory-client",
    "--env=OIDC_REDIRECT_URI=http://127.0.0.1:4173/auth/callback",
    "--env=OIDC_ALLOWED_ORIGIN=http://127.0.0.1:4173",
    "node:22-bookworm-slim", "node", "/provider.mjs"]);
  startedTlsIdp = true;
  let trustedIssuerReady = false;
  for (let attempt = 0; attempt < 35; attempt++) {
    try {
      await docker(["exec", tlsIdpName, "node", "-e",
        'fetch("https://identity-tls:9443/.well-known/openid-configuration",{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
      ], { timeout: 6000 });
      trustedIssuerReady = true; break;
    } catch { await sleep(350); }
  }
  if (!trustedIssuerReady) throw Error("Private HTTPS OIDC issuer failed verified TLS readiness");

  const productionApi = async (name, alias, trustCA) =>
    docker(["run", "-d", "--name", name, "--network-alias", alias, ...common,
      ...(trustCA ? ["--mount", tlsMount, "--env=SSL_CERT_FILE=/ci-tls/ca.crt"] : []),
      "--env=ASPNETCORE_URLS=http://0.0.0.0:8080",
      "--env=ASPNETCORE_ENVIRONMENT=Production",
      "--env=Auth__Mode=oidc",
      "--env=Auth__Authority=https://identity-tls:9443",
      "--env=Auth__Audience=factory-client",
      "--env=Web__AllowedOrigins=https://app.example.test",
      "--env=Database__Provider=postgresql",
      "--env=Database__ConnectionString=Host=db;Port=5432;Database=app;Username=app;Password=" + dbPassword,
      "mcr.microsoft.com/dotnet/aspnet:" + framework + ".0",
      "dotnet", "src/backend/applications/Api/bin/Release/net" + framework + ".0/Api.dll"]);
  await productionApi(tlsApiName, "api-tls", true);
  startedTlsApi = true;
  await productionApi(untrustedApiName, "api-untrusted", false);
  startedUntrustedApi = true;
  let productionReady = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await docker(["exec", webName, "node", "-e",
        'Promise.all(["http://api-tls:8080/health","http://api-untrusted:8080/health"].map(u=>fetch(u,{signal:AbortSignal.timeout(2500)}))).then(r=>process.exit(r.every(x=>x.ok)?0:1)).catch(()=>process.exit(1))'
      ], { timeout: 7500 });
      productionReady = true; break;
    } catch { await sleep(450); }
  }
  if (!productionReady) throw Error("Both isolated Production ASP.NET Core APIs must start");

  // A client WITHOUT the ephemeral CA must fail the TLS handshake/hostname
  // verification. Success would invalidate the trust-boundary test.
  await assert.rejects(docker(["run", "--rm", "--network", network,
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--user=" + uid + ":" + gid, "--memory=128m", "--pids-limit=64",
    "node:22-bookworm-slim", "node", "-e",
    'fetch("https://identity-tls:9443/.well-known/openid-configuration",{signal:AbortSignal.timeout(3500)}).then(()=>process.exit(0)).catch(()=>process.exit(17))'
  ], { timeout: 12000 }), "A client without the CA must reject the HTTPS issuer");

  // Replay the real .NET JWT+JWKS rollover/RBAC test against both Production
  // API instances. The untrusted API must answer 401 to a correctly signed
  // token while the API with CA trust accepts the SAME signing key.
  const tlsRollover = await docker(["run", "--rm", "--network", network,
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--user=" + uid + ":" + gid, "--memory=192m", "--pids-limit=80",
    "--mount", tlsMount,
    "--mount", "type=bind,src=" + rolloverPath + ",dst=/ci-api-rollover.mjs,readonly",
    "--env=CI=true",
    "--env=OIDC_CI_SECRET=" + tlsIdpControl,
    "--env=NODE_EXTRA_CA_CERTS=/ci-tls/ca.crt",
    "--env=OIDC_TEST_TRANSPORT=private-tls",
    "node:22-bookworm-slim", "node", "/ci-api-rollover.mjs"
  ], { timeout: 95000 });
  assert.match(tlsRollover, /OIDC_PRODUCTION_HTTPS_CA_PASS/);
  console.log(tlsRollover);
  console.log("FULLSTACK_OIDC_POSTGRES_PASS: " + verifiedBrowserTests + " Chromium tests with CORS, multi-tab logout, Nginx CSP, OIDC browser refresh/logout, live ASP.NET Core JWKS rollover, RS256 PKCE login, JWT role/owner isolation and audit");
} catch(e) {
  console.error("FULLSTACK_INTEGRATION_ERROR:", String(e.message || e));
  if (startedApi) console.error("API logs:", await logs(apiName));
  if (startedWeb) console.error("Web logs:", await logs(webName));
  if (startedDb) console.error("DB logs:", await logs(dbName));
  if (startedIdp) console.error("OIDC fixture logs:", await logs(idpName));
  if (startedCsp) console.error("Nginx CSP logs:", await logs(cspName));
  process.exitCode = 1;
} finally {
  if (startedTlsApi) await docker(["rm", "-f", tlsApiName]).catch(() => {});
  if (startedUntrustedApi) await docker(["rm", "-f", untrustedApiName]).catch(() => {});
  if (startedTlsIdp) await docker(["rm", "-f", tlsIdpName]).catch(() => {});
  if (startedWeb) await docker(["rm", "-f", webName]).catch(() => {});
  if (startedCsp) await docker(["rm", "-f", cspName]).catch(() => {});
  if (startedApi) await docker(["rm", "-f", apiName]).catch(() => {});
  if (startedDb) await docker(["rm", "-f", dbName]).catch(() => {});
  if (startedIdp) await docker(["rm", "-f", idpName]).catch(() => {});
  if (networkCreated) await docker(["network", "rm", network]).catch(e => {
    console.error("Cleanup network failed:", String(e.message));
    process.exitCode = 1;
  });
  if (tlsDirectory) await rm(tlsDirectory, { recursive: true, force: true });
}
