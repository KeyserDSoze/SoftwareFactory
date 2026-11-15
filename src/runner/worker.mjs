import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, jobDirectory, readReport, scrub, validateRequest } from "./common.mjs";
import { isInfrastructureFailure, planStep, planWebDependencies, runDockerStep } from "./docker.mjs";

/** Atomic exclusive job claim on the shared POSIX filesystem. Do not expire by age. */
async function isClaimed(dataDir, id) {
  try { await lstat(path.join(jobDirectory(dataDir, id), ".claim")); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
export async function executeJob(id, options = {}) {
  const dataDir = options.dataDir ?? process.env.RUNNER_DATA_DIR ?? "/data";
  const claim = path.join(jobDirectory(dataDir, id), ".claim");
  try { await mkdir(claim, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") return readReport(dataDir, id);
    throw error;
  }
  try { return await executeClaimedJob(id, options); }
  finally { await rm(claim, { recursive: true, force: true }); }
}

async function executeClaimedJob(id, {
  dataDir = process.env.RUNNER_DATA_DIR || "/data",
  workspaceRoot = process.env.RUNNER_HOST_WORK_DIR || "/srv/softwarefactory/workspaces",
  executeStep = runDockerStep,
  createStepPlan = planStep,
  createDependencyPlan = planWebDependencies,
  environment = process.env,
} = {}) {
  const dir = jobDirectory(dataDir, id);
  const reportFile = path.join(dir, "report.json");
  let report = await readReport(dataDir, id);
  if (report.state !== "queued") return report;
  const input = JSON.parse(await readFile(path.join(dir, "input.json"), "utf8"));
  const { request, digest } = validateRequest(input);
  if (digest !== report.digest) throw new Error("Input digest mismatch");
  const destination = path.resolve(workspaceRoot, id);
  if (!path.isAbsolute(workspaceRoot) || destination === path.resolve(workspaceRoot))
    throw new Error("Invalid worker workspace root");
  report = { ...report, state: "running", startedAt: new Date().toISOString(), summary: "Worker started", preparation: null };
  await atomicWrite(reportFile, report);
  try {
    await mkdir(destination, { mode: 0o700, recursive: true });
    for (const [name, content] of Object.entries(request.files)) {
      const target = path.resolve(destination, name);
      if (!target.startsWith(destination + path.sep)) throw new Error("Unsafe file target");
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600, flag: "wx" });
    }
    let prepared = false, blocked = "";
    for (const step of request.steps) {
      const plan = createStepPlan(step, request.files, destination, environment);
      if (plan.skip) {
        report.results.push({ step, state: "skipped", reason: plan.skip });
      } else if (step === "web-build" || step === "web-test" || step === "playwright") {
        if (!prepared) {
          prepared = true;
          const setupPlan = createDependencyPlan(request.files, destination, environment);
          const setupResult = setupPlan.skip
            ? { step: "npm-prepare", state: "skipped", reason: setupPlan.skip }
            : await executeStep(setupPlan, id, "npm-prepare");
          report.preparation = setupResult;
          await atomicWrite(reportFile, report);
          if (setupResult.state !== "passed") {
            blocked = "Node dependency setup failed (not a code test). " +
              (setupResult.reason || setupResult.stderr || "Inspect runner configuration").slice(0, 450);
          }
        }
        if (blocked) report.results.push({ step, state: "skipped", reason: blocked });
        else {
          const result = await executeStep(plan, id, step);
          report.results.push(isInfrastructureFailure(result) ?
            { ...result, state: "skipped", reason: "Runner infrastructure failure; no code test was verified" } : result);
        }
      } else {
        const result = await executeStep(plan, id, step);
        report.results.push(isInfrastructureFailure(result) ?
          { ...result, state: "skipped", reason: "Runner infrastructure failure; no code test was verified" } : result);
      }
      await atomicWrite(reportFile, report);
      if (report.results[report.results.length - 1].state === "failed") break;
    }
    const failed = report.results.some(r => r.state === "failed");
    const skipped = report.results.some(r => r.state === "skipped");
    report.state = failed ? "failed" : skipped ? "incomplete" : "passed";
    report.summary = failed ? "At least one executed code test failed" :
      skipped ? "Some checks were skipped due to missing tests or infrastructure setup; NOT a pass" :
        "All requested steps executed and passed";
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
  pollMs = 1500, stop = () => false, executeQueuedJob = executeJob,
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
        const claimed = await isClaimed(dataDir, id);
        if (!claimed && ["passed", "failed", "incomplete"].includes(report.state) &&
            Number.isFinite(Date.parse(report.finishedAt)) && Date.parse(report.finishedAt) < expireBefore) {
          await rm(jobDirectory(dataDir, id), { recursive: true, force: true });
          continue;
        }
        // Claimed queued jobs must not starve ready jobs.
        if (report.state === "queued" && !claimed) queued.push({ id, acceptedAt: report.acceptedAt });
        if (report.state === "running" && !claimed) {
          // Do not clobber a running job owned by another worker.
          await atomicWrite(path.join(jobDirectory(dataDir, id), "report.json"), {
            ...report, state: "failed", finishedAt: new Date().toISOString(),
            summary: "Worker interrupted without claim; inspect orphaned Docker containers",
          });
        }
      } catch { /* malformed entry not executable */ }
    }
    queued.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    if (queued.length) {
      try { await executeQueuedJob(queued[0].id, { dataDir, workspaceRoot }); }
      catch(e) {
        console.error("Failed to handle job " + queued[0].id + ": " + scrub(e.message));
        try {
          const dir = jobDirectory(dataDir, queued[0].id);
          const report = await readReport(dataDir, queued[0].id);
          await atomicWrite(path.join(dir, "report.json"), {
            ...report, state: "failed", finishedAt: new Date().toISOString(), summary: "Worker rejected job",
          });
        } catch { /* cannot persist report */ }
      }
    } else await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorker().catch(e => { console.error("Fatal worker error", e); process.exitCode = 1; });
}
