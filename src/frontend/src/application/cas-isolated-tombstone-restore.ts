/**
 * #179/#139: operator-selected backup for an existing native CAS tombstone.
 * Historical data is NOT fresh test/review/runner/GitHub evidence.
 * No legacy store, remote sync, fallback or automatic retry.
 */
import type {CasProjectSnapshot,CasProjectTombstone} from "../infrastructure/project-cas";
import {parseCasRestoreBackupFile} from "../infrastructure/project-cas-restore-file";
import {prepareCasTombstoneRestore,confirmCasTombstoneRestore} from "../infrastructure/project-cas-lifecycle";

export type CasIsolatedTombstoneRestoreTicket=Readonly<{
  id:string;name:string;raw:string;tombstone:CasProjectTombstone;
}>;

/** Read-only preflight. Require an existing tombstone of the original ID. */
export async function prepareCasIsolatedTombstoneRestore(
  fileContent:string,
):Promise<CasIsolatedTombstoneRestoreTicket> {
  const backup=parseCasRestoreBackupFile(fileContent);
  const native=await prepareCasTombstoneRestore(backup.id,backup.raw);
  if(native.tombstone.id!==backup.id || native.raw!==backup.raw)
    throw Error("Ticket restore CAS non coerente.");
  return Object.freeze({
    id:backup.id,name:backup.name,raw:backup.raw,
    tombstone:Object.freeze({
      id:native.tombstone.id,revision:native.tombstone.revision,
    }),
  });
}

/** Native implementation rechecks tombstone and commits in ONE IDB readwrite
 * transaction, ACKing only on tx.oncomplete. Lost ACK is not retry authority.
 */
export async function confirmCasIsolatedTombstoneRestore(
  ticket:CasIsolatedTombstoneRestoreTicket,
  consent:boolean,
):Promise<CasProjectSnapshot> {
  if(consent!==true)throw Error("Consenso al ripristino CAS mancante.");
  if(!ticket || !ticket.tombstone ||
     !Number.isSafeInteger(ticket.tombstone.revision) ||
     ticket.tombstone.revision<1 ||
     ticket.tombstone.revision>=Number.MAX_SAFE_INTEGER-1)
    throw Error("Ticket tombstone CAS non valido.");
  const backup=parseCasRestoreBackupFile(ticket.raw);
  if(backup.raw!==ticket.raw || backup.id!==ticket.id ||
     backup.name!==ticket.name || ticket.tombstone.id!==ticket.id)
    throw Error("Ticket CAS manomesso.");
  const saved=await confirmCasTombstoneRestore({
    raw:ticket.raw,tombstone:ticket.tombstone,
  },true);
  if(saved.id!==ticket.id ||
     saved.revision!==ticket.tombstone.revision+1 ||
     saved.raw!==ticket.raw)
    throw Error("ACK restore CAS ambiguo: controllare la libreria.");
  return Object.freeze({id:saved.id,revision:saved.revision,raw:saved.raw});
}
