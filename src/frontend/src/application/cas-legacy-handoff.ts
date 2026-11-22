/**
 * #171/#139 — single, explicitly consented LEGACY → CAS-only handoff.
 * Unlike the preview copy (#141), a successful readback can navigate to the
 * standalone CAS root, but ONLY with an untrusted ID/revision/digest hint.
 * Legacy and IDB writes are not atomic together; never erase either source.
 */
import type {FactoryProject} from "../domain/types";
import {prepareLegacyCasCopy,copyLegacyCasTicket}
  from "../infrastructure/project-cas-migration";
import type {LegacyCasCopyTicket}
  from "../infrastructure/project-cas-migration";
import {readCasProjectSlot,serializeCasProject}
  from "../infrastructure/project-cas";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {inspectCasIsolatedStages} from "./cas-isolated-stage-inspection";
import {validateCasIsolatedStackConfig} from "./cas-isolated-stack-config";
import {casHandoffRawDigest} from "./cas-root-workspace";
import type {CasHandoffHint} from "./cas-root-workspace";

export type LegacyCasHandoffTicket=Readonly<LegacyCasCopyTicket>;
export type LegacyCasHandoffResult=Readonly<{
  status:"ready"|"copied_unverified";
  id:string;revision:number;
  hint?:CasHandoffHint;
}>;

function checkSource(ticket:LegacyCasHandoffTicket,
  live:FactoryProject):void {
  try{
    if(!ticket || !live || ticket.id!==live.id ||
       typeof ticket.raw!=="string" ||
       ticket.raw.length>1_000_000 ||
       serializeCasProject(live)!==ticket.raw ||
       !validateCasIsolatedStackConfig(live.config))
      throw Error("Unsafe live ticket");
    const inspected=inspectCasIsolatedStages({
      id:ticket.id,revision:1,raw:ticket.raw,
    });
    if(!inspected || inspected.some(s=>
      s.status==="invalid" || s.status==="running"))
      throw Error("Running/inconsistent stage");
    // Existing Code Agent/GitHub evidence may be copied AS HISTORICAL DATA,
    // not marked reviewed/passed or automatically published. No credentials.
    if(live.stages.some(s=>s.status==="running"))
      throw Error("Running stage");
  }catch{
    throw Error("Progetto legacy non compatibile o non fermo per il trasferimento CAS.");
  }
}

/** No legacy writes. Read-only precheck distinguishes missing from tombstone
 * and already-present (even identical) CAS source; no implicit merge/replace.
 */
export async function prepareLegacyCasHandoff(
  live:FactoryProject,
):Promise<LegacyCasHandoffTicket> {
  const ticket=prepareLegacyCasCopy(live.id);
  checkSource(ticket,live);
  const slot=await readCasProjectSlot(ticket.id);
  if(slot.state!=="missing")
    throw Error("ID IndexedDB già esistente o eliminato: verifica le copie prima di trasferire.");
  // Recheck after asynchronous IDB read, while local editor holds its lease.
  if(prepareLegacyCasCopy(ticket.id).raw!==ticket.raw)
    throw Error("Sorgente legacy cambiata durante il controllo.");
  return Object.freeze({id:ticket.id,raw:ticket.raw});
}

/**
 * Caller MUST first obtain three consents including a byte-exact backed-up
 * JSON on disk, and must maintain an exclusive live writer lease.
 * Ready guard is sampled before/after every asynchronous boundary.
 */
export async function commitLegacyCasHandoff(
  ticket:LegacyCasHandoffTicket,
  consent:boolean,isStable:()=>boolean,
):Promise<LegacyCasHandoffResult> {
  if(consent!==true || typeof isStable!=="function" || !isStable())
    throw Error("Trasferimento legacy→CAS non autorizzato o progetto cambiato.");
  const live=JSON.parse(ticket.raw) as FactoryProject;
  checkSource(ticket,live);
  if(prepareLegacyCasCopy(ticket.id).raw!==ticket.raw)
    throw Error("Sorgente legacy cambiata: nessuna copia autorizzata.");
  const before=await readCasProjectSlot(ticket.id);
  if(before.state!=="missing")
    throw Error("La destinazione IndexedDB non è libera: nessuna sovrascrittura.");
  if(!isStable() || prepareLegacyCasCopy(ticket.id).raw!==ticket.raw)
    throw Error("Sorgente legacy cambiata prima della scrittura.");
  // Atomic insert-only IDB: native tx checks missing/tombstone/cap40.
  // If an ACK is lost or legacy changes DURING the write, do not retry.
  const acknowledged=await copyLegacyCasTicket(ticket,true);
  if(acknowledged.id!==ticket.id || acknowledged.revision!==1 ||
     acknowledged.raw!==ticket.raw)
    return {status:"copied_unverified",id:ticket.id,revision:1};
  // Observation after ACK must never reclassify a committed insert as
  // "failed copy". The operator can inspect the IDB library manually.
  try{
    const observed=await readCasProjectSlot(ticket.id);
    if(!isStable() || prepareLegacyCasCopy(ticket.id).raw!==ticket.raw ||
       observed.state!=="present" ||
       !sameSnapshot(acknowledged,observed.snapshot))
      return {status:"copied_unverified",id:ticket.id,revision:1};
    const digest=await casHandoffRawDigest(acknowledged.raw);
    if(!isStable() || prepareLegacyCasCopy(ticket.id).raw!==ticket.raw)
      return {status:"copied_unverified",id:ticket.id,revision:1};
    return {
      status:"ready",id:ticket.id,revision:1,
      hint:Object.freeze({id:ticket.id,revision:1,digest}),
    };
  }catch{
    return {status:"copied_unverified",id:ticket.id,revision:1};
  }
}
function sameSnapshot(a:CasProjectSnapshot,b:CasProjectSnapshot):boolean {
  return a.id===b.id && a.revision===b.revision && a.raw===b.raw;
}
