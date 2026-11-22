/**
 * Read-only, fail-closed projection of the isolated native CAS pipeline (#158).
 * Does NOT read IDB, localStorage, settings, secrets or provenance journals.
 * Stage statuses are historical AI checkpoints, never runner/test/review proof.
 */
import {STAGES} from "../domain/defaults";
import type {FactoryProject,StageId,StageStatus} from "../domain/types";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {serializeCasProject} from "../infrastructure/project-cas";

export const CAS_STAGE_PREVIEW_CHARS=12_000;
export const CAS_STAGE_PREVIEW_SOURCES=16;
const MAX_SOURCE_TITLE=160;
const MAX_SOURCE_SNIPPET=320;
const STATUSES=new Set(["pending","running","complete","failed"]);

export type CasStageInspectionStatus=StageStatus|"invalid";
export type CasStageSourcePreview=Readonly<{
  title:string;
  snippet:string;
  href:string|null;
}>;
export type CasStageInspection=Readonly<{
  id:StageId;
  status:CasStageInspectionStatus;
  output:string;
  completionOrigin:"manual"|"ai"|"unknown";
  outputTruncated:boolean;
  sources:readonly CasStageSourcePreview[];
  sourceTotal:number;
  sourcesTruncated:boolean;
}>;

/** A third-party source URL is never an executable or untrusted-scheme link.
 * HTTP links (even localhost), credentials and control chars remain inert. */
export function safeCasStageSourceHref(value:unknown):string|null {
  if(typeof value!=="string" || value.length===0 || value.length>2048 ||
    value.trim()!==value || /[\u0000-\u001f\u007f]/.test(value))
    return null;
  try{
    const url=new URL(value);
    return url.protocol==="https:" && Boolean(url.hostname) &&
      !url.username && !url.password ? url.href : null;
  }catch{return null;}
}

/** Returns null on malformed/repacked CAS raw, never synthesizing a stage. */
export function inspectCasIsolatedStages(
  snapshot:CasProjectSnapshot|null,
):readonly CasStageInspection[]|null {
  if(!snapshot) return null;
  try{
    if(typeof snapshot.id!=="string" ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision<1 ||
      typeof snapshot.raw!=="string")return null;
    const project=JSON.parse(snapshot.raw) as FactoryProject;
    if(!project || project.id!==snapshot.id ||
       serializeCasProject(project)!==snapshot.raw ||
       !Array.isArray(project.stages) ||
       project.stages.length!==STAGES.length)return null;
    const rows:CasStageInspection[]=[];
    for(let i=0;i<STAGES.length;i++){
      const stage=project.stages[i];
      if(!stage || stage.id!==STAGES[i].id ||
         typeof stage.label!=="string" ||
         !STATUSES.has(stage.status) ||
         typeof stage.output!=="string" ||
         !Array.isArray(stage.sources) ||
         (stage.error!==undefined && typeof stage.error!=="string") ||
         (stage.completionOrigin!==undefined &&
           (!["manual","ai"].includes(stage.completionOrigin) ||
            stage.status!=="complete")) ||
         (stage.updatedAt!==undefined && typeof stage.updatedAt!=="string"))
        return null;

      // A complete checkpoint without content, or a pending/running record
      // with output, is never presented as verified completion. Keep the
      // historical text visible for operator inspection but flag mismatch.
      const impossible=(stage.status==="complete" && !stage.output.trim()) ||
        ((stage.status==="pending" || stage.status==="running" ||
          stage.status==="failed") &&
          (Boolean(stage.output) || stage.sources.length>0));
      const sourceTotal=stage.sources.length;
      const sources=stage.sources.slice(0,CAS_STAGE_PREVIEW_SOURCES)
        .map(source=>{
          const record=source && typeof source==="object" ? source : null;
          const title=record && typeof record.title==="string"
            ? record.title.slice(0,MAX_SOURCE_TITLE):"";
          const snippet=record && typeof record.snippet==="string"
            ? record.snippet.slice(0,MAX_SOURCE_SNIPPET):"";
          return Object.freeze({
            title, snippet,
            href:safeCasStageSourceHref(record?.url),
          });
        });
      rows.push(Object.freeze({
        id:STAGES[i].id,
        status:impossible?"invalid":stage.status,
        output:stage.output.slice(0,CAS_STAGE_PREVIEW_CHARS),
        completionOrigin:stage.status==="complete"?
          (stage.completionOrigin??"unknown"):"unknown",
        outputTruncated:stage.output.length>CAS_STAGE_PREVIEW_CHARS,
        sources:Object.freeze(sources),
        sourceTotal,
        sourcesTruncated:sourceTotal>CAS_STAGE_PREVIEW_SOURCES,
      }));
    }
    return Object.freeze(rows);
  }catch{
    return null;
  }
}
