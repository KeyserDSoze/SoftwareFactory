import { describe, expect, it } from "vitest";
import { createProject } from "./defaults";
import {
  developmentOf, replacePendingWithRepair, setPending, validateProposal, workspaceFiles,
  approvePending, saveReview,
} from "./development";

const path = "src/backend/domain/Invoice.cs";
function response(code: string, otherPath = path) {
  return JSON.stringify({
    summary: "Repair invoice domain", files: [{ path: otherPath, reason: "Correct compiler error", content: code }],
    tests: ["dotnet build"], assumptions: [],
  });
}
function fixture() {
  const project = createProject();
  project.config.name = "Repair Factory";
  const original = validateProposal(response("namespace RepairFactory; public record Invoice(Guid Id);"), project, "Implement invoice");
  const staged = setPending(project, original);
  return { staged, original };
}
describe("bounded AI-assisted repair", () => {
  it("replaces only the original pending paths and invalidates previous review and job bindings", () => {
    const { staged, original } = fixture();
    const reviewed = saveReview(staged, original.id, {
      verdict: "pass", report: "Static review only", completedAt: "2026-11-14",
    });
    reviewed.development!.lastRunnerEvidence = {
      id: "01234567-89ab-4def-a234-0123456789ab", digest: "a".repeat(64),
      endpoint: "https://runner.example.test", label: "job", steps: ["dotnet-build"],
      submittedAt: "2026-11-14", proposalId: original.id, revision: 0,
    };
    reviewed.development!.lastRunnerJobId = reviewed.development!.lastRunnerEvidence.id;
    const repaired = replacePendingWithRepair(reviewed, original.id,
      response("namespace RepairFactory; public record Invoice(Guid Id, string Name);"));
    const pending = developmentOf(repaired).pending!;
    expect(pending.repairCount).toBe(1);
    expect(pending.previousProposalId).toBe(original.id);
    expect(pending.id).not.toBe(original.id);
    expect(pending.review).toBeUndefined();
    expect(repaired.development?.lastRunnerEvidence).toBeUndefined();
    expect(repaired.development?.lastRunnerJobId).toBeUndefined();
    expect(workspaceFiles(repaired)[path]).toBeUndefined(); // still pending, not applied
    expect(() => approvePending(repaired)).toThrow(/review avversaria/i);
  });
  it("prevents scope creep, no-op repairs and attempts on a replaced pending proposal", () => {
    const { staged, original } = fixture();
    expect(() => replacePendingWithRepair(staged, original.id,
      response("namespace RepairFactory; public record Invoice(Guid Id);", "src/backend/domain/NewFile.cs"))).toThrow(/stessi file/);
    expect(() => replacePendingWithRepair(staged, original.id,
      response(original.edits[0].content))).toThrow(/non ha modificato/);
    expect(() => replacePendingWithRepair(staged, "another", response("different"))).toThrow(/cambiata/);
  });
  it("limits repairs to two attempts, requiring explicit new tests each time", () => {
    const { staged, original } = fixture();
    const first = replacePendingWithRepair(staged, original.id,
      response("namespace RepairFactory; public record Invoice(Guid Id, string Name);"));
    const second = replacePendingWithRepair(first, first.development!.pending!.id,
      response("namespace RepairFactory; public record Invoice(Guid Id, string Name, int Amount);"));
    expect(second.development?.pending?.repairCount).toBe(2);
    expect(() => replacePendingWithRepair(second, second.development!.pending!.id,
      response("namespace RepairFactory; public record Invoice(Guid Id, string Name, int Amount, bool Good);"))).toThrow(/Massimo due/);
  });
});
