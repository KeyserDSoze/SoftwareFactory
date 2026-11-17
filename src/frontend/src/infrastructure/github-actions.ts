import type { GitConfig } from "../domain/types";
import { validateGitConfig } from "./github";
import { unzipSync } from "fflate";

export const ACTION_STEPS = ["dotnet-build", "dotnet-test", "web-build", "web-test", "playwright"] as const;
export type ActionTestStep = typeof ACTION_STEPS[number];
export type GithubActionReceipt = {
  requestId: string; repository: string; branch: string; commitSha: string;
  createdAt: string; selected: ActionTestStep[];
  runId?: number;
};
export type ActionStepResult = {
  id: ActionTestStep; status: "passed" | "failed" | "incomplete";
  exitCode: number | null; durationMs: number; reason: string; output: string;
};
export type GithubActionReport = {
  schemaVersion: 1; requestId: string; repository: string; ref: string;
  commitSha: string; runId: number; runAttempt: number;
  startedAt: string; finishedAt: string;
  state: "passed" | "failed" | "incomplete";
  summary: { requested: number; passed: number; failed: number; incomplete: number };
  steps: ActionStepResult[];
};
export type GitHubWorkflowRun = {
  id: number; event: string; name: string; display_title: string; head_branch: string;
  head_sha: string; status: "queued"|"in_progress"|"completed"|"waiting"|"requested"|"pending";
  conclusion: string|null; html_url: string; run_attempt: number; created_at: string;
};
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const WORKFLOW = "softwarefactory-tests.yml";
function required(cond: unknown, message: string): asserts cond {
  if (!cond) throw Error(message);
}
function safeRoot(git: GitConfig): string {
  validateGitConfig(git);
  return "/repos/" + git.owner + "/" + git.repo;
}
async function gh<T>(rootPath: string, token: string, init: RequestInit = {}): Promise<T> {
  required(token.length > 10, "Configura un PAT GitHub con permessi Actions e Contents.");
  const response = await fetch("https://api.github.com" + rootPath, {
    ...init, mode: "cors", cache: "no-store", redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: "Bearer " + token,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok)
    throw Error("GitHub Actions HTTP " + response.status +
      ". Verifica che la action esista sul branch predefinito e il PAT abbia Actions:write/read e Contents:read.");
  return response.status === 204 ? ({} as T) : response.json() as Promise<T>;
}
export async function launchGithubTests(
  git: GitConfig, token: string, selected: ActionTestStep[],
): Promise<GithubActionReceipt> {
  const root = safeRoot(git);
  required(selected.length > 0 && selected.length <= ACTION_STEPS.length &&
    selected.every(x => ACTION_STEPS.includes(x)) && new Set(selected).size === selected.length,
    "Seleziona almeno un test valido, senza duplicati.");
  const sha = await gh<{ object: { sha: string } }>(
    root + "/git/ref/heads/" + git.branch.split("/").map(encodeURIComponent).join("/"), token);
  const commitSha = sha.object?.sha;
  required(typeof commitSha === "string" && SHA.test(commitSha),
    "GitHub non ha restituito lo SHA esatto del branch.");
  const receipt: GithubActionReceipt = {
    requestId: crypto.randomUUID(), repository: git.owner + "/" + git.repo,
    branch: git.branch, commitSha, createdAt: new Date().toISOString(), selected: [...selected],
  };
  required(UUID.test(receipt.requestId), "Identificativo dispatch non valido.");
  const inputs: Record<string, string> = { request_id: receipt.requestId };
  for (const name of ACTION_STEPS) inputs[name.replace(/-/g, "_")] = selected.includes(name) ? "true" : "false";
  await gh(root + "/actions/workflows/" + WORKFLOW + "/dispatches", token, {
    method: "POST", body: JSON.stringify({ ref: git.branch, inputs }),
  });
  return receipt;
}
export function checkActionReceipt(value: unknown): GithubActionReceipt {
  required(value && typeof value === "object" && !Array.isArray(value), "Receipt GitHub Actions mancante.");
  const r = value as GithubActionReceipt;
  required(UUID.test(r.requestId) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repository) &&
    typeof r.branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(r.branch) &&
    !r.branch.includes("..") && SHA.test(r.commitSha) &&
    typeof r.createdAt === "string" && Number.isFinite(Date.parse(r.createdAt)) &&
    Array.isArray(r.selected) && r.selected.length > 0 &&
    r.selected.every(x => ACTION_STEPS.includes(x)) &&
    new Set(r.selected).size === r.selected.length &&
    (r.runId === undefined || Number.isSafeInteger(r.runId) && r.runId > 0),
    "Receipt GitHub Actions non valido.");
  return r;
}
export async function findGithubActionRun(
  git: GitConfig, token: string, receipt: GithubActionReceipt,
): Promise<GitHubWorkflowRun | null> {
  checkActionReceipt(receipt);
  required(receipt.repository.toLowerCase() === (git.owner + "/" + git.repo).toLowerCase() &&
    receipt.branch === git.branch, "Repository o branch diversi dal dispatch originale.");
  const root = safeRoot(git);
  const data = await gh<{ workflow_runs: unknown[] }>(
    root + "/actions/workflows/" + WORKFLOW + "/runs?event=workflow_dispatch&branch=" +
    encodeURIComponent(receipt.branch) + "&per_page=50", token);
  required(Array.isArray(data.workflow_runs) && data.workflow_runs.length <= 50, "Elenco workflow run GitHub non valido.");
  const matches = data.workflow_runs.filter(value => {
    if (!value || typeof value !== "object") return false;
    const run = value as GitHubWorkflowRun;
    return run.display_title === "SoftwareFactory tests " + receipt.requestId &&
      run.head_branch === receipt.branch && run.event === "workflow_dispatch" &&
      typeof run.head_sha === "string" && SHA.test(run.head_sha) &&
      Number.isSafeInteger(run.id) && run.id > 0;
  }) as GitHubWorkflowRun[];
  if (receipt.runId !== undefined) return matches.find(x => x.id === receipt.runId) ?? null;
  if (!matches.length) return null;
  required(matches.length === 1, "Dispatch ambiguo: più run con lo stesso UUID.");
  const run = matches[0];
  required(run.head_sha === receipt.commitSha,
    "Il branch GitHub è cambiato tra il dispatch e l'avvio del test: risultato obsoleto.");
  required(typeof run.created_at === "string" && Date.parse(run.created_at) >=
    Date.parse(receipt.createdAt) - 120000,
    "Risultato GitHub non associato al dispatch corrente.");
  return run;
}
const bounds = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const exactly = (obj: Record<string, unknown>, keys: string[]) =>
  Object.keys(obj).sort().join(",") === [...keys].sort().join(",");
