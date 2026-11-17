import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import { publishGithubWorkspace, importGithubWorkspace } from "./github-publication";
import { encodeGithubWorkspace, githubProjectDirty } from "./github-workspace";
import { persistProject, persistProjectIfUnchanged, localProjectSnapshot, listLocalProjects, loadLocalProject, saveSecret } from "./store";
import type { FactoryProject, GitConfig } from "../domain/types";

const SHA = "a".repeat(40), NEXT = "d".repeat(40);
const PAT = "github_pat_" + "x".repeat(50);
const git: GitConfig = { owner: "octocat", repo: "demo", branch: "main",
  privateRepo: true, authMode: "pat", appGateway: "" };
const makeProject = () => {
  const p = createProject(); p.config.name = "Test App"; p.config.description = "Testable app";
  return p;
};
function mockGitHub(p: FactoryProject, opts: {public?:boolean;existing?:FactoryProject;head?:string}={}) {
  const calls: Array<{url:string; init:RequestInit}> = [];
  let head = opts.head ?? SHA;
  vi.stubGlobal("fetch", vi.fn(async (url:string, init:RequestInit={}) => {
    calls.push({url,init});
    const method = init.method || "GET";
    let output: unknown = {};
    let status = 200;
    if (url.endsWith("/repos/octocat/demo")) {
      output = { name:"demo",owner:{login:"octocat"},default_branch:"main",
        private:opts.public !== true,archived:false,disabled:false,
        permissions:{push:true} };
    } else if (url.includes("/git/ref/heads/main") && method === "GET") output={ object:{ sha:head } };
    else if (url.includes("/contents/.softwarefactory/workspace-state.v1.json")) {
      if (!opts.existing) status=404;
      else {
        const text=encodeGithubWorkspace(opts.existing);
        output = {type:"file",encoding:"base64",size:text.length,
          content:btoa(unescape(encodeURIComponent(text)))};
      }
    } else if (url.includes("/git/commits/") && method === "GET")
      output={tree:{sha:"b".repeat(40)}};
    else if (url.endsWith("/git/trees") && method==="POST") output={sha:"c".repeat(40)};
    else if (url.endsWith("/git/commits") && method==="POST") output={sha:NEXT};
    else if (url.includes("/git/refs/heads/main") && method==="PATCH") { head=NEXT; output={object:{sha:NEXT}}; }
    else throw Error("Unexpected GitHub API "+method+" "+url);
    return {ok:status<400,status,json:async()=>output,
      text:async()=>JSON.stringify(output)};
  }));
  return calls;
}
describe("GitHub commit and local multi-project sync safety", () => {
  const storage = new Map<string,string>();
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage",{
      getItem: (k:string)=>storage.get(k)??null,
      setItem: (k:string,v:string)=>{storage.set(k,v);},
      removeItem: (k:string)=>{storage.delete(k);},
    });
    vi.stubGlobal("sessionStorage", {
      getItem: (k:string)=>storage.get("session."+k)??null,
      setItem: (k:string,v:string)=>{storage.set("session."+k,v);},
      removeItem: (k:string)=>{storage.delete("session."+k);},
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("persists many projects without PAT in local library and restores distinct repos", () => {
    const a=makeProject(),b=makeProject();
    a.githubDestination={...git};
    b.githubDestination={...git,repo:"second"};
    saveSecret("github.pat",PAT);
    persistProject(a); persistProject(b);
    expect(listLocalProjects()).toHaveLength(2);
    expect(loadLocalProject(a.id).githubDestination?.repo).toBe("demo");
    expect(loadLocalProject(b.id).githubDestination?.repo).toBe("second");
    expect(JSON.stringify([...storage].filter(([k])=>!k.startsWith("session.")))).not.toContain(PAT);
    expect(()=>loadLocalProject("../secret")).toThrow();
  });
  it("blocks a stale tab from silently overwriting a project modified in another tab", () => {
    const local = makeProject();
    persistProject(local);
    const baseline = localProjectSnapshot(local.id);
    expect(baseline).not.toBeNull();
    const fromOtherTab = {...local,config:{...local.config,name:"Other-tab change"},
      updatedAt:"2026-11-17T14:00:00Z"};
    persistProject(fromOtherTab);
    const stale = {...local,config:{...local.config,name:"Stale tab edit"}};
    expect(() => persistProjectIfUnchanged(stale,baseline)).toThrow(/Conflitto locale/);
    expect(loadLocalProject(local.id).config.name).toBe("Other-tab change");
    const latestBaseline=localProjectSnapshot(local.id);
    expect(persistProjectIfUnchanged({...fromOtherTab,config:{...fromOtherTab.config,name:"Approved edit"}},latestBaseline))
      .toContain("Approved edit");
  });
  it("publishes source and checkpoint in one fast-forward commit and records exact HEAD", async () => {
    const p=makeProject();
    const calls=mockGitHub(p);
    const result=await publishGithubWorkspace(p,git,PAT);
    expect(result.sha).toBe(NEXT);
    expect(result.project.githubSync).toMatchObject({
      owner:"octocat",repo:"demo",branch:"main",lastCommit:NEXT,
      syncedLocalUpdatedAt:p.updatedAt,publicConsent:false,
    });
    expect(githubProjectDirty(result.project,git)).toBe(false);
    const tree=calls.find(x=>x.url.endsWith("/git/trees"))?.init;
    expect(tree?.method).toBe("POST");
    const paths=JSON.parse(tree?.body as string).tree.map((f:{path:string})=>f.path);
    expect(paths).toContain(".softwarefactory/workspace-state.v1.json");
    expect(JSON.stringify(tree?.body)).not.toContain(PAT);
    const update=calls.find(x=>x.url.includes("/git/refs/heads/main") &&
      x.init.method==="PATCH")?.init;
    expect(JSON.parse(update?.body as string).force).toBe(false);
  });
  it("never acknowledges a push when the remote ref moves immediately after PATCH", async () => {
    const p=makeProject();
    const history=mockGitHub(p);
    const githubFetch=fetch as ReturnType<typeof vi.fn>;
    const original=githubFetch.getMockImplementation()!;
    let verifiedReads=0;
    githubFetch.mockImplementation(async (url:string,init:RequestInit={}) => {
      if (url.includes("/git/ref/heads/main") && (init.method??"GET")==="GET") {
        verifiedReads++;
        if (verifiedReads >= 3)
          return {ok:true,status:200,text:async()=>JSON.stringify({
            object:{sha:"f".repeat(40)},
          })};
      }
      return original(url,init);
    });
    await expect(publishGithubWorkspace(p,git,PAT)).rejects.toThrow(/HEAD diversa/);
    expect(history.some(x=>x.init.method==="PATCH")).toBe(true);
  });
  it("refuses public repo without explicit consent even when configured private", async () => {
    const p=makeProject();
    const calls=mockGitHub(p,{public:true});
    await expect(publishGithubWorkspace(p,git,PAT)).rejects.toThrow(/PUBBLICA/);
    expect(calls.some(x=>x.init.method==="POST"||x.init.method==="PATCH")).toBe(false);
    const published=await publishGithubWorkspace(p,git,PAT,true);
    expect(published.project.githubSync?.publicConsent).toBe(true);
  });
  it("never carries public consent from a different destination, even with same PAT", async () => {
    const p=makeProject();
    p.githubSync={owner:"octocat",repo:"other-app",branch:"main",lastCommit:SHA,
      syncedLocalUpdatedAt:p.updatedAt,syncedAt:new Date().toISOString(),publicConsent:true};
    const calls=mockGitHub(p,{public:true});
    await expect(publishGithubWorkspace(p,git,PAT)).rejects.toThrow(/PUBBLICA/);
    expect(calls.some(x=>x.init.method==="POST"||x.init.method==="PATCH")).toBe(false);
    await expect(publishGithubWorkspace(p,git,PAT,true)).resolves.toMatchObject({
      project:{githubSync:{publicConsent:true,repo:"demo"}},
    });
  });
  it("fails closed if remote commit moved after last local acknowledgement", async () => {
    const p=makeProject();
    p.githubSync={owner:git.owner,repo:git.repo,branch:"main",lastCommit:SHA,
      syncedLocalUpdatedAt:p.updatedAt,syncedAt:new Date().toISOString()};
    const calls=mockGitHub(p,{head:"e".repeat(40)});
    await expect(publishGithubWorkspace(p,git,PAT)).rejects.toThrow(/Conflitto/);
    expect(calls.some(x=>x.init.method==="POST"||x.init.method==="PATCH")).toBe(false);
  });
  it("refuses overwrite of existing SoftwareFactory checkpoint when first binding is unknown", async () => {
    const current=makeProject(),other=makeProject();
    const calls=mockGitHub(current,{existing:other});
    await expect(publishGithubWorkspace(current,git,PAT)).rejects.toThrow(/Importalo/);
    expect(calls.some(x=>x.init.method==="POST"||x.init.method==="PATCH")).toBe(false);
    const imported=await importGithubWorkspace(current,git,PAT);
    expect(imported.project.id).toBe(other.id);
    expect(imported.project.githubSync?.lastCommit).toBe(SHA);
  });
});
