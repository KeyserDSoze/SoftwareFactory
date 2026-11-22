import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {developmentOf,workspaceFiles} from "../domain/development";
import {serializeCasProject} from "../infrastructure/project-cas";
import {buildCasIsolatedPendingCodePatch} from "./cas-isolated-code-patch";
import {prepareCasIsolatedSourceZip} from "./cas-isolated-source-zip";
import {
  buildCasIsolatedHumanApplyPendingPatch,
  canApplyCasIsolatedHumanPendingPatch,
} from "./cas-isolated-human-apply";

const path="src/frontend/web/src/Human169.tsx";
const short="export const Operator169=()=> <div>HUMAN_UNVERIFIED_169</div>;";
const p0=()=>{
  const p=createProject();
  p.config.name="Human source without claims";
  p.config.description="IDB-only code patch manual exercise";
  return p;
};
const snap=(p:ReturnType<typeof p0>,revision=2)=>({
  id:p.id,revision,raw:serializeCasProject(p),
});
const patch=(p:ReturnType<typeof p0>,body=short,pth=path)=>
  buildCasIsolatedPendingCodePatch(snap(p),"Operator proposed source",
    JSON.stringify({summary:"Unreviewed proposed source",
      files:[{path:pth,content:body,reason:"Manual source preview"}],
      tests:["web-test"],assumptions:["No test has run"]}));

