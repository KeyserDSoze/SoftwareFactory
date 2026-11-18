import { useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, Clock, Cloud, Play, RefreshCw, ShieldAlert, Wrench } from "lucide-react";
import type { FactoryProject, FactorySettings } from "../domain/types";
import type { RunnerJobEvidence } from "../domain/development";
import type { RunnerTaskActivity } from "./BackgroundTaskToast";
import RunnerTelemetry from "./RunnerTelemetry";
import RunnerBatchPanel from "./RunnerBatchPanel";
import { planRepairRetest, verifyRepairRetestReceipt } from "../application/repair-loop";
import { getRepairCheckpoint, prepareRepairRetest, repairPaths, syncRepairRetest, operatorRepairKey } from "../infrastructure/repair-coordinator";
import { readSecret } from "../infrastructure/store";
import {
  fetchRunnerJob, fetchRunnerExecutionPlan, runnerSourceFiles, submitRunnerJob, runnerRequestDigest, runnerEndpoint,
  runnerPollDecision, verifyCurrentRunnerReport, type RunnerExecutionPlan, type RunnerReport, type RunnerStep, type RunnerVerification,
} from "../infrastructure/runner";

type Props = {
  project: FactoryProject;
  settings: FactorySettings;
  busy: boolean;
  onRunnerBound: (evidence: RunnerJobEvidence) => void;
  onRepair: (report: RunnerReport, evidence: RunnerJobEvidence) => Promise<void>;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
  onRunnerActivity?: (activity: RunnerTaskActivity | null) => void;
};
const AVAILABLE: { step: RunnerStep; label: string }[] = [
  { step: "dotnet-build", label: ".NET build" },
  { step: "dotnet-test", label: ".NET test" },
  { step: "web-build", label: "React build" },
  { step: "web-test", label: "Frontend tests" },
  { step: "playwright", label: "Playwright E2E" },
];
const terminal = (state: string) => ["passed", "failed", "incomplete"].includes(state);
export default function RunnerPanel({ project, settings, busy, onRunnerBound, onRepair, onNotice, onError, onRunnerActivity }: Props) {
  const [steps, setSteps] = useState<RunnerStep[]>(["dotnet-build", "web-build"]);
  const [report, setReport] = useState<RunnerReport | null>(null);
  const [executionPlan, setExecutionPlan] = useState<RunnerExecutionPlan | null>(null);
  const [verification, setVerification] = useState<RunnerVerification | null>(null);
  const [pollNotice, setPollNotice] = useState<{
    kind: "retrying" | "paused" | "blocked"; detail: string;
  } | null>(null);
  const [pollRestart, setPollRestart] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  // Preserve an in-flight receipt UUID for manual retry after a lost response.
  // A confirmed submission clears this; a deliberate new run gets a new UUID.
  const pendingSubmission = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const latestProject = useRef(project);
  latestProject.current = project;
  const syncInFlight = useRef<string | null>(null);
  const syncedOutcome = useRef<string | null>(null);
  const [checkpointState, setCheckpointState] = useState<"idle" | "syncing" | "saved" | "error">("idle");
  const [syncRetry, setSyncRetry] = useState(0);
  const repairOperatorKey = readSecret("runner.operator.key");
  const pendingRepair = project.development?.pending;
  const isRepair = (pendingRepair?.repairCount ?? 0) > 0;
  const retestPlan = (() => {
    if (!isRepair) return null;
    try { return planRepairRetest(project, steps); }
    catch { return null; }
  })();
  const evidence = project.development?.lastRunnerEvidence;
  const jobId = evidence?.id || project.development?.lastRunnerJobId || "";
  const endpoint = settings.runnerEndpoint || "";
  const secret = readSecret("runner.key");

  useEffect(() => {
    setReport(null);
    setExecutionPlan(null);
    setVerification(null);
    setPollNotice(null);
    if (!jobId || !endpoint || !secret) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const next = await fetchRunnerJob(endpoint, secret, jobId, controller.signal);
        if (disposed) return;
        consecutiveFailures = 0;
        setPollNotice(null);
        setReport(next);
        // A PM plan may be unavailable on older runners or during journal rename.
        // It must never be shown unless bound to the same digest and evidence head.
        try {
          const linked = await fetchRunnerExecutionPlan(endpoint, secret, next, controller.signal);
          if (disposed || controller.signal.aborted) return;
          setExecutionPlan(linked);
        } catch {
          if (disposed || controller.signal.aborted) return;
          setExecutionPlan(null);
        }
        if (!terminal(next.state)) timer = setTimeout(() => void tick(), 2500);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        const decision = runnerPollDecision(error, consecutiveFailures);
        if (decision.retry) {
          consecutiveFailures = decision.attempt;
          setPollNotice({ kind: "retrying",
            detail: "Connessione temporaneamente indisponibile. Nuova lettura " +
              decision.attempt + "/5 senza riavviare il job." });
          timer = setTimeout(() => void tick(), decision.delayMs);
          return;
        }
        // Never show a previous report as verified when a non-recoverable read
        // fails; 401/403/404/409 and malformed JSON must stop automatic polls.
        setReport(null);
        setVerification(null);
        // An auth/integrity denial after a previous transient failure must
        // remain a hard stop, not be mislabeled as exhausted network retries.
        const transient = runnerPollDecision(error, 0).retry;
        setPollNotice({ kind: transient ? "paused" : "blocked",
          detail: transient
            ? "Letture automatiche sospese dopo cinque tentativi senza risposta valida."
            : "Lettura fermata: il runner ha rifiutato la richiesta o il report non è valido." });
        onError("Report runner: " + (error instanceof Error ? error.message : String(error)));
      }
    };
    void tick();
    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [jobId, endpoint, secret, onError, pollRestart]);

  useEffect(() => {
    let disposed = false;
    setVerification(null);
    if (!report || report.id !== jobId || !endpoint) return;
    void verifyCurrentRunnerReport(project, endpoint, report, evidence)
      .then(async verified => {
        if (disposed) return;
        setVerification(verified);
        const pending = project.development?.pending;
        const binding = pending?.repairSession;
        if (!binding || (pending?.repairCount ?? 0) === 0 ||
            (verified.kind !== "passed" && verified.kind !== "failed") ||
            evidence?.id !== report.id || !secret) return;
        const signature = report.id + ":" + verified.kind;
        if (syncedOutcome.current === signature || syncInFlight.current === signature) return;
        syncInFlight.current = signature;
        setCheckpointState("syncing");
        try {
          await syncRepairRetest(endpoint, operatorRepairKey(), binding, repairPaths(pending),
            evidence.id, evidence.digest, verified.kind);
          if (!disposed) { syncedOutcome.current = signature; setCheckpointState("saved"); }
        } catch (error) {
          if (!disposed) {
            setCheckpointState("error");
            onError("Sincronizzazione checkpoint repair: " +
              (error instanceof Error ? error.message : String(error)));
          }
        } finally {
          if (syncInFlight.current === signature) syncInFlight.current = null;
        }
      })
      .catch(() => { if (!disposed) setVerification({ kind: "invalid", detail: "Impossibile verificare il report." }); });
    return () => { disposed = true; };
  }, [project, evidence, report, jobId, endpoint, repairOperatorKey, syncRetry]);

  const submit = async () => {
    if (busy || requesting || repairing) return;
    if (!endpoint || !secret) { onError("Configura URL e API key del runner nelle Impostazioni."); return; }
    if (isRepair && !retestPlan) {
      onError("Dopo un repair è obbligatoria una nuova review positiva e la provenienza dei test falliti."); return;
    }
    const selectedSteps = retestPlan?.steps ?? steps;
    if (!selectedSteps.length) { onError("Seleziona almeno un tipo di test."); return; }
    const pending = project.development?.pending;
    const label = retestPlan?.label ??
      (project.config.name + (pending ? " · proposal: " + pending.summary : " · approved workspace")).slice(0, 160);
    const consent = retestPlan
      ? "Repair supervisionato " + retestPlan.attempt + "/2. Confermi il PASSAGGIO SUCCESSIVO? " +
        "Il primo click registra solo il digest della patch con la chiave del proponente; " +
        "il secondo registra solo la review con la chiave di un altro operatore; " +
        "il terzo, dopo il ritorno alla chiave proponente, invia i test (" +
        selectedSteps.join(", ") + "). Nessun codice viene applicato automaticamente."
      : "Inviare il codice sorgente al runner remoto? Verrà eseguito in container isolati sul tuo server, non nel browser.";
    if (!window.confirm(consent)) return;
    setRequesting(true);
    try {
      const files = runnerSourceFiles(project, pending !== undefined);
      const checksum = await runnerRequestDigest(label, files, selectedSteps);
      if (retestPlan && pending) {
        // The remote coordinator must acknowledge both the exact patch digest and
        // the operator-declared review before we send the fixed source snapshot.
        const before = await getRepairCheckpoint(endpoint, operatorRepairKey(),
          pending.repairSession!, repairPaths(pending));
        const checkpoint = await prepareRepairRetest(
          endpoint, operatorRepairKey(), pending, checksum, selectedSteps);
        if (latestProject.current.updatedAt !== project.updatedAt ||
            latestProject.current.development?.pending?.id !== pending.id)
          throw new Error("Workspace modificato prima del re-test: invio annullato.");
        if (checkpoint.state === "awaiting_review") {
          onNotice("Patch registrata sul runner. Cambia nelle Impostazioni la chiave operatore con quella del REVISORE indipendente, poi premi nuovamente il pulsante per registrare la review. Nessun test è stato avviato.");
          return;
        }
        if (before.state === "awaiting_review" && checkpoint.state === "awaiting_retest") {
          onNotice("Review indipendente registrata. Ora cambia la credenziale operatore con quella del PROPONENTE e premi nuovamente per inviare i test. Nessun test è stato avviato.");
          return;
        }
      }
      const signature = runnerEndpoint(endpoint) + ":" + checksum;
      const idempotencyKey = pendingSubmission.current?.signature === signature
        ? pendingSubmission.current.idempotencyKey : crypto.randomUUID();
      pendingSubmission.current = { signature, idempotencyKey };
      const receipt = await submitRunnerJob(endpoint, secret, label, files, selectedSteps,
        undefined, idempotencyKey);
      verifyRepairRetestReceipt(receipt, checksum);
      // A response to an outdated submission must never be bound to a newer patch.
      if (latestProject.current.updatedAt !== project.updatedAt ||
          (latestProject.current.development?.pending?.id ?? null) !== (pending?.id ?? null) ||
          (latestProject.current.development?.revision ?? 0) !== (project.development?.revision ?? 0))
        throw new Error("Workspace modificato durante l'invio: receipt non associata.");
      const binding: RunnerJobEvidence = {
        id: receipt.id, digest: checksum, endpoint: runnerEndpoint(endpoint), label: label.trim(),
        steps: [...selectedSteps], submittedAt: new Date().toISOString(),
        proposalId: pending?.id || null, revision: project.development?.revision ?? 0,
      };
      setReport(null); setExecutionPlan(null); setVerification(null);
      onRunnerBound(binding);
      pendingSubmission.current = null;
      onNotice(retestPlan
        ? "Nuovo re-test per repair " + retestPlan.attempt + "/2 inviato: " + receipt.id +
          ". Attendi i risultati e controlla il diff; nessuna approvazione automatica."
        : "Job inviato: " + receipt.id + ". L'esito sarà valido solo per questo snapshot dei sorgenti.");
    } catch(e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setRequesting(false); }
  };
  const retryRepair = async () => {
    if (!report || !evidence || busy || requesting || repairing) return;
    const verified = await verifyCurrentRunnerReport(project, endpoint, report, evidence);
    if (verified.kind !== "failed" || !project.development?.pending || evidence.proposalId !== project.development.pending.id) {
      onError("Il report non è più valido per questa patch. Esegui di nuovo i test."); return;
    }
    if ((project.development.pending.repairCount ?? 0) >= 2) { onError("Raggiunto il limite di riparazioni AI."); return; }
    if (!window.confirm("Inviare all'AI il log del test fallito e la patch per proporre una correzione? Sarà richiesta una nuova review. Nessuna modifica verrà applicata automaticamente.")) return;
    setRepairing(true);
    try { await onRepair(report, evidence); } finally { setRepairing(false); }
  };
  useEffect(() => {
    if (!onRunnerActivity) return;
    if (!jobId) { onRunnerActivity(null); return; }
    // Do not report an invented running task: no verified receipt/report means unknown.
    if (report?.id !== jobId) return;
    onRunnerActivity({ id: jobId, label: report.label, state: report.state });
    return () => { onRunnerActivity(null); };
  }, [jobId, report?.id, report?.state, report?.label, onRunnerActivity]);
  const displayedReport = report?.id === jobId ? report : null;
  const kind = verification?.kind || "awaiting";
  const canRepair = displayedReport?.state === "failed" && kind === "failed" &&
    evidence?.proposalId && project.development?.pending?.id === evidence.proposalId &&
    (project.development.pending.repairCount ?? 0) < 2;
  return <section className="panel">
    <div className="panel-title"><div><div className="eyebrow">REMOTE EXECUTION / TEST RUNNER</div><h3>Test e compilazione reali</h3></div><Cloud size={20} className="muted" /></div>
    <RunnerTelemetry endpoint={endpoint} active={requesting || Boolean(report?.state === "running" || report?.state === "queued")} />
    <p className="helper">L'esito è associato all'impronta SHA-256 del codice inviato. Se la patch o il progetto cambiano, il risultato diventa automaticamente <strong>obsoleto</strong>.</p>
    {!endpoint && <div className="code-agent-warning"><ShieldAlert size={17}/> Configura URL e API key in Settings → Remote runner.</div>}
    {isRepair && !readSecret("runner.operator.key") &&
      <div className="code-agent-warning"><ShieldAlert size={17}/>
        Configura anche la credenziale operatore repair nelle Impostazioni: la chiave dei job non autorizza review o approvazioni.
      </div>}
    {isRepair && <div className={retestPlan ? "runner-verification" : "code-agent-warning"}>
      <ShieldAlert size={17}/>
      <span>{retestPlan
        ? "Repair " + retestPlan.attempt + "/2 · job fallito " + retestPlan.failedJobId.slice(0, 8) +
          " · re-test obbligatorio: " + retestPlan.steps.join(", ") +
          ". Gli step falliti e le build necessarie non possono essere esclusi."
        : "Repair in attesa di review positiva o evidenze valide. Nessun test o codice verrà applicato automaticamente."}</span>
    </div>}
    {isRepair && pendingRepair?.repairSession && <p className="helper">
      Checkpoint persistente <code>{pendingRepair.repairSession.id.slice(0, 8)}…</code>
      {checkpointState === "saved" ? " · esito test registrato" :
        checkpointState === "syncing" ? " · sincronizzazione esito in corso" :
        checkpointState === "error" ? " · sincronizzazione fallita: approvazione bloccata" :
        " · l'esito verificato sarà registrato dopo i test"}
    </p>}
    {isRepair && checkpointState === "error" && displayedReport?.state !== "incomplete" && <div className="panel-footer">
      <span>Se il re-test è terminato, reinserisci la chiave del proponente (scope propose) e riprova il checkpoint. Non è un nuovo test.</span>
      <button className="secondary" disabled={requesting || repairing || busy}
        onClick={() => setSyncRetry(x => x + 1)}>Riprova sincronizzazione</button>
    </div>}
    <div className="runner-checks">{AVAILABLE.map(({ step, label }) =>
      <label className="checkline" key={step}><input type="checkbox" checked={steps.includes(step)} disabled={requesting || repairing}
        onChange={e => setSteps(current => e.target.checked ? [...current, step] : current.filter(x => x !== step))}/>{label}</label>)}</div>
    <div className="panel-footer"><span>Le patch non ancora approvate vengono incluse solo nel test. Nessun push o applicazione automatica.</span>
      <button className="secondary" disabled={busy || requesting || repairing || !endpoint || !secret ||
          (isRepair ? !retestPlan : !steps.length)}
        onClick={() => void submit()}>{requesting ? <RefreshCw size={16} className="spinning"/> : <Play size={16}/>}
        {requesting ? "Invio..." : retestPlan ? "Conferma e riesegui test repair" : "Avvia test sul runner"}</button></div>
    <RunnerBatchPanel project={project} settings={settings} selectedSteps={steps}
      busy={busy || requesting || repairing} onNotice={onNotice} onError={onError}/>
    {jobId && <div className="runner-report">
      <div className="runner-report-title"><strong><Activity size={16}/> Job {jobId.slice(0, 8)}</strong>
        {displayedReport && <span className={"runner-state " + kind}>{kind === "awaiting" ? displayedReport.state.toUpperCase() : kind.toUpperCase()}</span>}</div>
      {pollNotice && <div className="code-agent-warning">
        <ShieldAlert size={17}/>
        <span>{pollNotice.detail}</span>
        {pollNotice.kind !== "retrying" &&
          <button className="secondary" disabled={busy || requesting || repairing || !endpoint || !secret}
            onClick={() => setPollRestart(x => x + 1)}>Riprova lettura</button>}
      </div>}
      {!displayedReport ? <p className="helper">{pollNotice
        ? "Nessun report verificato disponibile: non dedurre l'esito dei test."
        : "Caricamento report dal runner..."}</p> : <>
        <p className="helper">{displayedReport.summary}</p>
        <div className={"runner-verification " + (kind === "passed" ? "ok" : kind === "stale" || kind === "invalid" ? "invalid" : "")}>
          {kind === "passed" ? <CheckCircle2 size={17}/> : kind === "awaiting" ? <Clock size={17}/> : <ShieldAlert size={17}/>}
          <span>{verification?.detail || "Verifica fingerprint e risultati in corso..."}</span>
        </div>
        <small>Digest snapshot: <code>{displayedReport.digest.slice(0, 20)}…</code> · Avviato: {displayedReport.startedAt || "in coda"}</small>
        {executionPlan && executionPlan.jobId === displayedReport.id &&
          executionPlan.evidence.head === displayedReport.evidence?.head &&
          <details className="runner-step">
            <summary><Activity size={15}/><strong>Piano PM del job (journal verificato)</strong>
              <span>{executionPlan.evidence.count} checkpoint</span></summary>
            <p>Dipendenze e risultati derivati dal journal del runner. Nessun PM o tester AI viene avviato automaticamente.</p>
            <ol className="runner-plan-list">{executionPlan.tasks.map(task =>
              <li key={task.id}><strong>{task.id}</strong><span>{task.status}</span>
                <small>{task.dependsOn.length ? "Dopo: " + task.dependsOn.join(", ") : "Primo step"}</small></li>)}</ol>
          </details>}
        {!executionPlan && <p className="helper">Piano PM server non disponibile o non correlato: consulta il report verificato, senza dedurre un successo dal solo job.</p>}
        {displayedReport.preparation && <details className="runner-step">
          <summary>{displayedReport.preparation.state === "passed" ?
            <CheckCircle2 size={15} className="ok"/> : <ShieldAlert size={15} className="danger"/>}
            <strong>Preparazione dipendenze npm</strong>
            <span>{displayedReport.preparation.state} · exit {displayedReport.preparation.exitCode ?? "—"}</span></summary>
          <p>Preparazione isolata con script lifecycle disabilitati. Un fallimento qui è un problema di setup, non dimostra un bug nel codice.</p>
          {displayedReport.preparation.stdout && <pre>{displayedReport.preparation.stdout}</pre>}
          {displayedReport.preparation.stderr && <pre>{displayedReport.preparation.stderr}</pre>}
        </details>}
        {displayedReport.results.map((result, index) => <details key={index} className="runner-step">
          <summary>{result.state === "passed" ? <CheckCircle2 size={15} className="ok"/> :
            result.state === "failed" ? <ShieldAlert size={15} className="danger"/> : <Clock size={15} className="muted"/>}
            <strong>{result.step}</strong><span>{result.state} · exit {result.exitCode ?? "—"} · {result.durationMs ? Math.round(result.durationMs / 1000) + "s" : "—"}</span></summary>
          {result.reason && <p>{result.reason}</p>}
          {result.command && <p>Command: <code>{result.command}</code> · Image: {result.image}</p>}
          {result.stdout && <pre>{result.stdout}</pre>}
          {result.stderr && <pre>{result.stderr}</pre>}
        </details>)}
        {kind === "incomplete" && <p className="code-agent-warning">Esito incompleto: test saltati o problema dell'ambiente. Verifica configurazione runner prima di correggere il codice.</p>}
        {canRepair && <div className="panel-footer"><span>Repair AI: {project.development?.pending?.repairCount ?? 0}/2 · nuova review e nuovo test obbligatori.</span>
          <button className="secondary" disabled={busy || requesting || repairing} onClick={() => void retryRepair()}>
            <Wrench size={15}/> {repairing ? "Riparazione in corso..." : "Proponi correzione AI"}</button></div>}
        {kind === "failed" && !canRepair && <p className="helper">Per correggere è necessaria una proposta ancora pendente, il digest corrente e tentativi AI disponibili.</p>}
      </>}
    </div>}
  </section>;
}
