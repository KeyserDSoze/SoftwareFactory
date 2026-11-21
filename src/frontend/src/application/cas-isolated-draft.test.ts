import {describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {hasCasIsolatedUnsavedDraft} from "./cas-isolated-draft";

function setup(){
  const p=createProject();
  p.config.name="Original";
  p.config.description="Brief";
  p.config.requirements="Required";
  return {p,selected:{id:p.id,revision:1,raw:JSON.stringify(p)}};
}

describe("isolated CAS unsaved draft safety (#154)",()=>{
  it("keeps the selected snapshot clean when all three fields are unchanged",()=>{
    const {selected}=setup();
    expect(hasCasIsolatedUnsavedDraft(selected,"Original","Brief","Required"))
      .toBe(false);
    expect(hasCasIsolatedUnsavedDraft(null,"anything","anything","anything"))
      .toBe(false);
  });

  it("detects every changed field, including requirements only",()=>{
    const {selected}=setup();
    expect(hasCasIsolatedUnsavedDraft(selected,"Changed","Brief","Required"))
      .toBe(true);
    expect(hasCasIsolatedUnsavedDraft(selected,"Original","Changed","Required"))
      .toBe(true);
    expect(hasCasIsolatedUnsavedDraft(selected,"Original","Brief","Changed"))
      .toBe(true);
  });

  it("accepts only missing historical optional fields as empty, never malformed types",()=>{
    const {p}=setup();
    const history={...p,config:{name:"Original"}};
    const raw=JSON.stringify(history);
    expect(hasCasIsolatedUnsavedDraft(
      {id:p.id,revision:1,raw},"Original","","",
    )).toBe(false);
    for(const value of [null,42,{},[]]){
      for(const field of ["description","requirements"]){
        const config={...history.config,[field]:value};
        const malformed=JSON.stringify({...history,config});
        expect(hasCasIsolatedUnsavedDraft(
          {id:p.id,revision:1,raw:malformed},"Original","","",
        )).toBe(true);
      }
    }
  });

  it("fails closed for corrupted, noncanonical or wrong-ID snapshots",()=>{
    const {p,selected}=setup();
    for(const candidate of [
      {...selected,raw:"{not JSON"},
      {...selected,raw:selected.raw+" "},
      {...selected,id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},
      {...selected,raw:JSON.stringify({...p,config:null})},
    ]){
      expect(hasCasIsolatedUnsavedDraft(candidate,
        "Original","Brief","Required")).toBe(true);
    }
  });

  it("does not read or mutate browser storage",()=>{
    const {selected}=setup();
    const forbidden=vi.fn(()=>{throw Error("Storage access forbidden");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    try{
      expect(hasCasIsolatedUnsavedDraft(selected,
        "Original","Brief","unsaved requirements")).toBe(true);
      expect(forbidden).not.toHaveBeenCalled();
    }finally{
      vi.unstubAllGlobals();
    }
  });
});
