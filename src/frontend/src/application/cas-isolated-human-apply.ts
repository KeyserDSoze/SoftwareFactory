/**
 * #169 / #139: human-source transfer of a PENDING Code Agent JSON patch to
 * native CAS overrides. This is expressly NOT independent Code Reviewer
 * approval, runner evidence, tests or GitHub deployment.
 */
import type {FactoryProject} from "../domain/types";
import {STAGES} from "../domain/defaults";
import {
  allowedCodePath,developmentOf,workspaceFiles,
} from "../domain/development";
import {generateFiles} from "./scaffold";
import {inspectCasIsolatedPendingCodePatch,
  inspectCasIsolatedPendingCodeFiles}
  from "./cas-isolated-code-patch";
import {inspectCasIsolatedStages} from "./cas-isolated-stage-inspection";
import {serializeCasProject} from "../infrastructure/project-cas";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";

const SECRET=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/i;
export const CAS_HUMAN_APPLY_MAX_FILES=8;
export const CAS_HUMAN_APPLY_PREVIEW_MAX=1_600;

/** A preview of ALL nontruncated file contents is mandatory, not merely
 * the summary or a conveniently forged 'previous' field.
 */
function checked(snapshot:CasProjectSnapshot):FactoryProject {
  try{
    if(!snapshot || typeof snapshot.id!=="string" ||
       !Number.isSafeInteger(snapshot.revision) || snapshot.revision<1 ||
       typeof snapshot.raw!=="string" || snapshot.raw.length>1_000_000)
      throw Error("Ticket malformed");
    const p=JSON.parse(snapshot.raw) as FactoryProject;
    if(!p || p.id!==snapshot.id ||
       serializeCasProject(p)!==snapshot.raw ||
       !Array.isArray(p.stages) || p.stages.length!==STAGES.length ||
       !inspectCasIsolatedStages(snapshot) ||
       inspectCasIsolatedStages(snapshot)!.some(s=>
         s.status==="invalid" || s.status==="running"))
      throw Error("Stage inconsistent");
    const dev=developmentOf(p);
    if(!p.development || !dev.pending ||
       dev.pending.review!==undefined ||
       dev.pending.repairCount!==undefined ||
       dev.pending.repairTrail!==undefined ||
       dev.pending.repairSession!==undefined ||
       dev.pending.previousProposalId!==undefined ||
       dev.lastRunnerJobId!==undefined ||
       dev.lastRunnerEvidence!==undefined ||
       p.githubDestination!==undefined || p.githubSync!==undefined ||
       p.githubTestReceipt!==undefined ||
       !Number.isSafeInteger(dev.revision) || dev.revision<0 ||
       dev.revision>=Number.MAX_SAFE_INTEGER-1 ||
       dev.pending.revision!==dev.revision ||
       typeof dev.pending.id!=="string" || !dev.pending.id ||
       Object.keys(dev.pending).sort().join(",")!==
         "assumptions,createdAt,edits,id,request,revision,summary,tests" ||
       typeof dev.pending.createdAt!=="string" ||
       !Number.isFinite(Date.parse(dev.pending.createdAt)) ||
       !Array.isArray(dev.pending.tests) || dev.pending.tests.length>15 ||
       dev.pending.tests.some(x=>typeof x!=="string" ||
         x.length>300 || SECRET.test(x)) ||
       !Array.isArray(dev.pending.assumptions) ||
       dev.pending.assumptions.length>15 ||
       dev.pending.assumptions.some(x=>typeof x!=="string" ||
         x.length>300 || SECRET.test(x)) ||
       typeof dev.pending.request!=="string" || !dev.pending.request.trim() ||
       dev.pending.request.length>2_000 || SECRET.test(dev.pending.request) ||
       typeof dev.pending.summary!=="string" ||
       !dev.pending.summary.trim() || dev.pending.summary.length>1_000 ||
       SECRET.test(dev.pending.summary) ||
       !Array.isArray(dev.history) || dev.history.length!==0 ||
       !dev.overrides || Array.isArray(dev.overrides) ||
       typeof dev.overrides!=="object" ||
       !dev.originals || Array.isArray(dev.originals) ||
       typeof dev.originals!=="object")
      throw Error("Unreviewed pending/evidence mismatch");
    const applications=dev.humanApplications??[];
    if(!Array.isArray(applications) || applications.length>24 ||
       new Set(applications.map(r=>r?.id)).size!==applications.length ||
       applications.some(r=>!r ||
         !["operator-unverified","reverted"].includes(r.status) ||
         !Number.isSafeInteger(r.revision) || r.revision<1 ||
         r.revision>dev.revision ||
         typeof r.id!=="string" || !r.id ||
         typeof r.summary!=="string" || !r.summary ||
         r.summary.length>1_000 ||
         typeof r.appliedAt!=="string" ||
         !Number.isFinite(Date.parse(r.appliedAt)) ||
         (r.status==="reverted" ?
           typeof r.revertedAt!=="string" ||
             !Number.isFinite(Date.parse(r.revertedAt)) :
           r.revertedAt!==undefined) ||
         !Array.isArray(r.paths) || r.paths.length<1 ||
         r.paths.length>CAS_HUMAN_APPLY_MAX_FILES ||
         new Set(r.paths).size!==r.paths.length ||
         r.paths.some(path=>!allowedCodePath(path)) ||
         (r.files!==undefined &&
           (!Array.isArray(r.files) ||
            r.files.length!==r.paths.length ||
            r.files.some((f,i)=>!f || f.path!==r.paths[i] ||
              !allowedCodePath(f.path) ||
              (f.before!==null &&
                (typeof f.before!=="string" ||
                 f.before.length>CAS_HUMAN_APPLY_PREVIEW_MAX ||
                 SECRET.test(f.before))) ||
              typeof f.after!=="string" || !f.after.trim() ||
              f.after.length>CAS_HUMAN_APPLY_PREVIEW_MAX ||
              SECRET.test(f.after)))) ||
         SECRET.test(r.summary)) ||
       applications.some(r=>r.id===dev.pending!.id))
      throw Error("Unsafe prior manual applications");
    const before=workspaceFiles(p);  // rejects generator baseline conflicts
    const generated=generateFiles(p);
    const keys=Object.keys(dev.overrides);
    if(keys.length>24 || Object.keys(dev.originals).length!==keys.length ||
       Object.keys(dev.originals).some(k=>!Object.prototype.hasOwnProperty.call(
         dev.overrides,k)) ||
       keys.some(k=>!allowedCodePath(k) ||
         typeof dev.overrides[k]!=="string" ||
         dev.overrides[k].length>32_000 ||
         SECRET.test(dev.overrides[k]) ||
         dev.overrides[k]!==before[k] ||
         dev.originals[k] !== (generated[k]??null)))
      throw Error("Untrusted prior baseline");
    if(!inspectCasIsolatedPendingCodePatch(snapshot) ||
       !Array.isArray(dev.pending.edits) ||
       dev.pending.edits.length<1 ||
       dev.pending.edits.length>CAS_HUMAN_APPLY_MAX_FILES)
      throw Error("Pending schema invalid");
    const preview=inspectCasIsolatedPendingCodeFiles(snapshot);
    if(!preview || preview.length!==dev.pending.edits.length ||
       preview.some(f=>f.beforeTruncated || f.afterTruncated))
      throw Error("Full source preview unavailable or truncated");
    const paths=new Set<string>();
    let total=0;
    for(const edit of dev.pending.edits){
      if(!edit || !allowedCodePath(edit.path) || paths.has(edit.path) ||
         typeof edit.content!=="string" || !edit.content.trim() ||
         edit.content.length>CAS_HUMAN_APPLY_PREVIEW_MAX ||
         typeof edit.reason!=="string" || !edit.reason.trim() ||
         edit.reason.length>500 ||
         edit.previous!== (Object.prototype.hasOwnProperty.call(before,edit.path)
           ?before[edit.path]:null) ||
         (edit.previous!==null &&
           edit.previous.length>CAS_HUMAN_APPLY_PREVIEW_MAX) ||
         edit.content===edit.previous ||
         SECRET.test(edit.content) || SECRET.test(edit.reason) ||
         (edit.previous!==null && SECRET.test(edit.previous)))
        throw Error("Untrusted Code Agent edit");
      paths.add(edit.path);total+=edit.content.length;
    }
    if(total>CAS_HUMAN_APPLY_MAX_FILES*CAS_HUMAN_APPLY_PREVIEW_MAX)
      throw Error("Code Agent aggregate too large");
    return p;
  }catch{
    // Never disclose historical source code or untrusted preview diagnostics
    // through a preflight/button or UI error path.
    throw Error("Patch Code Agent non applicabile: verifica snapshot, sorgenti integrali e backup.");
  }
}

