/**
 * IndexedDB compare-and-swap foundation for a FUTURE opt-in local project
 * cutover (#138). The live Factory editor still uses localStorage. This is a
 * real atomic IDB transaction for callers of this module, not a claim that
 * legacy localStorage writers are fenced.
 *
 * Never await a promise inside a readwrite transaction: IDB will deactivate
 * it between event-loop tasks. The get/compare/scan/put/delete run entirely in
 * request callbacks in ONE transaction; acknowledgement is tx.oncomplete.
 */
import type { FactoryProject } from "../domain/types";
import {CasStorageFault,nativeCasStorageFault} from "./project-cas-storage-fault";

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
  // A tombstone is NOT a missing row. Only an explicit restore with the
  // exact tombstone generation, backup and consent may resurrect it (#147).
  if (expected === null) return current === null;
  return current !== null && current.raw !== null &&
    current.revision === expected.revision && current.raw === expected.raw;
}

async function openCasDb(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB)
    throw new CasStorageFault("unsupported");
  return await new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); }
    catch(error) {
      reject(nativeCasStorageFault(error) ??
        Error("Impossibile aprire IndexedDB CAS."));
      return;
    }
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE);
    };
    request.onerror = () => reject(
      nativeCasStorageFault(request.error) ??
        Error("Impossibile aprire IndexedDB CAS."));
    request.onblocked = () => {
      blocked = true;
      reject(new CasStorageFault("blocked"));
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


/** Read-only CAS slot inspection (#142). Do NOT merge absent with a
 * tombstone: an old legacy snapshot must never mask a deliberate deletion.
 */
export type CasProjectSlot =
  | Readonly<{state: "missing"}>
  | Readonly<{state: "tombstone"; revision: number}>
  | Readonly<{state: "present"; snapshot: CasProjectSnapshot}>;

export async function readCasProjectSlot(id: string): Promise<CasProjectSlot> {
  checkId(id);
  const db = await openCasDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      let result: CasProjectSlot = {state: "missing"};
      let failure = "Ricognizione IndexedDB interrotta.";
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(Error(failure));
      tx.onerror = () => reject(Error("Ricognizione IndexedDB non riuscita."));
      const request = tx.objectStore(STORE).get(id);
      request.onsuccess = () => {
        try {
          const row = readRow(request.result as unknown, id);
          if (row) {
            result = row.raw === null ?
              {state: "tombstone", revision: row.revision} :
              {state: "present", snapshot: {id, revision: row.revision, raw: row.raw}};
          }
        } catch {
          failure = "Archivio IndexedDB locale corrotto.";
          tx.abort();
        }
      };
    });
  } finally { db.close(); }
}

/** Read-only IndexedDB library discovery for future opt-in migration (#139/#140).
 * Never use a localStorage index or hide corrupt/overfull IndexedDB data.
 */
export type CasProjectChoice = Readonly<{
  id: string; name: string; updatedAt: string; repository: string; revision: number;
}>;

export async function listCasProjects(): Promise<CasProjectChoice[]> {
  const db = await openCasDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const projects: CasProjectChoice[] = [];
      let failure = "Elenco progetti IndexedDB interrotto.";
      tx.oncomplete = () => resolve(projects.sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
      tx.onabort = () => reject(Error(failure));
      tx.onerror = () => reject(Error("Elenco progetti IndexedDB non riuscito."));
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        try {
          if (typeof cursor.key !== "string") throw Error("Invalid key");
          checkId(cursor.key);
          const row = readRow(cursor.value as unknown, cursor.key);
          if (!row) throw Error("Missing row");
          if (row.raw !== null) {
            // readRow already checked project identity, schema and size.
            const project = JSON.parse(row.raw) as FactoryProject;
            projects.push({
              id: row.id, revision: row.revision,
              name: project.config.name, updatedAt: project.updatedAt,
              repository: project.githubDestination?.owner && project.githubDestination?.repo
                ? project.githubDestination.owner + "/" + project.githubDestination.repo : "",
            });
            if (projects.length > 40) {
              failure = "Libreria IndexedDB oltre 40 progetti: recupero manuale richiesto.";
              tx.abort();
              return;
            }
          }
          cursor.continue();
        } catch {
          failure = "Archivio IndexedDB locale corrotto: elenco non disponibile.";
          tx.abort();
        }
      };
    });
  } finally { db.close(); }
}

