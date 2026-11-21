/**
 * Opt-in CAS-only scratch editor (#149). This is intentionally NOT the active
 * Factory editor and does not import/migrate its write paths. No projectRef,
 * live setProject, localStorage, GitHub or cloud operations are reachable here.
 */
import {useRef,useState} from "react";
import type {FactoryLocale} from "../i18n";
import {t} from "../i18n";
import type {CasProjectChoice,CasProjectSnapshot} from "../infrastructure/project-cas";
import {listCasProjects} from "../infrastructure/project-cas";
import {prepareCasIsolatedNewProject,confirmCasIsolatedNewProject}
  from "../application/cas-isolated-create";
import {
  openCasSelectionController,type CasSelectionController,
} from "../infrastructure/project-cas-selection";
import {
  buildCasIsolatedConfigEdit,CAS_ISOLATED_NAME_MAX,
  CAS_ISOLATED_DESCRIPTION_MAX,
} from "../application/cas-isolated-config";
import {prepareCasIsolatedDelete} from "../application/cas-isolated-delete";

type Props={locale:FactoryLocale};

function exact(a:CasProjectSnapshot,b:CasProjectSnapshot):boolean {
  return a.id===b.id && a.revision===b.revision && a.raw===b.raw;
}

export default function CasIsolatedEditor({locale}:Props) {
  const [expanded,setExpanded]=useState(false);
  const [list,setList]=useState<CasProjectChoice[]|null>(null);
  const [snapshot,setSnapshot]=useState<CasProjectSnapshot|null>(null);
  const [draftName,setDraftName]=useState("");
  const [draftDescription,setDraftDescription]=useState("");
  const [newProjectName,setNewProjectName]=useState("");
  const [newProjectDescription,setNewProjectDescription]=useState("");
  const [working,setWorking]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const active=useRef<CasSelectionController|null>(null);
  const inFlight=useRef(false);

  const dirty=snapshot !== null && (() => {
    const data=JSON.parse(snapshot.raw) as {config:{name:string;description:string}};
    return data.config.name !== draftName ||
      (data.config.description || "") !== draftDescription;
  })();

  function accept(current:CasProjectSnapshot):void {
    // openCasSelectionController validates canonical raw before exposing it.
    const p=JSON.parse(current.raw) as {config:{name:string;description:string}};
    setSnapshot(current);
    setDraftName(p.config.name);
    setDraftDescription(p.config.description || "");
  }
  async function run(action:()=>Promise<void>):Promise<void> {
    if(inFlight.current) return;
    inFlight.current=true;
    setWorking(true); setError(""); setNotice("");
    try { await action(); }
    catch {
      // Never expose raw project JSON / native IDB provider errors.
      setError(t(locale,"casIsoFailure"));
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
    active.current=null; setExpanded(false);
    setList(null); setSnapshot(null); setError(""); setNotice("");
    setDraftName(""); setDraftDescription("");
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
      // A second tab may modify the new project after tx.oncomplete. Never
      // silently open/adopt it as the current editor in that case.
      const fresh=await openCasSelectionController(ticket.id);
      if(!exact(fresh.snapshot(),acknowledged))
        throw Error("New project altered after insertion");
      // Successful insert does not automatically become an active editor.
      // Discover it from IDB again so opening still requires explicit consent.
      setList(await listCasProjects());
      setNewProjectName(""); setNewProjectDescription("");
      setNotice(t(locale,"casIsoCreateDone")+" (rev. "+acknowledged.revision+")");
    });
  }
  function refresh():void {
    void run(async()=>{
      // Refreshes the read-only choices, NOT the active CAS token. This
      // permits explicit ticket-based switching. A blocked/closed session
      // must be reopened by selecting a fresh library entry (no rebase).
      if(!active.current || active.current.state()!=="ready") {
        active.current=null; setSnapshot(null);
      }
      const available=await listCasProjects();
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
      setDraftName("");setDraftDescription("");
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
      const controller=active.current, expected=snapshot;
      if(!controller || !expected || controller.state()!=="ready" ||
        !exact(controller.snapshot(),expected))
        throw Error("Stale CAS session");
      const candidate=buildCasIsolatedConfigEdit(expected,draftName,draftDescription);
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
        <p className="helper">{t(locale,"casIsoInvalidate")}</p>
        <button type="button" className="secondary"
          disabled={working || !dirty || !active.current}
          onClick={save}>{t(locale,"casIsoSave")}</button>
        <button type="button" className="secondary"
          disabled={working || !active.current || Boolean(dirty)}
          onClick={deleteSelected}>{t(locale,"casIsoDeleteAction")}</button>
        <p className="helper">{t(locale,"casIsoDeleteExplain")}</p>
        <button type="button" className="secondary" disabled={working}
          onClick={()=>{active.current=null;setSnapshot(null);setList(null);}}>
          {t(locale,"casIsoDiscard")}
        </button>
      </div>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </>}
  </section>;
}
