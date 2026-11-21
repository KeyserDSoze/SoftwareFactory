/**
 * Future opt-in IndexedDB-only project selection coordinator (#144/#139).
 * NOT connected to the live localStorage editor. This coordinator owns the
 * only writable CAS session: callers never receive an unguarded session.
 *
 * Prepare a destination ticket before user consent. Reopen and verify exact
 * ID/revision/JSON after consent. Never silently adopt later tab writes.
 */
import type { FactoryProject } from "../domain/types";
import { deleteCasProject, listCasProjects } from "./project-cas";
import type { CasProjectChoice, CasProjectSnapshot, CasProjectTombstone } from "./project-cas";
import { openCasEditorSession } from "./project-cas-editor-session";
import type { CasEditorSession } from "./project-cas-editor-session";

export type CasSelectionState = "ready" | "saving" | "switching" | "blocked";
export type CasSwitchTicket = Readonly<{
  source: CasProjectSnapshot;
  destination: CasProjectSnapshot;
  generation: number;
}>;
export type CasSelectionController = Readonly<{
  state(): CasSelectionState;
  snapshot(): CasProjectSnapshot;
  list(): Promise<CasProjectChoice[]>;
  prepareSwitch(id: string): Promise<CasSwitchTicket>;
  confirmSwitch(ticket: CasSwitchTicket): Promise<CasProjectSnapshot>;
  commit(next: FactoryProject, expected: CasProjectSnapshot): Promise<CasProjectSnapshot>;
  delete(expected: CasProjectSnapshot, consent: boolean): Promise<CasProjectTombstone>;
}>;

function frozenSnapshot(value: CasProjectSnapshot): CasProjectSnapshot {
  return Object.freeze({id: value.id, revision: value.revision, raw: value.raw});
}
function exact(a: CasProjectSnapshot, b: CasProjectSnapshot): boolean {
  return Boolean(a && b) && a.id === b.id && a.revision === b.revision &&
    a.raw === b.raw;
}
function requireReady(state: CasSelectionState): void {
  if (state !== "ready")
    throw Error("Selezione IndexedDB sospesa: salvataggio, cambio o conflitto in corso.");
}

/** Opening a controller NEVER creates or imports a missing project. */
export async function openCasSelectionController(id: string): Promise<CasSelectionController> {
  let active: CasEditorSession = await openCasEditorSession(id);
  let state: CasSelectionState = "ready";
  let generation = 0;

  return Object.freeze({
    state: () => state,
    snapshot: () => frozenSnapshot(active.snapshot()),
    list: async () => {
      requireReady(state);
      const version = generation;
      const choices = await listCasProjects();
      if (state !== "ready" || generation !== version)
        throw Error("Elenco IndexedDB obsoleto: ripeti la lettura.");
      return choices;
    },
    prepareSwitch: async (targetId: string) => {
      requireReady(state);
      const from = frozenSnapshot(active.snapshot());
      const version = generation;
      if (targetId === from.id)
        throw Error("Progetto IndexedDB già selezionato.");
      // Read-only, before displaying confirmation. May be obsolete later.
      const target = await openCasEditorSession(targetId);
      if (state !== "ready" || generation !== version ||
          !exact(active.snapshot(), from))
        throw Error("La selezione è cambiata: ripeti il controllo del progetto.");
      return Object.freeze({
        source: from,
        destination: frozenSnapshot(target.snapshot()),
        generation: version,
      });
    },
    confirmSwitch: async (ticket: CasSwitchTicket) => {
      requireReady(state);
      if (!ticket || !ticket.source || !ticket.destination ||
          !Number.isSafeInteger(ticket.generation) ||
          ticket.generation !== generation ||
          !exact(active.snapshot(), ticket.source) ||
          ticket.source.id === ticket.destination.id)
        throw Error("Ticket IndexedDB obsoleto: ripeti la selezione e il consenso.");
      state = "switching";
      try {
        // Open again *after* consent. Never adopt a newer destination row.
        const next = await openCasEditorSession(ticket.destination.id);
        if (!exact(next.snapshot(), ticket.destination) ||
            !exact(active.snapshot(), ticket.source))
          throw Error("Destinazione IndexedDB cambiata: selezione annullata.");
        active = next;
        generation++;
        state = "ready";
        return frozenSnapshot(next.snapshot());
      } catch {
        // No mutation of source or destination occurred. The old session
        // remains available, subject to its normal transactional CAS guard.
        state = "ready";
        throw Error("Cambio progetto IndexedDB non confermato: selezione precedente conservata.");
      }
    },
    commit: async (next: FactoryProject, expected: CasProjectSnapshot) => {
      requireReady(state);
      const before = active.snapshot();
      if (!exact(before, expected))
        throw Error("Snapshot IndexedDB obsoleto: salvataggio annullato.");
      state = "saving";
      try {
        // Active session advances its token only after transaction oncomplete.
        const acknowledged = await active.commit(next, before);
        generation++;
        state = "ready";
        return frozenSnapshot(acknowledged);
      } catch {
        // Invalid drafts remain retryable only when no transaction started;
        // ambiguous CAS/conflict blocks until explicit full reopen.
        state = active.state() === "blocked" ? "blocked" : "ready";
        throw Error("Salvataggio IndexedDB non confermato: verifica il progetto prima di continuare.");
      }
    },
    delete: async (expected: CasProjectSnapshot, consent: boolean) => {
      requireReady(state);
      if (consent !== true)
        throw Error("Eliminazione IndexedDB non autorizzata: consenso obbligatorio.");
      const before=active.snapshot();
      if (!exact(before, expected))
        throw Error("Ticket cancellazione IndexedDB obsoleto.");
      state = "saving";
      try {
        // Native deleteCasProject fences against direct noncooperating writers.
        // No success/advance before the IDB transaction oncomplete.
        const tombstone=await deleteCasProject(before.id,before);
        if (tombstone.id !== before.id ||
            tombstone.revision !== before.revision + 1)
          throw Error("Conferma tombstone incoerente.");
        generation++;
        // The selected project no longer exists. Never leave a writable
        // controller pointing at deleted state; explicit reopen is required.
        state = "blocked";
        return Object.freeze({id:tombstone.id,revision:tombstone.revision});
      } catch {
        // An aborted/lost acknowledgement might already have deleted the
        // project. Do not retry or continue editing with the old token.
        state = "blocked";
        throw Error("Eliminazione IndexedDB non confermata: verifica la tombstone prima di proseguire.");
      }
    },
  } satisfies CasSelectionController);
}
