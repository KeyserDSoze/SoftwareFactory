/** Durable SoftwareFactory checkpoint stored ONLY in an explicitly published
 * application repository. No settings, PATs, API keys, cloud keys or runner keys.
 * GitHub branch and commit SHA are treated as the concurrency authority.
 */
import type { FactoryProject, GitConfig } from "../domain/types";
import { validateGitConfig } from "./github";
import { workspaceFiles, allowedCodePath } from "../domain/development";
const PATH = ".softwarefactory/workspace-state.v1.json";
const SHA = /^[a-f0-9]{40}$/i;
const SECRET = /github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-proj-|sk-[A-Za-z0-9]{24,})/;
const keys = (v: object) => Object.keys(v).sort().join("|");
const STAGES = ["features","competitors","technical","architecture","adversarial","implementation"];
/** Never transfer device-bound runner attestations or a previously accepted
 * adversarial verdict. The new device must re-review pending patches and run
 * its own tests; pending repairs cannot inherit old operator session grants.
 */
export function portableGithubProject(project: FactoryProject): FactoryProject {
  const dev = project.development;
  return {
    id: project.id, config: project.config, stages: project.stages,
    createdAt: project.createdAt, updatedAt: project.updatedAt,
    ...(dev ? { development: {
      revision: dev.revision, overrides: dev.overrides, originals: dev.originals,
      history: dev.history,
      ...(dev.pending ? { pending: {
        ...dev.pending,
        review: undefined, repairSession: undefined, repairTrail: undefined,
      } } : {}),
      // NOT lastRunnerJobId / lastRunnerEvidence: those are local attestation
      // bindings, NOT portable proofs for a different device.
    } } : {}),
  };
}
export function encodeGithubWorkspace(project: FactoryProject): string {
  // Validate exact allowed editable code paths before sending the checkpoint.
  workspaceFiles(project);
  const safe = portableGithubProject(project);
  const content = JSON.stringify({ schemaVersion: 1, kind: "softwarefactory-workspace",
    project: safe }) + "\n";
  if (content.length > 440000) throw Error("Checkpoint troppo grande per la sincronizzazione GitHub.");
  if (SECRET.test(content)) throw Error("Possibile segreto nel checkpoint GitHub: pubblicazione annullata.");
  return content;
}
export function decodeGithubWorkspace(text: string): FactoryProject {
  if (typeof text !== "string" || text.length > 440000) throw Error("Checkpoint GitHub non valido o troppo grande.");
  if (SECRET.test(text)) throw Error("Checkpoint remoto contenente un possibile segreto: importazione annullata.");
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { throw Error("Checkpoint GitHub JSON non valido."); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw Error("Checkpoint GitHub non valido.");
  const raw = decoded as Record<string, unknown>;
  if (keys(raw) !== "kind|project|schemaVersion" || raw.schemaVersion !== 1 ||
      raw.kind !== "softwarefactory-workspace" || !raw.project ||
      typeof raw.project !== "object" || Array.isArray(raw.project))
    throw Error("Formato checkpoint GitHub sconosciuto.");
  const project = raw.project as FactoryProject;
  const allowed = ["id","config","stages","createdAt","updatedAt","development"];
  if (Object.keys(project).some(k => !allowed.includes(k)) ||
      typeof project.id !== "string" || !/^[0-9a-f-]{36}$/i.test(project.id) ||
      typeof project.createdAt !== "string" || !Number.isFinite(Date.parse(project.createdAt)) ||
      typeof project.updatedAt !== "string" || !Number.isFinite(Date.parse(project.updatedAt)) ||
      !project.config || typeof project.config !== "object" || Array.isArray(project.config) ||
      typeof project.config.name !== "string" || typeof project.config.description !== "string" ||
      !Array.isArray(project.config.frontends) || !project.config.frontends.length ||
      !Array.isArray(project.stages) || project.stages.length !== STAGES.length)
    throw Error("Checkpoint GitHub incompleto.");
  if (project.stages.some((stage,i) => !stage || stage.id !== STAGES[i] ||
      !["pending","running","complete","failed"].includes(stage.status) ||
      typeof stage.output !== "string" || stage.output.length > 25000 ||
      !Array.isArray(stage.sources) || stage.sources.length > 100))
    throw Error("Checkpoint GitHub con pipeline non valida.");
  const dev = project.development;
  if (dev) {
    if (!Number.isSafeInteger(dev.revision) || dev.revision < 0 ||
        !dev.overrides || typeof dev.overrides !== "object" ||
        !dev.originals || typeof dev.originals !== "object" ||
        !Array.isArray(dev.history) || dev.history.length > 50 ||
        Object.entries(dev.overrides).some(([path,code]) => !allowedCodePath(path) ||
          typeof code !== "string" || code.length > 32000) ||
        Object.keys(dev.originals).some(path => !allowedCodePath(path)) ||
        dev.pending?.edits?.some(edit => !allowedCodePath(edit.path) ||
          typeof edit.content !== "string" || edit.content.length > 32000))
      throw Error("Checkpoint GitHub con workspace di sviluppo non valido.");
  }
  // A snapshot of an interrupted AI task must never resume that task implicitly.
  project.stages = project.stages.map(s => s.status === "running" ?
    { ...s, status: "pending" as const } : s);
  // Will reject incompatible baseline and modified file conflicts, without executing code.
  try { workspaceFiles(project); } catch { throw Error("Checkpoint GitHub non compatibile con il generatore corrente."); }
  return portableGithubProject(project);
}
export const GITHUB_WORKSPACE_PATH = PATH;
export type RemoteGithubWorkspace = { headSha: string; project: FactoryProject | null };
export async function inspectGithubWorkspace(git: GitConfig, token: string,
  signal?: AbortSignal): Promise<RemoteGithubWorkspace> {
  validateGitConfig(git);
  if (typeof token !== "string" || token.length < 20)
    throw Error("Configura PAT GitHub per leggere un checkpoint.");
  const root = "https://api.github.com/repos/" + encodeURIComponent(git.owner) +
    "/" + encodeURIComponent(git.repo);
  const request = async (path: string, allowMissing = false) => {
    const response = await fetch(root + path, {
      method: "GET", mode: "cors", redirect: "error", credentials: "omit", cache: "no-store",
      referrerPolicy: "no-referrer", signal, headers: { Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw Error("Lettura checkpoint GitHub HTTP " + response.status + ".");
    const text = await response.text();
    if (text.length > 750000) throw Error("Risposta GitHub troppo grande.");
    try { return JSON.parse(text) as unknown; } catch { throw Error("JSON GitHub non valido."); }
  };
  const ref: unknown = await request("/git/ref/heads/" +
    git.branch.split("/").map(encodeURIComponent).join("/"));
  const sha = (ref as { object?: { sha?: unknown } })?.object?.sha;
  if (typeof sha !== "string" || !SHA.test(sha)) throw Error("HEAD GitHub non valida.");
  const metadata: unknown = await request("/contents/" + PATH + "?ref=" + sha, true);
  if (!metadata) return { headSha: sha, project: null };
  const file = metadata as { type?: unknown; encoding?: unknown; size?: unknown; content?: unknown };
  if (file.type !== "file" || file.encoding !== "base64" ||
      typeof file.size !== "number" || file.size > 440000 || file.size < 1 ||
      typeof file.content !== "string" || file.content.length > 700000)
    throw Error("File di checkpoint remoto non valido.");
  let plain: string;
  try {
    const binary = atob(file.content.replace(/\s+/g, ""));
    plain = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, x => x.charCodeAt(0)));
  } catch { throw Error("Codifica checkpoint GitHub non valida."); }
  return { headSha: sha, project: decodeGithubWorkspace(plain) };
}
export function githubBindingMatches(project: FactoryProject, git: GitConfig): boolean {
  const sync = project.githubSync;
  return Boolean(sync && sync.owner.toLowerCase() === git.owner.toLowerCase() &&
    sync.repo.toLowerCase() === git.repo.toLowerCase() && sync.branch === git.branch &&
    SHA.test(sync.lastCommit));
}
export function githubProjectDirty(project: FactoryProject, git: GitConfig): boolean {
  return !githubBindingMatches(project, git) ||
    project.githubSync?.syncedLocalUpdatedAt !== project.updatedAt;
}
