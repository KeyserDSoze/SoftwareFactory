/**
 * Pre-cutover async pipeline write coordinator (#156/#139).
 * NOT connected to App.tsx: live Factory still writes localStorage.
 * Future callers must keep each AI result bound to the CAS token returned
 * after the "running" transaction completed, never to an optimistic draft.
 */
import {STAGES} from "../domain/defaults";
import type {FactoryProject,ResearchSource,StageId} from "../domain/types";
import {commitStage,stageReady} from "./pipeline";
import {serializeCasProject} from "../infrastructure/project-cas";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {openCasEditorSession} from "../infrastructure/project-cas-editor-session";
import type {CasEditorSession} from "../infrastructure/project-cas-editor-session";
import {prepareCasFailedWriteTicket} from "./cas-failed-write-diagnosis";
import type {CasFailedWriteTicket} from "./cas-failed-write-diagnosis";

const MAX_STAGE_OUTPUT=60_000;
const MAX_SOURCES=32;
const STATUSES=new Set(["pending","running","complete","failed"]);

export type CasPipelineRunTicket=Readonly<{
  id:string;stage:StageId;started:CasProjectSnapshot;
}>;
export type CasPipelineFailureKind="provider"|"timeout"|"invalid_result";
/** Volatile diagnostics, never an acknowledgement or permission to retry. */
export type CasPipelineFailedWrite=Readonly<{
  operation:"begin"|"complete"|"abort"|"fail";
  stage:StageId;
  ticket:CasFailedWriteTicket;
}>;
export type CasPipelineSession=Readonly<{
  snapshot():CasProjectSnapshot;
  state():ReturnType<CasEditorSession["state"]>;
  failedWrite():CasPipelineFailedWrite|null;
  begin(stage:StageId):Promise<CasPipelineRunTicket>;
  complete(ticket:CasPipelineRunTicket,output:string,sources:ResearchSource[]):Promise<CasProjectSnapshot>;
  abort(ticket:CasPipelineRunTicket):Promise<CasProjectSnapshot>;
  fail(ticket:CasPipelineRunTicket,kind:CasPipelineFailureKind):Promise<CasProjectSnapshot>;
}>;

function exact(a:CasProjectSnapshot,b:CasProjectSnapshot):boolean {
  return Boolean(a&&b) && a.id===b.id &&
    a.revision===b.revision && a.raw===b.raw;
}
function strictProject(snapshot:CasProjectSnapshot):FactoryProject {
  try{
    if(!snapshot || !Number.isSafeInteger(snapshot.revision) ||
       snapshot.revision<1 || typeof snapshot.raw!=="string")
      throw Error("Invalid CAS token");
    const project=JSON.parse(snapshot.raw) as FactoryProject;
    if(!project || project.id!==snapshot.id ||
       serializeCasProject(project)!==snapshot.raw ||
       project.stages.length!==STAGES.length ||
       project.stages.some((stage,index)=>
         !stage || stage.id!==STAGES[index].id ||
         typeof stage.label!=="string" ||
         !STATUSES.has(stage.status) ||
         typeof stage.output!=="string" ||
         !Array.isArray(stage.sources) ||
         (stage.error!==undefined && typeof stage.error!=="string") ||
         (stage.completionOrigin!==undefined &&
           (!["manual","ai"].includes(stage.completionOrigin) ||
            stage.status!=="complete")) ||
         (stage.updatedAt!==undefined &&
           typeof stage.updatedAt!=="string")))
      throw Error("Invalid stage layout");
    return project;
  }catch{
    throw Error("Snapshot pipeline IndexedDB non canonico: scrittura bloccata.");
  }
}
function validateOutput(output:string,sources:ResearchSource[]):void {
  if(typeof output!=="string" || !output.trim() ||
     output.length>MAX_STAGE_OUTPUT ||
     !Array.isArray(sources) || sources.length>MAX_SOURCES ||
     sources.some(source=>!source ||
       typeof source.title!=="string" || source.title.length>512 ||
       typeof source.url!=="string" || source.url.length>2048 ||
       !/^https?:\/\//i.test(source.url) ||
       typeof source.snippet!=="string" || source.snippet.length>8_000 ||
       typeof source.query!=="string" || source.query.length>1_000 ||
       typeof source.fetchedAt!=="string" ||
       !Number.isFinite(Date.parse(source.fetchedAt))))
    throw Error("Risultato pipeline IndexedDB non valido: commit annullato.");
}

/** Pure read-only UI preflight. begin() repeats every check after opening
 * an exact IDB session; a preflight result is never a commit acknowledgement. */
export function canBeginCasPipelineStage(
  snapshot:CasProjectSnapshot|null,stageId:StageId,
):boolean {
  if(!snapshot) return false;
  try{
    const index=STAGES.findIndex(stage=>stage.id===stageId);
    if(index<0) return false;
    const project=strictProject(snapshot);
    return !project.stages.some(stage=>stage.status==="running") &&
      stageReady(project,stageId) &&
      ["pending","failed"].includes(project.stages[index].status);
  }catch{return false;}
}

