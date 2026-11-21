import {afterEach,describe,expect,it,vi} from "vitest";
import {createProject} from "../domain/defaults";
import {
  MAX_CAS_RESTORE_FILE_BYTES, parseCasRestoreBackupFile,
} from "./project-cas-restore-file";

describe("explicit IDB tombstone restore file parsing (#148)",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("accepts exact project raw from IndexedDB/legacy export without changing bytes",()=>{
    const p=createProject(),raw=JSON.stringify(p);
    expect(parseCasRestoreBackupFile(raw)).toEqual({
      id:p.id,name:p.config.name,raw,
    });
  });
  it("accepts the existing v1 local recovery envelope without dropping project data",()=>{
    const p=createProject();
    p.config.name="Recovered historical project";
    const text=JSON.stringify({
      kind:"softwarefactory-local-recovery",schemaVersion:1,
      exportedAt:"2026-11-21T15:00:00.000Z",project:p,
    },null,2);
    expect(parseCasRestoreBackupFile(text)).toEqual({
      id:p.id,name:p.config.name,raw:JSON.stringify(p),
    });
  });
  it("normalizes a formatted raw project into canonical CAS raw",()=>{
    const p=createProject();
    expect(parseCasRestoreBackupFile(JSON.stringify(p,null,2)).raw)
      .toEqual(JSON.stringify(p));
  });
  it("rejects malformed, unknown envelopes and wrong schema with no silent restore",()=>{
    const p=createProject();
    for(const v of ["", "bad", "null", "[]", "{}", JSON.stringify({
      kind:"softwarefactory-local-recovery",schemaVersion:2,
      exportedAt:"2026-11-21T15:00:00.000Z",project:p,
    }),JSON.stringify({kind:"other",schemaVersion:1,project:p}),
    JSON.stringify({kind:"softwarefactory-local-recovery",schemaVersion:1,
      exportedAt:"invalid",project:p})]){
      expect(()=>parseCasRestoreBackupFile(v)).toThrow(/Backup|Formato/);
    }
  });
  it("enforces max file text size and refuses invalid project IDs",()=>{
    expect(()=>parseCasRestoreBackupFile("x".repeat(
      MAX_CAS_RESTORE_FILE_BYTES+1))).toThrow(/troppo grande/);
    const p=createProject();
    expect(()=>parseCasRestoreBackupFile(JSON.stringify({...p,id:"wrong"})))
      .toThrow(/non canonico/);
  });
  it("never interacts with localStorage or IndexedDB during parsing",()=>{
    const unexpected=vi.fn(()=>{throw Error("STORAGE_FORBIDDEN");});
    vi.stubGlobal("indexedDB",{open:unexpected});
    vi.stubGlobal("localStorage",{getItem:unexpected,setItem:unexpected});
    parseCasRestoreBackupFile(JSON.stringify(createProject()));
    expect(unexpected).not.toHaveBeenCalled();
  });
});
