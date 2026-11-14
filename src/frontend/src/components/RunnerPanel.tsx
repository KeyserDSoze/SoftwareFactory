import { useEffect, useState } from "react";
import { Activity, CheckCircle2, Clock, Cloud, Play, RefreshCw, ShieldAlert } from "lucide-react";
import type { FactoryProject, FactorySettings } from "../domain/types";
import { readSecret } from "../infrastructure/store";
import { fetchRunnerJob, runnerSourceFiles, submitRunnerJob, type RunnerReport, type RunnerStep } from "../infrastructure/runner";

type Props = {
  project: FactoryProject;
  settings: FactorySettings;
  busy: boolean;
  onProjectChange: (project: FactoryProject) => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
};
const AVAILABLE: { step: RunnerStep; label: string }[] = [
  { step: "dotnet-build", label: ".NET build" },
  { step: "dotnet-test", label: ".NET test" },
  { step: "web-build", label: "React build" },
  { step: "web-test", label: "Frontend tests" },
  { step: "playwright", label: "Playwright E2E" },
];
const terminal = (state: string) => ["passed", "failed", "incomplete"].includes(state);
export default function RunnerPanel({ project, settings, busy, onProjectChange, onNotice, onError }: Props) {
  const [steps, setSteps] = useState<RunnerStep[]>(["dotnet-build", "web-build"]);
  const [report, setReport] = useState<RunnerReport | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [jobId, setJobId] = useState(() => project.development?.lastRunnerJobId || "");
  const endpoint = settings.runnerEndpoint || "";
  const secret = readSecret("runner.key");
  useEffect(() => { setJobId(project.development?.lastRunnerJobId || ""); }, [project.id]);
  useEffect(() => {
    if (!jobId || !endpoint || !secret) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const next = await fetchRunnerJob(endpoint, secret, jobId, controller.signal);
        if (disposed) return;
        setReport(next);
        if (!terminal(next.state)) timer = setTimeout(() => void tick(), 2500);
      } catch (e) {
        if (!disposed) onError("Report runner: " + (e instanceof Error ? e.message : String(e)));
      }
    };
    void tick();
    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [jobId, endpoint, secret, onError]);
  const submit = async () => {
    if (busy || requesting) return;
    if (!endpoint || !secret) { onError("Configura URL e API key del runner nelle Impostazioni."); return; }
    if (!steps.length) { onError("Seleziona almeno un tipo di test."); return; }
    const pending = project.development?.pending;
    const label = project.config.name + (pending ? " · proposal: " + pending.summary : " · approved workspace");
    if (!confirm("Inviare il codice sorgente al runner remoto? Verrà eseguito in container isolati sul tuo server, non nel browser.")) return;
    setRequesting(true);
    try {
      const files = runnerSourceFiles(project, true);
      const receipt = await submitRunnerJob(endpoint, secret, label.slice(0, 160), files, steps);
      setJobId(receipt.id);
      setReport(null);
      onProjectChange({ ...project, development: {
        ...(project.development || { revision: 0, overrides: {}, originals: {}, history: [] }),
        lastRunnerJobId: receipt.id,
      } });
      onNotice("Job inviato: " + receipt.id + ". Il worker elaborerà gli step e pubblicherà il report.");
    } catch(e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setRequesting(false); }
  };
  return <section className="panel">
    <div className="panel-title"><div><div className="eyebrow">REMOTE EXECUTION / TEST RUNNER</div><h3>Test e compilazione reali</h3></div><Cloud size={20} className="muted" /></div>
    <p className="helper">Test nel runner Docker remoto, con immagini preconfigurate, rete disabilitata di default e limiti per processo. Il report è una prova di esecuzione, non una certificazione di sicurezza.</p>
    {!endpoint && <div className="code-agent-warning"><ShieldAlert size={17}/> Configura URL e API key in Settings → Remote runner.</div>}
    <div className="runner-checks">{AVAILABLE.map(({ step, label }) =>
      <label className="checkline" key={step}><input type="checkbox" checked={steps.includes(step)} disabled={requesting}
        onChange={e => setSteps(current => e.target.checked ? [...current, step] : current.filter(x => x !== step))}/>{label}</label>)}</div>
    <div className="panel-footer"><span>Le patch non ancora approvate vengono incluse nel test, senza essere pubblicate su GitHub.</span>
      <button className="secondary" disabled={busy || requesting || !endpoint || !secret || !steps.length}
        onClick={() => void submit()}>{requesting ? <RefreshCw size={16} className="spinning"/> : <Play size={16}/>}
        {requesting ? "Invio..." : "Invia al runner"}</button></div>
    {jobId && <div className="runner-report">
      <div className="runner-report-title"><strong><Activity size={16}/> Job {jobId.slice(0, 8)}</strong>
        {report && <span className={"runner-state " + report.state}>{report.state.toUpperCase()}</span>}</div>
      {!report ? <p className="helper">Caricamento report dal runner...</p> : <>
        <p className="helper">{report.summary}</p>
        <small>Digest sorgenti + selezione: <code>{report.digest.slice(0, 20)}…</code> · Avviato: {report.startedAt || "in coda"}</small>
        {report.results.map((result, index) => <details key={index} className="runner-step">
          <summary>{result.state === "passed" ? <CheckCircle2 size={15} className="ok"/> :
            result.state === "failed" ? <ShieldAlert size={15} className="danger"/> : <Clock size={15} className="muted"/>}
            <strong>{result.step}</strong><span>{result.state} · exit {result.exitCode ?? "—"} · {result.durationMs ? Math.round(result.durationMs / 1000) + "s" : "—"}</span></summary>
          {result.reason && <p>{result.reason}</p>}
          {result.command && <p>Command: <code>{result.command}</code> · Image: {result.image}</p>}
          {result.stdout && <pre>{result.stdout}</pre>}
          {result.stderr && <pre>{result.stderr}</pre>}
        </details>)}
        {report.state === "incomplete" && <p className="code-agent-warning">Alcuni step sono stati saltati: esito incompleto, non un test completamente superato.</p>}
      </>}
    </div>}
  </section>;
}