describe("native human-applied CAS code #169",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("moves a FULLY previewable pending edit into overrides, with only unverified provenance",()=>{
    const original=p0(),staged=patch(original),t=snap(staged,3);
    expect(canApplyCasIsolatedHumanPendingPatch(t)).toBe(true);
    const result=buildCasIsolatedHumanApplyPendingPatch(t);
    const dev=developmentOf(result);
    expect(dev.pending).toBeUndefined();
    expect(dev.revision).toBe(1);
    expect(dev.overrides[path]).toBe(short);
    expect(dev.originals[path]).toBeNull();
    expect(dev.history).toEqual([]);
    expect(dev.lastRunnerEvidence).toBeUndefined();
    expect(dev.lastRunnerJobId).toBeUndefined();
    expect(dev.humanApplications).toEqual([{
      id:developmentOf(staged).pending!.id,
      summary:"Unreviewed proposed source",
      appliedAt:expect.any(String),revision:1,paths:[path],
      files:[{path,before:null,after:short}],
      status:"operator-unverified",
    }]);
    expect(workspaceFiles(result)[path]).toBe(short);
    expect(result.githubSync).toBeUndefined();
    expect(result.githubTestReceipt).toBeUndefined();
    expect(result.stages).toEqual(original.stages);
    expect(snap(staged,3).raw).toBe(t.raw);
    const zip=prepareCasIsolatedSourceZip(snap(result,4));
    expect(zip.files[path]).toBe(short);
    expect(zip.files["docs/feature-implementation.md"]).toBeUndefined();
    expect(zip.files["docs/cas-idb-export-provenance.md"])
      .toContain("operator-applied");
    expect(JSON.stringify(zip.files)).not.toContain("independently reviewed");
  });

  it("rejects historical, falsified review, repair, runner and GitHub evidence",()=>{
    const p=p0(),staged=patch(p),dev=staged.development!;
    for(const changed of [
      {...staged,development:{...dev,pending:{...dev.pending!,
        review:{verdict:"pass" as const,report:"unverified",completedAt:"now"}}}},
      {...staged,development:{...dev,pending:{...dev.pending!,
        repairCount:1}}},
      {...staged,development:{...dev,lastRunnerJobId:"123"}},
      {...staged,development:{...dev,lastRunnerEvidence:{
        id:"123",digest:"fake",endpoint:"runner",label:"fake",
        steps:["web-test" as const],submittedAt:"now",proposalId:null,revision:0}}},
      {...staged,development:{...dev,history:[{
        id:"x",request:"x",summary:"x",appliedAt:"now",
        edits:[],review:{verdict:"pass" as const,report:"fake",completedAt:"now"},
        status:"applied" as const,
      }]}},
      {...staged,githubTestReceipt:{
        requestId:"fake",repository:"a/b",branch:"main",commitSha:"x",
        createdAt:"now",selected:["web-test" as const]}},
      {...staged,githubDestination:{
        owner:"a",repo:"b",branch:"main",privateRepo:false,
        authMode:"pat" as const,appGateway:""}},
    ]){
      expect(canApplyCasIsolatedHumanPendingPatch(snap(changed))).toBe(false);
      expect(()=>buildCasIsolatedHumanApplyPendingPatch(snap(changed)))
        .toThrow(/non applicabile/);
    }
  });

  it("refuses truncated file BEFORE and AFTER and unsafe injected content",()=>{
    const original=p0();
    const long=patch(original,"const content = '"+("x".repeat(1700))+"';");
    expect(canApplyCasIsolatedHumanPendingPatch(snap(long))).toBe(false);
    const staged=patch(original);
    const poisoned={...staged,development:{
      ...staged.development!,pending:{
        ...staged.development!.pending!,
        edits:staged.development!.pending!.edits.map(e=>({
          ...e,content:"github_pat_"+"a".repeat(25),
        })),
      },
    }};
    expect(canApplyCasIsolatedHumanPendingPatch(snap(poisoned))).toBe(false);
    const badPrevious={...staged,development:{
      ...staged.development!,pending:{
        ...staged.development!.pending!,
        edits:staged.development!.pending!.edits.map(e=>({
          ...e,previous:"forged prior source",
        })),
      },
    }};
    expect(canApplyCasIsolatedHumanPendingPatch(snap(badPrevious))).toBe(false);
  });

  it("supports repeated bounded manual applications with consistent scaffold baseline",()=>{
    const one=buildCasIsolatedHumanApplyPendingPatch(snap(patch(p0())));
    const two=buildCasIsolatedPendingCodePatch(snap(one,5),
      "Second manual request",JSON.stringify({
        summary:"Second source, still unreviewed",
        files:[{path,content:"export const Operator169=2;",
          reason:"Second manual source update"}],
      }));
    const applied=buildCasIsolatedHumanApplyPendingPatch(snap(two,6));
    const dev=developmentOf(applied);
    expect(dev.revision).toBe(2);
    expect(dev.humanApplications).toHaveLength(2);
    expect(dev.originals[path]).toBeNull();
    expect(dev.overrides[path]).toBe("export const Operator169=2;");
    expect(dev.history).toEqual([]);
    expect(dev.humanApplications?.every(x=>x.status==="operator-unverified"))
      .toBe(true);
  });

  it("rejects canonical mismatch, running stage, no pending and I/O dependencies",()=>{
    const p=p0(),staged=patch(p),ticket=snap(staged);
    expect(canApplyCasIsolatedHumanPendingPatch(snap(p))).toBe(false);
    expect(canApplyCasIsolatedHumanPendingPatch({...ticket,id:"other"})).toBe(false);
    expect(canApplyCasIsolatedHumanPendingPatch({...ticket,revision:0})).toBe(false);
    expect(canApplyCasIsolatedHumanPendingPatch({
      ...ticket,raw:ticket.raw+" " })).toBe(false);
    staged.stages[0].status="running";
    expect(canApplyCasIsolatedHumanPendingPatch(snap(staged))).toBe(false);
    const forbidden=vi.fn(()=>{throw Error("FORBIDDEN_STORAGE");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    vi.stubGlobal("fetch",forbidden);
    const fresh=patch(p0());
    expect(buildCasIsolatedHumanApplyPendingPatch(snap(fresh))
      .development?.humanApplications?.[0].status)
      .toBe("operator-unverified");
    expect(forbidden).not.toHaveBeenCalled();
  });
});
