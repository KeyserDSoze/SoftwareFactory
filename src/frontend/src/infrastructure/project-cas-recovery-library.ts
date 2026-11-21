/**
 * Read-only historical IndexedDB recovery independent of localStorage (#145).
 * Staged CAS copies can outlive/corrupt their legacy slots. Never auto-restore,
 * set active project, mutate IndexedDB, or silently accept a newer revision.
 */
import type { FactoryProject } from "../domain/types";
import {
  listCasProjects, readCasProjectSlot, serializeCasProject,
} from "./project-cas";
import type { CasProjectChoice, CasProjectSlot, CasProjectSnapshot } from "./project-cas";

export type CasRecoveryTicket = Readonly<{
  id: string; revision: number; raw: string;
}>;

/** Fail closed on an unreadable, corrupt, or overfull IndexedDB library. */
export async function listCasRecoveryCopies(): Promise<CasProjectChoice[]> {
  return listCasProjects();
}

function canonical(snapshot: CasProjectSnapshot): void {
  try {
    const parsed = JSON.parse(snapshot.raw) as FactoryProject;
    if (parsed.id !== snapshot.id ||
        serializeCasProject(parsed) !== snapshot.raw)
      throw Error("Mismatch");
  } catch {
    throw Error("Copia IndexedDB non canonica: export annullato.");
  }
}

function same(slot: CasProjectSlot, expected: CasRecoveryTicket): boolean {
  return slot.state === "present" &&
    slot.snapshot.id === expected.id &&
    slot.snapshot.revision === expected.revision &&
    slot.snapshot.raw === expected.raw;
}

function checkTicket(ticket: CasRecoveryTicket): void {
  if (!ticket || !Number.isSafeInteger(ticket.revision) ||
      ticket.revision < 1 || ticket.revision > Number.MAX_SAFE_INTEGER-1 ||
      typeof ticket.raw !== "string" || ticket.raw.length === 0 ||
      ticket.raw.length > 1_000_000) {
    throw Error("Ticket recupero IndexedDB non valido.");
  }
  canonical(ticket);
}

/** Prepare BEFORE the human confirms the historical JSON export.
 * The listed revision is a UI epoch: refuse a changed slot, even if valid.
 */
export async function prepareCasRecoveryTicket(
  id: string, listedRevision: number,
): Promise<CasRecoveryTicket> {
  if (!Number.isSafeInteger(listedRevision) || listedRevision < 1 ||
      listedRevision > Number.MAX_SAFE_INTEGER-1)
    throw Error("Revisione elenco IndexedDB non valida.");
  const slot=await readCasProjectSlot(id);
  if (slot.state !== "present" || slot.snapshot.revision !== listedRevision)
    throw Error("La copia IndexedDB è cambiata dall'elenco: aggiorna la libreria.");
  canonical(slot.snapshot);
  return Object.freeze({
    id:slot.snapshot.id, revision:slot.snapshot.revision, raw:slot.snapshot.raw,
  });
}

/** Re-read exact ID/revision/raw TWICE after user consent. Never trust only a
 * revision: noncooperating writers may tamper with raw at same revision.
 * A stable result is a point-in-time historical export, not a live backup.
 */
export async function confirmCasRecoveryTicket(
  ticket: CasRecoveryTicket, consent: boolean,
): Promise<string> {
  if (consent !== true)
    throw Error("Consenso al download storico IndexedDB mancante.");
  checkTicket(ticket);
  const first=await readCasProjectSlot(ticket.id);
  if (!same(first,ticket))
    throw Error("Copia IndexedDB cambiata: ricarica la libreria prima di esportare.");
  const second=await readCasProjectSlot(ticket.id);
  if (!same(second,ticket))
    throw Error("Copia IndexedDB cambiata: ricarica la libreria prima di esportare.");
  return ticket.raw;
}
