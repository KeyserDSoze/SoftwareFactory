import {describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import type {CasProjectSnapshot,CasProjectSlot} from "../infrastructure/project-cas";
import {
  prepareCasSelectedRevisionReconcile,
  confirmCasSelectedRevisionReconcile,
} from "./cas-selected-revision-reconcile";

function fixture(){
  const p=createProject();
  p.config.name="Pinned project 185";
  const old:CasProjectSnapshot={id:p.id,revision:2,raw:JSON.stringify(p)};
  const next:CasProjectSnapshot={...old,revision:3,
    raw:JSON.stringify({...p,config:{...p.config,name:"Rival revision 185"}})};
  return {old,next};
}
describe("manual CAS selected revision reconciliation #185",()=>{
  it("reports unchanged only with byte-exact pinned revision; no legacy reads",async()=>{
    const {old}=fixture(),forbidden=vi.fn();
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    const read=vi.fn(async():Promise<CasProjectSlot>=>({
      state:"present",snapshot:old,
    }));
    const result=await prepareCasSelectedRevisionReconcile(old,read);
    expect(result).toEqual({state:"unchanged",old});
    expect(Object.isFrozen(result)).toBe(true);
    expect(read).toHaveBeenCalledWith(old.id);
    expect(forbidden).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("marks rival advance without adopting it; separate explicit consent required",async()=>{
    const {old,next}=fixture(),read=vi.fn(async()=>({
      state:"present" as const,snapshot:next,
    }));
    const ticket=await prepareCasSelectedRevisionReconcile(old,read);
    expect(ticket.state).toBe("advanced");
    await expect(confirmCasSelectedRevisionReconcile(ticket,false,()=>true,read))
      .rejects.toThrow(/Consenso/);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(confirmCasSelectedRevisionReconcile(ticket,true,()=>true,read))
      .resolves.toEqual(next);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not confuse tombstone/missing with a new writable project",async()=>{
    const {old}=fixture();
    expect(await prepareCasSelectedRevisionReconcile(old,async()=>({
      state:"missing",
    }))).toEqual({state:"missing",old});
    const deleted=await prepareCasSelectedRevisionReconcile(old,async()=>({
      state:"tombstone",revision:3,
    }));
    expect(deleted).toEqual({
      state:"tombstone",old,deleted:{id:old.id,revision:3},
    });
    await expect(confirmCasSelectedRevisionReconcile(
      deleted,true,()=>true,
    )).rejects.toThrow(/Nessuna/);
    await expect(prepareCasSelectedRevisionReconcile(old,async()=>({
      state:"tombstone",revision:2,
    }))).rejects.toThrow(/incoerente/);
  });
  it("rejects same-revision rewrite, rollback, corrupted raw and ID mismatch",async()=>{
    const {old,next}=fixture();
    const rivals=[
      {...next,revision:old.revision},
      {...next,revision:old.revision-1},
      {...next,raw:next.raw+" "},
      {...next,id:createProject().id},
    ];
    for(const snapshot of rivals)
      await expect(prepareCasSelectedRevisionReconcile(old,async()=>({
        state:"present",snapshot,
      }))).rejects.toThrow();
    await expect(prepareCasSelectedRevisionReconcile({
      ...old,raw:old.raw+" ",
    },async()=>({state:"missing"}))).rejects.toThrow(/non canonica/);
  });
  it("refuses rival update/delete, stale UI selection and tampered tickets",async()=>{
    const {old,next}=fixture();
    const ticket=await prepareCasSelectedRevisionReconcile(old,async()=>({
      state:"present",snapshot:next,
    }));
    if(ticket.state!=="advanced")throw Error("Expected advance");
    let calls=0;
    await expect(confirmCasSelectedRevisionReconcile(
      ticket,true,()=>++calls===1,
      async()=>({state:"present",snapshot:next}),
    )).rejects.toThrow(/cambiata/);
    await expect(confirmCasSelectedRevisionReconcile(
      ticket,true,()=>true,
      async()=>({state:"tombstone",revision:4}),
    )).rejects.toThrow(/invalidato/);
    await expect(confirmCasSelectedRevisionReconcile(
      ticket,true,()=>true,
      async()=>({state:"present",snapshot:{...next,revision:4}}),
    )).rejects.toThrow(/invalidato/);
    await expect(confirmCasSelectedRevisionReconcile({
      ...ticket,next:{...next,revision:2},
    },true,()=>true)).rejects.toThrow(/non valido/);
  });
});
