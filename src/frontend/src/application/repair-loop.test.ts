import { describe, expect, it } from "vitest";
import { createProject } from "../domain/defaults";
import { developmentOf, replacePendingWithRepair, saveReview, setPending,
  validateProposal, type RunnerJobEvidence } from "../domain/development";
import { planRepairRetest, verifyRepairRetestReceipt } from "./repair-loop";
import type { RunnerStep } from "../infrastructure/runner";

const dotnet = "src/backend/domain/Invoice.cs";
const web = "src/frontend/web/src/RepairCard.tsx";
const e2e = "src/frontend/web/e2e/repair.spec.ts";
const id1 = "00000000-0000-4000-a000-000000000024";
const id2 = "00000000-0000-4000-a000-000000000025";
const digest = "b".repeat(64);
function response(paths: string[], iteration: number) {
  return JSON.stringify({
    summary: "Repair attempt " + iteration,
    files: paths.map(path => ({ path, reason: "Resolve compilation failure",
      content: path.endsWith(".cs")
        ? "namespace RepairStudio; public record Invoice(int Value" + iteration + ");"
        : "export const repaired = " + iteration + ";",
    })),
    tests: [], assumptions: [],
  });
}
function setup(paths: string[], failedSteps: RunnerStep[], attempt = 1) {
  const project = createProject();
  project.config.name = "Repair Studio";
  project.config.description = "Retest supervision";
  const first = validateProposal(response(paths, 0), project, "Implement repair studio");
  let current = setPending(project, first);
  const failedEvidence: RunnerJobEvidence = {
    id: id1, digest, endpoint: "https://runner.example.test",
    label: "Repair Studio · proposal", steps: [...failedSteps],
    proposalId: first.id, revision: developmentOf(current).revision,
    submittedAt: "2026-11-15T20:00:00Z",
  };
  current.development!.lastRunnerEvidence = failedEvidence;
  current.development!.lastRunnerJobId = failedEvidence.id;
  current = replacePendingWithRepair(current, first.id, response(paths, 1), failedEvidence);
  let patch = current.development!.pending!;
  current = saveReview(current, patch.id, {
    verdict: "pass", report: "New independent review", completedAt: "2026-11-15T20:00:01Z",
  });
  if (attempt === 2) {
    patch = current.development!.pending!;
    current.development!.lastRunnerEvidence = {
      ...failedEvidence, id: id2, digest: "c".repeat(64), proposalId: patch.id,
      steps: ["web-test"],
    };
    current = replacePendingWithRepair(current, patch.id, response(paths, 2),
      current.development!.lastRunnerEvidence);
    current = saveReview(current, current.development!.pending!.id, {
      verdict: "pass", report: "Reviewed attempt 2", completedAt: "2026-11-15T20:00:02Z",
    });
  }
  return { current, failedEvidence };
}

