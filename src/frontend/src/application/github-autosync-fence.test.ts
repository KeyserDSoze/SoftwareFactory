import {describe,expect,it} from "vitest";
import {createProject} from "../domain/defaults";
import type {FactoryProject,GitConfig} from "../domain/types";
import {
  prepareGithubAutosyncPin,assertGithubAutosyncPin,prepareGithubAutosyncAck,
} from "./github-autosync-fence";

const SHA="a".repeat(40),NEW_SHA="b".repeat(40);
const git:GitConfig={owner:"sample",repo:"softwarefactory",branch:"main",
  authMode:"pat",appGateway:"",privateRepo:true};
function fixture(){
  const project=createProject();
  project.githubSync={owner:git.owner,repo:git.repo,branch:git.branch,
    lastCommit:SHA,syncedAt:"2026-11-20T08:00:00.000Z",
    syncedLocalUpdatedAt:"2026-11-20T08:00:00.000Z"};
  project.updatedAt="2026-11-23T16:00:00.000Z";
  const raw=JSON.stringify(project);
  const remote={...project,githubSync:{
    ...project.githubSync,lastCommit:NEW_SHA,
    syncedLocalUpdatedAt:project.updatedAt,
    syncedAt:"2026-11-23T16:01:00.000Z",
  }};
  return {project,raw,remote};
}
describe("legacy GitHub autosync async ACK fencing #188",()=>{
  it("pins exact JSON and destination, without credentials or mutable settings",()=>{
    const {project,raw}=fixture();
    const config={...git};
    const pin=prepareGithubAutosyncPin(project,config);
    expect(pin.raw).toBe(raw);
    expect(Object.isFrozen(pin)).toBe(true);
    expect(Object.isFrozen(pin.git)).toBe(true);
    config.branch="next";
    expect(pin.git.branch).toBe("main");
    expect(JSON.stringify(pin)).not.toContain("PAT");
    expect(()=>assertGithubAutosyncPin(
      pin,project,git,true,raw,true,
    )).not.toThrow();
  });
  it("rejects changed project bytes even if ID and updatedAt remain the same",()=>{
    const {project,raw}=fixture(),pin=prepareGithubAutosyncPin(project,git);
    const changed:FactoryProject={...project,
      config:{...project.config,name:"Rival changed code, same timestamp"}};
    expect(()=>assertGithubAutosyncPin(pin,changed,git,true,raw,true))
      .toThrow(/Conflitto GitHub autosync/);
    expect(()=>assertGithubAutosyncPin(pin,project,git,true,
      JSON.stringify(changed),true)).toThrow(/Conflitto/);
    expect(()=>assertGithubAutosyncPin(pin,{
      ...project,updatedAt:"2026-11-23T16:01:00.000Z",
    },git,true,raw,true)).toThrow(/Conflitto/);
  });
  it("rejects destination and auth changes, opt-out, lost lease or retired write fence",()=>{
    const {project,raw}=fixture(),pin=prepareGithubAutosyncPin(project,git);
    for(const changed of [
      {...git,owner:"other"},{...git,repo:"another"},{...git,branch:"other"},
      {...git,authMode:"app" as const},
      {...git,appGateway:"https://example.test/app"},
      {...git,privateRepo:false},
    ])expect(()=>assertGithubAutosyncPin(pin,project,changed,true,raw,true))
      .toThrow(/Conflitto/);
    expect(()=>assertGithubAutosyncPin(pin,project,git,false,raw,true))
      .toThrow(/Conflitto/);
    expect(()=>assertGithubAutosyncPin(pin,project,git,true,raw,false))
      .toThrow(/Conflitto/);
    expect(()=>assertGithubAutosyncPin(pin,project,git,true,null,true))
      .toThrow(/Conflitto/);
  });
  it("rejects forged ACK owner/repo/branch/SHA and public consent",()=>{
    const {project,raw,remote}=fixture();
    const pin=prepareGithubAutosyncPin(project,git);
    const altered=[
      {...remote,githubSync:{...remote.githubSync,repo:"unrelated"}},
      {...remote,githubSync:{...remote.githubSync,branch:"other"}},
      {...remote,githubSync:{...remote.githubSync,lastCommit:SHA}},
      {...remote,githubSync:{...remote.githubSync,syncedLocalUpdatedAt:"older"}},
      {...remote,id:createProject().id},
    ];
    for(const bad of altered)
      expect(()=>prepareGithubAutosyncAck(pin,{
        project:bad,sha:NEW_SHA,
      },project,git,true,raw,true)).toThrow(/Conflitto/);
    expect(()=>prepareGithubAutosyncAck(pin,{
      project:remote,sha:"bad",
    },project,git,true,raw,true)).toThrow(/Conflitto/);
    const publicGit={...git,privateRepo:false};
    const publicProject={...project,githubSync:{...project.githubSync!,publicConsent:true}};
    const publicPin=prepareGithubAutosyncPin(publicProject,publicGit);
    const remotePublic={...remote,githubSync:{...remote.githubSync!,publicConsent:false}};
    expect(()=>prepareGithubAutosyncAck(publicPin,{project:remotePublic,sha:NEW_SHA},
      publicProject,publicGit,true,JSON.stringify(publicProject),true))
      .toThrow(/Conflitto/);
  });
  it("permits only exact, locally pinned ACK, preserving every prior workspace field",()=>{
    const {project,raw,remote}=fixture();
    const pin=prepareGithubAutosyncPin(project,git);
    const ack=prepareGithubAutosyncAck(pin,{
      project:remote,sha:NEW_SHA,
    },project,git,true,raw,true);
    expect(ack).toEqual(remote);
    expect(ack.updatedAt).toBe(project.updatedAt);
    expect(ack.githubSync?.lastCommit).toBe(NEW_SHA);
    expect(ack.githubSync?.syncedLocalUpdatedAt).toBe(project.updatedAt);
    expect(project.githubSync?.lastCommit).toBe(SHA);
  });
  it("never silently turns a clean or mismatched remote project into an autosync",()=>{
    const {project}=fixture();
    const cleaned={...project,githubSync:{
      ...project.githubSync!,syncedLocalUpdatedAt:project.updatedAt,
    }};
    expect(()=>prepareGithubAutosyncPin(cleaned,git)).toThrow(/Conflitto/);
    expect(()=>prepareGithubAutosyncPin(project,{...git,branch:"feature"}))
      .toThrow(/Conflitto/);
  });
  it("rechecks after BOTH awaits and refuses post-push ACK if another tab writes",async()=>{
    const {project,raw,remote}=fixture();
    const pin=prepareGithubAutosyncPin(project,git);
    let live=project,storedRaw=raw,currentGit={...git};
    const state=()=>assertGithubAutosyncPin(
      pin,live,currentGit,true,storedRaw,true,
    );
    state();
    const token=await Promise.resolve("session-pat-not-in-pin");
    expect(token).toMatch(/pat/);
    currentGit={...git,repo:"new-destination"};
    expect(state).toThrow(/Conflitto/); // token resolution: NO push
    currentGit={...git};state();
    const pushed=await Promise.resolve({project:remote,sha:NEW_SHA});
    live={...project,config:{...project.config,name:"Other tab"}};
    storedRaw=JSON.stringify(live);
    expect(()=>prepareGithubAutosyncAck(pin,pushed,live,
      currentGit,true,storedRaw,true)).toThrow(/Conflitto/);
  });
});
