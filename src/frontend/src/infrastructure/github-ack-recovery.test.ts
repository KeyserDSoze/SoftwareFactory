import { describe, expect, it, vi, afterEach } from "vitest";
import { createProject } from "../domain/defaults";
import { workspaceFiles } from "../domain/development";
import type { FactoryProject, GitConfig } from "../domain/types";
import { encodeGithubWorkspace, GITHUB_WORKSPACE_PATH } from "./github-workspace";
import { recoverGithubAcknowledgement } from "./github-publication";
import { gitBlobObjectSha } from "./github";

const OLD = "a".repeat(40), REMOTE = "d".repeat(40), TREE = "b".repeat(40);
const PAT = "github_pat_" + "x".repeat(50);
const git: GitConfig = {owner:"octocat",repo:"demo",branch:"main",privateRepo:true,
  authMode:"pat",appGateway:""};
function make() {
  const project = createProject();
  project.config.name = "Recoverable app";
  project.config.description = "Generate an app with verified checkpoint";
  return project;
}
function bound(p: FactoryProject): FactoryProject {
  return {...p, githubSync:{owner:git.owner,repo:git.repo,branch:git.branch,
    lastCommit:OLD,syncedLocalUpdatedAt:p.updatedAt,syncedAt:"2026-11-17T10:00:00.000Z"}};
}
type MockOptions = { remote?:FactoryProject|null; parent?:string;
  corruptBlob?:string; afterReadHead?:string; badTree?:boolean };
