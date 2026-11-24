/**
 * Opt-in CAS-only scratch editor (#149). This is intentionally NOT the active
 * Factory editor and does not import/migrate its write paths. No projectRef,
 * live setProject, localStorage, GitHub or cloud operations are reachable here.
 */
import {useEffect,useMemo,useRef,useState} from "react";
import {matchesCasHandoffHint} from "../application/cas-root-workspace";
import {prepareCasRevisionResumeLink} from "../application/cas-revision-resume";
import {prepareCasExternalConfigImport,confirmCasExternalConfigImport}
  from "../application/cas-external-config-import";
import {prepareCasIsolatedTombstoneRestore,confirmCasIsolatedTombstoneRestore}
  from "../application/cas-isolated-tombstone-restore";
import {MAX_CAS_RESTORE_FILE_BYTES} from "../infrastructure/project-cas-restore-file";
import type {CasRevisionResumeLink} from "../application/cas-revision-resume";
import type {CasHandoffHint} from "../application/cas-root-workspace";
import {strToU8,zipSync} from "fflate";
import {STAGES,SERVICE_KINDS,SERVICE_LABELS,SERVICE_OPTIONS} from "../domain/defaults";
import type {FactoryProject,FactorySettings,StageId,ProjectConfig,
  FrontendKind,DeploymentTarget,EnvironmentName}
  from "../domain/types";
import {runStage} from "../application/pipeline";
import {resolveAgentRoute,stageAgentRole} from "../domain/agent-roles";
import {validateAiEndpoint} from "../infrastructure/ai";
import {casStorageFaultCode} from "../infrastructure/project-cas-storage-fault";
import {
  openCasPipelineSession,canBeginCasPipelineStage,
} from "../application/cas-pipeline-session";
import type {FactoryLocale} from "../i18n";
import {t} from "../i18n";
import type {CasProjectChoice,CasProjectSnapshot} from "../infrastructure/project-cas";
import {
  listCasProjects,listCasTombstones,readCasProject,readCasLibraryBackupSnapshot,
} from "../infrastructure/project-cas";
import type {CasProjectTombstone} from "../infrastructure/project-cas";
import {
  prepareCasIsolatedNewProject,confirmCasIsolatedNewProject,
  verifyCasIsolatedCreatedReadback,
} from "../application/cas-isolated-create";
import {
  prepareCasIsolatedConfigFork,confirmCasIsolatedConfigFork,
} from "../application/cas-isolated-config-fork";
import {
  openCasSelectionController,type CasSelectionController,
} from "../infrastructure/project-cas-selection";
import {
  buildCasIsolatedConfigEdit,CAS_ISOLATED_NAME_MAX,
  CAS_ISOLATED_DESCRIPTION_MAX,CAS_ISOLATED_REQUIREMENTS_MAX,
} from "../application/cas-isolated-config";
import {prepareCasIsolatedDelete} from "../application/cas-isolated-delete";
import {
  buildCasIsolatedStackConfigEdit,readCasIsolatedStackConfig,
  hasCasIsolatedStackDraft,
} from "../application/cas-isolated-stack-config";
import {hasCasIsolatedUnsavedDraft} from "../application/cas-isolated-draft";
import {prepareCasFailedWriteTicket,inspectCasFailedWrite,
  prepareCasFailedWriteBackup}
  from "../application/cas-failed-write-diagnosis";
import type {CasFailedWriteTicket,CasFailedWriteObservation,
  CasFailedWriteBackupContext}
  from "../application/cas-failed-write-diagnosis";
import type {CasPipelineFailedWrite,CasPipelineRunTicket,CasPipelineSession}
  from "../application/cas-pipeline-session";
import {
  prepareCasUncommittedDraftBackup,inspectCasUncommittedDraftBackup,
  MAX_CAS_UNCOMMITTED_DRAFT_FILE_BYTES,
} from "../application/cas-uncommitted-draft-backup";
import type {CasUncommittedDraftInspection}
  from "../application/cas-uncommitted-draft-backup";
import {
  canCopyCasUncommittedDraftLocally,prepareCasUncommittedDraftLocalCopy,
} from "../application/cas-uncommitted-draft-local-copy";
import {inspectCasIsolatedStages} from "../application/cas-isolated-stage-inspection";
import {
  buildCasIsolatedManualStage,canCommitCasIsolatedManualStage,
  CAS_MANUAL_STAGE_MAX_CHARS,
} from "../application/cas-isolated-manual-stage";
import {
  buildCasIsolatedPendingCodePatch,canStageCasIsolatedCodePatch,
  inspectCasIsolatedPendingCodePatch,inspectCasIsolatedPendingCodeFiles,
  buildCasIsolatedDiscardPendingCodePatch,
  canDiscardCasIsolatedPendingCodePatch,
  CAS_PENDING_PATCH_MAX_REQUEST,CAS_PENDING_PATCH_MAX_JSON,
} from "../application/cas-isolated-code-patch";
import {
  prepareCasIsolatedExport,confirmCasIsolatedExport,
} from "../application/cas-isolated-export";
import {prepareCasIsolatedSourceZip} from "../application/cas-isolated-source-zip";
import {prepareCasSelectedRevisionReconcile,confirmCasSelectedRevisionReconcile}
  from "../application/cas-selected-revision-reconcile";
import {
  prepareCasLibraryRecoveryBundle,confirmCasLibraryRecoveryBundle,
  encodeCasLibraryRecoveryZip,CasLibraryZipPortabilityError,
} from "../application/cas-library-recovery-bundle";
import {
  prepareCasEmptyLibraryRestorePreview,confirmCasEmptyLibraryBackupRestore,
  MAX_CAS_LIBRARY_ZIP_BYTES,
} from "../application/cas-empty-library-zip-restore";
import {
  buildCasIsolatedHumanApplyPendingPatch,
  canApplyCasIsolatedHumanPendingPatch,
} from "../application/cas-isolated-human-apply";
import {
  prepareCasIsolatedHumanUndo,buildCasIsolatedHumanUndo,
} from "../application/cas-isolated-human-undo";
import {
  buildCasIsolatedStageReset,canResetCasIsolatedStage,
} from "../application/cas-isolated-stage-reset";
import {inspectCasRunningStage,prepareCasRunningRecovery}
  from "../application/cas-running-recovery";

type Props={
  locale:FactoryLocale;settings:FactorySettings;
  /** Used only by the standalone CAS root (#167). */
  onRequestLegacy?:()=>void;
  /** #171: untrusted, opt-in URL hint. No automatic IndexedDB open. */
  handoff?:CasHandoffHint|null;
};

const CAS_STACK_FRONTENDS:ReadonlyArray<FrontendKind>=
  ["react","react-native","android","ios","unity"];
const CAS_STACK_DEPLOYMENTS:ReadonlyArray<DeploymentTarget>=
  ["docker","kubernetes","azure","aws","gcp"];
const CAS_STACK_DATABASES:ReadonlyArray<ProjectConfig["database"]>=
  ["postgresql","sqlserver","mysql","sqlite"];

const CAS_INSPECTION_STATUS_KEY={
  pending:"casIsoInspectPending",
  running:"casIsoInspectRunning",
  complete:"casIsoInspectComplete",
  failed:"casIsoInspectFailed",
  invalid:"casIsoInspectInconsistent",
} as const;

function exact(a:CasProjectSnapshot,b:CasProjectSnapshot):boolean {
  return a.id===b.id && a.revision===b.revision && a.raw===b.raw;
}

