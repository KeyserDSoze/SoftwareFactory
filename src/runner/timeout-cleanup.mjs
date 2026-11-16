/** Timeout-only Docker cleanup. Do not delete by a reusable name.
 * Fail closed on mismatched labels/ID or a daemon that is not rootless.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { runnerContainerIdentity } from "./orphans.mjs";
import { allowedRootlessHost, probeRootlessDocker } from "./docker-probe.mjs";

const execFile = promisify(execFileCallback);
const FULL_ID = /^[a-f0-9]{64}$/;
const defaultRunDocker = async (args, options) =>
  (await execFile("docker", args, options)).stdout;

function inspectedId(raw, identity) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 8192) return null;
  let entries;
  try { entries = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(entries) || entries.length !== 1) return null;
  const item = entries[0], labels = item?.Config?.Labels;
  if (!item || typeof item.Id !== "string" || !FULL_ID.test(item.Id) ||
      item.Name !== "/" + identity.name ||
      !labels || typeof labels !== "object" || Array.isArray(labels) ||
      identity.labels.some(([key, value]) => labels[key] !== value))
    return null;
  return item.Id;
}

/** Trusted Node callbacks are test seams, never available to the job/API.
 * Inspect twice (by name and then by immutable full ID) before removing by ID.
 * Return false without exposing daemon diagnostics if the proof is insufficient.
 */
export async function cleanupTimedOutRunnerContainer(jobId, step, {
  host = process.env.DOCKER_HOST || "unix:///run/docker.sock",
  runDocker = defaultRunDocker, probeDocker = probeRootlessDocker,
} = {}) {
  const identity = runnerContainerIdentity(jobId, step);
  if (!allowedRootlessHost(host)) return false;
  const options = {
    timeout: 5000, maxBuffer: 8192,
    env: { PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: "/tmp", DOCKER_CONFIG: "/tmp", DOCKER_HOST: host },
  };
  try {
    if ((await probeDocker()) !== true) return false;
    const first = inspectedId(await runDocker(
      ["inspect", "--type", "container", identity.name], options), identity);
    if (!first) return false;
    const second = inspectedId(await runDocker(
      ["inspect", "--type", "container", first], options), identity);
    if (second !== first) return false;
    if ((await probeDocker()) !== true) return false;
    await runDocker(["rm", "-f", first], options);
    return true;
  } catch {
    // On uncertainty, leave the container for operator-only reconciliation.
    return false;
  }
}
