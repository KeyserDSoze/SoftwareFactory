/** Offline Ed25519 attestations. The private signing key MUST stay off the runner host.
 * A signature binds an exported journal to an operator-controlled key; it cannot
 * prove that a Docker run happened or that the signer inspected real hardware.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyEvidenceExport } from "./evidence.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const invalid = () => Object.assign(new Error("Offline runner attestation verification failed"), {
  code: "ATTESTATION_INVALID",
});
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** Sort object keys recursively so reformatting an export does not change its identity. */
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" +
      canonical(value[k])).join(",") + "}";
  throw invalid();
}
function ed25519Public(value) {
  const publicKey = createPublicKey(value);
  if (publicKey.asymmetricKeyType !== "ed25519") throw invalid();
  return publicKey;
}
export function publicKeyFingerprint(value) {
  return sha(ed25519Public(value).export({ type: "spki", format: "der" }));
}
export function evidenceStatement(bundle) {
  const { report, head, entries } = verifyEvidenceExport(bundle);
  if (!["passed", "failed", "incomplete"].includes(report.state)) throw invalid();
  return { version: 1, context: "softwarefactory.runner.evidence.v1",
    jobId: report.id, inputDigest: report.digest, state: report.state,
    count: entries.length, head, bundleSha256: sha(canonical(bundle)) };
}
export function signEvidenceBundle(bundle, privateKeySource) {
  const statement = evidenceStatement(bundle);
  const privateKey = createPrivateKey(privateKeySource);
  if (privateKey.asymmetricKeyType !== "ed25519") throw invalid();
  const publicKey = ed25519Public(privateKey);
  return { version: 1, algorithm: "Ed25519", statement,
    signerKeySha256: publicKeyFingerprint(publicKey),
    signature: sign(null, Buffer.from(canonical(statement)), privateKey).toString("base64url") };
}
export function verifySignedEvidence(bundle, receipt, trustedPublicKeySource) {
  try {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
        Object.keys(receipt).join(",") !==
          "version,algorithm,statement,signerKeySha256,signature" ||
        receipt.version !== 1 || receipt.algorithm !== "Ed25519" ||
        typeof receipt.signerKeySha256 !== "string" || !HASH.test(receipt.signerKeySha256) ||
        typeof receipt.signature !== "string" || !SIG.test(receipt.signature))
      throw invalid();
    const statement = evidenceStatement(bundle);
    if (canonical(receipt.statement) !== canonical(statement)) throw invalid();
    const trustedPublicKey = ed25519Public(trustedPublicKeySource);
    if (receipt.signerKeySha256 !== publicKeyFingerprint(trustedPublicKey)) throw invalid();
    const signature = Buffer.from(receipt.signature, "base64url");
    if (signature.length !== 64 ||
        !verify(null, Buffer.from(canonical(statement)), trustedPublicKey, signature))
      throw invalid();
    return { verified: true, jobId: statement.jobId,
      inputDigest: statement.inputDigest, state: statement.state,
      count: statement.count, head: statement.head,
      signerKeySha256: receipt.signerKeySha256 };
  } catch { throw invalid(); }
}
async function readBoundedJson(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4_000_000)
    throw invalid();
  return JSON.parse(await readFile(filename, "utf8"));
}
async function readPrivateKey(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      info.size > 20_000 || info.size === 0)
    throw invalid();
  return await readFile(filename);
}
/** Exact argv vocabulary: no secret bytes in args or logs. */
export async function main(argv = process.argv.slice(2)) {
  const [mode, ...options] = argv;
  const expected = mode === "sign"
    ? ["evidence", "private-key", "out"]
    : mode === "verify" ? ["evidence", "receipt", "public-key"] : null;
  const flags = Object.create(null);
  if (!expected || options.length !== expected.length) throw invalid();
  for (const option of options) {
    const m = /^--([a-z-]+)=(.+)$/.exec(option);
    if (!m || !expected.includes(m[1]) || flags[m[1]]) throw invalid();
    flags[m[1]] = m[2];
  }
  if (expected.some(k => !flags[k])) throw invalid();
  const bundle = await readBoundedJson(flags.evidence);
  if (mode === "sign") {
    const key = await readPrivateKey(flags["private-key"]);
    const receipt = signEvidenceBundle(bundle, key);
    await writeFile(flags.out, JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600, flag: "wx",
    });
    process.stdout.write("RUNNER_ATTESTATION_SIGNED\n");
    return receipt;
  }
  const receipt = await readBoundedJson(flags.receipt);
  const pub = await readFile(flags["public-key"], "utf8");
  const status = verifySignedEvidence(bundle, receipt, pub);
  process.stdout.write("RUNNER_ATTESTATION_VERIFIED\n");
  return status;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    // Do not echo key paths, payloads, private key material or exported test logs.
    console.error("RUNNER_ATTESTATION_FAILED");
    process.exitCode = 1;
  });
