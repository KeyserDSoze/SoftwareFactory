import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {prepareCasTombstoneRestore,confirmCasTombstoneRestore} from "../infrastructure/project-cas-lifecycle";
import {
  prepareCasIsolatedTombstoneRestore,confirmCasIsolatedTombstoneRestore,
} from "./cas-isolated-tombstone-restore";

vi.mock("../infrastructure/project-cas-lifecycle",()=>({
  prepareCasTombstoneRestore:vi.fn(),
  confirmCasTombstoneRestore:vi.fn(),
}));
const prepareNative=vi.mocked(prepareCasTombstoneRestore);
const confirmNative=vi.mocked(confirmCasTombstoneRestore);
function fixture(){
  const project=createProject();
  project.config.name="Historical project";
  const raw=JSON.stringify(project);
  return {project,raw,tombstone:{id:project.id,revision:4}};
}
describe("CAS-only explicit tombstone restore #179",()=>{
  beforeEach(()=>{prepareNative.mockReset();confirmNative.mockReset();});
  afterEach(()=>vi.unstubAllGlobals());
  it("prepares exact raw only after a native tombstone lookup, no writes",async()=>{
    const f=fixture();
    prepareNative.mockResolvedValueOnce({raw:f.raw,tombstone:f.tombstone});
    const ticket=await prepareCasIsolatedTombstoneRestore(f.raw);
    expect(ticket).toEqual({id:f.project.id,name:f.project.config.name,raw:f.raw,tombstone:f.tombstone});
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(Object.isFrozen(ticket.tombstone)).toBe(true);
    expect(prepareNative).toHaveBeenCalledWith(f.project.id,f.raw);
    expect(confirmNative).not.toHaveBeenCalled();
  });
  it("accepts envelope v1 without reinterpreting it as CAS revision",async()=>{
    const f=fixture();
    prepareNative.mockResolvedValueOnce({raw:f.raw,tombstone:f.tombstone});
    const backup=JSON.stringify({kind:"softwarefactory-local-recovery",
      schemaVersion:1,exportedAt:"2026-11-23T12:00:00Z",project:f.project});
    const ticket=await prepareCasIsolatedTombstoneRestore(backup);
    expect(ticket.raw).toBe(f.raw);
    expect(ticket.tombstone.revision).toBe(4);
  });
  it("rejects invalid files and oversize before reading native store",async()=>{
    for(const input of ["","not-json","{}","x".repeat(1_500_001),
      JSON.stringify({kind:"unknown",schemaVersion:1,project:createProject()})])
      await expect(prepareCasIsolatedTombstoneRestore(input)).rejects.toThrow();
    expect(prepareNative).not.toHaveBeenCalled();
  });
  it("blocks absent/current project, unavailable IDB, or unknown tombstone",async()=>{
    const f=fixture();
    prepareNative.mockRejectedValueOnce(Error("tombstone missing"))
      .mockRejectedValueOnce(Error("native unavailable"));
    await expect(prepareCasIsolatedTombstoneRestore(f.raw)).rejects.toThrow(/missing/);
    await expect(prepareCasIsolatedTombstoneRestore(f.raw)).rejects.toThrow(/unavailable/);
    expect(confirmNative).not.toHaveBeenCalled();
  });
  it("requires consent and verifies ticket BEFORE any native write",async()=>{
    const f=fixture(),t={id:f.project.id,name:f.project.config.name,raw:f.raw,tombstone:f.tombstone};
    await expect(confirmCasIsolatedTombstoneRestore(t,false)).rejects.toThrow(/Consenso/);
    for(const changed of [
      {...t,id:"invalid"},
      {...t,name:"wrong"},
      {...t,raw:f.raw+" "},
      {...t,tombstone:{...f.tombstone,id:"invalid"}},
      {...t,tombstone:{...f.tombstone,revision:0}},
    ])await expect(confirmCasIsolatedTombstoneRestore(changed,true)).rejects.toThrow();
    expect(confirmNative).not.toHaveBeenCalled();
  });
  it("returns exact ACK and flags ambiguous results",async()=>{
    const f=fixture(),t={id:f.project.id,name:f.project.config.name,raw:f.raw,tombstone:f.tombstone};
    confirmNative.mockResolvedValueOnce({id:f.project.id,revision:5,raw:f.raw});
    await expect(confirmCasIsolatedTombstoneRestore(t,true))
      .resolves.toEqual({id:f.project.id,revision:5,raw:f.raw});
    expect(confirmNative).toHaveBeenCalledWith({raw:f.raw,tombstone:f.tombstone},true);
    confirmNative.mockResolvedValueOnce({id:f.project.id,revision:7,raw:f.raw});
    await expect(confirmCasIsolatedTombstoneRestore(t,true)).rejects.toThrow(/ambiguo/);
  });
  it("propagates a rival-tab stale tombstone, never retries or touches legacy/cloud",async()=>{
    const f=fixture(),t={id:f.project.id,name:f.project.config.name,raw:f.raw,tombstone:f.tombstone};
    const forbidden=vi.fn(()=>{throw Error("FORBIDDEN_EXTERNAL_IO");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("fetch",forbidden);
    confirmNative.mockRejectedValueOnce(Error("stale native tombstone"));
    await expect(confirmCasIsolatedTombstoneRestore(t,true))
      .rejects.toThrow(/stale/);
    expect(confirmNative).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
