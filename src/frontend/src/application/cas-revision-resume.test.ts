import {describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {serializeCasProject} from "../infrastructure/project-cas";
import type {CasProjectSlot,CasProjectSnapshot}
  from "../infrastructure/project-cas";
import {
  factoryCasHandoffHint,matchesCasHandoffHint,
} from "./cas-root-workspace";
import {prepareCasRevisionResumeLink}
  from "./cas-revision-resume";

const src=()=>{
  const project=createProject();
  project.config.name="Pinned private brief";
  project.config.description="TOP_SECRET_BRIEF_CONTENT_176";
  const raw=serializeCasProject(project);
  return {id:project.id,revision:4,raw} satisfies CasProjectSnapshot;
};
const present=(s:CasProjectSnapshot):CasProjectSlot=>
  ({state:"present",snapshot:s});
const URL_WITH_SECRETS=
  "https://example.test/factory/base/?code=AUTH_CODE_SECRET&state=OAUTH_STATE_SECRET"+
  "&access_token=TOKEN_SECRET#fragment_secret";

describe("CAS revision-bound return link (#176)",()=>{
  it("returns only ID/rev/SHA-256 and canonical CAS-only Pages base path",async()=>{
    const expected=src();
    const read=vi.fn(async()=>present(expected));
    const result=await prepareCasRevisionResumeLink(
      expected,URL_WITH_SECRETS,()=>true,read);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toMatchObject({id:expected.id,revision:4});
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    const url=new URL(result.url);
    expect(url.origin+url.pathname)
      .toBe("https://example.test/factory/base/");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "casDigest","casHandoff","casRevision","workspace",
    ]);
    expect(url.hash).toBe("");
    expect(url.searchParams.get("workspace")).toBe("cas");
    expect(result.url).not.toMatch(
      /TOP_SECRET_BRIEF_CONTENT_176|AUTH_CODE_SECRET|OAUTH_STATE_SECRET|TOKEN_SECRET|fragment_secret/);
    expect(read).toHaveBeenCalledTimes(2);
    const parsed=factoryCasHandoffHint(url.search);
    expect(parsed).toEqual({id:expected.id,revision:4,digest:result.digest});
    expect(await matchesCasHandoffHint(parsed!,expected)).toBe(true);
  });
  it("never reads the browser store if the UI has a dirty draft or no stable session",async()=>{
    const snapshot=src();
    const read=vi.fn(async()=>present(snapshot));
    await expect(prepareCasRevisionResumeLink(snapshot,URL_WITH_SECRETS,
      ()=>false,read)).rejects.toThrow(/bozza/);
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses malformed, noncanonical, running or contradictory snapshots",async()=>{
    const expected=src(),read=vi.fn(async()=>present(expected));
    const candidates=[
      {...expected,revision:0},
      {...expected,id:"not-a-uuid"},
      {...expected,raw:expected.raw+" "},
      {...expected,raw:JSON.stringify({
        ...JSON.parse(expected.raw),id:crypto.randomUUID(),
      })},
      {...expected,raw:JSON.stringify({
        ...JSON.parse(expected.raw),
        stages:(JSON.parse(expected.raw).stages as Array<{status:string}>)
          .map((s,i)=>i===0?{...s,status:"running"}:s),
      })},
    ];
    for(const candidate of candidates)
      await expect(prepareCasRevisionResumeLink(
        candidate,URL_WITH_SECRETS,()=>true,read))
        .rejects.toThrow(/non canonica|checkpoint/);
    expect(read).not.toHaveBeenCalled();
  });
  it("blocks absent and tombstoned exact ID, no fallback to legacy",async()=>{
    const expected=src();
    for(const slot of [
      {state:"missing"} as CasProjectSlot,
      {state:"tombstone",revision:5} as CasProjectSlot,
    ]){
      const read=vi.fn(async()=>slot);
      await expect(prepareCasRevisionResumeLink(
        expected,URL_WITH_SECRETS,()=>true,read))
        .rejects.toThrow(/modificata\/eliminata/);
      expect(read).toHaveBeenCalledTimes(1);
    }
  });
  it("detects a noncooperating tab updating revision AFTER the hash",async()=>{
    const expected=src(),rival={...expected,revision:5};
    let reads=0;
    const read=vi.fn(async()=>{
      reads++;
      return present(reads===1?expected:rival);
    });
    await expect(prepareCasRevisionResumeLink(
      expected,URL_WITH_SECRETS,()=>true,read))
      .rejects.toThrow(/modificata\/eliminata/);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("detects a rival rewriting raw at the same revision",async()=>{
    const expected=src();
    const rival={...expected,raw:expected.raw.replace(
      "Pinned private brief","CONCURRENT_OTHER_TAB_176")};
    let reads=0;
    await expect(prepareCasRevisionResumeLink(
      expected,URL_WITH_SECRETS,()=>true,async()=>{
        reads++;
        return present(reads===1?expected:rival);
      })).rejects.toThrow(/modificata\/eliminata/);
    expect(reads).toBe(2);
  });
  it("refuses if the editor changes during native I/O or crypto boundary",async()=>{
    const expected=src();
    let stableCount=0;
    const read=vi.fn(async()=>present(expected));
    await expect(prepareCasRevisionResumeLink(
      expected,URL_WITH_SECRETS,()=>++stableCount<2,read))
      .rejects.toThrow(/sessione CAS è cambiata/);
    expect(read).toHaveBeenCalledTimes(1);
    stableCount=0;
    await expect(prepareCasRevisionResumeLink(
      expected,URL_WITH_SECRETS,()=>++stableCount<3,read))
      .rejects.toThrow(/sessione CAS è cambiata/);
    expect(read).toHaveBeenCalledTimes(2); // prior first read + second first read
  });
  it("rejects credentials in URL authority and non-web schemes",async()=>{
    const expected=src(),read=vi.fn(async()=>present(expected));
    for(const url of [
      "javascript:alert(1)",
      "file:///tmp/project",
      "https://user:pass@example.test/secret",
    ])await expect(prepareCasRevisionResumeLink(
      expected,url,()=>true,read)).rejects.toThrow(/URL CAS non valido/);
    expect(read).not.toHaveBeenCalled();
  });
  it("fails closed when the readback rejects, including blocked native storage",async()=>{
    const expected=src();
    const read=vi.fn(async():Promise<CasProjectSlot>=>{
      throw Error("NATIVE_IDB_BLOCKED_OR_VERSIONCHANGE_176");
    });
    await expect(prepareCasRevisionResumeLink(
      expected,URL_WITH_SECRETS,()=>true,read))
      .rejects.toThrow(/NATIVE_IDB_BLOCKED/);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
