/**
 * Opt-in CAS-only scratch editor (#149). This is intentionally NOT the active
 * Factory editor and does not import/migrate its write paths. No projectRef,
 * live setProject, localStorage, GitHub or cloud operations are reachable here.
 */
import {useEffect,useRef,useState} from "react";
import {STAGES} from "../domain/defaults";
import type {FactoryProject,FactorySettings,StageId} from "../domain/types";
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
import {listCasProjects} from "../infrastructure/project-cas";
import {
  prepareCasIsolatedNewProject,confirmCasIsolatedNewProject,
  verifyCasIsolatedCreatedReadback,
} from "../application/cas-isolated-create";
import {
  openCasSelectionController,type CasSelectionController,
} from "../infrastructure/project-cas-selection";
import {
  buildCasIsolatedConfigEdit,CAS_ISOLATED_NAME_MAX,
  CAS_ISOLATED_DESCRIPTION_MAX,CAS_ISOLATED_REQUIREMENTS_MAX,
} from "../application/cas-isolated-config";
import {prepareCasIsolatedDelete} from "../application/cas-isolated-delete";
import {hasCasIsolatedUnsavedDraft} from "../application/cas-isolated-draft";
import {inspectCasIsolatedStages} from "../application/cas-isolated-stage-inspection";
import {
  buildCasIsolatedManualStage,canCommitCasIsolatedManualStage,
  CAS_MANUAL_STAGE_MAX_CHARS,
} from "../application/cas-isolated-manual-stage";
import {
  buildCasIsolatedPendingCodePatch,canStageCasIsolatedCodePatch,
  inspectCasIsolatedPendingCodePatch,
  CAS_PENDING_PATCH_MAX_REQUEST,CAS_PENDING_PATCH_MAX_JSON,
} from "../application/cas-isolated-code-patch";
import {
  prepareCasIsolatedExport,confirmCasIsolatedExport,
} from "../application/cas-isolated-export";
import {
  buildCasIsolatedStageReset,canResetCasIsolatedStage,
} from "../application/cas-isolated-stage-reset";

type Props={locale:FactoryLocale;settings:FactorySettings};

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

