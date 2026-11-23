/**
 * #175/#139: create a NEW CAS-only IndexedDB project from a retired
 * historical legacy project's validated non-secret CONFIGURATION only.
 * No original-ID retry, legacy write, local target or cross-store merging.
 */
import type {FactoryProject} from "../domain/types";
import {
  prepareRetiredLegacyConfigFork,assertRetiredLegacyForkSource,
  validateRetiredLegacyForkTarget,
} from "./legacy-retired-config-fork";
import type {RetiredLegacyForkTicket} from "./legacy-retired-config-fork";
import {casHandoffRawDigest} from "./cas-root-workspace";
import type {CasHandoffHint} from "./cas-root-workspace";
import {readLegacyCasRetirement}
  from "../infrastructure/legacy-cas-retirement";
import {localProjectSnapshot} from "../infrastructure/store";
import {insertCasProjectNeverSeen,readCasProjectSlot}
  from "../infrastructure/project-cas";

export type RetiredLegacyToCasTicket=RetiredLegacyForkTicket;
export type RetiredLegacyToCasResult=Readonly<{
  status:"ready"|"copied_unverified";
  id:string;revision:1;hint?:CasHandoffHint;
}>;

function assertLocalTargetAbsent(id:string):void {
  // Require a fresh identity in BOTH stores, not just in native IDB.
  // The read is only a preflight: native IDB transaction remains authoritative.
  if(localProjectSnapshot(id)!==null || readLegacyCasRetirement(id)!==null)
    throw Error("UUID fork CAS già occupato/protetto nel legacy.");
}
async function assertNativeTargetAbsent(id:string):Promise<void> {
  const slot=await readCasProjectSlot(id);
  if(slot.state!=="missing")
    throw Error("UUID fork CAS presente o tombstoned: non sovrascrivere.");
}

/** Read-only ticket preparation; no IDB insert and no legacy writes. */
export async function prepareRetiredLegacyToCasFork(
  sourceId:string,
):Promise<RetiredLegacyToCasTicket> {
  const ticket=await prepareRetiredLegacyConfigFork(sourceId);
  assertLocalTargetAbsent(ticket.target.id);
  await assertNativeTargetAbsent(ticket.target.id);
  await assertRetiredLegacyForkSource(ticket.source);
  assertLocalTargetAbsent(ticket.target.id);
  return ticket;
}

/**
 * EXACT raw source download and three confirmations are caller obligations.
 * A second preflight after confirmations catches tombstones/collisions; the
 * native tx itself is insert-only never-seen, including 40 active cap.
 *
 * Never repeat a native insert after a lost ACK. Even after tx.oncomplete,
 * a readback/source race can at most downgrade navigation to unverified.
 */
export async function commitRetiredLegacyToCasFork(
  ticket:RetiredLegacyToCasTicket,
  consent:boolean,isStable:()=>boolean,
):Promise<RetiredLegacyToCasResult> {
  if(consent!==true || typeof isStable!=="function" || !isStable())
    throw Error("Fork CAS non autorizzato o writer legacy sorgente instabile.");
  const source=await assertRetiredLegacyForkSource(ticket.source);
  const target=validateRetiredLegacyForkTarget(ticket,source);
  assertLocalTargetAbsent(target.id);
  await assertNativeTargetAbsent(target.id);
  if(!isStable())throw Error("Workspace legacy cambiato prima del fork CAS.");
  await assertRetiredLegacyForkSource(ticket.source);
  assertLocalTargetAbsent(target.id);
  if(!isStable())throw Error("Sorgente legacy cambiata durante il fork CAS.");
  // No localStorage setItem; a native readwrite transaction checks
  // tombstones, present rows, capacity and inserts exactly once.
  const inserted=await insertCasProjectNeverSeen(target,ticket.target.raw);
  if(inserted.id!==ticket.target.id || inserted.revision!==1 ||
     inserted.raw!==ticket.target.raw)
    return {status:"copied_unverified",id:ticket.target.id,revision:1};
  try{
    const slot=await readCasProjectSlot(target.id);
    if(slot.state!=="present" || slot.snapshot.id!==target.id ||
       slot.snapshot.revision!==1 ||
       slot.snapshot.raw!==ticket.target.raw ||
       !isStable())
      return {status:"copied_unverified",id:ticket.target.id,revision:1};
    await assertRetiredLegacyForkSource(ticket.source);
    assertLocalTargetAbsent(target.id);
    if(!isStable())
      return {status:"copied_unverified",id:ticket.target.id,revision:1};
    // Handoff hint is a local selector, NOT an auto-open authority:
    // CAS-only root still requires a second explicit operator decision.
    const digest=await casHandoffRawDigest(ticket.target.raw);
    if(!isStable() || localProjectSnapshot(ticket.source.id)!==
         ticket.source.raw)
      return {status:"copied_unverified",id:ticket.target.id,revision:1};
    return {
      status:"ready",id:ticket.target.id,revision:1,
      hint:Object.freeze({id:ticket.target.id,revision:1,digest}),
    };
  }catch{
    return {status:"copied_unverified",id:ticket.target.id,revision:1};
  }
}
