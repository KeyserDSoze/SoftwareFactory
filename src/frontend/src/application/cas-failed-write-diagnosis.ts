/** #197: read-only post-failure CAS diagnosis. Matching bytes NEVER prove
 * that this tab wrote them or that tx.oncomplete was acknowledged. No retry.
 */
import {STAGES} from "../domain/defaults";
import type {FactoryProject,StageId} from "../domain/types";
import {readCasProjectSlot,serializeCasProject}
  from "../infrastructure/project-cas";
import type {CasProjectSnapshot,CasProjectSlot}
  from "../infrastructure/project-cas";

export type CasFailedWriteTicket=Readonly<{
  old:CasProjectSnapshot;proposed:CasProjectSnapshot;
}>;
export type CasFailedWriteObservation=Readonly<{
  state:"unchanged"|"candidate_present"|"diverged"|"tombstone"|"missing";
  observedRevision:number|null;
}>;
export type CasFailedWriteReader=(id:string)=>Promise<CasProjectSlot>;
const MAX_REVISION=Number.MAX_SAFE_INTEGER-1;
function invalid():never{
  throw Error("Ticket o revisione CAS non canonici: diagnosi bloccata.");
}
function canonical(s:CasProjectSnapshot):CasProjectSnapshot{
  try{
    if(!s || typeof s.id!=="string" || typeof s.raw!=="string" ||
      !s.raw || s.raw.length>1_000_000 ||
      !Number.isSafeInteger(s.revision) ||
      s.revision<1 || s.revision>MAX_REVISION)invalid();
    const p=JSON.parse(s.raw) as FactoryProject;
    if(!p || p.id!==s.id || serializeCasProject(p)!==s.raw)invalid();
    return Object.freeze({id:s.id,revision:s.revision,raw:s.raw});
  }catch{return invalid();}
}
function exact(a:CasProjectSnapshot,b:CasProjectSnapshot):boolean{
  return a.id===b.id && a.revision===b.revision && a.raw===b.raw;
}
function verify(t:CasFailedWriteTicket):CasFailedWriteTicket{
  try{
    if(!t)invalid();
    const old=canonical(t.old),proposed=canonical(t.proposed);
    if(old.id!==proposed.id || proposed.revision!==old.revision+1 ||
      old.raw===proposed.raw)invalid();
    return Object.freeze({old,proposed});
  }catch{return invalid();}
}
/** Construct BEFORE commit, keep ONLY when actual native session is blocked. */
export function prepareCasFailedWriteTicket(
  expected:CasProjectSnapshot,proposed:FactoryProject,
):CasFailedWriteTicket{
  try{
    const old=canonical(expected);
    if(old.revision>=MAX_REVISION || !proposed ||
       proposed.id!==old.id)invalid();
    return verify({old,proposed:{
      id:old.id,revision:old.revision+1,
      raw:serializeCasProject(proposed),
    }});
  }catch{return invalid();}
}
/** No writes, rebase, provenance claims, storage fallback or automatic ACK. */
export async function inspectCasFailedWrite(
  ticket:CasFailedWriteTicket,
  read:CasFailedWriteReader=readCasProjectSlot,
):Promise<CasFailedWriteObservation>{
  const checked=verify(ticket);
  const current=await read(checked.old.id);
  if(!current || typeof current!=="object")invalid();
  if(current.state==="missing")
    return Object.freeze({state:"missing",observedRevision:null});
  if(current.state==="tombstone"){
    if(!Number.isSafeInteger(current.revision) ||
       current.revision<=checked.old.revision ||
       current.revision>MAX_REVISION)invalid();
    return Object.freeze({
      state:"tombstone",observedRevision:current.revision,
    });
  }
  if(current.state!=="present")invalid();
  const now=canonical(current.snapshot);
  if(now.id!==checked.old.id ||
    now.revision<checked.old.revision ||
    (now.revision===checked.old.revision && !exact(now,checked.old)))
    invalid();
  if(exact(now,checked.old))
    return Object.freeze({
      state:"unchanged",observedRevision:now.revision,
    });
  if(exact(now,checked.proposed))
    return Object.freeze({
      state:"candidate_present",observedRevision:now.revision,
    });
  return Object.freeze({
    state:"diverged",observedRevision:now.revision,
  });
}


/** #199: explicit LOCAL plaintext copy of an uncertain native CAS write.
 * An exported candidate is not an IndexedDB acknowledgement, storage backup,
 * provider result attestation, or automatic restore/import authority.
 */
export const MAX_CAS_FAILED_WRITE_BACKUP_BYTES=6_000_000;
export const CAS_FAILED_WRITE_BACKUP_FORMAT="softwarefactory-cas-failed-write";
export type CasFailedWriteBackupContext=Readonly<{
  operation:"editor"|"begin"|"complete"|"abort"|"fail";
  stage:StageId|null;
}>;
export type CasFailedWriteBackup=Readonly<{fileName:string;raw:string}>;

/** Pure: no IndexedDB/storage/network/DOM operations. Call only after a
 * genuinely blocked write and a pinned, operator-visible diagnostic ticket.
 * The UI must obtain explicit export consent before offering the bytes.
 */
export function prepareCasFailedWriteBackup(
  ticket:CasFailedWriteTicket,context:CasFailedWriteBackupContext,
):CasFailedWriteBackup {
  try {
    const checked=verify(ticket);
    if(!context || !["editor","begin","complete","abort","fail"]
      .includes(context.operation) ||
      (context.operation==="editor"
        ?context.stage!==null
        :!STAGES.some(stage=>stage.id===context.stage)) ||
      !/^[a-f0-9-]{36}$/i.test(checked.old.id))invalid();
    const raw=JSON.stringify({
      format:CAS_FAILED_WRITE_BACKUP_FORMAT,
      schemaVersion:1,authoritative:false,
      automaticRestore:false,unconfirmed:true,
      warning:"PLAINTEXT diagnostic candidate: the write was NOT confirmed. May contain sensitive project, AI and historical data. Manual offline inspection only; NEVER import/restore automatically, never treat as a successful CAS commit, test, review or provider attestation.",
      operation:context.operation,stage:context.stage,
      old:checked.old,proposed:checked.proposed,
    },null,2);
    if(new TextEncoder().encode(raw).byteLength>
      MAX_CAS_FAILED_WRITE_BACKUP_BYTES)invalid();
    return Object.freeze({
      fileName:"softwarefactory-cas-unconfirmed-"+
        checked.old.id+"-r"+checked.old.revision+
        "-to-r"+checked.proposed.revision+".json",
      raw,
    });
  }catch{return invalid();}
}
