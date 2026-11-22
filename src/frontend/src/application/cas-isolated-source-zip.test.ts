import {afterEach,describe,expect,it,vi} from "vitest";
import {zipSync,strToU8,unzipSync,strFromU8} from "fflate";
import {createProject} from "../domain/defaults";
import {allowedCodePath,workspaceFiles} from "../domain/development";
import {generateFiles} from "./scaffold";
import {serializeCasProject} from "../infrastructure/project-cas";
import {buildCasIsolatedPendingCodePatch} from "./cas-isolated-code-patch";
import {prepareCasIsolatedSourceZip} from "./cas-isolated-source-zip";

const fixture=()=>{
  const p=createProject();
  p.config.name="IndexedDB only scaffold";
  p.config.description="Generate a full-stack application safely";
  return p;
};
const ticket=(p:ReturnType<typeof fixture>,revision=4)=>({
  id:p.id,revision,raw:serializeCasProject(p),
});
const pack=(p:ReturnType<typeof fixture>)=>{
  const t=prepareCasIsolatedSourceZip(ticket(p));
  const archive=Object.fromEntries(Object.entries(t.files)
    .map(([path,text])=>[path,strToU8(text)]));
  return {t,zip:unzipSync(zipSync(archive,{level:6}))};
};

describe("CAS native source-only ZIP projection #165",()=>{
  afterEach(()=>vi.unstubAllGlobals());

  it("bundles the pinned generated scaffold plus a static unverified provenance note",()=>{
    const p=fixture(),expected=workspaceFiles(p);
    const {t,zip}=pack(p);
    expect(t.id).toBe(p.id);
    expect(t.revision).toBe(4);
    expect(t.raw).toBe(serializeCasProject(p));
    expect(t.fileName).toBe(
      "softwarefactory-idb-sources-"+p.id+"-r4.zip");
    expect(strFromU8(zip["README.md"])).toBe(expected["README.md"]);
    expect(strFromU8(zip["docs/cas-idb-export-provenance.md"]))
      .toContain("NOT a proof of successful compilation");
    expect(Object.isFrozen(t)).toBe(true);
    expect(Object.isFrozen(t.files)).toBe(true);
    expect(Object.keys(t.files).length).toBeGreaterThan(10);
  });

  it("never packages a pending human Code Agent edit, even after staging",()=>{
    const p=fixture(),path="src/frontend/web/src/Unreviewed165.tsx";
    const dangerous="export const UNREVIEWED_DO_NOT_EXPORT_165 = 1;";
    const staged=buildCasIsolatedPendingCodePatch(ticket(p),
      "Unreviewed human input",JSON.stringify({summary:"Not reviewed",
        files:[{path,content:dangerous,reason:"Proposed only"}]}));
    const before=ticket(staged);
    const {t,zip}=pack(staged);
    expect(t.raw).toBe(before.raw);
    expect(staged.development?.pending?.edits[0].content).toBe(dangerous);
    expect(t.files[path]).toBeUndefined();
    expect(zip[path]).toBeUndefined();
    expect(JSON.stringify(t.files)).not.toContain(dangerous);
    expect(strFromU8(zip["docs/cas-idb-export-provenance.md"]))
      .toContain("Unreviewed Code Agent pending edits were NOT included");
  });

  it("includes applied overrides but never exports an unverified history review claim",()=>{
    const p=fixture(),path="src/frontend/web/src/Applied165.tsx";
    p.development={
      revision:1,overrides:{[path]:"export const APPLIED_FROM_SNAPSHOT=1;"},
      originals:{[path]:null},
      history:[{id:"applied-165",request:"local",summary:"Operator history",
        appliedAt:"2026-11-22T15:00:00Z",
        edits:[{path,previous:null,content:"export const APPLIED_FROM_SNAPSHOT=1;",
          reason:"operator"}],
        review:{verdict:"pass",report:"UNVERIFIED_REVIEW_CLAIM_165",
          completedAt:"2026-11-22T15:00:00Z"},status:"applied"}],
    };
    const {zip,t}=pack(p);
    expect(strFromU8(zip[path])).toBe("export const APPLIED_FROM_SNAPSHOT=1;");
    expect(zip["docs/feature-implementation.md"]).toBeUndefined();
    expect(JSON.stringify(t.files)).not.toContain("UNVERIFIED_REVIEW_CLAIM_165");
    expect(strFromU8(zip["docs/cas-idb-export-provenance.md"]))
      .toContain("historical feature-implementation log was omitted");
  });

  it("rejects forged token, malformed stage, path traversal and dishonest applied baseline",()=>{
    const p=fixture(),snap=ticket(p);
    expect(()=>prepareCasIsolatedSourceZip({...snap,id:"wrong"})).toThrow();
    expect(()=>prepareCasIsolatedSourceZip({...snap,revision:0})).toThrow();
    expect(()=>prepareCasIsolatedSourceZip({...snap,raw:snap.raw+" "}))
      .toThrow();
    p.stages[0].completionOrigin="ai";
    expect(()=>prepareCasIsolatedSourceZip(ticket(p))).toThrow();
    delete p.stages[0].completionOrigin;
    const name=Object.keys(generateFiles(p)).find(allowedCodePath)!;
    p.development={revision:2,
      overrides:{[name]:"export const ok=1;"},
      originals:{[name]:"forged baseline"},
      history:[]};
    expect(()=>prepareCasIsolatedSourceZip(ticket(p))).toThrow();
    p.development.overrides={"../../.github/workflows/evil.yml":"bad"};
    p.development.originals={"../../.github/workflows/evil.yml":null};
    expect(()=>prepareCasIsolatedSourceZip(ticket(p))).toThrow();
    p.development.overrides={"src/frontend/web/src/Evil165.tsx":
      "github_pat_"+"a".repeat(25)};
    p.development.originals={"src/frontend/web/src/Evil165.tsx":null};
    expect(()=>prepareCasIsolatedSourceZip(ticket(p))).toThrow();
  });

  it("rejects mismatched originals and oversized/unsafe overrides",()=>{
    const p=fixture(),path="src/frontend/web/src/Applied165.tsx";
    p.development={revision:1,overrides:{[path]:"export const x=1;"},
      originals:{},history:[]};
    expect(()=>prepareCasIsolatedSourceZip(ticket(p))).toThrow();
    p.development.originals={[path]:null};
    p.development.overrides[path]="x".repeat(32_001);
    expect(()=>prepareCasIsolatedSourceZip(ticket(p))).toThrow();
    p.development.overrides[path]="sk-"+"a".repeat(25);
    expect(()=>prepareCasIsolatedSourceZip(ticket(p))).toThrow();
  });

  it("never reads legacy storage, IDB, session tokens or network",()=>{
    const forbidden=vi.fn(()=>{throw Error("EXTERNAL_IO_FORBIDDEN");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    vi.stubGlobal("fetch",forbidden);
    const p=fixture();
    const t=prepareCasIsolatedSourceZip(ticket(p));
    expect(t.files["README.md"]).toContain("SoftwareFactory");
    expect(forbidden).not.toHaveBeenCalled();
  });
});
