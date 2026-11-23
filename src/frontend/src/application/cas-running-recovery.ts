/** Operator-only CAS AI running-stage recovery (#172/#139).
 * A remote provider or other tab may still execute: never infer cancellation
 * or success. An eventual stale result must lose the native revision CAS.
 */
import {STAGES} from "../domain/defaults";
import type {FactoryProject,StageId} from "../domain/types";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {serializeCasProject} from "../infrastructure/project-cas";
import {buildCasIsolatedStageReset} from "./cas-isolated-stage-reset";

export type CasRunningRecovery=Readonly<{stage:StageId;candidate:FactoryProject}>;

export function prepareCasRunningRecovery(expected:CasProjectSnapshot):CasRunningRecovery {
  let project:FactoryProject;
  try{
    if(!expected || !Number.isSafeInteger(expected.revision) ||
       expected.revision<1 || typeof expected.raw!=="string")throw Error("Invalid token");
    project=JSON.parse(expected.raw) as FactoryProject;
    if(!project || project.id!==expected.id ||
       serializeCasProject(project)!==expected.raw ||
       project.stages.length!==STAGES.length ||
       project.stages.some((s,i)=>!s || s.id!==STAGES[i].id))
      throw Error("Invalid stage layout");
  }catch{throw Error("Recupero running IndexedDB: snapshot non canonico.");}
  const running=project.stages.flatMap((stage,i)=>
    stage.status==="running"?[i]:[]);
  if(running.length!==1)
    throw Error("Recupero running IndexedDB: serve una sola fase running.");
  const index=running[0],current=project.stages[index];
  // Reject ambiguous evidence or downstream work. Never erase unrelated
  // completions silently or accept a forged "running" with existing output.
  if(project.stages.slice(0,index).some(s=>s.status!=="complete") ||
     current.output!=="" || !Array.isArray(current.sources) ||
     current.sources.length!==0 || current.error!==undefined ||
     current.completionOrigin!==undefined ||
     (current.updatedAt!==undefined &&
       (typeof current.updatedAt!=="string" ||
        !Number.isFinite(Date.parse(current.updatedAt)))) ||
     project.stages.slice(index+1).some(s=>
       s.status!=="pending" || s.output!=="" ||
       !Array.isArray(s.sources) || s.sources.length!==0 ||
       s.error!==undefined || s.updatedAt!==undefined ||
       s.completionOrigin!==undefined))
    throw Error("Recupero running IndexedDB: checkpoint ambiguo.");
  const stage=STAGES[index].id;
  const candidate=buildCasIsolatedStageReset(expected,stage);
  if(candidate.stages.some(s=>s.status==="running"))
    throw Error("Recupero running IndexedDB: risultato non sicuro.");
  return Object.freeze({stage,candidate});
}

export function inspectCasRunningStage(snapshot:CasProjectSnapshot|null):StageId|null {
  if(!snapshot)return null;
  try{return prepareCasRunningRecovery(snapshot).stage;}
  catch{return null;}
}
