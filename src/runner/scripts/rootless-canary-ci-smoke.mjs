/** CI-only real Docker smoke for the rootless canary's container life-cycle.
 * NEVER an attestation of rootless VM isolation. GitHub hosted Docker is rootful.
 * Unlike production CLI, the injected rootless check is deliberately faked
 * solely inside this file, under an explicit CI gate + confirmed rootful daemon.
 */
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rootlessSecurityOptions } from "../orphans.mjs";
import { runRootlessCanary } from "./rootless-canary.mjs";

const execFile = promisify(execFileCallback);
const HOST = "unix:///var/run/docker.sock";

export function ciRootfulCanaryAllowed(env, uid) {
  return env?.GITHUB_ACTIONS === "true" && env?.CI === "true" &&
    Number.isInteger(uid) && uid > 0;
}
export function cachedNodeDigest(json) {
  let values;
  try { values = JSON.parse(json); } catch { throw Error("CI canary image metadata invalid"); }
  if (!Array.isArray(values) || values.length > 16)
    throw Error("CI canary image references unavailable");
  const digests = new Set();
  for (const ref of values) {
    if (typeof ref === "string" && /^(?:node|docker\.io\/library\/node)@sha256:[a-f0-9]{64}$/.test(ref))
      digests.add("node@sha256:" + ref.split("@sha256:")[1]);
  }
  if (digests.size !== 1)
    throw Error("CI canary needs exactly one locally cached immutable Node digest");
  return [...digests][0];
}
export function rootfulOnlySecurityOptions(raw) {
  let options;
  try { options = JSON.parse(raw); } catch { throw Error("CI Docker mode inspection invalid"); }
  if (!Array.isArray(options) || options.length > 32 ||
      options.some(v => typeof v !== "string" || v.length > 256) ||
      rootlessSecurityOptions(options))
    throw Error("CI canary requires explicit rootful GitHub test daemon");
  return true;
}
async function main() {
  if (!ciRootfulCanaryAllowed(process.env, process.getuid?.()))
    throw Error("CI canary forbidden outside non-root GitHub Actions");
  const env = { PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: "/tmp", DOCKER_CONFIG: "/tmp", DOCKER_HOST: HOST };
  const docker = async (args, options = {}) => {
    const { stdout } = await execFile("docker", args, {
      timeout: options.timeout || 8000, maxBuffer: options.maxBuffer || 65536, env,
    });
    return stdout;
  };
  rootfulOnlySecurityOptions(await docker(
    ["info", "--format", "{{json .SecurityOptions}}"]));
  const image = cachedNodeDigest(await docker(
    ["image", "inspect", "node:22-bookworm-slim", "--format", "{{json .RepoDigests}}"]));
  // Confirm no pre-existing labels: the host is freshly provisioned by GitHub.
  const list = () => docker(["ps", "-a",
    "--filter", "label=softwarefactory.canary", "--format", "{{.ID}}"]);
  assert.equal((await list()).trim(), "", "unexpected canary residue before CI run");
  const execute = async (args, options) => {
    if (!["create", "inspect", "start", "rm"].includes(args[0]))
      throw Error("CI canary command not allowlisted");
    if (args[0] === "create" &&
        (!args.includes("--pull=never") || !args.includes("--network=none") ||
         !args.includes("--read-only") || !args.includes("--cap-drop=ALL") ||
         !args.includes("--security-opt=no-new-privileges") ||
         !args.some(v => /^node@sha256:[a-f0-9]{64}$/.test(v))))
      throw Error("CI canary attempted an unsafe create");
    // The production canary expects unix:///run/docker.sock. This CI wrapper
    // redirects ONLY the fixed approved commands to the disposable rootful
    // host socket; never change production CLI host policy.
    return docker(args, { timeout: options.timeout, maxBuffer: options.maxBuffer });
  };
  try {
    const result = await runRootlessCanary({
      image, confirmed: true, host: "unix:///run/docker.sock",
      // Explicit test-only rootful override; no rootless claim is exported.
      probeDocker: async () => true,
      runDocker: execute,
    });
    assert.equal(result.status, "passed");
    assert.equal(result.cleanup, "verified");
    assert.equal(result.network, "none");
    assert.equal((await list()).trim(), "", "canary must not leave Docker resources");
    process.stdout.write("CANARY_REAL_DOCKER_ROOTFUL_CI_ONLY_PASS (NOT ROOTLESS VM ATTESTATION)\n");
  } finally {
    // Never indiscriminately prune; production cleanup is the responsibility
    // of the canary and any residue must fail CI for manual inspection.
    assert.equal((await list()).trim(), "",
      "CI canary left a container: manual investigation required");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("CI-only canary real Docker smoke failed (no rootless attestation)");
    process.exitCode = 1;
  });
