import {describe,expect,it,vi,afterEach} from "vitest";
import {createProject} from "../domain/defaults";
import {readCasIsolatedStackConfig} from "./cas-isolated-stack-config";
import {CAS_UNCOMMITTED_DRAFT_FORMAT,prepareCasUncommittedDraftBackup}
  from "./cas-uncommitted-draft-backup";
import type {CasUncommittedDraftInput} from "./cas-uncommitted-draft-backup";

function fixture():CasUncommittedDraftInput {
  const project=createProject();
  project.config.name="Baseline name";
  project.config.description="Original description";
  const snapshot={id:project.id,revision:7,raw:JSON.stringify(project)};
  return {
    snapshot,name:project.config.name,description:project.config.description,
    requirements:project.config.requirements??"",
    stack:readCasIsolatedStackConfig(snapshot),
    manualStage:"features",manualOutput:"",
    codeRequest:"",codeProposalJson:"",
  };
}

describe("opt-in CAS uncommitted draft emergency offline backup #194",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("preserves exact pinned RAW and every human draft without claiming a commit",()=>{
    const base=fixture();
    const input={
      ...base,name:"Changed 🦊 name",description:"Brief 日本語\\n second line",
      requirements:"π / TODO",manualStage:"technical" as const,
      manualOutput:"Draft manual stage",
      codeRequest:"Unreviewed request",
      codeProposalJson:'{"files":[],"reason":"not approved"}',
      stack:{...base.stack!,deployment:"aws" as const},
    };
    const backup=prepareCasUncommittedDraftBackup(input);
    const parsed=JSON.parse(backup.raw);
    expect(backup.fileName).toBe(
      "softwarefactory-cas-uncommitted-draft-"+base.snapshot.id+"-r7.json");
    expect(parsed).toMatchObject({
      format:CAS_UNCOMMITTED_DRAFT_FORMAT,schemaVersion:1,
      authoritative:false,automaticRestore:false,uncommitted:true,
      base:base.snapshot,
      draft:{
        config:{name:input.name,description:input.description,
          requirements:input.requirements},
        manualStage:"technical",manualOutput:input.manualOutput,
        codeRequest:input.codeRequest,
        codeProposalJson:input.codeProposalJson,
      },
    });
    expect(parsed.draft.stack.deployment).toBe("aws");
    expect(parsed.warning).toMatch(/STALE/);
    expect(parsed.warning).toMatch(/NEVER committed/);
    expect(backup.raw).not.toContain("authorization");
    expect(Object.isFrozen(backup)).toBe(true);
  });
  it("works with a stale pinned snapshot and never touches IDB, localStorage, sessionStorage or network",()=>{
    const input={...fixture(),requirements:"UNCOMMITTED secret text; no sync"};
    const forbidden=vi.fn(()=>{throw Error("SECRET_IO_NOT_ALLOWED");});
    vi.stubGlobal("indexedDB",{open:forbidden});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("fetch",forbidden);
    const backup=prepareCasUncommittedDraftBackup(input);
    expect(JSON.parse(backup.raw).base.revision).toBe(7);
    expect(JSON.parse(backup.raw).draft.config.requirements)
      .toBe("UNCOMMITTED secret text; no sync");
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("does not export a fake recovery if nothing is dirty",()=>{
    expect(()=>prepareCasUncommittedDraftBackup(fixture()))
      .toThrow(/non esportabile/);
  });
  it("fails closed on invalid canonical source, id/revision and oversize drafts",()=>{
    const f=fixture();
    const wrongRaw=JSON.stringify({...JSON.parse(f.snapshot.raw),
      id:"11111111-1111-4111-8111-111111111194"});
    for(const value of [
      {...f,requirements:"dirty",snapshot:{...f.snapshot,raw:wrongRaw}},
      {...f,requirements:"dirty",snapshot:{...f.snapshot,revision:0}},
      {...f,requirements:"dirty",snapshot:{...f.snapshot,revision:Number.MAX_SAFE_INTEGER}},
      {...f,requirements:"dirty",snapshot:{...f.snapshot,raw:f.snapshot.raw+" "}},
      {...f,requirements:"dirty",name:"x".repeat(121)},
      {...f,requirements:"dirty",codeProposalJson:"a".repeat(145_001)},
      {...f,requirements:"dirty",manualOutput:"a".repeat(60_001)},
      {...f,requirements:"dirty",manualStage:"unknown" as never},
      {...f,requirements:"dirty",stack:{...f.stack!,deployment:"invalid" as never}},
    ])expect(()=>prepareCasUncommittedDraftBackup(value))
      .toThrow(/non esportabile/);
  });
  it("does not serialize extra injected secrets/settings as top-level fields",()=>{
    const input={...fixture(),manualOutput:"Human text",settings:{
      apiKey:"MUST_NOT_LEAK_IN_ARCHIVE",token:"MUST_NOT_LEAK_IN_ARCHIVE",
    }};
    const backup=prepareCasUncommittedDraftBackup(input);
    expect(backup.raw).not.toContain("MUST_NOT_LEAK_IN_ARCHIVE");
    expect(JSON.parse(backup.raw).draft.manualOutput).toBe("Human text");
  });
});
