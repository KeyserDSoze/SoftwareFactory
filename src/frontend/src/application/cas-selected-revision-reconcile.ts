/**
 * #185/#139 — explicit read-only CAS selected-revision reconciliation.
 * A pinned session is NEVER automatically rebased to a rival tab's newer raw.
 * A "tombstone" is not missing, and neither can be resurrected by inspection.
 */
import type {FactoryProject} from "../domain/types";
import {
  readCasProjectSlot,serializeCasProject,
} from "../infrastructure/project-cas";
import type {
  CasProjectSlot,CasProjectSnapshot,CasProjectTombstone,
} from "../infrastructure/project-cas";

export type CasRevisionRead=(id:string)=>Promise<CasProjectSlot>;
export type CasSelectedRevisionObservation=
  | Readonly<{state:"unchanged";old:CasProjectSnapshot}>
  | Readonly<{state:"advanced";old:CasProjectSnapshot;next:CasProjectSnapshot}>
  | Readonly<{state:"tombstone";old:CasProjectSnapshot;deleted:CasProjectTombstone}>
  | Readonly<{state:"missing";old:CasProjectSnapshot}>;

const MAX_REVISION=Number.MAX_SAFE_INTEGER-1;

function canonical(snapshot:CasProjectSnapshot):CasProjectSnapshot {
  try{
    if(!snapshot || typeof snapshot.raw!=="string" ||
       !Number.isSafeInteger(snapshot.revision) ||
       snapshot.revision<1 || snapshot.revision>MAX_REVISION ||
       snapshot.raw.length===0 || snapshot.raw.length>1_000_000)
      throw Error("Bad CAS revision");
    const p=JSON.parse(snapshot.raw) as FactoryProject;
    if(!p || p.id!==snapshot.id ||
       serializeCasProject(p)!==snapshot.raw)
      throw Error("Noncanonical native raw");
    return Object.freeze({
      id:snapshot.id,revision:snapshot.revision,raw:snapshot.raw,
    });
  }catch{
    throw Error("Revisione IndexedDB non canonica: confronto bloccato.");
  }
}
function exact(a:CasProjectSnapshot,b:CasProjectSnapshot):boolean {
  return a.id===b.id && a.revision===b.revision && a.raw===b.raw;
}

/** An observational read: no IndexedDB writes, no legacy, no auto adoption.
 * Dirty UI drafts may request inspection, but NEVER consent to rebase.
 */
export async function prepareCasSelectedRevisionReconcile(
  selected:CasProjectSnapshot,
  read:CasRevisionRead=readCasProjectSlot,
):Promise<CasSelectedRevisionObservation> {
  const old=canonical(selected);
  const now=await read(old.id);
  if(now.state==="missing")
    return Object.freeze({state:"missing" as const,old});
  if(now.state==="tombstone"){
    if(!Number.isSafeInteger(now.revision) ||
       now.revision<=old.revision || now.revision>MAX_REVISION)
      throw Error("Tombstone IndexedDB incoerente: confronto bloccato.");
    return Object.freeze({
      state:"tombstone" as const,old,
      deleted:Object.freeze({id:old.id,revision:now.revision}),
    });
  }
  const next=canonical(now.snapshot);
  if(next.id!==old.id || next.revision<old.revision ||
     (next.revision===old.revision && !exact(next,old)))
    throw Error("Revisione IndexedDB non monotona o RAW divergente.");
  if(exact(next,old))
    return Object.freeze({state:"unchanged" as const,old});
  return Object.freeze({state:"advanced" as const,old,next});
}

/** Final consent NEVER overrides or merges; it re-reads the exact
 * revision/raw found BEFORE user consent. A second read in the UI when
 * opening the new controller prevents adoption of another later winner.
 */
export async function confirmCasSelectedRevisionReconcile(
  ticket:CasSelectedRevisionObservation,
  consent:boolean,isStable:()=>boolean,
  read:CasRevisionRead=readCasProjectSlot,
):Promise<CasProjectSnapshot> {
  if(consent!==true)
    throw Error("Consenso alla revisione rivale IndexedDB obbligatorio.");
  if(typeof isStable!=="function" || !isStable())
    throw Error("Selezione CAS, pipeline o bozze modificate.");
  if(!ticket || ticket.state!=="advanced")
    throw Error("Nessuna revisione IndexedDB avanzata da adottare.");
  const old=canonical(ticket.old),next=canonical(ticket.next);
  if(old.id!==next.id || next.revision<=old.revision)
    throw Error("Ticket revisione IndexedDB non valido.");
  const current=await read(old.id);
  if(!isStable())
    throw Error("Selezione CAS cambiata durante ricognizione.");
  if(current.state!=="present" ||
     !exact(canonical(current.snapshot),next))
    throw Error("Una nuova modifica IndexedDB ha invalidato il consenso.");
  return next;
}
