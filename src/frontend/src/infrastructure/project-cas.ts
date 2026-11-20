/**
 * IndexedDB compare-and-swap foundation for a FUTURE opt-in local project
 * cutover (#138). The live Factory editor still uses localStorage. This is a
 * real atomic IDB transaction for callers of this module, not a claim that
 * legacy localStorage writers are fenced.
 *
 * Never await a promise inside a readwrite transaction: IDB will deactivate
 * it between event-loop tasks. The get/compare/put/delete run entirely in
 * request callbacks in ONE transaction; acknowledgement is tx.oncomplete.
 */
import type { FactoryProject } from "../domain/types";

const DATABASE = "softwarefactory.project.cas.v1";
const STORE = "projects";
const PROJECT_ID = /^[0-9a-f-]{36}$/i;
const MAX_RAW_CHARS = 1_000_000;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;

type Row = { id: string; revision: number; raw: string | null };
export type CasProjectSnapshot = Readonly<{
  id: string; revision: number; raw: string;
}>;
export type CasProjectTombstone = Readonly<{ id: string; revision: number }>;

function checkId(id: string): void {
  if (typeof id !== "string" || !PROJECT_ID.test(id))
    throw Error("ID progetto IndexedDB non valido.");
}

export function serializeCasProject(project: FactoryProject): string {
  if (!project || !PROJECT_ID.test(project.id) || !project.config ||
      typeof project.config.name !== "string" || !Array.isArray(project.stages) ||
      typeof project.updatedAt !== "string" ||
      project.updatedAt.length > 64 || !Number.isFinite(Date.parse(project.updatedAt)))
    throw Error("Progetto IndexedDB non valido.");
  let raw: string | undefined;
  try { raw = JSON.stringify(project); }
  catch { throw Error("Progetto IndexedDB non serializzabile."); }
  if (!raw || raw.length > MAX_RAW_CHARS)
    throw Error("Progetto IndexedDB troppo grande: supera il limite locale.");
  return raw;
}

function readRow(value: unknown, id: string): Row | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Archivio IndexedDB locale corrotto.");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "id,raw,revision" ||
      r.id !== id || !Number.isSafeInteger(r.revision) ||
      (r.revision as number) < 1 || (r.revision as number) > MAX_REVISION ||
      (r.raw !== null && (typeof r.raw !== "string" ||
        !r.raw || r.raw.length > MAX_RAW_CHARS)))
    throw Error("Archivio IndexedDB locale corrotto.");
  if (typeof r.raw === "string") {
    let project: unknown;
    try { project = JSON.parse(r.raw); }
    catch { throw Error("Archivio IndexedDB locale corrotto."); }
    const parsed = project as Partial<FactoryProject> | null;
    if (!parsed || parsed.id !== id || !parsed.config ||
        typeof parsed.config.name !== "string" || !Array.isArray(parsed.stages) ||
        typeof parsed.updatedAt !== "string" ||
        parsed.updatedAt.length > 64 || !Number.isFinite(Date.parse(parsed.updatedAt)))
      throw Error("Archivio IndexedDB locale corrotto.");
  }
  return { id, revision: r.revision as number, raw: r.raw as string | null };
}

function checkExpected(id: string, expected: CasProjectSnapshot | null): void {
  if (expected === null) return;
  if (!expected || expected.id !== id ||
      !Number.isSafeInteger(expected.revision) || expected.revision < 1 ||
      expected.revision > MAX_REVISION || typeof expected.raw !== "string" ||
      !expected.raw || expected.raw.length > MAX_RAW_CHARS)
    throw Error("Versione CAS IndexedDB non valida.");
}

function matchesExpected(current: Row | null, expected: CasProjectSnapshot | null): boolean {
  if (expected === null) return current === null || current.raw === null;
  return current !== null && current.raw !== null &&
    current.revision === expected.revision && current.raw === expected.raw;
}

async function openCasDb(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB)
    throw Error("IndexedDB non disponibile: salvataggio CAS non eseguito.");
  return await new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); }
    catch { reject(Error("Impossibile aprire IndexedDB CAS.")); return; }
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE);
    };
    request.onerror = () => reject(Error("Impossibile aprire IndexedDB CAS."));
    request.onblocked = () => {
      blocked = true;
      reject(Error("Archivio CAS bloccato da un'altra scheda."));
    };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

