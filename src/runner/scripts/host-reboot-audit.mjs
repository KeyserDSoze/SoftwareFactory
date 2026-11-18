/** Operator-only, strictly local, read-only reboot inspection (#96).
 *
 * A baseline file is created exactly once in the host's private runner data
 * directory. An independent new Linux boot ID plus current rootless
 * Compose/systemd/authenticated API observations are required for success.
 * No Docker create/start/stop, tunnel setup, public HTTP or secret output.
 * This local record is NOT signed, remotely attested or proof of Cloudflare
 * DNS/Access; callbacks are deterministic Node test seams only.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readFile, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPrivateEnv, validateHostEnvironment, selectEndpointBearer,
  main as preflight } from "../preflight.mjs";
import { probeRootlessDocker } from "../docker-probe.mjs";
import { probeInstalledRunner } from "./host-install.mjs";

const execFile = promisify(execFileCb);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const host = "unix:///run/user/1000/docker.sock";
const project = "sf-runner";
const witnessName = ".sf-reboot-baseline.v1.json";
const bootRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = () => { throw Error("Local reboot audit refused; inspect the dedicated rootless Linux host"); };
const canonical = x => typeof x === "string" && x.length < 4096 &&
  x.startsWith("/") && !/[\x00-\x1f\x7f]/.test(x) && path.resolve(x) === x;
const safeEnv = () => ({
  PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/tmp",
  DOCKER_HOST: host, DOCKER_CONFIG: "/tmp",
});
const same = (x, y) => JSON.stringify(Object.entries(x)
  .sort(([a], [b]) => a.localeCompare(b))) === JSON.stringify(Object.entries(y)
  .sort(([a], [b]) => a.localeCompare(b)));
const services = withTunnel => withTunnel
  ? ["cloudflared", "runner-api", "runner-worker"]
  : ["runner-api", "runner-worker"];
const proof = ({mode, status, ...data}, kind, opts) =>
  mode === kind && status === "passed" &&
  (kind === "host" ? data.uid === 1000 && data.dockerRootless === true &&
    data.directoriesPrivate === true && data.socketPrivate === true &&
    (opts.authMode === "inline" && !opts.operatorRegistry ||
      data.credentialMode === opts.authMode &&
      data.credentialsPrivate === true &&
      data.operatorRegistryChecked === opts.operatorRegistry)
    : data.apiLoopbackOnly === true &&
      data.dockerSocketInWorkerOnly === true &&
      data.tunnelServiceChecked === true);
const envFlags = ({authMode,operatorRegistry}) => [
  ...(authMode === "key-file" ? ["--runner-key-file"] : []),
  ...(authMode === "tenants" ? ["--tenants"] : []),
  ...(operatorRegistry ? ["--operator-registry"] : []),
];

const defaultCommand = async (program, args, opts) => {
  const r = await execFile(program, args, opts);
  if (typeof r.stdout !== "string" ||
      Buffer.byteLength(r.stdout) > 65536) refuse();
  return r.stdout;
};
const getBootId = async () => (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();

function safeContainer(raw, shortId, needed) {
  const x = JSON.parse(raw);
  const name = x?.Config?.Labels?.["com.docker.compose.service"];
  if (!needed.has(name) || needed.get(name) !== false ||
      typeof x.Id !== "string" || !/^[a-f0-9]{64}$/.test(x.Id) ||
      !x.Id.startsWith(shortId) ||
      x.Config?.Labels?.["com.docker.compose.project"] !== project ||
      x.State?.Running !== true || x.State.Status !== "running" ||
      x.HostConfig?.Privileged !== false ||
      x.HostConfig?.NetworkMode !== project + "_default" ||
      !Array.isArray(x.Mounts)) refuse();
  const sockets = x.Mounts.filter(m =>
    typeof m?.Destination === "string" &&
      (m.Destination.endsWith(".sock") || m.Destination.includes("/docker.sock")) ||
    typeof m?.Source === "string" &&
      (m.Source.endsWith(".sock") || m.Source.includes("/docker.sock")));
  if (name === "runner-worker") {
    if (sockets.length !== 1 ||
        sockets[0].Type !== "bind" ||
        sockets[0].Source !== "/run/user/1000/docker.sock" ||
        sockets[0].Destination !== "/run/docker.sock") refuse();
  } else if (sockets.length !== 0) refuse();
  if (name === "runner-api") {
    const bindings = x.HostConfig?.PortBindings;
    if (!bindings || Object.keys(bindings).length !== 1 ||
        !Array.isArray(bindings["8787/tcp"]) ||
        bindings["8787/tcp"].length !== 1 ||
        bindings["8787/tcp"][0]?.HostIp !== "127.0.0.1" ||
        bindings["8787/tcp"][0]?.HostPort !== "8787") refuse();
  } else if (x.HostConfig?.PortBindings &&
      Object.values(x.HostConfig.PortBindings).some(x => x?.length)) refuse();
  needed.set(name, true);
}

export function validateRebootWitness(x, expected, currentBoot, now) {
  const fields = ["at","authMode","bootId","operatorRegistry","project",
    "requireTunnel","services","version"];
  if (!x || typeof x !== "object" || Array.isArray(x) ||
      Object.keys(x).sort().join(",") !== fields.sort().join(",") ||
      x.version !== 1 || x.project !== project ||
      !bootRegex.test(x.bootId) || x.bootId === currentBoot ||
      x.authMode !== expected.authMode ||
      x.operatorRegistry !== expected.operatorRegistry ||
      x.requireTunnel !== expected.requireTunnel ||
      JSON.stringify(x.services) !== JSON.stringify(services(expected.requireTunnel)))
    refuse();
  const at = Date.parse(x.at);
  if (typeof x.at !== "string" || !Number.isFinite(at) ||
      new Date(at).toISOString() !== x.at ||
      at > now || now-at > 7*24*60*60*1000) refuse();
  return true;
}

/** New mode 'before' may write one local witness only after all runtime
 * observations pass. 'after' rejects the SAME boot ID and requires the
 * identical service/auth policy and a fresh runtime observation.
 */
