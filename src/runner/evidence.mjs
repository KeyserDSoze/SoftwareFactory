/** Per-job SHA-256 chained JSONL. Tamper-evident, not remote attestation or WORM. */
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicWrite, jobDirectory, readReport } from "./common.mjs";

const ZERO = "0".repeat(64);
const HEX = /^[a-f0-9]{64}$/;
const KINDS = new Set(["accepted", "started", "preparation", "step", "finished", "recovered", "rejected"]);
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshot = value => { const copy = { ...value }; delete copy.evidence; return copy; };
const invalid = () => Object.assign(new Error("Runner evidence integrity check failed"), { code: "EVIDENCE_INVALID" });
const journalPath = (dataDir, id) => path.join(jobDirectory(dataDir, id), "evidence.jsonl");

/** Pure verification for export: no filesystem and no trust in claimed result. */
export function verifyEvidenceExport(bundle) {
  try {
    if (!bundle || Array.isArray(bundle) || typeof bundle !== "object" ||
        Object.keys(bundle).join(",") !== "version,id,count,head,report,entries" ||
        bundle.version !== 1 || typeof bundle.id !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(bundle.id) ||
        !HEX.test(bundle.head) || !Number.isSafeInteger(bundle.count) ||
        !bundle.report || Array.isArray(bundle.report) ||
        bundle.report.id !== bundle.id || !HEX.test(bundle.report.digest) ||
        !Array.isArray(bundle.entries) || bundle.entries.length !== bundle.count ||
        bundle.entries.length < 1 || bundle.entries.length > 48 ||
        Buffer.byteLength(JSON.stringify(bundle)) > 4_000_000) throw invalid();
    let previousHash = ZERO;
    for (const [i, entry] of bundle.entries.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
          Object.keys(entry).join(",") !== "version,sequence,previousHash,kind,at,report,hash")
        throw invalid();
      const { hash, ...record } = entry;
      if (record.version !== 1 || record.sequence !== i + 1 ||
          record.previousHash !== previousHash || !KINDS.has(record.kind) ||
          typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at)) ||
          !record.report || Array.isArray(record.report) ||
          record.report.id !== bundle.id || record.report.digest !== bundle.report.digest ||
          !HEX.test(hash) || sha(record) !== hash) throw invalid();
      previousHash = hash;
    }
    if (bundle.entries[0].kind !== "accepted" ||
        bundle.head !== previousHash || bundle.report.evidence?.version !== 1 ||
        bundle.report.evidence.count !== bundle.entries.length ||
        bundle.report.evidence.head !== previousHash ||
        !isDeepStrictEqual(snapshot(bundle.report),
          bundle.entries[bundle.entries.length - 1].report))
      throw invalid();
    return { report: bundle.report, entries: bundle.entries, head: previousHash };
  } catch (error) {
    if (error.code === "EVIDENCE_INVALID") throw error;
    throw invalid();
  }
}
export function portableEvidenceBundle(verified) {
  const { report, entries, head } = verified;
  const bundle = { version: 1, id: report.id, count: entries.length,
    head, report, entries };
  verifyEvidenceExport(bundle);
  return bundle;
}

/** Existing report without a journal is invalid; missing report remains 404. */
export async function verifyJobEvidence(dataDir, id) {
  const report = await readReport(dataDir, id);
  try {
    const content = await readFile(journalPath(dataDir, id), "utf8");
    if (!content.endsWith("\n") || Buffer.byteLength(content) > 4_000_000) throw invalid();
    const lines = content.slice(0, -1).split("\n");
    return verifyEvidenceExport({
      version: 1, id, count: lines.length,
      head: report.evidence?.head, report,
      entries: lines.map(line => JSON.parse(line)),
    });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EVIDENCE_INVALID" ||
        error instanceof SyntaxError) throw invalid();
    throw error;
  }
}

/** A worker fsyncs an appended journal entry BEFORE the atomic report rename.
 * HTTP readers can briefly observe the new journal with the old report.
 * Retry only this integrity mismatch; never accept unverified snapshots,
 * retry missing jobs, truncate a journal, or hide persistent tampering.
 */
export async function retryEvidenceRead(read) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await read(); }
    catch (error) {
      if (error.code !== "EVIDENCE_INVALID" || attempt === 2) throw error;
      await sleep(25);
    }
  }
}

export function verifyJobEvidenceForRead(dataDir, id) {
  return retryEvidenceRead(() => verifyJobEvidence(dataDir, id));
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
