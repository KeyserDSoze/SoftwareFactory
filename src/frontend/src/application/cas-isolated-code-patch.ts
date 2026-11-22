/**
 * Opt-in IndexedDB CAS pending Code Agent proposal (#162/#139).
 * Human-submitted JSON is validated by the existing domain patch allowlist.
 * This does NOT contact a provider, execute code, review, test, approve,
 * publish, or update the synchronous live Factory/CodeAgentPanel.
 */
import {STAGES} from "../domain/defaults";
import type {FactoryProject} from "../domain/types";
import {allowedCodePath,developmentOf,rejectPending,setPending,validateProposal,workspaceFiles} from "../domain/development";
import {serializeCasProject} from "../infrastructure/project-cas";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";

export const CAS_PENDING_PATCH_MAX_JSON=145_000;
export const CAS_PENDING_PATCH_MAX_REQUEST=2_000;
const STATUSES=new Set(["pending","running","complete","failed"]);
const ORIGINS=new Set(["manual","ai"]);
// Reject recognizable token/private key sequences anywhere in operator JSON
// (including reasons, summary, tests and assumptions), not just edit.content.
const SECRET_PATTERN=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/i;

function strict(snapshot:CasProjectSnapshot):FactoryProject {
  try{
    if(!snapshot || !Number.isSafeInteger(snapshot.revision) ||
       snapshot.revision<1 || typeof snapshot.raw!=="string")
      throw Error("token");
    const p=JSON.parse(snapshot.raw) as FactoryProject;
    if(!p || p.id!==snapshot.id ||
       serializeCasProject(p)!==snapshot.raw ||
       !Array.isArray(p.stages) || p.stages.length!==STAGES.length ||
       p.stages.some((s,i)=>!s || s.id!==STAGES[i].id ||
         typeof s.label!=="string" || !STATUSES.has(s.status) ||
         typeof s.output!=="string" || !Array.isArray(s.sources) ||
         (s.error!==undefined && typeof s.error!=="string") ||
         (s.completionOrigin!==undefined &&
           (!ORIGINS.has(s.completionOrigin) || s.status!=="complete"))))
      throw Error("stage");
    return p;
  }catch{
    throw Error("Snapshot CAS per Code Agent non canonico: nessuna scrittura.");
  }
}

/** Prepare a single pending patch candidate without any I/O. */
export function buildCasIsolatedPendingCodePatch(
  snapshot:CasProjectSnapshot,request:string,proposalJson:string,
):FactoryProject {
  if(typeof request!=="string" || !request.trim() ||
     request.length>CAS_PENDING_PATCH_MAX_REQUEST ||
     typeof proposalJson!=="string" || !proposalJson.trim() ||
     proposalJson.length>CAS_PENDING_PATCH_MAX_JSON)
    throw Error("Richiesta/JSON patch IndexedDB vuoti o troppo grandi.");
  if(SECRET_PATTERN.test(request) || SECRET_PATTERN.test(proposalJson))
    throw Error("Possibile credenziale nel JSON Code Agent: proposta rifiutata.");
  const project=strict(snapshot);
  if(developmentOf(project).pending)
    throw Error("Esiste già una proposta Code Agent pending: non sovrascrivere.");
  // validateProposal enforces the existing generated-scaffold baseline,
  // edit allowlist, full replacements, 1..8 files, per-file/aggregate limits,
  // no duplicates and no secrets embedded in file contents.
  const proposal=validateProposal(proposalJson,project,request);
  if(proposal.review!==undefined || proposal.repairCount!==undefined ||
     proposal.repairTrail!==undefined || proposal.repairSession!==undefined)
    throw Error("Non importare attestazioni di review/repair nel pending.");
  const next=setPending(project,proposal);
  // Do not fabricate runner/job evidence nor mark a proposal applied.
  serializeCasProject(next);
  return next;
}

export type CasPendingCodePreview=Readonly<{
  summary:string;revision:number;editCount:number;
  status:"unreviewed"|"review_unverified";
}>;

/** Read-only bounded inspector for the currently pinned copy. Existing
 * historical AI review is never independently attested by this view.
 */
export function inspectCasIsolatedPendingCodePatch(
  snapshot:CasProjectSnapshot|null,
):CasPendingCodePreview|null {
  if(!snapshot)return null;
  try{
    const p=strict(snapshot);
    const dev=developmentOf(p),patch=dev.pending;
    if(!patch)return null;
    if(typeof patch.summary!=="string" ||
       patch.summary.length>1_000 || !patch.summary.trim() ||
       !Array.isArray(patch.edits) ||
       patch.edits.length<1 || patch.edits.length>8 ||
       !Number.isSafeInteger(patch.revision) ||
       patch.revision!==dev.revision)
      return null;
    return Object.freeze({
      summary:patch.summary.slice(0,1_000),
      revision:patch.revision,
      editCount:patch.edits.length,
      status:patch.review===undefined?"unreviewed":"review_unverified",
    });
  }catch{return null;}
}