export async function openCasPipelineSession(id:string):Promise<CasPipelineSession> {
  // Explicit native IDB open: no bootstrap, tombstone revival or fallback.
  const session=await openCasEditorSession(id);
  let active:CasPipelineRunTicket|null=null;
  let failedWrite:CasPipelineFailedWrite|null=null;
  async function commitWithDiagnosis(
    operation:CasPipelineFailedWrite["operation"],stage:StageId,
    next:FactoryProject,expected:CasProjectSnapshot,
  ):Promise<CasProjectSnapshot>{
    // Capture exact bytes before the native write, not after an uncertain
    // outcome. A rejected preflight cannot create a failed-write receipt.
    const ticket=prepareCasFailedWriteTicket(expected,next);
    try{
      const acknowledged=await session.commit(next,expected);
      failedWrite=null;
      return acknowledged;
    }catch(error){
      if(session.state()==="blocked"){
        failedWrite=Object.freeze({operation,stage,ticket});
      }
      throw error;
    }
  }
  function currentTicket(ticket:CasPipelineRunTicket):FactoryProject {
    if(!ticket || active!==ticket ||
       session.state()!=="ready" ||
       !exact(session.snapshot(),ticket.started))
      throw Error("Risultato AI obsoleto: token pipeline CAS non corrispondente.");
    const project=strictProject(ticket.started);
    if(project.stages.find(stage=>stage.id===ticket.stage)?.status!=="running")
      throw Error("Stage non in esecuzione: risultato tardivo scartato.");
    return project;
  }
  async function finishTicket(
    ticket:CasPipelineRunTicket,project:FactoryProject,
    operation:"complete"|"abort"|"fail",
  ):Promise<CasProjectSnapshot> {
    // The native session updates the token only on IDB transaction oncomplete.
    const confirmed=await commitWithDiagnosis(
      operation,ticket.stage,project,ticket.started);
    active=null;
    return confirmed;
  }
  return Object.freeze({
    snapshot:()=>session.snapshot(),
    state:()=>session.state(),
    failedWrite:()=>failedWrite,
    begin:async(stageId:StageId)=>{
      const index=STAGES.findIndex(stage=>stage.id===stageId);
      if(index<0) throw Error("Fase pipeline CAS non riconosciuta.");
      if(active || session.state()!=="ready")
        throw Error("Pipeline CAS occupata o bloccata: nessun avvio concorrente.");
      const before=session.snapshot();
      const project=strictProject(before);
      if(project.stages.some(stage=>stage.status==="running") ||
         !stageReady(project,stageId) ||
         !["pending","failed"].includes(project.stages[index].status))
        throw Error("Predecessori non pronti o fase CAS già in esecuzione/completata.");
      const now=new Date().toISOString();
      const next:FactoryProject={
        ...project,
        stages:project.stages.map((stage,i)=>i<index?stage:i===index?{
          id:stage.id,label:stage.label,status:"running" as const,
          output:"",sources:[],updatedAt:now,
        }:{
          id:stage.id,label:stage.label,status:"pending" as const,
          output:"",sources:[],
        }),
        updatedAt:now,
      };
      serializeCasProject(next);
      const acknowledged=await commitWithDiagnosis("begin",stageId,next,before);
      const ticket:CasPipelineRunTicket=Object.freeze({
        id:acknowledged.id,stage:stageId,started:Object.freeze({
          id:acknowledged.id,revision:acknowledged.revision,raw:acknowledged.raw,
        }),
      });
      active=ticket;
      return ticket;
    },
    complete:async(ticket:CasPipelineRunTicket,output:string,sources:ResearchSource[])=>{
      const project=currentTicket(ticket);
      validateOutput(output,sources);
      const result=commitStage(project,ticket.stage,output,sources);
      // New AI completions are distinguishable from manual edits and older
      // unknown-provenance historical checkpoints; this is NOT an AI bill,
      // independent reviewer approval or runner result.
      const next:FactoryProject={...result,stages:result.stages.map(stage=>
        stage.id===ticket.stage?
          {...stage,completionOrigin:"ai" as const}:stage)};
      serializeCasProject(next);
      return finishTicket(ticket,next,"complete");
    },
    abort:async(ticket:CasPipelineRunTicket)=>{
      const project=currentTicket(ticket);
      const now=new Date().toISOString();
      const next:FactoryProject={...project,updatedAt:now,
        stages:project.stages.map(stage=>stage.id===ticket.stage?{
          id:stage.id,label:stage.label,status:"pending" as const,
          output:"",sources:[],
        }:stage),
      };
      return finishTicket(ticket,next,"abort");
    },
    fail:async(ticket:CasPipelineRunTicket,kind:CasPipelineFailureKind)=>{
      const project=currentTicket(ticket);
      const messages:Record<CasPipelineFailureKind,string>={
        provider:"Provider AI non disponibile.",
        timeout:"Tempo massimo del provider AI superato.",
        invalid_result:"Risultato del provider AI non valido.",
      };
      if(!Object.prototype.hasOwnProperty.call(messages,kind))
        throw Error("Tipo errore pipeline CAS non riconosciuto.");
      const now=new Date().toISOString();
      const next:FactoryProject={...project,updatedAt:now,
        stages:project.stages.map(stage=>stage.id===ticket.stage?{
          id:stage.id,label:stage.label,status:"failed" as const,
          output:"",sources:[],error:messages[kind],updatedAt:now,
        }:stage),
      };
      return finishTicket(ticket,next,"fail");
    },
  } satisfies CasPipelineSession);
}
