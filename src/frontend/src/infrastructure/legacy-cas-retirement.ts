/** #173: cooperative write fence for a project intentionally handed to IDB.
 * The marker is armed BEFORE the native CAS insert. localStorage and IDB are
 * not an atomic pair; ambiguous inserts leave a durable, fail-closed marker.
 * Old clients and direct Storage writes are NOT fenced by this mechanism.
 */
export const LEGACY_CAS_RETIREMENT_PREFIX="softwarefactory.cas.retired.v1.";
const SLOT="softwarefactory.project.library.v1.";
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST=/^[0-9a-f]{64}$/;
type Retirement=Readonly<{schema:1;id:string;digest:string}>;

function key(id:string):string {
  if(typeof id!=="string" || !ID.test(id))
    throw Error("ID progetto legacy non valido: scrittura bloccata.");
  return LEGACY_CAS_RETIREMENT_PREFIX+id;
}

export function readLegacyCasRetirement(id:string):Retirement|null {
  const raw=localStorage.getItem(key(id));
  if(raw===null)return null;
  try {
    if(!raw || raw.length>256)throw Error("Invalid size");
    const parsed=JSON.parse(raw) as Record<string,unknown>;
    if(!parsed || Array.isArray(parsed) ||
       Object.keys(parsed).sort().join(",")!=="digest,id,schema" ||
       parsed.schema!==1 || parsed.id!==id ||
       typeof parsed.digest!=="string" || !DIGEST.test(parsed.digest))
      throw Error("Invalid marker");
    return Object.freeze({schema:1,id,digest:parsed.digest});
  }catch{throw Error("Barriera CAS legacy non valida: nessuna scrittura consentita.");}
}

/** Read-only UI status; malformed or inaccessible markers fail closed. */
export function legacyCasRetirementBlocked(id:string):boolean {
  try{return readLegacyCasRetirement(id)!==null;}
  catch{return true;}
}

export function assertLegacyProjectWritable(id:string):void {
  if(readLegacyCasRetirement(id))
    throw Error("Progetto legacy trasferito a IndexedDB: scritture bloccate. Apri il workspace CAS e conserva il backup originale.");
}

/** Must run only after an exact backup and explicit final consent, and BEFORE
 * calling any native IDB insert. Never auto-remove on failed/unknown ACK.
 */
export function armLegacyCasRetirement(
  ticket:Readonly<{id:string;raw:string}>,digest:string,
):void {
  if(!ticket || typeof ticket.raw!=="string" || !ticket.raw ||
     ticket.raw.length>1_000_000 || !DIGEST.test(digest))
    throw Error("Barriera CAS legacy: ticket non valido.");
  const storageKey=key(ticket.id);
  if(readLegacyCasRetirement(ticket.id)!==null)
    throw Error("Barriera CAS legacy già presente: non ripetere il trasferimento.");
  if(localStorage.getItem(SLOT+ticket.id)!==ticket.raw)
    throw Error("Sorgente legacy cambiata: trasferimento annullato.");
  const marker=JSON.stringify({schema:1,id:ticket.id,digest});
  try {localStorage.setItem(storageKey,marker);}
  catch {throw Error("Barriera CAS legacy non salvata: trasferimento annullato.");}
  if(localStorage.getItem(storageKey)!==marker)
    throw Error("Barriera CAS legacy non confermata: trasferimento annullato.");
  // An asynchronous rival could have changed the source before this sync
  // operation. Leave the marker armed and abort rather than infer success.
  if(localStorage.getItem(SLOT+ticket.id)!==ticket.raw)
    throw Error("Sorgente legacy cambiata dopo barriera: nessuna copia autorizzata.");
}