export async function runRebootAudit({
  mode, envFile, authMode = "inline", operatorRegistry = false,
  requireTunnel = false, uid = process.getuid?.(), euid = process.geteuid?.(),
  readEnv = readPrivateEnv, bootId = getBootId,
  inspectDataDir = lstat,
  now = () => Date.now(),
  preflightCheck = argv => preflight(argv, { write: () => {} }),
  probeDocker = probeRootlessDocker,
  systemCommand = defaultCommand, dockerCommand = defaultCommand,
  readiness = probeInstalledRunner,
  witnessRead = readWitness, witnessWrite = writeWitness,
} = {}) {
  if (process.platform !== "linux" || uid !== 1000 || euid !== 1000 ||
      !["before", "after"].includes(mode) || !canonical(envFile) ||
      !["inline", "key-file", "tenants"].includes(authMode) ||
      typeof operatorRegistry !== "boolean" ||
      authMode === "tenants" && operatorRegistry ||
      typeof requireTunnel !== "boolean") refuse();
  const flags = ["--env-file=" + envFile, ...envFlags({authMode,operatorRegistry})];
  const opts = {authMode,operatorRegistry,requireTunnel};
  try {
    const original = await readEnv(envFile);
    validateHostEnvironment(original, {authMode,operatorRegistry});
    if (Object.keys(original).some(key =>
      /^(?:COMPOSE_[A-Z0-9_]+|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|NODE_OPTIONS|NODE_PATH)$/.test(key)))
      refuse();
    const dir = original.RUNNER_DATA_DIR;
    if (!canonical(dir) || dir === "/") refuse();
    const metadata = await inspectDataDir(dir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        metadata.uid !== uid || (metadata.mode & 0o077) !== 0) refuse();
    const witnessPath = path.join(dir, witnessName);
    const currentBoot = await bootId();
    if (typeof currentBoot !== "string" || !bootRegex.test(currentBoot)) refuse();
    const stamp = now();
    if (!Number.isSafeInteger(stamp) || stamp <= 0) refuse();
    if (mode === "after") {
      const saved = await witnessRead(witnessPath, uid);
      validateRebootWitness(saved, opts, currentBoot, stamp);
    }
    for (const kind of ["compose", "host"]) {
      const evidence = await preflightCheck([kind, ...flags]);
      if (!proof(evidence, kind, opts)) refuse();
    }
    const sysOptions = { timeout: 6000, maxBuffer: 4096,
      env: { PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: process.env.HOME || "/tmp" } };
    const [dockerService, linger] = await Promise.all([
      systemCommand("systemctl", ["--user", "is-active", "docker.service"], sysOptions),
      systemCommand("loginctl", ["show-user", "1000", "-p", "Linger", "--value"], sysOptions),
    ]);
    if (dockerService !== "active\n" || linger !== "yes\n") refuse();
    const runDocker = async (args, timeout = 8000) => {
      if (await probeDocker({ host }) !== true) refuse();
      const raw = await dockerCommand("docker", args, {
        timeout, maxBuffer: 65536, cwd: root, env: safeEnv(),
      });
      if (typeof raw !== "string" ||
          Buffer.byteLength(raw, "utf8") > 65536) refuse();
      return raw;
    };
    const ids = (await runDocker(["ps", "-a", "--filter",
      "label=com.docker.compose.project=" + project,
      "--format", "{{.ID}}"])).trim().split(/\r?\n/);
    if (ids.length !== services(requireTunnel).length ||
        new Set(ids).size !== ids.length ||
        ids.some(x => !/^[a-f0-9]{12,64}$/.test(x))) refuse();
    const needed = new Map(services(requireTunnel).map(x => [x, false]));
    for (const id of ids) {
      const inspected = await runDocker(["inspect","--format","{{json .}}",id]);
      safeContainer(inspected, id, needed);
    }
    if ([...needed.values()].some(v => v !== true)) refuse();
    const bearer = selectEndpointBearer(original, { authMode, privateEnv: true });
    if (await readiness({ bearer }) !== true) refuse();
    if ((await bootId()) !== currentBoot ||
        !same(original, await readEnv(envFile))) refuse();
    if (mode === "before") {
      const witness = { version: 1, project, at: new Date(stamp).toISOString(),
        bootId: currentBoot, authMode, operatorRegistry,
        requireTunnel, services: services(requireTunnel) };
      await witnessWrite(witnessPath, witness, uid);
      return { version: 1, state: "baseline_saved", localOnly: true,
        requiresReboot: true, project, services: services(requireTunnel) };
    }
    return { version: 1, state: "different_boot_verified", localOnly: true,
      requiresReboot: false, rootless: true, authenticated: true,
      externalAccessVerified: false, project, services: services(requireTunnel) };
  } catch { refuse(); }
}

