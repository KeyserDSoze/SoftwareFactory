import { projectHandoffBoard, type HandoffStatus } from "../domain/handoff";
import type { FactoryProject } from "../domain/types";
import "./agent-handoff.css";

const LABELS: Record<HandoffStatus, string> = {
  completed: "Checkpoint presente",
  ready: "Pronto",
  running: "In corso nella scheda",
  failed: "Errore",
  blocked: "Bloccato",
  changes_required: "Correzioni richieste",
  verification_required: "Verifica necessaria",
};

/** Non-interactive PM overview. Never substitutes live runner verification. */
export default function AgentHandoffBoard({ project }: { project: FactoryProject }) {
  const board = projectHandoffBoard(project);
  const names = new Map(board.tasks.map(task => [task.id, task.title]));
  const upcoming = board.tasks.filter(task => board.nextTaskIds.includes(task.id));
  return <section className="panel handoff-panel" aria-label="Piano di handoff della software house">
    <div className="panel-title">
      <div><span className="eyebrow">PM / TASK DEPENDENCIES</span><h3>Handoff e gate verificabili</h3></div>
      <span className="count-pill">{board.completed}/{board.tasks.length} checkpoint</span>
    </div>
    <p className="handoff-explainer">Piano di sola lettura derivato dai checkpoint salvati.
      Le responsabilità non avviano nuovi agenti. Un job inviato non significa test superato;
      i gate effettivi di review, test e approvazione rimangono nel Code Agent.</p>
    <p className="handoff-next"><strong>Passaggi disponibili: </strong>
      {upcoming.length ? upcoming.map(task => task.title).join(" · ") :
        "Nessuno: controlla i checkpoint e gli eventuali blocchi."}</p>
    <ol className="handoff-list">
      {board.tasks.map(task => <li key={task.id} className="handoff-item">
        <div className="handoff-item-top">
          <div><strong>{task.title}</strong><span className="handoff-owner">{task.owner}</span></div>
          <span className={"handoff-state handoff-" + task.status}>{LABELS[task.status]}</span>
        </div>
        <p>{task.evidence}</p>
        <small>Dipendenze: {task.dependsOn.length ?
          task.dependsOn.map(id => names.get(id) ?? id).join(" · ") : "nessuna"}</small>
      </li>)}
    </ol>
  </section>;
}