export function canApplyCasIsolatedHumanPendingPatch(
  snapshot:CasProjectSnapshot|null,
):boolean {
  if(!snapshot)return false;
  try{checked(snapshot);return true;}catch{return false;}
}

/** No I/O; controller.commit performs the sole native readwrite CAS. */
export function buildCasIsolatedHumanApplyPendingPatch(
  snapshot:CasProjectSnapshot,
):FactoryProject {
  const project=checked(snapshot),dev=developmentOf(project);
  const patch=dev.pending!;
  const originals={...dev.originals},overrides={...dev.overrides};
  const generated=generateFiles(project);
  for(const edit of patch.edits){
    if(!Object.prototype.hasOwnProperty.call(originals,edit.path))
      originals[edit.path]=generated[edit.path]??null;
    overrides[edit.path]=edit.content;
  }
  const revision=dev.revision+1;
  const next:FactoryProject={...project,
    development:{
      ...dev,revision,overrides,originals,pending:undefined,
      humanApplications:[
        ...(dev.humanApplications??[]),
        {
          id:patch.id,summary:patch.summary,
          appliedAt:new Date().toISOString(),
          revision,paths:patch.edits.map(e=>e.path),
          files:patch.edits.map(e=>({
            path:e.path,before:e.previous,after:e.content,
          })),
          status:"operator-unverified",
        },
      ],
    },
    updatedAt:new Date().toISOString(),
  };
  // Includes generated scaffold conflict checking under actual overrides.
  // Human-only history is NEVER pushed into featureImplementation log.
  workspaceFiles(next);
  serializeCasProject(next);
  return next;
}
