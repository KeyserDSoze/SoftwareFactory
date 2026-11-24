/** #194/#139 — strictly offline emergency export of unsaved CAS-only drafts.
 * Neither the pinned IDB RAW nor the unsaved user text is a current CAS ACK.
 * This is NOT an import/restore format, a cloud sync or verified evidence.
 * In particular, no FactorySettings/credentials are accepted as inputs.
 */
import {STAGES} from "../domain/defaults";
import type {FactoryProject,ProjectConfig,StageId} from "../domain/types";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {serializeCasProject} from "../infrastructure/project-cas";
import {
  CAS_ISOLATED_NAME_MAX,CAS_ISOLATED_DESCRIPTION_MAX,
  CAS_ISOLATED_REQUIREMENTS_MAX,
} from "./cas-isolated-config";
import {hasCasIsolatedUnsavedDraft} from "./cas-isolated-draft";
import {
  hasCasIsolatedStackDraft,validateCasIsolatedStackConfig,
} from "./cas-isolated-stack-config";
import {CAS_MANUAL_STAGE_MAX_CHARS} from "./cas-isolated-manual-stage";
import {CAS_PENDING_PATCH_MAX_JSON,CAS_PENDING_PATCH_MAX_REQUEST}
  from "./cas-isolated-code-patch";

export const MAX_CAS_UNCOMMITTED_DRAFT_FILE_BYTES=6_000_000;
const MAX_REVISION=Number.MAX_SAFE_INTEGER-1;
export const CAS_UNCOMMITTED_DRAFT_FORMAT="softwarefactory-cas-uncommitted-draft";

export type CasUncommittedDraftInput=Readonly<{
  snapshot:CasProjectSnapshot;
  name:string;description:string;requirements:string;
  stack:ProjectConfig|null;
  manualStage:StageId;manualOutput:string;
  codeRequest:string;codeProposalJson:string;
}>;
export type CasUncommittedDraftBackup=Readonly<{
  fileName:string;raw:string;
}>;

function invalid():never {
  // Never expose raw user text, old AI checkpoints or provider credentials.
  throw Error("Bozza CAS non esportabile: dati non canonici o oltre limite.");
}

/** Synchronous, no IndexedDB read required — works even if a CAS writer is
 * blocked, quota-exhausted, stale or the browser cannot reopen the DB.
 * Nothing mutates the selection, stages or the stored CAS revision.
 */
export function prepareCasUncommittedDraftBackup(
  input:CasUncommittedDraftInput,
):CasUncommittedDraftBackup {
  try {
    if(!input || !input.snapshot ||
       !Number.isSafeInteger(input.snapshot.revision) ||
       input.snapshot.revision<1 || input.snapshot.revision>MAX_REVISION ||
       typeof input.snapshot.raw!=="string" ||
       input.snapshot.raw.length>1_000_000 ||
       typeof input.name!=="string" ||
       input.name.length>CAS_ISOLATED_NAME_MAX ||
       typeof input.description!=="string" ||
       input.description.length>CAS_ISOLATED_DESCRIPTION_MAX ||
       typeof input.requirements!=="string" ||
       input.requirements.length>CAS_ISOLATED_REQUIREMENTS_MAX ||
       typeof input.manualOutput!=="string" ||
       input.manualOutput.length>CAS_MANUAL_STAGE_MAX_CHARS ||
       typeof input.codeRequest!=="string" ||
       input.codeRequest.length>CAS_PENDING_PATCH_MAX_REQUEST ||
       typeof input.codeProposalJson!=="string" ||
       input.codeProposalJson.length>CAS_PENDING_PATCH_MAX_JSON ||
       !STAGES.some(stage=>stage.id===input.manualStage) ||
       (input.stack!==null && !validateCasIsolatedStackConfig(input.stack)))
      invalid();
    const project=JSON.parse(input.snapshot.raw) as FactoryProject;
    if(!project || project.id!==input.snapshot.id ||
       serializeCasProject(project)!==input.snapshot.raw)
      invalid();
    const unsaved=hasCasIsolatedUnsavedDraft(input.snapshot,
      input.name,input.description,input.requirements) ||
      hasCasIsolatedStackDraft(input.snapshot,input.stack) ||
      input.manualOutput.length>0 || input.codeRequest.length>0 ||
      input.codeProposalJson.length>0;
    if(!unsaved)invalid();
    const raw=JSON.stringify({
      format:CAS_UNCOMMITTED_DRAFT_FORMAT,
      schemaVersion:1,
      authoritative:false,
      automaticRestore:false,
      uncommitted:true,
      warning:"PLAINTEXT emergency copy. The base revision may be STALE; draft text was NEVER committed. May contain sensitive user text or historical unverified AI/runner/GitHub data. Manual inspection only; NOT an IndexedDB restore, sync, test or review attestation.",
      base:{
        id:input.snapshot.id,revision:input.snapshot.revision,
        raw:input.snapshot.raw,
      },
      draft:{
        config:{
          name:input.name,description:input.description,
          requirements:input.requirements,
        },
        stack:input.stack,
        manualStage:input.manualStage,
        manualOutput:input.manualOutput,
        codeRequest:input.codeRequest,
        codeProposalJson:input.codeProposalJson,
      },
    },null,2);
    if(!raw || new TextEncoder().encode(raw).byteLength>MAX_CAS_UNCOMMITTED_DRAFT_FILE_BYTES)
      invalid();
    return Object.freeze({
      fileName:"softwarefactory-cas-uncommitted-draft-"+
        input.snapshot.id+"-r"+input.snapshot.revision+".json",
      raw,
    });
  }catch{return invalid();}
}

