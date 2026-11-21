import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import { compareAndSwapCasProject, readCasProjectSlot } from "./project-cas";
import { openCasEditorSession } from "./project-cas-editor-session";

vi.mock("./project-cas",async getActual=>{
  const original=await getActual<typeof import("./project-cas")>();
  return {...original,compareAndSwapCasProject:vi.fn(),readCasProjectSlot:vi.fn()};
});
const load=vi.mocked(readCasProjectSlot);
const cas=vi.mocked(compareAndSwapCasProject);
const original=()=>{const p=createProject();return {project:p,snapshot:{
  id:p.id,revision:1,raw:JSON.stringify(p),
}};};
const next=(p:ReturnType<typeof createProject>,name:string)=>({
  ...p,config:{...p.config,name},
});

describe("async CAS editor session preflight (#143)",()=>{
  beforeEach(()=>{load.mockReset();cas.mockReset();});
  afterEach(()=>vi.unstubAllGlobals());

  it("requires explicit existing IDB row, never implicitly bootstraps or revives tombstones",async()=>{
    const {project}=original();
    load.mockResolvedValueOnce({state:"missing"})
      .mockResolvedValueOnce({state:"tombstone",revision:2});
    await expect(openCasEditorSession(project.id)).rejects.toThrow(/assente/);
    await expect(openCasEditorSession(project.id)).rejects.toThrow(/eliminato/);
    expect(cas).not.toHaveBeenCalled();
  });

  it("rejects noncanonical IDB JSON and storage outages with no local fallback",async()=>{
    const {project,snapshot}=original();
    load.mockResolvedValueOnce({state:"present",snapshot:{...snapshot,
      raw:JSON.stringify(project,null,2)}});
    await expect(openCasEditorSession(project.id)).rejects.toThrow(/non canonico/);
    load.mockRejectedValueOnce(Error("IndexedDB non disponibile"));
    const localSet=vi.fn();vi.stubGlobal("localStorage",{setItem:localSet});
    await expect(openCasEditorSession(project.id)).rejects.toThrow(/IndexedDB non disponibile/);
    expect(localSet).not.toHaveBeenCalled();
    expect(cas).not.toHaveBeenCalled();
  });

  it("does not advance token until confirmed async transaction and rejects double click",async()=>{
    const {project,snapshot}=original();
    load.mockResolvedValue({state:"present",snapshot});
    const handle=await openCasEditorSession(project.id);
    let succeed!: (value:typeof snapshot)=>void;
    cas.mockImplementationOnce(()=>new Promise(resolve=>{succeed=resolve;}));
    const updated=next(project,"confirmed");
    const pending=handle.commit(updated,snapshot);
    expect(handle.state()).toBe("saving");
    expect(handle.snapshot()).toEqual(snapshot);
    await expect(handle.commit(next(project,"second"),snapshot)).rejects.toThrow(/già in corso/);
    expect(cas).toHaveBeenCalledTimes(1);
    const committed={id:project.id,revision:2,raw:JSON.stringify(updated)};
    succeed(committed);
    await expect(pending).resolves.toEqual(committed);
    expect(handle.state()).toBe("ready");
    expect(handle.snapshot()).toEqual(committed);
    await expect(handle.commit(next(project,"stale"),snapshot)).rejects.toThrow(/obsoleta/);
    expect(cas).toHaveBeenCalledTimes(1);
  });

  it("blocks session on failed/ambiguous CAS without a retry or optimistic ACK",async()=>{
    const {project,snapshot}=original();
    load.mockResolvedValue({state:"present",snapshot});
    const handle=await openCasEditorSession(project.id);
    cas.mockRejectedValueOnce(Error("SECRET_NATIVE_QUOTA_DETAIL"));
    await expect(handle.commit(next(project,"blocked"),snapshot))
      .rejects.toThrow(/non confermato/);
    expect(handle.state()).toBe("blocked");
    expect(handle.snapshot()).toEqual(snapshot);
    await expect(handle.commit(next(project,"unwanted retry"),snapshot))
      .rejects.toThrow(/bloccata/);
    expect(cas).toHaveBeenCalledTimes(1);
    const reopened=await openCasEditorSession(project.id);
    expect(reopened.state()).toBe("ready");
    expect(reopened.snapshot()).toEqual(snapshot);
  });

  it("validates next snapshot/ID before touching CAS and does not leak data",async()=>{
    const {project,snapshot}=original();
    load.mockResolvedValue({state:"present",snapshot});
    const h=await openCasEditorSession(project.id);
    await expect(h.commit({...project,id:"../wrong"},snapshot)).rejects.toThrow(/ID progetto/);
    await expect(h.commit({...project,config:null as unknown as typeof project.config},snapshot))
      .rejects.toThrow(/non valido/);
    await expect(h.commit(next(project,"wrong ticket"),{...snapshot,raw:"other"}))
      .rejects.toThrow(/obsoleta/);
    expect(h.state()).toBe("ready");
    expect(cas).not.toHaveBeenCalled();
  });

  it("blocks on incoherent backend acknowledgement rather than treating it as saved",async()=>{
    const {project,snapshot}=original();
    load.mockResolvedValue({state:"present",snapshot});
    const h=await openCasEditorSession(project.id);
    cas.mockResolvedValueOnce({...snapshot,revision:10});
    await expect(h.commit(next(project,"verified"),snapshot))
      .rejects.toThrow(/non confermato/);
    expect(h.snapshot()).toEqual(snapshot);
    expect(h.state()).toBe("blocked");
  });
});
