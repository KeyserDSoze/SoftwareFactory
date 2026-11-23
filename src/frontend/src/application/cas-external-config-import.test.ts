import {beforeEach,describe,expect,it,vi} from "vitest";
import {createProject,STAGES} from "../domain/defaults";
import {compareAndSwapCasProject,serializeCasProject}
  from "../infrastructure/project-cas";
import {
  prepareCasExternalConfigImport,confirmCasExternalConfigImport,
} from "./cas-external-config-import";

vi.mock("../infrastructure/project-cas",async importOriginal=>{
  const original=await importOriginal<typeof import(
    "../infrastructure/project-cas")>();
  return {...original,compareAndSwapCasProject:vi.fn()};
});
const native=vi.mocked(compareAndSwapCasProject);
function historical(){
  const p=createProject();
  p.config.name="Historic app";
  p.config.requirements="PostgreSQL and React";
  p.config.frontends=["react","android"];
  p.stages[0]={id:"features",label:STAGES[0].label,status:"complete",
    output:"UNVERIFIED_HISTORIC_LLM_OUTPUT",sources:[],completionOrigin:"ai"};
  p.githubDestination={owner:"old",repo:"old",branch:"main",authMode:"pat",
    appGateway:"",privateRepo:false};
  p.githubSync={owner:"old",repo:"old",branch:"main",lastCommit:"OLD_SHA",
    syncedLocalUpdatedAt:p.updatedAt,syncedAt:p.updatedAt,publicConsent:true};
  p.githubTestReceipt={requestId:"old",repository:"old/old",branch:"main",
    commitSha:"OLD_SHA",createdAt:p.updatedAt,selected:["web-build"]};
  p.development={revision:2,overrides:{},originals:{},history:[],
    lastRunnerJobId:"OLD_RUNNER_EVIDENCE"};
  return p;
}
const raw=()=>serializeCasProject(historical());

describe("CAS manual JSON configuration-only import (#178)",()=>{
  beforeEach(()=>native.mockReset());
  it("creates fresh identity with only safe stack, empty stages and zero evidence",()=>{
    const previous=historical();
    const ticket=prepareCasExternalConfigImport(serializeCasProject(previous));
    const target=JSON.parse(ticket.raw);
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(ticket.id).not.toBe(previous.id);
    expect(ticket.name).toBe("Historic app (import)");
    expect(target.config).toEqual({...previous.config,name:ticket.name});
    expect(target.stages).toEqual(STAGES.map(({id,label})=>({
      id,label,status:"pending",output:"",sources:[],
    })));
    expect(Object.keys(target).sort()).toEqual([
      "config","createdAt","id","stages","updatedAt",
    ]);
    expect(ticket.raw).not.toContain("UNVERIFIED_HISTORIC_LLM_OUTPUT");
    expect(ticket.raw).not.toContain("OLD_RUNNER_EVIDENCE");
    expect(ticket.raw).not.toContain("OLD_SHA");
    expect(ticket.raw).not.toContain("publicConsent");
  });
  it("rejects malformed, noncanonical, unknown schema and oversized JSON before native I/O",()=>{
    for(const value of [
      "", "{}", "null", " ".repeat(1_000_001),
      raw()+"\n", JSON.stringify({...historical(),unexpectedField:true}),
      JSON.stringify({...historical(),createdAt:"invalid"}),
      JSON.stringify({...historical(),id:"not-a-uuid"}),
    ])expect(()=>prepareCasExternalConfigImport(value)).toThrow();
    expect(native).not.toHaveBeenCalled();
  });
  it("fails closed for unsafe stack, credentials and inconsistent AI stages",()=>{
    const p=historical();
    p.config.requirements="github_pat_"+"X".repeat(25);
    expect(()=>prepareCasExternalConfigImport(serializeCasProject(p))).toThrow();
    p.config.requirements="Safe";
    p.config.frontends=["react","react"];
    expect(()=>prepareCasExternalConfigImport(serializeCasProject(p))).toThrow();
    p.config.frontends=["react"];
    p.stages[0].status="running";
    expect(()=>prepareCasExternalConfigImport(serializeCasProject(p))).toThrow();
    expect(native).not.toHaveBeenCalled();
  });
  it("requires explicit consent and rejects tampered tickets or inherited proofs",async()=>{
    const ticket=prepareCasExternalConfigImport(raw());
    await expect(confirmCasExternalConfigImport(ticket,false))
      .rejects.toThrow(/Consenso/);
    const bad=[
      {...ticket,id:"other"},
      {...ticket,name:"different"},
      {...ticket,raw:ticket.raw+" "},
      {...ticket,source:{...ticket.source,revision:2}},
      {...ticket,source:{...ticket.source,id:"different"}},
      {...ticket,raw:JSON.stringify({
        ...JSON.parse(ticket.raw),githubSync:{publicConsent:true},
      })},
    ];
    for(const value of bad)
      await expect(confirmCasExternalConfigImport(value,true)).rejects.toThrow();
    expect(native).not.toHaveBeenCalled();
  });
  it("one insert-only CAS, exact ACK, no overwrite or optimistic success",async()=>{
    const ticket=prepareCasExternalConfigImport(raw());
    native.mockResolvedValueOnce({id:ticket.id,revision:1,raw:ticket.raw});
    await expect(confirmCasExternalConfigImport(ticket,true)).resolves.toEqual({
      id:ticket.id,revision:1,raw:ticket.raw,
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith(JSON.parse(ticket.raw),null);
    native.mockResolvedValueOnce({id:ticket.id,revision:2,raw:ticket.raw});
    await expect(confirmCasExternalConfigImport(ticket,true)).rejects
      .toThrow(/ambiguo/);
  });
  it("propagates native collision/quota/unknown ACK without reading legacy or cloud",async()=>{
    const forbidden=vi.fn(()=>{throw Error("FORBIDDEN_LEGACY_OR_NETWORK");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("fetch",forbidden);
    try{
      const ticket=prepareCasExternalConfigImport(raw());
      native.mockRejectedValueOnce(Error("collision or tombstone"));
      await expect(confirmCasExternalConfigImport(ticket,true))
        .rejects.toThrow(/collision/);
      expect(native).toHaveBeenCalledTimes(1);
      expect(forbidden).not.toHaveBeenCalled();
    }finally{vi.unstubAllGlobals();}
  });
});
