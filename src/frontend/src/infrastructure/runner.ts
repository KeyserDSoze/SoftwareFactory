import type { FactoryProject } from "../domain/types";
import type { RunnerJobEvidence } from "../domain/development";
import { workspaceFiles } from "../domain/development";

export type RunnerStep = "dotnet-build" | "dotnet-test" | "web-build" | "web-test" | "playwright";
export type RunnerStepResult = {
  step: RunnerStep | "npm-prepare";
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
  preparation?: RunnerStepResult | null;
};
// A retry may return the existing job's current verified state. A receipt
// alone never certifies that any build/test succeeded: fetch the full report.
export type RunnerJobReceipt = { id: string; digest: string; state: RunnerReport["state"] };
export type RunnerVerification = {
  kind: "awaiting" | "passed" | "failed" | "incomplete" | "stale" | "invalid";
  detail: string;
};

/** Only transient transport/HTTP failures may be polled again. In particular,
 * 401/403 revoke access, 404 is missing and 409 denotes invalid evidence.
 * Do not retry a structurally invalid successful JSON response.
 */
export class RunnerRequestError extends Error {
  constructor(message: string, readonly status: number | null, readonly transient: boolean) {
    super(message);
    this.name = "RunnerRequestError";
  }
}
export function runnerPollDecision(error: unknown, failures: number):
  { retry: true; attempt: number; delayMs: number } | { retry: false } {
  if (!(error instanceof RunnerRequestError) || !error.transient ||
      !Number.isInteger(failures) || failures < 0 || failures >= 5) return { retry: false };
  const attempt = failures + 1;
  return { retry: true, attempt, delayMs: Math.min(30_000, 2500 * 2 ** (attempt - 1)) };
}

const PATH_ALLOWED = [
  /^src\/backend\/(?:applications\/Api|business|domain|infrastructure)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:cs|csproj|json)$/,
  /^src\/backend\/infrastructure\/Migrations\/[0-9]{4}_[A-Za-z0-9_-]+\.sql$/,
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
export async function runnerRequest<T>(baseUrl: string, key: string, endpoint: string, init: RequestInit = {}): Promise<T> {
  if (key.length < 32) throw new Error("Configura l'API key del runner (almeno 32 caratteri).");
  const base = runnerEndpoint(baseUrl);
  let response: Response;
  try { response = await fetch(base + endpoint, {
    ...init, mode: "cors", redirect: "error", cache: "no-store",
    headers: { Authorization: "Bearer " + key, ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}) },
  }); } catch (error) {
    // Cancellation caused by changing job, endpoint, credentials or unmount
    // must never be treated as a retryable tunnel/network failure.
    if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError"))
      throw error;
    throw new RunnerRequestError(
      "Runner non raggiungibile: verifica URL, tunnel, CORS e connessione.", null, true);
  }
  if (!response.ok) {
    let detail = "";
    try { const body = await response.json() as { error?: string; detail?: string }; detail = body.detail || body.error || ""; } catch { /* invalid response */ }
    const status = response.status;
    throw new RunnerRequestError(
      "Runner HTTP " + status + (detail ? ": " + detail.slice(0, 300) : ""),
      status, status === 408 || status === 429 || status >= 500);
  }
  return response.json() as Promise<T>;
}
export async function submitRunnerJob(baseUrl: string, key: string, label: string,
  files: Record<string, string>, steps: RunnerStep[], signal?: AbortSignal,
  idempotencyKey: string = crypto.randomUUID()) {
  return runnerRequest<RunnerJobReceipt>(baseUrl, key, "/v1/jobs", { method: "POST", signal,
    headers: { "Idempotency-Key": idempotencyKey },
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

/**
 * Read-only connector onboarding probe. Never submits source snapshots or
 * starts a Docker container. Only a worker's recent daemon observation is
 * checked; this is not a successful SDK build, security attestation or VM audit.
 */
export type RunnerConnectorProbe =
  | { state: "ready"; detail: string; steps: RunnerStep[] }
  | { state: "auth-failed" | "api-unavailable" | "unsupported" | "worker-offline" | "docker-unavailable";
      detail: string; steps?: RunnerStep[] };

function connectorFailure(error: unknown): RunnerConnectorProbe {
  if (error instanceof RunnerRequestError && (error.status === 401 || error.status === 403))
    return { state: "auth-failed", detail: "Credenziale rifiutata oppure origin browser non autorizzato (401/403)." };
  return { state: "api-unavailable", detail: "API non raggiungibile o risposta inattesa. Verifica HTTPS/localhost, tunnel, CORS e credenziale." };
}

function connectorObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const CONNECTOR_STEPS: RunnerStep[] = ["dotnet-build", "dotnet-test", "web-build", "web-test", "playwright"];

export async function probeRunnerConnector(baseUrl: string, key: string,
  signal?: AbortSignal): Promise<RunnerConnectorProbe> {
  let payload: unknown;
  try { payload = await runnerRequest<unknown>(baseUrl, key, "/v1/capabilities", { signal }); }
  catch (error) { if (signal?.aborted) throw error; return connectorFailure(error); }
  if (!connectorObject(payload) || payload.protocol !== 1 ||
      payload.execution !== "remote-docker" || payload.networkDefault !== "none" ||
      !Array.isArray(payload.steps) || payload.steps.length === 0 ||
      payload.steps.length > CONNECTOR_STEPS.length ||
      payload.steps.some((step: unknown) => !CONNECTOR_STEPS.includes(step as RunnerStep)) ||
      new Set(payload.steps).size !== payload.steps.length)
    return { state: "unsupported", detail: "Il runner non dichiara il protocollo 1 e la policy Docker/network attesi." };
  const steps = payload.steps as RunnerStep[];

  let readiness: unknown;
  try { readiness = await runnerRequest<unknown>(baseUrl, key, "/v1/readiness", { signal }); }
  catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof RunnerRequestError && error.status === 503)
      return { state: "worker-offline", detail: "API autenticata, ma heartbeat del worker assente o scaduto. Nessun test eseguito.", steps };
    return connectorFailure(error);
  }
  if (!connectorObject(readiness) || readiness.status !== "ready" || readiness.worker !== "responsive")
    return { state: "unsupported", detail: "Heartbeat worker non verificabile: nessuna esecuzione confermata.", steps };

  let execution: unknown;
  try { execution = await runnerRequest<unknown>(baseUrl, key, "/v1/execution-readiness", { signal }); }
  catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof RunnerRequestError && error.status === 503)
      return { state: "docker-unavailable", detail: "Worker presente, ma prova recente del daemon Docker rootless indisponibile.", steps };
    return connectorFailure(error);
  }
  if (!connectorObject(execution) || execution.status !== "ready" ||
      execution.worker !== "responsive" || execution.docker !== "rootless")
    return { state: "unsupported", detail: "Il runner non conferma il daemon Docker rootless.", steps };
  return { state: "ready", detail: "API autenticata, worker attivo e daemon rootless osservato recentemente. Nessuna build o esecuzione sandbox è stata verificata.", steps };
}

