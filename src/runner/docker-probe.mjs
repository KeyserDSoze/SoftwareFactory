/** Read-only daemon inspection from the WORKER only. Never mount or
 * contact Docker from runner-api; a socket path is not proof of rootless mode.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { rootlessSecurityOptions } from "./orphans.mjs";

const execFile = promisify(execFileCallback);
export function allowedRootlessHost(host) {
  return host === "unix:///run/docker.sock" ||
    /^unix:\/\/\/run\/user\/[0-9]+\/docker\.sock$/.test(host);
}

/** No shell, no arbitrary daemon URI, no inherited Docker credentials.
 * Fail closed on non-rootless, unavailable, timed-out or malformed responses.
 */
export async function probeRootlessDocker({
  host = process.env.DOCKER_HOST || "unix:///run/docker.sock",
  runDocker = async (args, options) =>
    (await execFile("docker", args, options)).stdout,
} = {}) {
  if (!allowedRootlessHost(host)) return false;
  try {
    const raw = await runDocker(
      ["info", "--format", "{{json .SecurityOptions}}"],
      {
        timeout: 5000, maxBuffer: 4096,
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          HOME: "/tmp", DOCKER_CONFIG: "/tmp", DOCKER_HOST: host,
        },
      });
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 4096)
      return false;
    const options = JSON.parse(raw);
    if (!Array.isArray(options) || options.length > 32 ||
        options.some(value => typeof value !== "string" || value.length > 256))
      return false;
    return rootlessSecurityOptions(options);
  } catch {
    // Never leak daemon errors, socket paths, or Docker client environment.
    return false;
  }
}
