/** Stable, non-sensitive IndexedDB operational faults (#160).
 * Decode only browser-native failure NAMES, never message, SQL/JSON, URLs,
 * provider error objects or browser exception stacks. This is same-origin
 * storage diagnostic only; never an optimistic commit acknowledgement.
 */
export type CasStorageFaultCode="unsupported"|"upgrade"|"quota"|"blocked";
const MESSAGES:Readonly<Record<CasStorageFaultCode,string>>=Object.freeze({
  unsupported:"IndexedDB non disponibile: nessun salvataggio locale eseguito.",
  upgrade:"Versione IndexedDB incompatibile: archivio non modificato. Non cancellare o ripristinare automaticamente.",
  quota:"Quota IndexedDB esaurita: transazione non confermata, verifica spazio e backup.",
  blocked:"Archivio IndexedDB bloccato da un'altra scheda: nessun salvataggio confermato.",
});
export class CasStorageFault extends Error {
  readonly code:CasStorageFaultCode;
  constructor(code:CasStorageFaultCode){
    super(MESSAGES[code]);
    this.name="CasStorageFault";
    this.code=code;
  }
}
export function nativeCasStorageFault(error:unknown):CasStorageFault|null {
  // Caller must supply an exception from an IndexedDB API, never untrusted
  // provider output. No raw native message is exposed in the user interface.
  if(!error || typeof error!=="object")return null;
  const name=(error as {name?:unknown}).name;
  return name==="VersionError"?
    new CasStorageFault("upgrade"):name==="QuotaExceededError"?
    new CasStorageFault("quota"):null;
}
export function casStorageFaultCode(error:unknown):CasStorageFaultCode|null {
  return error instanceof CasStorageFault ? error.code : null;
}
