/** Read-only operational readiness checks. Never log Docker Compose JSON, secrets, or request bodies. */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootlessSecurityOptions } from "./orphans.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fail = message => { throw new Error(message); };
const isSecureUser = user => user === "1000:1000";
const contains = (items, name) => Array.isArray(items) && items.includes(name);
// The security profiles are exact, not merely inclusive: appending
// seccomp=unconfined or apparmor=unconfined must not retain a green check.
const single = (items, name) =>
  Array.isArray(items) && items.length === 1 && items[0] === name;
const noNamespaceOverrides = svc => [
  "network_mode", "pid", "ipc", "uts", "userns_mode",
  "cgroup", "cgroupns_mode", "isolation",
].every(field => svc[field] == null);
// Docker Compose mounts can bypass service.volumes via volumes_from,
// secrets/configs and tmpfs. Device rules and supplemental groups can also
// relax container isolation without appearing in the reviewed bind list.
const noExtraMounts = value =>
  value == null || (Array.isArray(value) && value.length === 0);
const noExtraCapabilities = svc => [
  "cap_add", "devices", "device_cgroup_rules", "device_requests", "gpus",
  "group_add", "sysctls", "volumes_from", "tmpfs", "secrets", "configs",
  "expose",
].every(field => noExtraMounts(svc[field]));
const unprivilegedProfile = svc =>
  svc && typeof svc === "object" && !Array.isArray(svc) &&
  (svc.privileged == null || svc.privileged === false) &&
  single(svc.cap_drop, "ALL") &&
  single(svc.security_opt, "no-new-privileges:true") &&
  noExtraCapabilities(svc) && noNamespaceOverrides(svc);
const safeService = (name, svc) => {
  if (!unprivilegedProfile(svc) || !isSecureUser(svc.user) ||
      svc.read_only !== true)
    fail(name + ": unsafe runtime permissions or hidden mounts");
};
// Reject obvious host-system bind targets and noncanonical paths. An
// operator may use /srv or /var/lib for dedicated runner data; symlink and
// directory ownership checks still require live host preflight on the VM.
const dangerousHostRoots = ["/", "/etc", "/proc", "/sys", "/dev", "/run",
  "/tmp", "/root"];
const canonicalAbsolutePath = value => typeof value === "string" &&
  path.isAbsolute(value) && !value.includes("\0") &&
  value === path.resolve(value);
const safeHostMountSource = value => canonicalAbsolutePath(value) &&
  !dangerousHostRoots.some(root => value === root || value.startsWith(root + "/"));
const overlaps = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
const mountsFor = (svc, allowWorkerSocket = false) => {
  if (!Array.isArray(svc.volumes)) fail("Runner service has no explicit mounts");
  for (const volume of svc.volumes) {
    // Only the worker may mount the exact rootless UID 1000 socket. A
    // generic /run bind remains forbidden, even if mounted read-only.
    const dedicatedSocket = allowWorkerSocket &&
      volume?.source === "/run/user/1000/docker.sock" &&
      volume.target === "/run/docker.sock";
    if (volume?.type !== "bind" ||
        (!safeHostMountSource(volume.source) && !dedicatedSocket) ||
        !canonicalAbsolutePath(volume.target))
      fail("Runner service has unsafe bind mounts");
  }
  return svc.volumes;
};
const noPublicPorts = (name, svc) => {
  if (Array.isArray(svc.ports) && svc.ports.length) fail(name + ": unexpected host ports");
  if (svc.network_mode === "host") fail(name + ": host networking forbidden");
};
const isSocketMount = volume => /docker\.sock$/.test(volume.target) ||
  /docker\.sock$/.test(volume.source);

/** Docker Compose v2's resolved config --format json schema, not YAML source.
 * Only fixed failure codes are emitted: config can contain RUNNER_API_KEY and Tunnel tokens.
 */
