/** Initial Linux connector install, operator-only (issue #88 / #87 M2).
 *
 * Does not SSH, fetch code, modify host packages, open public ports, install
 * Cloudflare or grant arbitrary Docker access. Apply requires explicit user
 * consent, a clean pinned main checkout and a real rootless VM canary.
 *
 * CLI outputs contain NO credentials, file paths or upstream Docker errors.
 * Injection points below are exclusively trusted local Node test seams.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as preflight, readPrivateEnv, validateHostEnvironment,
  selectEndpointBearer } from "../preflight.mjs";
import { runVmAcceptance } from "./vm-acceptance.mjs";
import { verifyInstallerReleaseSource } from "./installer-source.mjs";
import { probeRootlessDocker } from "../docker-probe.mjs";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOCKER_HOST = "unix:///run/user/1000/docker.sock";
const PROJECT = "sf-runner";
const SHA = /^[a-f0-9]{40}$/;
const IMAGE = /^node@sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const reject = () => { throw Error("Runner host install refused; inspect the dedicated Linux host manually"); };
const canonical = value => typeof value === "string" &&
  value.length > 1 && value.length <= 4096 && !/[\0\r\n]/.test(value) &&
  path.isAbsolute(value) && path.resolve(value) === value;
const profileFlags = (authMode, operators) => [
  ...(authMode === "key-file" ? ["--runner-key-file"] : []),
  ...(authMode === "tenants" ? ["--tenants"] : []),
  ...(operators ? ["--operator-registry"] : []),
];
const defaultRun = async (command, argv, options) =>
  (await execFile(command, argv, options)).stdout;
const safeProcessEnv = () => ({
  PATH: process.env.PATH || "/usr/bin:/bin",
  HOME: process.env.HOME || "/tmp",
  DOCKER_HOST,
});
const snapshotsEqual = (a, b) =>
  JSON.stringify(Object.entries(a).sort(([x], [y]) => x.localeCompare(y))) ===
  JSON.stringify(Object.entries(b).sort(([x], [y]) => x.localeCompare(y)));
const proofIsSafe = (proof, kind, authMode, operators) =>
  proof?.status === "passed" && proof.mode === kind &&
  (kind === "compose" ?
    proof.apiLoopbackOnly === true &&
    proof.dockerSocketInWorkerOnly === true &&
    typeof proof.tunnelServiceChecked === "boolean" :
    proof.uid === 1000 && proof.dockerRootless === true &&
    proof.directoriesPrivate === true && proof.socketPrivate === true &&
    (authMode === "inline" && !operators ||
      proof.credentialMode === authMode && proof.credentialsPrivate === true &&
      proof.operatorRegistryChecked === operators));
const acceptanceIsSafe = (proof, id, authMode, operators) =>
  proof?.version === 1 && proof.scope === "local-vm" &&
  proof.status === "passed" && proof.canaryId === id &&
  proof.authMode === authMode && proof.operatorRegistry === operators &&
  proof.dockerRootless === true && proof.canaryCleanup === "verified" &&
  JSON.stringify(proof.checks) === JSON.stringify(["compose", "host", "canary"]);

export async function verifyCleanPinnedMain({ commit, git = (argv) =>
  defaultRun("git", argv, { cwd: root, timeout: 7000, maxBuffer: 8192,
    env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/tmp" } }),
} = {}) {
  if (!SHA.test(commit)) reject();
  try {
    const [actual, branch, dirty] = await Promise.all([
      git(["rev-parse", "--verify", "HEAD"]),
      git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      git(["status", "--porcelain", "--untracked-files=all"]),
    ]);
    if (typeof actual !== "string" || actual.trim() !== commit ||
        branch !== "main\n" || dirty !== "") reject();
    return true;
  } catch { reject(); }
}

/** Read-only local loopback proof that the API is authenticated, the worker is
 * responsive, and the worker observed a rootless daemon. No test runs or POST.
 * The caller supplies the API key from a verified private env; it is never
 * serialized or echoed. Never follow redirect with an Authorization header.
 */
