import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, jobDirectory, readReport, validateRequest } from "../common.mjs";
import { recordJobEvidence, portableEvidenceBundle, verifyEvidenceExport,
  verifyJobEvidence } from "../evidence.mjs";
import { evidenceStatement, signEvidenceBundle, verifySignedEvidence,
  publicKeyFingerprint } from "../attest.mjs";

const execFile = promisify(execFileCallback);
const attestor = fileURLToPath(new URL("../attest.mjs", import.meta.url));
const id = "00000000-0000-4000-a000-000000000023";
const files = { "src/frontend/web/src/App.tsx": "export default function App() { return null }" };
const pair = () => generateKeyPairSync("ed25519");
async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sf-signed-evidence-"));
  const dir = jobDirectory(dataDir, id);
  await mkdir(dir, { recursive: true });
  const checked = validateRequest({ label: "attestation", files, steps: ["web-build"] });
  await atomicWrite(path.join(dir, "report.json"), {
    id, digest: checked.digest, state: "queued", acceptedAt: new Date().toISOString(),
    label: "attestation", steps: checked.request.steps, results: [],
  });
  const initial = await readReport(dataDir, id);
  await recordJobEvidence(dataDir, id, initial, "accepted");
  await recordJobEvidence(dataDir, id, { ...initial, state: "running",
    startedAt: new Date().toISOString() }, "started");
  const running = await readReport(dataDir, id);
  await recordJobEvidence(dataDir, id, {
    ...running, state: "failed", finishedAt: new Date().toISOString(),
    results: [{ step: "web-build", state: "failed", exitCode: 1,
      durationMs: 23, stdout: "Compilation failed", stderr: "" }],
  }, "finished");
  return { dataDir, bundle: portableEvidenceBundle(await verifyJobEvidence(dataDir, id)) };
}

test("offline Ed25519 signature pins full report, journal and independent trusted public key", async () => {
  const { dataDir, bundle } = await setup();
  try {
    const { privateKey, publicKey } = pair();
    const receipt = signEvidenceBundle(bundle, privateKey);
    const valid = verifySignedEvidence(bundle, receipt, publicKey);
    assert.equal(valid.verified, true);
    assert.equal(valid.state, "failed");
    assert.equal(valid.jobId, id);
    assert.equal(valid.count, 3);
    assert.equal(valid.signerKeySha256, publicKeyFingerprint(publicKey));
    assert.equal(receipt.statement.inputDigest, bundle.report.digest);
    assert.equal(receipt.statement.bundleSha256, evidenceStatement(bundle).bundleSha256);
    assert.ok(!JSON.stringify(receipt).includes("Compilation failed"),
      "portable signature is a minimal manifest, not an echo of sensitive test logs");
    // JSON key order and whitespace changes in the downloaded export do not change its identity.
    const reformatted = JSON.parse(JSON.stringify(bundle));
    reformatted.report = Object.fromEntries(Object.entries(bundle.report).reverse());
    assert.equal(verifySignedEvidence(reformatted, receipt, publicKey).verified, true);
    assert.throws(() => verifySignedEvidence(bundle, receipt, pair().publicKey), /verification failed/);
    assert.throws(() => verifySignedEvidence(bundle, {
      ...receipt, signature: (receipt.signature[0] === "A" ? "B" : "A") + receipt.signature.slice(1),
    }, publicKey), /verification failed/);
    assert.throws(() => signEvidenceBundle(bundle, pair().publicKey), Error);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("offline exported evidence catches edits, missing entries, false status and forged signatures", async () => {
  const { dataDir, bundle } = await setup();
  try {
    const { privateKey, publicKey } = pair();
    const signature = signEvidenceBundle(bundle, privateKey);
    const mutate = transform => {
      const clone = structuredClone(bundle);
      transform(clone);
      return clone;
    };
    for (const corrupt of [
      mutate(x => { x.report.state = "passed"; }),
      mutate(x => { x.entries[2].report.results[0].exitCode = 0; }),
      mutate(x => { x.entries.pop(); x.count--; }),
      mutate(x => { x.entries[1].previousHash = "0".repeat(64); }),
      mutate(x => { x.entries[0].report.label = "falsified"; }),
    ]) {
      assert.throws(() => verifyEvidenceExport(corrupt), /integrity/);
      assert.throws(() => verifySignedEvidence(corrupt, signature, publicKey), /verification failed/);
    }
    // A hostile server administrator can recompute the entire local journal and report,
    // but cannot reuse an off-host signature of the original evidence bundle.
    const forged = mutate(x => {
      const entry = x.entries[2];
      entry.report.state = "passed";
      entry.report.results[0].state = "passed";
      entry.report.results[0].exitCode = 0;
      const { hash, ...record } = entry;
      entry.hash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
      x.head = entry.hash;
      x.report = { ...entry.report, evidence: {
        version: 1, count: x.entries.length, head: entry.hash,
      } };
    });
    assert.equal(verifyEvidenceExport(forged).report.state, "passed");
    assert.throws(() => verifySignedEvidence(forged, signature, publicKey), /verification failed/,
      "independent pinned signature detects a full local journal rewrite");
    const other = { ...signature,
      statement: { ...signature.statement, jobId: "00000000-0000-4000-a000-000000000099" } };
    assert.throws(() => verifySignedEvidence(bundle, other, publicKey), /verification failed/);
    const unsigned = { ...signature, signerKeySha256: "0".repeat(64) };
    assert.throws(() => verifySignedEvidence(bundle, unsigned, publicKey), /verification failed/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("offline CLI refuses insecure private keys, verifies with pinned public key and never overwrites receipt", async () => {
  const { dataDir, bundle } = await setup();
  try {
    const { privateKey, publicKey } = pair();
    const evidenceFile = path.join(dataDir, "export.json");
    const privateFile = path.join(dataDir, "signer.key");
    const publicFile = path.join(dataDir, "trusted.pub");
    const receiptFile = path.join(dataDir, "receipt.json");
    await writeFile(evidenceFile, JSON.stringify(bundle), { mode: 0o600 });
    await writeFile(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await writeFile(publicFile, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
    const run = async args => execFile(process.execPath, [attestor, ...args],
      { timeout: 7000, maxBuffer: 100_000 });
    const signArgs = ["sign", "--evidence=" + evidenceFile,
      "--private-key=" + privateFile, "--out=" + receiptFile];
    const signed = await run(signArgs);
    assert.match(signed.stdout, /RUNNER_ATTESTATION_SIGNED/);
    assert.equal((await stat(receiptFile)).mode & 0o077, 0);
    const verified = await run(["verify", "--evidence=" + evidenceFile,
      "--receipt=" + receiptFile, "--public-key=" + publicFile]);
    assert.match(verified.stdout, /RUNNER_ATTESTATION_VERIFIED/);
    await assert.rejects(run(signArgs), /RUNNER_ATTESTATION_FAILED/);
    await rm(receiptFile);
    await writeFile(privateFile,
      privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o644 });
    await assert.rejects(run(signArgs), /RUNNER_ATTESTATION_FAILED/);
    assert.equal((await stat(privateFile)).mode & 0o077, 0o044);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
