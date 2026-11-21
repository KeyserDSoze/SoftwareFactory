/**
 * Dirty-draft guard for the opt-in IndexedDB editor (#154/#139).
 * Pure and fail-closed: a malformed historical snapshot must never make
 * user-entered data look safe to discard. No I/O, no legacy fallback.
 */
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {serializeCasProject} from "../infrastructure/project-cas";
import type {FactoryProject} from "../domain/types";

export function hasCasIsolatedUnsavedDraft(
  selected:CasProjectSnapshot|null,
  name:string,description:string,requirements:string,
):boolean {
  if(!selected) return false;
  if(typeof name!=="string" || typeof description!=="string" ||
     typeof requirements!=="string") return true;
  try{
    const project=JSON.parse(selected.raw) as FactoryProject;
    if(!project || project.id!==selected.id ||
       serializeCasProject(project)!==selected.raw ||
       (project.config.description!==undefined &&
         typeof project.config.description!=="string") ||
       (project.config.requirements!==undefined &&
         typeof project.config.requirements!=="string"))
      return true;
    return project.config.name!==name ||
      (project.config.description ?? "")!==description ||
      (project.config.requirements ?? "")!==requirements;
  }catch{
    // Render and destructive-UI checks must not throw on invalid snapshots.
    return true;
  }
}
