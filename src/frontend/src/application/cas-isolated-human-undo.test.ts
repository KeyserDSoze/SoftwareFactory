import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import type {FactoryProject} from "../domain/types";
import {developmentOf,workspaceFiles} from "../domain/development";
import {serializeCasProject} from "../infrastructure/project-cas";
import {buildCasIsolatedPendingCodePatch}
  from "./cas-isolated-code-patch";
import {buildCasIsolatedHumanApplyPendingPatch}
  from "./cas-isolated-human-apply";
import {prepareCasIsolatedSourceZip}
  from "./cas-isolated-source-zip";
import {
  prepareCasIsolatedHumanUndo,canUndoCasIsolatedHumanPatch,
  buildCasIsolatedHumanUndo,
} from "./cas-isolated-human-undo";

const path="src/frontend/web/src/UndoHuman170.tsx";
const firstContent="export const UndoHuman170=()=> <p>OLD_HUMAN_170</p>;";
const secondContent="export const UndoHuman170=()=> <p>NEW_HUMAN_170</p>;";
const seed=()=>{
  const project=createProject();
  project.config.name="Undo human CAS source";
  project.config.description="Operator only: never certified";
  project.stages[0]={...project.stages[0],status:"complete",
    output:"HISTORICAL_MANUAL_STAGE_170",
    completionOrigin:"manual",sources:[]};
  return project;
};
const snap=(p:FactoryProject,revision=2)=>({
  id:p.id,revision,raw:serializeCasProject(p),
});
const pending=(project:FactoryProject,body=firstContent)=>{
  const json=JSON.stringify({
    summary:"Manual source without independent review",
    files:[{path,content:body,
      reason:"Human source changes, no test run"}],
    tests:["web-build"],assumptions:["No evidence of successful test"],
  });
  return buildCasIsolatedPendingCodePatch(
    snap(project),"Manual source request",json);
};
const apply=(project:FactoryProject,body=firstContent)=>
  buildCasIsolatedHumanApplyPendingPatch(snap(pending(project,body)));

