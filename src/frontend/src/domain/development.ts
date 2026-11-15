import type { FactoryProject } from "./types";
import { generateFiles } from "../application/scaffold";

export type FeatureEdit = { path: string; content: string; reason: string; previous: string | null };
export type FeatureReview = {
  verdict: "pass" | "changes_required";
  report: string;
  completedAt: string;
};
export type FeatureProposal = {
  id: string;
  request: string;
  summary: string;
  createdAt: string;
  revision: number;
  edits: FeatureEdit[];
  tests: string[];
  assumptions: string[];
  review?: FeatureReview;
  repairCount?: number;
  previousProposalId?: string;
  /** Server-verified failed jobs that caused each bounded repair; no log or token storage. */
  repairTrail?: RepairAttempt[];
};
export type RepairAttempt = {
  attempt: number;
  failedJobId: string;
  failedDigest: string;
  steps: RunnerJobEvidence["steps"];
};
export type AppliedFeature = {
  id: string;
  request: string;
  summary: string;
  appliedAt: string;
  edits: FeatureEdit[];
  review: FeatureReview;
  status: "applied" | "reverted" | "superseded";
};
export type RunnerJobEvidence = {
  id: string;
  digest: string;
  endpoint: string;
  label: string;
  steps: ("dotnet-build" | "dotnet-test" | "web-build" | "web-test" | "playwright")[];
  submittedAt: string;
  proposalId: string | null;
  revision: number;
};
export type DevelopmentWorkspace = {
  revision: number;
  overrides: Record<string, string>;
  originals: Record<string, string | null>;
  history: AppliedFeature[];
  pending?: FeatureProposal;
  lastRunnerJobId?: string;
  lastRunnerEvidence?: RunnerJobEvidence;
};
export const emptyDevelopment = (): DevelopmentWorkspace => ({
  revision: 0, overrides: {}, originals: {}, history: [],
});
export function developmentOf(project: FactoryProject): DevelopmentWorkspace {
  return project.development || emptyDevelopment();
}
export function allowedCodePath(path: string): boolean {
  if (typeof path !== "string" || path.length > 180 || path.includes("..") ||
      path.includes("\\") || path.startsWith("/") || path.includes("//") ||
      /[\x00-\x1f]/.test(path) || path.split("/").some(s => s.startsWith("."))) return false;
  return /^src\/backend\/(?:applications\/Api|business|domain|infrastructure)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z][A-Za-z0-9_-]*\.cs$/.test(path) ||
    /^src\/frontend\/web\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z][A-Za-z0-9_-]*\.(?:ts|tsx|css)$/.test(path) ||
    /^src\/frontend\/web\/e2e\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z][A-Za-z0-9_-]*\.spec\.ts$/.test(path);
}
export function workspaceConflicts(project: FactoryProject): string[] {
  const dev = developmentOf(project);
  if (!Object.keys(dev.originals).length) return [];
  const baseline = generateFiles(project);
  return Object.keys(dev.originals).filter(path =>
    (baseline[path] ?? null) !== dev.originals[path]).sort();
}
export function workspaceFiles(project: FactoryProject): Record<string, string> {
  const base = generateFiles(project);
  const dev = developmentOf(project);
  const conflicts = workspaceConflicts(project);
  if (conflicts.length) throw new Error("Config changed the generated baseline for: " + conflicts.join(", ") +
    ". Resolve the conflicts in Code Agent before exporting or pushing.");
  const result = { ...base, ...dev.overrides };
  const applied = dev.history.filter(h => h.status === "applied");
  if (applied.length) {
    result["docs/feature-implementation.md"] = [
      "# Feature implementation log", "",
      "> AI-proposed changes, independently reviewed and explicitly accepted by the user.",
      "> This ledger is not proof of successful compilation or executed tests.", "",
      ...applied.flatMap(h => [
        "## " + h.summary.replace(/[\r\n#]/g, " ").slice(0, 160), "",
        "- Accepted: " + h.appliedAt,
        "- Paths: " + h.edits.map(e => "`" + e.path + "`").join(", "),
        "- Adversarial verdict: " + h.review.verdict,
        "- Review: " + h.review.report.replace(/[\r\n]/g, " ").slice(0, 800),
        "",
      ]),
    ].join("\n") + "\n";
  }
  return result;
}
export function validateProposal(raw: string, project: FactoryProject, request: string): FeatureProposal {
  if (!request.trim() || request.length > 2000) throw new Error("La feature deve essere descritta (massimo 2000 caratteri).");
  const dev = developmentOf(project);
  if (dev.pending) throw new Error("Esiste già una patch in attesa: approvala o scartala.");
  if (workspaceConflicts(project).length) throw new Error("Risolvi prima i conflitti con lo scaffold.");
  if (raw.length > 145000) throw new Error("Risposta AI troppo grande: suddividi la feature.");
  const trimmed = raw.trim();
  const text = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") : trimmed;
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { throw new Error("Risposta AI non in formato JSON valido."); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Risposta AI non è un oggetto.");
  const value = decoded as Record<string, unknown>;
  if (typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 1000)
    throw new Error("Manca un riepilogo valido della patch.");
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > 8)
    throw new Error("La patch deve modificare da 1 a 8 file.");
  const originalFiles = workspaceFiles(project);
  const paths = new Set<string>();
  let total = 0;
  const edits: FeatureEdit[] = value.files.map((unknownEdit: unknown) => {
    if (!unknownEdit || typeof unknownEdit !== "object" || Array.isArray(unknownEdit))
      throw new Error("Edit non valido.");
    const edit = unknownEdit as Record<string, unknown>;
    const path = edit.path;
    if (typeof path !== "string" || !allowedCodePath(path))
      throw new Error("Path non permesso: " + String(path).slice(0, 200));
    if (paths.has(path)) throw new Error("Path duplicato: " + path);
    paths.add(path);
    if (typeof edit.content !== "string" || !edit.content.trim() || edit.content.length > 32000)
      throw new Error("Contenuto file vuoto o troppo grande: " + path);
    if (typeof edit.reason !== "string" || !edit.reason.trim() || edit.reason.length > 500)
      throw new Error("Motivazione mancante: " + path);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}/.test(edit.content))
      throw new Error("Possibile credenziale nel contenuto. Non includere secret o private key.");
    total += edit.content.length;
    const previous = originalFiles[path] ?? null;
    if (previous === edit.content) throw new Error("Nessuna differenza rispetto al file corrente: " + path);
    return { path, content: edit.content, reason: edit.reason, previous };
  });
  if (total > 85000) throw new Error("Patch troppo grande: suddividi la feature.");
  const strings = (key: "tests" | "assumptions"): string[] => {
    const v = value[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 15 || v.some(s => typeof s !== "string" || s.length > 300))
      throw new Error("Campo " + key + " non valido.");
    return v as string[];
  };
  return {
    id: crypto.randomUUID(), request: request.trim(), summary: value.summary.trim(),
    createdAt: new Date().toISOString(), revision: dev.revision,
    edits, tests: strings("tests"), assumptions: strings("assumptions"),
  };
}
export function setPending(project: FactoryProject, proposal: FeatureProposal): FactoryProject {
  const dev = developmentOf(project);
  if (dev.pending || proposal.revision !== dev.revision || workspaceConflicts(project).length)
    throw new Error("Workspace cambiato durante la generazione. Patch scartata.");
  return { ...project, development: { ...dev, pending: proposal }, updatedAt: new Date().toISOString() };
}
export function saveReview(project: FactoryProject, id: string, review: FeatureReview): FactoryProject {
  const dev = developmentOf(project);
  if (!dev.pending || dev.pending.id !== id) throw new Error("Patch non più attiva.");
  return { ...project, development: { ...dev, pending: { ...dev.pending, review } }, updatedAt: new Date().toISOString() };
}
export function rejectPending(project: FactoryProject): FactoryProject {
  const dev = developmentOf(project);
  return { ...project, development: { ...dev, pending: undefined }, updatedAt: new Date().toISOString() };
}
export function approvePending(project: FactoryProject, options: { verifiedRepair?: boolean } = {}): FactoryProject {
  const dev = developmentOf(project), proposal = dev.pending;
  if (!proposal) throw new Error("Nessuna patch in attesa.");
  if (proposal.review?.verdict !== "pass") throw new Error("La review avversaria non ha approvato la patch.");
  if ((proposal.repairCount ?? 0) > 0 && options.verifiedRepair !== true)
    throw new Error("Dopo un repair sono obbligatori nuovi test reali superati sul codice corrente.");
  if (proposal.revision !== dev.revision || workspaceConflicts(project).length)
    throw new Error("Patch obsoleta, occorre rigenerarla.");
  const files = workspaceFiles(project);
  const overrides = { ...dev.overrides }, originals = { ...dev.originals };
  for (const edit of proposal.edits) {
    if ((files[edit.path] ?? null) !== edit.previous)
      throw new Error("Il file " + edit.path + " è cambiato: approvazione rifiutata.");
    if (!(edit.path in originals)) originals[edit.path] = generateFiles(project)[edit.path] ?? null;
    overrides[edit.path] = edit.content;
  }
  const record: AppliedFeature = { id: proposal.id, request: proposal.request, summary: proposal.summary,
    appliedAt: new Date().toISOString(), edits: proposal.edits, review: proposal.review, status: "applied" };
  return { ...project, development: {
    ...dev, revision: dev.revision + 1, pending: undefined, overrides, originals,
    history: [...dev.history, record].slice(-50),
  }, updatedAt: new Date().toISOString() };
}
export function undoLatest(project: FactoryProject): FactoryProject {
  const dev = developmentOf(project);
  if (dev.pending) throw new Error("Scarta prima la patch in attesa.");
  if (workspaceConflicts(project).length) throw new Error("Risolvi prima i conflitti.");
  const history = dev.history.slice();
  let index = history.length - 1;
  while (index >= 0 && history[index].status !== "applied") index--;
  if (index < 0) throw new Error("Nessuna feature da annullare.");
  const entry = history[index], base = generateFiles(project), files = workspaceFiles(project);
  for (const edit of entry.edits) if ((files[edit.path] ?? null) !== edit.content)
    throw new Error("Non posso annullare: il file " + edit.path + " è stato modificato successivamente.");
  const overrides = { ...dev.overrides }, originals = { ...dev.originals };
  for (const edit of entry.edits) {
    if (edit.previous === (base[edit.path] ?? null)) {
      delete overrides[edit.path]; delete originals[edit.path];
    } else if (edit.previous === null) {
      delete overrides[edit.path]; delete originals[edit.path];
    } else overrides[edit.path] = edit.previous;
  }
  history[index] = { ...entry, status: "reverted" };
  return { ...project, development: { ...dev, revision: dev.revision + 1, overrides, originals, history },
    updatedAt: new Date().toISOString() };
}
export function dropConflictingChanges(project: FactoryProject): FactoryProject {
  const dev = developmentOf(project), conflicts = workspaceConflicts(project);
  if (!conflicts.length) return project;
  const overrides = { ...dev.overrides }, originals = { ...dev.originals };
  for (const path of conflicts) { delete overrides[path]; delete originals[path]; }
  const history = dev.history.map(h => h.status === "applied" && h.edits.some(e => conflicts.includes(e.path))
    ? { ...h, status: "superseded" as const } : h);
  return { ...project, development: { ...dev, revision: dev.revision + 1, overrides, originals, pending: undefined, history },
    updatedAt: new Date().toISOString() };
}