export function canStageCasIsolatedCodePatch(
  snapshot:CasProjectSnapshot|null,request:string,proposalJson:string,
):boolean {
  if(!snapshot)return false;
  // Deliberately does not invoke validateProposal: that creates random IDs
  // and timestamps every render. Button validation remains a cheap, pure
  // read-only preflight; commit repeats COMPLETE validation after the click.
  try{
    if(!request.trim() || request.length>CAS_PENDING_PATCH_MAX_REQUEST ||
       !proposalJson.trim() || proposalJson.length>CAS_PENDING_PATCH_MAX_JSON ||
       SECRET_PATTERN.test(request) || SECRET_PATTERN.test(proposalJson))
      return false;
    const p=strict(snapshot);
    return !developmentOf(p).pending;
  }catch{return false;}
}

/** #163: only an unreviewed, unrepaired human CAS pending may be discarded. */
function discardableCasPending(snapshot:CasProjectSnapshot):FactoryProject {
  const project=strict(snapshot);
  const view=inspectCasIsolatedPendingCodePatch(snapshot);
  const pending=developmentOf(project).pending;
  if(!view || view.status!=="unreviewed" || !pending ||
     typeof pending.id!=="string" || !pending.id ||
     typeof pending.request!=="string" || !pending.request.trim() ||
     pending.repairCount!==undefined || pending.repairTrail!==undefined ||
     pending.repairSession!==undefined)
    throw Error("Pending Code Agent IndexedDB non scartabile: nessuna scrittura.");
  return project;
}
export function buildCasIsolatedDiscardPendingCodePatch(
  snapshot:CasProjectSnapshot,
):FactoryProject {
  const next=rejectPending(discardableCasPending(snapshot));
  serializeCasProject(next);
  return next;
}
export function canDiscardCasIsolatedPendingCodePatch(
  snapshot:CasProjectSnapshot|null,
):boolean {
  if(!snapshot)return false;
  try{discardableCasPending(snapshot);return true;}catch{return false;}
}

/** #164: inert, source-bound read-only projection for the opt-in CAS editor.
 * Human-supplied `previous` is NOT evidence: recompute the current scaffold +
 * approved overrides and refuse mismatches before revealing any excerpts.
 * No writes, network, external review, or executable diff rendering.
 */
export const CAS_CODE_FILE_PREVIEW_CHARS=1_600;
export type CasPendingCodeFilePreview=Readonly<{
  path:string;reason:string;
  before:string;after:string;
  beforeMissing:boolean;
  beforeTruncated:boolean;afterTruncated:boolean;
}>;

export function inspectCasIsolatedPendingCodeFiles(
  snapshot:CasProjectSnapshot|null,
):readonly CasPendingCodeFilePreview[]|null {
  if(!snapshot)return null;
  try{
    const project=strict(snapshot);
    const dev=developmentOf(project),patch=dev.pending;
    if(!patch || !inspectCasIsolatedPendingCodePatch(snapshot) ||
       !Number.isSafeInteger(dev.revision) || dev.revision<0 ||
       patch.revision!==dev.revision ||
       !Array.isArray(patch.edits) ||
       patch.edits.length<1 || patch.edits.length>8) return null;
    const baseline=workspaceFiles(project);
    const paths=new Set<string>();
    let total=0;
    const files=patch.edits.map(edit=>{
      if(!edit || !allowedCodePath(edit.path) || paths.has(edit.path) ||
         typeof edit.reason!=="string" || !edit.reason.trim() ||
         edit.reason.length>500 ||
         typeof edit.content!=="string" || !edit.content.trim() ||
         edit.content.length>32_000 ||
         (edit.previous!==null && (
           typeof edit.previous!=="string" || edit.previous.length>250_000)))
        throw Error("Untrusted patch edit");
      paths.add(edit.path);
      total+=edit.content.length;
      if(total>85_000 || SECRET_PATTERN.test(edit.content) ||
         SECRET_PATTERN.test(edit.reason) ||
         (edit.previous!==null && SECRET_PATTERN.test(edit.previous)))
        throw Error("Untrusted patch content");
      const actual=Object.prototype.hasOwnProperty.call(baseline,edit.path)
        ? baseline[edit.path] : null;
      if(actual!==edit.previous || actual===edit.content)
        throw Error("Stale or no-op proposed source");
      return Object.freeze({
        path:edit.path,
        reason:edit.reason,
        before:actual===null?"":actual.slice(0,CAS_CODE_FILE_PREVIEW_CHARS),
        after:edit.content.slice(0,CAS_CODE_FILE_PREVIEW_CHARS),
        beforeMissing:actual===null,
        beforeTruncated:actual!==null &&
          actual.length>CAS_CODE_FILE_PREVIEW_CHARS,
        afterTruncated:edit.content.length>CAS_CODE_FILE_PREVIEW_CHARS,
      });
    });
    return Object.freeze(files);
  }catch{
    // Stored content and dynamic scaffold generator diagnostics are untrusted.
    // The view is unavailable, never a reason to erase or rewrite the pending.
    return null;
  }
}
