/** #197: read-only post-failure CAS diagnosis. Matching bytes NEVER prove
 * that this tab wrote them or that tx.oncomplete was acknowledged. No retry.
 */
import type {FactoryProject} from "../domain/types";
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
