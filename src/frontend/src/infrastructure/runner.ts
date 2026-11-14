import type { FactoryProject } from "../domain/types";
import type { RunnerJobEvidence } from "../domain/development";
import { workspaceFiles } from "../domain/development";

export type RunnerStep = "dotnet-build" | "dotnet-test" | "web-build" | "web-test" | "playwright";
export type RunnerStepResult = {
  step: RunnerStep;
  state: "passed" | "failed" | "skipped";
  reason?: string;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  image?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
};
export type RunnerReport = {
  id: string; digest: string; label: string;
  state: "queued" | "running" | "passed" | "failed" | "incomplete";
  summary: string; acceptedAt: string; startedAt: string | null; finishedAt: string | null;
  steps: RunnerStep[]; results: RunnerStepResult[];
};
export type RunnerJobReceipt = { id: string; digest: string; state: "queued" };
export type RunnerVerification = {
  kind: "awaiting" | "passed" | "failed" | "incomplete" | "stale" | "invalid";
  detail: string;
};

const PATH_ALLOWED = [
  /^src\/backend\/(?:applications\/Api|business|domain|infrastructure)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:cs|csproj|json)$/,
  /^src\/frontend\/web\/(?:src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:ts|tsx|css)|(?:index\.html|package\.json|package-lock\.json|vite\.config\.ts|tsconfig\.json|playwright\.config\.ts)|e2e\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.spec\.ts)$/,
  /^tests\/backend\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:cs|csproj|json)$/,
];
export function runnerEndpoint(value: string): string {
  const u = new URL(value);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (!((u.protocol === "https:") || (local && u.protocol === "http:")) ||
      u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw new Error("Runner URL non valido: usa HTTPS oppure HTTP su localhost, senza path o credenziali.");
  return u.origin;
}
export function runnerSourceFiles(project: FactoryProject, includePending: boolean): Record<string, string> {
  const files = workspaceFiles(project);
  if (includePending && project.development?.pending) {
    for (const edit of project.development.pending.edits) files[edit.path] = edit.content;
  }
  const filtered = Object.fromEntries(Object.entries(files).filter(([path]) =>
    !path.includes("..") && !path.split("/").some(segment => segment.startsWith(".")) &&
    PATH_ALLOWED.some(re => re.test(path))));
  if (!Object.keys(filtered).length) throw new Error("Non ci sono file sorgente da verificare.");
  return filtered;
}
async function runnerRequest<T>(baseUrl: string, key: string, endpoint: string, init: RequestInit = {}): Promise<T> {
  if (key.length < 32) throw new Error("Configura l'API key del runner (almeno 32 caratteri).");
  const base = runnerEndpoint(baseUrl);
  let response: Response;
  try { response = await fetch(base + endpoint, {
    ...init, mode: "cors", redirect: "error", cache: "no-store",
    headers: { Authorization: "Bearer " + key, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  }); } catch { throw new Error("Runner non raggiungibile: verifica URL, tunnel, CORS e connessione."); }
  if (!response.ok) {
    let detail = "";
    try { const body = await response.json() as { error?: string; detail?: string }; detail = body.detail || body.error || ""; } catch { /* invalid response */ }
    throw new Error("Runner HTTP " + response.status + (detail ? ": " + detail.slice(0, 300) : ""));
  }
  return response.json() as Promise<T>;
}
export async function submitRunnerJob(baseUrl: string, key: string, label: string, files: Record<string, string>, steps: RunnerStep[], signal?: AbortSignal) {
  return runnerRequest<RunnerJobReceipt>(baseUrl, key, "/v1/jobs", { method: "POST", signal,
    body: JSON.stringify({ label, files, steps }) });
}
export async function fetchRunnerJob(baseUrl: string, key: string, id: string, signal?: AbortSignal) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Runner job ID non valido.");
  return runnerRequest<RunnerReport>(baseUrl, key, "/v1/jobs/" + id, { signal });
}

/**
 * Canonical request equivalent to src/runner/common.mjs validateRequest().
 * The receipt SHA-256 cryptographically binds the exact source snapshot, tests
 * and label to this job. It is a content identity, NOT server attestation.
 */
export function canonicalRunnerRequest(label: string, files: Record<string, string>, steps: RunnerStep[]) {
  const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0));
  return { schemaVersion: 1, label: label.trim(), files: ordered, steps: [...steps] };
}
export async function runnerRequestDigest(label: string, files: Record<string, string>, steps: RunnerStep[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalRunnerRequest(label, files, steps)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
}
export function verifyRunnerResultShape(report: RunnerReport, evidence: RunnerJobEvidence): RunnerVerification {
  if (report.id !== evidence.id || report.digest !== evidence.digest || report.label !== evidence.label ||
      JSON.stringify(report.steps) !== JSON.stringify(evidence.steps))
    return { kind: "invalid", detail: "Identità del report diversa dal job inviato." };
  if (!["queued","running","passed","failed","incomplete"].includes(report.state) ||
      !Array.isArray(report.results) || report.results.length > evidence.steps.length ||
      report.results.some((r, i) => r.step !== evidence.steps[i] || !["passed","failed","skipped"].includes(r.state)))
    return { kind: "invalid", detail: "La struttura degli step non corrisponde al job richiesto." };
  if (report.state === "queued" || report.state === "running")
    return { kind: "awaiting", detail: "Test ancora in corso; nessuna verifica completata." };
  if (report.state === "passed") {
    const actuallyPassed = report.results.length === evidence.steps.length && report.results.every(r =>
      r.state === "passed" && r.exitCode === 0 && r.timedOut !== true && typeof r.durationMs === "number");
    return actuallyPassed
      ? { kind: "passed", detail: "Tutti gli step richiesti risultano effettivamente eseguiti con exit code 0." }
      : { kind: "invalid", detail: "Il server indica passed senza prove complete per tutti gli step." };
  }
  if (report.state === "failed") {
    return report.results.some(r => r.state === "failed")
      ? { kind: "failed", detail: "Almeno uno step eseguito ha riportato errore." }
      : { kind: "incomplete", detail: "Errore di setup o worker: nessun test fallito con output verificabile." };
  }
  return report.results.length === evidence.steps.length && report.results.some(r => r.state === "skipped") &&
    report.results.every(r => r.state !== "failed")
    ? { kind: "incomplete", detail: "Uno o più test non sono stati eseguiti: nessun pass completo." }
    : { kind: "invalid", detail: "Report parziale o contraddittorio." };
}
export async function verifyCurrentRunnerReport(
  project: FactoryProject, endpoint: string, report: RunnerReport,
  evidence: RunnerJobEvidence | undefined,
): Promise<RunnerVerification> {
  if (!evidence) return { kind: "stale", detail: "Job precedente senza fingerprint verificabile: esegui di nuovo i test." };
  if (runnerEndpoint(endpoint) !== evidence.endpoint)
    return { kind: "stale", detail: "L'endpoint del runner è cambiato." };
  const binding = project.development;
  if ((binding?.revision ?? 0) !== evidence.revision ||
      (binding?.pending?.id ?? null) !== evidence.proposalId)
    return { kind: "stale", detail: "La proposta o la revisione del codice è cambiata: risultati non più validi." };
  try {
    const files = runnerSourceFiles(project, evidence.proposalId !== null);
    const currentDigest = await runnerRequestDigest(evidence.label, files, evidence.steps);
    if (currentDigest !== evidence.digest)
      return { kind: "stale", detail: "I sorgenti attuali non coincidono con lo snapshot testato." };
  } catch {
    return { kind: "stale", detail: "Impossibile ricostruire lo snapshot originale." };
  }
  return verifyRunnerResultShape(report, evidence);
}
