/**
 * #189/#139: deliberate offline ZIP v1 -> all-or-nothing IndexedDB CAS import.
 * STRICT: only the #183 backup format, only 1–40 active projects, only a
 * truly empty destination (including no tombstones). Existing IDs are NEVER
 * merged/overwritten/revived. Imported native revisions restart at 1 while
 * source generations stay in the offline manifest, not in new CAS slots.
 *
 * Historical project raw may contain secrets or stale AI/GitHub/runner data.
 * A matching SHA-256 is integrity-only; it is NOT verification, approval,
 * signed provenance or consent to synchronize to GitHub/cloud.
 */
import {unzipSync} from "fflate";
import type {FactoryProject} from "../domain/types";
import {
  importCasEmptyLibraryAtomic,inspectCasLibraryTrulyEmpty,
  serializeCasProject,MAX_CAS_LIBRARY_BACKUP_CHARS,
  MAX_CAS_TOMBSTONE_INVENTORY,
} from "../infrastructure/project-cas";
import type {CasProjectSnapshot,CasEmptyLibraryImport,
  CasProjectTombstone} from "../infrastructure/project-cas";
import {casHandoffRawDigest} from "./cas-root-workspace";

export const MAX_CAS_LIBRARY_ZIP_BYTES=20_000_000;
const MAX_MANIFEST_BYTES=128_000;
const MAX_PROJECT_UTF8_BYTES=4_000_000;
const MAX_DECOMPRESSED_BYTES=64_128_000;
const ID=/^[0-9a-f-]{36}$/i;
const SHA=/^[a-f0-9]{64}$/;
const PROJECT_PATH=/^projects\/([0-9a-f-]{36})-r([1-9][0-9]*)\.json$/i;
const MAX_REVISION=Number.MAX_SAFE_INTEGER-1;
const FORMAT="softwarefactory-cas-library-recovery";

export type CasEmptyLibraryZipTicket=Readonly<{
  format:"softwarefactory-cas-library-recovery";
  projects:ReadonlyArray<Readonly<{
    id:string;revision:number;raw:string;sha256:string;
  }>>;
  tombstones:ReadonlyArray<CasProjectTombstone>;
}>;

type ZipEntry=Readonly<{id:string;revision:number;file:string;sha256:string}>;
export type CasZipDigest=(raw:string)=>Promise<string>;
export type CasZipImportWriter=(entries:ReadonlyArray<CasEmptyLibraryImport>)=>
  Promise<ReadonlyArray<CasProjectSnapshot>>;

