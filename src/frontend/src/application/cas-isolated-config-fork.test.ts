import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createProject,STAGES} from "../domain/defaults";
import {serializeCasProject,forkCasProjectConfiguration}
  from "../infrastructure/project-cas";
import {
  prepareCasIsolatedConfigFork,confirmCasIsolatedConfigFork,
} from "./cas-isolated-config-fork";

vi.mock("../infrastructure/project-cas",async importOriginal=>{
  const original=await importOriginal<typeof import(
    "../infrastructure/project-cas")>();
  return {...original,forkCasProjectConfiguration:vi.fn()};
});
const native=vi.mocked(forkCasProjectConfiguration);
const source=()=>{
  const p=createProject();
  p.config.name="Local configuration to branch";
  p.config.description="New software requirement";
  p.config.requirements="Strict security review";
  p.config.frontends=["react","android"];
  p.config.services.cache.production="redis";
  p.stages[0]={id:"features",label:STAGES[0].label,
    status:"complete",output:"Historic unverified LLM output",sources:[],
    completionOrigin:"ai"};
  p.githubDestination={
    owner:"example",repo:"legacy",branch:"main",authMode:"pat",
    appGateway:"",privateRepo:false,
  };
  p.githubSync={owner:"example",repo:"legacy",branch:"main",
    lastCommit:"old",syncedLocalUpdatedAt:p.updatedAt,
    syncedAt:p.updatedAt,publicConsent:true};
  p.githubTestReceipt={requestId:"old",repository:"example/legacy",
    branch:"main",commitSha:"old",createdAt:p.updatedAt,
    selected:["web-build"],runId:1234};
  p.development={revision:3,overrides:{
    "src/frontend/web/src/LegacyFeature.tsx":"export const Historic=1;",
  },originals:{
    "src/frontend/web/src/LegacyFeature.tsx":null,
  },history:[],lastRunnerJobId:"historic-id",
    lastRunnerEvidence:{id:"old",digest:"old",endpoint:"https://runner.example",
      label:"Historic job",steps:["web-build"],submittedAt:p.updatedAt,
      proposalId:null,revision:3},
    pending:{id:"human",request:"Not executed",summary:"Pending",
      createdAt:p.updatedAt,revision:3,edits:[],tests:[],assumptions:[]}};
  return p;
};
const snap=(p:ReturnType<typeof source>,revision=5)=>({
  id:p.id,revision,raw:serializeCasProject(p),
});

describe("isolated native IndexedDB config-only fork #166",()=>{
  beforeEach(()=>native.mockReset());
  afterEach(()=>vi.unstubAllGlobals());

  it("preserves full stack settings but never copies stages, code or external evidence",()=>{
    const p=source(),ticket=prepareCasIsolatedConfigFork(snap(p));
    const fork=JSON.parse(ticket.raw);
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(Object.isFrozen(ticket.source)).toBe(true);
    expect(fork.id).toBe(ticket.id);
    expect(fork.id).not.toBe(p.id);
    expect(fork.config).toEqual({
      ...p.config,name:p.config.name+" (copy)",
    });
    expect(fork.createdAt).toBe(fork.updatedAt);
    expect(fork.stages).toEqual(STAGES.map(({id,label})=>({
      id,label,status:"pending",output:"",sources:[],
    })));
    expect(fork.development).toBeUndefined();
    expect(fork.githubDestination).toBeUndefined();
    expect(fork.githubSync).toBeUndefined();
    expect(fork.githubTestReceipt).toBeUndefined();
    expect(ticket.source.raw).toContain("Historic unverified");
    expect(ticket.raw).not.toContain("Historic unverified");
    expect(ticket.raw).not.toContain("historic-id");
  });

  it("rejects altered ticket, wrong source, noncanon state and credentials before I/O",async()=>{
    const p=source(),expected=snap(p),ticket=prepareCasIsolatedConfigFork(expected);
    for(const changed of [
      {...ticket,id:"wrong"},
      {...ticket,name:"other"},
      {...ticket,raw:ticket.raw+" "},
      {...ticket,source:{...ticket.source,revision:0}},
      {...ticket,source:{...ticket.source,id:"wrong"}},
      {...ticket,source:{...ticket.source,raw:ticket.source.raw+" "}},
    ])await expect(confirmCasIsolatedConfigFork(changed,true)).rejects.toThrow();
    expect(()=>prepareCasIsolatedConfigFork({...expected,raw:"{}"})).toThrow();
    p.config.requirements="github_pat_"+"a".repeat(25);
    expect(()=>prepareCasIsolatedConfigFork(snap(p))).toThrow();
    p.config.requirements="Safe";
    p.stages[0].status="pending";
    expect(()=>prepareCasIsolatedConfigFork(snap(p))).toThrow();
    expect(native).not.toHaveBeenCalled();
  });

  it("rejects non-schema config and checks 120-char target names",()=>{
    const p=source();
    p.config.name="n".repeat(120);
    const ticket=prepareCasIsolatedConfigFork(snap(p));
    expect(ticket.name.length).toBeLessThanOrEqual(120);
    p.config.services.cache.production="illegal";
    expect(()=>prepareCasIsolatedConfigFork(snap(p))).toThrow();
    p.config.services.cache.production="redis";
    p.config.frontends=["react","react"];
    expect(()=>prepareCasIsolatedConfigFork(snap(p))).toThrow();
  });

  it("calls the native atomic source read + target insert once after consent",async()=>{
    const p=source(),ticket=prepareCasIsolatedConfigFork(snap(p));
    await expect(confirmCasIsolatedConfigFork(ticket,false)).rejects
      .toThrow(/Consenso/);
    expect(native).not.toHaveBeenCalled();
    native.mockResolvedValueOnce({id:ticket.id,revision:1,raw:ticket.raw});
    await expect(confirmCasIsolatedConfigFork(ticket,true))
      .resolves.toEqual({id:ticket.id,revision:1,raw:ticket.raw});
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith(ticket.source,
      JSON.parse(ticket.raw),true);
    native.mockResolvedValueOnce({id:ticket.id,revision:2,raw:ticket.raw});
    await expect(confirmCasIsolatedConfigFork(ticket,true)).rejects
      .toThrow(/incoerente/);
  });

  it("does not fall back to other stores/remote on native conflict/quota",async()=>{
    const forbidden=vi.fn(()=>{throw Error("FORBIDDEN_EXTERNAL_IO");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    vi.stubGlobal("fetch",forbidden);
    const ticket=prepareCasIsolatedConfigFork(snap(source()));
    native.mockRejectedValueOnce(Error("Source CAS conflict"))
      .mockRejectedValueOnce(Error("QuotaExceededError"));
    await expect(confirmCasIsolatedConfigFork(ticket,true)).rejects
      .toThrow(/conflict/);
    await expect(confirmCasIsolatedConfigFork(ticket,true)).rejects
      .toThrow(/Quota/);
    expect(forbidden).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledTimes(2);
  });
});
