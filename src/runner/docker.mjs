import path from "node:path";
import { spawn } from "node:child_process";
import { scrub } from "./common.mjs";

const SAFE_IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{2,180}$/;
const TIME_LIMIT_MS = 120_000;
function imageFor(step, files, env) {
  const framework = files["src/backend/applications/Api/Api.csproj"]?.match(/<TargetFramework>net(10|11)\.0<\/TargetFramework>/)?.[1] || "11";
  const image = step.startsWith("dotnet-") ?
    (framework === "10" ? (env.RUNNER_DOTNET10_IMAGE || "mcr.microsoft.com/dotnet/sdk:10.0") :
      (env.RUNNER_DOTNET11_IMAGE || "mcr.microsoft.com/dotnet/sdk:11.0")) :
    step === "playwright" ? (env.RUNNER_PLAYWRIGHT_IMAGE || "mcr.microsoft.com/playwright:v1.56.1-noble") :
    (env.RUNNER_NODE_IMAGE || "node:22-alpine");
  if (!SAFE_IMAGE.test(image)) throw new Error("Invalid administrator-configured Docker image");
  return image;
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
    if (!files["src/frontend/web/package.json"]) return { skip: "No frontend package.json" };
    let scripts;
    try { scripts = JSON.parse(files["src/frontend/web/package.json"]).scripts || {}; }
    catch { return { skip: "Invalid package.json" }; }
    if (step === "web-test" && typeof scripts.test !== "string") return { skip: "No npm test script configured" };
    command = ["/bin/sh", "-c", "cd src/frontend/web && npm install --offline --ignore-scripts --no-audit --no-fund && npm run " +
      (step === "web-test" ? "test" : "build")];
  } else if (step === "playwright") {
    if (!Object.keys(files).some(p => /^src\/frontend\/web\/e2e\/.test(p)))
      return { skip: "No Playwright e2e/*.spec.ts files configured" };
    command = ["/bin/sh", "-c", "cd src/frontend/web && npx --no-install playwright test --reporter=line"];
  } else throw new Error("Unsupported execution step");
  if (!path.isAbsolute(workdir) || /[\n\r:,]/.test(workdir)) throw new Error("Invalid workdir mount");
  const image = imageFor(step, files, env);
  const args = [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=1024m", "--cpus=1",
    "--user=1000:1000", "--shm-size=256m",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=128m",
    "--mount", "type=bind,src=" + workdir + ",dst=/work,rw",
    "--workdir=/work", "--env=HOME=/tmp", "--env=DOTNET_CLI_HOME=/tmp",
    "--env=NUGET_PACKAGES=/work/.nuget/packages", "--env=NPM_CONFIG_CACHE=/work/.npm",
    "--env=CI=true", image, ...command,
  ];
  return { image, command, args, timeoutMs: TIME_LIMIT_MS };
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
