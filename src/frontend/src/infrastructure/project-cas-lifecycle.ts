/**
 * Restore planning from an operator-supplied JSON backup (#146/#139).
 * The ACTIVE editor remains on localStorage and does not use this helper.
 * No import/overwrite, no UI action or silent tombstone recreation here.
 */
import type { FactoryProject } from "../domain/types";
import { readCasProjectSlot, restoreCasTombstoneProject, serializeCasProject } from "./project-cas";
import type { CasProjectSnapshot, CasProjectTombstone } from "./project-cas";

export type CasTombstoneRestoreTicket = Readonly<{
  tombstone: CasProjectTombstone;
  raw: string;
}>;

function backupProject(id: string, raw: string): FactoryProject {
  let parsed: FactoryProject;
  try {
    parsed=JSON.parse(raw) as FactoryProject;
    if (parsed.id !== id || serializeCasProject(parsed) !== raw)
      throw Error("Invalid");
  } catch {
    throw Error("Backup JSON non canonico o ID progetto diverso: ripristino annullato.");
  }
  return parsed;
}

/** Read-only ticket before the operator's explicit restore consent. */
export async function prepareCasTombstoneRestore(
  id: string, backedUpRaw: string,
): Promise<CasTombstoneRestoreTicket> {
  backupProject(id,backedUpRaw);
  const slot=await readCasProjectSlot(id);
  if (slot.state !== "tombstone")
    throw Error("Ripristino IndexedDB non consentito: tombstone assente o progetto già presente.");
  return Object.freeze({
    tombstone:Object.freeze({id,revision:slot.revision}),
    raw:backedUpRaw,
  });
}

/**
 * Only a *separate* explicit action can accept a prepared ticket.
 * Re-reads the tombstone before invoking a revision-fenced native readwrite
 * transaction, where another writer may still win and make us fail closed.
 */
export async function confirmCasTombstoneRestore(
  ticket: CasTombstoneRestoreTicket, userConfirmed: boolean,
): Promise<CasProjectSnapshot> {
  if (userConfirmed !== true)
    throw Error("Conferma esplicita del ripristino IndexedDB obbligatoria.");
  if (!ticket || !ticket.tombstone)
    throw Error("Ticket tombstone IndexedDB non valido.");
  const {id,revision}=ticket.tombstone;
  const project=backupProject(id,ticket.raw);
  if (!Number.isSafeInteger(revision) || revision < 1 ||
      revision > Number.MAX_SAFE_INTEGER-1)
    throw Error("Revisione tombstone IndexedDB non valida.");
  const current=await readCasProjectSlot(id);
  if (current.state !== "tombstone" || current.revision !== revision)
    throw Error("Tombstone IndexedDB cambiata: prepara un nuovo ripristino.");
  // Never preflight a capacity count outside the real write transaction.
  return restoreCasTombstoneProject(project,ticket.tombstone,ticket.raw,true);
}
