/** Human-written checkpoint editing in the ISOLATED IndexedDB pilot (#161).
 * Pure, revision-pinned candidate; no storage, network, code execution or
 * implied AI/test/reviewer attestation. The caller must still obtain exact
 * JSON backup and explicit human consent, then native tx.oncomplete ACK.
 */
import {STAGES} from "../domain/defaults";
import type {FactoryProject,StageId} from "../domain/types";
import {serializeCasProject} from "../infrastructure/project-cas";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";

export const CAS_MANUAL_STAGE_MAX_CHARS=60_000;
const STATUSES=new Set(["pending","running","complete","failed"]);
const ORIGINS=new Set(["ai","manual"]);

function strictProject(snapshot:CasProjectSnapshot):FactoryProject {
  try{
    if(!snapshot || !Number.isSafeInteger(snapshot.revision) ||
       snapshot.revision<1 || typeof snapshot.raw!=="string")
      throw Error("Invalid token");
    const project=JSON.parse(snapshot.raw) as FactoryProject;
    if(!project || project.id!==snapshot.id ||
       serializeCasProject(project)!==snapshot.raw ||
       !Array.isArray(project.stages) ||
       project.stages.length!==STAGES.length ||
       project.stages.some((stage,i)=>
         !stage || stage.id!==STAGES[i].id ||
         typeof stage.label!=="string" ||
         !STATUSES.has(stage.status) ||
         typeof stage.output!=="string" ||
         !Array.isArray(stage.sources) ||
         (stage.error!==undefined && typeof stage.error!=="string") ||
         (stage.updatedAt!==undefined && typeof stage.updatedAt!=="string") ||
         (stage.completionOrigin!==undefined &&
           (!ORIGINS.has(stage.completionOrigin) ||
            stage.status!=="complete"))))
      throw Error("Invalid stage layout");
    return project;
  }catch{
    throw Error("Checkpoint manuale IndexedDB non canonico: modifica bloccata.");
  }
}

/** Replaces exactly the target checkpoint, invalidates ALL successors and
 * keeps earlier checkpoints byte-for-byte unchanged after reserialization.
 * Complete->complete editing is allowed, but must not keep obsolete sources
 * or falsely annotate the text as provider-generated.
 */
export function buildCasIsolatedManualStage(
  snapshot:CasProjectSnapshot,stageId:StageId,body:string,
):FactoryProject {
  const index=STAGES.findIndex(stage=>stage.id===stageId);
  if(index<0)throw Error("Fase manuale IndexedDB sconosciuta.");
  if(typeof body!=="string" || !body.trim() ||
     body.length>CAS_MANUAL_STAGE_MAX_CHARS)
    throw Error("Output manuale IndexedDB vuoto o troppo lungo.");
  const project=strictProject(snapshot);
  if(project.stages.some(stage=>stage.status==="running"))
    throw Error("Fase IndexedDB running: recupero manuale obbligatorio.");
  if(project.stages.slice(0,index).some(stage=>
    stage.status!=="complete" || !stage.output.trim()))
    throw Error("Predecessori IndexedDB non completati.");
  if(!["pending","failed","complete"].includes(project.stages[index].status))
    throw Error("Fase IndexedDB non modificabile.");
  const nextAt=new Date().toISOString();
  const next:FactoryProject={
    ...project,updatedAt:nextAt,
    stages:project.stages.map((stage,i)=>
      i<index ? stage : i===index ? {
        id:stage.id,label:stage.label,status:"complete" as const,
        output:body,sources:[],completionOrigin:"manual" as const,
        updatedAt:nextAt,
      } : {
        id:stage.id,label:stage.label,status:"pending" as const,
        output:"",sources:[],
      }),
  };
  // Avoid idempotent acknowledgement of an unchanged stage and empty
  // downstream. A no-op must not advance the CAS revision or timestamps.
  const unchanged=project.stages[index].status==="complete" &&
    project.stages[index].output===body &&
    project.stages[index].completionOrigin==="manual" &&
    project.stages[index].sources.length===0 &&
    project.stages.slice(index+1).every(stage=>
      stage.status==="pending" && !stage.output &&
      stage.sources.length===0 && stage.error===undefined &&
      stage.updatedAt===undefined && stage.completionOrigin===undefined);
  if(unchanged)throw Error("Nessuna modifica manuale IndexedDB da salvare.");
  serializeCasProject(next);
  return next;
}

export function canCommitCasIsolatedManualStage(
  snapshot:CasProjectSnapshot|null,stageId:StageId,body:string,
):boolean {
  if(!snapshot)return false;
  try{buildCasIsolatedManualStage(snapshot,stageId,body);return true;}
  catch{return false;}
}
