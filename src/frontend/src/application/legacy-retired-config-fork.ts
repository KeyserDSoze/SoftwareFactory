/**
 * #174/#139: operator-confirmed clean legacy fork AFTER a CAS handoff.
 * The original per-ID legacy slot and its retirement marker are immutable.
 * This is an insert-only cooperative localStorage recovery, NOT CAS across
 * localStorage/IndexedDB or a way to reactivate historical AI/test evidence.
 */
import {createProject,STAGES} from "../domain/defaults";
import type {FactoryProject} from "../domain/types";
import {validateCasIsolatedStackConfig} from "./cas-isolated-stack-config";
import {inspectCasIsolatedStages} from "./cas-isolated-stage-inspection";
import {CAS_ISOLATED_NAME_MAX} from "./cas-isolated-config";
import {casHandoffRawDigest} from "./cas-root-workspace";
import {serializeCasProject} from "../infrastructure/project-cas";
import {readLegacyCasRetirement} from "../infrastructure/legacy-cas-retirement";
import {acquireProjectWriterLease} from "../infrastructure/project-writer-lease";
import {localProjectSnapshot,persistProjectIfUnchanged} from "../infrastructure/store";

export type RetiredLegacyForkTicket=Readonly<{
  source:Readonly<{id:string;raw:string;digest:string}>;
  target:Readonly<{id:string;raw:string;name:string}>;
}>;
export type RetiredLegacyForkResult=Readonly<{
  status:"created"|"created_unverified";id:string;
}>;
const SUFFIX=" (recovery)";

function parseSource(id:string,raw:string):FactoryProject {
  try{
    if(typeof raw!=="string" || !raw || raw.length>1_000_000)
      throw Error("Invalid raw");
    const source=JSON.parse(raw) as FactoryProject;
    if(!source || source.id!==id ||
       serializeCasProject(source)!==raw ||
       !validateCasIsolatedStackConfig(source.config))
      throw Error("Invalid canonical config");
    const stages=inspectCasIsolatedStages({id,revision:1,raw});
    if(!stages || stages.length!==STAGES.length ||
       stages.some(s=>s.status==="invalid" || s.status==="running"))
      throw Error("Running/inconsistent stage");
    return source;
  }catch{
    throw Error("Sorgente legacy protetta non canonica, non sicura o con fasi attive.");
  }
}

function assertTargetFree(id:string):void {
  if(localProjectSnapshot(id)!==null || readLegacyCasRetirement(id)!==null)
    throw Error("UUID recupero già utilizzato o protetto: non sovrascrivere.");
}

export async function assertRetiredLegacyForkSource(ticket:RetiredLegacyForkTicket["source"]):
  Promise<FactoryProject> {
  if(!ticket || typeof ticket.id!=="string")
    throw Error("Ticket recupero legacy non valido.");
  const marker=readLegacyCasRetirement(ticket.id);
  if(!marker || marker.digest!==ticket.digest)
    throw Error("Barriera di trasferimento legacy mancante o diversa.");
  const raw=localProjectSnapshot(ticket.id);
  if(raw!==ticket.raw)
    throw Error("Snapshot legacy cambiato: nuovo backup e consenso necessari.");
  const source=parseSource(ticket.id,ticket.raw);
  if(await casHandoffRawDigest(ticket.raw)!==ticket.digest)
    throw Error("Digest legacy diverso dalla barriera: recupero bloccato.");
  // The SHA-256 computation yields asynchronously. Never adopt a newer
  // local raw or a modified marker while it was pending.
  const after=readLegacyCasRetirement(ticket.id);
  if(!after || after.digest!==ticket.digest ||
     localProjectSnapshot(ticket.id)!==ticket.raw)
    throw Error("Barriera o snapshot legacy cambiati durante il controllo.");
  return source;
}