/**
 * One guarded attempt at repairing an existing pending proposal.
 * The AI may REPLACE only the same files, not expand its access to new paths.
 * Prior review and runner evidence are invalidated: repair never auto-approves.
 */
export function replacePendingWithRepair(
  project: FactoryProject, proposalId: string, raw: string,
  evidence?: RunnerJobEvidence,
): FactoryProject {
  const dev = developmentOf(project), old = dev.pending;
  if (!old || old.id !== proposalId) throw new Error("Proposta cambiata durante la correzione.");
  if (old.revision !== dev.revision || workspaceConflicts(project).length)
    throw new Error("Workspace modificato: riparazione annullata.");
  const previousCount = old.repairCount ?? 0;
  if (previousCount >= 2) throw new Error("Massimo due riparazioni AI per proposta.");
  if (evidence && (evidence.proposalId !== old.id || evidence.revision !== dev.revision ||
      dev.lastRunnerEvidence?.id !== evidence.id || dev.lastRunnerEvidence?.digest !== evidence.digest ||
      !Array.isArray(evidence.steps) || !evidence.steps.length))
    throw new Error("Prove del job fallito non più associate alla proposta: repair annullato.");
  const bare: FactoryProject = { ...project, development: { ...dev, pending: undefined } };
  const next = validateProposal(raw, bare, old.request);
  const oldPaths = old.edits.map(e => e.path).sort();
  const newPaths = next.edits.map(e => e.path).sort();
  if (JSON.stringify(oldPaths) !== JSON.stringify(newPaths))
    throw new Error("La riparazione può modificare solo gli stessi file della proposta.");
  if (next.edits.every(edit => edit.content === old.edits.find(oldEdit => oldEdit.path === edit.path)?.content))
    throw new Error("La riparazione non ha modificato nessun file.");
  return {
    ...project,
    development: {
      ...dev,
      pending: { ...next, repairCount: previousCount + 1, previousProposalId: old.id,
        repairTrail: [
          ...(old.repairTrail || []),
          ...(evidence ? [{ attempt: previousCount + 1, failedJobId: evidence.id,
            failedDigest: evidence.digest, steps: [...evidence.steps] }] : []),
        ],
      },
      lastRunnerJobId: undefined,
      lastRunnerEvidence: undefined,
    },
    updatedAt: new Date().toISOString(),
  };
}
