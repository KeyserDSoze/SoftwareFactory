/**
 * #178/#139 — manual, configuration-only import from a local JSON backup.
 * The historical project is only an untrusted INPUT, never a native CAS
 * revision to reopen: issue a fresh UUID, strip all evidence and use exactly
 * one never-seen IndexedDB transaction. Never read the legacy localStorage.
 */
import {createProject,STAGES} from "../domain/defaults";
import type {FactoryProject} from "../domain/types";
import {
  compareAndSwapCasProject,serializeCasProject,
} from "../infrastructure/project-cas";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {checkedCasForkSource} from "./cas-isolated-config-fork";
import {CAS_ISOLATED_NAME_MAX} from "./cas-isolated-config";

const MAX_BACKUP_CHARS=1_000_000;
const ALLOWED_SOURCE_KEYS=new Set([
  "id","config","stages","createdAt","updatedAt",
  "development","githubDestination","githubSync","githubTestReceipt",
]);
const IMPORT_SUFFIX=" (import)";

export type CasExternalConfigImportTicket=Readonly<{
  source:CasProjectSnapshot;id:string;name:string;raw:string;
}>;

function sourceFromRaw(raw:string):CasProjectSnapshot {
  if(typeof raw!=="string" || !raw || raw.length>MAX_BACKUP_CHARS)
    throw Error("Backup JSON CAS non valido o troppo grande.");
  try {
    const value=JSON.parse(raw) as FactoryProject;
    if(!value || typeof value!=="object" || Array.isArray(value) ||
       Object.keys(value).some(key=>!ALLOWED_SOURCE_KEYS.has(key)) ||
       typeof value.createdAt!=="string" ||
       !Number.isFinite(Date.parse(value.createdAt)) ||
       typeof value.id!=="string")
      throw Error("Invalid source");
    const token:CasProjectSnapshot={id:value.id,revision:1,raw};
    // Reuse the same strict canonical stage/stack/no-known-secret gates
    // as the native IDB configuration-only fork, without any store access.
    checkedCasForkSource(token);
    return Object.freeze(token);
  }catch{
    throw Error("Backup JSON CAS non canonico o con configurazione non sicura.");
  }
}

function importedName(name:string):string {
  return name.slice(0,CAS_ISOLATED_NAME_MAX-IMPORT_SUFFIX.length).trimEnd()+
    IMPORT_SUFFIX;
}

export function prepareCasExternalConfigImport(
  raw:string,
):CasExternalConfigImportTicket {
  const source=sourceFromRaw(raw);
  const historical=checkedCasForkSource(source);
  const name=importedName(historical.config.name);
  const fresh=createProject();
  if(fresh.id===source.id)throw Error("UUID progetto importato non nuovo.");
  const target:FactoryProject={
    ...fresh,config:{...structuredClone(historical.config),name},
  };
  const serialized=serializeCasProject(target);
  return Object.freeze({source,id:target.id,name,raw:serialized});
}

function checkedTarget(ticket:CasExternalConfigImportTicket):FactoryProject {
  if(!ticket || ticket.source?.revision!==1 ||
     typeof ticket.raw!=="string" || ticket.raw.length>MAX_BACKUP_CHARS)
    throw Error("Ticket import CAS non valido.");
  const historical=checkedCasForkSource(sourceFromRaw(ticket.source.raw));
  const expectedName=importedName(historical.config.name);
  let target:FactoryProject;
  try {
    target=JSON.parse(ticket.raw) as FactoryProject;
    const blankStages=STAGES.map(({id,label})=>({
      id,label,status:"pending",output:"",sources:[],
    }));
    if(!target || target.id!==ticket.id || target.id===ticket.source.id ||
       ticket.source.id!==historical.id || ticket.name!==expectedName ||
       target.config?.name!==expectedName ||
       Object.keys(target).sort().join(",")!==
         "config,createdAt,id,stages,updatedAt" ||
       target.createdAt!==target.updatedAt ||
       JSON.stringify(target.config)!==
         JSON.stringify({...historical.config,name:expectedName}) ||
       JSON.stringify(target.stages)!==JSON.stringify(blankStages) ||
       serializeCasProject(target)!==ticket.raw)
      throw Error("Tampered ticket");
  }catch{
    throw Error("Ticket import CAS alterato o con evidenze non consentite.");
  }
  return target;
}

/** Single native insert-only call after a distinct human confirmation.
 * A rejected/ambiguous ACK is NOT permission to retry automatically.
 */
export async function confirmCasExternalConfigImport(
  ticket:CasExternalConfigImportTicket,consent:boolean,
):Promise<CasProjectSnapshot> {
  if(consent!==true)throw Error("Consenso import CAS non fornito.");
  const target=checkedTarget(ticket);
  const ack=await compareAndSwapCasProject(target,null);
  if(ack.id!==ticket.id || ack.revision!==1 || ack.raw!==ticket.raw)
    throw Error("ACK import CAS ambiguo: controllare libreria, non ritentare.");
  return Object.freeze({id:ack.id,revision:ack.revision,raw:ack.raw});
}