export function inspectComposeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    fail("Invalid Compose configuration");
  const svcs = config.services;
  if (!svcs || typeof svcs !== "object" || Array.isArray(svcs) ||
      !Object.hasOwn(svcs, "runner-api") || !Object.hasOwn(svcs, "runner-worker"))
    fail("Expected runner-api and runner-worker services");
  // This is a security gate for the entire resolved stack, not merely for
  // the two known services. An ignored privileged sidecar can defeat all
  // guarantees about ports, mounts and Docker socket access.
  const known = new Set(["runner-api", "runner-worker", "cloudflared"]);
  if (Object.keys(svcs).some(name => !known.has(name)))
    fail("Unexpected Docker Compose service");
  const api = svcs["runner-api"], worker = svcs["runner-worker"];
  safeService("runner-api", api);
  safeService("runner-worker", worker);
  const apiMounts = mountsFor(api), workerMounts = mountsFor(worker, true);
  const apiData = apiMounts.find(v => v.target === "/data");
  const registry = apiMounts.find(v => v.target === "/run/secrets/runner-operators");
  const apiRegistryEnv = api.environment?.RUNNER_REPAIR_OPERATORS_FILE;
  if (!apiData || apiData.read_only === true ||
      apiMounts.length !== (registry ? 2 : 1) ||
      apiMounts.some(isSocketMount))
    fail("runner-api: unexpected mounts or Docker socket");
  if (registry) {
    if (registry.read_only !== true || registry.source === apiData.source ||
        ["/", "/etc", "/tmp", "/run", "/var", "/root"].includes(registry.source) ||
        apiRegistryEnv !== "/run/secrets/runner-operators/operators.json" ||
        api.environment?.RUNNER_REPAIR_OPERATORS_JSON)
      fail("runner-api: unsafe operator registry mount or configuration");
  } else if (apiRegistryEnv) {
    fail("runner-api: operator file configured without private directory mount");
  }
  const workspace = worker.environment?.RUNNER_HOST_WORK_DIR;
  // Distinct host paths prevent a workspace from being used as a mutable
  // ancestor/child of the API report and evidence directory.
  if (!safeHostMountSource(apiData.source) ||
      !safeHostMountSource(workspace) || overlaps(apiData.source, workspace))
    fail("Runner data/workspace host mounts must be distinct and private");
  if (workerMounts.length !== 3 ||
      !workerMounts.some(v => v.target === "/data" && v.source === apiData.source) ||
      !workerMounts.some(v => v.target === "/run/docker.sock" &&
        /^\/run\/user\/1000\/docker\.sock$/.test(v.source)) ||
      typeof workspace !== "string" || !path.isAbsolute(workspace) ||
      ["/", "/etc", "/run", "/var", "/var/run", "/tmp"].includes(workspace) ||
      !workerMounts.some(v => v.target === workspace && v.source === workspace) ||
      workerMounts.filter(isSocketMount).length !== 1 ||
      workerMounts.some(v => v.read_only === true ||
        (registry && v.source === registry.source)))
    fail("runner-worker: expected isolated rootless Docker socket and shared data/work mounts");
  if (worker.environment?.DOCKER_HOST !== "unix:///run/docker.sock")
    fail("runner-worker: DOCKER_HOST must point to mounted private socket");
  noPublicPorts("runner-worker", worker);
  const ports = api.ports || [];
  if (!Array.isArray(ports) || ports.length !== 1 ||
      ports[0].host_ip !== "127.0.0.1" || Number(ports[0].target) !== 8787 ||
      Number(ports[0].published) !== 8787 || ports[0].protocol !== "tcp")
    fail("runner-api: must bind port 8787 on loopback only");
  if (api.environment?.RUNNER_PORT !== "8787" && api.environment?.RUNNER_PORT !== 8787)
    fail("runner-api: unexpected port configuration");
  if (api.environment?.DOCKER_HOST || worker.ports?.length)
    fail("runner-api: daemon access or worker ports forbidden");
  if (svcs.cloudflared) {
    const tunnel = svcs.cloudflared;
    if (!unprivilegedProfile(tunnel) || !noExtraMounts(tunnel.volumes))
      fail("cloudflared: unsafe runtime permissions or mounts");
    noPublicPorts("cloudflared", tunnel);
  }
  return { mode: "compose", status: "passed", apiLoopbackOnly: true,
    dockerSocketInWorkerOnly: true, tunnelServiceChecked: Boolean(svcs.cloudflared) };
}