export async function compareAndSwapCasProject(
  project: FactoryProject, expected: CasProjectSnapshot | null,
): Promise<CasProjectSnapshot> {
  // A null ticket is a never-seen insert, NOT permission to resurrect a
  // deleted/tombstoned record. Use restoreCasTombstoneProject for that.
  // Validation is entirely before opening a readwrite transaction.
  const raw = serializeCasProject(project);
  checkExpected(project.id, expected);
  const db = await openCasDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      let failure: string | CasStorageFault = "Scrittura CAS IndexedDB interrotta.";
      let next: CasProjectSnapshot | null = null;
      tx.oncomplete = () => {
        if (next) resolve(next);
        else reject(Error("Scrittura CAS IndexedDB non confermata."));
      };
      tx.onabort = () => reject(
        failure instanceof CasStorageFault ? failure :
          nativeCasStorageFault(tx.error) ?? Error(failure));
      // A request error is non-terminal until the transaction aborts.
      // Native quota is handled onabort, never as a successful save.
      tx.onerror = () => {
        const fault=nativeCasStorageFault(tx.error);
        if(fault)failure=fault;
      };
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
        if (expected === null) {
          // New-project capacity, existing row corruption and the insert
          // must be checked in this SAME readwrite transaction (#147).
          // Do not make a non-atomic preflight list/read in another tx.
          let active = 0;
          const scan = store.openCursor();
          scan.onsuccess = () => {
            try {
              const cursor = scan.result;
              if (!cursor) {
                next = {id:project.id,revision,raw};
                store.add({id:project.id,revision,raw} satisfies Row,project.id);
                return;
              }
              if (typeof cursor.key !== "string") throw Error("Invalid key");
              checkId(cursor.key);
              const row = readRow(cursor.value as unknown,cursor.key);
              if (!row) throw Error("Missing row");
              if (row.raw !== null) {
                active++;
                if (active >= 40) {
                  failure = "Libreria IndexedDB piena (40 progetti).";
                  tx.abort(); return;
                }
              }
              cursor.continue();
            } catch(error) {
              failure = nativeCasStorageFault(error) ??
                "Archivio IndexedDB corrotto: insert CAS bloccata.";
              tx.abort();
            }
          };
          return;
        }
        // Update of a previously-present project cannot increase the active
        // record count and requires the exact revision+raw CAS ticket.
        next = { id: project.id, revision, raw };
        try{
          store.put({id: project.id, revision, raw} satisfies Row, project.id);
        }catch(error){
          failure=nativeCasStorageFault(error) ??
            "Scrittura CAS IndexedDB non riuscita.";
          tx.abort();
        }
      };
    });
  } finally { db.close(); }
}


/** Strict, never-seen IDB insert for operator-approved legacy staging (#141).
 * A tombstone is an existing ID; all rows and the 40-active capacity are
 * checked inside the same transaction as the insert, not before it.
 */
export async function insertCasProjectNeverSeen(
  project: FactoryProject, exactRaw: string,
): Promise<CasProjectSnapshot> {
  const raw = serializeCasProject(project);
  if (raw !== exactRaw) throw Error("Snapshot legacy non identico: copia rifiutata.");
  const db = await openCasDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let failure: string | CasStorageFault = "Copia IndexedDB interrotta.";
      let written = false;
      tx.oncomplete = () => {
        if (written) resolve({id: project.id, revision: 1, raw});
        else reject(Error("Copia IndexedDB non confermata."));
      };
      tx.onabort = () => reject(
        failure instanceof CasStorageFault ? failure :
          nativeCasStorageFault(tx.error) ?? Error(failure));
      // A request error is non-terminal until the transaction aborts.
      // Native quota is handled onabort, never as a successful save.
      tx.onerror = () => {
        const fault=nativeCasStorageFault(tx.error);
        if(fault)failure=fault;
      };
      let active = 0;
      const req = store.openCursor();
      req.onsuccess = () => {
        try {
          const cursor = req.result;
          if (!cursor) {
            written = true;
            store.add({id: project.id, revision: 1, raw} satisfies Row, project.id);
            return;
          }
          if (typeof cursor.key !== "string") throw Error("Invalid key");
          checkId(cursor.key);
          const row = readRow(cursor.value as unknown, cursor.key);
          if (!row) throw Error("Missing row");
          if (row.id === project.id) {
            failure = "Progetto già presente in IndexedDB (anche come tombstone).";
            tx.abort(); return;
          }
          if (row.raw !== null) active++;
          if (active >= 40) {
            failure = "Libreria IndexedDB piena (40 progetti).";
            tx.abort(); return;
          }
          cursor.continue();
        } catch(error) {
          failure = nativeCasStorageFault(error) ??
            "Archivio IndexedDB corrotto: copia bloccata.";
          tx.abort();
        }
      };
    });
  } finally { db.close(); }
}