/** #195: inert projection of the EXACT canonical JSON emitted by #194.
 * Re-uses the original export validator but never calls a storage API,
 * controller, provider or network. No byte signature / authorship proof:
 * a manually recreated canonical file remains untrusted.
 */
export type CasUncommittedDraftInspection=Readonly<{
  id:string;revision:number;originalName:string;
  config:Readonly<{name:string;description:string;requirements:string}>;
  stack:ProjectConfig|null;manualStage:StageId;manualOutput:string;
  codeRequest:string;codeProposalJson:string;
}>;
function exactKeys(value:unknown,expected:string):boolean {
  return Boolean(value && typeof value==="object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",")===expected);
}
export function inspectCasUncommittedDraftBackup(
  raw:string,
):CasUncommittedDraftInspection {
  try {
    if(typeof raw!=="string" || !raw ||
       new TextEncoder().encode(raw).byteLength>
         MAX_CAS_UNCOMMITTED_DRAFT_FILE_BYTES)invalid();
    const envelope=JSON.parse(raw) as Record<string,unknown>;
    if(!exactKeys(envelope,
         "authoritative,automaticRestore,base,draft,format,schemaVersion,uncommitted,warning") ||
       envelope.format!==CAS_UNCOMMITTED_DRAFT_FORMAT ||
       envelope.schemaVersion!==1 ||
       envelope.authoritative!==false ||
       envelope.automaticRestore!==false ||
       envelope.uncommitted!==true ||
       !exactKeys(envelope.base,"id,raw,revision") ||
       !exactKeys(envelope.draft,
         "codeProposalJson,codeRequest,config,manualOutput,manualStage,stack"))
      invalid();
    const base=envelope.base as Record<string,unknown>;
    const draft=envelope.draft as Record<string,unknown>;
    if(!exactKeys(draft.config,"description,name,requirements"))
      invalid();
    const config=draft.config as Record<string,unknown>;
    const input:CasUncommittedDraftInput={
      snapshot:base as CasProjectSnapshot,
      name:config.name as string,
      description:config.description as string,
      requirements:config.requirements as string,
      stack:draft.stack as ProjectConfig|null,
      manualStage:draft.manualStage as StageId,
      manualOutput:draft.manualOutput as string,
      codeRequest:draft.codeRequest as string,
      codeProposalJson:draft.codeProposalJson as string,
    };
    // This is also a strict canonical text check: no duplicated JSON keys,
    // injected fields, adjusted flags, warning rewording or changed order.
    // Users must inspect changed/recreated files manually; no signature.
    if(prepareCasUncommittedDraftBackup(input).raw!==raw)invalid();
    const source=JSON.parse(input.snapshot.raw) as FactoryProject;
    return Object.freeze({
      id:input.snapshot.id,
      revision:input.snapshot.revision,
      originalName:source.config.name,
      config:Object.freeze({name:input.name,
        description:input.description,requirements:input.requirements}),
      stack:input.stack===null?null:structuredClone(input.stack),
      manualStage:input.manualStage,
      manualOutput:input.manualOutput,
      codeRequest:input.codeRequest,
      codeProposalJson:input.codeProposalJson,
    });
  }catch{return invalid();}
}
