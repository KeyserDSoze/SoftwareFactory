import {beforeEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {readCasProjectSlot,restoreCasTombstoneProject} from "./project-cas";
import {prepareCasTombstoneRestore,confirmCasTombstoneRestore} from "./project-cas-lifecycle";

vi.mock("./project-cas",async importOriginal=>{
  const original=await importOriginal<typeof import("./project-cas")>();
  return {...original,readCasProjectSlot:vi.fn(),restoreCasTombstoneProject:vi.fn()};
});
const read=vi.mocked(readCasProjectSlot);
const restore=vi.mocked(restoreCasTombstoneProject);
function fixture(){
  const project=createProject(),raw=JSON.stringify(project);
  return {project,raw,tombstone:{id:project.id,revision:2}};
}

describe("intentional tombstone restore with exact backup (#146)",()=>{
  beforeEach(()=>{read.mockReset();restore.mockReset();});

  it("rejects mismatched backup, malformed JSON, absent tombstone and live rows",async()=>{
    const {project,raw}=fixture();
    await expect(prepareCasTombstoneRestore(project.id,"{bad")).rejects.toThrow(/Backup JSON/);
    await expect(prepareCasTombstoneRestore("../invalid",raw)).rejects.toThrow(/Backup JSON/);
    read.mockResolvedValueOnce({state:"missing"})
      .mockResolvedValueOnce({state:"present",snapshot:{id:project.id,raw,revision:1}});
    await expect(prepareCasTombstoneRestore(project.id,raw)).rejects.toThrow(/tombstone assente/);
    await expect(prepareCasTombstoneRestore(project.id,raw)).rejects.toThrow(/tombstone assente/);
    expect(restore).not.toHaveBeenCalled();
  });

  it("validates ticket before consent and refuses a stale tombstone after consent",async()=>{
    const {project,raw,tombstone}=fixture();
    read.mockResolvedValueOnce({state:"tombstone",revision:2})
      .mockResolvedValueOnce({state:"tombstone",revision:3});
    const ticket=await prepareCasTombstoneRestore(project.id,raw);
    expect(ticket).toEqual({tombstone,raw});
    await expect(confirmCasTombstoneRestore(ticket,false)).rejects.toThrow(/Conferma/);
    await expect(confirmCasTombstoneRestore(ticket,true)).rejects.toThrow(/cambiata/);
    expect(restore).not.toHaveBeenCalled();
  });

  it("passes unchanged full backup only after explicit consent and current tombstone",async()=>{
    const {project,raw,tombstone}=fixture();
    read.mockResolvedValue({state:"tombstone",revision:2});
    const ticket=await prepareCasTombstoneRestore(project.id,raw);
    restore.mockResolvedValue({id:project.id,revision:3,raw});
    await expect(confirmCasTombstoneRestore(ticket,true)).resolves.toEqual({
      id:project.id,revision:3,raw,
    });
    expect(restore).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledWith(project,tombstone,raw,true);
  });

  it("never reads/writes localStorage, fails closed on missing DB and does not rebase",async()=>{
    const {project,raw}=fixture();
    const local=vi.fn(()=>{throw Error("SECRET_LEGACY");});
    vi.stubGlobal("localStorage",{getItem:local,setItem:local});
    read.mockRejectedValue(Error("IndexedDB non disponibile"));
    await expect(prepareCasTombstoneRestore(project.id,raw))
      .rejects.toThrow(/IndexedDB non disponibile/);
    expect(local).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("validates an unexpected forged ticket before entering IndexedDB",async()=>{
    const {project,raw,tombstone}=fixture();
    await expect(confirmCasTombstoneRestore({
      tombstone:{...tombstone,revision:0},raw,
    },true)).rejects.toThrow(/Revisione/);
    await expect(confirmCasTombstoneRestore({
      tombstone,raw:"invalid",
    },true)).rejects.toThrow(/Backup JSON/);
    expect(read).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });
});