const originPattern = /^https:\/\/[a-z0-9.-]+(?::\d+)?$|^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i;
export function validateHostEnvironment(env) {
  if (!env || typeof env.RUNNER_API_KEY !== "string" ||
      env.RUNNER_API_KEY.length < 32 || env.RUNNER_API_KEY.startsWith("REPLACE_"))
    fail("Runner API key is missing or placeholder");
  if (!env.RUNNER_ALLOWED_ORIGINS ||
      env.RUNNER_ALLOWED_ORIGINS.split(",").some(v => !originPattern.test(v.trim())))
    fail("Explicit trusted runner origins are required");
  if (env.RUNNER_DOCKER_SOCKET !== "/run/user/1000/docker.sock")
    fail("Expected the dedicated uid 1000 rootless Docker socket");
  for (const key of ["RUNNER_DATA_DIR", "RUNNER_HOST_WORK_DIR"]) {
    const value = env[key];
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") ||
        value === "/" || value === "/tmp")
      fail("Invalid runner host directory configuration");
  }
  if (path.resolve(env.RUNNER_DATA_DIR) === path.resolve(env.RUNNER_HOST_WORK_DIR))
    fail("Runner data and workspace must be separate");
  return true;
}

/** Live VM check (not run as a rootless substitute on hosted CI). */
export async function inspectHost({
  env = process.env, stat = lstat, uid = process.getuid?.(), runDocker = async args => {
    try {
      return (await execFile("docker", args, {
        timeout: 12000, maxBuffer: 200000,
        env: { PATH: process.env.PATH, HOME: "/tmp" },
      })).stdout;
    } catch { fail("Cannot reach rootless Docker daemon"); }
  },
} = {}) {
  validateHostEnvironment(env);
  if (uid !== 1000) fail("Run VM preflight as the dedicated uid 1000 account");
  for (const key of ["RUNNER_DATA_DIR", "RUNNER_HOST_WORK_DIR"]) {
    let info;
    try { info = await stat(env[key]); } catch { fail("Runner host directory missing"); }
    if (!info.isDirectory() || info.isSymbolicLink() ||
        info.uid !== 1000 || (info.mode & 0o077) !== 0)
      fail("Runner host directory has unsafe owner or permissions (require uid 1000 and mode 0700)");
  }
  let socket;
  try { socket = await stat(env.RUNNER_DOCKER_SOCKET); }
  catch { fail("Rootless Docker socket unavailable"); }
  if (!socket.isSocket() || socket.isSymbolicLink() ||
      socket.uid !== 1000 || (socket.mode & 0o007) !== 0)
    fail("Docker socket is not a private Unix socket owned by uid 1000");
  let securityOptions;
  try {
    securityOptions = JSON.parse(await runDocker([
      "--host", "unix://" + env.RUNNER_DOCKER_SOCKET,
      "info", "--format", "{{json .SecurityOptions}}",
    ]));
  } catch { fail("Docker daemon security inspection unavailable"); }
  if (!rootlessSecurityOptions(securityOptions))
    fail("Docker daemon does not attest rootless security mode");
  return { mode: "host", status: "passed", uid: 1000,
    directoriesPrivate: true, socketPrivate: true, dockerRootless: true };
}

/** Read-only HTTPS/CORS/TLS/auth probe. No POST, no automatic redirect, no secret output.
 * Optional Access Service Auth is for trusted operator CLI only. NEVER put
 * Cloudflare service tokens into the Factory browser, HTTP job or generated app.
 */