describe("CAS-only human source undo #170",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("undoes a human-added file with exact before/after, stage invalidation, no review",()=>{
    const project=seed(),applied=apply(project),t=snap(applied,3);
    const record=developmentOf(applied).humanApplications![0];
    expect(record.files).toEqual([{path,before:null,after:firstContent}]);
    const preview=prepareCasIsolatedHumanUndo(t);
    expect(preview.id).toBe(project.id);
    expect(preview.revision).toBe(3);
    expect(preview.entryId).toBe(record.id);
    expect(preview.legacyAdditionOnly).toBe(false);
    expect(preview.files).toEqual([{path,current:firstContent,restore:null}]);
    expect(Object.isFrozen(preview.files)).toBe(true);
    const restored=buildCasIsolatedHumanUndo(t);
    const dev=developmentOf(restored);
    expect(dev.revision).toBe(2);
    expect(dev.pending).toBeUndefined();
    expect(dev.overrides[path]).toBeUndefined();
    expect(dev.originals[path]).toBeUndefined();
    expect(dev.history).toEqual([]);
    expect(dev.humanApplications).toEqual([{
      ...record,status:"reverted",revertedAt:expect.any(String),
    }]);
    expect(restored.stages.every(s=>s.status==="pending" &&
      s.output==="" && s.sources.length===0 &&
      s.completionOrigin===undefined)).toBe(true);
    expect(prepareCasIsolatedSourceZip(snap(restored,4)).files[path])
      .toBeUndefined();
    expect(JSON.stringify(applied)).toBe(t.raw);
    expect(canUndoCasIsolatedHumanPatch(snap(restored,4))).toBe(false);
    expect(restored.githubSync).toBeUndefined();
    expect(restored.githubTestReceipt).toBeUndefined();
    expect(dev.lastRunnerEvidence).toBeUndefined();
  });

  it("restores a previous manual override exactly and leaves earlier record unverified",()=>{
    const first=apply(seed());
    const second=apply(first,secondContent);
    expect(developmentOf(second).humanApplications?.[1].files)
      .toEqual([{path,before:firstContent,after:secondContent}]);
    const preview=prepareCasIsolatedHumanUndo(snap(second,6));
    expect(preview.files[0].restore).toBe(firstContent);
    const undone=buildCasIsolatedHumanUndo(snap(second,6));
    const dev=developmentOf(undone);
    expect(dev.revision).toBe(3);
    expect(dev.overrides[path]).toBe(firstContent);
    expect(dev.originals[path]).toBeNull();
    expect(dev.humanApplications?.map(x=>x.status))
      .toEqual(["operator-unverified","reverted"]);
    expect(workspaceFiles(undone)[path]).toBe(firstContent);
    expect(prepareCasIsolatedSourceZip(snap(undone,7)).files[path])
      .toBe(firstContent);
    // A NEW manual operation can follow a reverted record; no false
    // reviewer/test claim is introduced by the undo audit trail.
    const again=apply(undone,"export const ThirdHuman170=42;");
    expect(developmentOf(again).humanApplications?.map(x=>x.status))
      .toEqual(["operator-unverified","reverted","operator-unverified"]);
    expect(developmentOf(again).history).toEqual([]);
  });

  it("supports historical #169 additive source but NEVER guesses overwritten before-image",()=>{
    const first=apply(seed());
    const old=structuredClone(first);
    delete old.development!.humanApplications![0].files;
    const preview=prepareCasIsolatedHumanUndo(snap(old));
    expect(preview.legacyAdditionOnly).toBe(true);
    expect(preview.files[0].restore).toBeNull();
    const restored=buildCasIsolatedHumanUndo(snap(old));
    expect(restored.development?.overrides[path]).toBeUndefined();
    const twice=apply(first,secondContent);
    const oldOverwrite=structuredClone(twice);
    delete oldOverwrite.development!.humanApplications![1].files;
    expect(canUndoCasIsolatedHumanPatch(snap(oldOverwrite))).toBe(false);
    expect(()=>buildCasIsolatedHumanUndo(snap(oldOverwrite)))
      .toThrow(/non disponibile/);
  });

  it("rejects forged after/before, stale ticket, missing file, and pending proposal",()=>{
    const first=apply(seed());
    const t=snap(first);
    for(const wrong of [
      {...t,id:"stale"},
      {...t,revision:0},
      {...t,raw:t.raw+" "},
    ])expect(canUndoCasIsolatedHumanPatch(wrong)).toBe(false);
    const afterMismatch=structuredClone(first);
    afterMismatch.development!.humanApplications![0].files![0].after=
      "export const forged=1;";
    expect(canUndoCasIsolatedHumanPatch(snap(afterMismatch))).toBe(false);
    const beforeMismatch=structuredClone(first);
    beforeMismatch.development!.humanApplications![0].files![0].before=
      "export const invented=1;";
    expect(canUndoCasIsolatedHumanPatch(snap(beforeMismatch))).toBe(false);
    const overwritten=structuredClone(first);
    overwritten.development!.overrides[path]="export const rival=1;";
    expect(canUndoCasIsolatedHumanPatch(snap(overwritten))).toBe(false);
    const withPending=pending(first,"export const other=1;");
    expect(canUndoCasIsolatedHumanPatch(snap(withPending))).toBe(false);
    const stageRunning=structuredClone(first);
    stageRunning.stages[1].status="running";
    expect(canUndoCasIsolatedHumanPatch(snap(stageRunning))).toBe(false);
  });

  it("refuses false review, runner/GitHub receipts and forged prior ledger",()=>{
    const original=apply(seed()),dev=original.development!;
    const altered:FactoryProject[]=[
      {...original,development:{...dev,lastRunnerJobId:"r"}},
      {...original,development:{...dev,history:[{
        id:"fake",request:"x",summary:"x",appliedAt:"now",
        edits:[],review:{verdict:"pass",report:"fake",
          completedAt:"now"},status:"applied",
      }]}},
      {...original,githubDestination:{
        owner:"r",repo:"p",branch:"main",
        authMode:"pat",appGateway:"",privateRepo:true,
      }},
      {...original,githubTestReceipt:{
        requestId:"fake",repository:"a/b",branch:"main",
        commitSha:"abc",createdAt:"now",selected:["web-test"],
      }},
      {...original,development:{...dev,humanApplications:[{
        ...dev.humanApplications![0],status:"reverted",
        revertedAt:"2026-11-22T20:00:00Z",
      }]}},
      {...original,development:{...dev,humanApplications:[{
        ...dev.humanApplications![0],files:[{
          path,before:null,after:"github_pat_"+"x".repeat(25),
        }],
      }]}},
    ];
    for(const p of altered){
      expect(canUndoCasIsolatedHumanPatch(snap(p))).toBe(false);
      expect(()=>prepareCasIsolatedHumanUndo(snap(p)))
        .toThrow(/non disponibile/);
    }
  });

  it("is pure: no legacy, IndexedDB, session credentials, network or file writes",()=>{
    const fail=vi.fn(()=>{throw Error("UNEXPECTED_IO");});
    vi.stubGlobal("localStorage",{getItem:fail,setItem:fail});
    vi.stubGlobal("sessionStorage",{getItem:fail,setItem:fail});
    vi.stubGlobal("indexedDB",{open:fail});
    vi.stubGlobal("fetch",fail);
    const project=apply(seed());
    const t=snap(project);
    expect(canUndoCasIsolatedHumanPatch(t)).toBe(true);
    expect(prepareCasIsolatedHumanUndo(t).files[0].current)
      .toBe(firstContent);
    expect(buildCasIsolatedHumanUndo(t).development?.revision).toBe(2);
    expect(fail).not.toHaveBeenCalled();
  });
});
