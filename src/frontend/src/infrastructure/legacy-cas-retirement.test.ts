import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {persistProject,persistProjectIfUnchanged,localProjectSnapshot}
  from "./store";
import {LEGACY_CAS_RETIREMENT_PREFIX,readLegacyCasRetirement,
  legacyCasRetirementBlocked,armLegacyCasRetirement,assertLegacyProjectWritable}
  from "./legacy-cas-retirement";

const SLOT="softwarefactory.project.library.v1.";
const DIGEST="a".repeat(64);
describe("legacy per-project handoff retirement fence (#173)",()=>{
  const cells=new Map<string,string>();
  let silent=false,quota=false;
  beforeEach(()=>{
    cells.clear();silent=false;quota=false;
    vi.stubGlobal("localStorage",{
      get length(){return cells.size;},
      key:(index:number)=>[...cells.keys()][index]??null,
      getItem:(key:string)=>cells.get(key)??null,
      setItem:(key:string,value:string)=>{
        if(key.startsWith(LEGACY_CAS_RETIREMENT_PREFIX)){
          if(quota)throw Error("SECRET_QUOTA");
          if(silent)return;
        }
        cells.set(key,value);
      },
    });
    vi.stubGlobal("sessionStorage",{
      getItem:()=>null,setItem:()=>undefined,
    });
  });
  afterEach(()=>vi.unstubAllGlobals());
  it("fences the transferred ID across fresh writes but leaves other projects writable",()=>{
    const p=createProject(),other=createProject();
    persistProject(p);persistProject(other);
    const raw=localProjectSnapshot(p.id)!;
    armLegacyCasRetirement({id:p.id,raw},DIGEST);
    const record=readLegacyCasRetirement(p.id);
    expect(record).toEqual({schema:1,id:p.id,digest:DIGEST});
    expect(cells.get(LEGACY_CAS_RETIREMENT_PREFIX+p.id)).not.toContain(raw);
    expect(legacyCasRetirementBlocked(p.id)).toBe(true);
    const update={...p,config:{...p.config,name:"Should be rejected"}};
    expect(()=>persistProject(update)).toThrow(/trasferito a IndexedDB/);
    expect(()=>persistProjectIfUnchanged(update,raw))
      .toThrow(/trasferito a IndexedDB/);
    expect(localProjectSnapshot(p.id)).toBe(raw);
    expect(()=>assertLegacyProjectWritable(p.id))
      .toThrow(/trasferito a IndexedDB/);
    expect(()=>persistProject({...other,config:{...other.config,name:"Other"}}))
      .not.toThrow();
    expect(localProjectSnapshot(other.id)).toContain("Other");
  });
  it("fails closed on corrupt marker and denied storage, without writing project slot",()=>{
    const p=createProject();persistProject(p);
    const raw=localProjectSnapshot(p.id)!;
    const k=LEGACY_CAS_RETIREMENT_PREFIX+p.id;
    for(const corrupt of ["{",JSON.stringify({schema:1,id:p.id,digest:"BAD"}),
      JSON.stringify({schema:1,id:p.id,digest:DIGEST,extra:"unsafe"})]){
      cells.set(k,corrupt);
      expect(legacyCasRetirementBlocked(p.id)).toBe(true);
      expect(()=>persistProject({...p,config:{...p.config,name:"overwrite"}}))
        .toThrow(/non valida/);
      expect(localProjectSnapshot(p.id)).toBe(raw);
    }
    cells.delete(k);quota=true;
    expect(()=>armLegacyCasRetirement({id:p.id,raw},DIGEST))
      .toThrow(/non salvata/);
    expect(cells.has(k)).toBe(false);
    quota=false;silent=true;
    expect(()=>armLegacyCasRetirement({id:p.id,raw},DIGEST))
      .toThrow(/non confermata/);
    expect(cells.has(k)).toBe(false);
  });
  it("requires exact raw and cannot silently re-arm even with identical digest",()=>{
    const p=createProject();persistProject(p);
    const raw=localProjectSnapshot(p.id)!;
    expect(()=>armLegacyCasRetirement({id:p.id,raw:raw+" "},DIGEST))
      .toThrow(/Sorgente legacy cambiata/);
    expect(()=>armLegacyCasRetirement({id:p.id,raw}, "invalid"))
      .toThrow(/non valido/);
    expect(readLegacyCasRetirement(p.id)).toBeNull();
    armLegacyCasRetirement({id:p.id,raw},DIGEST);
    expect(()=>armLegacyCasRetirement({id:p.id,raw},DIGEST))
      .toThrow(/già presente/);
    expect(localProjectSnapshot(p.id)).toBe(raw);
  });
});
