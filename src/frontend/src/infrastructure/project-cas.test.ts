import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import { compareAndSwapCasProject, deleteCasProject, readCasProject,
  serializeCasProject } from "./project-cas";

describe("IndexedDB CAS preflight and fail-closed contracts #138", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("serializes valid local FactoryProject without side effects", () => {
    const p = createProject();
    expect(JSON.parse(serializeCasProject(p)).id).toBe(p.id);
  });
  it("refuses invalid IDs, corrupted data, oversized JSON and cycles before opening DB", async () => {
    const open = vi.fn();
    vi.stubGlobal("indexedDB", {open});
    const p = createProject();
    const wrongId = {...p,id:"../not-an-id"};
    const broken = {...p,config:null as unknown as typeof p.config};
    const tooLarge = {...p,config:{...p.config,requirements:"x".repeat(1_000_000)}};
    const circular: Record<string, unknown> = {};
    circular.back = circular;
    expect(()=>serializeCasProject(wrongId)).toThrow(/non valido/);
    expect(()=>serializeCasProject(broken)).toThrow(/non valido/);
    expect(()=>serializeCasProject(tooLarge)).toThrow(/troppo grande/);
    // Build a runtime fixture with a cyclic extra property without an
    // excess-property literal passed directly to the FactoryProject type.
    const cyclicProject = Object.assign({}, p, {circular});
    expect(()=>serializeCasProject(cyclicProject)).toThrow(/non serializzabile/);
    await expect(compareAndSwapCasProject(tooLarge,null)).rejects.toThrow(/troppo grande/);
    await expect(compareAndSwapCasProject(p,{id:p.id,revision:0,raw:"secret"}))
      .rejects.toThrow(/Versione CAS/);
    await expect(deleteCasProject(p.id,{id:p.id,revision:0,raw:"secret"}))
      .rejects.toThrow(/Versione CAS/);
    expect(open).not.toHaveBeenCalled();
  });
  it("never downgrades to localStorage when IndexedDB is missing", async () => {
    vi.stubGlobal("indexedDB",undefined);
    const local = vi.fn();
    vi.stubGlobal("localStorage", {setItem:local});
    const p=createProject();
    await expect(readCasProject(p.id)).rejects.toThrow(/IndexedDB non disponibile/);
    await expect(compareAndSwapCasProject(p,null)).rejects.toThrow(/IndexedDB non disponibile/);
    await expect(deleteCasProject(p.id,{id:p.id,revision:1,raw:serializeCasProject(p)}))
      .rejects.toThrow(/IndexedDB non disponibile/);
    expect(local).not.toHaveBeenCalled();
  });
  it("does not surface provider content when a database open fails", async () => {
    const p=createProject();
    vi.stubGlobal("indexedDB",{
      open:()=>{throw Error("NEVER_ECHO_DB_NATIVE_REASON_SECRET");},
    });
    try {
      await compareAndSwapCasProject(p,null);
      throw Error("Expected CAS open failure");
    } catch(e) {
      expect(String(e)).toMatch(/IndexedDB CAS/);
      expect(String(e)).not.toContain("NEVER_ECHO_DB_NATIVE_REASON_SECRET");
    }
  });
});