export function verifyGithubActionReport(
  raw: unknown, receipt: GithubActionReceipt, run: GitHubWorkflowRun,
): GithubActionReport {
  checkActionReceipt(receipt);
  required(raw && typeof raw === "object" && !Array.isArray(raw), "Report GitHub Actions JSON non valido.");
  const d = raw as Record<string, unknown>;
  required(exactly(d, ["schemaVersion","requestId","repository","ref","commitSha","runId",
    "runAttempt","startedAt","finishedAt","state","summary","steps"]) && d.schemaVersion === 1 &&
    d.requestId === receipt.requestId && d.repository === receipt.repository &&
    d.ref === receipt.branch && d.commitSha === receipt.commitSha &&
    run.head_sha === receipt.commitSha && run.head_branch === receipt.branch &&
    d.runId === run.id && d.runAttempt === run.run_attempt &&
    Number.isSafeInteger(d.runAttempt) && (d.runAttempt as number) >= 1 &&
    typeof d.startedAt === "string" && typeof d.finishedAt === "string" &&
    Number.isFinite(Date.parse(d.startedAt)) && Number.isFinite(Date.parse(d.finishedAt)) &&
    Date.parse(d.finishedAt) >= Date.parse(d.startedAt),
    "Report non riferito al run, branch, tentativo o SHA atteso.");
  required(Array.isArray(d.steps) && d.steps.length === receipt.selected.length &&
    d.steps.length <= 5, "Il report non copre tutti i test richiesti.");
  const steps = d.steps as Array<Record<string, unknown>>;
  required(steps.every(x => x && typeof x === "object" &&
    exactly(x, ["id","status","exitCode","durationMs","reason","output"]) &&
    receipt.selected.includes(x.id as ActionTestStep) &&
    ["passed","failed","incomplete"].includes(x.status as string) &&
    (x.exitCode === null || Number.isSafeInteger(x.exitCode) && bounds(x.exitCode, 0, 255)) &&
    bounds(x.durationMs, 0, 3_000_000) &&
    typeof x.reason === "string" && x.reason.length <= 120 &&
    typeof x.output === "string" && x.output.length <= 2000 &&
    (x.status !== "passed" || x.exitCode === 0)) &&
    new Set(steps.map(x => x.id)).size === steps.length,
    "Risultati per-step mancanti o non attendibili.");
  const counts = { requested: steps.length,
    passed: steps.filter(s => s.status === "passed").length,
    failed: steps.filter(s => s.status === "failed").length,
    incomplete: steps.filter(s => s.status === "incomplete").length };
  required(d.summary && typeof d.summary === "object" && !Array.isArray(d.summary) &&
    exactly(d.summary as Record<string, unknown>, Object.keys(counts)) &&
    Object.entries(counts).every(([k,v]) => (d.summary as Record<string, unknown>)[k] === v),
    "I conteggi dichiarati non corrispondono alle prove.");
  const expected = counts.failed ? "failed" : counts.incomplete ? "incomplete" : "passed";
  required(d.state === expected &&
    (expected === "passed" ? run.status === "completed" && run.conclusion === "success"
      : run.status === "completed" && run.conclusion !== "success"),
    "Conclusione del workflow non coerente con i risultati dichiarati.");
  return d as GithubActionReport;
}
export async function loadGithubActionReport(
  git: GitConfig, token: string, receipt: GithubActionReceipt, run: GitHubWorkflowRun,
): Promise<GithubActionReport> {
  checkActionReceipt(receipt);
  required(run.status === "completed", "Il workflow non è ancora terminato.");
  const root = safeRoot(git);
  const list = await gh<{ artifacts: Array<{id:number;name:string;expired:boolean;size_in_bytes:number}> }>(
    root + "/actions/runs/" + run.id + "/artifacts?per_page=100", token);
  required(Array.isArray(list.artifacts) && list.artifacts.length <= 100, "Elenco artifact GitHub non valido.");
  const artifacts = list.artifacts.filter(a => a.name === "softwarefactory-test-report" && !a.expired);
  required(artifacts.length === 1, "Artifact JSON del test non disponibile oppure ambiguo.");
  const a = artifacts[0];
  required(Number.isSafeInteger(a.id) && a.id > 0 &&
    bounds(a.size_in_bytes, 1, 1_000_000), "Artifact JSON troppo grande.");
  // GitHub returns a short-lived signed download redirect. Fetch standard
  // strips Authorization on cross-origin redirects; some browsers may block
  // this download with CORS, in which case the UI provides a GitHub download link.
  let response: Response;
  try {
    response = await fetch("https://api.github.com" + root + "/actions/artifacts/" + a.id + "/zip", {
      method: "GET", mode: "cors", redirect: "follow", cache: "no-store",
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token },
    });
  } catch { throw Error("Download artifact impedito dal browser/CORS. Scarica manualmente il JSON dalla pagina GitHub Actions."); }
  required(response.ok, "Download report JSON HTTP " + response.status + ".");
  const blob = await response.blob();
  required(blob.size > 0 && blob.size <= 1_000_000, "ZIP artifact non valido o troppo grande.");
  const zip = new Uint8Array(await blob.arrayBuffer());
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(zip, { filter: file => file.name === "report.json" && file.originalSize <= 100000 });
  } catch { throw Error("Archivio report non leggibile."); }
  required(Object.keys(extracted).length === 1 && extracted["report.json"]?.length <= 100000,
    "L'artifact non contiene un unico report.json di dimensioni sicure.");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(extracted["report.json"])); }
  catch { throw Error("Artifact report.json non valido."); }
  return verifyGithubActionReport(parsed, receipt, run);
}
export function githubActionRunUrl(receipt: GithubActionReceipt, run?: GitHubWorkflowRun | null): string {
  checkActionReceipt(receipt);
  const prefix = "https://github.com/" + receipt.repository + "/actions/";
  return run && Number.isSafeInteger(run.id) && run.id > 0 ?
    prefix + "runs/" + run.id : prefix + "workflows/" + WORKFLOW;
}