/** Aggregate machine telemetry published by the remote worker, not a power meter. */
export type RunnerHostMetrics = {
  version: 1;
  measuredAt: string;
  cpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  uptimeSeconds: number | null;
  cpuTemperatureC: number | null;
};
export function validateRunnerHostMetrics(value: unknown): RunnerHostMetrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Metriche runner non valide.");
  const d = value as Record<string, unknown>;
  const number = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  const optional = (v: unknown, lo: number, hi: number) => v === null || number(v, lo, hi);
  if (Object.keys(d).sort().join(",") !== [
    "version", "measuredAt", "cpuPercent", "memoryUsedBytes", "memoryTotalBytes",
    "diskUsedBytes", "diskTotalBytes", "uptimeSeconds", "cpuTemperatureC",
  ].sort().join(",") ||
    d.version !== 1 || typeof d.measuredAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(d.measuredAt) ||
    !Number.isFinite(Date.parse(d.measuredAt)) ||
    Date.now() - Date.parse(d.measuredAt) > 60_000 ||
    Date.parse(d.measuredAt) > Date.now() + 1000 ||
    !optional(d.cpuPercent, 0, 100) ||
    !number(d.memoryTotalBytes, 1, Number.MAX_SAFE_INTEGER) ||
    !number(d.memoryUsedBytes, 0, d.memoryTotalBytes as number) ||
    !optional(d.diskTotalBytes, 0, Number.MAX_SAFE_INTEGER) ||
    (d.diskTotalBytes === null ? d.diskUsedBytes !== null :
      !number(d.diskUsedBytes, 0, d.diskTotalBytes as number)) ||
    !optional(d.uptimeSeconds, 0, Number.MAX_SAFE_INTEGER) ||
    !optional(d.cpuTemperatureC, 0, 125))
    throw new Error("Metriche runner mancanti, vecchie o non plausibili.");
  return value as RunnerHostMetrics;
}
export async function fetchRunnerHostMetrics(baseUrl: string, key: string, signal?: AbortSignal) {
  const data = await runnerRequest<unknown>(baseUrl, key, "/v1/host-metrics", { method: "GET", signal });
  return validateRunnerHostMetrics(data);
}
