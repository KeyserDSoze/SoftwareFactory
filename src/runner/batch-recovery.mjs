/** Local-only operator reconciliation of a pending guarded batch (#103).
 * NOT exposed as an HTTP endpoint. Must be invoked explicitly on the
 * shared POSIX volume after stopping all API/worker processes. A claim,
 * started job, changed evidence or unknown file leaves the guard intact.
 */
import { constants } from "node:fs";
import { open, lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateRequest, jobDirectory } from "./common.mjs";
import { verifyJobEvidence } from "./evidence.mjs";
import { readRunnerInput } from "./input.mjs";
import { withAdmissionLock } from "./admission.mjs";
import { getWorkflow, readVerifiedWorkflowManifest } from "./workflows.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
const TENANT = /^[a-z][a-z0-9-]{2,31}$/;
const blocked = () => Object.assign(new Error("Pending batch requires manual review"),
  { code: "BATCH_RECOVERY_BLOCKED" });
const validDirectory = async pathName => {
  const st = await lstat(pathName);
  if (!st.isDirectory() || st.uid !== process.geteuid?.() ||
      (st.mode & 0o077) !== 0) throw blocked();
};
const existingDirectory = async dir => {
  try { await validDirectory(dir); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw blocked(); }
};
async function readIntent(directory, id) {
  if (typeof constants.O_NOFOLLOW !== "number") throw blocked();
  await validDirectory(directory);
  const files = await readdir(directory);
  if (!isDeepStrictEqual(files, ["intent.json"])) throw blocked();
  let fd;
  try {
    fd = await open(path.join(directory, "intent.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await fd.stat();
    const safe = st => st.isFile() && st.uid === process.geteuid?.() &&
      st.nlink === 1 && (st.mode & 0o077) === 0 &&
      Number.isSafeInteger(st.size) && st.size > 1 && st.size <= 4096;
    if (!safe(before)) throw blocked();
    const buf = Buffer.alloc(before.size);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const after = await fd.stat();
    if (bytesRead !== buf.length || !safe(after) ||
        before.dev !== after.dev || before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw blocked();
    const intent = JSON.parse(buf.toString("utf8"));
    if (!intent || Array.isArray(intent) || typeof intent !== "object" ||
        Object.keys(intent).sort().join(",") !==
          ["version","id","tenantId","jobs","manifestHash"].sort().join(",") ||
        intent.version !== 1 || intent.id !== id || !HEX.test(intent.manifestHash) ||
        !(intent.tenantId === null || TENANT.test(intent.tenantId)) ||
        !Array.isArray(intent.jobs) || intent.jobs.length < 2 ||
        intent.jobs.length > 6 || new Set(intent.jobs.map(j => j?.id)).size !== intent.jobs.length ||
        intent.jobs.some(job => !job || Array.isArray(job) ||
          Object.keys(job).sort().join(",") !== "digest,id" ||
          !UUID.test(job.id) || !HEX.test(job.digest)))
      throw blocked();
    return intent;
  } catch { throw blocked(); }
  finally { await fd?.close().catch(() => {}); }
}
async function assertJobUnstarted(root, id, digest, tenantId) {
  await validDirectory(jobDirectory(root, id));
  const claim = path.join(jobDirectory(root,id), ".claim");
  try { await lstat(claim); throw blocked(); }
  catch(error) { if (error.code !== "ENOENT") throw blocked(); }
  let verified, checked;
  try {
    verified = await verifyJobEvidence(root, id);
    checked = validateRequest(await readRunnerInput(root, id));
  } catch { throw blocked(); }
  const report = verified.report;
  if (report.id !== id || report.digest !== digest || checked.digest !== digest ||
      (report.tenantId ?? null) !== tenantId ||
      report.state !== "queued" || report.startedAt !== null ||
      report.finishedAt !== null || !Array.isArray(report.results) ||
      report.results.length !== 0 || verified.entries.length !== 1 ||
      verified.entries[0].kind !== "accepted" ||
      verified.report.evidence?.count !== 1) throw blocked();
}
export async function reconcilePendingBatch({ dataDir, id, action }) {
  if (!path.isAbsolute(dataDir) || dataDir === "/" ||
      typeof id !== "string" || !UUID.test(id) ||
      !["abort", "finalize"].includes(action)) throw blocked();
  return withAdmissionLock(dataDir, async () => {
    const root = path.join(dataDir,"workflows");
    await validDirectory(root);
    const pending = path.join(root, ".pending-" + id);
    const intent = await readIntent(pending, id);
    const stage = path.join(dataDir,"workflow-staging",id);
    let manifest = null;
    try { manifest = await readVerifiedWorkflowManifest(dataDir,id); }
    catch(error) { if (error.code !== "ENOENT") throw blocked(); }
    if (action === "abort" && manifest) throw blocked();
    const found = [];
    for (const job of intent.jobs) {
      const live = await existingDirectory(jobDirectory(dataDir,job.id));
      const staged = await existingDirectory(jobDirectory(stage,job.id));
      if (live && staged) throw blocked();
      // Abort can be retried after crashing halfway through safe unlink.
      // A missing job is acceptable ONLY when the manifest is absent:
      // there is no new work to start and the marker still fences workers.
      if (!live && !staged) {
        if (action !== "abort") throw blocked();
        found.push({ id: job.id, live: false, absent: true });
        continue;
      }
      const location = live ? dataDir : stage;
      await assertJobUnstarted(location,job.id,job.digest,intent.tenantId);
      found.push({ id: job.id, live, absent: false });
    }
    if (action === "abort") {
      // Preflight all journals and claims above, BEFORE touching any paths.
      for (const job of found) {
        if (job.live)
          await rm(jobDirectory(dataDir,job.id), { recursive:true });
      }
      if (await existingDirectory(stage)) await rm(stage, { recursive: true });
      await rm(pending, { recursive:true });
      return { version:1, id, action:"abort", jobCount:found.length };
    }
    // Finalization after a crash between writing the manifest and removing
    // its guard requires complete, correctly bound evidence for every job.
    if (!manifest || !manifest.enforced || manifest.version !== 2 ||
        manifest.hash !== intent.manifestHash ||
        !isDeepStrictEqual(manifest.tasks.map(t => ({id:t.jobId,digest:t.digest})),intent.jobs) ||
        found.some(job=>!job.live)) throw blocked();
    const projection = await getWorkflow(dataDir,id,intent.tenantId);
    if (projection.tasks.some(t => t.status === "out_of_order")) throw blocked();
    if (await existingDirectory(stage)) await rm(stage, { recursive:true });
    await rm(pending, { recursive:true });
    return { version:1, id, action:"finalize", jobCount:found.length };
  });
}
