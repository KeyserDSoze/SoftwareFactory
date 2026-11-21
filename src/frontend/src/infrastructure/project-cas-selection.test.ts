import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import type { FactoryProject } from "../domain/types";
import { listCasProjects } from "./project-cas";
import { openCasEditorSession } from "./project-cas-editor-session";
import type { CasEditorSession } from "./project-cas-editor-session";
import { openCasSelectionController } from "./project-cas-selection";

vi.mock("./project-cas-editor-session",()=>({openCasEditorSession:vi.fn()}));
vi.mock("./project-cas",async getOriginal=>{
  const original=await getOriginal<typeof import("./project-cas")>();
  return {...original,listCasProjects:vi.fn()};
});
const open=vi.mocked(openCasEditorSession);
const list=vi.mocked(listCasProjects);
const deferred=<T>()=>{
  let resolve!: (value:T)=>void;
  let reject!: (reason:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
};
function sample(name:string){
  const project=createProject();
  project.config.name=name;
  return {project,snapshot:{id:project.id,revision:1,raw:JSON.stringify(project)}};
}
function session(initial:ReturnType<typeof sample>) {
  let token=initial.snapshot;
  let status: "ready"|"saving"|"blocked" = "ready";
  const commit=vi.fn(async (next:FactoryProject)=>{
    status="saving";
    token={id:next.id,revision:token.revision+1,raw:JSON.stringify(next)};
    status="ready";
    return token;
  });
  const handle:CasEditorSession={
    snapshot:()=>({...token}),
    state:()=>status,
    commit,
  };
  return {handle,commit,block:()=>{status="blocked";}};
}

describe("future CAS selection coordinator (#144)",()=>{
  beforeEach(()=>{open.mockReset();list.mockReset();});

  it("prepares source+destination ticket before consent and switches only after exact reread",async()=>{
    const a=sample("A"),b=sample("B");
    const ah=session(a),bh=session(b);
    open.mockResolvedValueOnce(ah.handle).mockResolvedValueOnce(bh.handle)
      .mockResolvedValueOnce(bh.handle);
    const ctrl=await openCasSelectionController(a.project.id);
    const ticket=await ctrl.prepareSwitch(b.project.id);
    expect(ctrl.snapshot()).toEqual(a.snapshot);
    expect(ticket).toEqual({source:a.snapshot,destination:b.snapshot,generation:0});
    expect(ctrl.state()).toBe("ready");
    await expect(ctrl.confirmSwitch(ticket)).resolves.toEqual(b.snapshot);
    expect(ctrl.snapshot()).toEqual(b.snapshot);
    expect(ctrl.state()).toBe("ready");
    await expect(ctrl.commit(a.project,a.snapshot)).rejects.toThrow(/obsoleto/);
    expect(ah.commit).not.toHaveBeenCalled();
    expect(bh.commit).not.toHaveBeenCalled();
  });

  it("denies stale destination after consent and retains original selection",async()=>{
    const a=sample("A"),b=sample("B"),updated={...b.snapshot,revision:2};
    open.mockResolvedValueOnce(session(a).handle)
      .mockResolvedValueOnce(session(b).handle)
      .mockResolvedValueOnce(session({...b,snapshot:updated}).handle);
    const ctrl=await openCasSelectionController(a.project.id);
    const ticket=await ctrl.prepareSwitch(b.project.id);
    await expect(ctrl.confirmSwitch(ticket)).rejects.toThrow(/non confermato/);
    expect(ctrl.state()).toBe("ready");
    expect(ctrl.snapshot()).toEqual(a.snapshot);
  });

  it("refuses concurrent saves/switches while an acknowledgement is in flight",async()=>{
    const a=sample("A"),b=sample("B"),slow=deferred<typeof a.snapshot>();
    const ah=session(a),bh=session(b);
    ah.commit.mockImplementationOnce(()=>slow.promise);
    open.mockResolvedValueOnce(ah.handle).mockResolvedValueOnce(bh.handle);
    const ctrl=await openCasSelectionController(a.project.id);
    const ticket=await ctrl.prepareSwitch(b.project.id);
    const pending=ctrl.commit({...a.project,config:{...a.project.config,name:"Saved"}},a.snapshot);
    expect(ctrl.state()).toBe("saving");
    expect(ctrl.snapshot()).toEqual(a.snapshot);
    await expect(ctrl.confirmSwitch(ticket)).rejects.toThrow(/sospesa/);
    await expect(ctrl.prepareSwitch(b.project.id)).rejects.toThrow(/sospesa/);
    await expect(ctrl.commit(a.project,a.snapshot)).rejects.toThrow(/sospesa/);
    const confirmed={id:a.project.id,revision:2,raw:JSON.stringify({
      ...a.project,config:{...a.project.config,name:"Saved"},
    })};
    slow.resolve(confirmed);
    await expect(pending).resolves.toEqual(confirmed);
    // The mocked handle did not update its token; ticket is fenced by epoch.
    await expect(ctrl.confirmSwitch(ticket)).rejects.toThrow(/obsoleto/);
    expect(ctrl.state()).toBe("ready");
  });

  it("fences a pending switch and preserves source if destination open fails",async()=>{
    const a=sample("A"),b=sample("B"),read=deferred<CasEditorSession>();
    open.mockResolvedValueOnce(session(a).handle)
      .mockResolvedValueOnce(session(b).handle)
      .mockImplementationOnce(()=>read.promise);
    const ctrl=await openCasSelectionController(a.project.id);
    const ticket=await ctrl.prepareSwitch(b.project.id);
    const switching=ctrl.confirmSwitch(ticket);
    expect(ctrl.state()).toBe("switching");
    await expect(ctrl.commit(a.project,a.snapshot)).rejects.toThrow(/sospesa/);
    await expect(ctrl.confirmSwitch(ticket)).rejects.toThrow(/sospesa/);
    read.reject(Error("SECRET_NATIVE_OPEN"));
    await expect(switching).rejects.toThrow(/non confermato/);
    expect(ctrl.state()).toBe("ready");
    expect(ctrl.snapshot()).toEqual(a.snapshot);
  });

  it("blocks after uncertain CAS failure without falling back or silently switching",async()=>{
    const a=sample("A"),b=sample("B"),ah=session(a);
    ah.commit.mockImplementationOnce(async()=>{ah.block();throw Error("SECRET_NATIVE");});
    open.mockResolvedValueOnce(ah.handle);
    const ctrl=await openCasSelectionController(a.project.id);
    await expect(ctrl.commit(a.project,a.snapshot)).rejects.toThrow(/non confermato/);
    expect(ctrl.state()).toBe("blocked");
    await expect(ctrl.prepareSwitch(b.project.id)).rejects.toThrow(/sospesa/);
    await expect(ctrl.commit(a.project,a.snapshot)).rejects.toThrow(/sospesa/);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not silently recover tombstones/missing or skip broken IndexedDB",async()=>{
    const a=sample("A"),b=sample("B");
    open.mockRejectedValueOnce(Error("Progetto IndexedDB eliminato"));
    await expect(openCasSelectionController(a.project.id)).rejects.toThrow(/eliminato/);
    open.mockResolvedValueOnce(session(a).handle)
      .mockRejectedValueOnce(Error("Progetto IndexedDB assente"));
    const ctrl=await openCasSelectionController(a.project.id);
    await expect(ctrl.prepareSwitch(b.project.id)).rejects.toThrow(/assente/);
    expect(ctrl.snapshot()).toEqual(a.snapshot);
    expect(ctrl.state()).toBe("ready");
  });

  it("bounds read-only library discovery to the current controller generation",async()=>{
    const a=sample("A"),ctrlHandle=session(a);
    open.mockResolvedValueOnce(ctrlHandle.handle);
    const ctrl=await openCasSelectionController(a.project.id);
    const pending=deferred<Awaited<ReturnType<typeof listCasProjects>>>();
    list.mockReturnValueOnce(pending.promise);
    const reading=ctrl.list();
    const committed=await ctrl.commit(a.project,a.snapshot);
    expect(committed.revision).toBe(2);
    pending.resolve([]);
    await expect(reading).rejects.toThrow(/obsoleto/);
    list.mockResolvedValueOnce([]);
    await expect(ctrl.list()).resolves.toEqual([]);
  });
});