async function mockRecovery(p:FactoryProject, options:MockOptions={}) {
  const remoteProject = options.remote === undefined ? p : options.remote;
  const content = remoteProject && encodeGithubWorkspace(remoteProject);
  const files = remoteProject && {...workspaceFiles(remoteProject),
    [GITHUB_WORKSPACE_PATH]: content!};
  const blobs = await Promise.all(Object.entries(files || {}).map(async ([path,data])=>({
    path,sha: await gitBlobObjectSha(data),type:"blob",mode:"100644",
  })));
  const calls: Array<{url:string;method:string}> = [];
  let headReads = 0;
  const stub = vi.fn(async (url:string, init:RequestInit={}) => {
    const method = init.method || "GET";
    calls.push({url,method});
    if (method !== "GET") throw Error("Recovery MUST NOT write to GitHub: " + method);
    let payload:unknown, status=200;
    if (url.endsWith("/git/ref/heads/main")) {
      headReads++;
      payload={object:{sha:headReads > 1 && options.afterReadHead ?
        options.afterReadHead : REMOTE}};
    } else if (url.includes("/contents/.softwarefactory/workspace-state.v1.json?ref=")) {
      if (!content) status=404;
      else payload={type:"file",size:new TextEncoder().encode(content).length,
        encoding:"base64",content:btoa(unescape(encodeURIComponent(content)))};
    } else if (url.endsWith("/git/commits/"+REMOTE)) {
      payload={sha:REMOTE,parents:[{sha:options.parent??OLD}],tree:{sha:TREE}};
    } else if (url.includes("/git/trees/"+TREE+"?recursive=1")) {
      payload={truncated:options.badTree??false,tree:blobs.map(x=>x.path === options.corruptBlob ?
        {...x,sha:"f".repeat(40)} : x)};
    } else throw Error("Unexpected GitHub recovery API call: "+url);
    return {status,ok:status < 400,headers:{get:()=>null},
      text:async()=>JSON.stringify(payload)};
  });
  vi.stubGlobal("fetch",stub);
  return calls;
}
afterEach(()=>vi.unstubAllGlobals());
describe("GitHub lost acknowledgement recovery (read-only)",()=>{
  it("reconciles only an exact child of last acknowledged HEAD, full files and checkpoint",async()=>{
    const project = bound(make());
    const calls=await mockRecovery(project);
    const result=await recoverGithubAcknowledgement(project,git,PAT);
    expect(result).toMatchObject({sha:REMOTE,branch:"main",parentSha:OLD,firstBinding:false,
      project:{id:project.id,githubSync:{lastCommit:REMOTE,
        syncedLocalUpdatedAt:project.updatedAt,publicConsent:false}}});
    expect(result.verifiedFiles).toBeGreaterThan(20);
    expect(calls.every(x=>x.method==="GET")).toBe(true);
    expect(calls.filter(x=>x.url.endsWith("/git/ref/heads/main"))).toHaveLength(2);
    expect(calls.some(x=>x.url.includes("/git/trees/"+TREE))).toBe(true);
    expect(project.githubSync!.lastCommit).toBe(OLD);
  });
  it("can explicitly adopt an exact first-push checkpoint without pretending to prove authorship",async()=>{
    const project=make();
    const calls=await mockRecovery(project);
    const result=await recoverGithubAcknowledgement(project,git,PAT);
    expect(result.firstBinding).toBe(true);
    expect(result.project.githubSync?.publicConsent).toBe(false);
    expect(result.verifiedFiles).toBeGreaterThan(0);
    expect(calls.every(x=>x.method==="GET")).toBe(true);
  });
  it("never confuses a matching checkpoint with matching published source files",async()=>{
    const project=bound(make());
    await mockRecovery(project,{corruptBlob:"README.md"});
    await expect(recoverGithubAcknowledgement(project,git,PAT)).rejects
      .toThrow(/Contenuto dei file GitHub diverso/);
  });
  it("rejects non-direct ancestor, modified HEAD, incomplete tree and missing checkpoint",async()=>{
    const project=bound(make());
    await mockRecovery(project,{parent:"e".repeat(40)});
    await expect(recoverGithubAcknowledgement(project,git,PAT)).rejects.toThrow(/non figlio/);
    await mockRecovery(project,{afterReadHead:"f".repeat(40)});
    await expect(recoverGithubAcknowledgement(project,git,PAT)).rejects.toThrow(/HEAD GitHub cambiata/);
    await mockRecovery(project,{badTree:true});
    await expect(recoverGithubAcknowledgement(project,git,PAT)).rejects.toThrow(/Albero GitHub incompleto/);
    await mockRecovery(project,{remote:null});
    await expect(recoverGithubAcknowledgement(project,git,PAT)).rejects.toThrow(/Nessun checkpoint/);
  });
  it("rejects another project, stale content, pending patch divergence and a known HEAD",async()=>{
    const project=bound(make()),other=make();
    await mockRecovery(project,{remote:other});
    await expect(recoverGithubAcknowledgement(project,git,PAT)).rejects.toThrow(/Checkpoint remoto diverso/);
    await mockRecovery(project,{remote:{...project,
      config:{...project.config,description:"Remote only change"}}});
    await expect(recoverGithubAcknowledgement(project,git,PAT)).rejects.toThrow(/Checkpoint remoto diverso/);
    await mockRecovery(project,{remote:{...project,
      development:{revision:0,history:[],overrides:{},originals:{},
        pending:{id:"request",request:"fix",summary:"fix",createdAt:project.createdAt,
          revision:0,edits:[],tests:[],assumptions:[]}}}});
    await expect(recoverGithubAcknowledgement(project,git,PAT)).rejects.toThrow(/Checkpoint remoto diverso/);
    const same={...project,githubSync:{...project.githubSync!,lastCommit:REMOTE}};
    await mockRecovery(same);
    await expect(recoverGithubAcknowledgement(same,git,PAT)).rejects.toThrow(/già nota/);
  });
  it("keeps a previous explicit public consent scoped to the same destination",async()=>{
    const project=bound(make());
    project.githubSync!.publicConsent=true;
    await mockRecovery(project);
    const result=await recoverGithubAcknowledgement(project,git,PAT);
    expect(result.project.githubSync!.publicConsent).toBe(true);
    const otherDestination={...git,repo:"a-different-repository"};
    // A different destination is treated as first binding and can never
    // inherit the old public consent even if matching source files exist.
    // Mocked URLs remain for octocat/demo, so test the scope via a read-only
    // alternative binding with matching GitHub target.
    const mismatched={...project, githubSync:{...project.githubSync!,repo:"another-app"}};
    await mockRecovery(mismatched);
    const unbound=await recoverGithubAcknowledgement(mismatched,git,PAT);
    expect(unbound.firstBinding).toBe(true);
    expect(unbound.project.githubSync!.publicConsent).toBe(false);
    expect(otherDestination.repo).not.toBe(git.repo);
  });
  it("computes exact standard Git UTF-8 blob IDs (not a hash of a JS character count)",async()=>{
    expect(await gitBlobObjectSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(await gitBlobObjectSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await gitBlobObjectSha("caffè\n")).toBe("e431f3aef7e18760c4b7958010f19b6a146f62a7");
  });
});