export async function probeInstalledRunner({
  bearer, fetchImpl = fetch, attempts = 24,
  wait = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  if (typeof bearer !== "string" || bearer.length < 32 || bearer.length > 256 ||
      bearer.startsWith("REPLACE_") || !/^[\x21-\x7e]+$/.test(bearer))
    reject();
  const origin = "http://127.0.0.1:8787";
  const call = async (url, authenticated) => {
    const response = await fetchImpl(origin + url, {
      method: "GET",
      headers: authenticated ? { Authorization: "Bearer " + bearer } : {},
      redirect: "manual", signal: AbortSignal.timeout(2500),
    });
    if (response?.status >= 300 && response.status < 400) reject();
    return response;
  };
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 30) reject();
  for (let i = 0; i < attempts; i++) {
    try {
      const unauth = await call("/v1/capabilities", false);
      if (unauth?.status !== 401) reject();
      const capability = await call("/v1/capabilities", true);
      if (capability?.status === 401 || capability?.status === 403) reject();
      if (capability?.status !== 200) throw Error("not ready");
      const info = await capability.json();
      if (info?.protocol !== 1 || info.networkDefault !== "none" ||
          info.execution !== "remote-docker" ||
          !Array.isArray(info.steps) || !info.steps.includes("dotnet-build"))
        reject();
      const worker = await call("/v1/readiness", true);
      const execution = await call("/v1/execution-readiness", true);
      if (worker?.status !== 200 || execution?.status !== 200)
        throw Error("not ready");
      const [w, e] = await Promise.all([worker.json(), execution.json()]);
      if (w?.status !== "ready" || w.worker !== "responsive" ||
          e?.status !== "ready" || e.worker !== "responsive" ||
          e.docker !== "rootless") reject();
      return true;
    } catch (error) {
      if (error?.message === "Runner host install refused; inspect the dedicated Linux host manually")
        throw error;
      if (i === attempts - 1) reject();
      await wait(450);
    }
  }
  reject();
}

/** Real orchestration uses only the fixed rootless DOCKER_HOST and a clean
 * Git checkout. preflight/vm/exec/fetch/FS seams are only test-injectable from
 * Node, never exposed as HTTP or accepted as CLI input.
 */
