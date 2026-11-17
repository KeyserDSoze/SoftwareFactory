/** Opt-in repository picker. Display metadata only; never infer a repo
 * from PAT or make any write while enumerating accessible destinations.
 */
import { validateGitConfig } from "./github";
import type { GitConfig } from "../domain/types";
export type GithubRepositoryChoice = {
  owner: string; repo: string; branch: string; privateRepo: boolean;
  canPush: boolean; archived: boolean; disabled: boolean;
  fullName: string;
};
function validGitCandidate(value: unknown): GithubRepositoryChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Metadati repository GitHub non validi.");
  const x = value as Record<string, unknown>;
  const owner = x.owner && typeof x.owner === "object" ? (x.owner as Record<string, unknown>).login : "";
  const repo = x.name, branch = x.default_branch;
  if (typeof owner !== "string" || typeof repo !== "string" ||
      typeof branch !== "string" || typeof x.private !== "boolean")
    throw Error("Metadati repository GitHub incompleti.");
  const git: GitConfig = { owner, repo, branch, authMode: "pat", appGateway: "", privateRepo: x.private };
  validateGitConfig(git);
  const permissions = x.permissions;
  if (permissions !== undefined && (typeof permissions !== "object" || permissions === null))
    throw Error("Permessi repository non validi.");
  const p = permissions as Record<string, unknown> | undefined;
  const archived = x.archived === true, disabled = x.disabled === true;
  return { owner, repo, branch, privateRepo: x.private, canPush: p?.push === true && !archived && !disabled,
    archived, disabled, fullName: owner + "/" + repo };
}
export async function findGithubRepositories(pat: string, signal?: AbortSignal): Promise<GithubRepositoryChoice[]> {
  if (typeof pat !== "string" || pat.trim().length < 20) throw Error("Configura un PAT GitHub prima di cercare.");
  const result: GithubRepositoryChoice[] = [];
  const seen = new Set<string>();
  // GitHub lists up to 100 per page. No silently partial list: exceed cap -> explicit error.
  for (let page = 1; page <= 6; page++) {
    if (page === 6) throw Error("Più di 500 repository: seleziona manualmente owner e branch.");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("https://api.github.com/user/repos?per_page=100&page=" + page +
        "&sort=full_name&direction=asc&affiliation=owner,collaborator,organization_member", {
        method: "GET", mode: "cors", cache: "no-store", redirect: "error",
        credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal,
        headers: { Accept: "application/vnd.github+json",
          Authorization: "Bearer " + pat.trim(), "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!response.ok) throw Error("Ricerca repository GitHub HTTP " + response.status + ".");
      const bytes = await response.text();
      if (bytes.length > 1_500_000) throw Error("Elenco repository GitHub troppo grande.");
      let parsed: unknown;
      try { parsed = JSON.parse(bytes); } catch { throw Error("Elenco repository non è JSON valido."); }
      if (!Array.isArray(parsed) || parsed.length > 100)
        throw Error("Elenco repository GitHub non valido.");
      for (const raw of parsed) {
        const repo = validGitCandidate(raw);
        const identity = repo.fullName.toLowerCase();
        if (seen.has(identity)) throw Error("Repository duplicata nella risposta GitHub.");
        seen.add(identity); result.push(repo);
      }
      if (parsed.length < 100) return result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return result;
}
/** Safe metadata read for a selected repository (not a PAT scope certificate). */
export async function inspectGithubRepository(
  git: GitConfig, pat: string, signal?: AbortSignal,
): Promise<GithubRepositoryChoice> {
  validateGitConfig(git);
  if (!pat || pat.trim().length < 20) throw Error("Configura prima un PAT GitHub.");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("https://api.github.com/repos/" +
      encodeURIComponent(git.owner) + "/" + encodeURIComponent(git.repo), {
      method: "GET", mode: "cors", cache: "no-store", redirect: "error", credentials: "omit",
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        Authorization: "Bearer " + pat.trim() },
    });
    if (!response.ok) throw Error("Verifica repository HTTP " + response.status + ".");
    const raw: unknown = await response.json();
    const result = validGitCandidate(raw);
    if (result.owner.toLowerCase() !== git.owner.toLowerCase() ||
        result.repo.toLowerCase() !== git.repo.toLowerCase())
      throw Error("Repository verificata non corrisponde alla destinazione.");
    return result;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); }
}
