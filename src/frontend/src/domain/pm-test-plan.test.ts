import { describe, it, expect } from "vitest";
import { validatePmTestProposal } from "./pm-test-plan";
const selected = ["dotnet-build","dotnet-test","web-build","web-test","playwright"] as const;
const p = {summary:"Run verified builds before smoke testing",
  tasks:[
    {id:"dotnet-build",dependsOn:[],reason:"Validate the backend source"},
    {id:"web-build",dependsOn:[],reason:"Validate the web source separately"},
    {id:"dotnet-test",dependsOn:["dotnet-build"],reason:"Run backend tests only after backend build"},
    {id:"web-test",dependsOn:["web-build"],reason:"Run browser unit tests after web build"},
    {id:"playwright",dependsOn:["dotnet-test","web-test"],reason:"Run full smoke tests after both pipelines"},
  ],
};
describe("AI project manager proposed DAG contract (#106)", () => {
  it("accepts human-selected tasks with parallel branches and transitive fan-in",()=>{
    expect(validatePmTestProposal(JSON.stringify(p),selected).tasks).toHaveLength(5);
    expect(validatePmTestProposal(p,selected).tasks[4].dependsOn).toEqual(["dotnet-test","web-test"]);
  });
  it("rejects omissions, role/command escalation, cycles, future links and fake successes",()=>{
    const changes=[
      {...p,tasks:p.tasks.slice(0,-1)},
      {...p,tasks:[...p.tasks.slice(0,-1),{...p.tasks[4],id:"shell"}]},
      {...p,tasks:[{...p.tasks[0],role:"admin"},...p.tasks.slice(1)]},
      {...p,tasks:[{...p.tasks[0],dependsOn:["dotnet-build"]},...p.tasks.slice(1)]},
      {...p,tasks:[...p.tasks.slice(0,-1),{...p.tasks[4],dependsOn:["dotnet-test"]}]},
      {...p,tasks:[...p.tasks.slice(0,-1),{...p.tasks[4],status:"passed"}]},
      {...p,tasks:[p.tasks[1],p.tasks[0],...p.tasks.slice(2)].map(t=>
        t.id==="web-test"? {...t,dependsOn:[]} : t)},
      {...p,summary:"Invalid"+String.fromCharCode(10)+"control character"},
    ];
    for(const v of changes)expect(()=>validatePmTestProposal(v,selected)).toThrow();
  });
  it("fails closed on unsafe JSON, duplicates, unknown steps or extra fields",()=>{
    expect(()=>validatePmTestProposal(String.fromCharCode(96).repeat(3)+"json",selected)).toThrow();
    expect(()=>validatePmTestProposal(JSON.stringify({...p,model:"remote"}),selected)).toThrow();
    expect(()=>validatePmTestProposal(JSON.stringify(p),["dotnet-build","dotnet-build"])).toThrow();
    expect(()=>validatePmTestProposal(JSON.stringify(p),["dotnet-build","dotnet-test"])).toThrow();
  });
});
