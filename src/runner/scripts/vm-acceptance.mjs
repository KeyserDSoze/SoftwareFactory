/** Operator-only local VM acceptance: Compose -> host -> real rootless canary.
 * Not a deployment, a remote HTTPS check or an off-host attestation.
 * Never callable by runner-api, worker polling or submitted jobs.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as preflight } from "../preflight.mjs";
import { runRootlessCanary } from "./rootless-canary.mjs";

const IMAGE = /^node@sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const VM_DOCKER_HOST = "unix:///run/user/1000/docker.sock";
const refused = () => { throw new Error("VM acceptance denied; manual investigation required"); };
const validPrivateEnvPath = value => typeof value === "string" &&
  value.length > 1 && value.length <= 4096 &&
  !/[\0\r\n]/.test(value) && path.isAbsolute(value) &&
  path.resolve(value) === value;

const isComposeProof = proof => proof?.mode === "compose" &&
  proof.status === "passed" && proof.apiLoopbackOnly === true &&
  proof.dockerSocketInWorkerOnly === true &&
  typeof proof.tunnelServiceChecked === "boolean";
const isHostProof = (proof, authMode, operatorRegistry) =>
  proof?.mode === "host" && proof.status === "passed" &&
  proof.uid === 1000 && proof.dockerRootless === true &&
  proof.directoriesPrivate === true && proof.socketPrivate === true &&
  (authMode === "inline" && !operatorRegistry ||
    proof.credentialMode === authMode &&
    proof.credentialsPrivate === true &&
    proof.operatorRegistryChecked === operatorRegistry);
const isCanaryProof = proof => proof?.status === "passed" &&
  proof.dockerRootless === true && proof.network === "none" &&
  proof.readonlyRootfs === true && proof.capsDropped === true &&
  proof.cleanup === "verified";

const profileFlags = (authMode, operators) => [
  ...(authMode === "key-file" ? ["--runner-key-file"] : []),
  ...(authMode === "tenants" ? ["--tenants"] : []),
  ...(operators ? ["--operator-registry"] : []),
];

/** All injectable callbacks are trusted Node TEST seams, not CLI arguments.
 * The real CLI always performs the actual preflight and Docker operations.
 */
export async function runVmAcceptance({
  envFile, image, authMode = "inline", operatorRegistry = false,
  confirmed = false, uid = process.getuid?.(), id = randomUUID(),
  preflightCheck = (argv) => preflight(argv, { write: () => {} }),
  canaryCheck = runRootlessCanary,
  writeRecovery = value => process.stderr.write(value),
} = {}) {
  if (confirmed !== true || uid !== 1000 ||
      !validPrivateEnvPath(envFile) || !IMAGE.test(image) ||
      !UUID.test(id) ||
      !["inline", "key-file", "tenants"].includes(authMode) ||
      typeof operatorRegistry !== "boolean" ||
      (authMode === "tenants" && operatorRegistry))
    refused();
  const flags = ["--env-file=" + envFile,
    ...profileFlags(authMode, operatorRegistry)];
  try {
    const compose = await preflightCheck(["compose", ...flags]);
    if (!isComposeProof(compose)) refused();
    const host = await preflightCheck(["host", ...flags]);
    if (!isHostProof(host, authMode, operatorRegistry)) refused();
    // Printed *after* both preflight gates but *before* Docker create:
    // operator can investigate an interrupted create with canary-reconcile.
    writeRecovery("ROOTLESS_CANARY_ID=" + id + "\n");
    const canary = await canaryCheck({
      image, confirmed: true, host: VM_DOCKER_HOST, id,
    });
    if (!isCanaryProof(canary)) refused();
    // A local, unsigned summary, NOT independent attestation or Cloudflare proof.
    return {
      version: 1, scope: "local-vm", status: "passed",
      authMode, operatorRegistry, canaryId: id,
      checks: ["compose", "host", "canary"],
      dockerRootless: true, canaryCleanup: "verified",
    };
  } catch {
    // Never print private env contents, Docker errors, paths or credentials.
    refused();
  }
}

const usage = "VM acceptance requires --env-file=/absolute/private.env " +
  "--image=node@sha256:<digest> --confirm " +
  "[--runner-key-file|--tenants] [--operator-registry]";
export async function main(argv = process.argv.slice(2), {
  execute = runVmAcceptance, uid = process.getuid?.(),
  write = value => process.stdout.write(value),
  writeRecovery = value => process.stderr.write(value),
} = {}) {
  const allowed = ["--confirm", "--runner-key-file", "--tenants",
    "--operator-registry"];
  if (!Array.isArray(argv) || argv.length < 3 || argv.length > 6 ||
      argv.some(v => typeof v !== "string" ||
        !(allowed.includes(v) || /^--env-file=[^\r\n]+$/.test(v) ||
          /^--image=node@sha256:[a-f0-9]{64}$/.test(v))) ||
      new Set(argv.map(v => v.split("=")[0])).size !== argv.length ||
      !argv.includes("--confirm") ||
      argv.includes("--tenants") &&
        (argv.includes("--runner-key-file") ||
         argv.includes("--operator-registry")))
    refused();
  const envFile = argv.find(v => v.startsWith("--env-file="))?.slice(11);
  const image = argv.find(v => v.startsWith("--image="))?.slice(8);
  if (!validPrivateEnvPath(envFile) || !IMAGE.test(image))
    refused();
  const authMode = argv.includes("--tenants") ? "tenants" :
    argv.includes("--runner-key-file") ? "key-file" : "inline";
  const operatorRegistry = argv.includes("--operator-registry");
  const receipt = await execute({
    envFile, image, authMode, operatorRegistry,
    confirmed: true, uid, writeRecovery,
  });
  if (receipt?.version !== 1 || receipt.scope !== "local-vm" ||
      receipt.status !== "passed" || receipt.authMode !== authMode ||
      receipt.operatorRegistry !== operatorRegistry ||
      !UUID.test(receipt.canaryId) ||
      JSON.stringify(receipt.checks) !==
        JSON.stringify(["compose", "host", "canary"]) ||
      receipt.dockerRootless !== true ||
      receipt.canaryCleanup !== "verified")
    refused();
  write("RUNNER_VM_ACCEPTANCE_PASS: " + JSON.stringify(receipt) + "\n");
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("RUNNER_VM_ACCEPTANCE_FAILED: inspect local VM and any canary residue manually");
    process.exitCode = 1;
  });
