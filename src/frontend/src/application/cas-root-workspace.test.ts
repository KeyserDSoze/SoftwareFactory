import {describe,expect,it} from "vitest";
import {
  factoryWorkspaceMode,factoryWorkspaceUrl,canNavigateLegacyToCas,
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
