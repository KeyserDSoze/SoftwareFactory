import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {developmentOf} from "../domain/development";
import {serializeCasProject} from "../infrastructure/project-cas";
import {buildCasIsolatedPendingCodePatch,
  buildCasIsolatedDiscardPendingCodePatch,
  canDiscardCasIsolatedPendingCodePatch} from "./cas-isolated-code-patch";

const make=()=>{
  const p=createProject();
  p.config.name="CAS Code Agent discard";
  p.config.description="Valid generated application brief";
  return p;
};
const snap=(p:ReturnType<typeof make>,revision=3)=>({
  id:p.id,revision,raw:serializeCasProject(p),
});
const proposal=JSON.stringify({summary:"Human unreviewed",files:[{
  path:"src/frontend/web/src/PilotDiscard163.tsx",
  content:"export const PilotDiscard163=()=> <p>Not executed</p>;",
  reason:"Staged human change only",
}]});
const pending=()=>{
  const p=make();
  p.development={revision:2,overrides:{},originals:{},
    history:[],lastRunnerJobId:"historical-job"};
  return buildCasIsolatedPendingCodePatch(snap(p),"Operator request",proposal);
};
describe("CAS #163 safe pending discard",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("removes only unreviewed pending, never stage/history/runner metadata",()=>{
    const p=pending(),before=snap(p);
    expect(canDiscardCasIsolatedPendingCodePatch(before)).toBe(true);
    const next=buildCasIsolatedDiscardPendingCodePatch(before);
    expect(developmentOf(next).pending).toBeUndefined();
    expect(next.stages).toEqual(p.stages);
    expect(next.config).toEqual(p.config);
    expect(next.development?.history).toEqual(p.development?.history);
    expect(next.development?.overrides).toEqual(p.development?.overrides);
    expect(next.development?.revision).toBe(2);
    expect(next.development?.lastRunnerJobId).toBe("historical-job");
    expect(next.githubSync).toBe(p.githubSync);
    expect(next.githubTestReceipt).toBe(p.githubTestReceipt);
    expect(serializeCasProject(next)).not.toBe(before.raw);
    expect(canDiscardCasIsolatedPendingCodePatch(snap(next))).toBe(false);
    expect(()=>buildCasIsolatedDiscardPendingCodePatch(snap(next)))
      .toThrow(/non scartabile/);
    expect(p.development?.pending?.summary).toBe("Human unreviewed");
  });
  it("refuses noncanonical tokens, reviewed, repaired or stale-workspace pending",()=>{
    const p=pending(),t=snap(p);
    expect(canDiscardCasIsolatedPendingCodePatch({...t,id:"wrong"})).toBe(false);
    expect(()=>buildCasIsolatedDiscardPendingCodePatch({...t,revision:0}))
      .toThrow(/non canonico/);
    expect(()=>buildCasIsolatedDiscardPendingCodePatch({...t,raw:t.raw+" "}))
      .toThrow(/non canonico/);
    p.development!.pending!.review={verdict:"pass",report:"Unverified",
      completedAt:new Date().toISOString()};
    expect(canDiscardCasIsolatedPendingCodePatch(snap(p))).toBe(false);
    delete p.development!.pending!.review;
    p.development!.pending!.repairCount=1;
    expect(canDiscardCasIsolatedPendingCodePatch(snap(p))).toBe(false);
    delete p.development!.pending!.repairCount;
    p.development!.pending!.revision=99;
    expect(canDiscardCasIsolatedPendingCodePatch(snap(p))).toBe(false);
  });
  it("does no storage, network or provider I/O in its pure path",()=>{
    const fail=vi.fn(()=>{throw Error("FORBIDDEN_IO");});
    vi.stubGlobal("localStorage",{getItem:fail,setItem:fail});
    vi.stubGlobal("sessionStorage",{getItem:fail,setItem:fail});
    vi.stubGlobal("indexedDB",{open:fail});
    vi.stubGlobal("fetch",fail);
    const t=snap(pending());
    expect(canDiscardCasIsolatedPendingCodePatch(t)).toBe(true);
    expect(developmentOf(buildCasIsolatedDiscardPendingCodePatch(t)).pending)
      .toBeUndefined();
    expect(fail).not.toHaveBeenCalled();
  });
});
