import {describe,expect,it,vi,afterEach} from "vitest";
import {createProject} from "../domain/defaults";
import {
  inspectCasUncommittedDraftBackup,prepareCasUncommittedDraftBackup,
} from "./cas-uncommitted-draft-backup";
import {readCasIsolatedStackConfig} from "./cas-isolated-stack-config";
import {
  canCopyCasUncommittedDraftLocally,prepareCasUncommittedDraftLocalCopy,
} from "./cas-uncommitted-draft-local-copy";

function fixture(){
  const project=createProject();
  project.config.name="CAS pinned untouched";
  const snapshot={id:project.id,revision:9,raw:JSON.stringify(project)};
  const input={
    snapshot,name:"Temporary 🌙 change",description:"Edit 日本語",
    requirements:"Manual notes (not saved)",stack:readCasIsolatedStackConfig(snapshot),
    manualStage:"technical" as const,
    manualOutput:"Human unverified stage text",
    codeRequest:"Unreviewed Code Agent input",
    codeProposalJson:'{"summary":"not a tested patch"}',
  };
  const archived=prepareCasUncommittedDraftBackup(input);
  return {snapshot,input,preview:inspectCasUncommittedDraftBackup(archived.raw)};
}

describe("CAS-only local form copy of pinned uncommitted draft #196",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("copies ALL form fields without a CAS acknowledgement or evidence promotion",()=>{
    const {snapshot,input,preview}=fixture();
    expect(canCopyCasUncommittedDraftLocally(preview,snapshot,true,false,false))
      .toBe(true);
    const copy=prepareCasUncommittedDraftLocalCopy(preview,snapshot);
    expect(copy).toEqual({
      name:input.name,description:input.description,
      requirements:input.requirements,stack:input.stack,
      manualStage:input.manualStage,manualOutput:input.manualOutput,
      codeRequest:input.codeRequest,
      codeProposalJson:input.codeProposalJson,
    });
    expect(Object.isFrozen(copy)).toBe(true);
    expect(snapshot.revision).toBe(9);
    expect(JSON.parse(snapshot.raw).config.name).toBe("CAS pinned untouched");
    expect(copy.stack).not.toBe(preview.stack);
  });
  it("disables copy on stale ID, rev, raw, blocked writer, existing dirty form or pipeline",()=>{
    const {snapshot,preview}=fixture();
    const rivals=[
      {...snapshot,id:"11111111-1111-4111-8111-111111111196"},
      {...snapshot,revision:snapshot.revision+1},
      {...snapshot,raw:snapshot.raw+" "},
      null,
    ];
    for(const rival of rivals){
      expect(canCopyCasUncommittedDraftLocally(
        preview,rival,true,false,false)).toBe(false);
      if(rival)expect(()=>prepareCasUncommittedDraftLocalCopy(preview,rival))
        .toThrow(/non applicabile/);
    }
    expect(canCopyCasUncommittedDraftLocally(preview,snapshot,false,false,false))
      .toBe(false);
    expect(canCopyCasUncommittedDraftLocally(preview,snapshot,true,true,false))
      .toBe(false);
    expect(canCopyCasUncommittedDraftLocally(preview,snapshot,true,false,true))
      .toBe(false);
  });
  it("never calls IndexedDB, localStorage, sessionStorage or a provider",()=>{
    const {snapshot,preview}=fixture();
    const forbidden=vi.fn(()=>{throw Error("NO_STORAGE_OR_NETWORK");});
    vi.stubGlobal("indexedDB",{open:forbidden});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("fetch",forbidden);
    expect(prepareCasUncommittedDraftLocalCopy(preview,snapshot).name)
      .toContain("🌙");
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("fails closed on source tamper or malformed embedded stack",()=>{
    const {snapshot,preview}=fixture();
    expect(()=>prepareCasUncommittedDraftLocalCopy(
      {...preview,baseRaw:preview.baseRaw.replace("CAS pinned untouched","WRONG")},
      snapshot)).toThrow(/non applicabile/);
    expect(()=>prepareCasUncommittedDraftLocalCopy(
      {...preview,manualStage:"unknown" as never},snapshot))
      .toThrow(/non applicabile/);
    expect(()=>prepareCasUncommittedDraftLocalCopy(
      {...preview,stack:{...preview.stack!,deployment:"bad" as never}},snapshot))
      .toThrow(/non applicabile/);
  });
});
