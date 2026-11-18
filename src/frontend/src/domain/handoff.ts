import { STAGES } from "./defaults";
import { AGENT_ROLES, stageAgentRole } from "./agent-roles";
import { developmentOf } from "./development";
import type { FactoryProject } from "./types";

/**
 * A read-only projection of the current project, not a job scheduler.
 * A stored runner receipt identifies a submission, NEVER a passing test.
 */
export type HandoffStatus =
  "completed" | "ready" | "running" | "failed" | "blocked" |
  "changes_required" | "verification_required";

export type HandoffTask = {
  id: string;
  title: string;
  owner: string;
  dependsOn: string[];
  status: HandoffStatus;
  evidence: string;
};

export type HandoffBoard = {
  tasks: HandoffTask[];
  completed: number;
  nextTaskIds: string[];
};

function agentName(id: string): string {
  return AGENT_ROLES.find(role => role.id === id)?.name ?? "Ruolo non configurato";
}

export function projectHandoffBoard(project: FactoryProject): HandoffBoard {
  const tasks: HandoffTask[] = [];
  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const checkpoint = project.stages.find(value => value.id === stage.id);
    const preceding = i ? tasks[i - 1] : undefined;
    const dependsOn = preceding ? [preceding.id] : [];
    let status: HandoffStatus = "blocked";
    let evidence = "Checkpoint non trovato: controlla il progetto.";
    if (preceding && preceding.status !== "completed") {
      evidence = "Attende un checkpoint valido: " + preceding.title + ".";
    } else if (checkpoint?.status === "complete" && typeof checkpoint.output === "string" &&
      checkpoint.output.trim().length > 0) {
      status = "completed";
      evidence = "Output salvato nel progetto; non prova build, test o approvazioni.";
    } else if (checkpoint?.status === "complete") {
      evidence = "Checkpoint incoerente: marcato completo senza output.";
    } else if (checkpoint?.status === "running") {
      status = "running";
      evidence = "Richiesta AI in esecuzione nella scheda corrente; non è un job persistente.";
    } else if (checkpoint?.status === "failed") {
      status = "failed";
      evidence = "La fase ha segnalato un errore. Riprova dalla AI Factory.";
    } else if (checkpoint?.status === "pending") {
      status = "ready";
      evidence = "Pronto all'avvio manuale dalla AI Factory.";
    }
    tasks.push({
      id: stage.id, title: stage.label, owner: agentName(stageAgentRole(stage.id)),
      dependsOn, status, evidence,
    });
  }

  const development = developmentOf(project);
  const proposal = development.pending;
  const implementationDone = tasks[tasks.length - 1].status === "completed";
  const currentProposal = Boolean(proposal && proposal.revision === development.revision &&
    Array.isArray(proposal.edits) && proposal.edits.length > 0);
  const patchStatus: HandoffStatus = !implementationDone ? "blocked" :
    proposal && !currentProposal ? "blocked" : currentProposal ? "completed" : "ready";
  tasks.push({
    id: "code-proposal", title: "Proposta di patch", owner: agentName("fullstack_developer"),
    dependsOn: ["implementation"], status: patchStatus,
    evidence: !implementationDone ? "Richiede il piano implementativo completato." :
      proposal && !currentProposal ? "Proposta obsoleta o priva di modifiche: non riutilizzare." :
      currentProposal ? "Patch proposta e salvata; nessuna esecuzione del codice attestata." :
      "Apri Code Agent per richiedere una patch supervisionata.",
  });

  const review = currentProposal ? proposal?.review : undefined;
  const reviewStatus: HandoffStatus = patchStatus !== "completed" ? "blocked" :
    review?.verdict === "pass" ? "completed" :
    review?.verdict === "changes_required" ? "changes_required" : "ready";
  tasks.push({
    id: "code-review", title: "Review indipendente", owner: agentName("code_reviewer"),
    dependsOn: ["code-proposal"], status: reviewStatus,
    evidence: reviewStatus === "completed" ?
      "La review della proposta corrente è passata; non equivale a un test eseguito." :
      reviewStatus === "changes_required" ? "La review richiede modifiche alla patch." :
      reviewStatus === "ready" ? "Richiede revisione prima dell'approvazione." :
      "Attende una proposta corrente non obsoleta.",
  });

  const job = development.lastRunnerEvidence;
  const submittedForCurrent = Boolean(currentProposal && job &&
    job.proposalId === proposal?.id && job.revision === development.revision);
  const testStatus: HandoffStatus = reviewStatus !== "completed" ? "blocked" :
    submittedForCurrent ? "verification_required" : "ready";
  tasks.push({
    id: "test-verification", title: "Verifica build e test", owner: agentName("tester"),
    dependsOn: ["code-review"], status: testStatus,
    evidence: testStatus === "blocked" ? "Attende una review valida." :
      submittedForCurrent ? "Job inviato, ma la receipt non ne attesta l'esito: verifica il report live in Code Agent." :
      "Nessun esito attestato in questo piano. Esegui e verifica i test da Code Agent.",
  });

  const repaired = currentProposal && (proposal?.repairCount ?? 0) > 0;
  const approvalStatus: HandoffStatus = reviewStatus !== "completed" ? "blocked" :
    repaired ? "verification_required" : "ready";
  tasks.push({
    id: "human-approval", title: "Approvazione patch", owner: "Supervisore umano",
    dependsOn: repaired ? ["code-review", "test-verification"] : ["code-review"],
    status: approvalStatus,
    evidence: approvalStatus === "blocked" ? "Attende una review della proposta corrente con verdict pass." :
      repaired ? "Dopo un repair sono obbligatori nuovi test reali sul codice corrente; verifica in Code Agent." :
      "Review disponibile: confronta i file e conferma esplicitamente in Code Agent. Non è auto-apply.",
  });

  return {
    tasks,
    completed: tasks.filter(task => task.status === "completed").length,
    nextTaskIds: tasks.filter(task =>
      ["ready", "running", "changes_required", "verification_required"].includes(task.status))
      .map(task => task.id),
  };
}
