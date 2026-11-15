/** Read-only operational readiness checks. Never log Docker Compose JSON, secrets, or request bodies. */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootlessSecurityOptions } from "./orphans.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fail = message => { throw new Error(message); };
const isSecureUser = user => user === "1000:1000";
const contains = (items, name) => Array.isArray(items) && items.includes(name);
const safeService = (name, svc) => {
  if (!svc || !isSecureUser(svc.user) || svc.read_only !== true ||
      svc.privileged === true || !contains(svc.cap_drop, "ALL") ||
      !contains(svc.security_opt, "no-new-privileges:true") ||
      (svc.cap_add && svc.cap_add.length) || (svc.devices && svc.devices.length) ||
      svc.network_mode === "host" || svc.pid === "host" || svc.ipc === "host")
    fail(name + ": unsafe runtime permissions");
};
const mountsFor = svc => {
  if (!Array.isArray(svc.volumes)) fail("Runner service has no explicit mounts");
  for (const volume of svc.volumes) {
    if (volume?.type !== "bind" || typeof volume.source !== "string" ||
        !path.isAbsolute(volume.source) || typeof volume.target !== "string" ||
        !path.isAbsolute(volume.target))
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
  if (!svcs || typeof svcs !== "object" || !svcs["runner-api"] || !svcs["runner-worker"])
    fail("Expected runner-api and runner-worker services");
  const api = svcs["runner-api"], worker = svcs["runner-worker"];
  safeService("runner-api", api);
  safeService("runner-worker", worker);
  const apiMounts = mountsFor(api), workerMounts = mountsFor(worker);
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
    if (tunnel.privileged || tunnel.network_mode === "host" ||
        tunnel.cap_add?.length || tunnel.devices?.length ||
        !contains(tunnel.cap_drop, "ALL") ||
        !contains(tunnel.security_opt, "no-new-privileges:true") ||
        tunnel.volumes?.some(isSocketMount))
      fail("cloudflared: unsafe runtime permissions");
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

/** Read-only HTTPS/CORS/TLS/auth probe. No POST, no automatic redirect, no secret output. */
export async function probeEndpoint({
  baseUrl, origin, apiKey, fetchImpl = fetch,
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
  async function call(resource, headers, method = "GET") {
    try {
      const response = await fetchImpl(new URL(resource, endpoint).href, {
        method, headers, redirect: "manual", signal: AbortSignal.timeout(8000),
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
    bearerAuthRequired: true, corsPreflightPassed: true, networkDefaultNone: true };
}

export async function readPrivateEnv(filePath, stat = lstat, read = readFile) {
  let info;
  try { info = await stat(filePath); } catch { fail("Private runner env file unavailable"); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    fail("Private runner env file must have mode 0600 and not be a symlink");
  let source;
  try { source = await read(filePath, "utf8"); }
  catch { fail("Private runner env file unreadable"); }
  const env = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const found = line.match(/^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/);
    if (!found || found[1] in env) fail("Private runner env file has unsupported syntax");
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

export async function main(argv = process.argv.slice(2)) {
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
      await probeEndpoint({ baseUrl: flags.url, origin: flags.origin, apiKey: env.RUNNER_API_KEY });
  }
  process.stdout.write("RUNNER_PREFLIGHT_PASS: " + JSON.stringify(result) + "\n");
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    // Only static failure descriptions are permitted. Never print Docker output, URLs, keys or .env.
    console.error("RUNNER_PREFLIGHT_FAILED: " + error.message);
    process.exitCode = 1;
  });
