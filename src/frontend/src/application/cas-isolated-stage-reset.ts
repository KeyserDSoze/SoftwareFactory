/**
 * Selectively invalidate one IndexedDB-only pipeline checkpoint and all later
 * stages (#155 / #139). This is NOT an AI completion, review or runner proof;
 * it only removes stale stage data in an exact CAS snapshot.
 */
import {STAGES} from "../domain/defaults";
import type {FactoryProject,StageId} from "../domain/types";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {serializeCasProject} from "../infrastructure/project-cas";

const VALID_STATUSES=new Set(["pending","running","complete","failed"]);

export function buildCasIsolatedStageReset(
  expected:CasProjectSnapshot,stageId:StageId,
):FactoryProject {
  const index=STAGES.findIndex(stage=>stage.id===stageId);
  if(index<0) throw Error("Fase IndexedDB non riconosciuta.");
  let project:FactoryProject;
  try{
    if(!expected || !Number.isSafeInteger(expected.revision) ||
       expected.revision<1 || typeof expected.raw!=="string")
      throw Error("Invalid snapshot");
    project=JSON.parse(expected.raw) as FactoryProject;
    if(project.id!==expected.id ||
       serializeCasProject(project)!==expected.raw ||
       project.stages.length!==STAGES.length ||
       project.stages.some((stage,i)=>
         !stage || stage.id!==STAGES[i].id ||
         typeof stage.label!=="string" ||
         !VALID_STATUSES.has(stage.status) ||
         typeof stage.output!=="string" ||
         !Array.isArray(stage.sources) ||
         (stage.error!==undefined && typeof stage.error!=="string") ||
         (stage.updatedAt!==undefined &&
           typeof stage.updatedAt!=="string")))
      throw Error("Invalid stage layout");
  }catch{
    throw Error("Checkpoint IndexedDB non canonici: reset annullato.");
  }
  const target=project.stages.slice(index);
  if(target.every(stage=>stage.status==="pending" &&
      stage.output==="" && stage.sources.length===0 &&
      stage.error===undefined && stage.updatedAt===undefined))
    throw Error("Le fasi IndexedDB selezionate sono già azzerate.");

  // Do not rewrite earlier stages, config, development or other evidence.
  // Remove every selected/later AI output and research receipt, never issue
  // a new "complete" status or infer that old tests are still valid.
  const next:FactoryProject={
    ...project,
    stages:project.stages.map((stage,i)=>i<index?stage:{
      id:stage.id,label:stage.label,status:"pending",
      output:"",sources:[],
    }),
    updatedAt:new Date().toISOString(),
  };
  serializeCasProject(next);
  return next;
}

/** Pure UI affordance: invalid/no-op snapshots disable reset, fail closed. */
export function canResetCasIsolatedStage(
  expected:CasProjectSnapshot|null,stageId:StageId,
):boolean {
  if(!expected) return false;
  try{buildCasIsolatedStageReset(expected,stageId);return true;}
  catch{return false;}
}
