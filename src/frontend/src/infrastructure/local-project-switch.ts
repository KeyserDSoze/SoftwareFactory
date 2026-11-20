import type { FactoryProject } from "../domain/types";
import { loadLocalProject, localProjectSnapshot } from "./store";

/** A user confirmation may take minutes while a different tab edits this
 * project. Pin the exact localStorage value BEFORE showing the confirmation.
 * Never adopt a baseline refreshed after user confirmation: it would make a
 * stale project payload look current after the writer lease is acquired.
 */
export interface LocalProjectSwitchTicket {
  readonly id: string;
  readonly snapshot: string;
  readonly displayName: string;
}

export function assertLocalProjectUnchanged(id: string, expected: string | null): void {
  if (localProjectSnapshot(id) !== expected)
    throw Error("Conflitto locale: progetto modificato durante il cambio. " +
      "Rileggi la libreria e conferma nuovamente, senza sovrascrivere.");
}

export function prepareLocalProjectSwitch(id: string): LocalProjectSwitchTicket {
  const snapshot = localProjectSnapshot(id);
  if (!snapshot) throw Error("Progetto non trovato nella libreria locale.");
  const selected = loadLocalProject(id);
  // Detect even a noncooperative write *during* the initial read. Both checks
  // are synchronous; they are not an IndexedDB transaction or global CAS.
  assertLocalProjectUnchanged(id, snapshot);
  return { id, snapshot, displayName: selected.config.name };
}

/** Call ONLY after acquiring the destination's exclusive writer Web Lock.
 * Recheck before and after loading and use the freshly loaded project, never
 * the pre-confirmation object. A stale ticket must fail without a write.
 */
export function readConfirmedLocalProjectSwitch(ticket: LocalProjectSwitchTicket):
  { project: FactoryProject; snapshot: string } {
  assertLocalProjectUnchanged(ticket.id, ticket.snapshot);
  const project = loadLocalProject(ticket.id);
  assertLocalProjectUnchanged(ticket.id, ticket.snapshot);
  return { project, snapshot: ticket.snapshot };
}
