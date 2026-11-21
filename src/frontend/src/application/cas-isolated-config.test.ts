import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {buildCasIsolatedConfigEdit,CAS_ISOLATED_NAME_MAX,
  CAS_ISOLATED_DESCRIPTION_MAX} from "./cas-isolated-config";

const fixture=()=>{
  const original=createProject();
  original.config.name="Before";
  original.config.description="Original brief";
  original.stages[0]={...original.stages[0],status:"complete",
    output:"HISTORICAL_AI_EVIDENCE",sources:[{title:"Source",url:"https://example.com",snippet:"Old"}]};
  const raw=JSON.stringify(original);
  return {original,expected:{id:original.id,revision:3,raw}};
};

describe("isolated CAS configuration builder (#149)",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("edits name and description immutably while invalidating old pipeline evidence",()=>{
    const {original,expected}=fixture();
    const candidate=buildCasIsolatedConfigEdit(expected,"Updated","New brief");
    expect(candidate.id).toBe(expected.id);
    expect(candidate.config.name).toBe("Updated");
    expect(candidate.config.description).toBe("New brief");
    expect(candidate.stages[0].status).toBe("pending");
    expect(candidate.stages[0].output).toBe("");
    expect(candidate.stages[0].sources).toEqual([]);
    expect(original.stages[0].output).toBe("HISTORICAL_AI_EVIDENCE");
    expect(JSON.stringify(original)).toBe(expected.raw);
    expect(candidate.updatedAt).not.toBeUndefined();
  });
  it("rejects an unchanged draft, invalid bounds and inconsistent snapshot before storage",()=>{
    const {expected}=fixture();
    expect(()=>buildCasIsolatedConfigEdit(expected,"Before","Original brief"))
      .toThrow(/Nessuna modifica/);
    expect(()=>buildCasIsolatedConfigEdit(expected," ","anything"))
      .toThrow(/non validi/);
    expect(()=>buildCasIsolatedConfigEdit(expected,"x".repeat(CAS_ISOLATED_NAME_MAX+1),""))
      .toThrow(/non validi/);
    expect(()=>buildCasIsolatedConfigEdit(expected,"Valid",
      "x".repeat(CAS_ISOLATED_DESCRIPTION_MAX+1))).toThrow(/non validi/);
    expect(()=>buildCasIsolatedConfigEdit({...expected,id:"different"},"A","B"))
      .toThrow(/non canonico/);
    expect(()=>buildCasIsolatedConfigEdit({...expected,raw:"broken"},"A","B"))
      .toThrow(/non canonico/);
  });
  it("does not read/write localStorage, IndexedDB, GitHub or settings during pure edit",()=>{
    const {expected}=fixture();
    const forbidden=vi.fn(()=>{throw Error("STORAGE_MUST_NOT_BE_TOUCHED");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    buildCasIsolatedConfigEdit(expected,"Edited","Description");
    expect(forbidden).not.toHaveBeenCalled();
  });
});