/**
 * #166: atomic source-fenced, never-seen configuration fork.
 * One readwrite tx checks source revision/raw, destination never-seen,
 * capacity and the insert. ACK is only tx.oncomplete.
 */
export async function forkCasProjectConfiguration(
  source:CasProjectSnapshot,project:FactoryProject,consent:boolean,
):Promise<CasProjectSnapshot> {
  if(consent!==true)throw Error("Duplicazione IndexedDB non autorizzata.");
  if(!source || !project || source.id===project.id)
    throw Error("Sorgente IndexedDB non valida.");
  checkId(source.id);
  checkExpected(source.id,source);
  checkId(project.id);
  const raw=serializeCasProject(project);
  const cleanStages=[
    ["features","Piano feature"],["competitors","Analisi competitor"],
    ["technical","Ricerca tecnica"],["architecture","Architettura"],
    ["adversarial","Adversarial review"],
    ["implementation","Piano implementativo"],
  ];
  const keys=Object.keys(project).sort().join(",");
  if(keys!=="config,createdAt,id,stages,updatedAt" ||
     project.createdAt!==project.updatedAt ||
     typeof project.config?.name!=="string" ||
     !project.config.name.trim() || project.config.name.length>120 ||
     !Array.isArray(project.stages) ||
     project.stages.length!==cleanStages.length ||
     project.stages.some((stage,i)=>!stage ||
       Object.keys(stage).sort().join(",")!=="id,label,output,sources,status" ||
       stage.id!==cleanStages[i][0] ||
       stage.label!==cleanStages[i][1] ||
       stage.status!=="pending" || stage.output!=="" ||
       !Array.isArray(stage.sources) || stage.sources.length!==0))
    throw Error("Destinazione duplicazione IndexedDB non pulita.");
  try{
    const decoded=JSON.parse(source.raw) as FactoryProject;
    if(decoded.id!==source.id ||
       serializeCasProject(decoded)!==source.raw)
      throw Error("Invalid source");
  }catch{
    throw Error("Snapshot sorgente IndexedDB non canonico.");
  }
  const db=await openCasDb();
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,"readwrite"),store=tx.objectStore(STORE);
      let failure:string|CasStorageFault="Duplicazione IndexedDB interrotta.";
      let committed:CasProjectSnapshot|null=null;
      tx.oncomplete=()=>{
        if(committed)resolve(committed);
        else reject(Error("Duplicazione IndexedDB non confermata."));
      };
      tx.onabort=()=>reject(failure instanceof CasStorageFault ? failure :
        nativeCasStorageFault(tx.error)??Error(failure));
      tx.onerror=()=>{
        const fault=nativeCasStorageFault(tx.error);
        if(fault)failure=fault;
      };
      const lookup=store.get(source.id);
      lookup.onsuccess=()=>{
        try{
          const current=readRow(lookup.result as unknown,source.id);
          if(!matchesExpected(current,source)) {
            failure="Sorgente IndexedDB cambiata: duplicazione annullata.";
            tx.abort();return;
          }
          const parsed=JSON.parse(current!.raw!) as FactoryProject;
          if(JSON.stringify({...parsed.config,name:project.config.name})!==
             JSON.stringify(project.config)){
            failure="Configurazione duplicata diversa dalla sorgente.";
            tx.abort();return;
          }
          let active=0;
          const scan=store.openCursor();
          scan.onsuccess=()=>{
            try{
              const cursor=scan.result;
              if(!cursor){
                committed={id:project.id,revision:1,raw};
                store.add({id:project.id,revision:1,raw} satisfies Row,project.id);
                return;
              }
              if(typeof cursor.key!=="string")throw Error("Invalid key");
              checkId(cursor.key);
              const row=readRow(cursor.value as unknown,cursor.key);
              if(!row)throw Error("Missing row");
              if(cursor.key===project.id){
                failure="Destinazione IndexedDB già vista, anche tombstone.";
                tx.abort();return;
              }
              if(row.raw!==null){
                active++;
                if(active>=40){
                  failure="Libreria IndexedDB piena (40 progetti).";
                  tx.abort();return;
                }
              }
              cursor.continue();
            }catch(error){
              failure=nativeCasStorageFault(error)??
                "Archivio IndexedDB corrotto: duplicazione bloccata.";
              tx.abort();
            }
          };
        }catch(error){
          failure=nativeCasStorageFault(error)??
            "Sorgente IndexedDB corrotta: duplicazione bloccata.";
          tx.abort();
        }
      };
    });
  }finally{db.close();}
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
      let failure: string | CasStorageFault = "Eliminazione CAS IndexedDB interrotta.";
      let deleted: CasProjectTombstone | null = null;
      tx.oncomplete = () => {
        if (deleted) resolve(deleted);
        else reject(Error("Eliminazione CAS IndexedDB non confermata."));
      };
      tx.onabort = () => reject(
        failure instanceof CasStorageFault ? failure :
          nativeCasStorageFault(tx.error) ?? Error(failure));
      // A request error is non-terminal until the transaction aborts.
      // Native quota is handled onabort, never as a successful save.
      tx.onerror = () => {
        const fault=nativeCasStorageFault(tx.error);
        if(fault)failure=fault;
      };
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
        try{
          store.put({id, revision, raw: null} satisfies Row, id);
        }catch(error){
          failure=nativeCasStorageFault(error) ??
            "Eliminazione CAS IndexedDB non riuscita.";
          tx.abort();
        }
      };
    });
  } finally { db.close(); }
}