export async function readCasProject(id: string): Promise<CasProjectSnapshot | null> {
  checkId(id);
  const db = await openCasDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      let result: CasProjectSnapshot | null = null;
      let failure = "Lettura IndexedDB CAS interrotta.";
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(Error(failure));
      tx.onerror = () => reject(Error("Lettura IndexedDB CAS non riuscita."));
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => {
        try {
          const row = readRow(req.result as unknown, id);
          if (row?.raw !== null && row?.raw !== undefined)
            result = {id, revision: row.revision, raw: row.raw};
        } catch {
          failure = "Archivio IndexedDB locale corrotto.";
          tx.abort();
        }
      };
    });
  } finally { db.close(); }
}

export async function compareAndSwapCasProject(
  project: FactoryProject, expected: CasProjectSnapshot | null,
): Promise<CasProjectSnapshot> {
  // Validation is entirely before opening a readwrite transaction.
  const raw = serializeCasProject(project);
  checkExpected(project.id, expected);
  const db = await openCasDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      let failure = "Scrittura CAS IndexedDB interrotta.";
      let next: CasProjectSnapshot | null = null;
      tx.oncomplete = () => {
        if (next) resolve(next);
        else reject(Error("Scrittura CAS IndexedDB non confermata."));
      };
      tx.onabort = () => reject(Error(failure));
      tx.onerror = () => reject(Error("Scrittura CAS IndexedDB non riuscita."));
      const store = tx.objectStore(STORE);
      const req = store.get(project.id);
      req.onsuccess = () => {
        let current: Row | null;
        try { current = readRow(req.result as unknown, project.id); }
        catch {
          failure = "Archivio IndexedDB locale corrotto.";
          tx.abort(); return;
        }
        if (!matchesExpected(current, expected)) {
          failure = "Conflitto CAS IndexedDB: versione del progetto cambiata.";
          tx.abort(); return;
        }
        const revision = (current?.revision ?? 0) + 1;
        if (revision > MAX_REVISION) {
          failure = "Limite revisioni IndexedDB raggiunto.";
          tx.abort(); return;
        }
        next = { id: project.id, revision, raw };
        // No Promise/await between get and put. The single readwrite
        // transaction serializes even two tabs that ignore Web Locks.
        store.put({id: project.id, revision, raw} satisfies Row, project.id);
      };
    });
  } finally { db.close(); }
}

export async function deleteCasProject(
  id: string, expected: CasProjectSnapshot,
): Promise<CasProjectTombstone> {
  checkId(id);
  checkExpected(id, expected);
  if (!expected) throw Error("Per eliminare un progetto serve una versione CAS.");
  const db = await openCasDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      let failure = "Eliminazione CAS IndexedDB interrotta.";
      let deleted: CasProjectTombstone | null = null;
      tx.oncomplete = () => {
        if (deleted) resolve(deleted);
        else reject(Error("Eliminazione CAS IndexedDB non confermata."));
      };
      tx.onabort = () => reject(Error(failure));
      tx.onerror = () => reject(Error("Eliminazione CAS IndexedDB non riuscita."));
      const store = tx.objectStore(STORE);
      const req = store.get(id);
      req.onsuccess = () => {
        let current: Row | null;
        try { current = readRow(req.result as unknown, id); }
        catch {
          failure = "Archivio IndexedDB locale corrotto.";
          tx.abort(); return;
        }
        if (!matchesExpected(current, expected)) {
          failure = "Conflitto CAS IndexedDB: versione del progetto cambiata.";
          tx.abort(); return;
        }
        const revision = current!.revision + 1;
        if (revision > MAX_REVISION) {
          failure = "Limite revisioni IndexedDB raggiunto.";
          tx.abort(); return;
        }
        // Keep a tombstone to avoid reset-to-revision-1 ABA on re-create.
        deleted = {id, revision};
        store.put({id, revision, raw: null} satisfies Row, id);
      };
    });
  } finally { db.close(); }
}
