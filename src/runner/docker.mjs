import path from "node:path";
import { spawn } from "node:child_process";
import { scrub } from "./common.mjs";

const SAFE_IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{2,180}$/;
const TIME_LIMIT_MS = 120_000;
const PACKAGE_VERSION = /^(?:\^|~|>=?|<=?|=)?\d+(?:\.\d+){0,2}(?:-[a-zA-Z0-9.-]+)?(?:\s*\|\|\s*(?:\^|~|>=?|<=?|=)?\d+(?:\.\d+){0,2}(?:-[a-zA-Z0-9.-]+)?)*$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NODE_IMAGE = "node:22-bookworm-slim";
export const PLAYWRIGHT_VERSION = "1.64.1";

function imageFor(step, files, env) {
  const framework = files["src/backend/applications/Api/Api.csproj"]?.match(/<TargetFramework>net(10|11)\.0<\/TargetFramework>/)?.[1] || "11";
  const image = step.startsWith("dotnet-")
    ? framework === "10"
      ? (env.RUNNER_DOTNET10_IMAGE || "mcr.microsoft.com/dotnet/sdk:10.0")
      : (env.RUNNER_DOTNET11_IMAGE || "mcr.microsoft.com/dotnet/sdk:11.0")
    : step === "playwright"
      ? (env.RUNNER_PLAYWRIGHT_IMAGE || "mcr.microsoft.com/playwright:v" + PLAYWRIGHT_VERSION + "-noble")
      : (env.RUNNER_NODE_IMAGE || NODE_IMAGE);
  if (!SAFE_IMAGE.test(image)) throw new Error("Invalid administrator-configured Docker image");
  return image;
}
export function validateNpmManifest(content) {
  let manifest;
  try { manifest = JSON.parse(content); }
  catch { throw new Error("Invalid npm package.json: not valid JSON"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("Invalid npm package.json: object required");
  // Install is data-only: no lifecycle scripts. Do not allow package escape via
  // file:, git+, http(s), npm aliases, workspaces or override registries.
  for (const field of ["workspaces", "overrides", "resolutions", "bundledDependencies", "bundleDependencies", "publishConfig", "config"]) {
    if (field in manifest) throw new Error("Unsupported npm manifest field: " + field);
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (!(field in manifest)) continue;
    const values = manifest[field];
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 80)
      throw new Error("Invalid npm dependency table: " + field);
    for (const [name, version] of Object.entries(values)) {
      if (!PACKAGE_NAME.test(name) || typeof version !== "string" || !PACKAGE_VERSION.test(version))
        throw new Error("Unsafe or unsupported npm dependency: " + name);
    }
  }
  if ("scripts" in manifest && (!manifest.scripts || typeof manifest.scripts !== "object" ||
      Array.isArray(manifest.scripts) || Object.values(manifest.scripts).some(v => typeof v !== "string")))
    throw new Error("Invalid npm scripts");
  return manifest;
}
function dockerArgs(workdir, image, command, { network = "none", containerUser = "0:0" } = {}) {
  if (!/^\d{1,5}:\d{1,5}$/.test(containerUser)) throw new Error("Invalid container user configuration");
  if (!path.isAbsolute(workdir) || /[\n\r:,]/.test(workdir)) throw new Error("Invalid workdir mount");
  return [
    "run", "--rm", "--init", "--network", network, "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=1024m", "--cpus=1",
    "--user=" + containerUser, "--shm-size=256m",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=128m",
    "--mount", "type=bind,src=" + workdir + ",dst=/work",
    "--workdir=/work", "--env=HOME=/tmp", "--env=DOTNET_CLI_HOME=/tmp",
    "--env=NUGET_PACKAGES=/work/.nuget/packages", "--env=NPM_CONFIG_CACHE=/work/.npm",
    "--env=CI=true", image, ...command,
  ];
}
function createPlan(step, files, workdir, command, env, options = {}) {
  const image = imageFor(step, files, env);
  return { image, command, args: dockerArgs(workdir, image, command, { ...options, containerUser: env.RUNNER_CONTAINER_UID || "0:0" }), timeoutMs: TIME_LIMIT_MS };
}
function webSourcePresent(files) {
  return typeof files["src/frontend/web/package.json"] === "string";
}
export function planStep(step, files, workdir, env = process.env) {
  let command;
  if (step === "dotnet-build") {
    if (!files["src/backend/applications/Api/Api.csproj"]) return { skip: "No backend API project file" };
    command = ["dotnet", "build", "src/backend/applications/Api/Api.csproj", "-c", "Release", "--nologo"];
  } else if (step === "dotnet-test") {
    if (!files["tests/backend/Tests.csproj"]) return { skip: "No tests/backend/Tests.csproj (no .NET tests configured)" };
    command = ["dotnet", "test", "tests/backend/Tests.csproj", "-c", "Release", "--nologo"];
  } else if (step === "web-build" || step === "web-test") {
    if (!webSourcePresent(files)) return { skip: "No frontend package.json" };
    const scripts = validateNpmManifest(files["src/frontend/web/package.json"]).scripts || {};
    if (typeof scripts[step === "web-build" ? "build" : "test"] !== "string")
      return { skip: "No npm " + (step === "web-build" ? "build" : "test") + " script configured" };
    command = ["npm", "run", step === "web-test" ? "test" : "build", "--prefix", "src/frontend/web"];
  } else if (step === "playwright") {
    if (!Object.keys(files).some(p => p.startsWith("src/frontend/web/e2e/") && p.endsWith(".spec.ts")))
      return { skip: "No Playwright e2e/*.spec.ts files configured" };
    if (!webSourcePresent(files)) return { skip: "No frontend package.json for Playwright" };
    if (!files["src/frontend/web/playwright.config.ts"])
      return { skip: "No Playwright configuration (webServer and browser target required)" };
    const manifest = validateNpmManifest(files["src/frontend/web/package.json"]);
    const packageVersion = manifest.devDependencies?.["@playwright/test"] || manifest.dependencies?.["@playwright/test"];
    if (packageVersion !== PLAYWRIGHT_VERSION)
      return { skip: "Playwright package must be pinned to " + PLAYWRIGHT_VERSION + " to match the browser image" };
    const image = imageFor("playwright", files, env);
    const tagMatch = image.match(/playwright:v([0-9]+[.][0-9]+[.][0-9]+)-/);
    if (tagMatch && tagMatch[1] !== PLAYWRIGHT_VERSION)
      return { skip: "Playwright container image and package version differ" };
    command = ["/bin/sh", "-c", "cd src/frontend/web && ./node_modules/.bin/playwright test --reporter=line"];
  } else throw new Error("Unsupported execution step");
  return createPlan(step, files, workdir, command, env);
}
/**
 * Dependency acquisition is a distinct, unprivileged, read-only-rootfs container.
 * Test containers NEVER have a network. Only the operator can opt in to npm
 * registry access, and all npm lifecycle scripts remain disabled.
 */
export function planWebDependencies(files, workdir, env = process.env) {
  if (!webSourcePresent(files)) return { skip: "No frontend package.json" };
  validateNpmManifest(files["src/frontend/web/package.json"]);
  const online = env.RUNNER_ALLOW_NET_DEPS === "true";
  const registry = env.RUNNER_NPM_REGISTRY || "https://registry.npmjs.org/";
  if (online) {
    const url = new URL(registry);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
      throw new Error("Registry must be a public HTTPS origin without credentials");
  }
  const command = ["npm", "install", "--prefix", "src/frontend/web",
    "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--package-lock=false",
    "--no-update-notifier", "--no-progress"];
  if (online) command.push("--registry=" + registry);
  else command.push("--offline");
  const image = imageFor("web-build", files, env);
  return { image, command, args: dockerArgs(workdir, image, command, { network: online ? "bridge" : "none",
    containerUser: env.RUNNER_CONTAINER_UID || "0:0" }),
    timeoutMs: TIME_LIMIT_MS, online };
}
const INFRA_FAILURE = /(?:Executable doesn.t exist at|Please run the following command to download new browsers|Host system is missing dependencies|Cannot connect to the Docker daemon|error during connect|Unable to find image|pull access denied|manifest unknown|failed to (?:create|start) task|OCI runtime create failed|no space left on device|\bNU1301\b|\bENOTCACHED\b|\bEAI_AGAIN\b|npm error code ENOTFOUND|npm ERR! code ENOTFOUND|network is unreachable|TLS handshake timeout)/i;
export function isInfrastructureFailure(result) {
  return result.state === "failed" &&
    (result.exitCode === null || result.exitCode === 125 || result.exitCode === 126 ||
      INFRA_FAILURE.test((result.stderr || "") + "\n" + (result.stdout || "")));
}
export function runDockerStep(plan, id, step, { spawnProcess = spawn, timeoutMs = plan.timeoutMs } = {}) {
  const name = "sf-" + id.slice(0, 8) + "-" + step;
  const args = [...plan.args];
  args.splice(2, 0, "--name", name);
  const started = Date.now();
  return new Promise(resolve => {
    let stdout = "", stderr = "", settled = false, timedOut = false;
    const child = spawnProcess("docker", args, { stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST || "unix:///run/docker.sock", HOME: "/tmp",
    } });
    child.stdout?.on("data", b => { stdout = (stdout + b.toString("utf8")).slice(-12_000); });
    child.stderr?.on("data", b => { stderr = (stderr + b.toString("utf8")).slice(-12_000); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // A killed CLI can leave the container running; forcibly stop the exact dedicated name.
      const cleaner = spawnProcess("docker", ["rm", "-f", name], {
        stdio: "ignore", env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST || "unix:///run/docker.sock" },
      });
      cleaner.on("error", () => {});
    }, timeoutMs);
    const finish = (code, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({
        step, state: !timedOut && code === 0 ? "passed" : "failed",
        exitCode: timedOut ? null : (typeof code === "number" ? code : null),
        timedOut, durationMs: Date.now() - started,
        image: plan.image, command: plan.command.join(" "),
        stdout: scrub(stdout), stderr: scrub(error || stderr),
      });
    };
    child.on("error", e => finish(null, e.message));
    child.on("close", code => finish(code));
  });
}
