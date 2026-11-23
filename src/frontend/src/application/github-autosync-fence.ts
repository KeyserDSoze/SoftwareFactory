/**
 * #188/#92/#139 — opt-in legacy GitHub autosync pinned across async token
 * resolution, remote publication and local ACK. A remote push may have
 * succeeded even if the local ACK is refused; NEVER retry automatically.
 *
 * This is NOT GitHub <-> IndexedDB atomic CAS, a cross-device lock or proof
 * of a new runner/review result. No PAT is stored in a ticket.
 */
import type {FactoryProject,GitConfig} from "../domain/types";
import {githubBindingMatches,githubProjectDirty} from "../infrastructure/github-workspace";

export type GithubAutosyncPin=Readonly<{
  id:string;
  raw:string;
  updatedAt:string;
  git:Readonly<GitConfig>;
}>;

export type GithubAutosyncResult=Readonly<{
  project:FactoryProject;
  sha:string;
}>;

function sameGit(a:GitConfig,b:GitConfig):boolean {
  return Boolean(a && b) &&
    a.owner===b.owner && a.repo===b.repo && a.branch===b.branch &&
    a.authMode===b.authMode && a.appGateway===b.appGateway &&
    a.privateRepo===b.privateRepo;
}
function refused():never {
  throw Error("Conflitto GitHub autosync: snapshot locale, destinazione o permesso cambiato. " +
    "Se il commit remoto è già partito, verifica la HEAD manualmente; nessun retry automatico.");
}
function serialize(project:FactoryProject):string {
  try{
    const raw=JSON.stringify(project);
    if(!project || typeof project.id!=="string" ||
       typeof project.updatedAt!=="string" || !raw ||
       raw.length>1_000_000)return refused();
    return raw;
  }catch{return refused();}
}

/** Capture the exact authorized state. The string cannot be mutated by the
 * legacy React editor or the mutable settings object while network is in flight.
 */
export function prepareGithubAutosyncPin(
  project:FactoryProject,git:GitConfig,
):GithubAutosyncPin {
  if(!project || !git || !githubBindingMatches(project,git) ||
     !githubProjectDirty(project,git))return refused();
  return Object.freeze({
    id:project.id,raw:serialize(project),
    updatedAt:project.updatedAt,
    git:Object.freeze({...git}),
  });
}

/** Call before requesting a token, AFTER that await and before the first
 * remote write, and AFTER GitHub's final readback but before a local ACK.
 * Do not adopt a newer local revision or a new destination for an old push.
 */
export function assertGithubAutosyncPin(
  pin:GithubAutosyncPin,
  live:FactoryProject,
  currentGit:GitConfig,
  enabled:boolean,
  storedRaw:string|null,
  ownsLease:boolean,
):void {
  if(!pin || !pin.git || !enabled || !ownsLease ||
     !sameGit(pin.git,currentGit) ||
     !live || live.id!==pin.id || live.updatedAt!==pin.updatedAt ||
     serialize(live)!==pin.raw || storedRaw!==pin.raw ||
     !githubBindingMatches(live,pin.git) ||
     !githubProjectDirty(live,pin.git))refused();
}

/** The remote ACK is only for the same pinned project and repo. We reject
 * forged or mismatched remote metadata and NEVER merge the ACK into newer
 * local changes, even if updatedAt happens to be unchanged.
 */
export function prepareGithubAutosyncAck(
  pin:GithubAutosyncPin,
  result:GithubAutosyncResult,
  live:FactoryProject,
  currentGit:GitConfig,
  enabled:boolean,
  storedRaw:string|null,
  ownsLease:boolean,
):FactoryProject {
  assertGithubAutosyncPin(pin,live,currentGit,enabled,storedRaw,ownsLease);
  const sync=result?.project?.githubSync;
  if(!sync || result.project.id!==pin.id ||
     result.project.updatedAt!==pin.updatedAt ||
     !/^[a-f0-9]{40}$/i.test(result.sha) ||
     sync.lastCommit!==result.sha ||
     sync.owner!==pin.git.owner || sync.repo!==pin.git.repo ||
     sync.branch!==pin.git.branch ||
     sync.syncedLocalUpdatedAt!==pin.updatedAt ||
     (pin.git.privateRepo===false && sync.publicConsent!==true))
    refused();
  // Preserve exactly the local project. Only a validated ACK is added:
  // historical test/review/runner evidence cannot be refreshed here.
  return {...live,githubSync:{...sync,syncedLocalUpdatedAt:pin.updatedAt}};
}
