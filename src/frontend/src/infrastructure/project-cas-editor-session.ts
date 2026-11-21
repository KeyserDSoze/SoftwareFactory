/**
 * Explicit asynchronous CAS write session for the FUTURE live editor cutover.
 * This module must not be wired into the synchronous localStorage editor until
 * every writer, import, restore, GitHub ack and project switch uses it (#139).
 *
 * No Web Locks assumptions; no localStorage fallback; no automatic rebase or
 * retry after an IndexedDB conflict. One in-flight mutation per session.
 */
import type { FactoryProject } from "../domain/types";
import { compareAndSwapCasProject, readCasProjectSlot, serializeCasProject } from "./project-cas";
import type { CasProjectSnapshot } from "./project-cas";

export type CasEditorSessionState = "ready" | "saving" | "blocked";
export type CasEditorSession = Readonly<{
  snapshot(): CasProjectSnapshot;
  state(): CasEditorSessionState;
  commit(next: FactoryProject, expected: CasProjectSnapshot): Promise<CasProjectSnapshot>;
}>;

function copySnapshot(source: CasProjectSnapshot): CasProjectSnapshot {
  // JSON strings are immutable; a new frozen object prevents caller mutation.
  return Object.freeze({id: source.id, revision: source.revision, raw: source.raw});
}

function exactToken(a: CasProjectSnapshot, b: CasProjectSnapshot): boolean {
  return b != null && a.id === b.id && a.revision === b.revision &&
    a.raw === b.raw;
}

/** Explicit open, never bootstrap/import/restore by side effect. */
export async function openCasEditorSession(id: string): Promise<CasEditorSession> {
  const found = await readCasProjectSlot(id);
  if (found.state === "missing")
    throw Error("Progetto IndexedDB assente: importazione esplicita richiesta.");
  if (found.state === "tombstone")
    throw Error("Progetto IndexedDB eliminato: ripristino automatico vietato.");

  // CAS row validation proves basic identity, not byte-for-byte canonical
  // JSON. Reject unusual/noncanonical JSON before returning a write handle.
  let parsed: FactoryProject;
  try {
    parsed = JSON.parse(found.snapshot.raw) as FactoryProject;
    if (serializeCasProject(parsed) !== found.snapshot.raw)
      throw Error("Non-canonical");
  } catch {
    throw Error("Snapshot IndexedDB non canonico: sessione di scrittura bloccata.");
  }
  let token = copySnapshot(found.snapshot);
  let status: CasEditorSessionState = "ready";
  return Object.freeze({
    snapshot: () => copySnapshot(token),
    state: () => status,
    commit: async (next: FactoryProject, expected: CasProjectSnapshot) => {
      if (status === "saving")
        throw Error("Scrittura IndexedDB già in corso: operazione concorrente rifiutata.");
      if (status === "blocked")
        throw Error("Sessione IndexedDB bloccata: verifica le copie e riapri esplicitamente.");
      if (!exactToken(token, expected))
        throw Error("Bozza IndexedDB obsoleta: token di revisione non corrispondente.");
      if (!next || next.id !== token.id)
        throw Error("ID progetto differente: scrittura IndexedDB rifiutata.");

      // Validate candidate before entering the busy state; never write the
      // token or leak a partial acknowledgement for invalid JSON.
      serializeCasProject(next);
      status = "saving";
      try {
        // Resolves only after a genuine IndexedDB transaction's oncomplete.
        const confirmed = await compareAndSwapCasProject(next, token);
        if (confirmed.id !== token.id || confirmed.revision !== token.revision + 1 ||
            confirmed.raw !== serializeCasProject(next)) {
          status = "blocked";
          throw Error("Conferma CAS IndexedDB incoerente: sessione bloccata.");
        }
        token = copySnapshot(confirmed);
        status = "ready";
        return copySnapshot(token);
      } catch {
        // Lost / aborted acknowledgement is indeterminate. No retry on the
        // same session: the user must inspect and explicitly reopen it.
        status = "blocked";
        throw Error("Salvataggio CAS IndexedDB non confermato: possibile conflitto. Riapri esplicitamente dopo verifica.");
      }
    },
  } satisfies CasEditorSession);
}
