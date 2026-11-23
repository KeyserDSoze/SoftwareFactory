/**
 * #183/#139: all-active-project native CAS offline recovery archive.
 * NEVER a cloud sync, re-attestation of historical evidence, restore, or
 * authorization to write the legacy editor. Project raw JSON is PLAINTEXT
 * and may contain sensitive user-authored data: preserve it EXACTLY.
 */
import {strToU8,zipSync} from "fflate";
import {MAX_CAS_LIBRARY_ZIP_BYTES,parseCasEmptyLibraryBackupZip}
  from "./cas-empty-library-zip-restore";
import type {FactoryProject} from "../domain/types";
import {
  MAX_CAS_LIBRARY_BACKUP_CHARS,MAX_CAS_TOMBSTONE_INVENTORY,
  readCasLibraryBackupSnapshot,serializeCasProject,
} from "../infrastructure/project-cas";
import type {
  CasLibraryBackupSnapshot,CasProjectSnapshot,CasProjectTombstone,
} from "../infrastructure/project-cas";
import {casHandoffRawDigest} from "./cas-root-workspace";

export const CAS_LIBRARY_RECOVERY_FILE="softwarefactory-cas-library-recovery-v1.zip";
const ID=/^[0-9a-f-]{36}$/i;
const MAX_REVISION=Number.MAX_SAFE_INTEGER-1;

export type CasLibraryRecoveryTicket=Readonly<{
  fileName:string;snapshot:CasLibraryBackupSnapshot;
}>;
export type CasLibraryRecoveryArchive=Readonly<{
  fileName:string;projectCount:number;files:Readonly<Record<string,string>>;
}>;
export type CasLibraryRecoveryRead=()=>Promise<CasLibraryBackupSnapshot>;
export type CasLibraryRecoveryDigest=(raw:string)=>Promise<string>;

function canonical(source:CasLibraryBackupSnapshot):CasLibraryBackupSnapshot {
  try{
    if(!source || !Array.isArray(source.projects) ||
       !Array.isArray(source.tombstones) ||
       !source.projects.length || source.projects.length>40 ||
       source.tombstones.length>MAX_CAS_TOMBSTONE_INVENTORY)
      throw Error("Bad size");
    let total=0;
    const ids=new Set<string>();
    const projects:CasProjectSnapshot[]=source.projects.map(p=>{
      if(!p || typeof p.id!=="string" || !ID.test(p.id) ||
         !Number.isSafeInteger(p.revision) || p.revision<1 ||
         p.revision>MAX_REVISION ||
         typeof p.raw!=="string" || !p.raw || p.raw.length>1_000_000 ||
         ids.has(p.id))throw Error("Bad snapshot");
      const project=JSON.parse(p.raw) as FactoryProject;
      if(!project || project.id!==p.id ||
         serializeCasProject(project)!==p.raw)
        throw Error("Invalid canonical project");
      ids.add(p.id);
      total+=p.raw.length;
      if(total>MAX_CAS_LIBRARY_BACKUP_CHARS)throw Error("Exceeded budget");
      return Object.freeze({id:p.id,revision:p.revision,raw:p.raw});
    }).sort((a,b)=>a.id.localeCompare(b.id));
    const tombstones:CasProjectTombstone[]=source.tombstones.map(t=>{
      if(!t || typeof t.id!=="string" || !ID.test(t.id) ||
         !Number.isSafeInteger(t.revision) || t.revision<1 ||
         t.revision>MAX_REVISION || ids.has(t.id))
        throw Error("Bad tombstone");
      ids.add(t.id);
      return Object.freeze({id:t.id,revision:t.revision});
    }).sort((a,b)=>a.id.localeCompare(b.id));
    return Object.freeze({
      projects:Object.freeze(projects),tombstones:Object.freeze(tombstones),
    });
  }catch{
    // Never echo malformed project data or incidental secrets in UI errors.
    throw Error("Backup libreria CAS non canonico o troppo grande.");
  }
}

function equal(a:CasLibraryBackupSnapshot,b:CasLibraryBackupSnapshot):boolean {
  return a.projects.length===b.projects.length &&
    a.tombstones.length===b.tombstones.length &&
    a.projects.every((p,i)=>p.id===b.projects[i].id &&
      p.revision===b.projects[i].revision && p.raw===b.projects[i].raw) &&
    a.tombstones.every((t,i)=>t.id===b.tombstones[i].id &&
      t.revision===b.tombstones[i].revision);
}

/** Read-only native snapshot. No download, consent or output yet. */
export async function prepareCasLibraryRecoveryBundle(
  read:CasLibraryRecoveryRead=readCasLibraryBackupSnapshot,
):Promise<CasLibraryRecoveryTicket> {
  const snapshot=canonical(await read());
  return Object.freeze({fileName:CAS_LIBRARY_RECOVERY_FILE,snapshot});
}

/** Require separate human consent and exact full-library readback across
 * SHA-256 generation. A concurrent new ID, new revision/raw, delete, restore
 * or tombstone change blocks the entire archive (no subset, merge or retry).
 * SHA-256 is integrity metadata, NOT a signature or proof of running tests.
 */
