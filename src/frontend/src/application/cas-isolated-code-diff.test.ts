import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {allowedCodePath,developmentOf} from "../domain/development";
import {generateFiles} from "./scaffold";
import {serializeCasProject} from "../infrastructure/project-cas";
import {
  buildCasIsolatedPendingCodePatch,
  inspectCasIsolatedPendingCodeFiles,
  CAS_CODE_FILE_PREVIEW_CHARS,
} from "./cas-isolated-code-patch";

const make=()=>{
  const p=createProject();
  p.config.name="CAS diff inspection";
  p.config.description="Generated application with valid .NET and React structure";
  return p;
};
const snapshot=(p:ReturnType<typeof make>,revision=7)=>({
  id:p.id,revision,raw:serializeCasProject(p),
});
const candidate=(p:ReturnType<typeof make>,path:string,content:string)=>
  buildCasIsolatedPendingCodePatch(snapshot(p),"Inspect an inert human patch",
    JSON.stringify({summary:"Not reviewed or executed",files:[{
      path,content,reason:"Operator supplied proposed replacement",
    }]}));

describe("CAS read-only source preview #164",()=>{
  afterEach(()=>vi.unstubAllGlobals());

  it("shows bounded added file and escaped-looking content without review evidence",()=>{
    const p=make(),path="src/frontend/web/src/OnlyPreview164.tsx";
    const raw="/* <img src=x onerror=alert('STORED_XSS')> */\n"+
      "export const Demo=()=> <p>Review me, never execute me</p>;";
    const before=snapshot(candidate(p,path,raw));
    const result=inspectCasIsolatedPendingCodeFiles(before);
    expect(result).toEqual([{
      path,reason:"Operator supplied proposed replacement",before:"",
      after:raw,beforeMissing:true,
      beforeTruncated:false,afterTruncated:false,
    }]);
    expect(result?.[0].after).toContain("<img src=x onerror=");
    expect(developmentOf(JSON.parse(before.raw)).pending?.review).toBeUndefined();
    expect(developmentOf(JSON.parse(before.raw)).pending?.edits[0].content)
      .toBe(raw);
  });

  it("recomputes existing scaffold baseline and refuses stored previous spoofing",()=>{
    const p=make();
    const path=Object.keys(generateFiles(p)).find(allowedCodePath);
    expect(path).toBeTruthy();
    if(!path)throw Error("Missing generated source fixture");
    const source=generateFiles(p)[path];
    const changed=candidate(p,path,"// replacement, inert preview only");
    const before=snapshot(changed);
    const projected=inspectCasIsolatedPendingCodeFiles(before);
    expect(projected).toHaveLength(1);
    expect(projected?.[0].before).toBe(source.slice(0,CAS_CODE_FILE_PREVIEW_CHARS));
    expect(projected?.[0].beforeMissing).toBe(false);
    expect(projected?.[0].beforeTruncated)
      .toBe(source.length>CAS_CODE_FILE_PREVIEW_CHARS);
    changed.development!.pending!.edits[0].previous="forged previous";
    expect(inspectCasIsolatedPendingCodeFiles(snapshot(changed))).toBeNull();
  });

  it("rejects malformed raw, duplicate or forbidden paths, no-op edits and leaked tokens",()=>{
    const p=make();
    const path="src/frontend/web/src/OnlyPreview164.tsx";
    const staged=candidate(p,path,"export const ok=1;");
    expect(inspectCasIsolatedPendingCodeFiles({...snapshot(staged),id:"wrong"}))
      .toBeNull();
    expect(inspectCasIsolatedPendingCodeFiles({...snapshot(staged),revision:0}))
      .toBeNull();
    expect(inspectCasIsolatedPendingCodeFiles({...snapshot(staged),raw:
      snapshot(staged).raw+" " })).toBeNull();
    staged.development!.pending!.edits[0].path="../../steal.ts";
    expect(inspectCasIsolatedPendingCodeFiles(snapshot(staged))).toBeNull();
    staged.development!.pending!.edits[0].path=path;
    const extra={...staged.development!.pending!.edits[0]};
    staged.development!.pending!.edits.push(extra);
    expect(inspectCasIsolatedPendingCodeFiles(snapshot(staged))).toBeNull();
    staged.development!.pending!.edits.pop();
    staged.development!.pending!.edits[0].previous="export const ok=1;";
    expect(inspectCasIsolatedPendingCodeFiles(snapshot(staged))).toBeNull();
    staged.development!.pending!.edits[0].previous=null;
    staged.development!.pending!.edits[0].reason=
      "github_pat_"+"a".repeat(24);
    expect(inspectCasIsolatedPendingCodeFiles(snapshot(staged))).toBeNull();
    expect(inspectCasIsolatedPendingCodeFiles(snapshot(make()))).toBeNull();
  });

  it("truncates each source separately and never mutates saved raw",()=>{
    const p=make(),path="src/frontend/web/src/OnlyPreview164.tsx";
    const raw="x".repeat(CAS_CODE_FILE_PREVIEW_CHARS+101);
    const staged=candidate(p,path,raw);
    const ticket=snapshot(staged),files=inspectCasIsolatedPendingCodeFiles(ticket);
    expect(files?.[0].after).toHaveLength(CAS_CODE_FILE_PREVIEW_CHARS);
    expect(files?.[0].afterTruncated).toBe(true);
    expect(files?.[0].beforeMissing).toBe(true);
    expect(ticket.raw).toContain(raw);
    expect(serializeCasProject(staged)).toBe(ticket.raw);
    expect(Object.isFrozen(files)).toBe(true);
    expect(Object.isFrozen(files?.[0])).toBe(true);
  });

  it("does not access IndexedDB, localStorage, sessionStorage or the network",()=>{
    const forbidden=vi.fn(()=>{throw Error("FORBIDDEN_EXTERNAL_IO");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    vi.stubGlobal("fetch",forbidden);
    const staged=candidate(make(),"src/frontend/web/src/OnlyPreview164.tsx",
      "export const inert = 1;");
    expect(inspectCasIsolatedPendingCodeFiles(snapshot(staged))).toHaveLength(1);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
