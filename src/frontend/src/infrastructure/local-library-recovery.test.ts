import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import { listLocalProjects, loadLocalProject, loadProject, localProjectSnapshot,
  persistProject, persistProjectIfUnchanged } from "./store";

const LIB="softwarefactory.project.library.v1.";
const INDEX="softwarefactory.project.index.v1";
const ACTIVE="softwarefactory.project.v1";
const TAB="softwarefactory.project.active-tab.v1";

describe("reconstruct local library and per-tab selection (#134)", () => {
  const persistent=new Map<string,string>();
  const tabs=[new Map<string,string>(),new Map<string,string>()];

  function asTab(n:number) {
    const entries=tabs[n];
    vi.stubGlobal("sessionStorage", {
      getItem:(k:string)=>entries.get(k)??null,
      setItem:(k:string,v:string)=>{entries.set(k,v);},
      removeItem:(k:string)=>{entries.delete(k);},
    });
  }
  function local() {
    return {
      get length() { return persistent.size; },
      key:(i:number)=>[...persistent.keys()][i]??null,
      getItem:(k:string)=>persistent.get(k)??null,
      setItem:(k:string,v:string)=>{persistent.set(k,v);},
      removeItem:(k:string)=>{persistent.delete(k);},
    };
  }
  const create=(name:string)=>{
    const p=createProject();p.config.name=name;return p;
  };
  beforeEach(()=>{
    persistent.clear();tabs.forEach(t=>t.clear());
    vi.stubGlobal("localStorage",local());
    asTab(0);
  });
  afterEach(()=>vi.unstubAllGlobals());

  it("recovers A and B even when concurrent writers lose the shared index entry",()=>{
    const a=create("Project A"),b=create("Project B");
    persistProject(a);asTab(1);persistProject(b);
    // Simulate an old writer's stale read-modify-write winning last.
    persistent.set(INDEX,JSON.stringify([{
      id:b.id,name:b.config.name,updatedAt:b.updatedAt,repository:"",
    }]));
    expect(listLocalProjects().map(x=>x.id).sort()).toEqual([a.id,b.id].sort());
    expect(loadLocalProject(a.id).config.name).toBe("Project A");
    expect(loadLocalProject(b.id).config.name).toBe("Project B");
    expect(loadProject().id).toBe(b.id);
    asTab(0);
    expect(loadProject().id).toBe(a.id);
    expect(persistent.get(ACTIVE)).toContain(b.id);
    expect(tabs[0].get(TAB)).toBe(a.id);
    expect(tabs[1].get(TAB)).toBe(b.id);
    expect([...tabs[0].values()].join(" ")).not.toContain("Project A");
  });

  it("does not trust stale or forged cache entries or expose corrupted library slots",()=>{
    const good=create("Good");
    const orphan=create("Orphan");
    persistProject(good);
    const misplaced=create("Different ID");
    persistent.set(LIB+orphan.id,JSON.stringify(misplaced));
    persistent.set(LIB+"invalid-id","{}");
    persistent.set(LIB+create("Malformed").id,"{invalid json");
    persistent.set(INDEX,JSON.stringify([
      {id:orphan.id,name:"Fake",updatedAt:"2029-01-01T00:00:00Z",repository:"fake/repo"},
      {id:good.id,name:"Fake Name",updatedAt:"2029-01-01T00:00:00Z",repository:"fake/repo"},
    ]));
    expect(listLocalProjects()).toEqual([{
      id:good.id,name:"Good",updatedAt:good.updatedAt,repository:"",
    }]);
    persistent.set(LIB+good.id,"x".repeat(1_000_001));
    expect(listLocalProjects()).toEqual([]);
  });

  it("enforces the 40 project cap from stored slots even with an empty global index",()=>{
    const projects=Array.from({length:40},(_,i)=>create("App-"+i));
    for(const p of projects){
      persistProject(p);
      // Another writer can drop the global index cache at any moment.
      persistent.set(INDEX,"[]");
    }
    expect(listLocalProjects()).toHaveLength(40);
    const extra=create("Should be rejected");
    expect(()=>persistProject(extra)).toThrow(/40 progetti/);
    expect(localProjectSnapshot(extra.id)).toBeNull();
    expect(listLocalProjects()).toHaveLength(40);
    expect(()=>persistProjectIfUnchanged({
      ...projects[0],config:{...projects[0].config,name:"Updated"},
    },localProjectSnapshot(projects[0].id))).not.toThrow();
  });

  it("keeps legacy global-pointer load and read-only index fallback available",()=>{
    const legacy=create("Legacy");
    legacy.stages[0].status="running";
    persistent.set(ACTIVE,JSON.stringify(legacy));
    expect(loadProject().id).toBe(legacy.id);
    expect(loadProject().stages[0].status).toBe("pending");
    const updated=create("Indexed only");
    persistent.set(INDEX,JSON.stringify([{
      id:updated.id,name:updated.config.name,
      updatedAt:updated.updatedAt,repository:"",
    }]));
    // Test mocks or older non-standard Storage shims may not enumerate keys.
    vi.stubGlobal("localStorage",{
      getItem:(k:string)=>persistent.get(k)??null,
      setItem:(k:string,v:string)=>persistent.set(k,v),
    });
    expect(listLocalProjects().map(x=>x.id)).toContain(updated.id);
    asTab(0);tabs[0].set(TAB,"not-a-project");
    expect(loadProject().id).toBe(legacy.id);
  });

  it("fails safe when a tab-selected project disappeared, rather than switching to another tab's project",()=>{
    const a=create("Tab A"),b=create("Tab B");
    persistProject(a);asTab(1);persistProject(b);
    asTab(0);
    persistent.delete(LIB+a.id);
    expect(loadProject().id).not.toBe(b.id);
    expect(listLocalProjects().map(x=>x.id)).toEqual([b.id]);
  });
});
