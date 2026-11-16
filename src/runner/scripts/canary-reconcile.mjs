/** Manual, strictly single-canary recovery from a failed rootless isolation test.
 * No automatic pruning, API route, worker integration, or untrusted user code.
 * The operator must ensure no concurrent canary process is running.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowedRootlessHost, probeRootlessDocker } from "../docker-probe.mjs";
import { safeConfig } from "./rootless-canary.mjs";

const execFile = promisify(execFileCallback);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FULL_ID = /^[a-f0-9]{64}$/;
const SHORT_ID = /^[a-f0-9]{12,64}$/;
const LABEL = "softwarefactory.canary";
const MAX_OUTPUT = 65536;
const refuse = () => { throw Error("Canary reconciliation denied; manual investigation required"); };

const localDocker = async (args, options) =>
  (await execFile("docker", args, options)).stdout;

function verifiedContainer(raw, name, selectedId) {
  let data;
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_OUTPUT)
      refuse();
    data = JSON.parse(raw);
  } catch { refuse(); }
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      typeof data.Id !== "string" || !FULL_ID.test(data.Id) ||
      !data.Id.startsWith(selectedId) || !safeConfig(data, name, data.Id) ||
      data.Config?.Labels?.["softwarefactory.runner"] !== undefined ||
      data.State?.Running !== false ||
      !["created", "exited"].includes(data.State?.Status))
    refuse();
  return { id: data.Id, name, state: data.State.Status };
}

/** The injected Docker/probe callbacks are Node-only testing seams, never
 * configurable by an HTTP request, environment bypass or submitted job.
 */
export async function reconcileRootlessCanary({
  canaryId, apply = false, confirmCanary = null,
  host = process.env.DOCKER_HOST || "unix:///run/docker.sock",
  probeDocker = probeRootlessDocker, runDocker = localDocker,
} = {}) {
  if (typeof canaryId !== "string" || !UUID.test(canaryId) ||
      typeof apply !== "boolean" ||
      (apply && confirmCanary !== canaryId) ||
      (!apply && confirmCanary !== null) ||
      !allowedRootlessHost(host)) refuse();
  const name = "sf-canary-" + canaryId;
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: "/tmp", DOCKER_CONFIG: "/tmp", DOCKER_HOST: host,
  };
  const command = async argv => {
    // Re-probe for ps, each inspect, and especially destructive rm. A previous
    // rootless result is never authority to operate on a replaced daemon.
    let rootless = false;
    try { rootless = (await probeDocker({ host })) === true; } catch {}
    if (!rootless) refuse();
    try {
      const output = await runDocker(argv, {
        timeout: 8000, maxBuffer: MAX_OUTPUT, env,
      });
      if (typeof output !== "string" ||
          Buffer.byteLength(output, "utf8") > MAX_OUTPUT) refuse();
      return output;
    } catch { refuse(); }
  };
  const rawIds = await command([
    "ps", "-a", "--filter", "label=" + LABEL + "=" + name,
    "--format", "{{.ID}}",
  ]);
  const ids = rawIds.trim() ? rawIds.trim().split(/\r?\n/) : [];
  if (ids.length > 1 || ids.some(id => !SHORT_ID.test(id))) refuse();
  if (ids.length === 0) return {
    canaryId, found: false, eligible: false, applied: false, removed: [],
  };
  const first = verifiedContainer(
    await command(["inspect", "--format", "{{json .}}", ids[0]]),
    name, ids[0]);
  if (!apply) return {
    canaryId, found: true, eligible: true, applied: false, container: first, removed: [],
  };
  const second = verifiedContainer(
    await command(["inspect", "--format", "{{json .}}", first.id]),
    name, first.id);
  if (second.id !== first.id || second.state !== first.state) refuse();
  const acknowledgement = (await command(["rm", "-f", first.id])).trim();
  if (acknowledgement !== first.id) refuse();
  return {
    canaryId, found: true, eligible: true, applied: true, container: second,
    removed: [first.id],
  };
}

const help = "Usage: node scripts/canary-reconcile.mjs --canary=<UUID> " +
  "[--apply --confirm-canary=<same UUID>] (dry-run by default)\n";

/** No generic list-all/prune: only a UUID from ROOTLESS_CANARY_ID can be used. */
export async function main(argv = process.argv.slice(2), {
  reconcile = reconcileRootlessCanary,
  uid = process.getuid?.(), write = value => process.stdout.write(value),
} = {}) {
  if (argv.length === 1 && argv[0] === "--help") { write(help); return null; }
  if (!Number.isSafeInteger(uid) || uid === 0) refuse();
  if (argv.length < 1 || argv.length > 3 ||
      argv.some(a => !/^--canary=[a-f0-9-]{36}$/.test(a) &&
        !/^--confirm-canary=[a-f0-9-]{36}$/.test(a) && a !== "--apply") ||
      argv.filter(a => a.startsWith("--canary=")).length !== 1 ||
      argv.filter(a => a === "--apply").length > 1 ||
      argv.filter(a => a.startsWith("--confirm-canary=")).length > 1) refuse();
  const canaryId = argv.find(a => a.startsWith("--canary=")).slice(9);
  const apply = argv.includes("--apply");
  const confirmCanary = argv.find(a =>
    a.startsWith("--confirm-canary="))?.slice(17) || null;
  if (!UUID.test(canaryId) ||
      (apply && confirmCanary !== canaryId) ||
      (!apply && confirmCanary !== null)) refuse();
  const result = await reconcile({ canaryId, apply, confirmCanary });
  write(JSON.stringify(result) + "\n");
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("CANARY_RECONCILIATION_REFUSED: use manual rootless Docker inspection");
    process.exitCode = 1;
  });