export async function writeWitness(file, x, uid) {
  let handle;
  try {
    handle = await open(file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600) refuse();
    await handle.writeFile(JSON.stringify(x) + "\n", { encoding: "utf8" });
    await handle.sync();
  } catch { refuse(); }
  finally { await handle?.close(); }
}
export async function readWitness(file, uid) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.uid !== uid ||
        (st.mode & 0o777) !== 0o600 || st.size < 70 || st.size > 2048) refuse();
    const bytes = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(bytes) !== st.size) refuse();
    const after = await handle.stat();
    if (after.dev !== st.dev || after.ino !== st.ino ||
        after.ctimeMs !== st.ctimeMs || after.size !== st.size) refuse();
    return JSON.parse(bytes);
  } catch { refuse(); }
  finally { await handle?.close(); }
}

export async function main(argv = process.argv.slice(2), {
  execute = runRebootAudit, write = value => process.stdout.write(value),
} = {}) {
  const usage = "node src/runner/scripts/host-reboot-audit.mjs before|after " +
    "--env-file=/absolute/private.env [--require-tunnel] " +
    "[--runner-key-file|--tenants] [--operator-registry]";
  if (argv.length === 1 && argv[0] === "--help") {
    write(usage + "\n"); return null;
  }
  const allowed = /^(before|after|--require-tunnel|--runner-key-file|--tenants|--operator-registry|--env-file=[^\r\n]+)$/;
  if (!Array.isArray(argv) || argv.length < 2 || argv.length > 6 ||
      argv.some(x => typeof x !== "string" || !allowed.test(x)) ||
      new Set(argv.map(x => x.split("=")[0])).size !== argv.length ||
      !["before","after"].includes(argv[0]) ||
      argv.slice(1).some(x => x === "before" || x === "after") ||
      argv.includes("--tenants") &&
        (argv.includes("--runner-key-file") || argv.includes("--operator-registry")))
    refuse();
  const envFile = argv.find(x => x.startsWith("--env-file="))?.slice(11);
  if (!canonical(envFile)) refuse();
  const authMode = argv.includes("--tenants") ? "tenants" :
    argv.includes("--runner-key-file") ? "key-file" : "inline";
  const operatorRegistry = argv.includes("--operator-registry");
  const requireTunnel = argv.includes("--require-tunnel");
  const result = await execute({ mode: argv[0], envFile, authMode,
    operatorRegistry, requireTunnel });
  if (result?.version !== 1 || result.localOnly !== true ||
      result.project !== project ||
      JSON.stringify(result.services) !== JSON.stringify(services(requireTunnel)) ||
      (argv[0] === "before" ?
        result.state !== "baseline_saved" || result.requiresReboot !== true :
        result.state !== "different_boot_verified" ||
        result.requiresReboot !== false || result.rootless !== true ||
        result.authenticated !== true || result.externalAccessVerified !== false))
    refuse();
  write("RUNNER_REBOOT_" + (argv[0] === "before" ? "BASELINE" : "LOCAL") +
    "_PASS: " + JSON.stringify(result) + "\n");
  return result;
}
if (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("RUNNER_REBOOT_AUDIT_REFUSED: inspect Linux host manually");
    process.exitCode = 1;
  });
}