/**
 * Explicit, user-approved resurrection from an EXISTING tombstone (#146).
 * This is the ONLY tombstone restore path: generic CAS with expected=null
 * now rejects all pre-existing IDs, including tombstones. It requires the exact
 * deletion generation, a byte-identical backup and an explicit positive
 * consent. The read, capacity scan and put use the SAME readwrite IDB
 * transaction. No localStorage fallback, automatic restore or retry.
 */
export async function restoreCasTombstoneProject(
  project: FactoryProject,
  expected: CasProjectTombstone,
  exactBackupRaw: string,
  consent: boolean,
): Promise<CasProjectSnapshot> {
  // All user-intent and data checks happen BEFORE touching IndexedDB.
  if (consent !== true)
    throw Error("Ripristino IndexedDB non autorizzato: consenso esplicito obbligatorio.");
  const raw = serializeCasProject(project);
  if (raw !== exactBackupRaw)
    throw Error("Backup IndexedDB non identico: ripristino rifiutato.");
  if (!expected || expected.id !== project.id ||
      !Number.isSafeInteger(expected.revision) || expected.revision < 1 ||
      expected.revision > MAX_REVISION)
    throw Error("Tombstone IndexedDB non valida per il ripristino.");

  const db = await openCasDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let failure: string | CasStorageFault = "Ripristino IndexedDB interrotto.";
      let confirmed: CasProjectSnapshot | null = null;
      tx.oncomplete = () => {
        if (confirmed) resolve(confirmed);
        else reject(Error("Ripristino IndexedDB non confermato."));
      };
      tx.onabort = () => reject(
        failure instanceof CasStorageFault ? failure :
          nativeCasStorageFault(tx.error) ?? Error(failure));
      // A request error is non-terminal until the transaction aborts.
      // Native quota is handled onabort, never as a successful save.
      tx.onerror = () => {
        const fault=nativeCasStorageFault(tx.error);
        if(fault)failure=fault;
      };
      const read = store.get(project.id);
      read.onsuccess = () => {
        let existing: Row | null;
        try { existing = readRow(read.result as unknown, project.id); }
        catch {
          failure = "Archivio IndexedDB locale corrotto.";
          tx.abort(); return;
        }
        if (!existing || existing.raw !== null ||
            existing.revision !== expected.revision) {
          failure = "Conflitto tombstone IndexedDB: revisione cambiata o progetto presente.";
          tx.abort(); return;
        }
        const revision = existing.revision + 1;
        if (revision > MAX_REVISION) {
          failure = "Limite revisioni IndexedDB raggiunto.";
          tx.abort(); return;
        }

        // Count every ACTIVE project, not just the tombstone being restored.
        // Capacity and tombstone generation are both checked in this one
        // transaction, including noncooperating writers in other tabs.
        let active = 0;
        const scan = store.openCursor();
        scan.onsuccess = () => {
          try {
            const cursor = scan.result;
            if (!cursor) {
              confirmed = {id:project.id,revision,raw};
              store.put({id:project.id,revision,raw} satisfies Row,project.id);
              return;
            }
            if (typeof cursor.key !== "string") throw Error("Invalid key");
            checkId(cursor.key);
            const row = readRow(cursor.value as unknown,cursor.key);
            if (!row) throw Error("Missing row");
            if (row.raw !== null) {
              active++;
              if (active >= 40) {
                failure = "Libreria IndexedDB piena (40 progetti).";
                tx.abort(); return;
              }
            }
            cursor.continue();
          } catch(error) {
            failure = nativeCasStorageFault(error) ??
              "Archivio IndexedDB corrotto: ripristino bloccato.";
            tx.abort();
          }
        };
      };
    });
  } finally { db.close(); }
}
