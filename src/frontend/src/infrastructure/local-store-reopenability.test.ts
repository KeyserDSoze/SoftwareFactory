import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import type { FactoryProject } from "../domain/types";
import { listLocalProjects, loadLocalProject, loadProject,
  localProjectSnapshot, persistProject, persistProjectIfUnchanged } from "./store";

const SLOT = "softwarefactory.project.library.v1.";
const LEGACY = "softwarefactory.project.v1";
const INDEX = "softwarefactory.project.index.v1";
const TAB = "softwarefactory.project.active-tab.v1";
const LIMIT = 1_000_000;

describe("local project reopenability and quota-safe metadata (#137)", () => {
  const storage = new Map<string,string>();
  const tabs = new Map<string,string>();
  const failWrites = new Set<string>();
  let silentSlot = false, blockTab = false, writes: string[] = [];
  beforeEach(() => {
    storage.clear(); tabs.clear(); failWrites.clear();
    silentSlot = false; blockTab = false; writes = [];
    vi.stubGlobal("localStorage", {
      get length() { return storage.size; },
      key:(i:number)=>[...storage.keys()][i]??null,
      getItem:(k:string)=>storage.get(k)??null,
      setItem:(k:string,v:string)=>{
        writes.push(k);
        if (failWrites.has(k)) throw Object.assign(new Error("QUOTA_SECRET_MUST_NOT_LEAK"), {
          name: "QuotaExceededError",
        });
        if (silentSlot && k.startsWith(SLOT)) return;
        storage.set(k,v);
      },
      removeItem:(k:string)=>storage.delete(k),
    });
    vi.stubGlobal("sessionStorage", {
      getItem:(k:string)=>tabs.get(k)??null,
      setItem:(k:string,v:string)=>{
        if (blockTab) throw Error("SESSION_SECRET_MUST_NOT_LEAK");
        tabs.set(k,v);
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const make=()=>createProject();

  it("refuses an oversize new snapshot before any local or session write",()=>{
    const project=make();
    project.config.requirements="x".repeat(LIMIT);
    expect(()=>persistProject(project)).toThrow(/troppo grande/);
    expect(writes).toEqual([]);
    expect(storage.size).toBe(0);
    expect(tabs.size).toBe(0);
  });

  it("rejects an oversize update without replacing a previously valid checkpoint",()=>{
    const p=make();
    persistProject(p);
    const baseline=localProjectSnapshot(p.id);
    const beforeIndex=storage.get(INDEX), beforeLegacy=storage.get(LEGACY);
    const beforeTab=tabs.get(TAB);
    writes=[];
    const newer={...p,config:{...p.config, requirements:"x".repeat(LIMIT)}};
    expect(()=>persistProjectIfUnchanged(newer,baseline)).toThrow(/troppo grande/);
    expect(writes).toEqual([]);
    expect(localProjectSnapshot(p.id)).toBe(baseline);
    expect(storage.get(INDEX)).toBe(beforeIndex);
    expect(storage.get(LEGACY)).toBe(beforeLegacy);
    expect(tabs.get(TAB)).toBe(beforeTab);
    expect(loadLocalProject(p.id).config.requirements).toBe("");
  });

  it("accepts exactly 1M serialized characters and rejects one more",()=>{
    const p=make(), originalLength=JSON.stringify(p).length;
    p.config.requirements="x".repeat(LIMIT-originalLength);
    expect(JSON.stringify(p)).toHaveLength(LIMIT);
    persistProject(p);
    expect(localProjectSnapshot(p.id)?.length).toBe(LIMIT);
    expect(loadLocalProject(p.id).id).toBe(p.id);
    expect(listLocalProjects()).toHaveLength(1);
    p.config.requirements+="x";
    expect(()=>persistProject(p)).toThrow(/troppo grande/);
    expect(localProjectSnapshot(p.id)?.length).toBe(LIMIT);
  });

  it("rejects invalid project IDs, shapes and dates with no write",()=>{
    const p=make();
    const broken: FactoryProject[]=[
      {...p,id:"../escaped"},
      {...p,config:null as unknown as FactoryProject["config"]},
      {...p,stages:null as unknown as FactoryProject["stages"]},
      {...p,updatedAt:"not-a-date"},
      {...p,updatedAt:"9".repeat(65)},
    ];
    for(const item of broken)
      expect(()=>persistProject(item)).toThrow(/non valido/);
    expect(writes).toEqual([]);
    expect(storage.size).toBe(0);
  });

  it("rejects circular JSON without printing contents or committing any key",()=>{
    const p=make();
    const loop: Record<string,unknown>={secret:"NEVER_ECHO_PAT"};
    loop.loop=loop;
    const invalid={...p,unexpected:loop};
    try {
      persistProject(invalid);
      throw Error("Expected failure");
    } catch(error) {
      expect(String(error)).toMatch(/non serializzabile/);
      expect(String(error)).not.toContain("NEVER_ECHO_PAT");
    }
    expect(writes).toEqual([]);
  });

  it("fails closed if authoritative slot hits quota, with zero metadata writes",()=>{
    const p=make();failWrites.add(SLOT+p.id);
    expect(()=>persistProject(p)).toThrow(/Spazio locale insufficiente/);
    expect(writes).toEqual([SLOT+p.id]);
    expect(storage.size).toBe(0);
    expect(tabs.size).toBe(0);
  });

  it("does not acknowledge a faulty adapter that silently discards the slot",()=>{
    const p=make();silentSlot=true;
    expect(()=>persistProject(p)).toThrow(/non confermata/);
    expect(writes).toEqual([SLOT+p.id]);
    expect(storage.size).toBe(0);
    expect(()=>persistProjectIfUnchanged(p,null)).toThrow(/non confermata/);
    expect(storage.size).toBe(0);
  });

  it("keeps a successful save when the legacy global cache fails quota",()=>{
    const p=make();failWrites.add(LEGACY);
    persistProject(p);
    expect(loadLocalProject(p.id).id).toBe(p.id);
    expect(listLocalProjects()).toHaveLength(1);
    expect(tabs.get(TAB)).toBe(p.id);
    expect(storage.has(LEGACY)).toBe(false);
    expect(storage.has(INDEX)).toBe(true);
  });

  it("keeps the confirmed slot and per-tab selection when both caches hit quota",()=>{
    const p=make();failWrites.add(LEGACY);failWrites.add(INDEX);
    const saved=persistProjectIfUnchanged(p,null);
    expect(saved).toBe(JSON.stringify(p));
    expect(loadProject().id).toBe(p.id);
    expect(loadLocalProject(p.id).id).toBe(p.id);
    expect(listLocalProjects().map(x=>x.id)).toEqual([p.id]);
    expect(storage.size).toBe(1);
    expect(tabs.get(TAB)).toBe(p.id);
    expect(writes).toEqual([SLOT+p.id,LEGACY,INDEX]);
  });

  it("allows manual library recovery even if caches and per-tab selection are blocked",()=>{
    const p=make();failWrites.add(LEGACY);failWrites.add(INDEX);blockTab=true;
    persistProject(p);
    expect(localProjectSnapshot(p.id)).toBe(JSON.stringify(p));
    expect(loadLocalProject(p.id).id).toBe(p.id);
    expect(listLocalProjects().map(x=>x.id)).toEqual([p.id]);
    expect(tabs.size).toBe(0);
  });

  it("preserves the stale baseline gate when a newer writer has already committed",()=>{
    const p=make();persistProject(p);
    const baseline=localProjectSnapshot(p.id);
    const current={...p,config:{...p.config,name:"Newer writer"}};
    persistProject(current);
    const stale={...p,config:{...p.config,name:"Stale writer"}};
    writes=[];
    expect(()=>persistProjectIfUnchanged(stale,baseline)).toThrow(/Conflitto locale/);
    expect(writes).toEqual([]);
    expect(loadLocalProject(p.id).config.name).toBe("Newer writer");
  });

  it("skips oversized legacy pointer before JSON.parse without deleting old data",()=>{
    const oversized="{".repeat(LIMIT+1);
    storage.set(LEGACY,oversized);
    const fallback=loadProject();
    expect(fallback.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(storage.get(LEGACY)).toBe(oversized);
    expect(writes).toEqual([]);
  });
});
