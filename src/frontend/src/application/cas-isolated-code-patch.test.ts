import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {developmentOf} from "../domain/development";
import {serializeCasProject} from "../infrastructure/project-cas";
import {
  buildCasIsolatedPendingCodePatch,canStageCasIsolatedCodePatch,
  inspectCasIsolatedPendingCodePatch,
  CAS_PENDING_PATCH_MAX_JSON,
} from "./cas-isolated-code-patch";

const sample=()=>{
  const p=createProject();
  p.config.name="IDB human patch";
  p.config.description="A valid feature brief for generated .NET/React application";
  return p;
};
const token=(p:ReturnType<typeof createProject>)=>({
  id:p.id,revision:7,raw:serializeCasProject(p),
});
const valid=()=>JSON.stringify({
  summary:"Human pasted JSON, not reviewed",
  files:[{path:"src/frontend/web/src/HumanFeature162.tsx",
    content:"export const HumanFeature162=()=> <p>Operator patch</p>;",
    reason:"Add component without running code"}],
  tests:["web-build"],assumptions:["Review and tests have NOT been run"],
});
describe("CAS Code Agent pending patch #162",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("saves only pending unreviewed proposal, no fabricated approval/runner/AI",()=>{
    const p=sample(),before=token(p);
    const result=buildCasIsolatedPendingCodePatch(
      before,"Human request",valid());
    const pending=developmentOf(result).pending!;
    expect(pending.summary).toBe("Human pasted JSON, not reviewed");
    expect(pending.request).toBe("Human request");
    expect(pending.edits).toHaveLength(1);
    expect(pending.edits[0].previous).toBeNull();
    expect(pending.review).toBeUndefined();
    expect(pending.repairTrail).toBeUndefined();
    expect(result.development?.history).toEqual([]);
    expect(result.development?.lastRunnerEvidence).toBeUndefined();
    expect(result.githubTestReceipt).toBeUndefined();
    expect(result.githubSync).toBeUndefined();
    expect(result.stages).toEqual(p.stages);
    expect(result.config).toEqual(p.config);
    expect(result.id).toBe(p.id);
    expect(Number.isFinite(Date.parse(result.updatedAt))).toBe(true);
    expect(before.raw).toBe(serializeCasProject(p));
    expect(inspectCasIsolatedPendingCodePatch(token(result))).toEqual({
      summary:"Human pasted JSON, not reviewed",
      editCount:1,revision:0,status:"unreviewed",
    });
    expect(inspectCasIsolatedPendingCodePatch(before)).toBeNull();
  });
  it("fails closed on duplicate pending, malformed raw/revision, bad paths",()=>{
    const p=sample(),t=token(p);
    const staged=buildCasIsolatedPendingCodePatch(t,"Request",valid());
    expect(()=>buildCasIsolatedPendingCodePatch(
      token(staged),"Again",valid())).toThrow(/pending/);
    expect(()=>buildCasIsolatedPendingCodePatch({...t,id:"wrong"},
      "Request",valid())).toThrow(/non canonico/);
    expect(()=>buildCasIsolatedPendingCodePatch({...t,revision:0},
      "Request",valid())).toThrow(/non canonico/);
    expect(()=>buildCasIsolatedPendingCodePatch({...t,raw:t.raw+" "},
      "Request",valid())).toThrow(/non canonico/);
    const forbidden=JSON.stringify({summary:"Forbidden",files:[
      {path:"../../.github/workflows/main.yml",content:"malicious",
        reason:"A"}]});
    expect(()=>buildCasIsolatedPendingCodePatch(t,"Request",forbidden))
      .toThrow(/Path non permesso/);
    expect(()=>buildCasIsolatedPendingCodePatch(t,"Request","broken"))
      .toThrow(/non in formato JSON valido/);
    expect(canStageCasIsolatedCodePatch(token(staged),"Request",valid()))
      .toBe(false);
  });
  it("rejects secret content in summary/description, overlong inputs and noncanonical origins",()=>{
    const p=sample(),t=token(p);
    const leaked=JSON.stringify({summary:"Leak github_pat_"+
      "a".repeat(25),files:[{
      path:"src/frontend/web/src/HumanFeature162.tsx",
      content:"export const k=1;",reason:"x",
    }]});
    expect(()=>buildCasIsolatedPendingCodePatch(t,"Request",leaked))
      .toThrow(/credenziale/);
    expect(()=>buildCasIsolatedPendingCodePatch(t,"",
      valid())).toThrow(/vuoti/);
    expect(()=>buildCasIsolatedPendingCodePatch(t,"Request",
      "z".repeat(CAS_PENDING_PATCH_MAX_JSON+1))).toThrow(/troppo grandi/);
    p.stages[0].completionOrigin="ai";
    expect(()=>buildCasIsolatedPendingCodePatch(token(p),"Request",valid()))
      .toThrow(/non canonico/);
  });
  it("retains historical workspace receipts but never counts them as review of this patch",()=>{
    const p=sample();
    p.development={revision:2,overrides:{},originals:{},
      history:[],lastRunnerJobId:"historic-only"};
    const next=buildCasIsolatedPendingCodePatch(token(p),"New request",valid());
    expect(next.development?.lastRunnerJobId).toBe("historic-only");
    expect(next.development?.pending?.revision).toBe(2);
    expect(next.development?.pending?.review).toBeUndefined();
    expect(inspectCasIsolatedPendingCodePatch(token(next))?.status)
      .toBe("unreviewed");
  });
  it("refuses duplicate paths, no-op and private key strings in any JSON field",()=>{
    const p=sample(),t=token(p);
    const duplicate=JSON.stringify({summary:"dup",files:[
      {path:"src/frontend/web/src/HumanFeature162.tsx",
        content:"export const a=1;",reason:"one"},
      {path:"src/frontend/web/src/HumanFeature162.tsx",
        content:"export const a=2;",reason:"two"}]});
    expect(()=>buildCasIsolatedPendingCodePatch(t,"Request",duplicate))
      .toThrow(/duplicato/);
    expect(()=>buildCasIsolatedPendingCodePatch(t,"-----BEGIN PRIVATE KEY-----",
      valid())).toThrow(/credenziale/);
    expect(canStageCasIsolatedCodePatch(t,"Request",valid())).toBe(true);
  });
  it("never accesses IDB/localStorage/network/provider for preflight or inspect",()=>{
    const fail=vi.fn(()=>{throw Error("FORBIDDEN_STORAGE_NETWORK");});
    vi.stubGlobal("localStorage",{getItem:fail,setItem:fail});
    vi.stubGlobal("sessionStorage",{getItem:fail,setItem:fail});
    vi.stubGlobal("indexedDB",{open:fail});
    vi.stubGlobal("fetch",fail);
    const p=sample(),t=token(p);
    expect(canStageCasIsolatedCodePatch(t,"Request",valid())).toBe(true);
    const candidate=buildCasIsolatedPendingCodePatch(t,"Request",valid());
    expect(inspectCasIsolatedPendingCodePatch(token(candidate))).not.toBeNull();
    expect(fail).not.toHaveBeenCalled();
  });
});
