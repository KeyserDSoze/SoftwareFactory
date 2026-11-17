import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../domain/defaults";
import { encodeGithubWorkspace, decodeGithubWorkspace, portableGithubProject, inspectGithubWorkspace,
  githubProjectDirty, githubBindingMatches } from "./github-workspace";
import { encryptGithubPatCloud, decryptGithubPatCloud,
  validateGithubPatVault } from "./github-pat-cloud-crypto";
import { assertGithubPat, sealGithubPat, unsealGithubPat } from "./github-pat-device";
import { saveSecret } from "./store";
import { saveGithubPatToCloud, restoreGithubPatFromCloud } from "./github-pat-cloud";
import { findGithubRepositories } from "./github-discovery";
import type { GitConfig } from "../domain/types";

const PAT = "github_pat_" + "x".repeat(50);
const PWD = "very secret cloud vault passphrase";
const git: GitConfig = { owner: "octocat", repo: "app", branch: "main",
  authMode: "pat", privateRepo: true, appGateway: "" };
const sha = "a".repeat(40);
const project = () => {
  const p = createProject();
  p.config.name = "Example App";
  p.config.description = "An app used in tests.";
  return p;
};
describe("GitHub BookWriter parity: PAT, cloud, discovery and checkpoints", () => {
  beforeEach(() => {
    const map = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("device key is nonextractable and AES-GCM PAT ciphertext does not reveal plaintext", async () => {
    expect(assertGithubPat(PAT)).toBe(PAT);
    expect(() => assertGithubPat("short")).toThrow();
    const key = await crypto.subtle.generateKey({name: "AES-GCM",length:256},false,["encrypt","decrypt"]);
    expect(key.extractable).toBe(false);
    const first = await sealGithubPat(PAT,key);
    const second = await sealGithubPat(PAT,key);
    expect(JSON.stringify(first)).not.toContain(PAT);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(await unsealGithubPat(first,key)).toBe(PAT);
    await expect(unsealGithubPat({...first,iv:(first.iv[0] === "A" ? "B" : "A") + first.iv.slice(1)},key)).rejects.toThrow();
    await expect(unsealGithubPat({...first,token:PAT},key)).rejects.toThrow();
  });
  it("cloud E2EE PAT uses fresh salt/IV, strict field schema and rejects wrong password", async () => {
    const first = await encryptGithubPatCloud(PAT,PWD);
    const second = await encryptGithubPatCloud(PAT,PWD);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(JSON.stringify(first)).not.toContain(PAT);
    expect(JSON.stringify(first)).not.toContain(PWD);
    expect(validateGithubPatVault(first)).toEqual(first);
    expect(await decryptGithubPatCloud(first,PWD)).toBe(PAT);
    await expect(decryptGithubPatCloud(first,"incorrect but long password")).rejects.toThrow(/Impossibile/);
    expect(() => validateGithubPatVault({...first,token:PAT})).toThrow();
    expect(() => validateGithubPatVault({...first,kind:"runner"})).toThrow();
  });
  it("uploads only encrypted PAT into Google appDataFolder and detects duplicate versions", async () => {
    saveSecret("cloud.google","access-token");
    const calls: Array<{url:string;init:RequestInit}> = [];
    let vault = "";
    vi.stubGlobal("fetch",vi.fn(async (url:string,init:RequestInit) => {
      calls.push({url,init});
      if (url.includes("/drive/v3/files?") && !url.includes("/upload/")) return {ok:true,json:async()=>({
        files:vault ? [{id:"valid1234",name:"softwarefactory-github-pat-v1.json",version:"1"}] : [],
      })};
      if (url.includes("/upload/")) {
        const body = String(init.body);
        const match = body.match(/\{"schemaVersion":1,"kind":"github-pat"[^\r\n]*/);
        if (!match) throw Error("encrypted payload not found");
        vault = match[0].split("\r\n")[0];
        return {ok:true,json:async()=>({})};
      }
      if (url.includes("?alt=media")) return {ok:true,text:async()=>vault};
      throw Error("Unexpected URL "+url);
    }));
    await saveGithubPatToCloud({provider:"google",clientId:"test"},PAT,PWD);
    expect(vault).toContain('"ciphertext"');
    expect(JSON.stringify(calls)).not.toContain(PAT);
    expect(JSON.stringify(calls)).not.toContain(PWD);
    expect(await restoreGithubPatFromCloud({provider:"google",clientId:"test"},PWD)).toBe(PAT);
  });
  it("uses OneDrive conditional creation instead of overwriting a concurrent cloud vault", async () => {
    saveSecret("cloud.microsoft","access-token");
    const urls: string[] = [];
    vi.stubGlobal("fetch",vi.fn(async (url:string,init:RequestInit) => {
      urls.push(url);
      if ((init?.method||"GET")==="GET") return {ok:false,status:404};
      expect((init.headers as Record<string,string>)["If-None-Match"]).toBe("*");
      expect(JSON.stringify(init.body)).not.toContain(PAT);
      return {ok:false,status:412};
    }));
    await expect(saveGithubPatToCloud({provider:"microsoft",clientId:"id"},PAT,PWD))
      .rejects.toThrow(/modificato/);
    expect(urls).toHaveLength(2);
  });
  it("discovers PAT-accessible repositories as metadata, no implicit write", async () => {
    const requested: RequestInit[] = [];
    vi.stubGlobal("fetch",vi.fn(async (_url:string,init:RequestInit) => {
      requested.push(init);
      return {ok:true,text:async()=>JSON.stringify([{
        name:"app",owner:{login:"octocat"},default_branch:"release",private:true,
        permissions:{push:true},archived:false,disabled:false,
      }, {name:"readme",owner:{login:"team"},default_branch:"main",private:false,
        permissions:{push:false}}])};
    }));
    const choices = await findGithubRepositories(PAT);
    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({owner:"octocat",repo:"app",branch:"release",canPush:true});
    expect(choices[1].canPush).toBe(false);
    expect(requested[0].method).toBe("GET");
    expect((requested[0].headers as Record<string,string>).Authorization).toBe("Bearer "+PAT);
  });
  it("exports only project checkpoint, validates identity and blocks secret text or broken paths", () => {
    const p = project();
    p.stages[0].status="complete";
    p.stages[0].output="Feature plan";
    const encoded=encodeGithubWorkspace(p);
    expect(encoded).toContain("softwarefactory-workspace");
    expect(encoded).not.toContain("githubToken");
    expect(decodeGithubWorkspace(encoded).id).toBe(p.id);
    expect(decodeGithubWorkspace(encoded).stages[0].status).toBe("complete");
    p.stages[0].output="Secret leaked: "+PAT;
    expect(()=>encodeGithubWorkspace(p)).toThrow(/segreto/);
    const bad=JSON.parse(encoded);
    bad.project.development={ revision:0,overrides:{"docker/.env":"secret"},
      originals:{"docker/.env":null},history:[] };
    expect(()=>decodeGithubWorkspace(JSON.stringify(bad))).toThrow();
  });
  it("strips runner evidence and approvals when exporting/importing a checkpoint across devices", () => {
    const p = project();
    p.development = {revision: 3, overrides: {}, originals: {}, history: [],
      lastRunnerJobId: "job-from-other-device",
      lastRunnerEvidence: {id: "job-from-other-device",digest:"a".repeat(64),
        endpoint:"https://runner.example.com",label:"old test",steps:["web-build"],
        submittedAt:new Date().toISOString(),proposalId:"proposal",revision:3},
      pending: {id:"proposal",request:"fix",summary:"Fix",createdAt:new Date().toISOString(),
        revision:3,edits:[],tests:[],assumptions:[],review:{
          verdict:"pass",report:"Old device review",completedAt:new Date().toISOString()},
        repairCount:1,
        repairSession:{id:"old-session",rootJobId:"job",rootProposalId:"proposal",
          endpoint:"https://runner.example.com"},
        repairTrail:[{attempt:1,failedJobId:"job",failedDigest:"digest",steps:["web-build"]}],
      },
    };
    const encrypted = encodeGithubWorkspace(p);
    expect(encrypted).not.toContain("job-from-other-device");
    expect(encrypted).not.toContain("old-session");
    expect(encrypted).not.toContain("Old device review");
    const portable = decodeGithubWorkspace(encrypted);
    expect(portable.development?.lastRunnerJobId).toBeUndefined();
    expect(portable.development?.lastRunnerEvidence).toBeUndefined();
    expect(portable.development?.pending?.review).toBeUndefined();
    expect(portable.development?.pending?.repairSession).toBeUndefined();
    const old = JSON.parse(encrypted);
    old.project.development.lastRunnerEvidence = p.development.lastRunnerEvidence;
    old.project.development.pending.review = p.development.pending!.review;
    expect(decodeGithubWorkspace(JSON.stringify(old)).development?.lastRunnerEvidence).toBeUndefined();
    expect(portableGithubProject(p).development?.pending?.review).toBeUndefined();
  });
  it("reads exact branch HEAD and decodes a checkpoint without modifying it", async () => {
    const p=project();
    const text=encodeGithubWorkspace(p);
    const binary=btoa(unescape(encodeURIComponent(text)));
    const urls:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async (url:string) => {
      urls.push(url);
      if (url.includes("/git/ref/")) return {ok:true,text:async()=>JSON.stringify({object:{sha}})};
      return {ok:true,text:async()=>JSON.stringify({
        type:"file",encoding:"base64",content:binary,size:text.length,
      })};
    }));
    const info=await inspectGithubWorkspace(git,PAT);
    expect(info.headSha).toBe(sha);
    expect(info.project?.id).toBe(p.id);
    expect(urls[1]).toContain("?ref="+sha);
    expect(githubProjectDirty(p,git)).toBe(true);
    const acknowledged={...p,githubSync:{owner:git.owner,repo:git.repo,branch:git.branch,
      lastCommit:sha,syncedLocalUpdatedAt:p.updatedAt,syncedAt:new Date().toISOString()}};
    expect(githubBindingMatches(acknowledged,git)).toBe(true);
    expect(githubProjectDirty(acknowledged,git)).toBe(false);
  });
});