export async function confirmCasLibraryRecoveryBundle(
  ticket:CasLibraryRecoveryTicket,
  consent:boolean,
  read:CasLibraryRecoveryRead=readCasLibraryBackupSnapshot,
  digest:CasLibraryRecoveryDigest=casHandoffRawDigest,
):Promise<CasLibraryRecoveryArchive> {
  if(consent!==true)throw Error("Consenso per backup completo CAS obbligatorio.");
  if(!ticket || ticket.fileName!==CAS_LIBRARY_RECOVERY_FILE)
    throw Error("Ticket libreria CAS non valido.");
  const expected=canonical(ticket.snapshot);
  const before=canonical(await read());
  if(!equal(expected,before))
    throw Error("Libreria CAS cambiata durante la conferma: download bloccato.");
  const files:Record<string,string>=Object.create(null);
  const projectIndex:{id:string;revision:number;file:string;sha256:string}[]=[];
  for(const p of expected.projects){
    const file="projects/"+p.id+"-r"+p.revision+".json";
    const sha256=await digest(p.raw);
    if(!/^[0-9a-f]{64}$/.test(sha256))
      throw Error("Digest SHA-256 recupero CAS non valido.");
    files[file]=p.raw;
    projectIndex.push({id:p.id,revision:p.revision,file,sha256});
  }
  const after=canonical(await read());
  if(!equal(expected,after))
    throw Error("Libreria CAS modificata durante SHA-256: download bloccato.");
  files["manifest.json"]=JSON.stringify({
    format:"softwarefactory-cas-library-recovery",
    schemaVersion:1,
    storage:"indexeddb-same-origin-profile",
    warning:"PLAINTEXT historical JSON; may contain sensitive data. Store offline. SHA-256 is NOT a signature, code review, test, runner proof, GitHub approval or cloud sync.",
    automaticRestore:false,
    projects:projectIndex,
    tombstones:expected.tombstones.map(t=>({id:t.id,revision:t.revision})),
  },null,2);
  return Object.freeze({
    fileName:CAS_LIBRARY_RECOVERY_FILE,
    projectCount:expected.projects.length,
    files:Object.freeze(files),
  });
}

/**
 * #192: a successfully exported archive must be accepted by the very same
 * offline ZIP parser used by the empty-store restore (#189). The 16M JS
 * character limit does NOT bound compressed UTF-8 ZIP bytes to 20 MB.
 * Keep the payload and its historical evidence unchanged; reject before the
 * browser receives a downloadable file if round-trip is not possible.
 */
export class CasLibraryZipPortabilityError extends Error {
  constructor(){
    super("ZIP backup CAS non ripristinabile con il parser corrente: download bloccato.");
    this.name="CasLibraryZipPortabilityError";
  }
}

export type CasLibraryZipCompressor=(entries:Record<string,Uint8Array>)=>Uint8Array;

/** Caller-visible boundary shared with the #189 restore file size cap. */
export function assertCasLibraryZipPortableSize(bytes:number):void {
  if(!Number.isSafeInteger(bytes) || bytes<50 ||
     bytes>MAX_CAS_LIBRARY_ZIP_BYTES)
    throw new CasLibraryZipPortabilityError();
}

/** Pure offline packaging, after both backup consents and native readbacks.
 * The ZIP itself (not only the precompression manifest) is parsed again
 * before offering a download. This is NOT proof it was saved to disk.
 */
export async function encodeCasLibraryRecoveryZip(
  archive:CasLibraryRecoveryArchive,
  digest:CasLibraryRecoveryDigest=casHandoffRawDigest,
  compress:CasLibraryZipCompressor=entries=>zipSync(entries,{level:6}),
):Promise<Uint8Array> {
  try{
    if(!archive || archive.fileName!==CAS_LIBRARY_RECOVERY_FILE ||
       !Number.isInteger(archive.projectCount) ||
       archive.projectCount<1 || archive.projectCount>40 ||
       !archive.files || typeof archive.files!=="object" ||
       Array.isArray(archive.files))
      throw new CasLibraryZipPortabilityError();
    const entries:Record<string,Uint8Array>=Object.create(null);
    for(const [path,raw] of Object.entries(archive.files)){
      if(typeof raw!=="string" || !raw)
        throw new CasLibraryZipPortabilityError();
      entries[path]=strToU8(raw);
    }
    const zipped=compress(entries);
    if(!(zipped instanceof Uint8Array))
      throw new CasLibraryZipPortabilityError();
    assertCasLibraryZipPortableSize(zipped.byteLength);
    // No IDB, localStorage, cloud, network, or user action is invoked here.
    const checked=await parseCasEmptyLibraryBackupZip(zipped,digest);
    if(checked.projects.length!==archive.projectCount ||
       checked.projects.some(p=>
         archive.files["projects/"+p.id+"-r"+p.revision+".json"]!==p.raw))
      throw new CasLibraryZipPortabilityError();
    // Manifest/tombstones, unique paths and all SHA hashes are checked
    // strictly by the restore parser against the compressed bytes.
    return Uint8Array.from(zipped);
  }catch{
    // Never interpolate project RAW, filenames or provider errors in UI.
    throw new CasLibraryZipPortabilityError();
  }
}