export async function probeEndpoint({
  baseUrl, origin, apiKey, accessClientId, accessClientSecret,
  fetchImpl = fetch,
} = {}) {
  let endpoint, source;
  try {
    endpoint = new URL(baseUrl);
    source = new URL(origin);
  } catch { fail("Invalid endpoint or Factory origin"); }
  if (endpoint.protocol !== "https:" || !endpoint.hostname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== "/" || source.protocol !== "https:" ||
      source.origin !== origin || source.username || source.password ||
      source.pathname !== "/" || source.search || source.hash)
    fail("Endpoint and Factory origin must be bare HTTPS origins");
  if (typeof apiKey !== "string" || apiKey.length < 32 || apiKey.startsWith("REPLACE_"))
    fail("A real runner API key is required in the environment");
  const hasAccess = accessClientId != null || accessClientSecret != null;
  let accessHeaders = {};
  if (hasAccess) {
    // Accept both legacy 64-hex and new cfast_ Cloudflare Access secrets.
    // Do not require a fixed token syntax, but reject CR/LF, controls,
    // whitespace and unbounded values before any HTTP request.
    const printable = /^[!-~]+$/;
    if (typeof accessClientId !== "string" ||
        accessClientId.length < 8 || accessClientId.length > 256 ||
        !printable.test(accessClientId) ||
        typeof accessClientSecret !== "string" ||
        accessClientSecret.length < 32 || accessClientSecret.length > 512 ||
        !printable.test(accessClientSecret) ||
        accessClientSecret.startsWith("REPLACE_"))
      fail("Cloudflare Access service credentials missing or invalid");
    accessHeaders = {
      "CF-Access-Client-Id": accessClientId,
      "CF-Access-Client-Secret": accessClientSecret,
    };
    // Negative check: an ordinary request must not get the runner health
    // response without Access. 302 login challenge is accepted but NEVER
    // followed. It is not provider identity/Cloudflare policy attestation.
    let negative;
    try {
      negative = await fetchImpl(new URL("/healthz", endpoint).href, {
        method: "GET", headers: { Origin: origin },
        redirect: "manual", signal: AbortSignal.timeout(8000),
      });
    } catch { fail("Cloudflare Access unauthenticated probe failed"); }
    if (![302, 401, 403].includes(negative?.status))
      fail("Endpoint is not restricted without Access service credentials");
  }
  async function call(resource, headers, method = "GET") {
    try {
      const response = await fetchImpl(new URL(resource, endpoint).href, {
        method, headers: { ...headers, ...accessHeaders },
        redirect: "manual", signal: AbortSignal.timeout(8000),
      });
      if (response.status >= 300 && response.status < 400)
        fail("HTTP redirect refused by endpoint probe");
      return response;
    } catch { fail("HTTPS endpoint request failed or redirected"); }
  }
  const health = await call("/healthz", { Origin: origin });
  if (health.status !== 200) fail("Remote liveness check failed");
  const unauth = await call("/v1/capabilities", { Origin: origin });
  if (unauth.status !== 401) fail("Remote capabilities must reject missing credentials");
  const authorized = await call("/v1/capabilities", {
    Origin: origin, Authorization: "Bearer " + apiKey,
  });
  if (authorized.status !== 200) fail("Remote capabilities authentication failed");
  let capabilities;
  try { capabilities = await authorized.json(); }
  catch { fail("Remote capabilities response is invalid"); }
  if (capabilities?.protocol !== 1 || capabilities?.networkDefault !== "none" ||
      !Array.isArray(capabilities?.steps) ||
      !capabilities.steps.includes("dotnet-build"))
    fail("Unexpected remote execution capabilities");
  const preflight = await call("/v1/jobs", {
    Origin: origin, "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
  }, "OPTIONS");
  const methods = (preflight.headers.get("access-control-allow-methods") || "").toLowerCase().split(/\s*,\s*/);
  const headers = (preflight.headers.get("access-control-allow-headers") || "").toLowerCase().split(/\s*,\s*/);
  if (preflight.status !== 204 ||
      preflight.headers.get("access-control-allow-origin") !== origin ||
      !methods.includes("post") ||
      !["authorization", "content-type", "idempotency-key"].every(x => headers.includes(x)))
    fail("Remote CORS preflight rejected or misconfigured");
  return { mode: "endpoint", status: "passed", https: true,
    bearerAuthRequired: true, corsPreflightPassed: true, networkDefaultNone: true,
    accessServiceTokenUsed: hasAccess,
    accessUnauthenticatedDenied: hasAccess };
}

// The private env holds bearer credentials and is consulted before deploy.
// Never validate a pathname and then reopen it: that accepts a different inode.
// Exactly 0600, one link, current euid and a bounded, stable single-FD read.
const MAX_PRIVATE_ENV_BYTES = 32_768;
const envUnavailable = () => fail(
  "Private runner env file must have mode 0600, no symlink and a stable private inode");
