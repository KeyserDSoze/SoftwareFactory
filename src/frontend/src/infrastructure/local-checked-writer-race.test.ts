import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import type {FactoryProject} from "../domain/types";
import {
  loadLocalProject,localProjectSnapshot,persistProject,persistProjectIfUnchanged,
} from "./store";

const SLOT="softwarefactory.project.library.v1.";
const POINTER="softwarefactory.project.v1";
const INDEX="softwarefactory.project.index.v1";
const TAB="softwarefactory.project.active-tab.v1";

describe("legacy second pinned-baseline fence after library scan #186",()=>{
  const raw=new Map<string,string>(),tabs=new Map<string,string>();
  const reads=new Map<string,number>();
  let writes:string[]=[];
  let onRead:((key:string,n:number)=>void)|null=null;
  beforeEach(()=>{
    raw.clear();tabs.clear();reads.clear();writes=[];
    onRead=null;
    vi.stubGlobal("localStorage",{
      get length(){return raw.size;},
      key:(i:number)=>[...raw.keys()][i]??null,
      getItem:(key:string)=>{
        if(key.startsWith(SLOT)){
          const count=(reads.get(key)??0)+1;
          reads.set(key,count);
          onRead?.(key,count);
        }
        return raw.get(key)??null;
      },
      setItem:(key:string,value:string)=>{
        writes.push(key);raw.set(key,value);
      },
      removeItem:(key:string)=>raw.delete(key),
    });
    vi.stubGlobal("sessionStorage",{
      getItem:(key:string)=>tabs.get(key)??null,
      setItem:(key:string,value:string)=>tabs.set(key,value),
    });
  });
  afterEach(()=>vi.unstubAllGlobals());
  function renamed(p:FactoryProject,name:string):FactoryProject {
    return {...p,config:{...p.config,name}};
  }
  function metadata(){
    return {pointer:raw.get(POINTER),index:raw.get(INDEX),tab:tabs.get(TAB)};
  }

  it("refuses a rival update injected AFTER initial raw check DURING per-ID library enumeration",()=>{
    const p=createProject();p.config.name="Before #186";
    persistProject(p);
    const expected=localProjectSnapshot(p.id);
    const stale=renamed(p,"Stale writer #186");
    const newer=renamed(p,"Noncooperating rival #186");
    const before=metadata();
    const key=SLOT+p.id;
    reads.clear();writes=[];
    let injected=false;
    onRead=(k,n)=>{
      // First getItem is persistProjectIfUnchanged() preflight, second is
      // loadLocalProject() during listLocalProjects()/capacity scan.
      if(k===key && n===2){
        raw.set(key,JSON.stringify(newer));
        injected=true;
      }
    };
    expect(()=>persistProjectIfUnchanged(stale,expected))
      .toThrow(/cambiato durante i controlli/);
    expect(injected).toBe(true);
    expect(writes).toEqual([]); // no authoritative or cache writes
    onRead=null;
    expect(localProjectSnapshot(p.id)).toBe(JSON.stringify(newer));
    expect(loadLocalProject(p.id).config.name).toBe("Noncooperating rival #186");
    expect(metadata()).toEqual(before);
  });

  it("refuses a rival INSERT of a target with expected=null while scanning another project",()=>{
    const other=createProject();other.config.name="Other project";
    persistProject(other);
    const next=createProject();next.config.name="Stale new #186";
    const injected=renamed(next,"Rival first writer #186");
    const before=metadata();
    reads.clear();writes=[];
    let fired=0;
    onRead=(k,n)=>{
      // Target was absent at preflight. An old writer creates the target
      // while the checked writer enumerates an unrelated valid slot.
      if(k===SLOT+other.id && n===1){
        raw.set(SLOT+next.id,JSON.stringify(injected));fired++;
      }
    };
    expect(()=>persistProjectIfUnchanged(next,null))
      .toThrow(/cambiato durante i controlli/);
    expect(fired).toBe(1);
    expect(writes).toEqual([]);
    onRead=null;
    expect(localProjectSnapshot(next.id)).toBe(JSON.stringify(injected));
    expect(metadata()).toEqual(before);
  });

  it("still writes unchanged pinned versions and returns byte-exact confirmed raw",()=>{
    const p=createProject();p.config.name="Original #186";
    persistProject(p);
    const expected=localProjectSnapshot(p.id);
    const current=renamed(p,"Human edit #186");
    writes=[];
    const ack=persistProjectIfUnchanged(current,expected);
    expect(ack).toBe(JSON.stringify(current));
    expect(localProjectSnapshot(p.id)).toBe(ack);
    expect(writes[0]).toBe(SLOT+p.id);
  });

  it("direct writer remains compatible, but has no fictional CAS guarantee",()=>{
    const p=createProject();p.config.name="Initial #186";
    persistProject(p);
    const other=renamed(p,"Direct writer #186");
    persistProject(other);
    expect(localProjectSnapshot(p.id)).toBe(JSON.stringify(other));
  });
});
