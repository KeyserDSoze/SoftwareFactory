/**
 * #170/#139 — explicit, local-only undo of LAST operator-unverified
 * Code Agent source application. Not a Code Review, build, test or migration.
 * Every source restoration is derived from the pinned native CAS raw and
 * current generated baseline; unknown historical before-images fail closed.
 */
import type {FactoryProject} from "../domain/types";
import {allowedCodePath,developmentOf,workspaceFiles}
  from "../domain/development";
import {generateFiles} from "./scaffold";
import {invalidateStages} from "./pipeline";
import {inspectCasIsolatedStages} from "./cas-isolated-stage-inspection";
import {serializeCasProject} from "../infrastructure/project-cas";
import type {CasProjectSnapshot} from "../infrastructure/project-cas";
import {CAS_HUMAN_APPLY_MAX_FILES,CAS_HUMAN_APPLY_PREVIEW_MAX}
  from "./cas-isolated-human-apply";

const SECRET=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/i;

export type CasIsolatedHumanUndoPreview=Readonly<{
  id:string;revision:number;entryId:string;
  summary:string;
  /** Existing #169 records without full before-images: additions only. */
  legacyAdditionOnly:boolean;
  files:readonly Readonly<{
    path:string;
    /** Exact *current* persisted human override source. */
    current:string;
    /** Exact previously effective source; null means delete new file. */
    restore:string|null;
  }>[];
}>;

function checked(snapshot:CasProjectSnapshot):CasIsolatedHumanUndoPreview {
  try{
    if(!snapshot || typeof snapshot.id!=="string" ||
       !Number.isSafeInteger(snapshot.revision) || snapshot.revision<1 ||
       typeof snapshot.raw!=="string" || snapshot.raw.length>1_000_000)
      throw Error("Malformed CAS ticket");
    const p=JSON.parse(snapshot.raw) as FactoryProject;
    if(!p || p.id!==snapshot.id ||
       serializeCasProject(p)!==snapshot.raw)
      throw Error("Invalid CAS source");
    const inspected=inspectCasIsolatedStages(snapshot);
    if(!inspected || inspected.some(s=>
      s.status==="invalid" || s.status==="running"))
      throw Error("Invalid or in-flight stage");
    const dev=developmentOf(p), apps=dev.humanApplications;
    if(!p.development || !Array.isArray(apps) ||
       apps.length<1 || apps.length>24 ||
       dev.pending!==undefined ||
       !Number.isSafeInteger(dev.revision) ||
       dev.revision<1 || dev.revision>=Number.MAX_SAFE_INTEGER-1 ||
       !Array.isArray(dev.history) || dev.history.length!==0 ||
       dev.lastRunnerEvidence!==undefined ||
       dev.lastRunnerJobId!==undefined ||
       p.githubSync!==undefined || p.githubDestination!==undefined ||
       p.githubTestReceipt!==undefined ||
       !dev.overrides || Array.isArray(dev.overrides) ||
       typeof dev.overrides!=="object" ||
       !dev.originals || Array.isArray(dev.originals) ||
       typeof dev.originals!=="object" ||
       new Set(apps.map(a=>a?.id)).size!==apps.length ||
       apps.some(a=>!a || !a.id || typeof a.id!=="string" ||
         typeof a.summary!=="string" || !a.summary.trim() ||
         a.summary.length>1000 || SECRET.test(a.summary) ||
         !Number.isSafeInteger(a.revision) ||
         a.revision<1 || a.revision>dev.revision ||
         typeof a.appliedAt!=="string" ||
         !Number.isFinite(Date.parse(a.appliedAt)) ||
         !["operator-unverified","reverted"].includes(a.status) ||
         (a.status==="reverted" ?
           typeof a.revertedAt!=="string" ||
             !Number.isFinite(Date.parse(a.revertedAt)) :
           a.revertedAt!==undefined) ||
         !Array.isArray(a.paths) || a.paths.length<1 ||
         a.paths.length>CAS_HUMAN_APPLY_MAX_FILES ||
         new Set(a.paths).size!==a.paths.length ||
         a.paths.some(path=>!allowedCodePath(path))))
      throw Error("Unsafe Code Agent workspace/ledger");
    const last=apps[apps.length-1];
    // Undo only the latest application: no intervening application/revert,
    // patch or remote evidence can be silently rebased on old source.
    if(last.status!=="operator-unverified" ||
       last.revision!==dev.revision)
      throw Error("Undo is not the latest source operation");

    const generated=generateFiles(p);
    const currentFiles=workspaceFiles(p); // includes prior overrides, rejects conflicts
    const overrides=Object.keys(dev.overrides);
    if(overrides.length>24 ||
       overrides.length!==Object.keys(dev.originals).length ||
       Object.keys(dev.originals).some(k=>
         !Object.prototype.hasOwnProperty.call(dev.overrides,k)) ||
       overrides.some(k=>!allowedCodePath(k) ||
         typeof dev.overrides[k]!=="string" ||
         dev.overrides[k].length>32_000 ||
         SECRET.test(dev.overrides[k]) ||
         dev.originals[k] !==
           (Object.prototype.hasOwnProperty.call(generated,k) ?
            generated[k]:null) ||
         currentFiles[k]!==dev.overrides[k]))
      throw Error("Inconsistent applied source baseline");

    const legacy=last.files===undefined;
    if(!legacy && (!Array.isArray(last.files) ||
       last.files.length!==last.paths.length))
      throw Error("Invalid undo before/after records");

    const files=last.paths.map((path,i)=>{
      if(!Object.prototype.hasOwnProperty.call(dev.overrides,path))
        throw Error("Applied file has disappeared");
      const current=dev.overrides[path];
      if(typeof current!=="string" || !current.trim() ||
         current.length>CAS_HUMAN_APPLY_PREVIEW_MAX ||
         SECRET.test(current))
        throw Error("Current source cannot be fully reviewed");
      const baseline=Object.prototype.hasOwnProperty.call(generated,path) ?
        generated[path]:null;
      if(dev.originals[path]!==baseline)
        throw Error("Not original baseline");
      const previousActive=apps.slice(0,-1).reverse()
        .find(app=>app.status==="operator-unverified" &&
          app.paths.includes(path));
      let restore:string|null;
      if(legacy){
        // #169 stored only ID/paths: cannot reconstruct a replacement.
        // Only remove a newly ADDED file never touched in earlier history.
        if(baseline!==null || apps.slice(0,-1).some(app=>
          app.paths.includes(path)))
          throw Error("Legacy overwrite lacks before-image");
        restore=null;
      }else{
        const file=last.files![i];
        if(!file || Object.keys(file).sort().join(",")!==
           "after,before,path" || file.path!==path ||
           typeof file.after!=="string" || file.after!==current ||
           file.after.length>CAS_HUMAN_APPLY_PREVIEW_MAX ||
           (file.before!==null &&
             (typeof file.before!=="string" ||
              !file.before.trim() ||
              file.before.length>CAS_HUMAN_APPLY_PREVIEW_MAX ||
              SECRET.test(file.before))) ||
           file.before===file.after)
          throw Error("Unbound human applied source");
        restore=file.before;
        // If this file was previously manually applied, before-image must
        // match the latest *active* recorded after-image, not an assertion
        // manufactured by a stale/fabricated undo record.
        const actualPrevious=previousActive ?
          previousActive.files?.find(f=>f.path===path)?.after : baseline;
        if(actualPrevious===undefined || restore!==actualPrevious)
          throw Error("Before-image does not match prior source");
      }
      return Object.freeze({path,current,restore});
    });
    return Object.freeze({
      id:snapshot.id,revision:snapshot.revision,entryId:last.id,
      summary:last.summary,legacyAdditionOnly:legacy,
      files:Object.freeze(files),
    });
  }catch{
    // Never echo token/raw, untrusted file source, historical review or
    // provider diagnostics in a user-facing native storage failure.
    throw Error("Undo umano CAS non disponibile: source/baseline/storico non verificabili.");
  }
}

