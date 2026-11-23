import {describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {zipSync} from "fflate";
import {MAX_CAS_LIBRARY_ZIP_BYTES,parseCasEmptyLibraryBackupZip}
  from "./cas-empty-library-zip-restore";
import {createProject} from "../domain/defaults";
import type {CasLibraryBackupSnapshot} from "../infrastructure/project-cas";
import {
  CAS_LIBRARY_RECOVERY_FILE,prepareCasLibraryRecoveryBundle,
  confirmCasLibraryRecoveryBundle,encodeCasLibraryRecoveryZip,
  assertCasLibraryZipPortableSize,CasLibraryZipPortabilityError,
} from "./cas-library-recovery-bundle";

function fixture():CasLibraryBackupSnapshot {
  const a=createProject(),b=createProject();
  a.config.name="Full copy with unverified old AI";
  a.stages[0].status="complete";
  a.stages[0].output="HISTORICAL_NOT_TESTED_183";
  b.config.name="Backup second";
  return {
    projects:[
      {id:b.id,revision:2,raw:JSON.stringify(b)},
      {id:a.id,revision:5,raw:JSON.stringify(a)},
    ],
    tombstones:[{id:"11111111-1111-4111-8111-111111111183",revision:4}],
  };
}
const mockDigest=vi.fn(async(_:string)=>"a".repeat(64));

describe("native CAS full library historical recovery bundle #183",()=>{
  it("pins and freezes canonical sorted active raw and tombstone metadata",async()=>{
    const input=fixture(),read=vi.fn(async()=>input);
    const ticket=await prepareCasLibraryRecoveryBundle(read);
    expect(ticket.fileName).toBe(CAS_LIBRARY_RECOVERY_FILE);
    expect(ticket.snapshot.projects.map(p=>p.id))
      .toEqual([...input.projects.map(p=>p.id)].sort());
    expect(ticket.snapshot.tombstones).toEqual(input.tombstones);
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(Object.isFrozen(ticket.snapshot.projects)).toBe(true);
    expect(Object.isFrozen(ticket.snapshot.projects[0])).toBe(true);
    expect(read).toHaveBeenCalledOnce();
  });
  it("requires consent before second IDB read, creates raw files and explicit non-attested manifest",async()=>{
    const input=fixture(),read=vi.fn(async()=>input);
    const ticket=await prepareCasLibraryRecoveryBundle(read);
    await expect(confirmCasLibraryRecoveryBundle(ticket,false,read,mockDigest))
      .rejects.toThrow(/Consenso/);
    expect(read).toHaveBeenCalledOnce();
    mockDigest.mockClear();
    const zip=await confirmCasLibraryRecoveryBundle(ticket,true,read,mockDigest);
    expect(read).toHaveBeenCalledTimes(3);
    expect(zip.fileName).toBe(CAS_LIBRARY_RECOVERY_FILE);
    expect(zip.projectCount).toBe(2);
    expect(Object.keys(zip.files)).toHaveLength(3);
    for(const p of ticket.snapshot.projects)
      expect(zip.files["projects/"+p.id+"-r"+p.revision+".json"]).toBe(p.raw);
    const manifest=JSON.parse(zip.files["manifest.json"]) as {
      projects:{id:string;revision:number;file:string;sha256:string}[];
      tombstones:{id:string;revision:number}[];
      warning:string;automaticRestore:boolean;schemaVersion:number;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.projects).toHaveLength(2);
    expect(manifest.projects.every(p=>p.sha256==="a".repeat(64))).toBe(true);
    expect(manifest.tombstones).toEqual(input.tombstones);
    expect(zip.files["manifest.json"]).not.toContain("HISTORICAL_NOT_TESTED_183");
    expect(manifest.warning).toContain("NOT a signature");
    expect(manifest.automaticRestore).toBe(false);
  });
  it("blocks full export after any new, changed or tombstoned native row",async()=>{
    const base=fixture();
    const variants:CasLibraryBackupSnapshot[]=[
      {projects:base.projects.slice(1),tombstones:base.tombstones},
      {projects:base.projects.map((p,i)=>i===0?{...p,revision:p.revision+1}:p),
        tombstones:base.tombstones},
      {projects:base.projects,tombstones:[{...base.tombstones[0],revision:6}]},
      {projects:base.projects,tombstones:[]},
      {projects:base.projects,tombstones:[
        ...base.tombstones,{id:"22222222-2222-4222-8222-222222222283",revision:2},
      ]},
    ];
    for(const changed of variants){
      const t=await prepareCasLibraryRecoveryBundle(async()=>base);
      const read=vi.fn(async()=>changed);
      await expect(confirmCasLibraryRecoveryBundle(t,true,read,mockDigest))
        .rejects.toThrow(/cambiata/);
      expect(read).toHaveBeenCalledOnce();
    }
  });
  it("rejects changes DURING async digest, even with stable initial re-read",async()=>{
    const input=fixture(),other={
      ...input,projects:input.projects.map((p,i)=>
        i===0?{...p,revision:p.revision+1}:p),
    };
    let n=0;
    const read=vi.fn(async()=>++n===1?input:other);
    const t=await prepareCasLibraryRecoveryBundle(async()=>input);
    await expect(confirmCasLibraryRecoveryBundle(t,true,read,mockDigest))
      .rejects.toThrow(/modificata/);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("fails closed on ticket forgery, corrupt raw, no active projects and totals",async()=>{
    const base=fixture();
    const ok=await prepareCasLibraryRecoveryBundle(async()=>base);
    await expect(confirmCasLibraryRecoveryBundle({...ok,fileName:"../foo.zip"},true))
      .rejects.toThrow(/Ticket/);
    for(const altered of [
      {...base,projects:[]},
      {...base,projects:base.projects.map((p,i)=>
        i===0?{...p,raw:p.raw+" "}:p)},
      {...base,projects:[base.projects[0],base.projects[0]]},
      {...base,tombstones:[...base.tombstones,{
        id:base.projects[0].id,revision:7,
      }]},
      {...base,projects:base.projects.map((p,i)=>
        i===0?{...p,id:"../../bad"}:p)},
    ])await expect(prepareCasLibraryRecoveryBundle(async()=>altered))
      .rejects.toThrow(/non canonico/);
    const hugeProject=createProject();
    hugeProject.config.requirements="x".repeat(950_000);
    const raw=JSON.stringify(hugeProject);
    const bigger=Array.from({length:17},(_,i)=>({
      id:"a"+String(i).padStart(7,"0")+"-1111-4111-8111-111111111183",
      revision:1,raw:JSON.stringify({...hugeProject,
        id:"a"+String(i).padStart(7,"0")+"-1111-4111-8111-111111111183"}),
    }));
    expect(raw.length).toBeLessThan(1_000_000);
    expect(bigger.every(p=>p.raw.length<1_000_000)).toBe(true);
    expect(bigger.reduce((total,p)=>total+p.raw.length,0))
      .toBeGreaterThan(16_000_000);
    await expect(prepareCasLibraryRecoveryBundle(async()=>({
      projects:bigger,tombstones:[],
    }))).rejects.toThrow(/troppo grande/);
  });
  it("round-trips the exact compressed backup through the native restore ZIP parser",async()=>{
    const source=fixture();
    const base:CasLibraryBackupSnapshot={
      projects:source.projects.map((p,i)=>i===0?{
        ...p,raw:p.raw.replace('"Backup second"','"Backup 日本語 🗂️ second"'),
      }:p),
      tombstones:source.tombstones,
    };
    const sha=async(raw:string)=>createHash("sha256").update(raw).digest("hex");
    const ticket=await prepareCasLibraryRecoveryBundle(async()=>base);
    const archive=await confirmCasLibraryRecoveryBundle(ticket,true,async()=>base,sha);
    const zipped=await encodeCasLibraryRecoveryZip(archive,sha);
    expect(zipped.byteLength).toBeLessThanOrEqual(MAX_CAS_LIBRARY_ZIP_BYTES);
    const checked=await parseCasEmptyLibraryBackupZip(zipped,sha);
    expect(checked.projects).toHaveLength(2);
    for(const original of base.projects){
      const matching=checked.projects.find(p=>p.id===original.id);
      expect(matching?.revision).toBe(original.revision);
      expect(matching?.raw).toBe(original.raw);
    }
    expect(checked.tombstones).toEqual(base.tombstones);
  });

  it("pins compressor-owned ZIP bytes before an async SHA digest can mutate them (#193)",async()=>{
    const base=fixture(),sha=async(raw:string)=>
      createHash("sha256").update(raw).digest("hex");
    const ticket=await prepareCasLibraryRecoveryBundle(async()=>base);
    const archive=await confirmCasLibraryRecoveryBundle(ticket,true,async()=>base,sha);
    let compressorView:Uint8Array|undefined;
    let originalZip:Uint8Array|undefined;
    let digestStarted!:()=>void;
    let releaseDigest!:()=>void;
    const started=new Promise<void>(resolve=>{digestStarted=resolve;});
    const pause=new Promise<void>(resolve=>{releaseDigest=resolve;});
    let called=0;
    const slowDigest=async(raw:string)=>{
      if(++called===1){digestStarted();await pause;}
      return sha(raw);
    };
    const pending=encodeCasLibraryRecoveryZip(archive,slowDigest,entries=>{
      const compressed=zipSync(entries,{level:6});
      // The compressor explicitly returns an offset view over a buffer
      // that the caller retains. Bytes outside the view are not ZIP data.
      const backing=new Uint8Array(compressed.length+64);
      backing.fill(0x9d);
      backing.set(compressed,32);
      compressorView=backing.subarray(32,32+compressed.length);
      originalZip=Uint8Array.from(compressorView);
      return compressorView;
    });
    await started;
    expect(compressorView).toBeDefined();
    expect(originalZip).toBeDefined();
    compressorView!.fill(0); // mutate while the parser awaits its first SHA
    releaseDigest();
    const delivered=await pending;
    expect(delivered).toEqual(originalZip);
    expect(delivered.buffer).not.toBe(compressorView!.buffer);
    const verified=await parseCasEmptyLibraryBackupZip(delivered,sha);
    expect(verified.projects).toHaveLength(archive.projectCount);
    for(const record of base.projects)
      expect(verified.projects.find(p=>p.id===record.id)?.raw).toBe(record.raw);
    expect(verified.tombstones).toEqual(base.tombstones);
  });
  it("still refuses a corrupt compressor result without any ZIP handoff (#193)",async()=>{
    const base=fixture(),sha=async(raw:string)=>
      createHash("sha256").update(raw).digest("hex");
    const ticket=await prepareCasLibraryRecoveryBundle(async()=>base);
    const archive=await confirmCasLibraryRecoveryBundle(ticket,true,async()=>base,sha);
    await expect(encodeCasLibraryRecoveryZip(archive,sha,entries=>{
      const compressed=zipSync(entries,{level:6});
      // The restore parser reads the ZIP central directory. A modified
      // local header alone may be tolerated by fflate: poison an entry's
      // declared uncompressed size with the disallowed ZIP64 sentinel.
      let poisoned=false;
      for(let i=0;i<compressed.length-30;i++){
        if(compressed[i]===0x50 && compressed[i+1]===0x4b &&
           compressed[i+2]===0x01 && compressed[i+3]===0x02){
          compressed.set([0xff,0xff,0xff,0xff],i+24);
          poisoned=true;break;
        }
      }
      expect(poisoned).toBe(true);
      return compressed;
    })).rejects.toBeInstanceOf(CasLibraryZipPortabilityError);
  });
  it("rejects ZIPs above the restore limit before handing off any file",async()=>{
    const base=fixture(),ticket=await prepareCasLibraryRecoveryBundle(async()=>base);
    const archive=await confirmCasLibraryRecoveryBundle(
      ticket,true,async()=>base,mockDigest);
    expect(()=>assertCasLibraryZipPortableSize(0))
      .toThrow(CasLibraryZipPortabilityError);
    expect(()=>assertCasLibraryZipPortableSize(Number.POSITIVE_INFINITY))
      .toThrow(CasLibraryZipPortabilityError);
    expect(()=>assertCasLibraryZipPortableSize(MAX_CAS_LIBRARY_ZIP_BYTES+1))
      .toThrow(CasLibraryZipPortabilityError);
    expect(()=>assertCasLibraryZipPortableSize(MAX_CAS_LIBRARY_ZIP_BYTES))
      .not.toThrow();
    const oversize=vi.fn(()=>new Uint8Array(MAX_CAS_LIBRARY_ZIP_BYTES+1));
    await expect(encodeCasLibraryRecoveryZip(archive,mockDigest,oversize))
      .rejects.toBeInstanceOf(CasLibraryZipPortabilityError);
    expect(oversize).toHaveBeenCalledOnce();
  });
  it("does not deliver a ZIP with mismatched RAW, manifest, file names or counts",async()=>{
    const base=fixture(),ticket=await prepareCasLibraryRecoveryBundle(async()=>base);
    const sha=async(raw:string)=>createHash("sha256").update(raw).digest("hex");
    const archive=await confirmCasLibraryRecoveryBundle(ticket,true,async()=>base,sha);
    const manifest={...archive.files};
    manifest["manifest.json"]=manifest["manifest.json"].replace(
      '"automaticRestore": false','"automaticRestore": true');
    const wrongRaw={...archive.files};
    const projectPath=Object.keys(wrongRaw).find(p=>p.startsWith("projects/"))!;
    wrongRaw[projectPath]+=" ";
    const bad=[
      {...archive,projectCount:1},
      {...archive,files:manifest},
      {...archive,files:wrongRaw},
      {...archive,files:{...archive.files,"../sensitive.txt":"bad"}},
    ];
    for(const corrupted of bad)
      await expect(encodeCasLibraryRecoveryZip(corrupted,sha))
        .rejects.toBeInstanceOf(CasLibraryZipPortabilityError);
  });
  it("rejects invalid digests and never touches localStorage/cloud",async()=>{
    const f=fixture(),blocked=vi.fn(()=>{throw Error("FORBIDDEN_IO");});
    vi.stubGlobal("localStorage",{getItem:blocked,setItem:blocked});
    vi.stubGlobal("sessionStorage",{getItem:blocked,setItem:blocked});
    vi.stubGlobal("fetch",blocked);
    const ticket=await prepareCasLibraryRecoveryBundle(async()=>f);
    await expect(confirmCasLibraryRecoveryBundle(ticket,true,
      async()=>f,async()=> "not-sha256")).rejects.toThrow(/Digest/);
    expect(blocked).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
