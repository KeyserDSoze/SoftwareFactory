import {describe,expect,it} from "vitest";
import {
  factoryWorkspaceMode,factoryWorkspaceUrl,canNavigateLegacyToCas,
  factoryCasHandoffUrl,factoryCasHandoffHint,casHandoffRawDigest,
  matchesCasHandoffHint,
} from "./cas-root-workspace";

const id="11111111-1111-4111-8111-111111111111";
const eligible=()=>({
  busy:false,writerReady:true,editingOutput:false,switching:false,
  localConflict:false,writerContended:false,githubAutoSync:false,
  otherDraft:false,projectId:id,leaseProjectId:id,
  expectedRaw:'{"id":"'+id+'"}',
  persistedRaw:'{"id":"'+id+'"}',
});

describe("factory root CAS-only workspace routing #167",()=>{
  it("requires the exact explicit mode, not a substring or malformed flag",()=>{
    expect(factoryWorkspaceMode("?workspace=cas")).toBe("cas");
    expect(factoryWorkspaceMode("workspace=cas&lang=en")).toBe("cas");
    for(const q of [
      "","?workspace=CAS","?workspace=legacy","?other=workspace%3Dcas",
      "?workspace=casual","?workspace=legacy&workspace=cas",
      "x".repeat(2200),
    ])expect(factoryWorkspaceMode(q)).toBe("legacy");
  });
  it("keeps GitHub Pages base path while switching only the workspace",()=>{
    const base="https://example.github.io/SoftwareFactory/?mode=demo&x=1#stage";
    const cas=factoryWorkspaceUrl(base,"cas");
    expect(cas).toBe("https://example.github.io/SoftwareFactory/"+
      "?mode=demo&x=1&workspace=cas");
    expect(factoryWorkspaceMode(new URL(cas).search)).toBe("cas");
    expect(factoryWorkspaceUrl(cas,"legacy"))
      .toBe("https://example.github.io/SoftwareFactory/?mode=demo&x=1");
    expect(()=>factoryWorkspaceUrl("file:///tmp/a","cas"))
      .toThrow(/HTTP/);
  });
  it("fails closed for busy, dirty, contended, stale and autosync legacy",()=>{
    expect(canNavigateLegacyToCas(eligible())).toBe(true);
    for(const key of ["busy","editingOutput","switching","localConflict",
      "writerContended","githubAutoSync","otherDraft"] as const){
      expect(canNavigateLegacyToCas({...eligible(),[key]:true}))
        .toBe(false);
    }
    expect(canNavigateLegacyToCas({...eligible(),writerReady:false}))
      .toBe(false);
    expect(canNavigateLegacyToCas({...eligible(),leaseProjectId:"other"}))
      .toBe(false);
    expect(canNavigateLegacyToCas({...eligible(),projectId:"bad"}))
      .toBe(false);
    expect(canNavigateLegacyToCas({...eligible(),persistedRaw:null}))
      .toBe(false);
    expect(canNavigateLegacyToCas({...eligible(),persistedRaw:"rival"}))
      .toBe(false);
    expect(canNavigateLegacyToCas({...eligible(),expectedRaw:""}))
      .toBe(false);
    expect(canNavigateLegacyToCas({...eligible(),
      expectedRaw:"z".repeat(1_000_001),persistedRaw:"z".repeat(1_000_001)}))
      .toBe(false);
  });
});

describe("explicit CAS-only legacy handoff link #171",()=>{
  const digest="a".repeat(64);
  const hint={id,revision:1,digest};
  it("preserves Pages base and unrelated query while adding only a bounded fingerprint",()=>{
    const href="https://keyserdsoze.github.io/SoftwareFactory/?a=1#danger";
    const target=factoryCasHandoffUrl(href,hint);
    expect(target).toBe("https://keyserdsoze.github.io/SoftwareFactory/"+
      "?a=1&workspace=cas&casHandoff="+id+"&casRevision=1&casDigest="+digest);
    expect(factoryCasHandoffHint(new URL(target).search)).toEqual(hint);
    expect(factoryWorkspaceUrl(target,"legacy"))
      .toBe("https://keyserdsoze.github.io/SoftwareFactory/?a=1");
    expect(factoryWorkspaceUrl(target,"cas"))
      .toBe("https://keyserdsoze.github.io/SoftwareFactory/?a=1&workspace=cas");
    expect(factoryCasHandoffHint("?workspace=legacy&casHandoff="+id+
      "&casRevision=1&casDigest="+digest)).toBeNull();
  });
  it("rejects crafted, duplicate, missing, ambiguous and oversized hints",()=>{
    const good="?workspace=cas&casHandoff="+id+
      "&casRevision=1&casDigest="+digest;
    for(const bad of [
      good+"&casHandoff="+id,
      good+"&casRevision=1",
      good+"&casDigest="+digest,
      good.replace("casRevision=1","casRevision=0"),
      good.replace("casRevision=1","casRevision=01"),
      good.replace("casRevision=1","casRevision=1.1"),
      good.replace("casRevision=1","casRevision=9007199254740992"),
      good.replace(id,"../../secret"),
      good.replace(digest,"zzz"),
      good.replace("workspace=cas","workspace=CAS"),
      "?casHandoff="+id+"&casRevision=1&casDigest="+digest,
    ])expect(factoryCasHandoffHint(bad)).toBeNull();
    expect(()=>factoryCasHandoffUrl("https://example.com/",{
      ...hint,digest:"secret",
    })).toThrow();
    expect(()=>factoryCasHandoffUrl("https://example.com/",{
      ...hint,revision:0,
    })).toThrow();
  });
  it("SHA-256 binds exact JSON bytes, ID and revision without leaking raw in URL",async()=>{
    const raw='{"id":"'+id+'","secret":"sensitive unlinked text"}';
    const hash=await casHandoffRawDigest(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const proof={id,revision:7,digest:hash};
    expect(await matchesCasHandoffHint(proof,{id,revision:7,raw}))
      .toBe(true);
    expect(await matchesCasHandoffHint(proof,{id,revision:8,raw}))
      .toBe(false);
    expect(await matchesCasHandoffHint(proof,{id,revision:7,raw:raw+" "}))
      .toBe(false);
    expect(await matchesCasHandoffHint(proof,{id:"other",revision:7,raw}))
      .toBe(false);
    const url=factoryCasHandoffUrl("https://example.com/",proof);
    expect(url).not.toContain("sensitive");
    expect(url).not.toContain("%7B");
    await expect(casHandoffRawDigest("x".repeat(1_000_001))).rejects.toThrow();
  });
});