export function prepareCasIsolatedHumanUndo(
  snapshot:CasProjectSnapshot,
):CasIsolatedHumanUndoPreview {
  return checked(snapshot);
}
export function canUndoCasIsolatedHumanPatch(
  snapshot:CasProjectSnapshot|null,
):boolean {
  if(!snapshot)return false;
  try{checked(snapshot);return true;}catch{return false;}
}

/** Pure candidate; caller must backup exact source JSON then commit with IDB
 * revision/raw compare-and-swap. No hidden retry, cloud or legacy fallback. */
export function buildCasIsolatedHumanUndo(
  snapshot:CasProjectSnapshot,
):FactoryProject {
  const ticket=checked(snapshot);
  const source=JSON.parse(snapshot.raw) as FactoryProject;
  const dev=developmentOf(source);
  const generated=generateFiles(source);
  const overrides={...dev.overrides},originals={...dev.originals};
  for(const file of ticket.files){
    const baseline=Object.prototype.hasOwnProperty.call(generated,file.path) ?
      generated[file.path]:null;
    if(file.restore===baseline){
      delete overrides[file.path];
      delete originals[file.path];
    }else{
      if(file.restore===null)throw Error("Missing existing source baseline");
      overrides[file.path]=file.restore;
      originals[file.path]=baseline;
    }
  }
  const applications=dev.humanApplications!.map((entry,i)=>
    i===dev.humanApplications!.length-1 ?
      {...entry,status:"reverted" as const,revertedAt:new Date().toISOString()} :
      entry);
  const next=invalidateStages({
    ...source,development:{
      ...dev,revision:dev.revision+1,
      overrides,originals,humanApplications:applications,
    },
  });
  workspaceFiles(next);
  serializeCasProject(next);
  return next;
}
