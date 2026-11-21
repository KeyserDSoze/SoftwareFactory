import {beforeEach,describe,expect,it,vi} from "vitest";
import {createProject,STAGES} from "../domain/defaults";
import type {FactoryProject} from "../domain/types";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {openCasEditorSession} from "../infrastructure/project-cas-editor-session";
import {openCasPipelineSession,canBeginCasPipelineStage} from "./cas-pipeline-session";

vi.mock("../infrastructure/project-cas-editor-session",()=>({
  openCasEditorSession:vi.fn(),
}));
const open=vi.mocked(openCasEditorSession);

function fixture(){
  const p=createProject();
  p.config.name="CAS pipeline";
  p.stages[0]={...p.stages[0],status:"complete",output:"Feature plan"};
  p.stages[1]={...p.stages[1],status:"complete",output:"Competitor plan"};
  return {p,snapshot:{id:p.id,revision:1,raw:JSON.stringify(p)}};
}
function arrange(snapshot:CasProjectSnapshot){
  let token=snapshot;
  let status:"ready"|"saving"|"blocked"="ready";
  const commit=vi.fn(async(next:FactoryProject,expected:CasProjectSnapshot)=>{
    if(status!=="ready" || expected.revision!==token.revision ||
       expected.raw!==token.raw) throw Error("CAS stale");
    status="saving";
    token={id:token.id,revision:token.revision+1,raw:JSON.stringify(next)};
    status="ready";
    return token;
  });
  open.mockResolvedValue({snapshot:()=>token,state:()=>status,commit});
  return {commit,block:()=>{status="blocked";}};
}

describe("async CAS pipeline stage contract (#156)",()=>{
  beforeEach(()=>open.mockReset());
  it("begins after predecessors and completes on the acknowledged start token",async()=>{
    const {p,snapshot}=fixture(),x=arrange(snapshot);
    const coordinator=await openCasPipelineSession(p.id);
    const ticket=await coordinator.begin("technical");
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(ticket.started.revision).toBe(2);
    expect(coordinator.snapshot()).toEqual(ticket.started);
    const begun=JSON.parse(ticket.started.raw);
    expect(begun.stages.slice(0,2)).toEqual(p.stages.slice(0,2));
    expect(begun.stages[2]).toMatchObject({status:"running",output:"",sources:[]});
    expect(begun.stages.slice(3).every((s:{status:string})=>s.status==="pending")).toBe(true);
    await expect(coordinator.begin("technical")).rejects.toThrow(/occupata/);
    const result=await coordinator.complete(ticket,"Actual AI result",[]);
    expect(result.revision).toBe(3);
    expect(JSON.parse(result.raw).stages[2].status).toBe("complete");
    expect(JSON.parse(result.raw).stages[2].output).toBe("Actual AI result");
    expect(JSON.parse(result.raw).stages.slice(0,2)).toEqual(p.stages.slice(0,2));
    await expect(coordinator.complete(ticket,"Late duplicate",[]))
      .rejects.toThrow(/obsoleto/);
    expect(x.commit).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid predecessor, empty result and unsafe citations before writing",async()=>{
    const {p,snapshot}=fixture(),x=arrange(snapshot);
    const coordinator=await openCasPipelineSession(p.id);
    await expect(coordinator.begin("implementation")).rejects.toThrow(/Predecessori/);
    await expect(coordinator.begin("nonsense" as never)).rejects.toThrow(/non riconosciuta/);
    const ticket=await coordinator.begin("technical");
    await expect(coordinator.complete(ticket," ",[])).rejects.toThrow(/non valido/);
    await expect(coordinator.complete(ticket,"x".repeat(60_001),[]))
      .rejects.toThrow(/non valido/);
    await expect(coordinator.complete(ticket,"OK",[{title:"bad",url:"javascript:bad",
      snippet:"x",query:"x",fetchedAt:"2026-11-21T20:00:00.000Z"}]))
      .rejects.toThrow(/non valido/);
    expect(x.commit).toHaveBeenCalledTimes(1);
    await expect(coordinator.complete(ticket,"Genuine result",[]))
      .resolves.toMatchObject({revision:3});
    expect(STAGES).toHaveLength(6);
  });
  it("abort fences late success; fail keeps bounded generic error, not provider secrets",async()=>{
    const {p,snapshot}=fixture(),x=arrange(snapshot);
    const coordinator=await openCasPipelineSession(p.id);
    const first=await coordinator.begin("technical");
    const aborted=await coordinator.abort(first);
    expect(JSON.parse(aborted.raw).stages[2]).toMatchObject({
      status:"pending",output:"",sources:[],
    });
    await expect(coordinator.complete(first,"late success",[])).rejects.toThrow(/obsoleto/);
    const second=await coordinator.begin("technical");
    await expect(coordinator.fail(second,"SECRET_CUSTOM_ERROR" as never))
      .rejects.toThrow(/non riconosciuto/);
    const failed=await coordinator.fail(second,"provider");
    const stage=JSON.parse(failed.raw).stages[2];
    expect(stage.status).toBe("failed");
    expect(stage.error).toBe("Provider AI non disponibile.");
    expect(failed.raw).not.toContain("SECRET_CUSTOM_ERROR");
    expect(x.commit).toHaveBeenCalledTimes(4);
  });
  it("rejects any late response if the writable session is blocked by a rival",async()=>{
    const {p,snapshot}=fixture(),x=arrange(snapshot);
    const coordinator=await openCasPipelineSession(p.id);
    const ticket=await coordinator.begin("technical");
    x.block();
    await expect(coordinator.complete(ticket,"late model answer",[]))
      .rejects.toThrow(/obsoleto/);
    await expect(coordinator.abort(ticket)).rejects.toThrow(/obsoleto/);
    expect(x.commit).toHaveBeenCalledTimes(1);
  });
  it("fails closed on malformed stage rows without localStorage access",async()=>{
    const {p,snapshot}=fixture();
    const x=arrange({...snapshot,raw:JSON.stringify({...p,stages:p.stages.slice(0,3)})});
    const local=vi.fn(()=>{throw Error("LEGACY_NOT_ALLOWED");});
    vi.stubGlobal("localStorage",{setItem:local,getItem:local});
    try{
      const coordinator=await openCasPipelineSession(p.id);
      await expect(coordinator.begin("technical")).rejects.toThrow(/non canonico/);
      expect(x.commit).not.toHaveBeenCalled();
      expect(local).not.toHaveBeenCalled();
    }finally{vi.unstubAllGlobals();}
  });
});
