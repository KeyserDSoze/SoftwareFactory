/** Operator-initiated, offline-only rootless Docker canary.
 * Never invoked by API, worker polling, or user-submitted job payloads.
 * Requires a previously cached immutable Node image digest and consent.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { allowedRootlessHost, probeRootlessDocker } from "../docker-probe.mjs";

const execFile = promisify(execFileCallback);
const IMAGE = /^node@sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const SUCCESS = "SF_ROOTLESS_CANARY_OK";
const LABEL = "softwarefactory.canary";
const MAX_STDOUT = 65536;
const sentinel = String.raw`const fs = require("node:fs");
const os = require("node:os");
function deny() { process.exit(41); }
if (process.getuid?.() !== 65534 || process.getgid?.() !== 65534) deny();
const status = fs.readFileSync("/proc/self/status", "utf8");
const cap = status.match(/^CapEff:\s*([0-9a-fA-F]+)$/m);
if (!cap || !/^0+$/.test(cap[1])) deny();
const interfaces = Object.keys(os.networkInterfaces());
if (interfaces.some(name => name !== "lo")) deny();
const temp = "/tmp/canary-" + process.pid;
try { fs.writeFileSync(temp, "ok", { flag: "wx" }); fs.unlinkSync(temp); }
catch { deny(); }
console.log("SF_ROOTLESS_CANARY_OK");`;

function fail(code) { throw new Error("Rootless canary " + code); }
function arrayEmpty(value) { return value == null || (Array.isArray(value) && value.length === 0); }
function safeIdentity(container, name, id) {
  return container && container.Id === id && CONTAINER_ID.test(id) &&
    container.Name === "/" + name && container.Config?.Labels?.[LABEL] === name;
}
export function safeConfig(container, name, id) {
  if (!safeIdentity(container, name, id)) return false;
  const config = container.Config, host = container.HostConfig;
  return config.User === "65534:65534" &&
    Array.isArray(config.Entrypoint) && config.Entrypoint.length === 1 &&
    config.Entrypoint[0] === "node" &&
    !config.Tty && !config.OpenStdin &&
    host && host.NetworkMode === "none" && host.ReadonlyRootfs === true &&
    host.Privileged === false && host.PublishAllPorts === false &&
    host.PidsLimit === 32 && host.Memory === 134217728 &&
    host.NanoCpus === 500000000 &&
    Array.isArray(host.CapDrop) && host.CapDrop.includes("ALL") &&
    arrayEmpty(host.CapAdd) && arrayEmpty(host.Binds) &&
    arrayEmpty(host.Mounts) && arrayEmpty(host.VolumesFrom) &&
    arrayEmpty(host.Devices) && arrayEmpty(container.Mounts) &&
    (host.PortBindings === null || Object.keys(host.PortBindings).length === 0) &&
    Array.isArray(host.SecurityOpt) && host.SecurityOpt.some(opt =>
      opt === "no-new-privileges" || opt === "no-new-privileges:true") &&
    typeof host.Tmpfs?.["/tmp"] === "string" &&
    ["rw", "nosuid", "nodev", "noexec", "size=16m"].every(flag =>
      host.Tmpfs["/tmp"].split(",").includes(flag));
}

export function buildRootlessCanaryArgs(image, name) {
  if (typeof image !== "string" || !IMAGE.test(image) ||
      typeof name !== "string" || !/^sf-canary-[a-f0-9-]{36}$/.test(name))
    fail("requires a locally cached node@sha256 digest and generated name");
  return ["create", "--name", name, "--label", LABEL + "=" + name,
    "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=128m",
    "--cpus=0.5", "--user=65534:65534",
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m",
    "--entrypoint=node", image, "-e", sentinel];
}

/** No other command, mount, image, Docker host or code is accepted from CLI.
 * Probe rootless mode fresh before EACH operation, including cleanup rm.
 * Docker errors are never echoed. Any cleanup failure forces an explicit
 * operator investigation instead of pretending the canary was successful.
 */
