import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProject } from "../domain/defaults";
import type { FactoryProject } from "../domain/types";
import type { RunnerJobEvidence } from "../domain/development";
import {
  canonicalRunnerRequest, runnerRequestDigest, runnerSourceFiles,
  verifyCurrentRunnerReport, verifyRunnerResultShape, type RunnerReport, type RunnerStep,
} from "./runner";

const STEPS: RunnerStep[] = ["dotnet-build", "web-build"];
function fixture() {
  const project = createProject();
  project.config.name = "Evidence Studio";
  project.config.description = "Verify current generated files";
  const evidence: RunnerJobEvidence = {
    id: "01234567-89ab-4def-a234-0123456789ab", digest: "",
    label: "Evidence Studio · approved workspace", endpoint: "https://runner.example.test",
    steps: STEPS, proposalId: null, revision: 0, submittedAt: new Date().toISOString(),
  };
  return { project, evidence };
}
async function boundFixture() {
  const { project, evidence } = fixture();
  evidence.digest = await runnerRequestDigest(evidence.label, runnerSourceFiles(project, false), evidence.steps);
  return { project, evidence };
}
function completeReport(evidence: RunnerJobEvidence, state: RunnerReport["state"] = "passed"): RunnerReport {
  return {
    id: evidence.id, label: evidence.label, digest: evidence.digest,
    state, summary: "Runner outcome", acceptedAt: "2026-11-14T00:00:00Z",
    startedAt: "2026-11-14T00:00:00Z", finishedAt: "2026-11-14T00:01:00Z",
    steps: [...evidence.steps],
    results: evidence.steps.map(step => ({
      step, state: state === "failed" ? "failed" : "passed",
      exitCode: state === "failed" ? 1 : 0, timedOut: false, durationMs: 600,
    })),
  };
}
describe("canonical runner identity and gates", () => {
  it("matches the Node runner SHA-256 canonical payload exactly, independent of input order", async () => {
    const { project, evidence } = fixture();
    const files = runnerSourceFiles(project, false);
    const reordered = Object.fromEntries(Object.entries(files).reverse());
    const body = canonicalRunnerRequest(evidence.label, reordered, evidence.steps);
    const expected = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    expect(await runnerRequestDigest(evidence.label, files, evidence.steps)).toBe(expected);
    expect(await runnerRequestDigest(evidence.label, reordered, evidence.steps)).toBe(expected);
    expect(await runnerRequestDigest(evidence.label, files, ["dotnet-build"])).not.toBe(expected);
  });
  it("accepts only a complete passed report with all requested commands actually executed", async () => {
    const { project, evidence } = await boundFixture();
    const report = completeReport(evidence);
    expect((await verifyCurrentRunnerReport(project, evidence.endpoint, report, evidence)).kind).toBe("passed");
    report.results.pop();
    expect(verifyRunnerResultShape(report, evidence).kind).toBe("invalid");
    report.results = completeReport(evidence).results;
    report.results[1].exitCode = null;
    expect(verifyRunnerResultShape(report, evidence).kind).toBe("invalid");
    report.results[1].exitCode = 0;
    report.results[1].state = "skipped";
    expect(verifyRunnerResultShape(report, evidence).kind).toBe("invalid");
  });
  it("rejects mismatching job IDs, digests, labels, step lists and reports with extra commands", async () => {
    const { evidence } = await boundFixture();
    const good = completeReport(evidence);
    expect(verifyRunnerResultShape({ ...good, id: "different" }, evidence).kind).toBe("invalid");
    expect(verifyRunnerResultShape({ ...good, digest: "f".repeat(64) }, evidence).kind).toBe("invalid");
    expect(verifyRunnerResultShape({ ...good, label: "other" }, evidence).kind).toBe("invalid");
    expect(verifyRunnerResultShape({ ...good, steps: ["dotnet-build"] }, evidence).kind).toBe("invalid");
    expect(verifyRunnerResultShape({ ...good, results: [...good.results, good.results[0]] }, evidence).kind).toBe("invalid");
  });
  it("marks results as obsolete when the baseline, endpoint, revision or patch changes", async () => {
    const { project, evidence } = await boundFixture();
    const report = completeReport(evidence);
    expect((await verifyCurrentRunnerReport(project, "https://runner.other.test", report, evidence)).kind).toBe("stale");
    const changedConfig = { ...project, config: { ...project.config, name: "New Product" } };
    expect((await verifyCurrentRunnerReport(changedConfig, evidence.endpoint, report, evidence)).kind).toBe("stale");
    const changedRevision: FactoryProject = { ...project, development: {
      revision: 1, overrides: {}, originals: {}, history: [],
    } };
    expect((await verifyCurrentRunnerReport(changedRevision, evidence.endpoint, report, evidence)).kind).toBe("stale");
    const differentProposal: FactoryProject = { ...project, development: {
      revision: 0, overrides: {}, originals: {}, history: [],
      pending: { id: "new", request: "new", summary: "new", createdAt: "", revision: 0, edits: [], tests: [], assumptions: [] },
    } };
    expect((await verifyCurrentRunnerReport(differentProposal, evidence.endpoint, report, evidence)).kind).toBe("stale");
    expect((await verifyCurrentRunnerReport(project, evidence.endpoint, report, undefined)).kind).toBe("stale");
  });
  it("distinguishes real failures from incomplete infrastructure failures and skipped checks", async () => {
    const { evidence } = await boundFixture();
    expect(verifyRunnerResultShape(completeReport(evidence, "failed"), evidence).kind).toBe("failed");
    expect(verifyRunnerResultShape({ ...completeReport(evidence, "failed"), results: [] }, evidence).kind).toBe("incomplete");
    const report = completeReport(evidence, "incomplete");
    report.results[1] = { step: "web-build", state: "skipped", reason: "No node cache" };
    expect(verifyRunnerResultShape(report, evidence).kind).toBe("incomplete");
    expect(verifyRunnerResultShape({ ...report, state: "passed" }, evidence).kind).toBe("invalid");
  });
});