export default function CasIsolatedEditor({
  locale,settings,onRequestLegacy,handoff,
}:Props) {
  const [expanded,setExpanded]=useState(false);
  const [list,setList]=useState<CasProjectChoice[]|null>(null);
  const [deleted,setDeleted]=useState<ReadonlyArray<CasProjectTombstone>|null>(null);
  const [snapshot,setSnapshot]=useState<CasProjectSnapshot|null>(null);
  const [draftName,setDraftName]=useState("");
  const [draftDescription,setDraftDescription]=useState("");
  const [draftRequirements,setDraftRequirements]=useState("");
  const [draftStack,setDraftStack]=useState<ProjectConfig|null>(null);
  const [stageToReset,setStageToReset]=useState<StageId>("features");
  const [stageToRun,setStageToRun]=useState<StageId>("features");
  const [manualStage,setManualStage]=useState<StageId>("features");
  const [manualOutput,setManualOutput]=useState("");
  const [codeRequest,setCodeRequest]=useState("");
  const [codeProposalJson,setCodeProposalJson]=useState("");
  const [pipelineRunning,setPipelineRunning]=useState(false);
  const [pipelineStatus,setPipelineStatus]=useState("");
  const [newProjectName,setNewProjectName]=useState("");
  const [newProjectDescription,setNewProjectDescription]=useState("");
  const [working,setWorking]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [resumeLink,setResumeLink]=useState<CasRevisionResumeLink|null>(null);
  const [emergencyPreview,setEmergencyPreview]=
    useState<CasUncommittedDraftInspection|null>(null);
  const [failedWrite,setFailedWrite]=useState<CasFailedWriteTicket|null>(null);
  const [pipelineFailedWrite,setPipelineFailedWrite]=
    useState<CasPipelineFailedWrite|null>(null);
  const [failedWriteObservation,setFailedWriteObservation]=
    useState<CasFailedWriteObservation|null>(null);
  const active=useRef<CasSelectionController|null>(null);
  const inFlight=useRef(false);
  const pipelineAbort=useRef<AbortController|null>(null);
  // Unmount aborts the network; a committed "running" stage is not
  // automatically completed or rolled back after browser crash/reload.
  useEffect(()=>()=>{pipelineAbort.current?.abort();},[]);

  const stackDirty=hasCasIsolatedStackDraft(snapshot,draftStack);
  const configDirty=hasCasIsolatedUnsavedDraft(
    snapshot,draftName,draftDescription,draftRequirements,
  ) || stackDirty;
  // Human stage text is a draft too: close/switch/refresh must not discard
  // it without explicit consent. Saving config must not silently erase it.
  const dirty=configDirty || manualOutput.length>0 ||
    codeRequest.length>0 || codeProposalJson.length>0;
  const resumeView=useRef({snapshot,dirty,pipelineRunning});
  resumeView.current={snapshot,dirty,pipelineRunning};
  const failedWriteView=useRef({failedWrite,snapshot});
  failedWriteView.current={failedWrite,snapshot};
  const shownResumeLink=snapshot && resumeLink &&
    snapshot.id===resumeLink.id &&
    snapshot.revision===resumeLink.revision &&
    !dirty && !pipelineRunning ? resumeLink : null;
  // This projection is read-only and pinned to the selection's exact CAS
  // revision; a rival tab cannot silently replace the text being inspected.
  const inspectedStages=inspectCasIsolatedStages(snapshot);
  const strandedStage=useMemo(()=>inspectCasRunningStage(snapshot),[snapshot]);
  const inspectedCodePatch=inspectCasIsolatedPendingCodePatch(snapshot);
  // Bounded source projections are expensive (generated scaffold baseline):
  // memoize by the pinned IDB snapshot, not draft edits or rival-tab events.
  const inspectedCodeFiles=useMemo(
    ()=>inspectCasIsolatedPendingCodeFiles(snapshot),[snapshot],
  );
  const canApplyCode=useMemo(
    ()=>canApplyCasIsolatedHumanPendingPatch(snapshot),[snapshot],
  );
  // Render only the exact pinned source, never a partial preview that
  // could hide an unreviewed before/after fragment from the operator.
  const inspectedHumanUndo=useMemo(()=>{
    if(!snapshot)return null;
    try{return prepareCasIsolatedHumanUndo(snapshot);}
    catch{return null;}
  },[snapshot]);

  async function commitSelectedWithProbe(
    controller:CasSelectionController,candidate:FactoryProject,
    expected:CasProjectSnapshot,
  ):Promise<CasProjectSnapshot> {
    // Preserve proposed RAW only on a genuinely blocked native CAS commit.
    const ticket=prepareCasFailedWriteTicket(expected,candidate);
    try{
      const committed=await controller.commit(candidate,expected);
      setFailedWrite(null);setFailedWriteObservation(null);setPipelineFailedWrite(null);
      return committed;
    }catch(error){
      if(controller.state()==="blocked"){
        setFailedWrite(ticket);setFailedWriteObservation(null);
      }
      throw error;
    }
  }
  function inspectBlockedWrite():void {
    const ticket=failedWrite,pinned=snapshot;
    if(!ticket || !pinned || !exact(ticket.old,pinned) ||
       inFlight.current || pipelineRunning)return;
    void run(async()=>{
      setFailedWriteObservation(null);
      try{
        const observed=await inspectCasFailedWrite(ticket);
        if(failedWriteView.current.failedWrite!==ticket ||
           resumeView.current.snapshot!==pinned ||
           resumeView.current.pipelineRunning)
          throw Error("Stale failed write inspection");
        setFailedWriteObservation(observed);
        setNotice(t(locale,"casFailedWriteReadDone"));
      }catch{
        setError(t(locale,"casFailedWriteReadUnavailable"));
      }
    });
  }
  function exportFailedWriteBackup():void {
    // The ticket is volatile and the selected baseline is the last ACK,
    // never the uncertain proposal. There is deliberately NO IDB read/write.
    const ticket=failedWrite,pinned=snapshot;
    if(!ticket || !pinned || !exact(ticket.old,pinned) ||
       inFlight.current || pipelineRunning)return;
    const context:CasFailedWriteBackupContext=
      pipelineFailedWrite?.ticket===ticket
        ?{operation:pipelineFailedWrite.operation,
          stage:pipelineFailedWrite.stage}
        :{operation:"editor",stage:null};
    void run(async()=>{
      let backup;
      try{backup=prepareCasFailedWriteBackup(ticket,context);}
      catch{setError(t(locale,"casFailedWriteBackupFailure"));return;}
      const pinnedView=()=>failedWriteView.current.failedWrite===ticket &&
        resumeView.current.snapshot===pinned &&
        !resumeView.current.pipelineRunning;
      if(!pinnedView()){
        setError(t(locale,"casFailedWriteBackupFailure"));return;
      }
      if(!window.confirm(t(locale,"casFailedWriteBackupConsent")+"\n"+
          pinned.id+" / rev. "+pinned.revision))return;
      // Selection may change during the explicit human consent dialog.
      if(!pinnedView()){
        setError(t(locale,"casFailedWriteBackupFailure"));return;
      }
      let url:string|undefined;
      try{
        url=URL.createObjectURL(new Blob([backup.raw],{
          type:"application/json",
        }));
        const link=document.createElement("a");
        link.href=url;link.download=backup.fileName;
        document.body.appendChild(link);link.click();link.remove();
        setNotice(t(locale,"casFailedWriteBackupOffered"));
      }catch{
        setError(t(locale,"casFailedWriteBackupFailure"));
      }finally{
        const objectUrl=url;
        if(objectUrl)setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
      }
    });
  }
  function preserveBlockedPipeline(
    pipeline:CasPipelineSession,baseline:CasProjectSnapshot,
  ):void {
    // baseline is an earlier native oncomplete ACK (or the selected source
    // for a rejected begin), NOT the proposed result or a newer rival.
    active.current=null;setList(null);
    accept(baseline);
    const failed=pipeline.failedWrite();
    if(failed && exact(failed.ticket.old,baseline)){
      setFailedWrite(failed.ticket);
      setPipelineFailedWrite(failed);
    }
    setNotice(t(locale,"casIsoPipelineBlocked")+
      " ID: "+baseline.id+" / rev. "+baseline.revision);
  }
  function accept(current:CasProjectSnapshot):void {
    // openCasSelectionController validates canonical raw before exposing it.
    const p=JSON.parse(current.raw) as {config:{name:string;description:string;requirements?:string}};
    setSnapshot(current);
    setFailedWrite(null);setFailedWriteObservation(null);setPipelineFailedWrite(null);
    setResumeLink(null);
    setDraftName(p.config.name);
    setDraftDescription(p.config.description || "");
    setDraftRequirements(p.config.requirements ?? "");
    // Strict validated stack projection. Malformed historic config is
    // read-only in this form; never "fix" missing fields by guessing.
    setDraftStack(readCasIsolatedStackConfig(current));
    setPipelineStatus("");
    setManualOutput("");
    setCodeRequest("");setCodeProposalJson("");
  }
  async function run(action:()=>Promise<void>):Promise<void> {
    if(inFlight.current) return;
    inFlight.current=true;
    setWorking(true); setError(""); setNotice("");
    try { await action(); }
    catch(error) {
      // Display only stable non-secret native storage categories, never raw
      // DOMException / project JSON / remote provider error messages.
      const nativeCode=casStorageFaultCode(error);
      const reason=nativeCode==="unsupported"?"casIsoStorageUnsupported":
        nativeCode==="upgrade"?"casIsoStorageUpgrade":
        nativeCode==="quota"?"casIsoStorageQuota":
        nativeCode==="blocked"?"casIsoStorageBlocked":"casIsoFailure";
      setError(t(locale,reason));
      if(active.current?.state()==="blocked") {
        active.current=null;
        setNotice(t(locale,"casIsoBlocked"));
      }
    } finally {
      inFlight.current=false;
      setWorking(false);
    }
  }
  function returnToLegacy():void {
    if(!onRequestLegacy || inFlight.current || working || pipelineRunning)
      return;
    // Navigating away from a draft is always an explicit, reversible
    // operator decision: it never writes draft data into legacy.
    if(dirty && !window.confirm(t(locale,"casRootExitDirtyConsent")))return;
    if(!window.confirm(t(locale,"casRootExitFinalConsent")))return;
    onRequestLegacy();
  }
  function openHandoffHint():void {
    if(!handoff || snapshot || active.current || inFlight.current)return;
    void run(async()=>{
      // Only a human click may trigger the FIRST IndexedDB read on the
      // dedicated CAS route. Hint alone must never mount legacy or IDB.
      const before=await openCasSelectionController(handoff.id);
      const source=before.snapshot();
      if(!await matchesCasHandoffHint(handoff,source)){
        setError(t(locale,"casHandoffStale"));return;
      }
      if(!window.confirm(t(locale,"casHandoffOpenConsent")+"\nID: "+
         source.id+" / rev. "+source.revision))return;
      // A rival may update IDB while the browser dialog is open.
      const after=await openCasSelectionController(handoff.id);
      const exactSource=after.snapshot();
      if(!exact(source,exactSource) ||
         !await matchesCasHandoffHint(handoff,exactSource)){
        setError(t(locale,"casHandoffStale"));return;
      }
      active.current=after;
      accept(exactSource);
      setExpanded(true);
      setList(null);
      setNotice(t(locale,"casHandoffOpened")+" ID: "+exactSource.id+
        " (rev. "+exactSource.revision+")");
    });
  }
  function generateResumeLink():void {
    const controller=active.current,expected=snapshot;
    if(!controller || !expected || inFlight.current ||
       controller.state()!=="ready" || dirty || pipelineRunning ||
       !exact(controller.snapshot(),expected))return;
    if(!window.confirm(t(locale,"casResumeConfirm")+"\nID: "+
       expected.id+" / rev. "+expected.revision))return;
    const stable=()=>controller===active.current &&
      controller.state()==="ready" &&
      resumeView.current.snapshot===expected &&
      !resumeView.current.dirty &&
      !resumeView.current.pipelineRunning &&
      exact(controller.snapshot(),expected);
    void run(async()=>{
      setResumeLink(null);
      try{
        const link=await prepareCasRevisionResumeLink(
          expected,window.location.href,stable,
        );
        if(!stable())throw Error("Revision changed before displaying link");
        setResumeLink(link);
        setNotice(t(locale,"casResumeCreated"));
      }catch{
        setError(t(locale,"casResumeStale"));
      }
    });
  }
  function close():void {
    if(inFlight.current) return;
    // "Close panel" does not mean permission to destroy a human draft.
    // An explicit rejection keeps both the CAS selection and all text.
    if(dirty && !window.confirm(t(locale,"casIsoCloseDirtyConfirm"))) return;
    active.current=null; setExpanded(false);
    setFailedWrite(null);setFailedWriteObservation(null);setPipelineFailedWrite(null);
    setResumeLink(null);
    setList(null); setDeleted(null); setSnapshot(null); setError(""); setNotice("");
    setDraftName(""); setDraftDescription("");setDraftRequirements("");
    setDraftStack(null);
    setStageToReset("features");setStageToRun("features");
    setManualStage("features");setManualOutput("");
    setCodeRequest("");setCodeProposalJson("");
    setPipelineStatus("");
    setNewProjectName(""); setNewProjectDescription("");
  }
  function createFresh():void {
    void run(async()=>{
      // A selected IDB editor, especially a dirty draft, must not be
      // displaced by a new-project submission. Discard explicitly first.
      if(snapshot || active.current) throw Error("Discard selected IDB project first");
      const ticket=prepareCasIsolatedNewProject(
        newProjectName,newProjectDescription,
      );
      if(!window.confirm(t(locale,"casIsoCreateConfirm")+"\n"+
        ticket.name+"\nID: "+ticket.id)) return;
      // The only write is native CAS expected=null: strict never-seen insert,
      // 40-active cap and tx.oncomplete acknowledgement. No legacy fallback.
      const acknowledged=await confirmCasIsolatedNewProject(ticket,true);
      // From this point the native transaction has ALREADY completed.
      // Neither a readback failure nor a racing writer can make this create
      // uncommitted. Clear the form to discourage a duplicate with a new UUID.
      setNewProjectName(""); setNewProjectDescription("");
      setList(null);
      const identity=" ID: "+acknowledged.id+" (rev. "+acknowledged.revision+")";
      const verified=await verifyCasIsolatedCreatedReadback(
        acknowledged,async id=>(await openCasSelectionController(id)).snapshot(),
      );
      if(!verified) {
        // The project exists per ACK, but its current state is unknown.
        // Do not rebase, retry or silently open a rival version.
        setNotice(t(locale,"casIsoCreateReadbackWarning")+identity);
        return;
      }
      try {
        // Library discovery is a separate read-only operation. If it fails
        // after a successful readback, it must not erase the create ACK.
        setList(await listCasProjects());
        setNotice(t(locale,"casIsoCreateDone")+identity);
      }catch{
        setList(null);
        setNotice(t(locale,"casIsoCreateReadbackWarning")+identity);
      }
    });
  }
  function importBackupFile(file:File):void {
    if(snapshot || active.current || inFlight.current || pipelineRunning)return;
    void run(async()=>{
      if(snapshot || active.current || file.size===0 ||
         file.size>1_000_000 || !file.name.toLowerCase().endsWith(".json")){
        setError(t(locale,"casIsoImportInvalid"));return;
      }
      let ticket;
      try{
        // Only the explicitly selected local file is read. The source JSON
        // remains ephemeral and is never sent to a provider or persisted.
        const raw=await file.text();
        ticket=prepareCasExternalConfigImport(raw);
      }catch{
        setError(t(locale,"casIsoImportInvalid"));return;
      }
      if(active.current || snapshot)return;
      if(!window.confirm(t(locale,"casIsoImportConfirm")+
         "\n"+ticket.name+"\nID: "+ticket.id))return;
      let acknowledged:CasProjectSnapshot;
      try{
        acknowledged=await confirmCasExternalConfigImport(ticket,true);
      }catch{
        // An unsuccessful/ambiguous acknowledgement must not trigger a
        // retry with a new UUID; the native insert might have committed.
        setError(t(locale,"casIsoImportUnverified")+
          " ID: "+ticket.id);return;
      }
      setList(null);
      const identity=" ID: "+acknowledged.id+
        " (rev. "+acknowledged.revision+")";
      const verified=await verifyCasIsolatedCreatedReadback(
        acknowledged,async id=>(await openCasSelectionController(id)).snapshot(),
      );
      if(!verified){
        setNotice(t(locale,"casIsoCreateReadbackWarning")+identity);return;
      }
      try{
        setList(await listCasProjects());
        setNotice(t(locale,"casIsoImportDone")+identity);
      }catch{
        setList(null);
        setNotice(t(locale,"casIsoCreateReadbackWarning")+identity);
      }
    });
  }
  function restoreDeletedCasBackup(file:File):void {
    if(snapshot || active.current || inFlight.current || pipelineRunning)return;
    void run(async()=>{
      if(snapshot || active.current || file.size===0 ||
         file.size>MAX_CAS_RESTORE_FILE_BYTES ||
         !file.name.toLowerCase().endsWith(".json")){
        setError(t(locale,"casIsoRestoreInvalid"));return;
      }
      let ticket;
      try{
        // Local backup only, then read-only native tombstone preflight.
        ticket=await prepareCasIsolatedTombstoneRestore(await file.text());
      }catch{
        setError(t(locale,"casIsoRestoreInvalid"));return;
      }
      if(active.current || snapshot)return;
      const identity=" ID: "+ticket.id+
        " / tombstone rev. "+ticket.tombstone.revision;
      if(!window.confirm(t(locale,"casIsoRestoreFirstConfirm")+
         "\n"+ticket.name.slice(0,120)+"\n"+identity))return;
      if(!window.confirm(t(locale,"casIsoRestoreFinalConfirm")+
         "\n"+identity))return;
      let saved:CasProjectSnapshot;
      try{
        saved=await confirmCasIsolatedTombstoneRestore(ticket,true);
      }catch{
        // Native race/ambiguous acknowledgement: no silent rebase or retry.
        setError(t(locale,"casIsoRestoreUnverified")+" ID: "+ticket.id);
        return;
      }
      setList(null);setDeleted(null);
      const restored=" ID: "+saved.id+" (rev. "+saved.revision+")";
      const verified=await verifyCasIsolatedCreatedReadback(
        saved,async id=>(await openCasSelectionController(id)).snapshot(),
      );
      if(!verified){
        setNotice(t(locale,"casIsoRestorePostAck")+restored);return;
      }
      try{
        setList(await listCasProjects());
        setNotice(t(locale,"casIsoRestoreDone")+restored);
      }catch{
        setList(null);
        setNotice(t(locale,"casIsoRestorePostAck")+restored);
      }
    });
  }
  function forkConfig():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
         dirty || !exact(controller.snapshot(),expected))
        throw Error("Stale/dirty CAS fork session");
      const ticket=prepareCasIsolatedConfigFork(expected);
      if(!window.confirm(t(locale,"casIsoForkBackupConfirm")+"\n"+
          ticket.source.id+" / rev. "+ticket.source.revision))return;
      // Byte-exact source backup is offered BEFORE either the saved-file
      // acknowledgement or permission to create the new ID.
      const url=URL.createObjectURL(new Blob([ticket.source.raw],{
        type:"application/json",
      }));
      try{
        const link=document.createElement("a");
        link.href=url;
        link.download="softwarefactory-cas-before-fork-"+ticket.source.id+
          "-r"+ticket.source.revision+".json";
        document.body.appendChild(link);link.click();link.remove();
      }finally{
        setTimeout(()=>URL.revokeObjectURL(url),30000);
      }
      if(!window.confirm(t(locale,"casIsoForkSavedConfirm")))return;
      if(!window.confirm(t(locale,"casIsoForkFinalConfirm")+"\n"+
        ticket.name+"\nID: "+ticket.id+"\nsource: "+ticket.source.id+
        " / rev. "+ticket.source.revision))return;

      // Native transaction checks SOURCE revision/raw and target never-seen
      // + capacity atomically. A stale source or existing destination aborts
      // all changes without retrying under a different UUID.
      const acknowledged=await confirmCasIsolatedConfigFork(ticket,true);
      setList(null);
      const identity=" ID: "+acknowledged.id+
        " (rev. "+acknowledged.revision+")";
      // Post-ACK observations MUST NOT change an already committed create
      // to a false failure, and must not silently switch the source editor.
      const verified=await verifyCasIsolatedCreatedReadback(
        acknowledged,async id=>(await openCasSelectionController(id)).snapshot(),
      );
      if(!verified){
        setNotice(t(locale,"casIsoForkReadbackWarning")+identity);
        return;
      }
      try{
        setList(await listCasProjects());
        setNotice(t(locale,"casIsoForkDone")+identity);
      }catch{
        setList(null);
        setNotice(t(locale,"casIsoForkReadbackWarning")+identity);
      }
    });
  }

  function scanDeleted():void {
    if(inFlight.current || pipelineRunning)return;
    void run(async()=>{
      // Explicit readonly scan; never discard the selection or human drafts.
      // Clear obsolete results BEFORE an unsuccessful new scan.
      setDeleted(null);
      const observations=await listCasTombstones();
      setDeleted(observations);
    });
  }
  function recheckSelectedRevision():void {
    if(inFlight.current || pipelineRunning || !onRequestLegacy)return;
    void run(async()=>{
      const controller=active.current,expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
         !exact(controller.snapshot(),expected)){
        setError(t(locale,"casRevisionCheckUnavailable"));return;
      }
      let checked;
      try{
        // Always a manually triggered, native-only readonly inspection.
        checked=await prepareCasSelectedRevisionReconcile(expected);
      }catch{
        setError(t(locale,"casRevisionCheckUnavailable"));return;
      }
      const identity=" ID: "+expected.id+" / rev. "+expected.revision;
      if(checked.state==="unchanged"){
        setNotice(t(locale,"casRevisionCheckUnchanged")+identity);
        return;
      }
      if(checked.state==="tombstone" || checked.state==="missing"){
        // A lost/deleted native row cannot remain a writable selection.
        // The previous raw remains on screen for manual historical recovery.
        active.current=null;setList(null);setResumeLink(null);
        setNotice(t(locale,checked.state==="tombstone"?
          "casRevisionCheckDeleted":"casRevisionCheckMissing")+identity);
        return;
      }
      if(dirty){
        // User draft wins over any automatic rebase. CAS commit still fences
        // the stale snapshot; no overwrite of the rival or silent discard.
        setNotice(t(locale,"casRevisionCheckDirty")+
          identity+" / rev. "+checked.next.revision);
        return;
      }
      const stable=()=>controller===active.current &&
        controller.state()==="ready" &&
        resumeView.current.snapshot===expected &&
        !resumeView.current.dirty && !resumeView.current.pipelineRunning &&
        exact(controller.snapshot(),expected);
      if(!stable())return;
      if(!window.confirm(t(locale,"casRevisionCheckBackupConsent")+
        "\n"+identity+" → rev. "+checked.next.revision))return;
      // Backup the PINNED old raw, not silently a new rival version.
      const url=URL.createObjectURL(new Blob([expected.raw],{
        type:"application/json",
      }));
      try{
        const link=document.createElement("a");
        link.href=url;
        link.download="softwarefactory-cas-before-reconcile-"+
          expected.id+"-r"+expected.revision+".json";
        document.body.appendChild(link);link.click();link.remove();
      }finally{
        setTimeout(()=>URL.revokeObjectURL(url),30000);
      }
      if(!window.confirm(t(locale,"casRevisionCheckSavedConsent")))return;
      if(!window.confirm(t(locale,"casRevisionCheckFinalConsent")+
        "\n"+identity+" → rev. "+checked.next.revision))return;
      try{
        if(!stable())
          throw Error("CAS UI changed during explicit rebase consent");
        const next=await confirmCasSelectedRevisionReconcile(
          checked,true,stable);
        // This SECOND native read also fences a rival between the final
        // confirmed readonly inspection and newly opened CAS editor session.
        const opened=await openCasSelectionController(expected.id);
        if(!stable() || !exact(opened.snapshot(),next))
          throw Error("Selected CAS revision changed before adopt");
        active.current=opened;
        accept(next);
        setList(null);setDeleted(null);
        setNotice(t(locale,"casRevisionCheckAdopted")+
          " ID: "+next.id+" / rev. "+next.revision);
      }catch{
        // No automatic retry or force-sync. Never claim the old revision
        // is gone; it is still pinned in the original UI until explicit
        // operator reconciliation is repeated.
        setError(t(locale,"casRevisionCheckStale")+identity);
      }
    });
  }

  function inspectOfflineUncommittedDraft(file:File):void {
    if(inFlight.current || pipelineRunning)return;
    void run(async()=>{
      // No native IDB read or selected CAS writer is consulted, even after
      // an unrelated project becomes stale. This is LOCAL, inert text.
      setEmergencyPreview(null);
      if(file.size<1 || file.size>MAX_CAS_UNCOMMITTED_DRAFT_FILE_BYTES){
        setError(t(locale,"casIsoDraftInspectFailure"));return;
      }
      if(!window.confirm(t(locale,"casIsoDraftInspectConsent")))return;
      try{
        const inspected=inspectCasUncommittedDraftBackup(await file.text());
        setEmergencyPreview(inspected);
        setNotice(t(locale,"casIsoDraftInspectReady"));
      }catch{
        setError(t(locale,"casIsoDraftInspectFailure"));
      }
    });
  }
  function copyUncommittedDraftIntoForm():void {
    const controller=active.current;
    const expected=snapshot;
    const preview=emergencyPreview;
    if(!controller || !expected || !preview || inFlight.current ||
       !canCopyCasUncommittedDraftLocally(preview,expected,
         controller.state()==="ready" &&
           exact(controller.snapshot(),expected),
         dirty,pipelineRunning))return;
    void run(async()=>{
      const stable=()=>active.current===controller &&
        controller.state()==="ready" &&
        resumeView.current.snapshot===expected &&
        !resumeView.current.dirty &&
        !resumeView.current.pipelineRunning &&
        exact(controller.snapshot(),expected);
      try{
        if(!stable())throw Error("stale");
        const copy=prepareCasUncommittedDraftLocalCopy(preview,expected);
        // A valid file is NOT evidence that its base revision still exists.
        // Check the live native store before and AFTER a synchronous dialog.
        const before=await readCasProject(expected.id);
        if(!stable() || !before || !exact(before,expected))
          throw Error("Stale native project before consent");
        if(!window.confirm(t(locale,"casIsoDraftCopyConsent")+
            "\n"+expected.id+" / rev. "+expected.revision))return;
        const after=await readCasProject(expected.id);
        if(!stable() || !after || !exact(after,expected))
          throw Error("Stale native project after consent");
        // These setState calls are the ONLY effect: never a CAS commit.
        // The normal save/stage paths still revalidate and need their
        // own backup and independent human consents.
        setDraftName(copy.name);
        setDraftDescription(copy.description);
        setDraftRequirements(copy.requirements);
        setDraftStack(copy.stack);
        setManualStage(copy.manualStage);
        setManualOutput(copy.manualOutput);
        setCodeRequest(copy.codeRequest);
        setCodeProposalJson(copy.codeProposalJson);
        setNotice(t(locale,"casIsoDraftCopyInMemory"));
      }catch{
        setError(t(locale,"casIsoDraftCopyRefused"));
      }
    });
  }
  function exportUncommittedDraft():void {
    // This intentionally works even after the CAS controller was blocked.
    // Only pinned React state is read — no IndexedDB, cloud or legacy access.
    if(!snapshot || !dirty || inFlight.current || pipelineRunning)return;
    void run(async()=>{
      let backup;
      try{
        backup=prepareCasUncommittedDraftBackup({
          snapshot,name:draftName,description:draftDescription,
          requirements:draftRequirements,stack:draftStack,
          manualStage,manualOutput,codeRequest,codeProposalJson,
        });
      }catch{
        setError(t(locale,"casIsoDraftBackupFailure"));return;
      }
      if(!window.confirm(t(locale,"casIsoDraftBackupConsent")+"\n"+
          snapshot.id+" / rev. "+snapshot.revision))return;
      let url:string|undefined;
      try{
        url=URL.createObjectURL(new Blob([backup.raw],{
          type:"application/json",
        }));
        const link=document.createElement("a");
        link.href=url;link.download=backup.fileName;
        document.body.appendChild(link);link.click();link.remove();
        // No filesystem ACK and no state mutation, even on blocked IDB.
        setNotice(t(locale,"casIsoDraftBackupOffered"));
      }catch{
        setError(t(locale,"casIsoDraftBackupFailure"));
      }finally{
        const objectUrl=url;
        if(objectUrl)setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
      }
    });
  }
  function refresh():void {
    if(inFlight.current) return;
    // A ready controller retains its pinned snapshot and draft on refresh.
    // After a failed/conflicting CAS write the controller is blocked, while
    // the rejected human draft is still on screen: never erase it silently.
    const resetsSelection=!active.current || active.current.state()!=="ready";
    if(resetsSelection && dirty &&
       !window.confirm(t(locale,"casIsoRefreshDirtyConfirm"))) return;
    void run(async()=>{
      setDeleted(null); // list refresh does not refresh a prior tombstone snapshot
      // Do the read FIRST: if IndexedDB is unavailable, retain even a
      // blocked selected project and its human/Code Agent drafts. An
      // explicit discard consent must not destroy the only draft if read
      // failed. Clear only after the verified read-only refresh succeeds.
      const available=await listCasProjects();
      if(resetsSelection) {
        active.current=null;setSnapshot(null);
        setFailedWrite(null);setFailedWriteObservation(null);setPipelineFailedWrite(null);
        setDraftName("");setDraftDescription("");setDraftRequirements("");
        setDraftStack(null);
        setManualOutput("");setCodeRequest("");setCodeProposalJson("");
      }
      setList(available);
    });
  }
  function choose(choice:CasProjectChoice):void {
    void run(async()=>{
      const current=active.current;
      const previous=snapshot;
      if(previous && dirty)
        throw Error("Unsaved CAS draft must be discarded explicitly");
      if(previous && current && previous.id === choice.id)
        throw Error("Already selected");
      if(current && previous) {
        const ticket=await current.prepareSwitch(choice.id);
        if(ticket.destination.revision!==choice.revision)
          throw Error("Stale discovery");
        if(!window.confirm(t(locale,"casIsoSwitchConfirm")+"\n"+
          choice.name+" / rev. "+choice.revision)) return;
        const confirmed=await current.confirmSwitch(ticket);
        accept(confirmed); setNotice(t(locale,"casIsoSelected"));
      } else {
        // Initial selection: check source twice, across human consent, to
        // avoid silently opening a different raw at the same revision.
        const before=await openCasSelectionController(choice.id);
        const ticket=before.snapshot();
        if(ticket.revision!==choice.revision) throw Error("Stale listing");
        if(!window.confirm(t(locale,"casIsoOpenConfirm")+"\n"+
          choice.name+" / rev. "+ticket.revision)) return;
        const after=await openCasSelectionController(choice.id);
        const confirmed=after.snapshot();
        if(!exact(ticket,confirmed)) throw Error("Stale opened project");
        active.current=after;
        accept(confirmed); setNotice(t(locale,"casIsoSelected"));
      }
    });
  }
  function deleteSelected():void {
    void run(async()=>{
      const controller=active.current, expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready")
        throw Error("CAS controller unavailable");
      // No pending name/description changes or stale in-memory revision.
      const ticket=prepareCasIsolatedDelete(
        expected,controller.snapshot(),draftName,draftDescription,
        draftRequirements,
      );
      if(!window.confirm(t(locale,"casIsoDeleteBackupConfirm"))) return;
      // Exact historical JSON (including AI checkpoints) BEFORE tombstoning.
      // File handoff must precede a separate operator acknowledgement.
      const url=URL.createObjectURL(new Blob([ticket.raw],{
        type:"application/json",
      }));
      const link=document.createElement("a");
      link.href=url;link.download=ticket.fileName;
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      if(!window.confirm(t(locale,"casIsoDeleteSavedConfirm"))) return;
      if(!window.confirm(
        t(locale,"casIsoDeleteFinalConfirm")+"\n\n"+
        ticket.name.slice(0,120)+"\nID: "+ticket.id+
        "\nrev. "+ticket.revision
      )) return;
      // The controller validates this exact token in a single native IDB
      // readwrite transaction; no legacy delete, retry or silent resurrection.
      const tombstone=await controller.delete(expected,true);
      if(tombstone.id!==ticket.id ||
        tombstone.revision!==ticket.revision+1)
        throw Error("CAS tombstone ACK does not match expected revision");
      active.current=null;
      setSnapshot(null);
      setDraftName("");setDraftDescription("");setDraftRequirements("");
        setDraftStack(null);
      setList(null);setDeleted(null);
      // Do not make an already acknowledged delete appear to have failed
      // solely because a later read-only library refresh is unavailable.
      try{setList(await listCasProjects());}catch{setList(null);}
      setNotice(t(locale,"casIsoDeleteDone")+
        " (rev. "+tombstone.revision+")");
    });
  }

  function save():void {
    void run(async()=>{
      if(manualOutput.length>0 || codeRequest.length>0 ||
         codeProposalJson.length>0)
        throw Error("Uncommitted stage/Code Agent draft must be handled first");
      const controller=active.current, expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
        !exact(controller.snapshot(),expected))
        throw Error("Stale CAS session");
      if(stackDirty && !draftStack)
        throw Error("Missing stack draft");
      // A single transaction saves text + stack together. A text-only edit
      // stays compatible with historical IDB fixtures lacking stack keys.
      const candidate=stackDirty ?
        buildCasIsolatedStackConfigEdit(expected,{
          ...draftStack!,name:draftName,description:draftDescription,
          requirements:draftRequirements,
        }) : buildCasIsolatedConfigEdit(
          expected,draftName,draftDescription,draftRequirements);
      if(!window.confirm(t(locale,"casIsoBackupConfirm"))) return;
      // The file contains the original exact raw, BEFORE the stage reset and
      // new candidate are persisted. No upload or automatic migration.
      const blob=new Blob([expected.raw],{type:"application/json"});
      const url=URL.createObjectURL(blob);
      const link=document.createElement("a");
      link.href=url;
      link.download="softwarefactory-cas-before-edit-"+expected.id+
        "-r"+expected.revision+".json";
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      if(!window.confirm(t(locale,"casIsoSavedConfirm"))) return;
      const committed=await commitSelectedWithProbe(controller,candidate,expected);
      if(!exact(committed,{
        id:candidate.id,revision:expected.revision+1,
        raw:JSON.stringify(candidate),
      }))
        throw Error("Inconsistent CAS acknowledgement");
      accept(committed);setList(null);
      setNotice(t(locale,"casIsoSaved")+" (rev. "+committed.revision+")");
    });
  }



  function restoreWholeCasLibraryZip(file:File):void {
    // Only the isolated root can initiate a new, native IDB writer.
    // Never mount this import in LegacyFactoryApp's embedded preview.
    if(!onRequestLegacy || snapshot || active.current ||
       inFlight.current || pipelineRunning)return;
    void run(async()=>{
      if(snapshot || active.current || pipelineRunning || !file ||
         file.size===0 || file.size>MAX_CAS_LIBRARY_ZIP_BYTES ||
         !file.name.toLowerCase().endsWith(".zip")){
        setError(t(locale,"casLibraryRestoreInvalid"));return;
      }
      let ticket;
      try{
        const bytes=new Uint8Array(await file.arrayBuffer());
        ticket=await prepareCasEmptyLibraryRestorePreview(bytes);
      }catch{
        setError(t(locale,"casLibraryRestoreInvalid"));return;
      }
      // Source revisions are historical. Each newly inserted native slot
      // starts at revision 1, and deleted payloads are NEVER imported.
      const count=ticket.projects.length+" "+t(locale,"casLibraryRestoreCount")+
        "; "+ticket.tombstones.length+" "+t(locale,"casLibraryRestoreTombstones");
      if(!window.confirm(t(locale,"casLibraryRestoreFirstConsent")+
        "\n"+count))return;
      if(!window.confirm(t(locale,"casLibraryRestoreFinalConsent")+
        "\n"+count))return;
      if(active.current || snapshot || resumeView.current.snapshot ||
         resumeView.current.dirty || resumeView.current.pipelineRunning){
        setError(t(locale,"casLibraryRestoreInvalid"));return;
      }
      let saved:ReadonlyArray<CasProjectSnapshot>;
      try{
        // Transaction's own cursor rejects even a tombstone or a newly
        // created ID during consent, with ZERO partial inserts.
        saved=await confirmCasEmptyLibraryBackupRestore(ticket,true);
      }catch{
        setError(t(locale,"casLibraryRestoreUnverified"));return;
      }
      setDeleted(null);setList(null);
      // Tx.oncomplete has acknowledged ALL rows, but another tab may
      // change them before readback. Never repeat this import after ACK.
      try{
        const current=await readCasLibraryBackupSnapshot();
        if(current.tombstones.length!==0 ||
           current.projects.length!==saved.length ||
           !saved.every(expected=>current.projects.some(item=>
             exact(item,expected))))
          throw Error("Post-ACK library changed");
        setList(await listCasProjects());
        setNotice(t(locale,"casLibraryRestoreDone")+
          " "+saved.length+" "+t(locale,"casLibraryRestoreCount"));
      }catch{
        setList(null);
        setNotice(t(locale,"casLibraryRestorePostAck"));
      }
    });
  }

  function exportLibraryBackup():void {
    if(inFlight.current || pipelineRunning)return;
    void run(async()=>{
      // A consistent, whole-library native IDB snapshot. Any unsaved draft
      // in a selected project stays untouched and is NOT in this archive.
      let ticket;
      try{
        ticket=await prepareCasLibraryRecoveryBundle();
      }catch{
        setError(t(locale,"casLibraryBackupUnavailable"));return;
      }
      const identity=ticket.snapshot.projects.length+" "+t(locale,"casLibraryBackupCount");
      if(!window.confirm(t(locale,"casLibraryBackupConsent")+"\n"+identity))return;
      if(!window.confirm(t(locale,"casLibraryBackupFinalConsent")+"\n"+identity))return;
      let files:Readonly<Record<string,string>>;
      try{
        const confirmed=await confirmCasLibraryRecoveryBundle(ticket,true);
        files=confirmed.files;
      }catch{
        // A race or ambiguous readback cannot authorize download of a
        // silently rebased or partial library. No auto-retry.
        setError(t(locale,"casLibraryBackupStale"));return;
      }
      let downloadUrl:string;
      try{
        // Compare the actual ZIP with the strict import parser before
        // offering a file; 16M characters can encode to >20MB UTF-8.
        const packed=await encodeCasLibraryRecoveryZip({
          fileName:ticket.fileName,
          projectCount:ticket.snapshot.projects.length,
          files,
        });
        // BlobPart requires an owned ArrayBuffer (not ArrayBufferLike).
        // Keep this copy AFTER the restore-parser preflight succeeds.
        const bytes=new Uint8Array(packed.byteLength);
        bytes.set(packed);
        downloadUrl=URL.createObjectURL(new Blob([bytes],{
          type:"application/zip",
        }));
      }catch(error){
        setError(t(locale,error instanceof CasLibraryZipPortabilityError ?
          "casLibraryBackupNotRestorable":"casLibraryBackupUnavailable"));
        return;
      }
      try{
        const link=document.createElement("a");
        link.href=downloadUrl;
        link.download=ticket.fileName;
        document.body.appendChild(link);link.click();link.remove();
        // Browser handoff is NOT proof that the user saved the archive.
        if(window.confirm(t(locale,"casLibraryBackupSavedConfirm")))
          setNotice(t(locale,"casLibraryBackupSaved")+" "+identity);
        else
          setNotice(t(locale,"casLibraryBackupUnverified")+" "+identity);
      }finally{
        setTimeout(()=>URL.revokeObjectURL(downloadUrl),30000);
      }
    });
  }

  function exportSelected():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot;
      // An unsaved human draft must NOT be lost just to export its pinned
      // durable revision. This operation is read-only and never calls accept().
      if(!controller || !expected || controller.state()!=="ready" ||
         !exact(controller.snapshot(),expected))
        throw Error("CAS selection unavailable for exact export");
      const ticket=prepareCasIsolatedExport(expected);
      if(!window.confirm(t(locale,"casIsoExportConsent")+"\n"+
         ticket.id+" / rev. "+ticket.revision))return;

      let raw:string;
      try{
        // Native read-only checks: matching pinned revision/raw, twice more
        // before acknowledging the backup. No stale draft or legacy fallback.
        raw=await confirmCasIsolatedExport(ticket,true);
      }catch{
        setNotice(t(locale,"casIsoExportStale")+
          " ID: "+ticket.id+" / rev. "+ticket.revision);
        return;
      }

      const url=URL.createObjectURL(new Blob([raw],{
        type:"application/json",
      }));
      try{
        const link=document.createElement("a");
        link.href=url;link.download=ticket.fileName;
        document.body.appendChild(link);link.click();link.remove();
        // The browser's download handoff isn't proof of saved disk bytes.
        if(window.confirm(t(locale,"casIsoExportSavedConfirm")))
          setNotice(t(locale,"casIsoExportSaved")+
            " ID: "+ticket.id+" / rev. "+ticket.revision);
        else
          setNotice(t(locale,"casIsoExportUnverified")+
            " ID: "+ticket.id+" / rev. "+ticket.revision);
      }finally{
        setTimeout(()=>URL.revokeObjectURL(url),30000);
      }
    });
  }

  function exportSourceZip():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
         !exact(controller.snapshot(),expected))
        throw Error("Stale CAS source export session");
      // No session settings, PAT, GitHub or pending patch from the live editor.
      // The pure builder includes only the generated baseline + persisted
      // overrides and deliberately drops the unverified history log.
      const ticket=prepareCasIsolatedSourceZip(expected);
      if(!window.confirm(t(locale,"casIsoSourceZipConsent")+"\n"+
         ticket.id+" / rev. "+ticket.revision))return;
      try{
        const verified=await confirmCasIsolatedExport(
          prepareCasIsolatedExport(expected),true);
        if(verified!==ticket.raw)
          throw Error("Stale native IDB source ticket");
      }catch{
        setNotice(t(locale,"casIsoSourceZipStale")+
          " ID: "+ticket.id+" / rev. "+ticket.revision);
        return;
      }

      // No pending proposal in this map. Archive generation is client-side,
      // after native IDB revision+raw readback; there are no project writes.
      const entries:Record<string,Uint8Array>={};
      for(const [file,body] of Object.entries(ticket.files).sort(
        ([a],[b])=>a.localeCompare(b)))
        entries[file]=strToU8(body);
      const zipped=zipSync(entries,{level:6});
      const bytes=new Uint8Array(zipped.length);bytes.set(zipped);
      const url=URL.createObjectURL(new Blob([bytes],{
        type:"application/zip",
      }));
      try{
        const link=document.createElement("a");
        link.href=url;link.download=ticket.fileName;
        document.body.appendChild(link);link.click();link.remove();
        // Browser handoff is NOT evidence of persistence on disk.
        if(window.confirm(t(locale,"casIsoSourceZipSavedConfirm")))
          setNotice(t(locale,"casIsoSourceZipSaved")+
            " ID: "+ticket.id+" / rev. "+ticket.revision);
        else
          setNotice(t(locale,"casIsoSourceZipUnverified")+
            " ID: "+ticket.id+" / rev. "+ticket.revision);
      }finally{
        setTimeout(()=>URL.revokeObjectURL(url),30000);
      }
    });
  }

  function saveManualStage():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot,stage=manualStage;
      if(!controller || !expected || controller.state()!=="ready" ||
         configDirty || codeRequest.length>0 || codeProposalJson.length>0 ||
         !exact(controller.snapshot(),expected))
        throw Error("Stale/dirty CAS manual stage commit");
      // Build before the first dialog: reject blank/oversize, running and
      // unready predecessors, never fabricate AI/runner/test evidence.
      const candidate=buildCasIsolatedManualStage(expected,stage,manualOutput);
      if(!window.confirm(t(locale,"casIsoManualBackupConfirm")+"\n"+
        stage+" / "+expected.id+" / rev. "+expected.revision))return;
      const url=URL.createObjectURL(new Blob([expected.raw],{
        type:"application/json",
      }));
      const link=document.createElement("a");
      link.href=url;
      link.download="softwarefactory-cas-before-human-stage-"+expected.id+
        "-r"+expected.revision+".json";
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      if(!window.confirm(t(locale,"casIsoManualSavedConfirm")))return;
      if(!window.confirm(t(locale,"casIsoManualFinalConfirm")+"\n"+
        stage+" / "+expected.id+" / rev. "+expected.revision))return;
      // Exactly one native CAS write. A competitor is fenced by revision+raw
      // *inside* the transaction; no retries or silent adoption.
      const committed=await commitSelectedWithProbe(controller,candidate,expected);
      if(!exact(committed,{
        id:candidate.id,revision:expected.revision+1,
        raw:JSON.stringify(candidate),
      }))throw Error("Inconsistent manual CAS ACK");
      // Clearing human text is permitted only after oncomplete ACK.
      accept(committed);setList(null);
      setNotice(t(locale,"casIsoManualDone")+
        " ("+stage+", rev. "+committed.revision+")");
    });
  }

  function stageCodeProposal():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
         configDirty || manualOutput.length>0 ||
         !exact(controller.snapshot(),expected))
        throw Error("Stale/dirty CAS Code Agent pending write");
      // Validate using the SAME domain allowlist and workspace conflict
      // checks as the real Code Agent, but do not call any AI provider,
      // review service, test runner, GitHub or live localStorage writer.
      const candidate=buildCasIsolatedPendingCodePatch(
        expected,codeRequest,codeProposalJson);
      if(!window.confirm(t(locale,"casIsoCodeBackupConfirm")+"\n"+
         expected.id+" / rev. "+expected.revision))return;
      const url=URL.createObjectURL(new Blob([expected.raw],{
        type:"application/json",
      }));
      const link=document.createElement("a");
      link.href=url;
      link.download="softwarefactory-cas-before-code-pending-"+expected.id+
        "-r"+expected.revision+".json";
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      if(!window.confirm(t(locale,"casIsoCodeBackupSavedConfirm")))return;
      if(!window.confirm(t(locale,"casIsoCodeFinalConfirm")+"\n"+
         expected.id+" / rev. "+expected.revision))return;
      const committed=await commitSelectedWithProbe(controller,candidate,expected);
      if(!exact(committed,{
        id:candidate.id,revision:expected.revision+1,
        raw:JSON.stringify(candidate),
      }))throw Error("Inconsistent Code Agent pending CAS ACK");
      // Never clear the pasted code draft or advance the selected revision
      // before native IndexedDB transaction oncomplete.
      accept(committed);setList(null);
      setNotice(t(locale,"casIsoCodeDone")+
        " (rev. "+committed.revision+")");
    });
  }

  function discardCodeProposal():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
         dirty || !exact(controller.snapshot(),expected))
        throw Error("Stale/dirty CAS pending Code Agent discard");
      const candidate=buildCasIsolatedDiscardPendingCodePatch(expected);
      if(!window.confirm(t(locale,"casIsoCodeDiscardBackupConfirm")+"\n"+
         expected.id+" / rev. "+expected.revision))return;
      const url=URL.createObjectURL(new Blob([expected.raw],{
        type:"application/json",
      }));
      const link=document.createElement("a");
      link.href=url;
      link.download="softwarefactory-cas-before-code-discard-"+expected.id+
        "-r"+expected.revision+".json";
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      if(!window.confirm(t(locale,"casIsoCodeDiscardSavedConfirm")))return;
      if(!window.confirm(t(locale,"casIsoCodeDiscardFinalConfirm")+"\n"+
         expected.id+" / rev. "+expected.revision))return;
      const committed=await commitSelectedWithProbe(controller,candidate,expected);
      if(!exact(committed,{
        id:candidate.id,revision:expected.revision+1,
        raw:JSON.stringify(candidate),
      }))throw Error("Inconsistent Code Agent discard CAS ACK");
      accept(committed);setList(null);
      setNotice(t(locale,"casIsoCodeDiscardDone")+
        " (rev. "+committed.revision+")");
    });
  }

  function applyHumanCodeProposal():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
         dirty || !exact(controller.snapshot(),expected) ||
         !canApplyCasIsolatedHumanPendingPatch(expected))
        throw Error("Stale/unsafe CAS human code apply");
      // No change to live, no reviewer test claim. Every file must be fully
      // visible in the inert before/after preview (no 1600-char truncation).
      const candidate=buildCasIsolatedHumanApplyPendingPatch(expected);
      const applied=candidate.development!.humanApplications!;
      const record=applied[applied.length-1];
      if(!window.confirm(t(locale,"casIsoHumanApplyBackupConfirm")+"\n"+
         expected.id+" / rev. "+expected.revision+"\n"+
         record.paths.join("\n")))return;
      const url=URL.createObjectURL(new Blob([expected.raw],{
        type:"application/json",
      }));
      try{
        const link=document.createElement("a");
        link.href=url;
        link.download="softwarefactory-cas-before-human-apply-"+
          expected.id+"-r"+expected.revision+".json";
        document.body.appendChild(link);link.click();link.remove();
      }finally{setTimeout(()=>URL.revokeObjectURL(url),30000);}
      if(!window.confirm(t(locale,"casIsoHumanApplySavedConfirm")))return;
      if(!window.confirm(t(locale,"casIsoHumanApplyFinalConfirm")+"\n"+
         expected.id+" / rev. "+expected.revision+"\n"+
         record.paths.join("\n")))return;
      // One native IndexedDB write with exact ID/revision/raw inside tx.
      // On a rival win, controller blocks; retain pending and any drafts.
      const committed=await commitSelectedWithProbe(controller,candidate,expected);
      if(!exact(committed,{
        id:candidate.id,revision:expected.revision+1,
        raw:JSON.stringify(candidate),
      }))throw Error("Inconsistent human patch CAS ACK");
      accept(committed);setList(null);
      setNotice(t(locale,"casIsoHumanApplyDone")+
        " ID: "+committed.id+" (rev. "+committed.revision+")");
    });
  }

  function undoHumanCodeApplication():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
         dirty || !exact(controller.snapshot(),expected))
        throw Error("Stale/dirty CAS human undo");
      const ticket=prepareCasIsolatedHumanUndo(expected);
      const candidate=buildCasIsolatedHumanUndo(expected);
      if(!window.confirm(t(locale,"casIsoHumanUndoBackupConfirm")+"\n"+
        ticket.id+" / rev. "+ticket.revision+"\n"+
        ticket.files.map(f=>f.path).join("\n")))return;
      const url=URL.createObjectURL(new Blob([expected.raw],{
        type:"application/json",
      }));
      try{
        const link=document.createElement("a");
        link.href=url;
        link.download="softwarefactory-cas-before-human-undo-"+
          ticket.id+"-r"+ticket.revision+".json";
        document.body.appendChild(link);link.click();link.remove();
      }finally{setTimeout(()=>URL.revokeObjectURL(url),30000);}
      if(!window.confirm(t(locale,"casIsoHumanUndoSavedConfirm")))return;
      if(!window.confirm(t(locale,"casIsoHumanUndoFinalConfirm")+"\n"+
        ticket.id+" / rev. "+ticket.revision+"\n"+
        ticket.files.map(f=>f.path).join("\n")))return;
      // Sole native compare-and-swap. A rival writer cannot be overwritten:
      // no retry, rebase, fallback to legacy or source patch reconstruction.
      const committed=await commitSelectedWithProbe(controller,candidate,expected);
      if(!exact(committed,{
        id:candidate.id,revision:expected.revision+1,
        raw:JSON.stringify(candidate),
      }))throw Error("Inconsistent human undo CAS ACK");
      accept(committed);setList(null);
      setNotice(t(locale,"casIsoHumanUndoDone")+" ID: "+committed.id+
        " (rev. "+committed.revision+")");
    });
  }

  function resetStage():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
         dirty || !exact(controller.snapshot(),expected))
        throw Error("Stale CAS stage reset or unsaved config draft");
      const candidate=buildCasIsolatedStageReset(expected,stageToReset);
      if(!window.confirm(t(locale,"casIsoStageResetBackupConfirm")+
        "\\n"+stageToReset+" / "+expected.id+" / rev. "+expected.revision))
        return;
      // Exact ORIGINAL JSON, including any historical AI output/receipts.
      // This is a deliberate export, never a hidden fallback or upload.
      const url=URL.createObjectURL(new Blob([expected.raw],{
        type:"application/json",
      }));
      const link=document.createElement("a");
      link.href=url;
      link.download="softwarefactory-cas-before-stage-reset-"+expected.id+
        "-r"+expected.revision+".json";
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      if(!window.confirm(t(locale,"casIsoStageResetSavedConfirm")))return;
      if(!window.confirm(t(locale,"casIsoStageResetFinalConfirm")+
        "\\n"+stageToReset+" / "+expected.id+" / rev. "+expected.revision))
        return;
      const committed=await commitSelectedWithProbe(controller,candidate,expected);
      if(!exact(committed,{
        id:candidate.id,revision:expected.revision+1,
        raw:JSON.stringify(candidate),
      }))throw Error("Inconsistent CAS stage reset ACK");
      accept(committed);setList(null);
      setNotice(t(locale,"casIsoStageResetDone")+
        " ("+stageToReset+", rev. "+committed.revision+")");
    });
  }

  function recoverRunningStage():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
         dirty || pipelineRunning || !exact(controller.snapshot(),expected))
        throw Error("Stale running CAS recovery or active local work");
      const ticket=prepareCasRunningRecovery(expected);
      if(!window.confirm(t(locale,"casIsoRunningRecoveryBackupConfirm")+
          "\n"+ticket.stage+" / "+expected.id+" / rev. "+expected.revision))
        return;
      const url=URL.createObjectURL(new Blob([expected.raw],{
        type:"application/json",
      }));
      const link=document.createElement("a");
      link.href=url;
      link.download="softwarefactory-cas-before-running-recovery-"+expected.id+
        "-r"+expected.revision+".json";
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      if(!window.confirm(t(locale,"casIsoRunningRecoverySavedConfirm")))return;
      if(!window.confirm(t(locale,"casIsoRunningRecoveryFinalConfirm")+
          "\n"+ticket.stage+" / "+expected.id+" / rev. "+expected.revision))
        return;
      // A rival writer during the dialogs wins the same native IDB compare.
      // No retry, rebase, remote cancellation claim, or localStorage fallback.
      const committed=await commitSelectedWithProbe(controller,ticket.candidate,expected);
      if(!exact(committed,{
        id:ticket.candidate.id,revision:expected.revision+1,
        raw:JSON.stringify(ticket.candidate),
      }))throw Error("Inconsistent running recovery ACK");
      accept(committed);setList(null);
      setNotice(t(locale,"casIsoRunningRecoveryDone")+
        " ("+ticket.stage+", rev. "+committed.revision+")");
    });
  }

  function executeCasStage():void {
    void run(async()=>{
      const controller=active.current,expected=snapshot,stage=stageToRun;
      if(!controller || !expected || controller.state()!=="ready" ||
         dirty || !exact(controller.snapshot(),expected) ||
         !canBeginCasPipelineStage(expected,stage))
        throw Error("Invalid isolated CAS pipeline preflight");

      // Provider config is checked BEFORE the first native IDB write.
      // All settings are non-secret; the AI token remains in sessionStorage.
      const capturedSettings=structuredClone(settings);
      const {profile}=resolveAgentRoute(
        capturedSettings,stageAgentRole(stage),stage);
      validateAiEndpoint(profile.baseUrl);

      if(!window.confirm(t(locale,"casIsoPipelineBackupConfirm")+
          "\n"+stage+" / "+expected.id+" / rev. "+expected.revision))return;
      const url=URL.createObjectURL(new Blob([expected.raw],{
        type:"application/json",
      }));
      const link=document.createElement("a");
      link.href=url;
      link.download="softwarefactory-cas-before-ai-stage-"+expected.id+
        "-r"+expected.revision+".json";
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      if(!window.confirm(t(locale,"casIsoPipelineSavedConfirm")))return;
      // Explicit consent before provider disclosure; research stages can
      // additionally query the configured search gateway.
      if(!window.confirm(t(locale,"casIsoPipelineProviderConfirm")+
          "\n"+stage+" / "+profile.baseUrl))return;

      const pipeline=await openCasPipelineSession(expected.id);
      if(!exact(pipeline.snapshot(),expected))
        throw Error("CAS project changed during provider consent");
      // tx.oncomplete for "running" MUST happen before any provider request.
      let ticket:CasPipelineRunTicket;
      try{
        ticket=await pipeline.begin(stage);
      }catch(error){
        if(pipeline.state()==="blocked"){
          preserveBlockedPipeline(pipeline,expected);
          return;
        }
        throw error;
      }
      // Keep the durable running checkpoint as the read-only selection.
      // Never retain a controller pointing to the earlier revision.
      active.current=null;
      accept(ticket.started);
      const cancellation=new AbortController();
      pipelineAbort.current=cancellation;
      setPipelineRunning(true);
      setPipelineStatus(t(locale,"casIsoPipelineRunning")+
        " ("+stage+", rev. "+ticket.started.revision+")");
      let ack:CasProjectSnapshot|null=null;
      let outcome:"complete"|"abort"|"fail"="complete";
      let providerReturned=false;
      try{
        const project=JSON.parse(ticket.started.raw) as FactoryProject;
        const response=await runStage(
          project,capturedSettings,stage,cancellation.signal);
        providerReturned=true;
        // Cancellation applies only to pending network I/O, never an
        // already submitted native commit.
        pipelineAbort.current=null;
        if(cancellation.signal.aborted){
          outcome="abort";
          ack=await pipeline.abort(ticket);
        }else{
          ack=await pipeline.complete(
            ticket,response.output,response.sources);
        }
      }catch{
        pipelineAbort.current=null;
        if(pipeline.state()!=="ready"){
          preserveBlockedPipeline(pipeline,ticket.started);
          return;
        }
        outcome=cancellation.signal.aborted?"abort":"fail";
        try{
          ack=outcome==="abort"?
            await pipeline.abort(ticket):
            await pipeline.fail(ticket,
              providerReturned?"invalid_result":"provider");
        }catch{
          preserveBlockedPipeline(pipeline,ticket.started);
          return;
        }
      }finally{
        pipelineAbort.current=null;
        setPipelineRunning(false);
        setPipelineStatus("");
      }

      // Native oncomplete ACK remains valid even when read-only readback
      // fails or another writer advanced the row. Never retry the AI call.
      if(!ack)throw Error("Native CAS pipeline ACK unavailable");
      const identity=" ID: "+ack.id+" / rev. "+ack.revision;
      try{
        const reopened=await openCasSelectionController(ack.id);
        if(!exact(reopened.snapshot(),ack))
          throw Error("Post-ACK readback no longer exact");
        active.current=reopened;
        accept(ack);setList(null);
        setNotice(t(locale,outcome==="complete"?"casIsoPipelineDone":
          outcome==="abort"?"casIsoPipelineAborted":"casIsoPipelineFailed")+
          identity);
      }catch{
        active.current=null;setSnapshot(null);setList(null);
        setDraftName("");setDraftDescription("");setDraftRequirements("");
        setDraftStack(null);
        setNotice(t(locale,"casIsoPipelinePostAckWarning")+identity);
      }
    });
  }

  return <section className="panel" data-testid="cas-isolated-editor">
    <div className="panel-title"><div>
      <span className="eyebrow">INDEXEDDB / CAS</span>
      <h3>{t(locale,"casIsoTitle")}</h3>
    </div></div>
    <p className="helper">{t(locale,"casIsoExplain")}</p>
    {handoff && <div data-testid="cas-root-handoff-hint">
      <p className="helper">{t(locale,"casHandoffHintExplain")}</p>
      <p><strong>ID:</strong> {handoff.id} · rev. {handoff.revision}</p>
      <button type="button" className="secondary"
        data-testid="cas-root-handoff-open"
        disabled={working || Boolean(snapshot) || Boolean(active.current)}
        onClick={openHandoffHint}>
        {t(locale,"casHandoffOpenAction")}
      </button>
    </div>}
    {!expanded ? <button type="button" className="secondary"
      onClick={()=>setExpanded(true)}>{t(locale,"casIsoOpenPanel")}</button> : <>
      <div className="row">
        {onRequestLegacy && <button type="button" className="secondary"
          data-testid="cas-root-return-action"
          disabled={working || pipelineRunning}
          onClick={returnToLegacy}>
          {t(locale,"casRootExitAction")}
        </button>}
        <button type="button" className="secondary" disabled={working}
          onClick={refresh}>{t(locale,"casIsoRefresh")}</button>
        <button type="button" className="secondary" disabled={working}
          onClick={close}>{t(locale,"casIsoClose")}</button>
      </div>
      <div data-testid="cas-isolated-create">
        <p className="helper">{t(locale,"casIsoCreateExplain")}</p>
        <label>{t(locale,"casIsoCreateName")}
          <input value={newProjectName} maxLength={CAS_ISOLATED_NAME_MAX}
            disabled={working || Boolean(snapshot)}
            onChange={e=>setNewProjectName(e.target.value)}/>
        </label>
        <label>{t(locale,"casIsoCreateDescription")}
          <textarea value={newProjectDescription}
            maxLength={CAS_ISOLATED_DESCRIPTION_MAX}
            disabled={working || Boolean(snapshot)}
            onChange={e=>setNewProjectDescription(e.target.value)}/>
        </label>
        <button type="button" className="secondary"
          disabled={working || Boolean(snapshot) || !newProjectName.trim()}
          onClick={createFresh}>{t(locale,"casIsoCreateAction")}</button>
      </div>
      <div data-testid="cas-isolated-import-config">
        <p className="helper">{t(locale,"casIsoImportExplain")}</p>
        <label>{t(locale,"casIsoImportLabel")}
          <input type="file" accept=".json,application/json"
            data-testid="cas-isolated-import-file"
            disabled={working || Boolean(snapshot) || pipelineRunning}
            onChange={e=>{
              const file=e.currentTarget.files?.[0];
              e.currentTarget.value="";
              if(file)importBackupFile(file);
            }}/>
        </label>
      </div>
      <div data-testid="cas-isolated-tombstone-restore">
        <p className="helper">{t(locale,"casIsoRestoreExplain")}</p>
        <label>{t(locale,"casIsoRestoreLabel")}
          <input type="file" accept=".json,application/json"
            data-testid="cas-isolated-tombstone-restore-file"
            disabled={working || Boolean(snapshot) || pipelineRunning}
            onChange={e=>{
              const file=e.currentTarget.files?.[0];
              e.currentTarget.value="";
              if(file)restoreDeletedCasBackup(file);
            }}/>
        </label>
      </div>
      {onRequestLegacy && <section data-testid="cas-library-zip-restore">
        <p className="helper">{t(locale,"casLibraryRestoreExplain")}</p>
        <label>{t(locale,"casLibraryRestoreLabel")}
          <input type="file" accept=".zip,application/zip"
            data-testid="cas-library-zip-restore-file"
            disabled={working || Boolean(snapshot) ||
              Boolean(active.current) || pipelineRunning}
            onChange={e=>{
              const file=e.currentTarget.files?.[0];
              e.currentTarget.value="";
              if(file)restoreWholeCasLibraryZip(file);
            }}/>
        </label>
      </section>}
      <section data-testid="cas-uncommitted-draft-inspection">
        <p className="helper">{t(locale,"casIsoDraftInspectExplain")}</p>
        <label>{t(locale,"casIsoDraftInspectLabel")}
          <input type="file" accept=".json,application/json"
            data-testid="cas-uncommitted-draft-inspect-file"
            disabled={working || pipelineRunning}
            onChange={e=>{
              const file=e.currentTarget.files?.[0];
              e.currentTarget.value="";
              if(file)inspectOfflineUncommittedDraft(file);
            }}/>
        </label>
        {emergencyPreview && <div
          data-testid="cas-uncommitted-draft-preview">
          <p role="status">{t(locale,"casIsoDraftInspectWarning")}</p>
          <p><strong>{t(locale,"casIsoDraftInspectIdentity")}</strong>
            {" "+emergencyPreview.id+" / rev. "+emergencyPreview.revision}
          </p>
          <p><strong>{t(locale,"casIsoDraftInspectBaseName")}</strong>
            {" "+emergencyPreview.originalName}</p>
          <p><strong>{t(locale,"casIsoDraftInspectName")}</strong></p>
          <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
            maxHeight:180,overflow:"auto"}}>{emergencyPreview.config.name}</pre>
          <p><strong>{t(locale,"casIsoDraftInspectDescription")}</strong></p>
          <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
            maxHeight:180,overflow:"auto"}}>{emergencyPreview.config.description}</pre>
          <p><strong>{t(locale,"casIsoDraftInspectRequirements")}</strong></p>
          <pre data-testid="cas-uncommitted-draft-requirements"
            style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
              maxHeight:180,overflow:"auto"}}>
            {emergencyPreview.config.requirements}
          </pre>
          <p><strong>{t(locale,"casIsoDraftInspectStack")}</strong></p>
          <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
            maxHeight:180,overflow:"auto"}}>
            {emergencyPreview.stack===null ? "-" :
              JSON.stringify(emergencyPreview.stack,null,2)}
          </pre>
          <p><strong>{t(locale,"casIsoDraftInspectManual")}</strong>
            {" "+emergencyPreview.manualStage}</p>
          <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
            maxHeight:180,overflow:"auto"}}>{emergencyPreview.manualOutput}</pre>
          <p><strong>{t(locale,"casIsoDraftInspectCodeRequest")}</strong></p>
          <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
            maxHeight:180,overflow:"auto"}}>{emergencyPreview.codeRequest}</pre>
          <p><strong>{t(locale,"casIsoDraftInspectCodeJson")}</strong></p>
          <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
            maxHeight:180,overflow:"auto"}}>{emergencyPreview.codeProposalJson}</pre>
          <p className="helper">{t(locale,"casIsoDraftCopyExplain")}</p>
          <button type="button" className="secondary"
            data-testid="cas-uncommitted-draft-copy-action"
            disabled={working || !canCopyCasUncommittedDraftLocally(
              emergencyPreview,snapshot,
              Boolean(active.current?.state()==="ready" &&
                snapshot && exact(active.current.snapshot(),snapshot)),
              dirty,pipelineRunning)}
            onClick={copyUncommittedDraftIntoForm}>
            {t(locale,"casIsoDraftCopyAction")}
          </button>
          <button type="button" className="secondary"
            data-testid="cas-uncommitted-draft-clear-preview"
            disabled={working}
            onClick={()=>setEmergencyPreview(null)}>
            {t(locale,"casIsoDraftInspectClear")}
          </button>
        </div>}
      </section>
      <section data-testid="cas-library-backup">
        <p className="helper">{t(locale,"casLibraryBackupExplain")}</p>
        <button type="button" className="secondary"
          data-testid="cas-library-backup-action"
          disabled={working || pipelineRunning}
          onClick={exportLibraryBackup}>{t(locale,"casLibraryBackupAction")}</button>
      </section>
      <section data-testid="cas-isolated-tombstone-inventory">
        <p className="helper">{t(locale,"casIsoTombstoneExplain")}</p>
        <button type="button" className="secondary"
          data-testid="cas-tombstone-scan"
          disabled={working || pipelineRunning}
          onClick={scanDeleted}>{t(locale,"casIsoTombstoneScan")}</button>
        {deleted!==null && <div data-testid="cas-tombstone-results">
          <p className="helper">{t(locale,"casIsoTombstoneSnapshot")}</p>
          {deleted.length===0 ? <p>{t(locale,"casIsoTombstoneEmpty")}</p> :
            <ul>{deleted.map(row=><li key={row.id}>
              <code>{row.id}</code> · rev. {row.revision}
            </li>)}</ul>}
        </div>}
      </section>
      {list!==null && <div data-testid="cas-isolated-library">
        {list.length===0 ? <p>{t(locale,"casIsoEmpty")}</p> :
          <ul>{list.map(choice=><li key={choice.id}>
            {choice.name} · rev. {choice.revision}
            <button type="button" className="secondary" disabled={working}
              aria-label={t(locale,"casIsoChoose")+": "+choice.name}
              onClick={()=>choose(choice)}>{t(locale,"casIsoChoose")}</button>
          </li>)}</ul>}
      </div>}
      {snapshot && <div data-testid="cas-isolated-active">
        <p><strong>{t(locale,"casIsoSelected")}</strong> ·
          rev. {snapshot.revision} · {snapshot.id}</p>
        <section data-testid="cas-isolated-uncommitted-draft-backup">
          <p className="helper">{t(locale,"casIsoDraftBackupExplain")}</p>
          <button type="button" className="secondary"
            data-testid="cas-isolated-draft-backup-action"
            disabled={working || pipelineRunning || !dirty}
            onClick={exportUncommittedDraft}>
            {t(locale,"casIsoDraftBackupAction")}
          </button>
        </section>
        {failedWrite && exact(failedWrite.old,snapshot) &&
          <section data-testid="cas-failed-write-inspection">
            <p className="helper">{t(locale,"casFailedWriteIntro")}</p>
            {pipelineFailedWrite && pipelineFailedWrite.ticket===failedWrite &&
              <p data-testid="cas-pipeline-failed-write-operation">
                {t(locale,"casPipelineFailedWriteOperation")}{" "}
                {t(locale,pipelineFailedWrite.operation==="begin"?
                  "casPipelineWriteBegin":pipelineFailedWrite.operation==="complete"?
                  "casPipelineWriteComplete":pipelineFailedWrite.operation==="abort"?
                  "casPipelineWriteAbort":"casPipelineWriteFail")}
                {" · "+pipelineFailedWrite.stage+" · rev. "+failedWrite.old.revision}
              </p>}
            <button type="button" className="secondary"
              data-testid="cas-failed-write-inspect-action"
              disabled={working || pipelineRunning}
              onClick={inspectBlockedWrite}>
              {t(locale,"casFailedWriteAction")}
            </button>
            <p className="helper">{t(locale,"casFailedWriteBackupExplain")}</p>
            <button type="button" className="secondary"
              data-testid="cas-failed-write-backup-action"
              disabled={working || pipelineRunning}
              onClick={exportFailedWriteBackup}>
              {t(locale,"casFailedWriteBackupAction")}
            </button>
            {failedWriteObservation &&
              <p data-testid="cas-failed-write-inspection-result">
                {t(locale,failedWriteObservation.state==="unchanged"?
                  "casFailedWriteUnchanged":
                  failedWriteObservation.state==="candidate_present"?
                    "casFailedWriteCandidatePresent":
                  failedWriteObservation.state==="diverged"?
                    "casFailedWriteDiverged":
                  failedWriteObservation.state==="tombstone"?
                    "casFailedWriteTombstone":"casFailedWriteMissing")}
                {failedWriteObservation.observedRevision===null?"":(
                  " / rev. "+failedWriteObservation.observedRevision)}
              </p>}
          </section>}
        {onRequestLegacy && <div data-testid="cas-selected-revision-check">
          <p className="helper">{t(locale,"casRevisionCheckExplain")}</p>
          <button type="button" className="secondary"
            data-testid="cas-selected-revision-check-action"
            disabled={working || pipelineRunning ||
              active.current?.state()!=="ready"}
            onClick={recheckSelectedRevision}>
            {t(locale,"casRevisionCheckAction")}
          </button>
        </div>}
        {onRequestLegacy && <div data-testid="cas-revision-resume">
          <p className="helper">{t(locale,"casResumeExplain")}</p>
          <button type="button" className="secondary"
            data-testid="cas-resume-generate"
            disabled={working || pipelineRunning || Boolean(dirty) ||
              active.current?.state()!=="ready"}
            onClick={generateResumeLink}>
            {t(locale,"casResumeAction")}
          </button>
          {shownResumeLink && <label>{t(locale,"casResumeLinkLabel")}
            <input type="text" readOnly value={shownResumeLink.url}
              data-testid="cas-resume-url"
              aria-label={t(locale,"casResumeLinkLabel")}
              onFocus={e=>e.currentTarget.select()}/>
            <small>{t(locale,"casResumePinned")} · rev. {shownResumeLink.revision}</small>
          </label>}
        </div>}
        <label>{t(locale,"casIsoName")}
          <input value={draftName} maxLength={CAS_ISOLATED_NAME_MAX}
            disabled={working || !active.current}
            onChange={e=>setDraftName(e.target.value)}/>
        </label>
        <label>{t(locale,"casIsoDescription")}
          <textarea value={draftDescription}
            maxLength={CAS_ISOLATED_DESCRIPTION_MAX}
            disabled={working || !active.current}
            onChange={e=>setDraftDescription(e.target.value)}/>
        </label>
        <label>{t(locale,"casIsoRequirements")}
          <textarea value={draftRequirements}
            maxLength={CAS_ISOLATED_REQUIREMENTS_MAX}
            disabled={working || !active.current}
            onChange={e=>setDraftRequirements(e.target.value)}/>
        </label>
        <div data-testid="cas-isolated-full-stack">
          <h4>{t(locale,"casIsoStackTitle")}</h4>
          <p className="helper">{t(locale,"casIsoStackExplain")}</p>
          {draftStack===null ?
            <p className="helper" data-testid="cas-isolated-stack-unavailable">
              {t(locale,"casIsoStackUnavailable")}
            </p>:
            <details>
              <summary>{t(locale,"casIsoStackExpand")}</summary>
              <fieldset>
                <legend>{t(locale,"casIsoStackFrontend")}</legend>
                {CAS_STACK_FRONTENDS.map(frontend=>
                  <label key={frontend} className="checkline">
                    <input type="checkbox"
                      data-testid={"cas-isolated-stack-frontend-"+frontend}
                      disabled={working || !active.current}
                      checked={draftStack.frontends.includes(frontend)}
                      onChange={e=>setDraftStack(current=>{
                        if(!current)return current;
                        return {...current,
                          frontends:e.target.checked ?
                            [...current.frontends,frontend] :
                            current.frontends.filter(f=>f!==frontend),
                        };
                      })}/>
                    {frontend}
                  </label>)}
              </fieldset>
              <label>{t(locale,"casIsoStackDeployment")}
                <select data-testid="cas-isolated-stack-deployment"
                  disabled={working || !active.current}
                  value={draftStack.deployment}
                  onChange={e=>setDraftStack(current=>current?
                    {...current,deployment:e.target.value as DeploymentTarget}:
                    current)}>
                  {CAS_STACK_DEPLOYMENTS.map(value=>
                    <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label>{t(locale,"casIsoStackDotnet")}
                <select data-testid="cas-isolated-stack-dotnet"
                  disabled={working || !active.current}
                  value={draftStack.dotnetVersion}
                  onChange={e=>setDraftStack(current=>current?
                    {...current,dotnetVersion:e.target.value as
                      ProjectConfig["dotnetVersion"]}:current)}>
                  <option value="11.0">.NET 11</option>
                  <option value="10.0">.NET 10</option>
                </select>
              </label>
              <label>{t(locale,"casIsoStackDatabase")}
                <select data-testid="cas-isolated-stack-database"
                  disabled={working || !active.current}
                  value={draftStack.database}
                  onChange={e=>setDraftStack(current=>current?
                    {...current,database:e.target.value as
                      ProjectConfig["database"]}:current)}>
                  {CAS_STACK_DATABASES.map(value=>
                    <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <h4>{t(locale,"casIsoStackServices")}</h4>
              {SERVICE_KINDS.map(kind=><div
                data-testid={"cas-isolated-stack-service-"+kind}
                key={kind}>
                <strong>{SERVICE_LABELS[kind]}</strong>
                {(["development","production"] as EnvironmentName[])
                  .map(env=><label key={env}>
                    {t(locale,env==="development" ?
                      "casIsoStackDev":"casIsoStackProd")}
                    <select
                      data-testid={"cas-isolated-stack-"+kind+"-"+env}
                      disabled={working || !active.current}
                      value={draftStack.services[kind][env]}
                      onChange={e=>setDraftStack(current=>{
                        if(!current)return current;
                        const services={...current.services,
                          [kind]:{...current.services[kind],
                            [env]:e.target.value}};
                        return {...current,services};
                      })}>
                      {SERVICE_OPTIONS[kind].map(value=>
                        <option key={value} value={value}>{value}</option>)}
                    </select>
                  </label>)}
              </div>)}
              {stackDirty && <p className="helper"
                data-testid="cas-isolated-stack-dirty">
                {t(locale,"casIsoStackDirty")}
              </p>}
            </details>}
        </div>
        <p className="helper">{t(locale,"casIsoInvalidate")}</p>
        <button type="button" className="secondary"
          disabled={working || !configDirty || manualOutput.length>0 ||
              codeRequest.length>0 || codeProposalJson.length>0 ||
              !active.current}
          onClick={save}>{t(locale,"casIsoSave")}</button>
        <div data-testid="cas-isolated-config-fork">
          <p className="helper">{t(locale,"casIsoForkExplain")}</p>
          <button type="button" className="secondary"
            data-testid="cas-isolated-config-fork-action"
            disabled={working || Boolean(dirty) || !active.current ||
              active.current.state()!=="ready" || !snapshot}
            onClick={forkConfig}>
            {t(locale,"casIsoForkAction")}
          </button>
        </div>
        <div data-testid="cas-isolated-full-export">
          <p className="helper">{t(locale,"casIsoExportExplain")}</p>
          <button type="button" className="secondary"
            disabled={working || !active.current ||
              active.current.state()!=="ready" || !snapshot}
            onClick={exportSelected}>
            {t(locale,"casIsoExportAction")}
          </button>
        </div>
        <div data-testid="cas-isolated-source-zip">
          <p className="helper">{t(locale,"casIsoSourceZipExplain")}</p>
          <button type="button" className="secondary"
            data-testid="cas-isolated-source-zip-action"
            disabled={working || !active.current ||
              active.current.state()!=="ready" || !snapshot}
            onClick={exportSourceZip}>
            {t(locale,"casIsoSourceZipAction")}
          </button>
        </div>
        <div data-testid="cas-isolated-stage-inspection">
          <h4>{t(locale,"casIsoInspectTitle")}</h4>
          <p className="helper">{t(locale,"casIsoInspectExplain")}</p>
          {inspectedStages===null ?
            <p className="helper" data-testid="cas-isolated-inspection-unavailable">
              {t(locale,"casIsoInspectInvalidSnapshot")}
            </p>:
            <ol>{inspectedStages.map((stage,index)=>
              <li key={stage.id}
                data-testid={"cas-isolated-stage-"+stage.id}>
                <strong>{STAGES[index].label}</strong>{" · "}
                <span data-testid="cas-isolated-stage-status">
                  {t(locale,CAS_INSPECTION_STATUS_KEY[stage.status])}
                </span>
                {stage.status==="running" &&
                  <p className="helper">
                    {t(locale,"casIsoInspectRunningRecovery")}
                  </p>}
                {stage.status==="complete" &&
                  <p className="helper" data-testid="cas-isolated-stage-origin">
                    {t(locale,stage.completionOrigin==="manual"?
                      "casIsoOriginManual":stage.completionOrigin==="ai"?
                      "casIsoOriginAi":"casIsoOriginUnknown")}
                    {" · "}{t(locale,"casIsoInspectNotVerified")}
                  </p>}
                {stage.status==="failed" &&
                  <p className="helper">
                    {t(locale,"casIsoInspectFailedInfo")}
                  </p>}
                {stage.status==="invalid" &&
                  <p className="helper">
                    {t(locale,"casIsoInspectInconsistentInfo")}
                  </p>}
                {stage.output && <details>
                  <summary>{t(locale,"casIsoInspectOutput")}
                    {stage.outputTruncated ?
                      " · "+t(locale,"casIsoInspectTruncated") : ""}
                  </summary>
                  {/* React renders historical model text as TEXT, never HTML. */}
                  <pre data-testid="cas-isolated-stage-output"
                    style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>
                    {stage.output}
                  </pre>
                </details>}
                {stage.sourceTotal>0 && <details>
                  <summary>{t(locale,"casIsoInspectSources")}
                    {" ("+stage.sourceTotal+")"}
                    {stage.sourcesTruncated ?
                      " · "+t(locale,"casIsoInspectTruncated") : ""}
                  </summary>
                  <p className="helper">
                    {t(locale,"casIsoInspectSourcesUntrusted")}
                  </p>
                  <ul>{stage.sources.map((source,i)=>
                    <li key={i}>
                      {source.href?
                        <a data-testid="cas-isolated-source-link"
                          href={source.href} target="_blank"
                          rel="noopener noreferrer nofollow">
                          {source.title ||
                            t(locale,"casIsoInspectUnknownSource")}
                        </a>:
                        <span data-testid="cas-isolated-untrusted-source">
                          {source.title ||
                            t(locale,"casIsoInspectUnknownSource")}
                          {" · "+t(locale,"casIsoInspectUnsafeSource")}
                        </span>}
                      {source.snippet && <p className="helper">
                        {source.snippet}
                      </p>}
                    </li>)}</ul>
                </details>}
              </li>)}</ol>}
        </div>
        <div data-testid="cas-isolated-manual-stage">
          <h4>{t(locale,"casIsoManualTitle")}</h4>
          <p className="helper">{t(locale,"casIsoManualExplain")}</p>
          <label>{t(locale,"casIsoManualSelection")}
            <select value={manualStage} disabled={working}
              onChange={e=>setManualStage(e.target.value as StageId)}>
              {STAGES.map(stage=><option key={stage.id} value={stage.id}>
                {stage.id}
              </option>)}
            </select>
          </label>
          <label>{t(locale,"casIsoManualOutput")}
            <textarea data-testid="cas-isolated-manual-input"
              value={manualOutput} rows={5}
              maxLength={CAS_MANUAL_STAGE_MAX_CHARS}
              disabled={working}
              onChange={e=>setManualOutput(e.target.value)}/>
          </label>
          <button type="button" className="secondary"
            disabled={working || configDirty ||
              codeRequest.length>0 || codeProposalJson.length>0 ||
              active.current?.state()!=="ready" ||
              !canCommitCasIsolatedManualStage(snapshot,manualStage,manualOutput)}
            onClick={saveManualStage}>{t(locale,"casIsoManualAction")}</button>
        </div>
        <div data-testid="cas-isolated-code-proposal">
          <h4>{t(locale,"casIsoCodeTitle")}</h4>
          <p className="helper">{t(locale,"casIsoCodeExplain")}</p>
          {inspectedCodePatch && <div
            data-testid="cas-isolated-code-pending-preview">
            <p><strong>{t(locale,"casIsoCodeAlreadyPending")}</strong></p>
            <p>{inspectedCodePatch.summary}</p>
            <p className="helper">
              {t(locale,"casIsoCodePatchStatus")} ·
              {" "+inspectedCodePatch.editCount+" file · "}
              rev. {inspectedCodePatch.revision}
            </p>
          </div>}
          {inspectedCodePatch && <details
            data-testid="cas-isolated-code-files-preview">
            <summary>{t(locale,"casIsoCodeFilesPreview")}</summary>
            <p className="helper">
              {t(locale,"casIsoCodeFilesWarning")} ·
              {" "+snapshot?.id+" / rev. "+snapshot?.revision}
            </p>
            {!inspectedCodeFiles ? <p role="status">
              {t(locale,"casIsoCodeFilesInvalid")}
            </p> : <ol>
              {inspectedCodeFiles.map(file=><li key={file.path}
                data-testid="cas-isolated-code-file">
                <p><strong data-testid="cas-isolated-code-file-path">
                  {file.path}
                </strong></p>
                <p className="helper">{file.reason}</p>
                <p><strong>{t(locale,"casIsoCodeBefore")}</strong></p>
                {file.beforeMissing ? <p className="helper">
                  {t(locale,"casIsoCodeNewFile")}
                </p> : <pre data-testid="cas-isolated-code-file-before"
                  style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
                    maxHeight:160,overflow:"auto"}}>{file.before}</pre>}
                {file.beforeTruncated && <p className="helper">
                  {t(locale,"casIsoCodeFilesTruncated")}
                </p>}
                <p><strong>{t(locale,"casIsoCodeAfter")}</strong></p>
                <pre data-testid="cas-isolated-code-file-after"
                  style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
                    maxHeight:160,overflow:"auto"}}>{file.after}</pre>
                {file.afterTruncated && <p className="helper">
                  {t(locale,"casIsoCodeFilesTruncated")}
                </p>}
              </li>)}
            </ol>}
          </details>}
          {inspectedCodePatch && <div
            data-testid="cas-isolated-code-human-apply">
            <p className="helper">
              {t(locale,"casIsoHumanApplyExplain")}
            </p>
            <button type="button" className="secondary"
              data-testid="cas-isolated-code-human-apply-action"
              disabled={working || Boolean(dirty) ||
                active.current?.state()!=="ready" ||
                !canApplyCode}
              onClick={applyHumanCodeProposal}>
              {t(locale,"casIsoHumanApplyAction")}
            </button>
            {!canApplyCode &&
              <p className="helper" data-testid="cas-isolated-code-human-apply-blocked">
                {t(locale,"casIsoHumanApplyBlocked")}
              </p>}
          </div>}
          {inspectedCodePatch && <button type="button" className="secondary"
            data-testid="cas-isolated-code-discard-action"
            disabled={working || Boolean(dirty) ||
              active.current?.state()!=="ready" ||
              !canDiscardCasIsolatedPendingCodePatch(snapshot)}
            onClick={discardCodeProposal}>
            {t(locale,"casIsoCodeDiscardAction")}
          </button>}
          <label>{t(locale,"casIsoCodeRequest")}
            <textarea value={codeRequest} maxLength={CAS_PENDING_PATCH_MAX_REQUEST}
              rows={3} disabled={working}
              data-testid="cas-isolated-code-request"
              onChange={e=>setCodeRequest(e.target.value)}/>
          </label>
          <label>{t(locale,"casIsoCodeJson")}
            <textarea value={codeProposalJson} maxLength={CAS_PENDING_PATCH_MAX_JSON}
              rows={6} disabled={working}
              data-testid="cas-isolated-code-json"
              onChange={e=>setCodeProposalJson(e.target.value)}/>
          </label>
          <button type="button" className="secondary"
            disabled={working || configDirty || manualOutput.length>0 ||
              active.current?.state()!=="ready" ||
              !canStageCasIsolatedCodePatch(snapshot,codeRequest,codeProposalJson)}
            onClick={stageCodeProposal}>
            {t(locale,"casIsoCodeAction")}
          </button>
        </div>
        <div data-testid="cas-isolated-human-undo">
          <h4>{t(locale,"casIsoHumanUndoTitle")}</h4>
          <p className="helper">{t(locale,"casIsoHumanUndoExplain")}</p>
          {inspectedHumanUndo ? <details
            data-testid="cas-isolated-human-undo-preview">
            <summary>{t(locale,"casIsoHumanUndoPreview")} ·
              {" "+inspectedHumanUndo.files.length+" file / rev. "+
                inspectedHumanUndo.revision}
            </summary>
            <p className="helper">
              {inspectedHumanUndo.summary} ·
              {inspectedHumanUndo.legacyAdditionOnly ?
                " "+t(locale,"casIsoHumanUndoLegacy") : ""}
            </p>
            <ol>{inspectedHumanUndo.files.map(file=>
              <li key={file.path}
                data-testid="cas-isolated-human-undo-file">
                <strong>{file.path}</strong>
                <p><strong>{t(locale,"casIsoHumanUndoCurrent")}</strong></p>
                <pre data-testid="cas-isolated-human-undo-current"
                  style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
                    maxHeight:160,overflow:"auto"}}>{file.current}</pre>
                <p><strong>{t(locale,"casIsoHumanUndoRestore")}</strong></p>
                {file.restore===null ?
                  <p data-testid="cas-isolated-human-undo-remove">
                    {t(locale,"casIsoHumanUndoRemove")}
                  </p>:
                  <pre data-testid="cas-isolated-human-undo-before"
                    style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",
                      maxHeight:160,overflow:"auto"}}>{file.restore}</pre>}
              </li>)}</ol>
          </details>:
            <p className="helper"
              data-testid="cas-isolated-human-undo-unavailable">
              {t(locale,"casIsoHumanUndoUnavailable")}
            </p>}
          <button type="button" className="secondary"
            data-testid="cas-isolated-human-undo-action"
            disabled={working || Boolean(dirty) ||
              active.current?.state()!=="ready" ||
              !inspectedHumanUndo}
            onClick={undoHumanCodeApplication}>
            {t(locale,"casIsoHumanUndoAction")}
          </button>
        </div>
        <div data-testid="cas-isolated-stage-reset">
          <p className="helper">{t(locale,"casIsoStageResetExplain")}</p>
          <label>{t(locale,"casIsoStageResetSelection")}
            <select value={stageToReset} disabled={working || Boolean(dirty)}
              onChange={e=>setStageToReset(e.target.value as StageId)}>
              {STAGES.map(stage=><option key={stage.id} value={stage.id}>
                {stage.id}
              </option>)}
            </select>
          </label>
          <button type="button" className="secondary"
            disabled={working || Boolean(dirty) ||
              active.current?.state()!=="ready" ||
              !canResetCasIsolatedStage(snapshot,stageToReset)}
            onClick={resetStage}>{t(locale,"casIsoStageResetAction")}</button>
        </div>
        <div data-testid="cas-isolated-running-recovery">
          <p className="helper">{t(locale,"casIsoRunningRecoveryExplain")}</p>
          <button type="button" className="secondary"
            data-testid="cas-isolated-running-recovery-action"
            disabled={working || pipelineRunning || Boolean(dirty) ||
              active.current?.state()!=="ready" || !strandedStage}
            onClick={recoverRunningStage}>
            {t(locale,"casIsoRunningRecoveryAction")}
            {strandedStage ? " ("+strandedStage+")" : ""}
          </button>
        </div>
        <div data-testid="cas-isolated-ai-stage">
          <p className="helper">{t(locale,"casIsoPipelineExplain")}</p>
          <label>{t(locale,"casIsoPipelineSelection")}
            <select value={stageToRun} disabled={working || Boolean(dirty)}
              onChange={e=>setStageToRun(e.target.value as StageId)}>
              {STAGES.map(stage=><option key={stage.id} value={stage.id}>
                {stage.id}
              </option>)}
            </select>
          </label>
          <button type="button" className="secondary"
            disabled={working || Boolean(dirty) ||
              active.current?.state()!=="ready" ||
              !canBeginCasPipelineStage(snapshot,stageToRun)}
            onClick={executeCasStage}>{t(locale,"casIsoPipelineAction")}</button>
          <button type="button" className="secondary"
            disabled={!pipelineRunning || !pipelineAbort.current}
            onClick={()=>{
              pipelineAbort.current?.abort();
              setPipelineStatus(t(locale,"casIsoPipelineCancelling"));
            }}>{t(locale,"casIsoPipelineCancel")}</button>
          {pipelineStatus && <p role="status"
            data-testid="cas-isolated-pipeline-status">{pipelineStatus}</p>}
        </div>
        <button type="button" className="secondary"
          disabled={working || !active.current || Boolean(dirty)}
          onClick={deleteSelected}>{t(locale,"casIsoDeleteAction")}</button>
        <p className="helper">{t(locale,"casIsoDeleteExplain")}</p>
        <button type="button" className="secondary" disabled={working}
          onClick={()=>{
            if(dirty && !window.confirm(t(locale,"casIsoCloseDirtyConfirm")))
              return;
            active.current=null;setSnapshot(null);setList(null);
            setDraftName("");setDraftDescription("");setDraftRequirements("");
        setDraftStack(null);
            setManualOutput("");setCodeRequest("");setCodeProposalJson("");
          }}>
          {t(locale,"casIsoDiscard")}
        </button>
      </div>}
    </>}
    {/* A route handoff can fail while the CAS editor is COLLAPSED.
        Keep stale revision/IDB storage errors visible without opening or
        auto-selecting a different project. */}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
