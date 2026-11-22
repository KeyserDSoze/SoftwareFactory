/**
 * #168 / #139 — native CAS stack composer.
 * Pure, fail-closed projection. This may invalidate planned stages, but must
 * NEVER silently rebase pending/applied Code Agent code, runner/test evidence
 * or published GitHub bindings onto a new generated scaffold.
 */
import type {FactoryProject,ProjectConfig} from "../domain/types";
import {DEFAULT_CONFIG,SERVICE_KINDS,SERVICE_OPTIONS,STAGES,updateConfig}
  from "../domain/defaults";
import {serializeCasProject} from "../infrastructure/project-cas";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {invalidateStages} from "./pipeline";
import {inspectCasIsolatedStages} from "./cas-isolated-stage-inspection";
import {
  CAS_ISOLATED_NAME_MAX,CAS_ISOLATED_DESCRIPTION_MAX,
  CAS_ISOLATED_REQUIREMENTS_MAX,
} from "./cas-isolated-config";

const FRONTENDS=["react","react-native","android","ios","unity"];
const DEPLOYMENTS=["azure","aws","gcp","kubernetes","docker"];
const DATABASES=["postgresql","sqlserver","mysql","sqlite"];
const VERSION=["11.0","10.0"];
const KEYS=Object.keys(DEFAULT_CONFIG).sort().join(",");
const SERVICES=SERVICE_KINDS.slice().sort().join(",");
const SECRET=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/i;

export function validateCasIsolatedStackConfig(value:unknown):value is ProjectConfig {
  if(!value || typeof value!=="object" || Array.isArray(value))return false;
  const c=value as ProjectConfig;
  try{
    if(Object.keys(c).sort().join(",")!==KEYS ||
       typeof c.name!=="string" || !c.name.trim() ||
       c.name.length>CAS_ISOLATED_NAME_MAX ||
       typeof c.description!=="string" ||
       c.description.length>CAS_ISOLATED_DESCRIPTION_MAX ||
       typeof c.requirements!=="string" ||
       c.requirements.length>CAS_ISOLATED_REQUIREMENTS_MAX ||
       !Array.isArray(c.frontends) || c.frontends.length<1 ||
       c.frontends.length>FRONTENDS.length ||
       new Set(c.frontends).size!==c.frontends.length ||
       c.frontends.some(x=>!FRONTENDS.includes(x)) ||
       !DEPLOYMENTS.includes(c.deployment) ||
       !VERSION.includes(c.dotnetVersion) ||
       !DATABASES.includes(c.database) ||
       !c.services || typeof c.services!=="object" ||
       Array.isArray(c.services) ||
       Object.keys(c.services).sort().join(",")!==SERVICES ||
       SERVICE_KINDS.some(kind=>{
         const binding=c.services[kind];
         return !binding || typeof binding!=="object" ||
           Array.isArray(binding) ||
           Object.keys(binding).sort().join(",")!==
             "development,production" ||
           !SERVICE_OPTIONS[kind].includes(binding.development) ||
           !SERVICE_OPTIONS[kind].includes(binding.production);
       }) || SECRET.test(JSON.stringify(c)))return false;
    return true;
  }catch{return false;}
}

function canonical(snapshot:CasProjectSnapshot):FactoryProject {
  try{
    if(!snapshot || !Number.isSafeInteger(snapshot.revision) ||
       snapshot.revision<1 || snapshot.revision>Number.MAX_SAFE_INTEGER-1 ||
       typeof snapshot.raw!=="string" || !snapshot.raw ||
       snapshot.raw.length>1_000_000)
      throw Error("Invalid CAS ticket");
    const project=JSON.parse(snapshot.raw) as FactoryProject;
    if(!project || project.id!==snapshot.id ||
       serializeCasProject(project)!==snapshot.raw ||
       !validateCasIsolatedStackConfig(project.config))
      throw Error("Invalid CAS source/config");
    const stages=inspectCasIsolatedStages(snapshot);
    if(!stages || stages.length!==STAGES.length ||
       stages.some(s=>s.status==="invalid" || s.status==="running"))
      throw Error("Unstable/inconsistent source stage");
    return project;
  }catch{
    throw Error("Snapshot/configurazione IndexedDB non validi o stage in esecuzione.");
  }
}

/** Null for a historical malformed or incomplete config. No storage I/O. */
export function readCasIsolatedStackConfig(
  snapshot:CasProjectSnapshot|null,
):ProjectConfig|null {
  if(!snapshot)return null;
  try{return structuredClone(canonical(snapshot).config);}
  catch{return null;}
}

/** Compares ONLY stack fields, not the textual name/description/requirements. */
export function hasCasIsolatedStackDraft(
  snapshot:CasProjectSnapshot|null,draft:ProjectConfig|null,
):boolean {
  if(!snapshot || !draft)return false;
  try{
    const c=canonical(snapshot).config;
    return JSON.stringify({
      frontends:c.frontends,deployment:c.deployment,
      dotnetVersion:c.dotnetVersion,database:c.database,services:c.services,
    })!==JSON.stringify({
      frontends:draft.frontends,deployment:draft.deployment,
      dotnetVersion:draft.dotnetVersion,database:draft.database,
      services:draft.services,
    });
  }catch{return true;}
}

/**
 * A full stack change carries only current text form fields and selected
 * stack fields. Reject any other unreviewed/published mutable evidence.
 * Caller downloads the exact historical raw before native controller.commit.
 */
export function buildCasIsolatedStackConfigEdit(
  expected:CasProjectSnapshot,draft:ProjectConfig,
):FactoryProject {
  const original=canonical(expected);
  if(!validateCasIsolatedStackConfig(draft))
    throw Error("Stack IndexedDB non valido: scegli frontend, servizi e valori consentiti.");
  if(original.development!==undefined ||
     original.githubDestination!==undefined ||
     original.githubSync!==undefined ||
     original.githubTestReceipt!==undefined)
    throw Error("Stack bloccato: Code Agent, runner o GitHub già collegati. Duplica prima SOLO la configurazione.");
  if(JSON.stringify(original.config)===JSON.stringify(draft))
    throw Error("Nessuna modifica IndexedDB da salvare.");
  const candidate=invalidateStages(updateConfig(original,structuredClone(draft)));
  // Pipeline checkpoints and origin claims never follow a changed stack.
  if(candidate.stages.some(stage=>stage.status!=="pending" ||
     stage.output!=="" || stage.sources.length>0 ||
     stage.completionOrigin!==undefined))
    throw Error("Invalida prima i checkpoint IndexedDB.");
  serializeCasProject(candidate);
  return candidate;
}