export function validateRetiredLegacyForkTarget(ticket:RetiredLegacyForkTicket,source:FactoryProject):
  FactoryProject {
  try{
    const target=JSON.parse(ticket.target.raw) as FactoryProject;
    const name=source.config.name.slice(0,CAS_ISOLATED_NAME_MAX-SUFFIX.length)+SUFFIX;
    const empty=STAGES.map(({id,label})=>({
      id,label,status:"pending",output:"",sources:[],
    }));
    if(!ticket.target || ticket.target.id===ticket.source.id ||
       target.id!==ticket.target.id || target.config?.name!==name ||
       ticket.target.name!==name ||
       target.createdAt!==target.updatedAt ||
       Object.keys(target).sort().join(",")!==
         "config,createdAt,id,stages,updatedAt" ||
       JSON.stringify(target.config)!==
         JSON.stringify({...source.config,name}) ||
       JSON.stringify(target.stages)!==JSON.stringify(empty) ||
       serializeCasProject(target)!==ticket.target.raw)
      throw Error("Unsafe target");
    return target;
  }catch{
    throw Error("Ticket fork legacy alterato: nessuna scrittura autorizzata.");
  }
}

/** Read-only preparation, never clear the old marker or touch IDB. */
export async function prepareRetiredLegacyConfigFork(
  id:string,
):Promise<RetiredLegacyForkTicket> {
  const marker=readLegacyCasRetirement(id);
  if(!marker)throw Error("Il progetto non è protetto da una barriera CAS valida.");
  const raw=localProjectSnapshot(id);
  if(!raw)throw Error("Snapshot legacy protetto non trovato.");
  const sourceInfo=Object.freeze({id,raw,digest:marker.digest});
  const source=await assertRetiredLegacyForkSource(sourceInfo);
  const fresh=createProject();
  if(fresh.id===id)throw Error("UUID recupero uguale all'originale.");
  assertTargetFree(fresh.id);
  const name=source.config.name.slice(0,CAS_ISOLATED_NAME_MAX-SUFFIX.length)+SUFFIX;
  const target:FactoryProject={
    ...fresh,
    config:{...structuredClone(source.config),name},
  };
  const ticket=Object.freeze({
    source:sourceInfo,
    target:Object.freeze({id:target.id,raw:serializeCasProject(target),name}),
  });
  validateRetiredLegacyForkTarget(ticket,source);
  await assertRetiredLegacyForkSource(sourceInfo);
  assertTargetFree(target.id);
  return ticket;
}

/**
 * Caller MUST obtain exact raw backup download, saved-file acknowledgement
 * and final explicit consent first. target Web Lock is acquired with
 * ifAvailable and held through the checked insert + source reinspection.
 * A lost write ACK is never retried or silently called a failed insert.
 */
export async function confirmRetiredLegacyConfigFork(
  ticket:RetiredLegacyForkTicket,consent:boolean,
  isStable:()=>boolean,
):Promise<RetiredLegacyForkResult> {
  if(consent!==true || typeof isStable!=="function" || !isStable())
    throw Error("Fork legacy non autorizzato: consenso o lease sorgente mancanti.");
  const source=await assertRetiredLegacyForkSource(ticket.source);
  const target=validateRetiredLegacyForkTarget(ticket,source);
  assertTargetFree(target.id);
  if(!isStable())throw Error("Workspace legacy cambiato: fork annullato.");
  const lease=await acquireProjectWriterLease(target.id);
  try{
    if(!isStable())throw Error("Lease sorgente cambiato: fork annullato.");
    // Second preflight AFTER the destination lease. No new baselines.
    await assertRetiredLegacyForkSource(ticket.source);
    assertTargetFree(target.id);
    if(!isStable())throw Error("Workspace cambiato prima dell'inserimento.");
    // No retries: a localStorage ACK can be indeterminate in faulty adapters.
    const confirmed=persistProjectIfUnchanged(target,null);
    if(confirmed!==ticket.target.raw)
      throw Error("Conferma fork incoerente: ispeziona la libreria.");
    try{
      await assertRetiredLegacyForkSource(ticket.source);
      if(!isStable() || localProjectSnapshot(target.id)!==ticket.target.raw)
        return {status:"created_unverified",id:target.id};
      return {status:"created",id:target.id};
    }catch{
      return {status:"created_unverified",id:target.id};
    }
  }finally{
    lease.release();
  }
}
