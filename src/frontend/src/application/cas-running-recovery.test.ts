import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {inspectCasRunningStage,prepareCasRunningRecovery}
  from "./cas-running-recovery";

function fixture(){
  const project=createProject();
  project.config.name="Recovery CAS";
  for(const stage of project.stages.slice(0,2)){
    stage.status="complete";stage.output="Historical output";
    stage.sources=[];stage.completionOrigin="ai";
  }
  project.stages[2].status="running";
  project.stages[2].updatedAt="2026-11-23T07:00:00.000Z";
  const token={id:project.id,revision:7,raw:JSON.stringify(project)};
  return {project,token};
}
describe("explicit running checkpoint recovery (#172)",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("recovers only running and following stages, leaving prior artifacts untouched",()=>{
    const {project,token}=fixture();
    const before=token.raw;
    const recovery=prepareCasRunningRecovery(token);
    expect(recovery.stage).toBe("technical");
    expect(inspectCasRunningStage(token)).toBe("technical");
    expect(recovery.candidate.stages.slice(0,2))
      .toEqual(project.stages.slice(0,2));
    for(const stage of recovery.candidate.stages.slice(2))
      expect(stage).toEqual({id:stage.id,label:stage.label,
        status:"pending",output:"",sources:[]});
    expect(recovery.candidate.config).toEqual(project.config);
    expect(recovery.candidate.createdAt).toEqual(project.createdAt);
    expect(recovery.candidate.development).toEqual(project.development);
    expect(recovery.candidate.githubSync).toEqual(project.githubSync);
    expect(token.raw).toBe(before);
    const after={id:token.id,revision:8,
      raw:JSON.stringify(recovery.candidate)};
    expect(inspectCasRunningStage(after)).toBeNull();
    expect(()=>prepareCasRunningRecovery(after)).toThrow(/sola fase/);
  });
  it("fails closed on missing or double running, ambiguous evidence and noncanonical tokens",()=>{
    const {project,token}=fixture();
    const variants=[
      {...project,stages:project.stages.map((s,i)=>i===2?
        {...s,status:"complete"}:s)},
      {...project,stages:project.stages.map((s,i)=>i===3?
        {...s,status:"running"}:s)},
      {...project,stages:project.stages.map((s,i)=>i===3?
        {...s,status:"complete",output:"late downstream"}:s)},
      {...project,stages:project.stages.map((s,i)=>i===2?
        {...s,output:"UNATTESTED_LATE_AI"}:s)},
      {...project,stages:project.stages.map((s,i)=>i===2?
        {...s,completionOrigin:"ai"}:s)},
      {...project,stages:project.stages.map((s,i)=>i===1?
        {...s,status:"pending"}:s)},
      {...project,stages:project.stages.slice(0,4)},
    ];
    for(const value of variants){
      const snapshot={...token,raw:JSON.stringify(value)};
      expect(inspectCasRunningStage(snapshot)).toBeNull();
      expect(()=>prepareCasRunningRecovery(snapshot)).toThrow();
    }
    for(const snapshot of [
      {...token,id:"00000000-0000-4000-8000-000000000000"},
      {...token,revision:0},{...token,raw:token.raw+" "},
      {...token,raw:"not json"},
    ]){
      expect(inspectCasRunningStage(snapshot)).toBeNull();
      expect(()=>prepareCasRunningRecovery(snapshot)).toThrow(/non canonico/);
    }
  });
  it("is pure: no localStorage, IndexedDB, provider or artificial receipt",()=>{
    const {token}=fixture();
    const forbidden=vi.fn(()=>{throw Error("UNEXPECTED_STORAGE");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    vi.stubGlobal("fetch",forbidden);
    const result=prepareCasRunningRecovery(token);
    expect(result.candidate.stages[2].status).toBe("pending");
    expect(forbidden).not.toHaveBeenCalled();
  });
});
