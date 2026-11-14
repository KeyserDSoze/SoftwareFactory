import { useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, CircleSlash, Code2, FileCode2, GitCommit, Pause, Play, RefreshCw, RotateCcw, ShieldCheck, ShieldX } from "lucide-react";
import type { FactoryProject, FactorySettings } from "../domain/types";
import type { FeatureEdit, FeatureProposal, RunnerJobEvidence } from "../domain/development";
import { approvePending, developmentOf, dropConflictingChanges, rejectPending, replacePendingWithRepair, saveReview, setPending, undoLatest, validateProposal, workspaceConflicts } from "../domain/development";
import { lineDiff } from "../application/code-diff";
import RunnerPanel from "./RunnerPanel";
import "./runner.css";
import { proposeCode, proposeCodeRepair, reviewCode } from "../application/code-agent";
import type { RunnerReport } from "../infrastructure/runner";
import { fetchRunnerJob, verifyCurrentRunnerReport } from "../infrastructure/runner";
import { readSecret } from "../infrastructure/store";

type Props = {
  project: FactoryProject;
  settings: FactorySettings;
  busy: boolean;
  onBusy: (busy: boolean, label?: string) => void;
  onProjectChange: (project: FactoryProject) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};
export default function CodeAgentPanel({ project, settings, busy, onBusy, onProjectChange, onNotice, onError }: Props) {
  const [request, setRequest] = useState("");
  const [activePath, setActivePath] = useState("");
  const [view, setView] = useState<"diff" | "old" | "new">("diff");
  const [phase, setPhase] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const dev = developmentOf(project);
  const pending = dev.pending;
  const conflicts = useMemo(() => {
    try { return workspaceConflicts(project); }
    catch { return [] as string[]; }
  }, [project]);
  const selected = pending?.edits.find(e => e.path === activePath) || pending?.edits[0];
  const diff = useMemo(() => selected ? lineDiff(selected.previous, selected.content) : [], [selected]);
  const ready = project.stages.some(s => s.id === "implementation" && s.status === "complete");

  function update(next: FactoryProject) { projectRef.current = next; onProjectChange(next); }
  function fail(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") onNotice("Task interrotto. Le modifiche non approvate non sono state pubblicate.");
    else onError(error instanceof Error ? error.message : String(error));
  }
  async function generate() {
    if (busy || !ready || !request.trim()) return;
    const starting = projectRef.current, controller = new AbortController();
    abortRef.current = controller; setPhase("Generazione della patch"); onBusy(true, "Code Agent: generazione");
    try {
      const raw = await proposeCode(starting, settings, request.trim(), controller.signal);
      if (controller.signal.aborted) return;
      if (projectRef.current.updatedAt !== starting.updatedAt)
        throw new Error("Il progetto è cambiato durante la generazione. Riprova.");
      const proposal = validateProposal(raw, projectRef.current, request.trim());
      const staged = setPending(projectRef.current, proposal);
      update(staged);
      setActivePath(proposal.edits[0]?.path || "");
      setView("diff");
      setPhase("Adversarial review indipendente");
      onBusy(true, "Code Agent: adversarial review");
      try {
        const review = await reviewCode(staged, settings, proposal, controller.signal);
        if (controller.signal.aborted) return;
        update(saveReview(projectRef.current, proposal.id, review));
        onNotice(review.verdict === "pass"
          ? "Patch generata e review superata. Controlla il diff e approva manualmente."
          : "Patch generata. La review ha trovato problemi: scartala e rigenera.");
      } catch (error) {
        if (!controller.signal.aborted) onError("Patch salvata, review non completata: " + (error instanceof Error ? error.message : String(error)));
      }
    } catch (error) { if (!controller.signal.aborted) fail(error); }
    finally { onBusy(false); setPhase(""); abortRef.current = null; }
  }
  async function reviewAgain() {
    if (!pending || busy) return;
    const controller = new AbortController();
    abortRef.current = controller; onBusy(true, "Code Agent: review"); setPhase("Adversarial review");
    try {
      const review = await reviewCode(projectRef.current, settings, pending, controller.signal);
      if (!controller.signal.aborted) {
        update(saveReview(projectRef.current, pending.id, review));
        onNotice(review.verdict === "pass" ? "Review superata: applica solo dopo aver verificato i file." : "Review bloccante: correggi la richiesta e rigenera.");
      }
    } catch(error) { if (!controller.signal.aborted) fail(error); }
    finally { onBusy(false); setPhase(""); abortRef.current = null; }
  }
  function bindRunnerJob(evidence: RunnerJobEvidence) {
    const current = projectRef.current;
    update({
      ...current,
      development: { ...developmentOf(current), lastRunnerJobId: evidence.id, lastRunnerEvidence: evidence },
      updatedAt: new Date().toISOString(),
    });
  }
  async function repair(report: RunnerReport, evidence: RunnerJobEvidence): Promise<void> {
    const originalProject = projectRef.current;
    const original = developmentOf(originalProject).pending;
    if (!original || original.id !== evidence.proposalId || busy) {
      onError("La proposta non è più disponibile per il repair."); return;
    }
    const proof = await verifyCurrentRunnerReport(originalProject, settings.runnerEndpoint || "", report, evidence);
    if (proof.kind !== "failed" || originalProject.development?.lastRunnerEvidence?.id !== evidence.id) {
      onError("Report non più valido per i sorgenti attuali."); return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("Correzione AI guidata dagli errori del test");
    onBusy(true, "Code Agent: repair");
    try {
      const raw = await proposeCodeRepair(originalProject, settings, original, report, controller.signal);
      if (controller.signal.aborted) return;
      if (projectRef.current.updatedAt !== originalProject.updatedAt ||
          projectRef.current.development?.pending?.id !== original.id)
        throw new Error("Il workspace è cambiato: la correzione non sarà applicata.");
      const revised = replacePendingWithRepair(projectRef.current, original.id, raw);
      update(revised);
      setActivePath(revised.development?.pending?.edits[0]?.path || "");
      setView("diff");
      setPhase("Adversarial review dopo la correzione");
      try {
        const patch = revised.development!.pending!;
        const review = await reviewCode(revised, settings, patch, controller.signal);
        if (controller.signal.aborted) return;
        update(saveReview(projectRef.current, patch.id, review));
        onNotice(review.verdict === "pass"
          ? "Patch corretta e review superata. Riesegui i test: il report precedente è invalido. Solo dopo controlla e approva."
          : "Patch corretta, ma la nuova review è bloccante. Nessun file è stato applicato.");
      } catch(error) {
        if (!controller.signal.aborted) onError("La patch corretta è salvata ma la review non è completata: " +
          (error instanceof Error ? error.message : String(error)));
      }
    } catch(error) { if (!controller.signal.aborted) fail(error); }
    finally { abortRef.current = null; setPhase(""); onBusy(false); }
  }
  async function approve() {
    const originalProject = projectRef.current, patch = developmentOf(originalProject).pending;
    if (busy || !patch) return;
    if (!window.confirm("Applicare le modifiche ai file locali? Non saranno pubblicate finché non esegui un push GitHub esplicito.")) return;
    const isRepair = (patch.repairCount ?? 0) > 0;
    if (isRepair) onBusy(true, "Verifica esiti runner post-repair");
    try {
      if (isRepair) {
        const evidence = originalProject.development?.lastRunnerEvidence;
        if (!evidence || evidence.proposalId !== patch.id)
          throw new Error("Dopo il repair devi rieseguire i test sul nuovo codice prima di approvare.");
        const required = new Set<string>();
        if (patch.edits.some(e => e.path.endsWith(".cs"))) required.add("dotnet-build");
        if (patch.edits.some(e => e.path.startsWith("src/frontend/web/src/"))) required.add("web-build");
        if ([...required].some(step => !evidence.steps.includes(step as typeof evidence.steps[number])))
          throw new Error("Ripeti almeno i build .NET/React corrispondenti ai file riparati.");
        const endpoint = settings.runnerEndpoint || "", key = readSecret("runner.key");
        const report = await fetchRunnerJob(endpoint, key, evidence.id);
        const status = await verifyCurrentRunnerReport(originalProject, endpoint, report, evidence);
        if (status.kind !== "passed")
          throw new Error("I nuovi test non sono superati o lo snapshot è cambiato: " + status.detail);
        if (projectRef.current.updatedAt !== originalProject.updatedAt)
          throw new Error("Il progetto è cambiato durante la verifica: riprova.");
      }
      update(approvePending(projectRef.current, { verifiedRepair: isRepair }));
      setRequest("");
      onNotice(isRepair
        ? "Patch riparata, ri-verificata e approvata localmente. Controlla il diff e pubblica manualmente."
        : "Modifiche applicate localmente. Esporta lo ZIP o pubblica su GitHub dopo averle verificate.");
    } catch (error) { fail(error); }
    finally { if (isRepair) onBusy(false); }
  }
  function reject() {
    if (busy || !pending) return;
    if (!window.confirm("Scartare questa proposta non approvata?")) return;
    update(rejectPending(projectRef.current)); onNotice("Patch proposta scartata. Nessun file approvato è stato modificato.");
  }
  function undo() {
    if (busy || !window.confirm("Annullare l'ultima feature applicata?")) return;
    try { update(undoLatest(projectRef.current)); onNotice("Ultima feature ripristinata localmente. Il remoto GitHub non viene modificato."); }
    catch(e) { fail(e); }
  }
  function resolve() {
    if (busy || !conflicts.length) return;
    if (!window.confirm("Scartare SOLO le modifiche AI nei file in conflitto con il nuovo stack? Le altre modifiche rimarranno.")) return;
    try { update(dropConflictingChanges(projectRef.current)); onNotice("Modifiche in conflitto scartate; lo scaffold aggiornato è di nuovo esportabile."); }
    catch(e) { fail(e); }
  }
  return <div className="code-agent-page">
    <header className="section-head">
      <div className="eyebrow">FACTORY / FEATURE IMPLEMENTATION</div>
      <h2>Code Agent</h2>
      <p>L'agente propone modifiche reali ai file .NET e React. Un secondo agente esegue la review avversaria. Tu controlli i diff e approvi; l'esportazione e il push contengono soltanto le patch applicate.</p>
    </header>
    <div className="code-agent-note"><AlertTriangle size={18} />
      <span><strong>Gate di sicurezza.</strong> Questa versione non compila né esegue codice AI nel browser. La review non equivale a test superati: dopo un push, usa GitHub Actions e correggi eventuali problemi di build.</span>
    </div>
    {conflicts.length > 0 && <section className="panel code-conflict" role="alert">
      <div className="panel-title"><div><span className="eyebrow">CONFIGURATION CONFLICT</span><h3>Conflitto con lo scaffold aggiornato</h3></div><AlertTriangle size={20} /></div>
      <p>Hai cambiato configurazione dopo aver modificato file generati. Per evitare di sovrascrivere la nuova base con codice incompatibile, ZIP e GitHub sono bloccati finché non risolvi:</p>
      <ul>{conflicts.map(p => <li key={p}><code>{p}</code></li>)}</ul>
      <button className="danger-button" disabled={busy} onClick={resolve}><RotateCcw size={16} /> Scarta solo le modifiche in conflitto</button>
    </section>}
    <section className="panel">
      <div className="panel-title"><div><div className="eyebrow">01 / IMPLEMENTATION REQUEST</div><h3>Nuova feature</h3></div><FileCode2 size={19} className="muted" /></div>
      {!ready && <div className="code-agent-warning"><CircleSlash size={17} /> Completa prima il piano implementativo nella scheda AI Factory.</div>}
      <label>Descrivi la modifica da implementare<textarea rows={4} maxLength={2000} value={request} disabled={busy || !!pending || !!conflicts.length} onChange={e => setRequest(e.target.value)}
        placeholder="Es. Implementa la gestione delle pratiche: API REST con validation, domain model e UI per inserire una nuova pratica..." /></label>
      <div className="panel-footer"><span>Revision #{dev.revision} · {dev.history.filter(h => h.status === "applied").length} feature applicate</span>
        <div className="button-group">
          {busy && abortRef.current ? <button className="danger-button" onClick={() => abortRef.current?.abort()}><Pause size={16} /> Interrompi</button> :
            <button className="primary" disabled={busy || !ready || !request.trim() || !!pending || !!conflicts.length}
              onClick={() => void generate()}><Play size={16} /> Genera patch e review</button>}
        </div></div>
      {phase && <div className="code-agent-phase"><RefreshCw size={15} className="spinning" /> {phase}</div>}
    </section>
    {pending && <section className="panel">
      <div className="panel-title"><div><div className="eyebrow">02 / PROPOSAL · NOT APPLIED</div><h3>{pending.summary}</h3></div>
        <span className="count-pill">{pending.edits.length} file · Repair {pending.repairCount ?? 0}/2</span></div>
      <p className="helper">La proposta è salvata nel progetto locale ma non modifica ancora i sorgenti esportati. Dopo una riparazione AI, review e test precedenti non sono più validi.</p>
      <div className="code-review-status">
        {pending.review?.verdict === "pass" ? <ShieldCheck size={20} className="ok" /> :
         pending.review?.verdict === "changes_required" ? <ShieldX size={20} className="danger" /> :
         <AlertTriangle size={20} className="muted" />}
        <div><strong>{pending.review ? (pending.review.verdict === "pass" ? "Review superata (non è una compilazione)" : "Review bloccante") : "Review non ancora disponibile"}</strong>
          <p>{pending.review?.report || "Esegui la review avversaria prima di applicare la patch."}</p></div>
      </div>
      <div className="feature-patch-layout">
        <div className="feature-file-list">{pending.edits.map(edit => <button key={edit.path} className={selected?.path === edit.path ? "selected" : ""} onClick={() => { setActivePath(edit.path); setView("diff"); }}>
          <FileCode2 size={15} /><span>{edit.path}</span><ChevronDown size={13} /></button>)}</div>
        <div className="feature-preview">
          {selected && <><div className="feature-file-header"><strong>{selected.path}</strong><span>{selected.previous === null ? "Nuovo file" : "Modificato"}</span></div>
            <p className="feature-reason">{selected.reason}</p>
            <div className="feature-view-tabs">{(["diff", "old", "new"] as const).map(v => <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{v === "diff" ? "Differenze" : v === "old" ? "Prima" : "Dopo"}</button>)}</div>
            {view === "diff" ? <pre className="feature-diff">{diff.map((line, i) => <div key={i} className={"feature-diff-line " + line.kind}><span>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>{line.text || " "}</div>)}</pre> :
              <pre className="feature-diff plain">{view === "old" ? (selected.previous ?? "(file inesistente)") : selected.content}</pre>}
          </>}
        </div>
      </div>
      {(pending.assumptions.length > 0 || pending.tests.length > 0) && <div className="feature-metadata">
        {pending.assumptions.length > 0 && <div><strong>Assunzioni da validare</strong><ul>{pending.assumptions.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
        {pending.tests.length > 0 && <div><strong>Test da eseguire</strong><ul>{pending.tests.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
      </div>}
      <div className="panel-footer"><span>La review avversaria può bloccare l'applicazione.</span><div className="button-group">
        <button className="subtle" disabled={busy} onClick={reject}><CircleSlash size={15} /> Scarta</button>
        <button className="secondary" disabled={busy} onClick={() => void reviewAgain()}><RefreshCw size={15} /> Riesegui review</button>
        <button className="primary" disabled={busy || pending.review?.verdict !== "pass" || !!conflicts.length} onClick={approve}><CheckCircle2 size={16} /> Approva e applica</button>
      </div></div>
    </section>}
<RunnerPanel project={project} settings={settings} busy={busy}
      onRunnerBound={bindRunnerJob} onRepair={repair} onNotice={onNotice} onError={onError} />
    <section className="panel"><div className="panel-title"><div><div className="eyebrow">03 / DEVELOPMENT HISTORY</div><h3>Modifiche approvate</h3></div><GitCommit size={19} className="muted" /></div>
      {dev.history.length === 0 ? <p className="dimmed">Nessuna feature è stata applicata. Le patch approvate saranno tracciate qui.</p> :
        <div className="feature-history">{[...dev.history].reverse().map(entry => <div key={entry.id} className="history-row">
          <div><strong>{entry.summary}</strong><small>{new Date(entry.appliedAt).toLocaleString("it-IT")} · {entry.edits.length} file</small></div>
          <span className={"history-status " + entry.status}>{entry.status === "applied" ? "Applicata" : entry.status === "reverted" ? "Annullata" : "Superata da configurazione"}</span></div>)}</div>}
      <div className="panel-footer"><span>Undo locale, non cancella commit già pubblicati.</span>
        <button className="secondary" disabled={busy || !!pending || !!conflicts.length || !dev.history.some(h => h.status === "applied")} onClick={undo}><RotateCcw size={16} /> Annulla ultima feature</button></div>
    </section>
  </div>;
}