export function isPrivateEnvFile(stat, uid = process.geteuid?.()) {
  return stat?.isFile?.() === true &&
    Number.isSafeInteger(uid) && stat.uid === uid && stat.nlink === 1 &&
    (stat.mode & 0o777) === 0o600 &&
    Number.isSafeInteger(stat.size) && stat.size >= 1 &&
    stat.size <= MAX_PRIVATE_ENV_BYTES;
}
export function isStablePrivateEnvSnapshot(before, after,
  uid = process.geteuid?.()) {
  return isPrivateEnvFile(before, uid) && isPrivateEnvFile(after, uid) &&
    ["dev", "ino", "uid", "gid", "nlink", "mode", "size", "mtimeMs", "ctimeMs"]
      .every(key => before[key] === after[key]);
}
/** openFile is strictly a Node unit-test seam, not an HTTP or job option. */
export async function readPrivateEnv(filePath, { openFile = open } = {}) {
  if (typeof constants.O_NOFOLLOW !== "number" ||
      typeof filePath !== "string" || !path.isAbsolute(filePath) ||
      filePath.includes("\0")) envUnavailable();
  let fd, source;
  try {
    fd = await openFile(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await fd.stat();
    if (!isPrivateEnvFile(before)) envUnavailable();
    // fstat size bounds memory and prevents an appended file being trusted.
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const length = Math.min(2048, bytes.length - position);
      const result = await fd.read(bytes, position, length, position);
      const read = result?.bytesRead;
      if (!Number.isSafeInteger(read) || read < 1 || read > length)
        envUnavailable();
      position += read;
    }
    const after = await fd.stat();
    if (!isStablePrivateEnvSnapshot(before, after)) envUnavailable();
    source = bytes.toString("utf8");
  } catch { envUnavailable(); }
  finally { await fd?.close().catch(() => {}); }
  const env = Object.create(null);
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const found = line.match(/^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/);
    if (!found || Object.hasOwn(env, found[1]))
      fail("Private runner env file has unsupported syntax");
    env[found[1]] = found[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

async function executeCompose(envFile, operatorRegistry = false) {
  let json;
  try {
    const { stdout } = await execFile("docker", [
      "compose", "--env-file", envFile,
      "-f", path.join(root, "docker/runner/compose.yml"),
      ...(operatorRegistry ? ["-f", path.join(root, "docker/runner/compose.repair-operators.yml")] : []),
      "--profile", "tunnel", "config", "--format", "json",
    ], { cwd: root, timeout: 15000, maxBuffer: 2000000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    json = JSON.parse(stdout);
  } catch { fail("Cannot parse resolved Docker Compose configuration"); }
  return inspectComposeConfig(json);
}

/** endpointProbe/write are trusted Node test seams, not CLI/API parameters. */
export async function main(argv = process.argv.slice(2), {
  endpointProbe = probeEndpoint, write = value => process.stdout.write(value),
} = {}) {
  const [mode, ...options] = argv;
  if (!["compose", "host", "endpoint"].includes(mode) ||
      options.some(x => x !== "--operator-registry" &&
        !/^--(?:env-file|url|origin)=[^\r\n]+$/.test(x)) ||
      new Set(options.map(x => x.split("=")[0])).size !== options.length)
    fail("Usage: preflight.mjs compose|host|endpoint [--env-file=PATH] [--operator-registry] [--url=HTTPS_ORIGIN --origin=HTTPS_ORIGIN]");
  const flags = Object.fromEntries(options.map(x => {
    const i = x.indexOf("=");
    return i === -1 ? [x.slice(2), true] : [x.slice(2, i), x.slice(i + 1)];
  }));
  if (mode !== "endpoint" && (flags.url || flags.origin) ||
      mode === "endpoint" && (!flags.url || !flags.origin) ||
      mode !== "compose" && flags["operator-registry"])
    fail("Invalid flags for preflight mode");
  let result;
  if (mode === "compose") result = await executeCompose(
    path.resolve(root, flags["env-file"] || "docker/runner/.env.example"),
    flags["operator-registry"] === true);
  else {
    const env = flags["env-file"] ? await readPrivateEnv(path.resolve(flags["env-file"])) : process.env;
    result = mode === "host" ? await inspectHost({ env }) :
      await endpointProbe({
        baseUrl: flags.url, origin: flags.origin, apiKey: env.RUNNER_API_KEY,
        accessClientId: env.CF_ACCESS_CLIENT_ID,
        accessClientSecret: env.CF_ACCESS_CLIENT_SECRET,
      });
  }
  write("RUNNER_PREFLIGHT_PASS: " + JSON.stringify(result) + "\n");
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    // Only static failure descriptions are permitted. Never print Docker output, URLs, keys or .env.
    console.error("RUNNER_PREFLIGHT_FAILED: " + error.message);
    process.exitCode = 1;
  });
