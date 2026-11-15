/** Per-job SHA-256 chained JSONL. Tamper-evident, not remote attestation or WORM. */
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, jobDirectory, readReport } from "./common.mjs";

const ZERO = "0".repeat(64);
const HEX = /^[a-f0-9]{64}$/;
const KINDS = new Set(["accepted", "started", "preparation", "step", "finished", "recovered", "rejected"]);
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshot = value => { const copy = { ...value }; delete copy.evidence; return copy; };
const invalid = () => Object.assign(new Error("Runner evidence integrity check failed"), { code: "EVIDENCE_INVALID" });
const journalPath = (dataDir, id) => path.join(jobDirectory(dataDir, id), "evidence.jsonl");

/** A missing report remains 404; missing/corrupt journal for an existing report is 409. */
export async function verifyJobEvidence(dataDir, id) {
  const report = await readReport(dataDir, id);
  try {
    const content = await readFile(journalPath(dataDir, id), "utf8");
    if (!content.endsWith("\n") || Buffer.byteLength(content) > 4_000_000) throw invalid();
    const lines = content.slice(0, -1).split("\n");
    if (!lines.length || lines.length > 48) throw invalid();
    let previousHash = ZERO;
    const entries = [];
    for (const line of lines) {
      const item = JSON.parse(line);
      if (!item || Array.isArray(item)) throw invalid();
      const { hash, ...record } = item;
      if (Object.keys(record).join(",") !== "version,sequence,previousHash,kind,at,report" ||
          item.version !== 1 || item.sequence !== entries.length + 1 ||
          item.previousHash !== previousHash || !KINDS.has(item.kind) ||
          !Number.isFinite(Date.parse(item.at)) || !item.report ||
          item.report.id !== id || item.report.digest !== report.digest ||
          typeof hash !== "string" || !HEX.test(hash) || sha(record) !== hash)
        throw invalid();
      previousHash = hash;
      entries.push(item);
    }
    if (entries[0].kind !== "accepted" ||
        report.evidence?.version !== 1 || report.evidence?.count !== entries.length ||
        report.evidence?.head !== previousHash ||
        JSON.stringify(snapshot(report)) !== JSON.stringify(entries.at(-1).report))
      throw invalid();
    return { report, entries, head: previousHash };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EVIDENCE_INVALID" || error instanceof SyntaxError)
      throw invalid();
    throw error;
  }
}

/** Exclusive writer: API owns fresh UUID; worker and recovery hold atomic .claim.
 * Fsync journal before replacing report. Interrupted updates deny access
 * until operator reconciliation; NEVER silently truncate/rewrite the journal.
 */
export async function recordJobEvidence(dataDir, id, report, kind) {
  if (!KINDS.has(kind)) throw Error("Invalid evidence event");
  let previousHash = ZERO, count = 0;
  if (kind === "accepted") {
    if (report.state !== "queued" || report.evidence) throw invalid();
  } else {
    const previous = await verifyJobEvidence(dataDir, id);
    if (["passed", "failed", "incomplete"].includes(previous.report.state)) throw invalid();
    previousHash = previous.head;
    count = previous.entries.length;
  }
  if (count >= 48) throw invalid();
  const record = { version: 1, sequence: count + 1, previousHash, kind,
    at: new Date().toISOString(), report: snapshot(report) };
  const hash = sha(record);
  const handle = await open(journalPath(dataDir, id), kind === "accepted" ? "wx" : "a", 0o600);
  try { await handle.writeFile(JSON.stringify({ ...record, hash }) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  report.evidence = { version: 1, count: count + 1, head: hash };
  await atomicWrite(path.join(jobDirectory(dataDir, id), "report.json"), report);
  return report;
}