export async function runHostInstall({
  envFile, commit, image, archive = null, archiveSha256 = null,
  mode = "check", confirmed = false,
  authMode = "inline", operatorRegistry = false,
  uid = process.getuid?.(), id = randomUUID(),
  readEnv = readPrivateEnv, git = undefined,
  verifyArchive = verifyInstallerReleaseSource,
  preflightCheck = argv => preflight(argv, { write: () => {} }),
  vmAcceptance = runVmAcceptance,
  probeDocker = probeRootlessDocker,
  runDocker = (argv, options) => defaultRun("docker", argv, options),
  localReadiness = probeInstalledRunner,
  claim = filename => mkdir(filename, { mode: 0o700 }),
  unclaim = filename => rmdir(filename),
  writeRecovery = value => process.stderr.write(value),
} = {}) {
  if (process.platform !== "linux" || uid !== 1000 ||
      !canonical(envFile) || !SHA.test(commit) || !IMAGE.test(image) ||
      !["check", "apply"].includes(mode) || typeof operatorRegistry !== "boolean" ||
      !["inline", "key-file", "tenants"].includes(authMode) ||
      authMode === "tenants" && operatorRegistry ||
      confirmed !== (mode === "apply") || !UUID.test(id) ||
      ((archive === null) !== (archiveSha256 === null)) ||
      (archive !== null && (!canonical(archive) ||
        !/^[a-f0-9]{64}$/.test(archiveSha256))))
    reject();
  const verifySource = () => archive === null
    ? verifyCleanPinnedMain({ commit, ...(git ? { git } : {}) })
    : verifyArchive({ root, archive, archiveSha256, commit });
  const options = ["--env-file=" + envFile, ...profileFlags(authMode, operatorRegistry)];
  let locked = false, claimPath;
  try {
    const initial = await readEnv(envFile);
    validateHostEnvironment(initial, { authMode, operatorRegistry });
    // A private env must not override the reviewed Compose project/profile,
    // Docker host/context or the Node executable. All these runtime controls
    // are pinned by the installer, never delegated to an env-file.
    if (Object.keys(initial).some(key =>
      /^(?:COMPOSE_[A-Z0-9_]+|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|NODE_OPTIONS|NODE_PATH)$/.test(key)))
      reject();
    await verifySource();
    for (const kind of ["compose", "host"]) {
      const proof = await preflightCheck([kind, ...options]);
      if (!proofIsSafe(proof, kind, authMode, operatorRegistry)) reject();
      if (!snapshotsEqual(initial, await readEnv(envFile))) reject();
    }
    if (mode === "check") {
      return { version: 1, state: "ready_to_install", scope: "local-linux",
        commit, authMode, operatorRegistry, checks: ["git", "private-env", "compose", "host"],
        installed: false };
    }
    // Rootless canary creates and deletes one digest-pinned isolated container.
    // No Docker compose startup may happen without the verified canary receipt.
    const accepted = await vmAcceptance({
      envFile, image, confirmed: true, uid, id, authMode,
      operatorRegistry, writeRecovery,
    });
    if (!acceptanceIsSafe(accepted, id, authMode, operatorRegistry)) reject();
    if (!snapshotsEqual(initial, await readEnv(envFile))) reject();
    await verifySource();
    // The host preflight certified this private data directory. An atomic
    // mkdir provides best-effort single-host fencing for two installers.
    claimPath = path.join(initial.RUNNER_DATA_DIR, ".sf-initial-install-claim");
    await claim(claimPath);
    locked = true;
    const rootless = async (argv, timeout = 12000) => {
      if (await probeDocker({ host: DOCKER_HOST }) !== true) reject();
      const output = await runDocker(argv, { cwd: root, timeout,
        maxBuffer: 65536, env: safeProcessEnv() });
      if (typeof output !== "string" ||
          Buffer.byteLength(output, "utf8") > 65536) reject();
      return output;
    };
    await verifySource();
    if (!snapshotsEqual(initial, await readEnv(envFile))) reject();
    const existing = await rootless(["ps", "-a", "--filter",
      "label=com.docker.compose.project=" + PROJECT, "--format", "{{.ID}}"]);
    if (existing.trim() !== "") reject(); // Never modify/reconcile an existing stack.
    const compose = ["compose", "--project-name", PROJECT,
      "--env-file", envFile,
      "-f", path.join(root, "docker/runner/compose.yml"),
      ...(authMode === "key-file" ?
        ["-f", path.join(root, "docker/runner/compose.runner-key-file.yml")] : []),
      ...(authMode === "tenants" ?
        ["-f", path.join(root, "docker/runner/compose.tenants.yml")] : []),
      ...(operatorRegistry ?
        ["-f", path.join(root, "docker/runner/compose.repair-operators.yml")] : [])];
    await rootless([...compose, "up", "--detach", "--build", "--no-deps",
      "runner-api", "runner-worker"], 180000);
    await verifySource();
    if (!snapshotsEqual(initial, await readEnv(envFile))) reject();
    const ids = (await rootless(["ps", "-a", "--filter",
      "label=com.docker.compose.project=" + PROJECT, "--format", "{{.ID}}"]))
      .trim().split(/\r?\n/);
    if (ids.length !== 2 || new Set(ids).size !== 2 ||
        ids.some(x => !/^[a-f0-9]{12,64}$/.test(x))) reject();
    const services = new Set();
    for (const containerId of ids) {
      const raw = await rootless(["inspect", "--format", "{{json .}}", containerId]);
      const obj = JSON.parse(raw);
      const service = obj?.Config?.Labels?.["com.docker.compose.service"];
      if (typeof obj?.Id !== "string" || !/^[a-f0-9]{64}$/.test(obj.Id) ||
          !obj.Id.startsWith(containerId) ||
          obj.Config?.Labels?.["com.docker.compose.project"] !== PROJECT ||
          !["runner-api", "runner-worker"].includes(service) ||
          !obj.State?.Running || obj.State?.Status !== "running" ||
          obj.HostConfig?.Privileged !== false ||
          !Array.isArray(obj.Mounts) ||
          (service === "runner-api" && obj.Mounts.some(
            mount => mount.Destination === "/run/docker.sock")) ||
          (service === "runner-worker" && !obj.Mounts.some(
            mount => mount.Type === "bind" &&
              mount.Source === "/run/user/1000/docker.sock" &&
              mount.Destination === "/run/docker.sock")) ||
          services.has(service)) reject();
      services.add(service);
    }
    const bearer = selectEndpointBearer(initial, {
      authMode, privateEnv: true });
    if (await localReadiness({ bearer }) !== true) reject();
    if (!snapshotsEqual(initial, await readEnv(envFile))) reject();
    return { version: 1, state: "installed", scope: "local-linux",
      commit, authMode, operatorRegistry, installed: true,
      dockerRootless: true, project: PROJECT,
      services: ["runner-api", "runner-worker"],
      checks: ["git", "private-env", "compose", "host", "canary",
        "empty-stack", "compose-up", "container-state", "authenticated-readiness"] };
  } catch { reject(); }
  finally {
    if (locked) {
      try { await unclaim(claimPath); }
      catch { reject(); }
    }
  }
}