function keys(value:unknown,expected:string[]):boolean {
  return Boolean(value && typeof value==="object" && !Array.isArray(value)) &&
    Object.keys(value as object).sort().join(",")===expected.slice().sort().join(",");
}
function failed():never {
  // NEVER interpolate untrusted file contents/paths/secrets in UI errors.
  throw Error("ZIP libreria CAS non valido, corrotto o oltre i limiti; nessun import.");
}
function decode(bytes:Uint8Array):string {
  try{return new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
  catch{return failed();}
}
function validateProject(entry:ZipEntry,raw:string):void {
  if(!ID.test(entry.id) || !Number.isSafeInteger(entry.revision) ||
     entry.revision<1 || entry.revision>MAX_REVISION ||
     entry.file!=="projects/"+entry.id+"-r"+entry.revision+".json" ||
     !SHA.test(entry.sha256) ||
     typeof raw!=="string" || !raw || raw.length>1_000_000)return failed();
  try{
    const project=JSON.parse(raw) as FactoryProject;
    if(!project || project.id!==entry.id ||
       serializeCasProject(project)!==raw)return failed();
  }catch{return failed();}
}

/** No IndexedDB or network read: parse the exact #183 ZIP locally.
 * Filter header metadata BEFORE unzipSync allocates output (including a
 * ZIP64 sentinel, which must NOT cause a multi-GB allocation).
 * Sum bounds are UTF-8 bytes, not JS UTF-16 character count.
 */
export async function parseCasEmptyLibraryBackupZip(
  data:Uint8Array,
  digest:CasZipDigest=casHandoffRawDigest,
):Promise<CasEmptyLibraryZipTicket> {
  try{
    if(!(data instanceof Uint8Array) || data.byteLength<50 ||
       data.byteLength>MAX_CAS_LIBRARY_ZIP_BYTES)return failed();
    const names=new Set<string>();
    let cumulative=0;
    const files=unzipSync(data,{
      filter:entry=>{
        const manifest=entry.name==="manifest.json";
        const project=PROJECT_PATH.test(entry.name);
        if((!manifest && !project) || names.has(entry.name) ||
           !Number.isSafeInteger(entry.originalSize) ||
           !Number.isSafeInteger(entry.size) ||
           entry.originalSize<1 || entry.size<1 ||
           (entry.compression!==0 && entry.compression!==8) ||
           (manifest && entry.originalSize>MAX_MANIFEST_BYTES) ||
           (project && entry.originalSize>MAX_PROJECT_UTF8_BYTES) ||
           entry.size>MAX_CAS_LIBRARY_ZIP_BYTES)return failed();
        cumulative+=entry.originalSize;
        if(cumulative>MAX_DECOMPRESSED_BYTES || names.size>=41)
          return failed();
        names.add(entry.name);
        return true;
      },
    });
    if(!names.has("manifest.json") || names.size!==Object.keys(files).length ||
       files["manifest.json"].byteLength>MAX_MANIFEST_BYTES)return failed();
    const manifest=JSON.parse(decode(files["manifest.json"])) as Record<string,unknown>;
    if(!keys(manifest,["format","schemaVersion","storage","warning",
      "automaticRestore","projects","tombstones"]) ||
       manifest.format!==FORMAT || manifest.schemaVersion!==1 ||
       manifest.storage!=="indexeddb-same-origin-profile" ||
       manifest.automaticRestore!==false ||
       typeof manifest.warning!=="string" ||
       manifest.warning.length<10 || manifest.warning.length>1024 ||
       !Array.isArray(manifest.projects) ||
       manifest.projects.length<1 || manifest.projects.length>40 ||
       !Array.isArray(manifest.tombstones) ||
       manifest.tombstones.length>MAX_CAS_TOMBSTONE_INVENTORY ||
       names.size!==manifest.projects.length+1)
      return failed();
    const ids=new Set<string>();
    let chars=0;
    const projects:CasEmptyLibraryZipTicket["projects"][number][]=[];
    for(const value of manifest.projects){
      if(!keys(value,["id","revision","file","sha256"]))return failed();
      const entry=value as ZipEntry;
      if(typeof entry.id!=="string" || typeof entry.file!=="string" ||
         typeof entry.sha256!=="string" || ids.has(entry.id) ||
         !Object.prototype.hasOwnProperty.call(files,entry.file))
        return failed();
      ids.add(entry.id);
      const raw=decode(files[entry.file]);
      validateProject(entry,raw);
      chars+=raw.length;
      if(chars>MAX_CAS_LIBRARY_BACKUP_CHARS)return failed();
      const expected=await digest(raw);
      if(expected!==entry.sha256)return failed();
      projects.push(Object.freeze({
        id:entry.id,revision:entry.revision,raw,sha256:entry.sha256,
      }));
    }
    const tombstones:CasProjectTombstone[]=[];
    for(const t of manifest.tombstones){
      if(!keys(t,["id","revision"]))return failed();
      const row=t as CasProjectTombstone;
      if(typeof row.id!=="string" || !ID.test(row.id) ||
         !Number.isSafeInteger(row.revision) ||
         row.revision<1 || row.revision>MAX_REVISION ||
         ids.has(row.id))return failed();
      ids.add(row.id);
      tombstones.push(Object.freeze({id:row.id,revision:row.revision}));
    }
    return Object.freeze({
      format:FORMAT,
      projects:Object.freeze(projects.sort((a,b)=>a.id.localeCompare(b.id))),
      tombstones:Object.freeze(tombstones.sort((a,b)=>a.id.localeCompare(b.id))),
    });
  }catch{return failed();}
}

/** Called after the file was validated and the user was shown explicit
 * counts. No write if consent missing. The writer fences the destination
 * emptiness again INSIDE the same readwrite transaction as all inserts.
 */
export async function confirmCasEmptyLibraryBackupRestore(
  ticket:CasEmptyLibraryZipTicket,consent:boolean,
  write:CasZipImportWriter=importCasEmptyLibraryAtomic,
  digest:CasZipDigest=casHandoffRawDigest,
):Promise<ReadonlyArray<CasProjectSnapshot>> {
  if(consent!==true)
    throw Error("Consenso ZIP libreria CAS obbligatorio.");
  try{
    if(!ticket || ticket.format!==FORMAT ||
       !Array.isArray(ticket.projects) ||
       ticket.projects.length<1 || ticket.projects.length>40 ||
       !Array.isArray(ticket.tombstones) ||
       ticket.tombstones.length>MAX_CAS_TOMBSTONE_INVENTORY)
      return failed();
    // The caller's ticket may be mutable even though the official parser
    // returns frozen objects. Never validate an async digest over one RAW
    // and later re-read a different RAW to pass into the native writer (#191).
    const sourceProjects=ticket.projects;
    const sourceTombstones=ticket.tombstones;
    const seen=new Set<string>();
    let chars=0;
    const pinned=Object.freeze(sourceProjects.map(p=>{
      if(!p || typeof p.id!=="string" || seen.has(p.id))return failed();
      const copy=Object.freeze({
        id:p.id,revision:p.revision,raw:p.raw,sha256:p.sha256,
      });
      validateProject({
        id:copy.id,revision:copy.revision,
        file:"projects/"+copy.id+"-r"+copy.revision+".json",
        sha256:copy.sha256,
      },copy.raw);
      seen.add(copy.id);
      chars+=copy.raw.length;
      if(chars>MAX_CAS_LIBRARY_BACKUP_CHARS)return failed();
      return copy;
    }));
    // Tombstones are historical metadata, never restored, but cannot be
    // malformed or collide with active IDs at the consent boundary.
    const pinnedTombstones=Object.freeze(sourceTombstones.map(t=>{
      if(!t || typeof t.id!=="string" || !ID.test(t.id) ||
         !Number.isSafeInteger(t.revision) || t.revision<1 ||
         t.revision>MAX_REVISION || seen.has(t.id))return failed();
      seen.add(t.id);
      return Object.freeze({id:t.id,revision:t.revision});
    }));
    for(const p of pinned){
      if(await digest(p.raw)!==p.sha256)return failed();
    }
    // A suspended digest gives other browser tasks an opportunity to mutate
    // the caller object. Reject rather than silently adopting a new ticket.
    if(ticket.projects!==sourceProjects ||
       ticket.tombstones!==sourceTombstones ||
       sourceProjects.length!==pinned.length ||
       sourceTombstones.length!==pinnedTombstones.length ||
       !sourceProjects.every((p,i)=>p && p.id===pinned[i].id &&
         p.revision===pinned[i].revision && p.raw===pinned[i].raw &&
         p.sha256===pinned[i].sha256) ||
       !sourceTombstones.every((t,i)=>t &&
         t.id===pinnedTombstones[i].id &&
         t.revision===pinnedTombstones[i].revision))
      return failed();
    // The only data crossing the IDB write boundary is the verified pinned
    // snapshot, never the caller's mutable project array.
    const inputs=Object.freeze(pinned.map(p=>Object.freeze({id:p.id,raw:p.raw})));
    const outcome=await write(inputs);
    if(!Array.isArray(outcome) || outcome.length!==pinned.length)
      throw Error("Import CAS ACK incerto: verifica manualmente la libreria; NON riprovare.");
    const byId=new Map(outcome.map(o=>[o.id,o]));
    for(const p of pinned){
      const saved=byId.get(p.id);
      if(!saved || saved.revision!==1 || saved.raw!==p.raw)
        throw Error("Import CAS ACK incerto: verifica manualmente la libreria; NON riprovare.");
    }
    return outcome;
  }catch{
    // Storage faults may signal ACK ambiguity: never retry from UI.
    throw Error("Import CAS non confermato, conflitto o archivio non vuoto: verifica manualmente, NON riprovare automaticamente.");
  }
}

export async function prepareCasEmptyLibraryRestorePreview(
  data:Uint8Array,
  digest:CasZipDigest=casHandoffRawDigest,
  empty:()=>Promise<boolean>=inspectCasLibraryTrulyEmpty,
):Promise<CasEmptyLibraryZipTicket> {
  const ticket=await parseCasEmptyLibraryBackupZip(data,digest);
  if(!await empty())
    throw Error("Archivio IndexedDB non vuoto (anche tombstone): nessun import.");
  return ticket;
}