describe("supervised repair/retest policy", () => {
  it("enforces all original tests plus mandatory builds despite unchecked UI selection", () => {
    const { current } = setup([dotnet, web, e2e], ["dotnet-test"]);
    const plan = planRepairRetest(current);
    expect(plan.attempt).toBe(1);
    expect(plan.failedJobId).toBe(id1);
    expect(plan.steps).toEqual(["dotnet-build", "dotnet-test", "web-build", "playwright"]);
    expect(plan.requiredBuilds).toEqual(["dotnet-build", "web-build", "playwright"]);
    expect(planRepairRetest(current, ["web-test"]).steps)
      .toEqual(["dotnet-build", "dotnet-test", "web-build", "web-test", "playwright"]);
    expect(plan.proposalId).toBe(current.development!.pending!.id);
    expect(plan.label).toContain("repair 1");
    expect(current.development?.lastRunnerEvidence).toBeUndefined();
  });
  it("preserves failure provenance through two attempts and stops the third", () => {
    const { current } = setup([web], ["web-build"], 2);
    const pending = current.development!.pending!;
    expect(pending.repairCount).toBe(2);
    expect(pending.repairTrail).toHaveLength(2);
    expect(pending.repairTrail![0]).toEqual({
      attempt: 1, failedJobId: id1, failedDigest: digest, steps: ["web-build"],
    });
    expect(pending.repairTrail![1]).toEqual({
      attempt: 2, failedJobId: id2, failedDigest: "c".repeat(64), steps: ["web-test"],
    });
    const plan = planRepairRetest(current);
    expect(plan.failedJobId).toBe(id2);
    expect(plan.steps).toEqual(["web-build", "web-test"]);
    expect(() => replacePendingWithRepair(current, pending.id, response([web], 3)))
      .toThrow(/Massimo due/);
  });
  it("refuses unreviewed, blocked, stale or unverifiable provenance", () => {
    const { current } = setup([dotnet], ["dotnet-test"]);
    const patch = current.development!.pending!;
    const withoutReview = { ...current, development: {
      ...current.development!, pending: { ...patch, review: undefined },
    } };
    expect(() => planRepairRetest(withoutReview)).toThrow(/review/);
    const blocked = { ...current, development: {
      ...current.development!, pending: { ...patch, review: {
        verdict: "changes_required" as const, report: "Compiler error",
        completedAt: "2026-11-15",
      } },
    } };
    expect(() => planRepairRetest(blocked)).toThrow(/review/);
    const outdated = { ...current, development: { ...current.development!, revision: 1 } };
    expect(() => planRepairRetest(outdated)).toThrow(/review/);
    const missing = { ...current, development: { ...current.development!,
      pending: { ...patch, repairTrail: [] },
    } };
    expect(() => planRepairRetest(missing)).toThrow(/Provenienza/);
    const malicious = { ...current, development: { ...current.development!,
      pending: { ...patch, repairTrail: [{ attempt: 1, failedJobId: "bad",
        failedDigest: digest, steps: ["unknown" as RunnerStep] }] },
    } };
    expect(() => planRepairRetest(malicious)).toThrow(/Provenienza/);
    expect(() => planRepairRetest(current, ["malicious-step" as RunnerStep]))
      .toThrow(/non autorizzato/);
  });
  it("refuses a changed failure binding and does not record unverifiable repair", () => {
    const project = createProject();
    project.config.name = "Binding test";
    project.config.description = "Verify that a changed runner report binding cannot trigger repair";
    const p = validateProposal(response([dotnet], 0), project, "Implement binding");
    const staged = setPending(project, p);
    const evidence: RunnerJobEvidence = {
      id: id1, digest, endpoint: "https://runner.example.test", label: "binding",
      steps: ["dotnet-build"], proposalId: p.id, revision: 0, submittedAt: "2026-11-15",
    };
    staged.development!.lastRunnerEvidence = evidence;
    expect(() => replacePendingWithRepair(staged, p.id, response([dotnet], 1),
      { ...evidence, id: id2 })).toThrow(/non più associate/);
    expect(staged.development!.pending?.repairCount).toBeUndefined();
    expect(staged.development!.lastRunnerEvidence?.id).toBe(id1);
  });
  it("accepts only a queued UUID-v4 receipt with the exact submitted SHA-256", () => {
    const valid = { id: id1, digest, state: "queued" as const };
    expect(() => verifyRepairRetestReceipt(valid, digest)).not.toThrow();
    expect(() => verifyRepairRetestReceipt({ ...valid, digest: "c".repeat(64) }, digest))
      .toThrow(/Ricevuta/);
    expect(() => verifyRepairRetestReceipt({ ...valid, state: "passed" as "queued" }, digest))
      .toThrow(/Ricevuta/);
    expect(() => verifyRepairRetestReceipt({ ...valid, id: "bad" }, digest))
      .toThrow(/Ricevuta/);
    expect(() => verifyRepairRetestReceipt(valid, "not-a-digest")).toThrow(/Ricevuta/);
  });
});
