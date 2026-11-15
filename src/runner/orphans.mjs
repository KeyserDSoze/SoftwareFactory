/** Operator-only Docker job reconciliation. No automatic prune and no secret labels. */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jobDirectory } from "./common.mjs";
import { verifyJobEvidence } from "./evidence.mjs";

const execFile = promisify(execFileCallback);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
// "fullstack" is a CI-only integration fixture; API request validation still forbids it.
const STEPS = new Set(["dotnet-build", "dotnet-test", "web-build", "web-test", "playwright", "npm-prepare", "fullstack"]);
const RUNNER_LABEL = "softwarefactory.runner";
const JOB_LABEL = "softwarefactory.job-id";
const STEP_LABEL = "softwarefactory.step";

export function runnerContainerIdentity(id, step) {
  if (!UUID.test(id) || !STEPS.has(step)) throw Error("Invalid runner container identity");
  return { name: "sf-" + id + "-" + step,
    labels: [[RUNNER_LABEL, "job"], [JOB_LABEL, id], [STEP_LABEL, step]] };
}
/** Docker socket paths are not a security proof: inspect the daemon's own mode. */
export function rootlessSecurityOptions(options) {
  return Array.isArray(options) && options.some(option => option === "name=rootless");
}
let inspectedHost = null;
async function defaultDocker(args) {
  const host = process.env.DOCKER_HOST || "unix:///run/docker.sock";
  // Never silently inspect an unrelated rootful host Docker daemon.
  if (host !== "unix:///run/docker.sock" && !/^unix:\/\/\/run\/user\/[0-9]+\/docker\.sock$/.test(host))
    throw Error("Operator command requires a dedicated rootless Docker socket");
  const env = { PATH: process.env.PATH, HOME: "/tmp", DOCKER_HOST: host };
  if (inspectedHost !== host) {
    const { stdout } = await execFile("docker",
      ["info", "--format", "{{json .SecurityOptions}}"],
      { timeout: 12_000, maxBuffer: 2_000_000, env });
    let options;
    try { options = JSON.parse(stdout); } catch { throw Error("Invalid Docker daemon security options"); }
    if (!rootlessSecurityOptions(options))
      throw Error("Docker daemon is not confirmed rootless; orphan cleanup refused");
    inspectedHost = host;
  }
  const { stdout } = await execFile("docker", args, {
    timeout: 12_000, maxBuffer: 2_000_000, env,
  });
  return stdout;
}
async function claimExists(dataDir, jobId) {
  try { await lstat(path.join(jobDirectory(dataDir, jobId), ".claim")); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function verifiedCandidate(runDocker, shortId, jobId) {
  const raw = await runDocker(["inspect", shortId]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw Error("Unexpected Docker inspect response");
  const container = parsed[0], labels = container?.Config?.Labels;
  const step = labels?.[STEP_LABEL];
  if (typeof container?.Id !== "string" || !CONTAINER_ID.test(container.Id) ||
      !container.Id.startsWith(shortId) || !STEPS.has(step) ||
      labels?.[RUNNER_LABEL] !== "job" || labels?.[JOB_LABEL] !== jobId ||
      container.Name !== "/" + runnerContainerIdentity(jobId, step).name ||
      typeof container?.State?.Status !== "string")
    throw Error("Docker container labels/name do not match the requested runner job");
  return { id: container.Id, name: container.Name.slice(1), step, state: container.State.Status };
}

/** Dry run is the default. Only a terminal failed/incomplete verified job without
 * a .claim may be cleaned, and each Docker ID is re-inspected before deletion.
 * Docker backend is injectable only for deterministic tests and isolated CI.
 */
export async function reconcileRunnerContainers({
  dataDir = process.env.RUNNER_DATA_DIR || "/data",
  jobId, apply = false, confirmJob = null, runDocker = defaultDocker,
} = {}) {
  if (typeof jobId !== "string" || !UUID.test(jobId))
    throw Error("A full runner job UUID is required");
  if (apply && confirmJob !== jobId)
    throw Error("Cleanup requires --confirm-job with the same complete UUID");
  const { report } = await verifyJobEvidence(dataDir, jobId);
  const claimed = await claimExists(dataDir, jobId);
  const eligible = !claimed && ["failed", "incomplete"].includes(report.state);
  // Never take action based on a partial, corrupt or stale job report.
  if (apply && !eligible)
    throw Error("Cleanup denied: job must be failed/incomplete and have no active claim");
  const raw = await runDocker(["ps", "-a",
    "--filter", "label=" + RUNNER_LABEL + "=job",
    "--filter", "label=" + JOB_LABEL + "=" + jobId,
    "--format", "{{.ID}}"]);
  const ids = raw.trim() ? raw.trim().split(/\r?\n/) : [];
  if (ids.length > 16 || new Set(ids).size !== ids.length ||
      ids.some(id => !CONTAINER_ID.test(id)))
    throw Error("Unexpected Docker container IDs");
  const containers = [];
  for (const id of ids) containers.push(await verifiedCandidate(runDocker, id, jobId));
  if (apply) {
    for (const container of containers) {
      const latest = await verifyJobEvidence(dataDir, jobId);
      if (!["failed", "incomplete"].includes(latest.report.state) ||
          await claimExists(dataDir, jobId))
        throw Error("Cleanup aborted: job state or claim changed");
      const confirmed = await verifiedCandidate(runDocker, container.id, jobId);
      if (confirmed.id !== container.id || confirmed.name !== container.name ||
          confirmed.step !== container.step)
        throw Error("Cleanup aborted: Docker identity changed");
      await runDocker(["rm", "-f", confirmed.id]);
    }
  }
  return { jobId, reportState: report.state, claimed, eligible, applied: apply,
    containers, removed: apply ? containers.map(c => c.id) : [] };
}
function help() {
  return "Usage: node orphans.mjs --job=<UUID> [--apply --confirm-job=<same UUID>]\n" +
    "Default: dry-run. Requires rootless DOCKER_HOST, verified terminal job and no .claim to remove.\n";
}
async function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") { process.stdout.write(help()); return; }
  const allowed = /^--(?:job|confirm-job)=[a-f0-9-]{36}$|^--apply$/;
  if (!argv.length || argv.some(arg => !allowed.test(arg)) ||
      argv.filter(arg => arg.startsWith("--job=")).length !== 1 ||
      argv.filter(arg => arg === "--apply").length > 1 ||
      argv.filter(arg => arg.startsWith("--confirm-job=")).length > 1)
    throw Error("Invalid arguments. " + help().trim());
  const jobId = argv.find(s => s.startsWith("--job=")).slice(6);
  const apply = argv.includes("--apply");
  const confirmJob = argv.find(s => s.startsWith("--confirm-job="))?.slice(14) || null;
  if (!apply && confirmJob) throw Error("--confirm-job requires --apply");
  const result = await reconcileRunnerContainers({ jobId, apply, confirmJob });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(e => {
    console.error("Orphan reconciliation refused:", e.message);
    process.exitCode = 1;
  });
