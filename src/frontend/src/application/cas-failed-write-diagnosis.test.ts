import {afterEach,describe,expect,it,vi} from "vitest";
import {STAGES} from "../domain/defaults";
import {createProject} from "../domain/defaults";
import type {CasProjectSlot} from "../infrastructure/project-cas";
import {
  inspectCasFailedWrite,prepareCasFailedWriteTicket,
  prepareCasFailedWriteBackup,CAS_FAILED_WRITE_BACKUP_FORMAT,
  MAX_CAS_FAILED_WRITE_BACKUP_BYTES,
} from "./cas-failed-write-diagnosis";
function fixture(){
  const p=createProject();p.config.name="Pinned writer 197";
  const old={id:p.id,revision:5,raw:JSON.stringify(p)};
  const candidate={...p,config:{...p.config,name:"Attempt from tab A"}};
  const ticket=prepareCasFailedWriteTicket(old,candidate);
  const rival={...ticket.proposed,raw:JSON.stringify({
    ...candidate,config:{...candidate.config,name:"Rival wins"}})};
  return {old,candidate,ticket,rival};
}
describe("native CAS failed write diagnosis #197",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("pins exact canonical bytes and advances proposed revision only in memory",()=>{
    const {old,candidate,ticket}=fixture();
    expect(ticket).toEqual({old,proposed:{
      id:old.id,revision:6,raw:JSON.stringify(candidate),
    }});
    expect(Object.isFrozen(ticket.old)).toBe(true);
    expect(Object.isFrozen(ticket.proposed)).toBe(true);
    candidate.config.name="caller-mutated-after";
    expect(ticket.proposed.raw).not.toContain("caller-mutated-after");
  });
  it("distinguishes unchanged and candidate-present without claiming a writer ACK",async()=>{
    const {ticket}=fixture();
    const read=vi.fn(async():Promise<CasProjectSlot>=>({
      state:"present",snapshot:ticket.old,
    }));
    expect(await inspectCasFailedWrite(ticket,read)).toEqual({
      state:"unchanged",observedRevision:5,
    });
    expect(read).toHaveBeenCalledWith(ticket.old.id);
    const observed=await inspectCasFailedWrite(ticket,async()=>({
      state:"present",snapshot:ticket.proposed,
    }));
    expect(observed).toEqual({
      state:"candidate_present",observedRevision:6,
    });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(observed).not.toHaveProperty("committedByCurrentTab");
  });
  it("reports a rival, tombstone and missing ID independently",async()=>{
    const {ticket,rival}=fixture();
    expect(await inspectCasFailedWrite(ticket,async()=>({
      state:"present",snapshot:rival,
    }))).toEqual({state:"diverged",observedRevision:6});
    expect(await inspectCasFailedWrite(ticket,async()=>({
      state:"present",snapshot:{...rival,revision:7},
    }))).toEqual({state:"diverged",observedRevision:7});
    expect(await inspectCasFailedWrite(ticket,async()=>({
      state:"tombstone",revision:7,
    }))).toEqual({state:"tombstone",observedRevision:7});
    expect(await inspectCasFailedWrite(ticket,async()=>({
      state:"missing",
    }))).toEqual({state:"missing",observedRevision:null});
  });
  it("rejects stale/corrupted tickets and impossible native revisions",async()=>{
    const {old,candidate,ticket,rival}=fixture();
    for(const bad of [
      {...ticket,old:{...old,revision:0}},
      {...ticket,old:{...old,raw:old.raw+" "}},
      {...ticket,proposed:{...ticket.proposed,id:createProject().id}},
      {...ticket,proposed:{...ticket.proposed,revision:5}},
      {...ticket,proposed:{...ticket.proposed,raw:old.raw}},
      {...ticket,proposed:{...ticket.proposed,raw:ticket.proposed.raw+" "}},
    ])await expect(inspectCasFailedWrite(bad)).rejects.toThrow();
    expect(()=>prepareCasFailedWriteTicket(
      {...old,revision:Number.MAX_SAFE_INTEGER-1},candidate,
    )).toThrow();
    expect(()=>prepareCasFailedWriteTicket(old,{
      ...candidate,id:createProject().id,
    })).toThrow();
    for(const s of [
      {state:"present",snapshot:{...rival,revision:5}},
      {state:"present",snapshot:{...rival,revision:4}},
      {state:"present",snapshot:{...rival,id:createProject().id}},
      {state:"present",snapshot:{...rival,raw:rival.raw+" "}},
      {state:"tombstone",revision:5},
    ] as CasProjectSlot[])
      await expect(inspectCasFailedWrite(ticket,async()=>s))
        .rejects.toThrow();
  });
  it("never touches storage, network, localStorage or session credentials",async()=>{
    const {ticket}=fixture();
    const deny=vi.fn(()=>{throw Error("FORBIDDEN_ACCESS");});
    vi.stubGlobal("indexedDB",{open:deny});
    vi.stubGlobal("localStorage",{getItem:deny,setItem:deny});
    vi.stubGlobal("sessionStorage",{getItem:deny,setItem:deny});
    vi.stubGlobal("fetch",deny);
    expect(await inspectCasFailedWrite(ticket,async()=>({
      state:"present",snapshot:ticket.proposed,
    }))).toMatchObject({state:"candidate_present"});
    expect(deny).not.toHaveBeenCalled();
  });
  it("does not convert read exceptions into unchanged or success",async()=>{
    const {ticket}=fixture();
    await expect(inspectCasFailedWrite(ticket,async()=>{
      throw Error("Native store unavailable");
    })).rejects.toThrow(/unavailable/);
  });
});


