import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {buildCasIsolatedConfigEdit,CAS_ISOLATED_NAME_MAX,
  CAS_ISOLATED_DESCRIPTION_MAX,CAS_ISOLATED_REQUIREMENTS_MAX} from "./cas-isolated-config";

const fixture=()=>{
  const original=createProject();
  original.config.name="Before";
  original.config.description="Original brief";
  original.config.requirements="Original constraints";
  original.stages[0]={...original.stages[0],status:"complete",
    output:"HISTORICAL_AI_EVIDENCE",sources:[{title:"Source",url:"https://example.com",snippet:"Old",
      query:"old evidence",fetchedAt:"2026-11-21T16:00:00.000Z"}]};
  const raw=JSON.stringify(original);
  return {original,expected:{id:original.id,revision:3,raw}};
};

describe("isolated CAS configuration builder (#149/#152)",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("edits requirements and config immutably while invalidating old pipeline evidence",()=>{
    const {original,expected}=fixture();
    const candidate=buildCasIsolatedConfigEdit(expected,"Updated","New brief","New requirements");
    expect(candidate.id).toBe(expected.id);
    expect(candidate.config.name).toBe("Updated");
    expect(candidate.config.description).toBe("New brief");
    expect(candidate.config.requirements).toBe("New requirements");
    expect(candidate.config.frontends).toEqual(original.config.frontends);
    expect(candidate.config.services).toEqual(original.config.services);
    expect(candidate.stages[0].status).toBe("pending");
    expect(candidate.stages[0].output).toBe("");
    expect(candidate.stages[0].sources).toEqual([]);
    expect(original.stages[0].output).toBe("HISTORICAL_AI_EVIDENCE");
    expect(JSON.stringify(original)).toBe(expected.raw);
    expect(candidate.updatedAt).not.toBeUndefined();
  });
  it("allows a requirements-only edit and rejects no-op / invalid input before storage",()=>{
    const {expected}=fixture();
    const candidate=buildCasIsolatedConfigEdit(
      expected,"Before","Original brief","Requirement-only revision");
    expect(candidate.config.requirements).toBe("Requirement-only revision");
    expect(candidate.stages[0].status).toBe("pending");
    expect(()=>buildCasIsolatedConfigEdit(
      expected,"Before","Original brief","Original constraints"))
      .toThrow(/Nessuna modifica/);
    expect(()=>buildCasIsolatedConfigEdit(expected," ","anything","x"))
      .toThrow(/non validi/);
    expect(()=>buildCasIsolatedConfigEdit(
      expected,"x".repeat(CAS_ISOLATED_NAME_MAX+1),"",""))
      .toThrow(/non validi/);
    expect(()=>buildCasIsolatedConfigEdit(
      expected,"Valid","x".repeat(CAS_ISOLATED_DESCRIPTION_MAX+1),""))
      .toThrow(/non validi/);
    expect(()=>buildCasIsolatedConfigEdit(
      expected,"Valid","","x".repeat(CAS_ISOLATED_REQUIREMENTS_MAX+1)))
      .toThrow(/non validi/);
    expect(()=>buildCasIsolatedConfigEdit(
      {...expected,id:"different"},"A","B","C"))
      .toThrow(/non canonico/);
    expect(()=>buildCasIsolatedConfigEdit(
      {...expected,raw:"broken"},"A","B","C"))
      .toThrow(/non canonico/);
  });
  it("fails closed for nonstring historical requirements; missing field becomes blank",()=>{
    const {original,expected}=fixture();
    const invalid={...original,config:{...original.config,requirements:123}};
    expect(()=>buildCasIsolatedConfigEdit(
      {...expected,raw:JSON.stringify(invalid)},"Before","Brief","New"))
      .toThrow(/Requisiti IndexedDB non validi/);
    const legacy=JSON.parse(expected.raw);
    delete legacy.config.requirements;
    const next=buildCasIsolatedConfigEdit(
      {...expected,raw:JSON.stringify(legacy)},"Before","Original brief","Added");
    expect(next.config.requirements).toBe("Added");
  });
  it("does not touch localStorage, IndexedDB, GitHub or settings during pure edit",()=>{
    const {expected}=fixture();
    const forbidden=vi.fn(()=>{throw Error("STORAGE_MUST_NOT_BE_TOUCHED");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    buildCasIsolatedConfigEdit(expected,"Edited","Description","Requirements");
    expect(forbidden).not.toHaveBeenCalled();
  });
});
