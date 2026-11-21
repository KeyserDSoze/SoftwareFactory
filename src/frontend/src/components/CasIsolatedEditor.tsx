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
import {
  openCasSelectionController,type CasSelectionController,
} from "../infrastructure/project-cas-selection";
import {
  buildCasIsolatedConfigEdit,CAS_ISOLATED_NAME_MAX,
  CAS_ISOLATED_DESCRIPTION_MAX,
} from "../application/cas-isolated-config";

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
