/** #196/#139 — opt-in, user-authorized LOCAL FORM copy from a verified
 * #194 emergency draft. Deliberately never merges stale snapshots or commits.
 * Callers MUST also re-read native IndexedDB before and after user consent.
 * This module is purely synchronous and has ZERO browser I/O.
 */
import type {FactoryProject,ProjectConfig,StageId}
  from "../domain/types";
import {serializeCasProject} from "../infrastructure/project-cas";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import type {CasUncommittedDraftInspection}
  from "./cas-uncommitted-draft-backup";
import {validateCasIsolatedStackConfig}
  from "./cas-isolated-stack-config";
import {
  CAS_ISOLATED_NAME_MAX,CAS_ISOLATED_DESCRIPTION_MAX,
  CAS_ISOLATED_REQUIREMENTS_MAX,
} from "./cas-isolated-config";
import {CAS_MANUAL_STAGE_MAX_CHARS}
  from "./cas-isolated-manual-stage";
import {CAS_PENDING_PATCH_MAX_REQUEST,CAS_PENDING_PATCH_MAX_JSON}
  from "./cas-isolated-code-patch";
import {STAGES} from "../domain/defaults";

export type CasLocalDraftCopy=Readonly<{
  name:string;description:string;requirements:string;
  stack:ProjectConfig|null;
  manualStage:StageId;manualOutput:string;
  codeRequest:string;codeProposalJson:string;
}>;

function reject():never {
  throw Error("Bozza di emergenza CAS non applicabile ai campi: fonte obsoleta o non valida.");
}

export function prepareCasUncommittedDraftLocalCopy(
  preview:CasUncommittedDraftInspection,
  selected:CasProjectSnapshot,
):CasLocalDraftCopy {
  try{
    // Compare *all three*: an ID alone, matching revision alone or
    // JSON-looking config are never a source match.
    if(!preview || !selected ||
       typeof preview.baseRaw!=="string" ||
       preview.id!==selected.id ||
       preview.revision!==selected.revision ||
       preview.baseRaw!==selected.raw ||
       !Number.isSafeInteger(selected.revision) ||
       selected.revision<1 ||
       selected.revision>=Number.MAX_SAFE_INTEGER ||
       !preview.config ||
       typeof preview.config.name!=="string" ||
       preview.config.name.length>CAS_ISOLATED_NAME_MAX ||
       typeof preview.config.description!=="string" ||
       preview.config.description.length>CAS_ISOLATED_DESCRIPTION_MAX ||
       typeof preview.config.requirements!=="string" ||
       preview.config.requirements.length>CAS_ISOLATED_REQUIREMENTS_MAX ||
       typeof preview.manualOutput!=="string" ||
       preview.manualOutput.length>CAS_MANUAL_STAGE_MAX_CHARS ||
       typeof preview.codeRequest!=="string" ||
       preview.codeRequest.length>CAS_PENDING_PATCH_MAX_REQUEST ||
       typeof preview.codeProposalJson!=="string" ||
       preview.codeProposalJson.length>CAS_PENDING_PATCH_MAX_JSON ||
       !STAGES.some(stage=>stage.id===preview.manualStage) ||
       (preview.stack!==null &&
        !validateCasIsolatedStackConfig(preview.stack)))
      reject();
    const project=JSON.parse(selected.raw) as FactoryProject;
    if(!project || project.id!==selected.id ||
       serializeCasProject(project)!==selected.raw)
      reject();
    return Object.freeze({
      name:preview.config.name,
      description:preview.config.description,
      requirements:preview.config.requirements,
      stack:preview.stack===null?null:structuredClone(preview.stack),
      manualStage:preview.manualStage,
      manualOutput:preview.manualOutput,
      codeRequest:preview.codeRequest,
      codeProposalJson:preview.codeProposalJson,
    });
  }catch{return reject();}
}

/** Pure button preflight; never a database/current-revision assertion. */
export function canCopyCasUncommittedDraftLocally(
  preview:CasUncommittedDraftInspection|null,
  selected:CasProjectSnapshot|null,
  controllerReady:boolean,
  currentFormDirty:boolean,
  busy:boolean,
):boolean {
  if(!preview || !selected || !controllerReady || currentFormDirty || busy)
    return false;
  try{
    prepareCasUncommittedDraftLocalCopy(preview,selected);
    return true;
  }catch{return false;}
}
