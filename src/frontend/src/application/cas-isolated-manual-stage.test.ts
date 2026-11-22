import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject,STAGES} from "../domain/defaults";
import {
  buildCasIsolatedManualStage,canCommitCasIsolatedManualStage,
  CAS_MANUAL_STAGE_MAX_CHARS,
} from "./cas-isolated-manual-stage";

function initial(){
  const p=createProject();
  return {p,token:{id:p.id,revision:3,raw:JSON.stringify(p)}};
}
function token(p:ReturnType<typeof createProject>){
  return {id:p.id,revision:3,raw:JSON.stringify(p)};
}
describe("isolated human stage output CAS preflight #161",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("commits human text only with explicit manual origin and no fabricated evidence",()=>{
    const {p}=initial();
    const text="<script>alert('not executable')</script> Human notes";
    const candidate=buildCasIsolatedManualStage(token(p),"features",text);
    expect(candidate.stages[0]).toMatchObject({
      id:"features",status:"complete",output:text,
      completionOrigin:"manual",sources:[],
    });
    expect(candidate.stages[0].error).toBeUndefined();
    expect(candidate.stages[1].status).toBe("pending");
    expect(candidate.id).toBe(p.id);
    expect(candidate.createdAt).toBe(p.createdAt);
    expect(candidate.githubSync).toBeUndefined();
    expect(candidate.githubTestReceipt).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("manual");
  });
  it("corrects existing complete stage and invalidates downstream without rewriting predecessors",()=>{
    const {p}=initial();
    p.stages[0]={...p.stages[0],status:"complete",output:"PREVIOUS_AI",
      sources:[{title:"Source",url:"https://example.org",snippet:"s",
        query:"q",fetchedAt:"2026-11-20T10:00:00Z"}]};
    p.stages[1]={...p.stages[1],status:"complete",output:"EXISTING",
      completionOrigin:"ai"};
    p.stages[2]={...p.stages[2],status:"complete",output:"DOWNSTREAM",
      completionOrigin:"manual"};
    p.stages[3]={...p.stages[3],status:"failed",error:"private provider error"};
    const before=token(p);
    const candidate=buildCasIsolatedManualStage(before,"competitors","CORRECTED HUMAN");
    expect(JSON.stringify(candidate.stages[0])).toBe(JSON.stringify(p.stages[0]));
    expect(candidate.stages[1].output).toBe("CORRECTED HUMAN");
    expect(candidate.stages[1].completionOrigin).toBe("manual");
    expect(candidate.stages.slice(2)).toEqual(
      STAGES.slice(2).map(stage=>({id:stage.id,label:stage.label,
        status:"pending",output:"",sources:[]})));
    expect(before.raw).toContain("DOWNSTREAM");
    expect(canCommitCasIsolatedManualStage(before,"competitors","CORRECTED HUMAN"))
      .toBe(true);
  });
  it("rejects completed prerequisite with no output and concurrent running stages",()=>{
    const {p}=initial();
    expect(()=>buildCasIsolatedManualStage(token(p),"technical","text"))
      .toThrow(/Predecessori/);
    p.stages[0].status="complete";p.stages[0].output="";
    expect(()=>buildCasIsolatedManualStage(token(p),"competitors","text"))
      .toThrow(/Predecessori/);
    p.stages[0].output="done";p.stages[4].status="running";
    expect(()=>buildCasIsolatedManualStage(token(p),"competitors","text"))
      .toThrow(/running/);
    expect(canCommitCasIsolatedManualStage(token(p),"competitors","text"))
      .toBe(false);
  });
  it("rejects blank/overlimit/nonstring, unknown stage, noncanonical and forged origins",()=>{
    const {p}=initial(),t=token(p);
    expect(()=>buildCasIsolatedManualStage(t,"features","  \n  "))
      .toThrow(/vuoto/);
    expect(()=>buildCasIsolatedManualStage(t,"features","x".repeat(
      CAS_MANUAL_STAGE_MAX_CHARS+1))).toThrow(/troppo lungo/);
    expect(()=>buildCasIsolatedManualStage(t,"features",null as never))
      .toThrow(/vuoto/);
    expect(()=>buildCasIsolatedManualStage(t,"bogus" as never,"x"))
      .toThrow(/sconosciuta/);
    expect(()=>buildCasIsolatedManualStage({...t,id:"other"},"features","x"))
      .toThrow(/non canonico/);
    expect(()=>buildCasIsolatedManualStage({...t,raw:t.raw+" "},"features","x"))
      .toThrow(/non canonico/);
    p.stages[0].completionOrigin="manual"; // invalid on pending stage
    expect(()=>buildCasIsolatedManualStage(token(p),"features","text"))
      .toThrow(/non canonico/);
    p.stages[0].status="complete";p.stages[0].output="old";
    p.stages[0].completionOrigin="remote" as never;
    expect(()=>buildCasIsolatedManualStage(token(p),"features","text"))
      .toThrow(/non canonico/);
  });
  it("no-op manual completion does not increment revision",()=>{
    const {p}=initial();
    p.stages[0]={id:"features",label:p.stages[0].label,status:"complete",
      output:"already done",sources:[],completionOrigin:"manual"};
    const t=token(p);
    expect(()=>buildCasIsolatedManualStage(t,"features","already done"))
      .toThrow(/Nessuna modifica/);
    expect(canCommitCasIsolatedManualStage(t,"features","already done"))
      .toBe(false);
  });
  it("is pure before consent: no IDB, localStorage, provider or network reads",()=>{
    const {p}=initial();
    const fail=vi.fn(()=>{throw Error("FORBIDDEN");});
    vi.stubGlobal("indexedDB",{open:fail});
    vi.stubGlobal("localStorage",{getItem:fail,setItem:fail});
    vi.stubGlobal("fetch",fail);
    const before=token(p);
    const c=buildCasIsolatedManualStage(before,"features","human text");
    expect(c.stages[0].status).toBe("complete");
    expect(before.raw).toBe(JSON.stringify(p));
    expect(fail).not.toHaveBeenCalled();
  });
});
