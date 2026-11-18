import { describe, expect, it } from "vitest";
import { createProject, STAGES } from "./defaults";
import { projectHandoffBoard } from "./handoff";
import type { FactoryProject, StageId } from "./types";

function finished(project: FactoryProject, id: StageId): void {
  const stage = project.stages.find(s => s.id === id);
  if (!stage) throw new Error("Missing stage " + id);
  stage.status = "complete";
  stage.output = "Reviewed checkpoint for " + id;
}
function finishStages(project: FactoryProject): void {
  for (const stage of STAGES) finished(project, stage.id);
}
function pendingPatch(project: FactoryProject): void {
  project.development = {
    revision: 2, overrides: {}, originals: {}, history: [],
    pending: {
      id: "proposal-1", request: "Add item", summary: "Item feature",
      createdAt: "2026-11-18T08:00:00.000Z", revision: 2,
      edits: [{ path: "src/frontend/web/src/App.tsx", previous: null,
        content: "export const item = 1;", reason: "Feature" }],
      tests: ["web-test"], assumptions: [],
    },
  };
}
function at(project: FactoryProject, id: string) {
  const entry = projectHandoffBoard(project).tasks.find(task => task.id === id);
  if (!entry) throw new Error("Task missing " + id);
  return entry;
}

describe("read-only software house handoff DAG (#98)", () => {
  it("starts with only the first AI stage ready and explicit dependencies", () => {
    const project = createProject();
    const board = projectHandoffBoard(project);
    expect(board.tasks).toHaveLength(STAGES.length + 4);
    expect(board.completed).toBe(0);
    expect(board.nextTaskIds).toEqual(["features"]);
    expect(at(project, "features")).toMatchObject({ status: "ready", dependsOn: [], owner: "Analista funzionale" });
    expect(at(project, "implementation").status).toBe("blocked");
    expect(at(project, "human-approval").owner).toBe("Supervisore umano");
  });

  it("uses completed nonempty checkpoints, not bare flags or nonexistent task executions", () => {
    const project = createProject();
    finished(project, "features");
    expect(at(project, "competitors").status).toBe("ready");
    expect(at(project, "architecture").status).toBe("blocked");
    project.stages.find(s => s.id === "features")!.output = "";
    expect(at(project, "features").status).toBe("blocked");
    expect(at(project, "competitors").status).toBe("blocked");
    project.stages.find(s => s.id === "features")!.output = "ok";
    project.stages.find(s => s.id === "competitors")!.status = "running";
    expect(at(project, "competitors").status).toBe("running");
    project.stages.find(s => s.id === "competitors")!.status = "failed";
    expect(at(project, "competitors").status).toBe("failed");
  });

  it("never trusts a downstream complete stage if the predecessor is incomplete", () => {
    const project = createProject();
    finished(project, "architecture");
    finished(project, "adversarial");
    finished(project, "implementation");
    expect(at(project, "architecture").status).toBe("blocked");
    expect(at(project, "implementation").status).toBe("blocked");
    expect(at(project, "code-proposal").status).toBe("blocked");
  });

  it("shows an actual proposal and review handoff without claiming tests passed", () => {
    const project = createProject();
    finishStages(project);
    expect(at(project, "code-proposal").status).toBe("ready");
    pendingPatch(project);
    expect(at(project, "code-proposal").status).toBe("completed");
    expect(at(project, "code-review").status).toBe("ready");
    expect(at(project, "test-verification").status).toBe("blocked");
    expect(at(project, "human-approval").status).toBe("blocked");
    project.development!.pending!.review = {
      verdict: "changes_required", report: "Unsafe SQL", completedAt: new Date().toISOString(),
    };
    expect(at(project, "code-review").status).toBe("changes_required");
    expect(at(project, "human-approval").status).toBe("blocked");
    project.development!.pending!.review!.verdict = "pass";
    expect(at(project, "code-review").status).toBe("completed");
    expect(at(project, "test-verification").status).toBe("ready");
    expect(at(project, "human-approval").status).toBe("ready");
    expect(at(project, "human-approval").evidence).toMatch(/Code Agent/);
  });

  it("treats submission as unverified and a repaired patch as requiring new live evidence", () => {
    const project = createProject();
    finishStages(project);
    pendingPatch(project);
    project.development!.pending!.review = {
      verdict: "pass", report: "No blockers", completedAt: new Date().toISOString(),
    };
    project.development!.lastRunnerEvidence = {
      id: "job-1", digest: "digest-1", endpoint: "https://runner.example.com",
      label: "Build", steps: ["web-build"], submittedAt: new Date().toISOString(),
      proposalId: "proposal-1", revision: 2,
    };
    expect(at(project, "test-verification").status).toBe("verification_required");
    expect(at(project, "test-verification").evidence).toMatch(/non ne attesta/);
    expect(at(project, "human-approval").status).toBe("ready");
    project.development!.pending!.repairCount = 1;
    expect(at(project, "human-approval").status).toBe("verification_required");
    expect(at(project, "human-approval").dependsOn).toContain("test-verification");
    project.development!.lastRunnerEvidence.proposalId = "old";
    expect(at(project, "test-verification").status).toBe("ready");
    project.development!.pending!.revision = 1;
    expect(at(project, "code-proposal").status).toBe("blocked");
    expect(at(project, "code-review").status).toBe("blocked");
  });

  it("derives the same board after serialized restore without mutating the project", () => {
    const project = createProject();
    finishStages(project);
    pendingPatch(project);
    const before = JSON.stringify(project);
    const first = projectHandoffBoard(project);
    expect(projectHandoffBoard(JSON.parse(before) as FactoryProject)).toEqual(first);
    expect(JSON.stringify(project)).toBe(before);
    expect(first.tasks.every(task => task.status !== "failed")).toBe(true);
  });
});
