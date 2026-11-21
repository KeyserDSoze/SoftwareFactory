/**
 * Export an exact, revision-pinned historical JSON backup from the isolated
 * IndexedDB editor (#159/#139). This is never a localStorage fallback, an
 * auto-sync, a CAS write or proof that a browser saved the offered download.
 */
import type {FactoryProject} from "../domain/types";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {serializeCasProject} from "../infrastructure/project-cas";
import {
  prepareCasRecoveryTicket,confirmCasRecoveryTicket,
} from "../infrastructure/project-cas-recovery-library";

export type CasIsolatedExportTicket=Readonly<{
  id:string;revision:number;raw:string;fileName:string;
}>;

function canonical(token:CasProjectSnapshot):void {
  try{
    if(!token || !Number.isSafeInteger(token.revision) ||
       token.revision<1 || token.revision>Number.MAX_SAFE_INTEGER-1 ||
       typeof token.raw!=="string" || !token.raw ||
       token.raw.length>1_000_000)
      throw Error("invalid ticket");
    const project=JSON.parse(token.raw) as FactoryProject;
    if(!project || project.id!==token.id ||
       serializeCasProject(project)!==token.raw)
      throw Error("noncanonical");
  }catch{
    throw Error("Snapshot IndexedDB non canonico: esportazione annullata.");
  }
}

function fileName(id:string,revision:number):string {
  return "softwarefactory-idb-project-"+id+"-r"+revision+".json";
}

/** Preflight is pure. Does NOT read/write either storage, or inspect secrets. */
export function prepareCasIsolatedExport(
  expected:CasProjectSnapshot,
):CasIsolatedExportTicket {
  canonical(expected);
  return Object.freeze({
    id:expected.id,revision:expected.revision,raw:expected.raw,
    fileName:fileName(expected.id,expected.revision),
  });
}

/** After the HUMAN approves download, re-read selected IDB revision+raw
 * three times (prepare recovery once, then confirm twice), without retry.
 * A tombstone, stale revision/raw or unavailable DB blocks the download.
 * The returned JSON is historical, not a claim of current cross-device state.
 */
export async function confirmCasIsolatedExport(
  ticket:CasIsolatedExportTicket,downloadConsent:boolean,
):Promise<string> {
  if(downloadConsent!==true)
    throw Error("Consenso export IndexedDB mancante.");
  if(!ticket || typeof ticket.fileName!=="string")
    throw Error("Ticket export IndexedDB mancante.");
  canonical(ticket);
  if(ticket.fileName!==fileName(ticket.id,ticket.revision))
    throw Error("Nome file export IndexedDB non valido.");
  const verified=await prepareCasRecoveryTicket(ticket.id,ticket.revision);
  if(verified.id!==ticket.id || verified.revision!==ticket.revision ||
     verified.raw!==ticket.raw)
    throw Error("La copia IndexedDB è cambiata: backup della selezione annullato.");
  return confirmCasRecoveryTicket(verified,true);
}
