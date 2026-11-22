import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {
  casStorageFaultCode,CasStorageFault,nativeCasStorageFault,
} from "./project-cas-storage-fault";
import {
  compareAndSwapCasProject,readCasProject,listCasProjects,
} from "./project-cas";

describe("native IndexedDB storage diagnostics (#160)",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("recognizes only native operation names without exposing text",()=>{
    const error=new DOMException("SECRET_NATIVE_BROWSER_DETAILS","VersionError");
    const result=nativeCasStorageFault(error);
    expect(result).toBeInstanceOf(CasStorageFault);
    expect(casStorageFaultCode(result)).toBe("upgrade");
    expect(String(result)).not.toContain("SECRET_NATIVE_BROWSER_DETAILS");
    expect(casStorageFaultCode(nativeCasStorageFault(
      {name:"QuotaExceededError",message:"SECRET_QUOTA_CONTENT"}))).toBe("quota");
    expect(nativeCasStorageFault({name:"ConstraintError",message:"SECRET"}))
      .toBeNull();
    expect(nativeCasStorageFault("QuotaExceededError")).toBeNull();
    expect(casStorageFaultCode(Error("quota"))).toBeNull();
  });
  it("refuses unsupported storage without localStorage fallback",async()=>{
    const writes=vi.fn();
    vi.stubGlobal("indexedDB",undefined);
    vi.stubGlobal("localStorage",{setItem:writes,getItem:writes});
    const p=createProject();
    for(const action of [
      readCasProject(p.id),listCasProjects(),compareAndSwapCasProject(p,null),
    ]){
      await expect(action).rejects.toMatchObject({code:"unsupported"});
    }
    expect(writes).not.toHaveBeenCalled();
  });
  it("classifies native VersionError on open and scrubs native message",async()=>{
    vi.stubGlobal("indexedDB",{
      open:()=>({onerror:null,onblocked:null,onupgradeneeded:null,
        onsuccess:null,error:null}),
    });
    const indexedDB=globalThis.indexedDB as unknown as {
      open:(name:string,version:number)=>Record<string,unknown>;
    };
    const open=vi.spyOn(indexedDB,"open").mockImplementation(()=>{
      const req:{onerror:()=>void;error:unknown}={
        onerror:()=>{},error:new DOMException("SECRET_NEW_SCHEMA","VersionError"),
      };
      queueMicrotask(()=>req.onerror());
      return req as never;
    });
    await expect(listCasProjects()).rejects.toMatchObject({code:"upgrade"});
    expect(open).toHaveBeenCalled();
  });
});
