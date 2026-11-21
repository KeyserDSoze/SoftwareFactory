/**
 * Pure preflight for explicit deletion in the standalone CAS editor (#151).
 * A delete may proceed only from the exact pinned, canonical snapshot, with
 * an unchanged draft. Never consult the live localStorage project.
 */
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {serializeCasProject} from "../infrastructure/project-cas";
import type {FactoryProject} from "../domain/types";

export type CasIsolatedDeleteTicket=Readonly<{
  id:string;
  revision:number;
  raw:string;
  name:string;
  fileName:string;
}>;

export function prepareCasIsolatedDelete(
  selected:CasProjectSnapshot,
  pinned:CasProjectSnapshot,
  draftName:string,
  draftDescription:string,
  draftRequirements:string,
):CasIsolatedDeleteTicket {
  if(!selected || !pinned || selected.id!==pinned.id ||
    selected.revision!==pinned.revision || selected.raw!==pinned.raw ||
    !Number.isSafeInteger(selected.revision) || selected.revision<1)
    throw Error("Token IndexedDB di eliminazione obsoleto.");
  let project:FactoryProject;
  try{
    project=JSON.parse(selected.raw) as FactoryProject;
    if(project.id!==selected.id || serializeCasProject(project)!==selected.raw ||
      !project.config || typeof project.config.name!=="string" ||
      typeof project.config.description!=="string")
      throw Error("Invalid");
  }catch{
    throw Error("Backup IndexedDB non canonico: cancellazione annullata.");
  }
  if(typeof draftRequirements!=="string" ||
    (project.config.requirements!==undefined &&
      typeof project.config.requirements!=="string") ||
    draftName!==project.config.name ||
    draftDescription!==project.config.description ||
    draftRequirements!==(project.config.requirements ?? ""))
    throw Error("Bozza IndexedDB non salvata: eliminazione bloccata.");
  return Object.freeze({
    id:selected.id,revision:selected.revision,raw:selected.raw,
    name:project.config.name,
    fileName:"softwarefactory-cas-before-delete-"+selected.id+
      "-r"+selected.revision+".json",
  });
}
