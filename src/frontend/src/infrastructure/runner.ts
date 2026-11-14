import type { FactoryProject } from "../domain/types";
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
