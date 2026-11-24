import {describe,expect,it,vi,afterEach} from "vitest";
import {createProject} from "../domain/defaults";
import {readCasIsolatedStackConfig} from "./cas-isolated-stack-config";
import {
  CAS_UNCOMMITTED_DRAFT_FORMAT,prepareCasUncommittedDraftBackup,
  inspectCasUncommittedDraftBackup,MAX_CAS_UNCOMMITTED_DRAFT_FILE_BYTES,
} from "./cas-uncommitted-draft-backup";
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

  it("reads a byte-canonical Unicode emergency file for manual inspection only (#195)",()=>{
    const f=fixture();
    const input={...f,name:"星 🌙 source",
      requirements:"Testo umano non confermato\n  second line",
      manualStage:"technical" as const,manualOutput:"Human result <script>alert(1)</script>",
      codeRequest:"Draft code request",
      codeProposalJson:'{"source":"still unreviewed"}',
      stack:{...f.stack!,deployment:"aws" as const}};
    const archive=prepareCasUncommittedDraftBackup(input);
    const projection=inspectCasUncommittedDraftBackup(archive.raw);
    expect(projection).toEqual({
      id:f.snapshot.id,revision:7,originalName:"Baseline name",
      config:{name:input.name,description:input.description,
        requirements:input.requirements},
      stack:input.stack,manualStage:"technical",
      manualOutput:input.manualOutput,codeRequest:input.codeRequest,
      codeProposalJson:input.codeProposalJson,
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.config)).toBe(true);
    expect(projection.originalName).not.toBe(projection.config.name);
    expect(archive.raw).toContain('"authoritative": false');
  });
  it("inspects the STALE base without touching IDB, localStorage or the network (#195)",()=>{
    const f=fixture(),archive=prepareCasUncommittedDraftBackup(
      {...f,requirements:"Never persisted, rival won"});
    const forbidden=vi.fn(()=>{throw Error("NO_IO_ALLOWED");});
    vi.stubGlobal("indexedDB",{open:forbidden});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("fetch",forbidden);
    const inspect=inspectCasUncommittedDraftBackup(archive.raw);
    expect(inspect.revision).toBe(7);
    expect(inspect.config.requirements).toBe("Never persisted, rival won");
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("refuses noncanonical JSON, wrong flags, injected fields, corrupt source or malformed drafts (#195)",()=>{
    const f=fixture(),archive=prepareCasUncommittedDraftBackup(
      {...f,requirements:"recover"});
    const parsed=JSON.parse(archive.raw);
    const mutated=[
      {...parsed,authoritative:true},
      {...parsed,automaticRestore:true},
      {...parsed,uncommitted:false},
      {...parsed,format:"softwarefactory-cas-library-backup"},
      {...parsed,schemaVersion:2},
      {...parsed,unexpected:"privileged extra"},
      {...parsed,warning:"TRUSTED OFFICIAL REPORT"},
      {...parsed,base:{...parsed.base,raw:parsed.base.raw+" "}},
      {...parsed,base:{...parsed.base,revision:-1}},
      {...parsed,draft:{...parsed.draft,arbitrarySecret:"key"}},
      {...parsed,draft:{...parsed.draft,manualStage:"unknown"}},
      {...parsed,draft:{...parsed.draft,codeRequest:"x".repeat(2_001)}},
    ];
    for(const bad of mutated)
      expect(()=>inspectCasUncommittedDraftBackup(JSON.stringify(bad,null,2)))
        .toThrow(/non esportabile/);
    expect(()=>inspectCasUncommittedDraftBackup(
      JSON.stringify(parsed))).toThrow(/non esportabile/);
    expect(()=>inspectCasUncommittedDraftBackup(
      archive.raw.replace('"schemaVersion": 1',
        '"schemaVersion": 1, "schemaVersion": 1')))
      .toThrow(/non esportabile/);
    expect(()=>inspectCasUncommittedDraftBackup(
      "x".repeat(MAX_CAS_UNCOMMITTED_DRAFT_FILE_BYTES+1)))
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
