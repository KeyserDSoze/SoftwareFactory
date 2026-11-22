import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject,STAGES} from "../domain/defaults";
import {serializeCasProject} from "../infrastructure/project-cas";
import {
  buildCasIsolatedStackConfigEdit,readCasIsolatedStackConfig,
  hasCasIsolatedStackDraft,validateCasIsolatedStackConfig,
} from "./cas-isolated-stack-config";
import type {FactoryProject} from "../domain/types";

const fixture=()=>{
  const p=createProject();
  p.config.name="Standalone native stack";
  p.config.description="Canonical IDB-only";
  p.stages[0]={...p.stages[0],status:"complete",output:"UNVERIFIED_HISTORY_168",
    completionOrigin:"manual",sources:[]};
  return p;
};
const snapshot=(p:FactoryProject,rev=2)=>({
  id:p.id,revision:rev,raw:serializeCasProject(p),
});

describe("CAS native full-stack configuration composer #168",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("edits frontends, deploy, .NET, DB and 5 environment bindings, resets every stage",()=>{
    const p=fixture(),expected=snapshot(p);
    const draft=readCasIsolatedStackConfig(expected)!;
    expect(draft).toEqual(p.config);
    draft.name="New IDB name";
    draft.description="New brief";
    draft.requirements="New requirements";
    draft.frontends=["react-native","ios"];
    draft.deployment="aws";
    draft.dotnetVersion="10.0";
    draft.database="mysql";
    draft.services.database.development="mysql";
    draft.services.database.production="aws-rds";
    draft.services.cache.development="redis";
    draft.services.cache.production="aws-elasticache";
    draft.services.queue.production="aws-sqs";
    draft.services.telemetry.production="aws-cloudwatch";
    draft.services.storage.production="aws-s3";
    expect(hasCasIsolatedStackDraft(expected,draft)).toBe(true);
    const result=buildCasIsolatedStackConfigEdit(expected,draft);
    expect(result.id).toBe(p.id);
    expect(result.config).toEqual(draft);
    expect(result.stages).toHaveLength(6);
    expect(result.stages.every(s=>s.status==="pending" && !s.output &&
      s.sources.length===0 && s.completionOrigin===undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("UNVERIFIED_HISTORY_168");
    expect(p.config.deployment).toBe("docker");
    expect(JSON.stringify(p)).toBe(expected.raw);
  });

  it("distinguishes text edits from stack draft; no-op is refused",()=>{
    const p=fixture(),expected=snapshot(p);
    const draft=readCasIsolatedStackConfig(expected)!;
    expect(hasCasIsolatedStackDraft(expected,draft)).toBe(false);
    draft.name="name only";
    expect(hasCasIsolatedStackDraft(expected,draft)).toBe(false);
    expect(buildCasIsolatedStackConfigEdit(expected,draft).config.name)
      .toBe("name only");
    expect(()=>buildCasIsolatedStackConfigEdit(expected,p.config))
      .toThrow(/Nessuna modifica/);
  });

  it("rejects malformed, noncanonical, overlarge and duplicate frontends",()=>{
    const p=fixture(),expected=snapshot(p);
    const draft=readCasIsolatedStackConfig(expected)!;
    for(const bad of [
      {...draft,frontends:[]},
      {...draft,frontends:["react","react"]},
      {...draft,frontends:["evil"]},
      {...draft,deployment:"unknown"},
      {...draft,dotnetVersion:"9.0"},
      {...draft,database:"none"},
      {...draft,services:{...draft.services,cache:{
        development:"unknown",production:"none",
      }}},
      {...draft,requirements:"github_pat_"+"x".repeat(25)},
      {...draft,name:"x".repeat(121)},
      {...draft,description:"a".repeat(8001)},
      {...draft,extra:"unexpected"},
    ]){
      expect(validateCasIsolatedStackConfig(bad)).toBe(false);
      expect(()=>buildCasIsolatedStackConfigEdit(expected,bad as typeof draft))
        .toThrow(/non valido/);
    }
    expect(()=>buildCasIsolatedStackConfigEdit(
      {...expected,revision:0},{...draft,name:"new"})).toThrow();
    expect(()=>buildCasIsolatedStackConfigEdit(
      {...expected,raw:expected.raw+" "},{...draft,name:"new"})).toThrow();
    expect(()=>buildCasIsolatedStackConfigEdit(
      {...expected,id:"bad"},{...draft,name:"new"})).toThrow();
    expect(readCasIsolatedStackConfig({...expected,id:"bad"})).toBeNull();
  });

  it("never changes stack with pending Code Agent / runner / GitHub binding or stage running",()=>{
    const p=fixture(),c={...p.config,deployment:"gcp" as const};
    p.development={revision:0,overrides:{},originals:{},history:[]};
    expect(()=>buildCasIsolatedStackConfigEdit(snapshot(p),c))
      .toThrow(/Stack bloccato/);
    delete p.development;
    p.githubDestination={owner:"x",repo:"r",branch:"main",authMode:"pat",
      appGateway:"",privateRepo:false};
    expect(()=>buildCasIsolatedStackConfigEdit(snapshot(p),c))
      .toThrow(/Stack bloccato/);
    delete p.githubDestination;
    p.githubTestReceipt={requestId:"1",repository:"x/r",branch:"main",
      commitSha:"old",createdAt:p.updatedAt,selected:["web-test"]};
    expect(()=>buildCasIsolatedStackConfigEdit(snapshot(p),c))
      .toThrow(/Stack bloccato/);
    delete p.githubTestReceipt;
    p.stages[0].status="running";
    expect(()=>buildCasIsolatedStackConfigEdit(snapshot(p),c))
      .toThrow(/stage in esecuzione/);
    p.stages[0].status="complete";
    p.stages[0].completionOrigin="nonexistent" as "manual";
    expect(()=>buildCasIsolatedStackConfigEdit(snapshot(p),c))
      .toThrow();
  });

  it("does not access localStorage, IndexedDB, network, session credentials",()=>{
    const forbidden=vi.fn(()=>{throw Error("FORBIDDEN_168");});
    vi.stubGlobal("localStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("sessionStorage",{getItem:forbidden,setItem:forbidden});
    vi.stubGlobal("indexedDB",{open:forbidden});
    vi.stubGlobal("fetch",forbidden);
    const p=fixture(),ticket=snapshot(p);
    const draft=readCasIsolatedStackConfig(ticket)!;
    draft.deployment="kubernetes";
    expect(buildCasIsolatedStackConfigEdit(ticket,draft)
      .config.deployment).toBe("kubernetes");
    expect(forbidden).not.toHaveBeenCalled();
    expect(STAGES).toHaveLength(6);
  });
});
