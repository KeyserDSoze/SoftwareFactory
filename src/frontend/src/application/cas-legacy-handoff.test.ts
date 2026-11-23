import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {readCasProjectSlot} from "../infrastructure/project-cas";
import {copyLegacyCasTicket} from "../infrastructure/project-cas-migration";
import {
  prepareLegacyCasHandoff,commitLegacyCasHandoff,
} from "./cas-legacy-handoff";
import {matchesCasHandoffHint} from "./cas-root-workspace";

vi.mock("../infrastructure/project-cas",async original=>{
  const module=await original<typeof import("../infrastructure/project-cas")>();
  return {...module,readCasProjectSlot:vi.fn()};
});
vi.mock("../infrastructure/project-cas-migration",async original=>{
  const module=await original<typeof import("../infrastructure/project-cas-migration")>();
  return {...module,copyLegacyCasTicket:vi.fn()};
});
const mockRead=vi.mocked(readCasProjectSlot);
const mockCopy=vi.mocked(copyLegacyCasTicket);
const prefix="softwarefactory.project.library.v1.";
const entries=new Map<string,string>();
const source=()=>{
  const p=createProject();
  p.config.name="Legacy project for assisted CAS handoff";
  p.config.description="Full stack with only historical evidence";
  const raw=JSON.stringify(p);
  entries.set(prefix+p.id,raw);
  return {p,raw,ticket:{id:p.id,raw}};
};
describe("opt-in legacy→CAS-only assist #171",()=>{
  beforeEach(()=>{
    entries.clear();
    mockRead.mockReset();mockCopy.mockReset();
    vi.stubGlobal("localStorage",{getItem:(key:string)=>
      entries.get(key)??null,setItem:(key:string,value:string)=>entries.set(key,value)});
    mockRead.mockResolvedValue({state:"missing"});
  });
  afterEach(()=>vi.unstubAllGlobals());
  it("requires missing destination and exact unchanged legacy source; read-only",async()=>{
    const {p,raw,ticket}=source();
    expect(await prepareLegacyCasHandoff(p)).toEqual(ticket);
    expect(mockRead).toHaveBeenCalledWith(p.id);
    expect(entries.get(prefix+p.id)).toBe(raw);
    expect(mockCopy).not.toHaveBeenCalled();
    for(const slot of [
      {state:"tombstone",revision:4} as const,
      {state:"present",snapshot:{id:p.id,revision:1,raw}} as const,
    ]){
      mockRead.mockResolvedValue(slot);
      await expect(prepareLegacyCasHandoff(p)).rejects
        .toThrow(/già esistente o eliminato/);
    }
    expect(mockCopy).not.toHaveBeenCalled();
  });
  it("rejects a running checkpoint, malformed stack/secret, stale in-memory raw",async()=>{
    const {p}=source();
    p.stages[0].status="running";
    await expect(prepareLegacyCasHandoff(p)).rejects.toThrow(/non compatibile/);
    p.stages[0].status="pending";
    p.config.frontends=[];
    await expect(prepareLegacyCasHandoff(p)).rejects.toThrow(/non compatibile/);
    p.config.frontends=["react"];
    p.config.description="github_pat_"+"a".repeat(25);
    await expect(prepareLegacyCasHandoff(p)).rejects.toThrow(/non compatibile/);
    p.config.description="saved draft modified in memory but not localStorage";
    await expect(prepareLegacyCasHandoff(p)).rejects.toThrow(/non compatibile/);
    expect(mockCopy).not.toHaveBeenCalled();
  });
  it("refuses consent false or lease lost before any IDB copy",async()=>{
    const {p,ticket}=source();
    const prepared=await prepareLegacyCasHandoff(p);
    expect(prepared).toEqual(ticket);
    await expect(commitLegacyCasHandoff(ticket,false,()=>true))
      .rejects.toThrow(/non autorizzato/);
    await expect(commitLegacyCasHandoff(ticket,true,()=>false))
      .rejects.toThrow(/non autorizzato/);
    expect(mockCopy).not.toHaveBeenCalled();
  });
  it("copies SAME full historical raw only once, verifies IDB and emits digest-only hint",async()=>{
    const {p,raw,ticket}=source();
    p.stages[0].status="complete";
    p.stages[0].output="UNVERIFIED_HISTORICAL_AI_CHECKPOINT";
    p.stages[0].completionOrigin="ai";
    const current=JSON.stringify(p);
    entries.set(prefix+p.id,current);
    const committed={id:p.id,revision:1,raw:current};
    mockCopy.mockImplementation(async()=>{
      const marker=entries.get("softwarefactory.cas.retired.v1."+p.id);
      expect(marker).toBeDefined();
      expect(JSON.parse(marker!).digest).toMatch(/^[0-9a-f]{64}$/);
      return committed;
    });
    mockRead.mockResolvedValueOnce({state:"missing"})
      .mockResolvedValueOnce({state:"present",snapshot:committed});
    const ready=vi.fn(()=>true);
    const result=await commitLegacyCasHandoff({id:p.id,raw:current},
      true,ready);
    expect(result.status).toBe("ready");
    expect(result.hint?.id).toBe(p.id);
    expect(result.hint?.revision).toBe(1);
    expect(result.hint?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await matchesCasHandoffHint(result.hint!,committed)).toBe(true);
    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(mockCopy).toHaveBeenCalledWith({id:p.id,raw:current},true);
    expect(entries.get(prefix+p.id)).toBe(current);
    expect(raw).not.toBe(current);
    expect(result).not.toHaveProperty("raw");
    expect(JSON.stringify(result)).not.toContain("UNVERIFIED_HISTORICAL");
  });
  it("a same-ID rival insert between preflight and final consent must abort",async()=>{
    const {p,ticket,raw}=source();
    mockRead.mockResolvedValue({state:"present",
      snapshot:{id:p.id,revision:1,raw}});
    await expect(commitLegacyCasHandoff(ticket,true,()=>true))
      .rejects.toThrow(/non è libera/);
    expect(mockCopy).not.toHaveBeenCalled();
  });
  it("source changed while awaiting native preflight read aborts before any copy",async()=>{
    const {p,ticket}=source();
    mockRead.mockImplementation(async()=>{
      entries.set(prefix+p.id,JSON.stringify({...p,
        config:{...p.config,name:"RIVAL_WON_171"}}));
      return {state:"missing"};
    });
    await expect(commitLegacyCasHandoff(ticket,true,()=>true))
      .rejects.toThrow(/Sorgente legacy cambiata/);
    expect(mockCopy).not.toHaveBeenCalled();
  });
  it("after acknowledged insert, stale/failing readback is copied_unverified not a false failed write",async()=>{
    const {p,ticket,raw}=source();
    const ack={id:p.id,revision:1,raw};
    mockCopy.mockResolvedValue(ack);
    mockRead.mockResolvedValueOnce({state:"missing"})
      .mockResolvedValueOnce({state:"present",
        snapshot:{...ack,revision:2}});
    expect(await commitLegacyCasHandoff(ticket,true,()=>true))
      .toEqual({status:"copied_unverified",id:p.id,revision:1});
    // Independent second interrupted handoff scenario; one armed ID may
    // NEVER be retried automatically following an ambiguous native ACK.
    entries.delete("softwarefactory.cas.retired.v1."+p.id);
    mockRead.mockReset();mockCopy.mockClear();
    mockRead.mockResolvedValueOnce({state:"missing"})
      .mockRejectedValueOnce(Error("OUTAGE_WITH_SECRET"));
    expect(await commitLegacyCasHandoff(ticket,true,()=>true))
      .toEqual({status:"copied_unverified",id:p.id,revision:1});
    expect(mockCopy).toHaveBeenCalledTimes(1);
  });
  it("quota-denied marker prevents any native IDB insert",async()=>{
    const {p,ticket}=source();
    vi.stubGlobal("localStorage",{
      getItem:(key:string)=>entries.get(key)??null,
      setItem:(key:string,value:string)=>{
        if(key.startsWith("softwarefactory.cas.retired.v1."))
          throw Error("SECRET_QUOTA_NEVER_LOG");
        entries.set(key,value);
      },
    });
    await expect(commitLegacyCasHandoff(ticket,true,()=>true))
      .rejects.toThrow(/Barriera CAS legacy non salvata/);
    expect(mockCopy).not.toHaveBeenCalled();
    expect(entries.get(prefix+p.id)).toBe(ticket.raw);
  });
  it("ambiguous native ACK retains fence and never retries the same source",async()=>{
    const {p,ticket}=source();
    mockCopy.mockRejectedValue(Error("NATIVE_ACK_UNCERTAIN"));
    await expect(commitLegacyCasHandoff(ticket,true,()=>true))
      .rejects.toThrow(/NATIVE_ACK_UNCERTAIN/);
    expect(mockCopy).toHaveBeenCalledTimes(1);
    expect(entries.get("softwarefactory.cas.retired.v1."+p.id))
      .toContain('"schema":1');
    await expect(commitLegacyCasHandoff(ticket,true,()=>true))
      .rejects.toThrow(/già presente/);
    expect(mockCopy).toHaveBeenCalledTimes(1);
  });
  it("no retry when post-consent guard rejects after asynchronous read",async()=>{
    const {p,ticket}=source();
    let calls=0;
    await expect(commitLegacyCasHandoff(ticket,true,()=>++calls<2))
      .rejects.toThrow(/prima della scrittura/);
    expect(mockCopy).not.toHaveBeenCalled();
  });
});
