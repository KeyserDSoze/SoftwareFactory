import { describe, expect, it } from "vitest";
import { createProject } from "../domain/defaults";
import { planRunnerBatch, runnerBatchSignature } from "./runner-batch";

describe("approved workspace to runner DAG planning (#104)", () => {
  it("keeps the canonical test order, independent roles, and no pending patch", () => {
    const project=createProject();
    project.config.description = "A sample project with a verified backend and frontend";
    const plan=planRunnerBatch(project,["web-test","dotnet-build","dotnet-test"]);
    expect(plan.consent).toBe(true);
    expect(plan.enforced).toBe(true);
    expect(plan.tasks.map(x=>x.id)).toEqual(["dotnet-build","dotnet-test","web-test"]);
    expect(plan.tasks.map(x=>x.dependsOn)).toEqual([[],["dotnet-build"],["dotnet-test"]]);
    expect(plan.tasks.map(x=>x.role)).toEqual(["devops_engineer","tester","tester"]);
    for(const task of plan.tasks){
      expect(task.request.steps).toEqual([task.id]);
      expect(Object.keys(task.request.files).length).toBeGreaterThan(0);
      expect(Object.values(task.request.files).join("")).not.toContain("github_pat_");
    }
  });
  it("rejects a bypass of pending review and unsafe / duplicate step choices", () => {
    const project=createProject();
    expect(() => planRunnerBatch(project,["dotnet-build"])).toThrow();
    expect(() => planRunnerBatch(project,["dotnet-build","dotnet-build"])).toThrow();
    expect(() => planRunnerBatch(project,["dotnet-build","shell" as never])).toThrow();
    const withPending={...project,development:{
      revision:0,overrides:{},originals:{},history:[],
      pending:{id:"candidate"} as never,
    }};
    expect(() => planRunnerBatch(withPending,["dotnet-build","dotnet-test"])).toThrow();
  });
  it("hash signature binds endpoint/project/revision/test plan and source snapshot", async () => {
    const project=createProject();
    project.config.description = "A sample project with a verified backend and frontend";
    const plan=planRunnerBatch(project,["dotnet-build","dotnet-test"]);
    const a=await runnerBatchSignature("https://runner.example.com",project,plan);
    expect(a).toBe(await runnerBatchSignature("https://runner.example.com",project,plan));
    const changed=planRunnerBatch(project,["dotnet-build","web-test"]);
    expect(a).not.toBe(await runnerBatchSignature("https://runner.example.com",project,changed));
    const revision={...project,development:{revision:2,overrides:{},originals:{},history:[]}};
    expect(a).not.toBe(await runnerBatchSignature("https://runner.example.com",revision,plan));
  });
});
