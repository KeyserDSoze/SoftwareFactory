import { useEffect, useRef, useState } from "react";
import { Activity, ChevronDown, ChevronUp, Loader2, Minimize2, Maximize2 } from "lucide-react";
import type { StageId } from "../domain/types";

export type RunnerTaskActivity = {
  id: string; state: "queued" | "running" | "passed" | "failed" | "incomplete";
  label: string;
};
type Props = {
  busy: boolean; operation: string; selectedStage: StageId; projectName: string;
  completed: number; total: number; latestLog: string | undefined;
  runner: RunnerTaskActivity | null;
  onOpen: (section: "pipeline" | "code" | "connections") => void;
};
/**
 * BookWriter-inspired bottom-right task card, based strictly on known state.
 * No synthetic LLM token-stream, no background-worker claims for browser work.
 */
export default function BackgroundTaskToast({
  busy, operation, selectedStage, projectName, completed, total, latestLog, runner, onOpen,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [previewHidden, setPreviewHidden] = useState(false);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [tick, setTick] = useState(Date.now());
  const previous = useRef("");
  const runningJob = runner?.state === "running" || runner?.state === "queued";
  const visible = busy || runningJob;
  const taskId = runningJob && runner ? "runner:" + runner.id : busy ? "app:" + operation : "";
  useEffect(() => {
    if (taskId && previous.current !== taskId) { setStartedAt(Date.now()); setExpanded(false); }
    previous.current = taskId;
  }, [taskId]);
  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [visible]);
  if (!visible) return null;
  const isRunner = Boolean(runningJob);
  const title = isRunner ? "Test sul server" : "SoftwareFactory al lavoro";
  const label = isRunner ? runner!.label : operation || "Elaborazione in corso";
  const section = isRunner || /code agent|patch|review|repair/i.test(label) ? "code" :
    /cloud|github/i.test(label) ? "connections" : "pipeline";
  const durationSeconds = Math.max(0, Math.floor((tick - startedAt) / 1000));
  return <aside className="background-task-toast" aria-label="Attività attuale" role="complementary">
    <div className="background-task-top">
      <button type="button" onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>
        <Loader2 size={17} className="spinning" aria-hidden="true" />
        <span><strong>{title}</strong><small>{projectName || "Progetto"} · {label}</small></span>
        {expanded ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
      </button>
      <button type="button" className="background-task-small" aria-label={previewHidden ? "Mostra anteprima" : "Riduci anteprima"}
        onClick={() => { setPreviewHidden(v => !v); setExpanded(false); }}>
        {previewHidden ? <Maximize2 size={16}/> : <Minimize2 size={16}/>}
      </button>
    </div>
    {!previewHidden && <div className="background-task-body">
      <strong><Activity size={15}/> {label}</strong>
      <small>{isRunner
        ? "Job " + runner!.id.slice(0, 8) + " · " + runner!.state
        : "Fase " + selectedStage + " · " + completed + "/" + total + " completate"}
      </small>
      <small>Durata attività visibile: {Math.floor(durationSeconds / 60)}m {durationSeconds % 60}s</small>
      {!isRunner && latestLog && <p className="background-task-log">{latestLog}</p>}
      <button type="button" className="subtle" onClick={() => onOpen(section)}>
        Apri {section === "code" ? "Code Agent / test" : section === "connections" ? "Impostazioni" : "pipeline"} 
      </button>
    </div>}
    {expanded && <div className="background-task-details">
      <p>{isRunner
        ? "Il job risiede sul runner. Apri i dettagli per verificare l'esito autentico; questa scheda non certifica test superati."
        : "L'attività AI o di sincronizzazione gira nel browser. Non è un agente autonomo che continua con la scheda chiusa."}</p>
      <button type="button" className="secondary" onClick={() => onOpen(section)}>Vedi dettagli e controlli</button>
    </div>}
  </aside>;
}
