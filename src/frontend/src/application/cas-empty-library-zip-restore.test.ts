import {describe,expect,it,vi} from "vitest";
import {createHash} from "node:crypto";
import {zipSync,strToU8} from "fflate";
import {createProject} from "../domain/defaults";
import {serializeCasProject} from "../infrastructure/project-cas";
import {
  MAX_CAS_LIBRARY_ZIP_BYTES,parseCasEmptyLibraryBackupZip,
  prepareCasEmptyLibraryRestorePreview,confirmCasEmptyLibraryBackupRestore,
} from "./cas-empty-library-zip-restore";

const digest=async(raw:string)=>createHash("sha256").update(raw).digest("hex");
type Entry={id:string;revision:number;file:string;sha256:string};
function sample(){
  const a=createProject(),b=createProject();
  a.config.name="Secret historic project 189";
  a.stages[0].status="complete";
  a.stages[0].output="UNVERIFIED_TEST_189_NO_NEW_EVIDENCE";
  b.config.name="Second project of library 189";
  const projects=[a,b];
  const manifest={
    format:"softwarefactory-cas-library-recovery",
    schemaVersion:1,storage:"indexeddb-same-origin-profile",
    warning:"PLAINTEXT historical JSON; SHA-256 is NOT a signature or test.",
    automaticRestore:false,
    projects:projects.map((p,i)=>{
      const raw=serializeCasProject(p);
      return {id:p.id,revision:i+2,file:"projects/"+p.id+"-r"+(i+2)+".json",
        sha256:createHash("sha256").update(raw).digest("hex")};
    }),
    tombstones:[{id:"e1890000-1111-4111-8111-111111111189",revision:9}],
  };
  const entries:Record<string,Uint8Array>={
    "manifest.json":strToU8(JSON.stringify(manifest)),
  };
  projects.forEach((p,i)=>{
    entries[manifest.projects[i].file]=strToU8(serializeCasProject(p));
  });
  const zip=()=>zipSync(entries,{level:6});
  return {projects,manifest,entries,zip};
}

