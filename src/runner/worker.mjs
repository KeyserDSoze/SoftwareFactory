import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, jobDirectory, readReport, scrub, validateRequest } from "./common.mjs";
import { planStep, runDockerStep } from "./docker.mjs";

export async function executeJob(id, {
  dataDir = process.env.RUNNER_DATA_DIR || "/data",
  workspaceRoot = process.env.RUNNER_HOST_WORK_DIR || "/srv/softwarefactory/workspaces",
  executeStep = runDockerStep,
} = {}) {
  const dir = jobDirectory(dataDir, id);
  const reportFile = path.join(dir, "report.json");
  let report = await readReport(dataDir, id);
  if (report.state !== "queued") return report;
  const input = JSON.parse(await readFile(path.join(dir, "input.json"), "utf8"));
  const { request, digest } = validateRequest(input);
  if (digest !== report.digest) throw new Error("Input digest mismatch");
  // Workspace path must be identical on the worker and the rootless Docker host.
  const destination = path.resolve(workspaceRoot, id);
  if (!path.isAbsolute(workspaceRoot) || destination === path.resolve(workspaceRoot))
    throw new Error("Invalid worker workspace root");
  report = { ...report, state: "running", startedAt: new Date().toISOString(), summary: "Worker started" };
  await atomicWrite(reportFile, report);
  try {
    await mkdir(destination, { mode: 0o700, recursive: true });
    for (const [name, content] of Object.entries(request.files)) {
      const target = path.resolve(destination, name);
      if (!target.startsWith(destination + path.sep)) throw new Error("Unsafe file target");
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600, flag: "wx" });
    }
    for (const step of request.steps) {
      const plan = planStep(step, request.files, destination);
      const result = plan.skip ? { step, state: "skipped", reason: plan.skip } : await executeStep(plan, id, step);
      report.results.push(result);
      await atomicWrite(reportFile, report);
      if (result.state === "failed") break;
    }
    const failed = report.results.some(r => r.state === "failed");
    const skipped = report.results.some(r => r.state === "skipped");
    report.state = failed ? "failed" : skipped ? "incomplete" : "passed";
    report.summary = failed ? "At least one execution step failed" :
      skipped ? "Some steps were not configured; this is NOT a complete pass" : "All requested steps executed and passed";
  } catch (error) {
    report.state = "failed";
    report.summary = "Worker error: " + scrub(error instanceof Error ? error.message : String(error));
  } finally {
    report.finishedAt = new Date().toISOString();
    await atomicWrite(reportFile, report);
    await rm(destination, { recursive: true, force: true }).catch(() => {});
  }
  return report;
}

export async function runWorker({
  dataDir = process.env.RUNNER_DATA_DIR || "/data",
  workspaceRoot = process.env.RUNNER_HOST_WORK_DIR || "/srv/softwarefactory/workspaces",
  pollMs = 1500, stop = () => false,
} = {}) {
  console.log("Runner worker is polling jobs; Docker socket must be rootless and host-isolated");
  while (!stop()) {
    let entries = [];
    try { entries = await readdir(path.join(dataDir, "jobs")); }
    catch(e) { if(e.code !== "ENOENT") console.error("Queue read error:", e.message); }
    const queued = [];
    const retentionHours = Math.min(168, Math.max(1, Number(process.env.RUNNER_RETENTION_HOURS || "24") || 24));
    const expireBefore = Date.now() - retentionHours * 60 * 60 * 1000;
    for (const id of entries) {
      try {
        const report = await readReport(dataDir, id);
        if (["passed", "failed", "incomplete"].includes(report.state) &&
            Number.isFinite(Date.parse(report.finishedAt)) && Date.parse(report.finishedAt) < expireBefore) {
          await rm(jobDirectory(dataDir, id), { recursive: true, force: true });
          continue;
        }
        if (report.state === "queued") queued.push({ id, acceptedAt: report.acceptedAt });
        // Fail closed on restart rather than pretending interrupted runs completed.
        if (report.state === "running") {
          await atomicWrite(path.join(jobDirectory(dataDir, id), "report.json"), {
            ...report, state: "failed", finishedAt: new Date().toISOString(),
            summary: "Worker was interrupted; inspect and clean up orphaned Docker containers",
          });
        }
      } catch { /* malformed entry not executable */ }
    }
    queued.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    if (queued.length) {
      try { await executeJob(queued[0].id, { dataDir, workspaceRoot }); }
      catch(e) {
        console.error("Failed to handle job " + queued[0].id + ": " + scrub(e.message));
        try { const dir = jobDirectory(dataDir, queued[0].id); const report = await readReport(dataDir, queued[0].id);
          await atomicWrite(path.join(dir, "report.json"), { ...report, state: "failed", finishedAt: new Date().toISOString(), summary: "Worker rejected job" }); }
        catch { /* cannot persist report */ }
      }
    } else await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorker().catch(e => { console.error("Fatal worker error", e); process.exitCode = 1; });
}
