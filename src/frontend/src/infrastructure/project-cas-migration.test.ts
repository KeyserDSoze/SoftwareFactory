import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import { prepareLegacyCasCopy, legacyCasBackupJson, copyLegacyCasTicket } from "./project-cas-migration";

const prefix="softwarefactory.project.library.v1.";
const entries=new Map<string,string>();
describe("backup-gated legacy CAS staging preflight (#141)",()=>{
  beforeEach(()=>{
    entries.clear();
    vi.stubGlobal("localStorage",{getItem:(k:string)=>entries.get(k)??null,
      setItem:(k:string,v:string)=>entries.set(k,v)});
  });
  afterEach(()=>vi.unstubAllGlobals());
  it("preserves exact original JSON including running checkpoint, with no writes",()=>{
    const p=createProject();
    p.stages[0].status="running";
    p.stages[0].output="unfinished source";
    const raw=JSON.stringify(p);
    entries.set(prefix+p.id,raw);
    const ticket=prepareLegacyCasCopy(p.id);
    expect(ticket).toEqual({id:p.id,raw});
    expect(legacyCasBackupJson(ticket)).toBe(raw);
    expect(entries.size).toBe(1);
  });
  it("rejects missing, corrupt, noncanonical, oversized or changed source",()=>{
    const p=createProject();
    expect(()=>prepareLegacyCasCopy(p.id)).toThrow(/non trovato/);
    entries.set(prefix+p.id,"{");
    expect(()=>prepareLegacyCasCopy(p.id)).toThrow(/JSON legacy non valido/);
    entries.set(prefix+p.id,JSON.stringify(p,null,2));
    expect(()=>prepareLegacyCasCopy(p.id)).toThrow(/non identico/);
    entries.set(prefix+p.id,JSON.stringify({...p,config:{...p.config,requirements:"x".repeat(1_000_000)}}));
    expect(()=>prepareLegacyCasCopy(p.id)).toThrow(/non identico/);
    entries.set(prefix+p.id,JSON.stringify(p));
    const ticket=prepareLegacyCasCopy(p.id);
    entries.set(prefix+p.id,JSON.stringify({...p,config:{...p.config,name:"changed"}}));
    expect(()=>legacyCasBackupJson(ticket)).toThrow(/cambiato/);
  });
  it("requires affirmative backup consent before any IDB operation",async()=>{
    const p=createProject(),raw=JSON.stringify(p);
    entries.set(prefix+p.id,raw);
    const ticket=prepareLegacyCasCopy(p.id);
    const open=vi.fn(()=>{throw Error("SENSITIVE_NATIVE_ERROR");});
    vi.stubGlobal("indexedDB",{open});
    await expect(copyLegacyCasTicket(ticket,false)).rejects.toThrow(/Conferma/);
    expect(open).not.toHaveBeenCalled();
    await expect(copyLegacyCasTicket(ticket,true)).rejects.toThrow(/IndexedDB CAS/);
    expect(open).toHaveBeenCalledTimes(1);
    expect(entries.get(prefix+p.id)).toBe(raw);
  });
});