describe("native CAS full ZIP empty-library atomic restore #189",()=>{
  it("parses authentic exporter ZIP, raw byte-exact SHA-256 and tombstone metadata",async()=>{
    const f=sample();
    const ticket=await parseCasEmptyLibraryBackupZip(f.zip(),digest);
    expect(ticket.format).toBe(f.manifest.format);
    expect(ticket.projects).toHaveLength(2);
    expect(ticket.projects.map(p=>p.id)).toEqual(
      f.projects.map(p=>p.id).sort());
    expect(ticket.tombstones).toEqual(f.manifest.tombstones);
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(Object.isFrozen(ticket.projects[0])).toBe(true);
    for(const project of f.projects)
      expect(ticket.projects.find(p=>p.id===project.id)?.raw)
        .toBe(serializeCasProject(project));
    expect(JSON.stringify(ticket.tombstones)).not.toContain(
      "UNVERIFIED_TEST_189");
  });
  it("requires a read-only TRUE-empty IDB preview including tombstones",async()=>{
    const f=sample(),read=vi.fn(async()=>true);
    const ticket=await prepareCasEmptyLibraryRestorePreview(
      f.zip(),digest,read);
    expect(ticket.projects).toHaveLength(2);
    expect(read).toHaveBeenCalledOnce();
    await expect(prepareCasEmptyLibraryRestorePreview(f.zip(),
      digest,async()=>false)).rejects.toThrow(/non vuoto/);
  });
  it("declined consent never invokes the native writer",async()=>{
    const f=sample(),ticket=await parseCasEmptyLibraryBackupZip(f.zip(),digest);
    const write=vi.fn(async()=>[]);
    await expect(confirmCasEmptyLibraryBackupRestore(ticket,false,write,digest))
      .rejects.toThrow(/Consenso/);
    expect(write).not.toHaveBeenCalled();
  });
  it("authorizes ALL exact active project raw in one atomic call at rev 1",async()=>{
    const f=sample(),ticket=await parseCasEmptyLibraryBackupZip(f.zip(),digest);
    const write=vi.fn(async(entries:ReadonlyArray<{id:string;raw:string}>)=>
      entries.map(p=>({id:p.id,revision:1,raw:p.raw})));
    const result=await confirmCasEmptyLibraryBackupRestore(
      ticket,true,write,digest);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toHaveLength(2);
    expect(result.every(p=>p.revision===1)).toBe(true);
    expect(result.map(p=>p.id)).toEqual(ticket.projects.map(p=>p.id));
    expect(JSON.stringify(write.mock.calls[0][0]))
      .not.toContain("e1890000-1111-4111-8111-111111111189");
  });
  it("post-commit malformed readback is ambiguous: NEVER auto-retry",async()=>{
    const f=sample(),ticket=await parseCasEmptyLibraryBackupZip(f.zip(),digest);
    const write=vi.fn(async(entries:ReadonlyArray<{id:string;raw:string}>)=>
      entries.slice(0,1).map(p=>({id:p.id,revision:1,raw:p.raw})));
    await expect(confirmCasEmptyLibraryBackupRestore(ticket,true,write,digest))
      .rejects.toThrow(/NON riprovare/);
    expect(write).toHaveBeenCalledOnce();
  });
  it("rejects tampered digest, missing/extra file, zip slip and unknown entries",async()=>{
    const f=sample();
    const wrongHash={...f.manifest,
      projects:f.manifest.projects.map((p,i)=>
        i===0?{...p,sha256:"0".repeat(64)}:p)};
    const invalid=[
      {"manifest.json":strToU8(JSON.stringify(wrongHash)),
        ...Object.fromEntries(Object.entries(f.entries)
          .filter(([key])=>key!=="manifest.json"))},
      Object.fromEntries(Object.entries(f.entries)
        .filter(([key])=>key!==f.manifest.projects[0].file)),
      {...f.entries,"../secret.json":strToU8("{}")},
      {...f.entries,"projects/":strToU8("bad directory")},
      {...f.entries,"unexpected.txt":strToU8("EXTRA")},
    ];
    for(const entries of invalid){
      await expect(parseCasEmptyLibraryBackupZip(
        zipSync(entries,{level:6}),digest,
      )).rejects.toThrow(/ZIP libreria CAS non valido/);
    }
  });
  it("rejects malformed JSON, duplicate IDs, source rev spoof, tombstone collision",async()=>{
    const f=sample();
    const variants=[
      {...f.manifest,projects:[f.manifest.projects[0],f.manifest.projects[0]]},
      {...f.manifest,projects:f.manifest.projects.map((x,i)=>
        i===0?{...x,revision:100}:x)},
      {...f.manifest,tombstones:[{
        id:f.projects[0].id,revision:3,
      }]},
      {...f.manifest,automaticRestore:true},
      {...f.manifest,storage:"legacy-localStorage"},
    ];
    for(const manifest of variants){
      const zip=zipSync({...f.entries,
        "manifest.json":strToU8(JSON.stringify(manifest))},{level:6});
      await expect(parseCasEmptyLibraryBackupZip(zip,digest))
        .rejects.toThrow(/ZIP libreria CAS non valido/);
    }
  });
  it("rejects noncanonical raw, zip >20MB and uncompressed header bomb early",async()=>{
    const f=sample();
    const noncanonical=zipSync({...f.entries,
      [f.manifest.projects[0].file]:strToU8(
        serializeCasProject(f.projects[0])+" "),
    },{level:6});
    await expect(parseCasEmptyLibraryBackupZip(noncanonical,digest))
      .rejects.toThrow(/ZIP libreria CAS non valido/);
    await expect(parseCasEmptyLibraryBackupZip(
      new Uint8Array(MAX_CAS_LIBRARY_ZIP_BYTES+1),digest,
    )).rejects.toThrow(/ZIP libreria CAS non valido/);
    // Central-directory uncompressed size is a ZIP64 4 GiB sentinel.
    // Must fail in filter BEFORE fflate could allocate ~4 GiB.
    const mutated=f.zip();
    let modified=false;
    for(let i=0;i<mutated.length-30;i++){
      if(mutated[i]===0x50&&mutated[i+1]===0x4b&&
         mutated[i+2]===0x01&&mutated[i+3]===0x02){
        mutated.set([0xff,0xff,0xff,0xff],i+24);
        modified=true;break;
      }
    }
    expect(modified).toBe(true);
    await expect(parseCasEmptyLibraryBackupZip(mutated,digest))
      .rejects.toThrow(/ZIP libreria CAS non valido/);
  });
  it("cannot access localStorage, sessionStorage or network on preview or consent",async()=>{
    const f=sample(),blocked=vi.fn(()=>{throw Error("SECRET_IO_MUST_NOT_HAPPEN");});
    vi.stubGlobal("localStorage",{getItem:blocked,setItem:blocked});
    vi.stubGlobal("sessionStorage",{getItem:blocked,setItem:blocked});
    vi.stubGlobal("fetch",blocked);
    const ticket=await prepareCasEmptyLibraryRestorePreview(
      f.zip(),digest,async()=>true);
    const saved=await confirmCasEmptyLibraryBackupRestore(ticket,true,
      async entries=>entries.map(p=>({...p,revision:1})),digest);
    expect(saved).toHaveLength(2);
    expect(blocked).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