const usage = "Usage: node src/runner/scripts/host-install.mjs " +
  "--env-file=/absolute/private.env --commit=<40-hex> --image=node@sha256:<64-hex> " +
  "(--check | --apply --confirm-install) [--archive=/absolute/release.tar.gz --archive-sha256=<64hex>] " +
  "[--runner-key-file|--tenants] [--operator-registry]";

export async function main(argv = process.argv.slice(2), {
  execute = runHostInstall, uid = process.getuid?.(),
  write = value => process.stdout.write(value),
  writeRecovery = value => process.stderr.write(value),
} = {}) {
  if (argv.length === 1 && argv[0] === "--help") { write(usage + "\n"); return null; }
  const allowed = /^(--check|--apply|--confirm-install|--runner-key-file|--tenants|--operator-registry|--env-file=[^\r\n]+|--commit=[a-f0-9]{40}|--image=node@sha256:[a-f0-9]{64}|--archive=[^\r\n]+|--archive-sha256=[a-f0-9]{64})$/;
  if (!Array.isArray(argv) || argv.length < 4 || argv.length > 10 ||
      argv.some(x => typeof x !== "string" || !allowed.test(x)) ||
      new Set(argv.map(x => x.split("=")[0])).size !== argv.length ||
      argv.includes("--check") === argv.includes("--apply") ||
      argv.includes("--apply") !== argv.includes("--confirm-install") ||
      argv.includes("--tenants") &&
        (argv.includes("--runner-key-file") || argv.includes("--operator-registry")))
    reject();
  const envFile = argv.find(x => x.startsWith("--env-file="))?.slice(11);
  const commit = argv.find(x => x.startsWith("--commit="))?.slice(9);
  const image = argv.find(x => x.startsWith("--image="))?.slice(8);
  const archive = argv.find(x => x.startsWith("--archive="))?.slice(10) || null;
  const archiveSha256 = argv.find(x => x.startsWith("--archive-sha256="))?.slice(17) || null;
  if (!canonical(envFile) || !SHA.test(commit || "") || !IMAGE.test(image || "") ||
      ((archive === null) !== (archiveSha256 === null)) ||
      (archive !== null && !canonical(archive)) || uid !== 1000) reject();
  const authMode = argv.includes("--tenants") ? "tenants" :
    argv.includes("--runner-key-file") ? "key-file" : "inline";
  const operatorRegistry = argv.includes("--operator-registry");
  const mode = argv.includes("--check") ? "check" : "apply";
  const result = await execute({ envFile, commit, image, archive, archiveSha256,
    mode, confirmed: mode === "apply", uid, authMode, operatorRegistry, writeRecovery });
  const expected = mode === "check" ? "ready_to_install" : "installed";
  const expectedChecks = mode === "apply" ?
    ["git", "private-env", "compose", "host", "canary", "empty-stack",
      "compose-up", "container-state", "authenticated-readiness"] :
    ["git", "private-env", "compose", "host"];
  if (result?.version !== 1 || result.state !== expected ||
      result.scope !== "local-linux" || result.commit !== commit ||
      result.authMode !== authMode || result.operatorRegistry !== operatorRegistry ||
      result.installed !== (mode === "apply") ||
      JSON.stringify(result.checks) !== JSON.stringify(expectedChecks) ||
      (mode === "apply" &&
        (result.dockerRootless !== true || result.project !== PROJECT ||
         JSON.stringify(result.services) !==
           JSON.stringify(["runner-api", "runner-worker"]))))
    reject();
  write("RUNNER_HOST_INSTALL_" + (mode === "apply" ? "PASS" : "CHECK") +
    ": " + JSON.stringify(result) + "\n");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never echo raw Docker/FS/Git errors or secrets from the private env.
    console.error("RUNNER_HOST_INSTALL_REFUSED: manual Linux rootless review required");
    process.exitCode = 1;
  });
}
