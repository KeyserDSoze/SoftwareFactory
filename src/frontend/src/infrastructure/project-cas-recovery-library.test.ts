import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import { listCasProjects, readCasProjectSlot } from "./project-cas";
import {
  listCasRecoveryCopies, prepareCasRecoveryTicket, confirmCasRecoveryTicket,
} from "./project-cas-recovery-library";

vi.mock("./project-cas",async original=>{
  const real=await original<typeof import("./project-cas")>();
  return {...real,listCasProjects:vi.fn(),readCasProjectSlot:vi.fn()};
});
const read=vi.mocked(readCasProjectSlot);
const list=vi.mocked(listCasProjects);
const source=()=>{const project=createProject();return {
  project,snapshot:{id:project.id,revision:3,raw:JSON.stringify(project)},
};};

describe("standalone IndexedDB historical recovery (#145)",()=>{
  beforeEach(()=>{read.mockReset();list.mockReset();});

  it("lists only IndexedDB, never touches corrupt/missing legacy storage",async()=>{
    const {snapshot}=source();
    const choices=[{id:snapshot.id,revision:3,name:"Recovered",updatedAt:"2026-11-21T10:00:00Z",repository:""}];
    list.mockResolvedValue(choices);
    vi.stubGlobal("localStorage",{
      getItem:vi.fn(()=>{throw Error("BROKEN_LEGACY_SOURCE");}),
      setItem:vi.fn(()=>{throw Error("WRITE_FORBIDDEN");}),
    });
    await expect(listCasRecoveryCopies()).resolves.toEqual(choices);
    read.mockResolvedValue({state:"present",snapshot});
    const ticket=await prepareCasRecoveryTicket(snapshot.id,3);
    await expect(confirmCasRecoveryTicket(ticket,true)).resolves.toBe(snapshot.raw);
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("propagates IDB failures rather than treating them as empty library",async()=>{
    list.mockRejectedValueOnce(Error("IndexedDB non disponibile"));
    await expect(listCasRecoveryCopies()).rejects.toThrow(/IndexedDB non disponibile/);
    const {snapshot}=source();
    read.mockRejectedValueOnce(Error("Archivio IndexedDB locale corrotto"));
    await expect(prepareCasRecoveryTicket(snapshot.id,3)).rejects.toThrow(/corrotto/);
  });

  it("rejects stale list revision, missing and tombstone without export",async()=>{
    const {snapshot}=source();
    read.mockResolvedValue({state:"present",snapshot});
    await expect(prepareCasRecoveryTicket(snapshot.id,2)).rejects.toThrow(/cambiata/);
    read.mockResolvedValue({state:"missing"});
    await expect(prepareCasRecoveryTicket(snapshot.id,3)).rejects.toThrow(/cambiata/);
    read.mockResolvedValue({state:"tombstone",revision:4});
    await expect(prepareCasRecoveryTicket(snapshot.id,3)).rejects.toThrow(/cambiata/);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("refuses noncanonical IDB rows even if core row schema is otherwise valid",async()=>{
    const {project,snapshot}=source();
    read.mockResolvedValue({state:"present",snapshot:{...snapshot,raw:
      JSON.stringify(project,null,2)}});
    await expect(prepareCasRecoveryTicket(project.id,3)).rejects.toThrow(/non canonica/);
  });

  it("requires consent and rechecks revision AND raw after confirmation",async()=>{
    const {snapshot}=source();
    read.mockResolvedValue({state:"present",snapshot});
    const ticket=await prepareCasRecoveryTicket(snapshot.id,3);
    read.mockClear();
    await expect(confirmCasRecoveryTicket(ticket,false)).rejects.toThrow(/Consenso/);
    expect(read).not.toHaveBeenCalled();
    read.mockResolvedValueOnce({state:"present",snapshot})
      .mockResolvedValueOnce({state:"present",snapshot:{...snapshot,raw:
        JSON.stringify({...JSON.parse(snapshot.raw),config:{name:"mutated"}})}});
    await expect(confirmCasRecoveryTicket(ticket,true)).rejects.toThrow(/cambiata/);
    read.mockReset();
    read.mockResolvedValue({state:"present",snapshot});
    await expect(confirmCasRecoveryTicket(ticket,true)).resolves.toBe(snapshot.raw);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("rejects a same-revision adversarial raw change before export",async()=>{
    const {project,snapshot}=source();
    read.mockResolvedValue({state:"present",snapshot});
    const ticket=await prepareCasRecoveryTicket(snapshot.id,3);
    const replaced={...snapshot,raw:JSON.stringify({
      ...project,config:{...project.config,name:"noncooperating writer"},
    })};
    read.mockResolvedValue({state:"present",snapshot:replaced});
    await expect(confirmCasRecoveryTicket(ticket,true)).rejects.toThrow(/cambiata/);
  });

  it("fails with invalid prepared tickets without attempting an IDB read",async()=>{
    const {snapshot}=source();
    await expect(confirmCasRecoveryTicket({...snapshot,revision:0},true)).rejects.toThrow(/Ticket/);
    await expect(confirmCasRecoveryTicket({...snapshot,raw:"broken"},true)).rejects.toThrow(/non canonica/);
    await expect(prepareCasRecoveryTicket(snapshot.id,0)).rejects.toThrow(/Revisione/);
    expect(read).not.toHaveBeenCalled();
  });
});
