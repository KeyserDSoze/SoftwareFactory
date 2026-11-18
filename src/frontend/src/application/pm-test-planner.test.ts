import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject, DEFAULT_SETTINGS } from "../domain/defaults";
import { proposePmTestPlan } from "./pm-test-planner";

const response = JSON.stringify({summary:"Build, then run backend tests",
  tasks:[
    {id:"dotnet-build",dependsOn:[],reason:"Compile and validate the backend"},
    {id:"dotnet-test",dependsOn:["dotnet-build"],reason:"Test the backend after its build"},
  ]});
describe("role-routed PM model planning (#106)",()=>{
  beforeEach(()=>vi.stubGlobal("sessionStorage", {getItem:()=>null}));
  afterEach(()=>vi.unstubAllGlobals());
  it("routes role model and thinking, without sending source snapshots or runner credentials",async()=>{
    const settings=structuredClone(DEFAULT_SETTINGS);
    settings.profiles[0].model="fallback";
    settings.agentRoutes={project_manager:{modelId:"pm-model",thinking:"high"}};
    const project=createProject();
    project.config.description="An example ledger app";
    const spy=vi.fn(async (_url:string,_options:RequestInit)=>({ok:true,json:async()=>({
      choices:[{message:{content:response}}],
    })}));
    vi.stubGlobal("fetch",spy);
    const plan=await proposePmTestPlan(project,settings,["dotnet-build","dotnet-test"]);
    expect(plan.tasks.map(x=>x.id)).toEqual(["dotnet-build","dotnet-test"]);
    expect(spy).toHaveBeenCalledTimes(1);
    const body=JSON.parse(String(spy.mock.calls[0][1].body));
    expect(body.model).toBe("pm-model");
    expect(body.reasoning_effort).toBe("high");
    expect(body.messages[0].content).toContain("Project Manager");
    expect(body.messages[1].content).toContain("selectedSteps");
    expect(body.messages[1].content).not.toContain("input.json");
    expect(body.messages[1].content).not.toContain("Authorization");
    expect(body.messages[1].content).not.toContain("src/backend/domain");
  });
  it("fails before contacting AI for a pending patch or invalid choice",async()=>{
    const spy=vi.fn();
    vi.stubGlobal("fetch",spy);
    const p=createProject();
    p.development={revision:0,overrides:{},originals:{},history:[],pending:{id:"pending"} as never};
    await expect(proposePmTestPlan(p,structuredClone(DEFAULT_SETTINGS),["dotnet-build","dotnet-test"])).rejects.toThrow();
    await expect(proposePmTestPlan(createProject(),structuredClone(DEFAULT_SETTINGS),["dotnet-build"])).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
  it("rejects AI inventing a pass status, without forwarding an executable plan",async()=>{
    const project=createProject(),settings=structuredClone(DEFAULT_SETTINGS);
    settings.profiles[0].model="test";
    vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,json:async()=>({
      choices:[{message:{content:JSON.stringify({...JSON.parse(response),passed:true})}}],
    })})));
    await expect(proposePmTestPlan(project,settings,["dotnet-build","dotnet-test"])).rejects.toThrow();
  });
});
