import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import { readCasProjectSlot } from "./project-cas";
import { inspectLegacyCasCopy, readCasExportSnapshot } from "./project-cas-reconciliation";

vi.mock("./project-cas",async importOriginal=>{
  const original=await importOriginal<typeof import("./project-cas")>();
  return {...original,readCasProjectSlot:vi.fn()};
});

const slotPrefix="softwarefactory.project.library.v1.";
const entries=new Map<string,string>();
const mocked=vi.mocked(readCasProjectSlot);

describe("read-only CAS reconciliation guard #142",()=>{
  beforeEach(()=>{
    entries.clear(); mocked.mockReset();
    vi.stubGlobal("localStorage",{
      getItem:(key:string)=>entries.get(key)??null,
      setItem:(key:string,value:string)=>entries.set(key,value),
    });
  });
  afterEach(()=>vi.unstubAllGlobals());
  function fixture(){
    const p=createProject(),raw=JSON.stringify(p);
    entries.set(slotPrefix+p.id,raw);
    return {p,raw,snapshot:{id:p.id,revision:1,raw}};
  }
  it("distinguishes missing and deletion without a write or fallback",async()=>{
    const {p}=fixture();
    mocked.mockResolvedValue({state:"missing"});
    await expect(inspectLegacyCasCopy(p.id)).resolves.toEqual({id:p.id,status:"missing"});
    mocked.mockResolvedValue({state:"tombstone",revision:3});
    await expect(inspectLegacyCasCopy(p.id)).resolves.toEqual(
      {id:p.id,status:"tombstone",revision:3});
    expect(entries.size).toBe(1);
  });
  it("identifies exact checkpoint identity, not just project timestamps",async()=>{
    const {p,snapshot,raw}=fixture();
    mocked.mockResolvedValue({state:"present",snapshot});
    await expect(inspectLegacyCasCopy(p.id)).resolves.toEqual(
      {id:p.id,status:"identical",revision:1});
    mocked.mockResolvedValue({state:"present",snapshot:{...snapshot,raw:
      JSON.stringify({...p,config:{...p.config,name:"earlier"}})}});
    await expect(inspectLegacyCasCopy(p.id)).resolves.toEqual(
      {id:p.id,status:"diverged",revision:1});
    expect(entries.get(slotPrefix+p.id)).toBe(raw);
  });
  it("fails on local change between async IDB reads",async()=>{
    const {p,snapshot}=fixture();
    mocked.mockImplementation(async()=>{
      entries.set(slotPrefix+p.id,JSON.stringify({...p,config:{...p.config,name:"writer B"}}));
      return {state:"present",snapshot};
    });
    await expect(inspectLegacyCasCopy(p.id)).rejects.toThrow(/cambiate/);
  });
  it("fails on concurrent IDB changes without trusting revision alone",async()=>{
    const {p,snapshot}=fixture();
    mocked.mockResolvedValueOnce({state:"present",snapshot})
      .mockResolvedValueOnce({state:"present",snapshot:{...snapshot,raw:"DIFFERENT"}});
    await expect(inspectLegacyCasCopy(p.id)).rejects.toThrow(/cambiate/);
    mocked.mockReset();
    mocked.mockResolvedValueOnce({state:"present",snapshot})
      .mockResolvedValueOnce({state:"tombstone",revision:2});
    await expect(inspectLegacyCasCopy(p.id)).rejects.toThrow(/cambiate/);
  });
  it("rejects missing/corrupt legacy or IndexedDB failure",async()=>{
    const {p}=fixture();
    entries.set(slotPrefix+p.id,"{broken");
    await expect(inspectLegacyCasCopy(p.id)).rejects.toThrow(/JSON legacy non valido/);
    entries.delete(slotPrefix+p.id);
    await expect(inspectLegacyCasCopy(p.id)).rejects.toThrow(/non trovato/);
    const {snapshot}=fixture();
    mocked.mockRejectedValue(Error("IndexedDB non disponibile"));
    await expect(inspectLegacyCasCopy(snapshot.id)).rejects.toThrow(/IndexedDB non disponibile/);
  });
  it("exports exact IDB bytes only for stable declared revision",async()=>{
    const {p,snapshot}=fixture();
    mocked.mockResolvedValue({state:"present",snapshot});
    await expect(readCasExportSnapshot(p.id,1)).resolves.toEqual(snapshot);
    await expect(readCasExportSnapshot(p.id,0)).rejects.toThrow(/Revisione/);
    await expect(readCasExportSnapshot(p.id,2)).rejects.toThrow(/cambiata/);
    mocked.mockReset();
    mocked.mockResolvedValueOnce({state:"present",snapshot})
      .mockResolvedValueOnce({state:"present",snapshot:{...snapshot,revision:2}});
    await expect(readCasExportSnapshot(p.id,1)).rejects.toThrow(/cambiata/);
  });
});
