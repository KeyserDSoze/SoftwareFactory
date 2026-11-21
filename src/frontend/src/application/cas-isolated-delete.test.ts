import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {prepareCasIsolatedDelete} from "./cas-isolated-delete";

function fixture(){
  const p=createProject();
  p.config.name="Historical IDB project";
  p.config.description="Old checkpoints must be backed up";
  p.stages[0].output="HISTORICAL_NOT_CURRENT";
  const raw=JSON.stringify(p);
  return {p,snapshot:{id:p.id,revision:4,raw}};
}

describe("isolated CAS delete preflight (#151)",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("pins exact revision and backup raw, without losing AI evidence",()=>{
    const {p,snapshot}=fixture();
    const ticket=prepareCasIsolatedDelete(
      snapshot,snapshot,p.config.name,p.config.description,
    );
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(ticket).toEqual({
      id:p.id,revision:4,raw:snapshot.raw,name:p.config.name,
      fileName:"softwarefactory-cas-before-delete-"+p.id+"-r4.json",
    });
    expect(JSON.parse(ticket.raw).stages[0].output)
      .toBe("HISTORICAL_NOT_CURRENT");
  });
  it("rejects a stale revision/raw/id or unsaved draft",()=>{
    const {p,snapshot}=fixture();
    for(const stale of [
      {...snapshot,revision:3},
      {...snapshot,raw:snapshot.raw+" "},
      {...snapshot,id:"00000000-0000-4000-8000-000000000000"},
    ]){
      expect(()=>prepareCasIsolatedDelete(
        snapshot,stale,p.config.name,p.config.description,
      )).toThrow(/obsoleto/);
    }
    expect(()=>prepareCasIsolatedDelete(snapshot,snapshot,"Edited",p.config.description))
      .toThrow(/non salvata/);
    expect(()=>prepareCasIsolatedDelete(snapshot,snapshot,p.config.name,"Edited"))
      .toThrow(/non salvata/);
    expect(()=>prepareCasIsolatedDelete(
      {...snapshot,raw:"broken"}, {...snapshot,raw:"broken"},
      p.config.name,p.config.description,
    )).toThrow(/non canonico/);
  });
  it("never accesses IndexedDB/localStorage during preflight",()=>{
    const {p,snapshot}=fixture();
    const forbidden=vi.fn(()=>{throw Error("NO_STORAGE");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    prepareCasIsolatedDelete(snapshot,snapshot,p.config.name,p.config.description);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
