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


describe("human-selected set bound to AI PM proposed DAG (#106)", () => {
  it("can use a valid parallel build proposal with deterministic roles and fan-in", async () => {
    const { validatePmTestProposal } = await import("../domain/pm-test-plan");
    const project=createProject();
    project.config.description="An example web API with tests";
    const chosen=["dotnet-build","dotnet-test","web-build","web-test","playwright"] as const;
    const approved=validatePmTestProposal({
      summary:"Build and test backend/frontend independently, then smoke",
      tasks:[
        {id:"web-build",dependsOn:[],reason:"Compile the web source"},
        {id:"dotnet-build",dependsOn:[],reason:"Compile the backend source"},
        {id:"web-test",dependsOn:["web-build"],reason:"Run the frontend unit tests"},
        {id:"dotnet-test",dependsOn:["dotnet-build"],reason:"Run the backend unit tests"},
        {id:"playwright",dependsOn:["web-test","dotnet-test"],reason:"End-to-end only after upstream verification"},
      ],
    },chosen);
    const custom=planRunnerBatch(project,[...chosen],approved);
    expect(custom.tasks.map(t=>t.id)).toEqual([
      "web-build","dotnet-build","web-test","dotnet-test","playwright",
    ]);
    expect(custom.tasks.map(t=>t.role)).toEqual([
      "devops_engineer","devops_engineer","tester","tester","tester",
    ]);
    expect(custom.tasks[4].dependsOn).toEqual(["web-test","dotnet-test"]);
    const manual=planRunnerBatch(project,[...chosen]);
    const a=await runnerBatchSignature("https://runner.example.com",project,custom);
    const b=await runnerBatchSignature("https://runner.example.com",project,manual);
    expect(a).not.toEqual(b);
    expect(custom.tasks.every(t=>t.request.steps.length===1 && t.request.steps[0]===t.id)).toBe(true);
  });
  it("rejects a stale proposal if the operator changes the selection or a patch becomes pending", async () => {
    const { validatePmTestProposal } = await import("../domain/pm-test-plan");
    const project=createProject();
    project.config.description="An example of a backend";
    const approved=validatePmTestProposal({
      summary:"Build before running backend tests",
      tasks:[
        {id:"dotnet-build",dependsOn:[],reason:"Compile the backend source"},
        {id:"dotnet-test",dependsOn:["dotnet-build"],reason:"Run the backend test suite"},
      ],
    },["dotnet-build","dotnet-test"]);
    expect(()=>planRunnerBatch(project,["dotnet-build","web-test"],approved)).toThrow();
    project.development={revision:0,overrides:{},originals:{},history:[],
      pending:{id:"waiting-review"} as never};
    expect(()=>planRunnerBatch(project,["dotnet-build","dotnet-test"],approved)).toThrow();
  });
});
