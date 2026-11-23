import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {createProject,STAGES} from "../domain/defaults";
import {persistProject,localProjectSnapshot} from "../infrastructure/store";
import {armLegacyCasRetirement,LEGACY_CAS_RETIREMENT_PREFIX}
  from "../infrastructure/legacy-cas-retirement";
import {casHandoffRawDigest} from "./cas-root-workspace";
import {
  prepareRetiredLegacyConfigFork,confirmRetiredLegacyConfigFork,
} from "./legacy-retired-config-fork";
const SLOT="softwarefactory.project.library.v1.";
const items=new Map<string,string>();
const locks=new Set<string>();
let blockTarget=false,quota=false,ackFaultSlot="",ackReadCount=0,slotWrites=0;
const source=async()=>{
  const p=createProject();
  p.config.name="Recover this project";
  p.config.description="Recover the product brief";
  p.config.requirements="No false evidence";
  p.config.frontends=["react","android"];
  p.config.services.cache.production="redis";
  p.stages[0]={...p.stages[0],status:"complete",output:"HISTORICAL_OUTPUT_174",
    completionOrigin:"ai",sources:[]};
  p.githubDestination={owner:"old",repo:"bound",branch:"main",authMode:"pat",
    appGateway:"",privateRepo:false};
  p.githubSync={owner:"old",repo:"bound",branch:"main",lastCommit:"HISTORIC_COMMIT",
    syncedLocalUpdatedAt:p.updatedAt,syncedAt:p.updatedAt};
  p.githubTestReceipt={requestId:"old",repository:"old/bound",branch:"main",
    commitSha:"old",createdAt:p.updatedAt,selected:["web-test"]};
  p.development={revision:1,overrides:{"x.ts":"HISTORIC_CODE_174"},
    originals:{"x.ts":null},history:[],lastRunnerJobId:"RUNNER_ID_174"};
  persistProject(p);
  const raw=localProjectSnapshot(p.id)!;
  armLegacyCasRetirement({id:p.id,raw},await casHandoffRawDigest(raw));
  return {p,raw};
};
describe("retired legacy clean configuration fork (#174)",()=>{
  beforeEach(()=>{
    items.clear();locks.clear();blockTarget=false;quota=false;
    ackFaultSlot="";ackReadCount=0;slotWrites=0;
    vi.stubGlobal("localStorage",{
      get length(){return items.size;},
      key:(i:number)=>[...items.keys()][i]??null,
      getItem:(key:string)=>{
        if(key===ackFaultSlot && items.has(key) && ++ackReadCount===2)
          return null; // simulated missing ACK after actual slot write
        return items.get(key)??null;
      },
      setItem:(key:string,value:string)=>{
        if(quota && key.startsWith(SLOT))throw Error("QUOTA_SECRET");
        if(key.startsWith(SLOT))slotWrites++;
        items.set(key,value);
      },
    });
    vi.stubGlobal("sessionStorage",{getItem:()=>null,setItem:()=>undefined});
    vi.stubGlobal("navigator",{locks:{request:async(key:string,_options:unknown,
      callback:(lock:Lock|null)=>Promise<void>)=>{
        if(blockTarget || locks.has(key))return callback(null);
        locks.add(key);
        try{await callback({name:key} as Lock);}
        finally{locks.delete(key);}
      }}});
  });
  afterEach(()=>vi.unstubAllGlobals());
  it("copies only validated non-secret config into fresh UUID with all pending stages",async()=>{
    const {p,raw}=await source();
    const ticket=await prepareRetiredLegacyConfigFork(p.id);
    expect(ticket.target.id).not.toBe(p.id);
    expect(ticket.source.raw).toBe(raw);
    expect(Object.isFrozen(ticket)).toBe(true);
    const preview=JSON.parse(ticket.target.raw);
    expect(preview.config).toEqual({...p.config,name:p.config.name+" (recovery)"});
    expect(preview.stages).toEqual(STAGES.map(({id,label})=>({
      id,label,status:"pending",output:"",sources:[],
    })));
    expect(Object.keys(preview).sort()).toEqual(
      ["config","createdAt","id","stages","updatedAt"]);
    expect(ticket.target.raw).not.toContain("HISTORICAL_OUTPUT_174");
    expect(ticket.target.raw).not.toContain("HISTORIC_CODE_174");
    expect(ticket.target.raw).not.toContain("HISTORIC_COMMIT");
    expect(ticket.target.raw).not.toContain("RUNNER_ID_174");
    expect(items.get(SLOT+ticket.target.id)).toBeUndefined();
    expect(items.get(SLOT+p.id)).toBe(raw);
    await expect(confirmRetiredLegacyConfigFork(ticket,false,()=>true))
      .rejects.toThrow(/consenso/);
    expect(items.get(SLOT+ticket.target.id)).toBeUndefined();
    expect(await confirmRetiredLegacyConfigFork(ticket,true,()=>true))
      .toEqual({status:"created",id:ticket.target.id});
    expect(items.get(SLOT+ticket.target.id)).toBe(ticket.target.raw);
    expect(items.get(SLOT+p.id)).toBe(raw);
    expect(items.get(LEGACY_CAS_RETIREMENT_PREFIX+p.id)).toBeDefined();
    expect(locks.size).toBe(0);
  });
  it("rejects incorrect marker digest, malformed marker, source changed, running stage",async()=>{
    const {p,raw}=await source();
    const marker=LEGACY_CAS_RETIREMENT_PREFIX+p.id;
    items.set(marker,JSON.stringify({schema:1,id:p.id,digest:"a".repeat(64)}));
    await expect(prepareRetiredLegacyConfigFork(p.id))
      .rejects.toThrow(/Digest/);
    items.set(marker,"{");
    await expect(prepareRetiredLegacyConfigFork(p.id))
      .rejects.toThrow(/non valida/);
    items.set(marker,JSON.stringify({schema:1,id:p.id,
      digest:await casHandoffRawDigest(raw)}));
    const ticket=await prepareRetiredLegacyConfigFork(p.id);
    items.set(SLOT+p.id,JSON.stringify({...p,config:{...p.config,
      description:"RIVAL_MODIFIED_SOURCE"}}));
    await expect(confirmRetiredLegacyConfigFork(ticket,true,()=>true))
      .rejects.toThrow(/cambiato/);
    expect(items.get(SLOT+ticket.target.id)).toBeUndefined();
    items.set(SLOT+p.id,raw);
    items.set(SLOT+p.id,JSON.stringify({...p,stages:p.stages.map((s,i)=>
      i===1?{...s,status:"running"}:s)}));
    await expect(prepareRetiredLegacyConfigFork(p.id))
      .rejects.toThrow(/Digest|non sicura/);
  });
  it("detects occupied target before or after destination lease, no overwrite",async()=>{
    const {p}=await source(),ticket=await prepareRetiredLegacyConfigFork(p.id);
    items.set(SLOT+ticket.target.id,"RIVAL_RESERVED");
    await expect(confirmRetiredLegacyConfigFork(ticket,true,()=>true))
      .rejects.toThrow(/già utilizzato/);
    expect(items.get(SLOT+ticket.target.id)).toBe("RIVAL_RESERVED");
    items.delete(SLOT+ticket.target.id);
    blockTarget=true;
    await expect(confirmRetiredLegacyConfigFork(ticket,true,()=>true))
      .rejects.toThrow(/altra scheda/);
    blockTarget=false;
    let calls=0;
    await expect(confirmRetiredLegacyConfigFork(ticket,true,()=>{
      calls++;
      if(calls===3)items.set(SLOT+ticket.target.id,"RIVAL_AFTER_LEASE");
      return true;
    })).rejects.toThrow(/già utilizzato/);
    expect(items.get(SLOT+ticket.target.id)).toBe("RIVAL_AFTER_LEASE");
  });
  it("fails quota without touching protected original; no hidden retry",async()=>{
    const {p,raw}=await source(),ticket=await prepareRetiredLegacyConfigFork(p.id);
    quota=true;
    await expect(confirmRetiredLegacyConfigFork(ticket,true,()=>true))
      .rejects.toThrow(/Spazio locale insufficiente/);
    expect(items.get(SLOT+ticket.target.id)).toBeUndefined();
    expect(items.get(SLOT+p.id)).toBe(raw);
  });
  it("never retries an unknown acknowledgement after the target slot was written",async()=>{
    const {p,raw}=await source();
    const ticket=await prepareRetiredLegacyConfigFork(p.id);
    const beforeWrites=slotWrites;
    ackFaultSlot=SLOT+ticket.target.id;
    await expect(confirmRetiredLegacyConfigFork(ticket,true,()=>true))
      .rejects.toThrow(/non confermata/);
    expect(slotWrites).toBe(beforeWrites+1);
    expect(items.get(ackFaultSlot)).toBe(ticket.target.raw);
    expect(items.get(SLOT+p.id)).toBe(raw);
    expect(items.get(LEGACY_CAS_RETIREMENT_PREFIX+p.id)).toBeDefined();
    // A brand-new ticket is required for a new attempt; never reuse the
    // occupied UUID from an unacknowledged insert.
    await expect(confirmRetiredLegacyConfigFork(ticket,true,()=>true))
      .rejects.toThrow(/già utilizzato/);
    expect(slotWrites).toBe(beforeWrites+1);
  });
  it("denies forged target that transfers evidence and blocks missing marker",async()=>{
    const {p}=await source(),ticket=await prepareRetiredLegacyConfigFork(p.id);
    const injected=JSON.parse(ticket.target.raw);
    injected.githubTestReceipt={runId:1};
    await expect(confirmRetiredLegacyConfigFork({
      source:ticket.source,target:{...ticket.target,raw:JSON.stringify(injected)},
    },true,()=>true)).rejects.toThrow(/alterato/);
    items.delete(LEGACY_CAS_RETIREMENT_PREFIX+p.id);
    await expect(confirmRetiredLegacyConfigFork(ticket,true,()=>true))
      .rejects.toThrow(/mancante/);
    expect(items.get(SLOT+ticket.target.id)).toBeUndefined();
  });
});
