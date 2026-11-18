/** Read-only PM view for one persisted runner job (#99).
 * Every positive test state comes from an independently verified journal step,
 * not from HTTP admission, a submitted receipt, or an unverified summary flag.
 * The local SHA-chain is not a remote signature or a Docker isolation proof.
 */
import { isDeepStrictEqual } from "node:util";
import { ALLOWED_STEPS } from "./common.mjs";

const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TERMINAL = ["passed", "failed", "incomplete"];
const invalid = () => Object.assign(new Error("Invalid PM execution evidence"), { code: "PM_PLAN_INTEGRITY" });
const WEB = new Set(["web-build", "web-test", "playwright"]);
function assertion(ok) { if (!ok) throw invalid(); }
function validResult(result, step) {
  assertion(result && typeof result === "object" && !Array.isArray(result) &&
    result.step === step && ["passed","failed","skipped"].includes(result.state));
  if (result.state === "passed")
    assertion(result.exitCode === 0 && result.timedOut !== true &&
      Number.isFinite(result.durationMs) && result.durationMs >= 0);
  if (result.state === "failed")
    assertion(Number.isInteger(result.exitCode) && result.exitCode !== 0 &&
      result.timedOut !== true);
}
export function projectVerifiedJobPlan(verified) {
  const { report, entries, head } = verified || {};
  assertion(report && typeof report === "object" && !Array.isArray(report) &&
    UUID.test(report.id) && HEX.test(report.digest) &&
    ["queued","running",...TERMINAL].includes(report.state) &&
    Array.isArray(report.steps) && report.steps.length >= 1 &&
    report.steps.length <= ALLOWED_STEPS.length &&
    report.steps.every(s => ALLOWED_STEPS.includes(s)) &&
    new Set(report.steps).size === report.steps.length &&
    Array.isArray(report.results) && report.results.length <= report.steps.length &&
    Array.isArray(entries) && entries.length >= 1 && entries.length <= 48 &&
    HEX.test(head) && report.evidence?.head === head &&
    report.evidence?.count === entries.length && report.evidence?.version === 1);
  const results = report.results;
  const stepEvents = entries.filter(e => e.kind === "step");
  assertion(stepEvents.length === results.length &&
    stepEvents.every((event, i) => Array.isArray(event.report?.results) &&
      event.report.results.length === i + 1 &&
      isDeepStrictEqual(event.report.results[i], results[i]) &&
      event.report.digest === report.digest));
  results.forEach((result, i) => validResult(result, report.steps[i]));
  const failed = results.some(r => r.state === "failed");
  const skipped = results.some(r => r.state === "skipped");
  if (report.state === "queued") assertion(results.length === 0 &&
    !entries.some(e => e.kind === "started"));
  if (report.state === "running") assertion(entries.some(e => e.kind === "started"));
  if (report.state === "passed") assertion(results.length === report.steps.length &&
    !failed && !skipped);
  if (report.state === "failed") assertion(failed);
  if (report.state === "incomplete") assertion(!failed);
  if (results.length < report.steps.length)
    assertion(report.state !== "passed");
  const prepEvents = entries.filter(e => e.kind === "preparation");
  assertion(prepEvents.length <= 1 && (
    report.preparation == null ? prepEvents.length === 0 :
      prepEvents.length === 1 && isDeepStrictEqual(prepEvents[0].report?.preparation, report.preparation)));
  if (report.preparation != null) {
    validResult(report.preparation, "npm-prepare");
    assertion(report.steps.some(s => WEB.has(s)));
    if (report.preparation.state !== "passed")
      assertion(!results.some(r => WEB.has(r.step) && r.state === "passed"));
  }

  const statusFor = r => r.state === "passed" ? "passed" :
    r.state === "failed" ? "failed" : "incomplete";
  const tasks = [];
  let previous = null, firstWeb = true;
  for (let i = 0; i < report.steps.length; i++) {
    const step = report.steps[i];
    if (WEB.has(step) && firstWeb) {
      firstWeb = false;
      if (report.preparation != null) {
        tasks.push({ id: "npm-prepare", owner: "Runner dependency preparation",
          dependsOn: previous ? [previous] : [],
          status: statusFor(report.preparation), exitCode: report.preparation.exitCode ?? null });
        previous = "npm-prepare";
      }
    }
    const result = results[i];
    tasks.push({ id: step, owner: "Runner test worker",
      dependsOn: previous ? [previous] : [],
      status: result ? statusFor(result) :
        TERMINAL.includes(report.state) ? "not_executed" : "waiting",
      exitCode: result?.exitCode ?? null });
    previous = step;
  }
  return {
    version: 1, jobId: report.id, digest: report.digest,
    evidence: { count: entries.length, head },
    state: report.state,
    tasks,
  };
}
