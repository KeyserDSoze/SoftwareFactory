import {describe,expect,it,vi,afterEach} from "vitest";
import {createProject,STAGES} from "../domain/defaults";
import {
  CAS_STAGE_PREVIEW_CHARS,CAS_STAGE_PREVIEW_SOURCES,
  inspectCasIsolatedStages,safeCasStageSourceHref,
} from "./cas-isolated-stage-inspection";

const fixture=()=>{
  const project=createProject();
  project.config.name="CAS stage inspection";
  const snapshot={id:project.id,revision:2,raw:JSON.stringify(project)};
  return {project,snapshot};
};
const snap=(project:ReturnType<typeof createProject>,revision=2)=>({
  id:project.id,revision,raw:JSON.stringify(project),
});
describe("read-only CAS stage inspection (#158)",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("shows canonical ordered stage status and only evidence-bearing AI text",()=>{
    const {project}=fixture();
    project.stages[0].status="complete";
    project.stages[0].output="<img src=x onerror=alert(1)> actual AI text";
    project.stages[1].status="running";
    project.stages[2].status="failed";
    project.stages[2].error="UNTRUSTED_PROVIDER_SECRET_NOT_FOR_UI";
    const rows=inspectCasIsolatedStages(snap(project));
    expect(rows).toHaveLength(STAGES.length);
    expect(rows?.map(row=>row.id)).toEqual(STAGES.map(s=>s.id));
    expect(rows?.map(row=>row.status).slice(0,4))
      .toEqual(["complete","running","failed","pending"]);
    expect(rows?.[0].output).toContain("<img src=x onerror");
    expect(JSON.stringify(rows)).not.toContain("UNTRUSTED_PROVIDER_SECRET_NOT_FOR_UI");
    expect(Object.isFrozen(rows)).toBe(true);
  });
  it("never upgrades empty completion, dirty pending/running or malformed raw",()=>{
    const {project,snapshot}=fixture();
    project.stages[0].status="complete";
    project.stages[0].output=" ";
    project.stages[1].status="running";
    project.stages[1].output="stale completed text";
    project.stages[2].status="pending";
    project.stages[2].sources=[{title:"bad",url:"javascript:alert(1)",
      snippet:"text",query:"x",fetchedAt:"2026-11-22T10:00:00Z"}];
    expect(inspectCasIsolatedStages(snap(project))?.slice(0,3).map(r=>r.status))
      .toEqual(["invalid","invalid","invalid"]);
    expect(inspectCasIsolatedStages({...snapshot,raw:snapshot.raw+" "}))
      .toBeNull();
    expect(inspectCasIsolatedStages({...snapshot,id:"different"})).toBeNull();
    expect(inspectCasIsolatedStages({...snapshot,revision:0})).toBeNull();
    expect(inspectCasIsolatedStages({...snapshot,raw:"{"})).toBeNull();
    expect(inspectCasIsolatedStages(null)).toBeNull();
    const bad=[{...project,stages:project.stages.slice(0,4)},
      {...project,stages:project.stages.map((s,i)=>
        i===2?{...s,id:"features"}:s)},
      {...project,stages:project.stages.map((s,i)=>
        i===2?{...s,status:"approved"}:s)},
      {...project,stages:project.stages.map((s,i)=>
        i===2?{...s,sources:"bad"}:s)}];
    for(const p of bad)
      expect(inspectCasIsolatedStages({...snapshot,raw:JSON.stringify(p)}))
        .toBeNull();
  });
  it("links only HTTPS without credentials, never javascript/http/data",()=>{
    for(const value of ["javascript:alert(1)","data:text/html,x",
      "http://example.com","http://localhost:1234","https://a:b@example.com",
      "https://example.com/\nnew"," https://example.com","ftp://example.com",
      "https://example.com:bad/","https://example.com/".repeat(180)])
      expect(safeCasStageSourceHref(value)).toBeNull();
    expect(safeCasStageSourceHref("https://example.org/research?q=1"))
      .toBe("https://example.org/research?q=1");
    expect(safeCasStageSourceHref(undefined)).toBeNull();
    expect(safeCasStageSourceHref({url:"https://example.com"})).toBeNull();
  });
  it("caps AI text and source preview without discarding the exact snapshot",()=>{
    const {project}=fixture();
    project.stages[0].status="complete";
    project.stages[0].output="a".repeat(CAS_STAGE_PREVIEW_CHARS+900);
    project.stages[0].sources=Array.from({length:CAS_STAGE_PREVIEW_SOURCES+3},
      (_,i)=>({
        title:"A".repeat(200),url:i===0?"https://example.org/ref":"javascript:bad",
        snippet:"Z".repeat(600),query:"test",fetchedAt:"2026-11-22T10:00:00Z",
      }));
    const input=snap(project);
    const rows=inspectCasIsolatedStages(input);
    expect(rows?.[0].output.length).toBe(CAS_STAGE_PREVIEW_CHARS);
    expect(rows?.[0].outputTruncated).toBe(true);
    expect(rows?.[0].sources).toHaveLength(CAS_STAGE_PREVIEW_SOURCES);
    expect(rows?.[0].sourceTotal).toBe(CAS_STAGE_PREVIEW_SOURCES+3);
    expect(rows?.[0].sourcesTruncated).toBe(true);
    expect(rows?.[0].sources[0].href).toBe("https://example.org/ref");
    expect(rows?.[0].sources[1].href).toBeNull();
    expect(rows?.[0].sources[0].title.length).toBe(160);
    expect(rows?.[0].sources[0].snippet.length).toBe(320);
    expect(input.raw).toContain("a".repeat(CAS_STAGE_PREVIEW_CHARS+900));
    expect(Object.isFrozen(rows?.[0].sources)).toBe(true);
  });
  it("never reads or writes any browser storage or executes source content",()=>{
    const {project}=fixture();
    const forbidden=vi.fn(()=>{throw Error("STORAGE_ACCESS_DENIED");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    project.stages[0].status="complete";
    project.stages[0].output="<script>alert('never')</script>";
    const view=inspectCasIsolatedStages(snap(project));
    expect(view?.[0].output).toContain("<script>");
    expect(forbidden).not.toHaveBeenCalled();
  });
});