export async function runRootlessCanary({
  image, confirmed = false,
  host = process.env.DOCKER_HOST || "unix:///run/docker.sock",
  probeDocker = probeRootlessDocker,
  runDocker = async (args, options) => (await execFile("docker", args, options)).stdout,
  id = randomUUID(),
} = {}) {
  if (confirmed !== true) fail("requires explicit --confirm");
  if (!allowedRootlessHost(host)) fail("refuses non-local Docker host");
  const name = "sf-canary-" + id;
  const args = buildRootlessCanaryArgs(image, name);
  const env = { PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: "/tmp", DOCKER_CONFIG: "/tmp", DOCKER_HOST: host };
  const command = async (argv, timeout = 8000) => {
    // Just-in-time guard on EVERY operation: the Docker daemon behind a
    // stable socket path can be replaced between create, inspect, start, rm.
    // Never cache a previous rootless check, even for read-only commands or
    // cleanup. Fail closed without copying Docker probe diagnostics.
    let rootless = false;
    try { rootless = (await probeDocker({ host })) === true; }
    catch { /* A failed probe never authorizes a Docker command. */ }
    if (!rootless) fail("requires a confirmed rootless daemon");
    try {
      const output = await runDocker(argv, { timeout, maxBuffer: MAX_STDOUT, env });
      if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_STDOUT)
        throw Error("invalid Docker CLI response");
      return output;
    } catch { fail("Docker operation failed"); }
  };
  let containerId = null, created = false, verified = false, failure = null;
  let success = false;
  const inspect = async () => {
    const raw = await command(["inspect", "--format", "{{json .}}", containerId]);
    try {
      const value = JSON.parse(raw);
      if (!safeIdentity(value, name, containerId)) fail("container identity mismatch");
      verified = true;
      return value;
    } catch { fail("container inspection rejected"); }
  };
  try {
    containerId = (await command(args)).trim();
    if (!CONTAINER_ID.test(containerId)) fail("creation returned invalid ID");
    created = true;
    const before = await inspect();
    if (!safeConfig(before, name, containerId))
      fail("container security settings mismatch");
    const stdout = await command(["start", "--attach", containerId], 20_000);
    const after = await inspect();
    if (!safeConfig(after, name, containerId) ||
        after.State?.Running !== false || after.State?.Status !== "exited" ||
        after.State.ExitCode !== 0 || after.State.OOMKilled !== false ||
        stdout.trim() !== SUCCESS) fail("container execution verification failed");
    success = true;
  } catch (error) {
    failure = error;
  } finally {
    if (created) {
      if (!verified) {
        // A foreign or unexpectedly altered container must not be removed.
        failure = new Error("Rootless canary identity unverified; manual investigation required");
      } else {
        try {
          const candidate = await inspect();
          if (!safeIdentity(candidate, name, containerId))
            fail("cleanup identity mismatch");
          const removed = (await command(["rm", "-f", containerId])).trim();
          if (removed !== containerId) fail("cleanup acknowledgement invalid");
        } catch {
          failure = new Error("Rootless canary cleanup failed; manual investigation required");
        }
      }
    }
  }
  if (failure) throw failure;
  if (!success) fail("execution not verified");
  return { status: "passed", dockerRootless: true, network: "none",
    readonlyRootfs: true, capsDropped: true, cleanup: "verified" };
}

async function main(args) {
  if (args.length !== 2 || !args.includes("--confirm") ||
      args.filter(x => x.startsWith("--image=")).length !== 1)
    fail("usage: node scripts/rootless-canary.mjs --image=node@sha256:<digest> --confirm");
  if (process.getuid?.() === 0) fail("refuses root operator identity");
  const image = args.find(x => x.startsWith("--image=")).slice("--image=".length);
  // Report the non-secret UUID before Docker create. If the daemon disappears
  // after create, this ID is the operator's recovery handle; never log Docker
  // stderr, token material, or the entire container inspect response.
  const runId = randomUUID();
  process.stderr.write("ROOTLESS_CANARY_ID=" + runId + "\n");
  const result = await runRootlessCanary({ image, confirmed: true, id: runId });
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(() => {
    console.error("Rootless canary failed; inspect rootless VM and canary containers manually");
    process.exitCode = 1;
  });