export default function CasIsolatedEditor({locale,settings}:Props) {
  const [expanded,setExpanded]=useState(false);
  const [list,setList]=useState<CasProjectChoice[]|null>(null);
  const [snapshot,setSnapshot]=useState<CasProjectSnapshot|null>(null);
  const [draftName,setDraftName]=useState("");
  const [draftDescription,setDraftDescription]=useState("");
  const [draftRequirements,setDraftRequirements]=useState("");
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
  const active=useRef<CasSelectionController|null>(null);
  const inFlight=useRef(false);
  const pipelineAbort=useRef<AbortController|null>(null);
  // Unmount aborts the network; a committed "running" stage is not
  // automatically completed or rolled back after browser crash/reload.
  useEffect(()=>()=>{pipelineAbort.current?.abort();},[]);

  const configDirty=hasCasIsolatedUnsavedDraft(
    snapshot,draftName,draftDescription,draftRequirements,
  );
  // Human stage text is a draft too: close/switch/refresh must not discard
  // it without explicit consent. Saving config must not silently erase it.
  const dirty=configDirty || manualOutput.length>0 ||
    codeRequest.length>0 || codeProposalJson.length>0;
  // This projection is read-only and pinned to the selection's exact CAS
  // revision; a rival tab cannot silently replace the text being inspected.
  const inspectedStages=inspectCasIsolatedStages(snapshot);
  const inspectedCodePatch=inspectCasIsolatedPendingCodePatch(snapshot);

  function accept(current:CasProjectSnapshot):void {
    // openCasSelectionController validates canonical raw before exposing it.
    const p=JSON.parse(current.raw) as {config:{name:string;description:string;requirements?:string}};
    setSnapshot(current);
    setDraftName(p.config.name);
    setDraftDescription(p.config.description || "");
    setDraftRequirements(p.config.requirements ?? "");
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
  function close():void {
    if(inFlight.current) return;
    // "Close panel" does not mean permission to destroy a human draft.
    // An explicit rejection keeps both the CAS selection and all text.
    if(dirty && !window.confirm(t(locale,"casIsoCloseDirtyConfirm"))) return;
    active.current=null; setExpanded(false);
    setList(null); setSnapshot(null); setError(""); setNotice("");
    setDraftName(""); setDraftDescription("");setDraftRequirements("");
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
  function refresh():void {
    if(inFlight.current) return;
    // A ready controller retains its pinned snapshot and draft on refresh.
    // After a failed/conflicting CAS write the controller is blocked, while
    // the rejected human draft is still on screen: never erase it silently.
    const resetsSelection=!active.current || active.current.state()!=="ready";
    if(resetsSelection && dirty &&
       !window.confirm(t(locale,"casIsoRefreshDirtyConfirm"))) return;
    void run(async()=>{
      // Do the read FIRST: if IndexedDB is unavailable, retain even a
      // blocked selected project and its human/Code Agent drafts. An
      // explicit discard consent must not destroy the only draft if read
      // failed. Clear only after the verified read-only refresh succeeds.
      const available=await listCasProjects();
      if(resetsSelection) {
        active.current=null;setSnapshot(null);
        setDraftName("");setDraftDescription("");setDraftRequirements("");
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
      setList(null);
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
      const candidate=buildCasIsolatedConfigEdit(
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
      const committed=await controller.commit(candidate,expected);
      if(!exact(committed,{
        id:candidate.id,revision:expected.revision+1,
        raw:JSON.stringify(candidate),
      }))
        throw Error("Inconsistent CAS acknowledgement");
      accept(committed);setList(null);
      setNotice(t(locale,"casIsoSaved")+" (rev. "+committed.revision+")");
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
      const committed=await controller.commit(candidate,expected);
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
      const committed=await controller.commit(candidate,expected);
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
      const committed=await controller.commit(candidate,expected);
      if(!exact(committed,{
        id:candidate.id,revision:expected.revision+1,
        raw:JSON.stringify(candidate),
      }))throw Error("Inconsistent CAS stage reset ACK");
      accept(committed);setList(null);
      setNotice(t(locale,"casIsoStageResetDone")+
        " ("+stageToReset+", rev. "+committed.revision+")");
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
      const ticket=await pipeline.begin(stage);
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
          active.current=null;setList(null);
          setPipelineStatus("");
          setNotice(t(locale,"casIsoPipelineBlocked")+
            " ID: "+expected.id+" / rev. "+ticket.started.revision);
          return;
        }
        outcome=cancellation.signal.aborted?"abort":"fail";
        try{
          ack=outcome==="abort"?
            await pipeline.abort(ticket):
            await pipeline.fail(ticket,
              providerReturned?"invalid_result":"provider");
        }catch{
          active.current=null;setList(null);
          setPipelineStatus("");
          setNotice(t(locale,"casIsoPipelineBlocked")+
            " ID: "+expected.id+" / rev. "+ticket.started.revision);
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
    {!expanded ? <button type="button" className="secondary"
      onClick={()=>setExpanded(true)}>{t(locale,"casIsoOpenPanel")}</button> : <>
      <div className="row">
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
        <p className="helper">{t(locale,"casIsoInvalidate")}</p>
        <button type="button" className="secondary"
          disabled={working || !configDirty || manualOutput.length>0 ||
              codeRequest.length>0 || codeProposalJson.length>0 ||
              !active.current}
          onClick={save}>{t(locale,"casIsoSave")}</button>
        <div data-testid="cas-isolated-full-export">
          <p className="helper">{t(locale,"casIsoExportExplain")}</p>
          <button type="button" className="secondary"
            disabled={working || !active.current ||
              active.current.state()!=="ready" || !snapshot}
            onClick={exportSelected}>
            {t(locale,"casIsoExportAction")}
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
            setManualOutput("");setCodeRequest("");setCodeProposalJson("");
          }}>
          {t(locale,"casIsoDiscard")}
        </button>
      </div>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </>}
  </section>;
}
