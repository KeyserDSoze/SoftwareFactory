import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {
  prepareCasIsolatedNewProject,confirmCasIsolatedNewProject,
  verifyCasIsolatedCreatedReadback,
} from "./cas-isolated-create";
import {compareAndSwapCasProject} from "../infrastructure/project-cas";
import {CAS_ISOLATED_NAME_MAX,CAS_ISOLATED_DESCRIPTION_MAX} from "./cas-isolated-config";
import {STAGES} from "../domain/defaults";

vi.mock("../infrastructure/project-cas",async importOriginal=>{
  const original=await importOriginal<typeof import("../infrastructure/project-cas")>();
  return {...original,compareAndSwapCasProject:vi.fn()};
});
const insert=vi.mocked(compareAndSwapCasProject);

describe("standalone IDB-only project create ticket (#150)",()=>{
  beforeEach(()=>insert.mockReset());
  afterEach(()=>vi.unstubAllGlobals());

  it("produces canonical, complete new project without old AI, GitHub or runner evidence",()=>{
    const ticket=prepareCasIsolatedNewProject("Fresh IDB","Independent brief");
    const p=JSON.parse(ticket.raw);
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(ticket.id).toBe(p.id);
    expect(ticket.name).toBe("Fresh IDB");
    expect(p.config.description).toBe("Independent brief");
    expect(p.createdAt).toBe(p.updatedAt);
    expect(p.githubDestination).toBeUndefined();
    expect(p.githubSync).toBeUndefined();
    expect(p.development).toBeUndefined();
    expect(p.stages.length).toBe(STAGES.length);
    expect(p.stages.every((s:{status:string;output:string;sources:unknown[]})=>
      s.status==="pending" && s.output==="" && s.sources.length===0)).toBe(true);
  });

  it("rejects invalid name, size, description and tampered prepared ticket",async()=>{
    expect(()=>prepareCasIsolatedNewProject(" ","")).toThrow(/non validi/);
    expect(()=>prepareCasIsolatedNewProject("x".repeat(CAS_ISOLATED_NAME_MAX+1),""))
      .toThrow(/non validi/);
    expect(()=>prepareCasIsolatedNewProject("name",
      "x".repeat(CAS_ISOLATED_DESCRIPTION_MAX+1))).toThrow(/non validi/);
    const ticket=prepareCasIsolatedNewProject("Valid","Description");
    await expect(confirmCasIsolatedNewProject({...ticket,id:"wrong"},true))
      .rejects.toThrow(/non canonico/);
    const forged=JSON.parse(ticket.raw);
    forged.githubSync={lastCommit:"NOT_A_REAL_REVIEW"};
    await expect(confirmCasIsolatedNewProject({...ticket,raw:JSON.stringify(forged)},true))
      .rejects.toThrow(/non canonico/);
    await expect(confirmCasIsolatedNewProject({...ticket,raw:"broken"},true))
      .rejects.toThrow(/non canonico/);
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses without consent before IndexedDB access",async()=>{
    const ticket=prepareCasIsolatedNewProject("Consent","Required");
    await expect(confirmCasIsolatedNewProject(ticket,false)).rejects.toThrow(/Conferma/);
    expect(insert).not.toHaveBeenCalled();
  });

  it("writes exactly one never-seen CAS insert and acknowledges only matching result",async()=>{
    const ticket=prepareCasIsolatedNewProject("Confirm","New");
    insert.mockResolvedValueOnce({id:ticket.id,revision:1,raw:ticket.raw});
    const done=await confirmCasIsolatedNewProject(ticket,true);
    expect(done).toEqual({id:ticket.id,revision:1,raw:ticket.raw});
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(JSON.parse(ticket.raw),null);
    insert.mockResolvedValueOnce({id:ticket.id,revision:2,raw:ticket.raw});
    await expect(confirmCasIsolatedNewProject(ticket,true)).rejects.toThrow(/incoerente/);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("separates confirmed create from later failed, stale or unavailable readback (#153)",async()=>{
    const ticket=prepareCasIsolatedNewProject("Committed","Read failure after ACK");
    const acknowledged={id:ticket.id,revision:1,raw:ticket.raw};
    insert.mockResolvedValueOnce(acknowledged);
    const completed=await confirmCasIsolatedNewProject(ticket,true);
    const same=vi.fn(async()=>({...completed}));
    expect(await verifyCasIsolatedCreatedReadback(completed,same)).toBe(true);
    expect(same).toHaveBeenCalledWith(ticket.id);
    for(const changed of [
      {...completed,revision:2},
      {...completed,raw:completed.raw+" "},
      {...completed,id:"a0000000-0000-4000-8000-000000000000"},
      null,
    ]){
      const reader=vi.fn(async()=>changed as typeof completed);
      expect(await verifyCasIsolatedCreatedReadback(completed,reader)).toBe(false);
    }
    const unavailable=vi.fn(async():Promise<typeof completed>=>{
      throw Error("IndexedDB versionchange / blocked");
    });
    expect(await verifyCasIsolatedCreatedReadback(completed,unavailable)).toBe(false);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("never falls back to localStorage on missing IDB, quota or ambiguous ACK",async()=>{
    const ticket=prepareCasIsolatedNewProject("No fallback","New");
    const local=vi.fn(()=>{throw Error("legacy forbidden");});
    vi.stubGlobal("localStorage",{getItem:local,setItem:local});
    insert.mockRejectedValueOnce(Error("IndexedDB non disponibile"))
      .mockRejectedValueOnce(Error("QuotaExceededError"));
    await expect(confirmCasIsolatedNewProject(ticket,true))
      .rejects.toThrow(/non disponibile/);
    await expect(confirmCasIsolatedNewProject(ticket,true))
      .rejects.toThrow(/QuotaExceeded/);
    expect(local).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
