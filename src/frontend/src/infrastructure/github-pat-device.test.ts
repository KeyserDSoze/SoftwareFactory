import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSecret, saveSecret } from "./store";
import {
  deviceHasGithubPat, forgetGithubPatOnDevice,
  saveGithubPatOnDevice, unlockGithubPatOnDevice,
} from "./github-pat-device";

/** Minimal IndexedDB transaction mock; exercises the real WebCrypto key and
 * ciphertext path without changing dependencies or storing a plaintext stub. */
function mockIndexedDb() {
  const rows=new Map<string,unknown>();
  let initialized=false;
  const db={
    objectStoreNames:{contains:(key:string)=>initialized&&key==="private"},
    createObjectStore: (_key:string)=>{initialized=true;return {};},
    close: ()=>{},
    transaction: (_name:string,_mode:string) => {
      const tx: {oncomplete?:()=>void;onerror?:()=>void;onabort?:()=>void;
        objectStore:(name:string)=>Record<string,(...args:unknown[])=>unknown>} = {
        objectStore: () => ({
          get: (key:unknown) => {
            const request: {result?:unknown;onsuccess?:()=>void;onerror?:()=>void}={};
            queueMicrotask(()=>{request.result=rows.get(String(key));request.onsuccess?.();});
            return request;
          },
          put: (value:unknown,key:unknown) => {
            queueMicrotask(()=>{rows.set(String(key),value);tx.oncomplete?.();});
          },
          add: (value:unknown,key:unknown) => {
            queueMicrotask(()=>{
              if(rows.has(String(key))) {tx.onabort?.();return;}
              rows.set(String(key),value);tx.oncomplete?.();
            });
          },
          delete: (key:unknown) => {
            queueMicrotask(()=>{rows.delete(String(key));tx.oncomplete?.();});
          },
        }),
      };
      return tx;
    },
  };
  vi.stubGlobal("indexedDB",{
    open: () => {
      const req: {result:typeof db;onupgradeneeded?:()=>void;
        onsuccess?:()=>void;onerror?:()=>void;onblocked?:()=>void}={result:db};
      queueMicrotask(()=>{if(!initialized)req.onupgradeneeded?.();req.onsuccess?.();});
      return req;
    },
  });
  return rows;
}
describe("encrypted device PAT persistence",()=>{
  beforeEach(()=>{
    const session=new Map<string,string>();
    vi.stubGlobal("sessionStorage",{
      getItem:(key:string)=>session.get(key)??null,
      setItem:(key:string,value:string)=>{session.set(key,value);},
      removeItem:(key:string)=>{session.delete(key);},
    });
  });
  afterEach(()=>vi.unstubAllGlobals());
  it("saves only ciphertext and nonextractable key, unlocks and erases without plaintext fallback",async()=>{
    const rows=mockIndexedDb();
    const pat="github_pat_"+ "p".repeat(50);
    await saveGithubPatOnDevice(pat);
    expect(await deviceHasGithubPat()).toBe(true);
    expect(readSecret("github.pat")).toBe(pat);
    expect((rows.get("device-key") as CryptoKey).extractable).toBe(false);
    expect(JSON.stringify(rows.get("github-pat"))).not.toContain(pat);
    saveSecret("github.pat","");
    expect(await unlockGithubPatOnDevice()).toBe(true);
    expect(readSecret("github.pat")).toBe(pat);
    await forgetGithubPatOnDevice();
    expect(readSecret("github.pat")).toBe("");
    expect(await deviceHasGithubPat()).toBe(false);
    expect(await unlockGithubPatOnDevice()).toBe(false);
  });
  it("fails closed without IndexedDB instead of writing plaintext storage",async()=>{
    vi.stubGlobal("indexedDB",undefined);
    await expect(saveGithubPatOnDevice("github_pat_"+"q".repeat(50))).rejects.toThrow(/IndexedDB/);
    expect(readSecret("github.pat")).toBe("");
  });
});
