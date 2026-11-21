import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {prepareCasRecoveryTicket,confirmCasRecoveryTicket}
  from "../infrastructure/project-cas-recovery-library";
import {
  prepareCasIsolatedExport,confirmCasIsolatedExport,
} from "./cas-isolated-export";

vi.mock("../infrastructure/project-cas-recovery-library",()=>({
  prepareCasRecoveryTicket:vi.fn(),
  confirmCasRecoveryTicket:vi.fn(),
}));
const prepareNative=vi.mocked(prepareCasRecoveryTicket);
const confirmNative=vi.mocked(confirmCasRecoveryTicket);

function fixture(){
  const p=createProject();p.config.name="Backup test";
  p.stages[0].output="Existing AI checkpoint <img src=x onerror=alert(1)>";
  p.stages[0].status="complete";
  const snapshot={id:p.id,revision:4,raw:JSON.stringify(p)};
  return {p,snapshot};
}
describe("selected IndexedDB full snapshot export (#159)",()=>{
  beforeEach(()=>{prepareNative.mockReset();confirmNative.mockReset();});
  afterEach(()=>vi.unstubAllGlobals());
  it("prepares immutable canonical exact raw and filename without any I/O",()=>{
    const {snapshot}=fixture();
    const fail=vi.fn(()=>{throw Error("FORBIDDEN_STORAGE");});
    vi.stubGlobal("localStorage",{getItem:fail,setItem:fail});
    vi.stubGlobal("indexedDB",{open:fail});
    const ticket=prepareCasIsolatedExport(snapshot);
    expect(ticket).toEqual({...snapshot,fileName:
      "softwarefactory-idb-project-"+snapshot.id+"-r4.json"});
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(ticket.raw).toBe(snapshot.raw);
    expect(ticket.raw).toContain("Existing AI checkpoint");
    expect(fail).not.toHaveBeenCalled();
    expect(prepareNative).not.toHaveBeenCalled();
    expect(confirmNative).not.toHaveBeenCalled();
  });
  it("refuses forged/noncanonical snapshot, revision, id and filename",async()=>{
    const {p,snapshot}=fixture();
    for(const candidate of [
      {...snapshot,id:"other"},
      {...snapshot,revision:0},
      {...snapshot,revision:Number.MAX_SAFE_INTEGER},
      {...snapshot,raw:snapshot.raw+" "},
      {...snapshot,raw:"{"},
      {...snapshot,raw:JSON.stringify({...p,id:"bad-path"})},
    ])
      expect(()=>prepareCasIsolatedExport(candidate)).toThrow();
    const t=prepareCasIsolatedExport(snapshot);
    await expect(confirmCasIsolatedExport({...t,fileName:"../../secret"},true))
      .rejects.toThrow(/Nome file/);
    expect(prepareNative).not.toHaveBeenCalled();
    expect(confirmNative).not.toHaveBeenCalled();
  });
  it("refuses consent before any IDB read and rechecks exact token",async()=>{
    const {snapshot}=fixture();
    const ticket=prepareCasIsolatedExport(snapshot);
    await expect(confirmCasIsolatedExport(ticket,false))
      .rejects.toThrow(/Consenso/);
    expect(prepareNative).not.toHaveBeenCalled();
    prepareNative.mockResolvedValue(snapshot);
    confirmNative.mockResolvedValue(snapshot.raw);
    await expect(confirmCasIsolatedExport(ticket,true))
      .resolves.toBe(snapshot.raw);
    expect(prepareNative).toHaveBeenCalledWith(snapshot.id,4);
    expect(confirmNative).toHaveBeenCalledWith(snapshot,true);
  });
  it("fails closed on rival raw or revision and does not export/retry",async()=>{
    const {snapshot,p}=fixture();
    const t=prepareCasIsolatedExport(snapshot);
    prepareNative.mockResolvedValueOnce({...snapshot,
      raw:JSON.stringify({...p,config:{...p.config,name:"Rival"}})});
    await expect(confirmCasIsolatedExport(t,true)).rejects.toThrow(/cambiata/);
    expect(confirmNative).not.toHaveBeenCalled();
    prepareNative.mockResolvedValueOnce({...snapshot,revision:5});
    await expect(confirmCasIsolatedExport(t,true)).rejects.toThrow(/cambiata/);
    expect(confirmNative).not.toHaveBeenCalled();
    prepareNative.mockRejectedValueOnce(Error("IDB unavailable"));
    await expect(confirmCasIsolatedExport(t,true))
      .rejects.toThrow(/IDB unavailable/);
    expect(confirmNative).not.toHaveBeenCalled();
    expect(prepareNative).toHaveBeenCalledTimes(3);
  });
  it("propagates post-consent native second/third readback conflict",async()=>{
    const {snapshot}=fixture(),t=prepareCasIsolatedExport(snapshot);
    prepareNative.mockResolvedValue(snapshot);
    confirmNative.mockRejectedValue(Error("Tombstone or rival CAS winner"));
    await expect(confirmCasIsolatedExport(t,true))
      .rejects.toThrow(/Tombstone/);
    expect(confirmNative).toHaveBeenCalledTimes(1);
  });
});