describe("CAS unconfirmed-write voluntary offline backup #199",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("exports exact old/proposed bytes as explicit non-authoritative data",()=>{
    const {ticket}=fixture();
    const result=prepareCasFailedWriteBackup(ticket,{
      operation:"complete",stage:STAGES[0].id,
    });
    const envelope=JSON.parse(result.raw);
    expect(envelope).toEqual({
      format:CAS_FAILED_WRITE_BACKUP_FORMAT,schemaVersion:1,
      authoritative:false,automaticRestore:false,unconfirmed:true,
      warning:expect.stringContaining("PLAINTEXT"),
      operation:"complete",stage:STAGES[0].id,
      old:ticket.old,proposed:ticket.proposed,
    });
    expect(envelope.old.raw).toBe(ticket.old.raw);
    expect(envelope.proposed.raw).toBe(ticket.proposed.raw);
    expect(result.fileName).toBe("softwarefactory-cas-unconfirmed-"+
      ticket.old.id+"-r5-to-r6.json");
    expect(new TextEncoder().encode(result.raw).byteLength)
      .toBeLessThanOrEqual(MAX_CAS_FAILED_WRITE_BACKUP_BYTES);
    expect(Object.isFrozen(result)).toBe(true);
    expect(prepareCasFailedWriteBackup(ticket,{
      operation:"editor",stage:null,
    }).raw).toContain('"operation": "editor"');
  });
  it("fails closed on missing, malformed and contradictory context/ticket",()=>{
    const {ticket}=fixture();
    for(const context of [
      {operation:"editor",stage:STAGES[0].id},
      {operation:"begin",stage:null},
      {operation:"complete",stage:"fake-stage"},
      {operation:"approve",stage:null},
      null,
    ])expect(()=>prepareCasFailedWriteBackup(ticket,context as never))
      .toThrow();
    for(const bad of [
      {...ticket,proposed:{...ticket.proposed,revision:7}},
      {...ticket,proposed:{...ticket.proposed,raw:ticket.old.raw}},
      {...ticket,old:{...ticket.old,raw:ticket.old.raw+" "}},
      {...ticket,old:{...ticket.old,id:"../unsafe"}},
    ])expect(()=>prepareCasFailedWriteBackup(bad,{
      operation:"editor",stage:null,
    })).toThrow();
  });
  it("never touches native IDB, legacy storage, session secrets or network",()=>{
    const {ticket}=fixture();
    const deny=vi.fn(()=>{throw Error("FORBIDDEN_IO");});
    vi.stubGlobal("indexedDB",{open:deny});
    vi.stubGlobal("localStorage",{getItem:deny,setItem:deny});
    vi.stubGlobal("sessionStorage",{getItem:deny,setItem:deny});
    vi.stubGlobal("fetch",deny);
    const backup=prepareCasFailedWriteBackup(ticket,{
      operation:"abort",stage:STAGES[0].id,
    });
    expect(JSON.parse(backup.raw).unconfirmed).toBe(true);
    expect(deny).not.toHaveBeenCalled();
  });
});
