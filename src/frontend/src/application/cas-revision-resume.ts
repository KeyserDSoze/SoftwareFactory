/**
 * #176/#139 — a bounded read-only return link to EXACTLY one IndexedDB
 * revision, never an import, auto-open token, cross-device sync or authority.
 *
 * Do not embed unreviewed URL params, source JSON, secrets or draft data.
 * The return side must still obtain explicit human consent and independently
 * recheck ID/revision/raw SHA-256 across that consent (#171).
 */
import {STAGES} from "../domain/defaults";
import type {FactoryProject} from "../domain/types";
import {inspectCasIsolatedStages} from "./cas-isolated-stage-inspection";
import {casHandoffRawDigest,factoryCasHandoffUrl}
  from "./cas-root-workspace";
import {readCasProjectSlot,serializeCasProject}
  from "../infrastructure/project-cas";
import type {CasProjectSnapshot,CasProjectSlot}
  from "../infrastructure/project-cas";

export type CasRevisionResumeLink=Readonly<{
  id:string;revision:number;digest:string;url:string;
}>;
export type CasResumeRead=(id:string)=>Promise<CasProjectSlot>;

function checkSnapshot(snapshot:CasProjectSnapshot):void {
  try{
    if(!snapshot || !Number.isSafeInteger(snapshot.revision) ||
       snapshot.revision<1 ||
       typeof snapshot.raw!=="string" ||
       snapshot.raw.length===0 || snapshot.raw.length>1_000_000)
      throw Error("Bad snapshot");
    const project=JSON.parse(snapshot.raw) as FactoryProject;
    if(!project || project.id!==snapshot.id ||
       serializeCasProject(project)!==snapshot.raw)
      throw Error("Noncanonical");
    const stages=inspectCasIsolatedStages(snapshot);
    if(!stages || stages.length!==STAGES.length ||
       stages.some(stage=>stage.status==="invalid" || stage.status==="running"))
      throw Error("Invalid or running stage");
  }catch{
    throw Error("Revisione CAS non canonica o checkpoint non stabile: link negato.");
  }
}
function exact(a:CasProjectSnapshot,b:CasProjectSnapshot):boolean {
  return a.id===b.id && a.revision===b.revision && a.raw===b.raw;
}
function sanitizedOriginPath(href:string):string {
  const url=new URL(href);
  if(!["http:","https:"].includes(url.protocol) ||
     !url.hostname || url.username || url.password)
    throw Error("URL CAS non valido.");
  // Deliberately drop ALL inherited query/fragment, even unrelated params:
  // OAuth callbacks and other app URLs could carry code/state/credentials.
  url.search="";url.hash="";
  return url.toString();
}
async function assertSameNative(
  expected:CasProjectSnapshot,read:CasResumeRead,
):Promise<void> {
  const current=await read(expected.id);
  if(current.state!=="present" || !exact(expected,current.snapshot))
    throw Error("Revisione CAS modificata/eliminata: ricarica la libreria.");
}

/**
 * A selected exact native snapshot is a PINNED candidate, never authority.
 * Recheck its native state before/after async SHA-256, and verify the live
 * UI selection/draft gate after every await. No native or legacy writes.
 */
export async function prepareCasRevisionResumeLink(
  expected:CasProjectSnapshot,href:string,isStable:()=>boolean,
  read:CasResumeRead=readCasProjectSlot,
):Promise<CasRevisionResumeLink> {
  if(typeof isStable!=="function" || !isStable())
    throw Error("Sessione CAS non stabile o bozza non salvata.");
  checkSnapshot(expected);
  const safeUrl=sanitizedOriginPath(href);
  await assertSameNative(expected,read);
  if(!isStable())
    throw Error("La sessione CAS è cambiata prima del digest.");
  const digest=await casHandoffRawDigest(expected.raw);
  if(!isStable())
    throw Error("La sessione CAS è cambiata durante il digest.");
  await assertSameNative(expected,read);
  if(!isStable())
    throw Error("La sessione CAS è cambiata durante la verifica.");
  const url=factoryCasHandoffUrl(safeUrl,{
    id:expected.id,revision:expected.revision,digest,
  });
  return Object.freeze({id:expected.id,revision:expected.revision,digest,url});
}
