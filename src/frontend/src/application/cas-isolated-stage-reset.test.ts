import {describe,expect,it,vi,afterEach} from "vitest";
import {createProject,STAGES} from "../domain/defaults";
import {buildCasIsolatedStageReset,canResetCasIsolatedStage}
  from "./cas-isolated-stage-reset";

const fixture=()=>{
  const original=createProject();
  original.config.name="Isolated checkpoint reset";
  for(const [i,stage] of original.stages.entries()){
    stage.status="complete";
    stage.output="OLD_AI_OUTPUT_"+i;
    stage.sources=[{title:"Source "+i,url:"https://example.com/"+i,
      snippet:"old",query:"query",fetchedAt:"2026-11-21T20:00:00.000Z"}];
    stage.updatedAt="2026-11-21T20:00:00.000Z";
  }
  return {original,expected:{id:original.id,revision:4,raw:JSON.stringify(original)}};
};
describe("isolated CAS selective stage reset (#155)",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("resets selected and downstream without modifying earlier checkpoints, config or receipts",()=>{
    const {original,expected}=fixture();
    const candidate=buildCasIsolatedStageReset(expected,"technical");
    expect(candidate.id).toBe(original.id);
    expect(candidate.stages.slice(0,2)).toEqual(original.stages.slice(0,2));
    for(const stage of candidate.stages.slice(2)){
      expect(stage).toEqual({
        id:stage.id,label:stage.label,status:"pending",output:"",sources:[],
      });
    }
    expect(candidate.config).toEqual(original.config);
    expect(candidate.createdAt).toBe(original.createdAt);
    expect(candidate.updatedAt).toBeDefined();
    expect(JSON.stringify(original)).toBe(expected.raw);
    expect(canResetCasIsolatedStage(expected,"technical")).toBe(true);
    const resetSnapshot={...expected,raw:JSON.stringify(candidate),revision:5};
    expect(canResetCasIsolatedStage(resetSnapshot,"technical")).toBe(false);
    expect(()=>buildCasIsolatedStageReset(resetSnapshot,"technical"))
      .toThrow(/già azzerate/);
    // Earlier phases remain eligible, since they contain old checkpoint data.
    expect(canResetCasIsolatedStage(resetSnapshot,"features")).toBe(true);
  });
  it("rejects unknown stage, wrong IDs/revisions/raw and malformed stage layouts",()=>{
    const {original,expected}=fixture();
    expect(()=>buildCasIsolatedStageReset(expected,"unexpected" as never))
      .toThrow(/non riconosciuta/);
    for(const snapshot of [
      {...expected,id:"00000000-0000-4000-8000-000000000000"},
      {...expected,revision:0},
      {...expected,raw:expected.raw+" "},
      {...expected,raw:"broken"},
    ])expect(()=>buildCasIsolatedStageReset(snapshot,"features"))
      .toThrow(/non canonici/);
    const malformed=[
      {...original,stages:original.stages.slice(0,4)},
      {...original,stages:[...original.stages.slice(0,2),
        {...original.stages[2],id:"features"},...original.stages.slice(3)]},
      {...original,stages:original.stages.map((s,i)=>i===1?
        {...s,sources:"forged"}:s)},
      {...original,stages:original.stages.map((s,i)=>i===1?
        {...s,status:"approved"}:s)},
    ];
    for(const project of malformed)
      expect(()=>buildCasIsolatedStageReset(
        {...expected,raw:JSON.stringify(project)},"technical"))
        .toThrow(/non canonici/);
    expect(STAGES.length).toBe(6);
  });
  it("does not mutate project, touch storage, or invent completed AI/test evidence",()=>{
    const {original,expected}=fixture();
    const forbidden=vi.fn(()=>{throw Error("NO_STORAGE_ACCESS");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    const candidate=buildCasIsolatedStageReset(expected,"adversarial");
    expect(candidate.stages[4].status).toBe("pending");
    expect(candidate.stages[5].status).toBe("pending");
    expect(candidate.stages[3]).toEqual(original.stages[3]);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
