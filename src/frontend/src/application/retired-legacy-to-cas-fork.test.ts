import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createProject,STAGES} from "../domain/defaults";
import {armLegacyCasRetirement,LEGACY_CAS_RETIREMENT_PREFIX}
  from "../infrastructure/legacy-cas-retirement";
import {persistProject,localProjectSnapshot} from "../infrastructure/store";
import {
  readCasProjectSlot,insertCasProjectNeverSeen,serializeCasProject,
} from "../infrastructure/project-cas";
import {casHandoffRawDigest,matchesCasHandoffHint}
  from "./cas-root-workspace";
import {
  prepareRetiredLegacyToCasFork,commitRetiredLegacyToCasFork,
} from "./retired-legacy-to-cas-fork";
import type {CasProjectSlot,CasProjectSnapshot}
  from "../infrastructure/project-cas";
vi.mock("../infrastructure/project-cas",async importOriginal=>{
  const orig=await importOriginal<typeof import("../infrastructure/project-cas")>();
  return {...orig,readCasProjectSlot:vi.fn(),insertCasProjectNeverSeen:vi.fn()};
});
const readNative=vi.mocked(readCasProjectSlot);
const insertNative=vi.mocked(insertCasProjectNeverSeen);
const library=new Map<string,string>();
const native=new Map<string,CasProjectSlot>();
const SLOT="softwarefactory.project.library.v1.";
let insertCalls=0;
function initStore(){
  vi.stubGlobal("localStorage",{
    get length(){return library.size;},
    key:(n:number)=>[...library.keys()][n]??null,
    getItem:(k:string)=>library.get(k)??null,
    setItem:(k:string,v:string)=>{library.set(k,v);},
  });
  vi.stubGlobal("sessionStorage",{getItem:()=>null,setItem:()=>undefined});
}
async function fixture(){
  const project=createProject();
  project.config.name="Recover native";
  project.config.description="Historical brief";
  project.config.requirements="Keep stack but not AI evidence";
  project.config.frontends=["react","android"];
  project.config.services.cache.production="redis";
  project.stages[0]={...project.stages[0],status:"complete",
    output:"HISTORICAL_AI_OUTPUT_175",completionOrigin:"ai"};
  project.githubDestination={owner:"old",repo:"published",branch:"main",
    authMode:"pat",appGateway:"",privateRepo:true};
  project.githubSync={owner:"old",repo:"published",branch:"main",
    lastCommit:"HISTORICAL_SHA_175",syncedLocalUpdatedAt:project.updatedAt,
    syncedAt:project.updatedAt};
  project.githubTestReceipt={requestId:"historic",repository:"old/published",
    branch:"main",commitSha:"old",createdAt:project.updatedAt,
    selected:["web-test"]};
  project.development={revision:1,
    overrides:{"x.ts":"HISTORICAL_CODE_175"},
    originals:{"x.ts":null},history:[]};
  persistProject(project);
  const raw=localProjectSnapshot(project.id)!;
  armLegacyCasRetirement({id:project.id,raw},await casHandoffRawDigest(raw));
  return {project,raw,marker:library.get(LEGACY_CAS_RETIREMENT_PREFIX+project.id)};
}
describe("retired legacy -> NEW native IndexedDB CAS clean config fork (#175)",()=>{
  beforeEach(()=>{
    library.clear();native.clear();insertCalls=0;
    initStore();
    readNative.mockReset();
    insertNative.mockReset();
    readNative.mockImplementation(async id=>native.get(id)??{state:"missing"});
    insertNative.mockImplementation(async (project,raw)=>{
      insertCalls++;
      if(native.has(project.id))throw Error("native collision or tombstone");
      if(serializeCasProject(project)!==raw)throw Error("noncanonical");
      const snapshot:CasProjectSnapshot={id:project.id,revision:1,raw};
      native.set(project.id,{state:"present",snapshot});
      return snapshot;
    });
  });
  afterEach(()=>vi.unstubAllGlobals());
  it("creates only fresh native config; no second legacy project or stale evidence",async()=>{
    const {project,raw,marker}=await fixture();
    const ticket=await prepareRetiredLegacyToCasFork(project.id);
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(ticket.source.raw).toBe(raw);
    expect(ticket.target.id).not.toBe(project.id);
    const body=JSON.parse(ticket.target.raw);
    expect(body.config).toEqual({...project.config,
      name:project.config.name+" (recovery)"});
    expect(body.stages).toEqual(STAGES.map(({id,label})=>({
      id,label,status:"pending",output:"",sources:[],
    })));
    expect(Object.keys(body).sort()).toEqual([
      "config","createdAt","id","stages","updatedAt"]);
    expect(ticket.target.raw).not.toMatch(
      /HISTORICAL_AI_OUTPUT_175|HISTORICAL_CODE_175|HISTORICAL_SHA_175/);
    const keysBefore=[...library.keys()].sort();
    await expect(commitRetiredLegacyToCasFork(ticket,false,()=>true))
      .rejects.toThrow(/non autorizzato/);
    expect(insertCalls).toBe(0);
    expect([...library.keys()].sort()).toEqual(keysBefore);
    const result=await commitRetiredLegacyToCasFork(ticket,true,()=>true);
    expect(result.status).toBe("ready");
    expect(result.id).toBe(ticket.target.id);
    expect(result.revision).toBe(1);
    expect(result.hint).toMatchObject({id:result.id,revision:1});
    expect(result.hint?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await matchesCasHandoffHint(result.hint!,native.get(result.id)!
      .state==="present" ? (native.get(result.id) as
      {state:"present";snapshot:CasProjectSnapshot}).snapshot :
      {id:result.id,revision:1,raw:""})).toBe(true);
    expect(insertCalls).toBe(1);
    expect([...library.keys()].sort()).toEqual(keysBefore);
    expect(library.get(SLOT+project.id)).toBe(raw);
    expect(library.get(LEGACY_CAS_RETIREMENT_PREFIX+project.id)).toBe(marker);
    expect(library.has(SLOT+result.id)).toBe(false);
  });
  it("fails closed on corrupt marker, mismatched SHA-256 and source drift",async()=>{
    const {project,raw,marker}=await fixture();
    const k=LEGACY_CAS_RETIREMENT_PREFIX+project.id;
    library.set(k,"{");
    await expect(prepareRetiredLegacyToCasFork(project.id))
      .rejects.toThrow(/non valida/);
    library.set(k,JSON.stringify({schema:1,id:project.id,
      digest:"b".repeat(64)}));
    await expect(prepareRetiredLegacyToCasFork(project.id))
      .rejects.toThrow(/Digest/);
    library.set(k,marker!);
    const ticket=await prepareRetiredLegacyToCasFork(project.id);
    library.set(SLOT+project.id,raw+" ");
    await expect(commitRetiredLegacyToCasFork(ticket,true,()=>true))
      .rejects.toThrow(/cambiato/);
    expect(insertCalls).toBe(0);
  });
  it("rejects present and tombstoned target, before and after consents",async()=>{
    const {project}=await fixture();
    const first=await prepareRetiredLegacyToCasFork(project.id);
    native.set(first.target.id,{state:"tombstone",revision:8});
    await expect(commitRetiredLegacyToCasFork(first,true,()=>true))
      .rejects.toThrow(/tombstoned/);
    expect(insertCalls).toBe(0);
    native.delete(first.target.id);
    native.set(first.target.id,{state:"present",snapshot:{
      id:first.target.id,revision:1,raw:first.target.raw}});
    await expect(commitRetiredLegacyToCasFork(first,true,()=>true))
      .rejects.toThrow(/tombstoned/);
    native.delete(first.target.id);
    library.set(SLOT+first.target.id,"RIVAL_LEGACY_UUID_175");
    await expect(commitRetiredLegacyToCasFork(first,true,()=>true))
      .rejects.toThrow(/legacy/);
    expect(insertCalls).toBe(0);
    library.delete(SLOT+first.target.id);
    const nativeNow=readNative.getMockImplementation()!;
    readNative.mockImplementationOnce(async id=>id===first.target.id?
      {state:"missing"}:nativeNow(id));
    // Noncooperating writer wins during the native readwrite transaction.
    insertNative.mockImplementationOnce(async (target,raw)=>{
      insertCalls++;
      native.set(target.id,{state:"present",
        snapshot:{id:target.id,revision:1,raw}});
      throw Error("Lost transaction race");
    });
    await expect(commitRetiredLegacyToCasFork(first,true,()=>true))
      .rejects.toThrow(/Lost transaction/);
    expect(insertCalls).toBe(1);
    expect(native.get(first.target.id)?.state).toBe("present");
  });
  it("rejects a ticket forged to carry historical evidence",async()=>{
    const {project}=await fixture();
    const ticket=await prepareRetiredLegacyToCasFork(project.id);
    const forged=JSON.parse(ticket.target.raw);
    forged.githubTestReceipt={runId:777};
    await expect(commitRetiredLegacyToCasFork({
      source:ticket.source,target:{...ticket.target,raw:JSON.stringify(forged)},
    },true,()=>true)).rejects.toThrow(/alterato/);
    expect(insertCalls).toBe(0);
  });
  it("lost native acknowledgement might have committed: caller must NOT retry",async()=>{
    const {project,raw,marker}=await fixture();
    const ticket=await prepareRetiredLegacyToCasFork(project.id);
    insertNative.mockImplementationOnce(async (target,exact)=>{
      insertCalls++;
      native.set(target.id,{state:"present",snapshot:{
        id:target.id,revision:1,raw:exact,
      }});
      throw Error("UNKNOWN_NATIVE_ACK_175");
    });
    await expect(commitRetiredLegacyToCasFork(ticket,true,()=>true))
      .rejects.toThrow(/UNKNOWN_NATIVE_ACK/);
    expect(insertCalls).toBe(1);
    expect(native.get(ticket.target.id)?.state).toBe("present");
    expect(library.get(SLOT+project.id)).toBe(raw);
    expect(library.get(LEGACY_CAS_RETIREMENT_PREFIX+project.id)).toBe(marker);
    await expect(commitRetiredLegacyToCasFork(ticket,true,()=>true))
      .rejects.toThrow(/tombstoned/);
    expect(insertCalls).toBe(1);
  });
  it("does not navigate on post-ACK source change, rival update or readback failure",async()=>{
    const {project,raw}=await fixture();
    const ticket=await prepareRetiredLegacyToCasFork(project.id);
    const nativeRead=readNative.getMockImplementation()!;
    let reads=0;
    readNative.mockImplementation(async id=>{
      reads++;
      if(reads>=2)return {state:"tombstone",revision:2};
      return nativeRead(id);
    });
    const out=await commitRetiredLegacyToCasFork(ticket,true,()=>true);
    expect(out).toEqual({status:"copied_unverified",
      id:ticket.target.id,revision:1});
    expect(insertCalls).toBe(1);
    expect(library.get(SLOT+project.id)).toBe(raw);
    // Distinct never-seen ticket: after success the source could also be
    // changed by a noncooperating tab while post-ACK digest is pending.
    readNative.mockImplementation(nativeRead);
    const newer=await prepareRetiredLegacyToCasFork(project.id);
    const insert=insertNative.getMockImplementation()!;
    insertNative.mockImplementationOnce(async (p,r)=>{
      const ack=await insert(p,r);
      library.set(SLOT+project.id,raw+" ");
      return ack;
    });
    const stale=await commitRetiredLegacyToCasFork(newer,true,()=>true);
    expect(stale.status).toBe("copied_unverified");
    expect(stale.hint).toBeUndefined();
  });
  it("honors lack of consent or changing lease before native insert",async()=>{
    const {project}=await fixture();
    const ticket=await prepareRetiredLegacyToCasFork(project.id);
    let count=0;
    await expect(commitRetiredLegacyToCasFork(ticket,true,()=>{
      count++;return count<2;
    })).rejects.toThrow(/cambiato/);
    expect(insertCalls).toBe(0);
    await expect(commitRetiredLegacyToCasFork(ticket,true,()=>false))
      .rejects.toThrow(/non autorizzato/);
    expect(insertCalls).toBe(0);
  });
});
