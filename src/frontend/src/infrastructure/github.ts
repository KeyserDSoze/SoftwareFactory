import type { GitConfig } from "../domain/types";

export interface PushResult { sha: string; url: string; branch: string }
class GitHubError extends Error { constructor(message: string) { super(message); this.name = "GitHubError"; } }
export function validateGitConfig(config: GitConfig): void {
  if (!/^[a-zA-Z0-9-]{1,39}$/.test(config.owner) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(config.repo))
    throw new GitHubError("Owner o repository GitHub non validi.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(config.branch) || config.branch.includes("..") || config.branch.includes("//") || config.branch.endsWith("/") || config.branch.endsWith(".lock"))
    throw new GitHubError("Nome branch non valido.");
}
async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch("https://api.github.com" + path, {
    ...init, redirect: "error",
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: "Bearer " + token, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  if (!r.ok) {
    if (r.status === 404) throw new GitHubError("GitHub: risorsa inesistente o token senza permessi (404).");
    if (r.status === 409 || r.status === 422) throw new GitHubError("GitHub: conflitto / branch cambiato (HTTP " + r.status + "). Nessun force push.");
    throw new GitHubError("GitHub: HTTP " + r.status + ". Controlla permessi e repository.");
  }
  return r.status === 204 ? ({} as T) : r.json() as Promise<T>;
}
export async function resolveGithubToken(git: GitConfig, pat: string): Promise<string> {
  if (git.authMode === "pat") {
    if (!pat.trim()) throw new GitHubError("Inserisci un PAT fine-grained con Contents read/write.");
    return pat.trim();
  }
  if (!git.appGateway) throw new GitHubError("Configura il gateway di autenticazione GitHub App.");
  const url = new URL(git.appGateway);
  if (url.protocol !== "https:") throw new GitHubError("Il gateway GitHub App deve usare HTTPS.");
  // A trusted server exchanges the app installation credentials for a short-lived token.
  // Never put private keys or GitHub App client secrets in the SPA.
  const r = await fetch(url.href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner: git.owner, repo: git.repo }) });
  if (!r.ok) throw new GitHubError("Gateway GitHub App: HTTP " + r.status);
  const data: unknown = await r.json();
  if (!data || typeof data !== "object" || !("token" in data) || typeof data.token !== "string")
    throw new GitHubError("Il gateway non ha restituito un installation token valido.");
  return data.token;
}
export async function ensureRepository(git: GitConfig, token: string): Promise<void> {
  validateGitConfig(git);
  try {
    await request("/repos/" + git.owner + "/" + git.repo, token);
  } catch (err) {
    if (!(err instanceof GitHubError) || !err.message.includes("(404)")) throw err;
    // Creating on the authenticated user account requires Administration/creation permissions.
    const actor = await request<{ login: string }>("/user", token);
    if (actor.login.toLowerCase() !== git.owner.toLowerCase())
      throw new GitHubError("Crea prima la repository nell'organizzazione indicata o usa il tuo account GitHub.");
    await request("/user/repos", token, {
      method: "POST", body: JSON.stringify({ name: git.repo, private: git.privateRepo, auto_init: true, description: "Generated with SoftwareFactory" }),
    });
  }
}
export async function pushGeneratedFiles(git: GitConfig, token: string, files: Record<string, string>, expectedHead?: string): Promise<PushResult> {
  validateGitConfig(git);
  if (!Object.keys(files).length) throw new GitHubError("Nessun file da pubblicare.");
  const root = "/repos/" + git.owner + "/" + git.repo;
  const refPath = root + "/git/ref/heads/" + git.branch.split("/").map(encodeURIComponent).join("/");
  let ref: { object: { sha: string } };
  try { ref = await request(refPath, token); }
  catch (e) {
    if (git.branch === "main") throw e;
    const base = await request<{ object: { sha: string } }>(root + "/git/ref/heads/main", token);
    await request(root + "/git/refs", token, { method: "POST", body: JSON.stringify({ ref: "refs/heads/" + git.branch, sha: base.object.sha }) });
    ref = await request(refPath, token);
  }
  const parentSha = ref.object.sha;
  if (expectedHead !== undefined && (!/^[a-f0-9]{40}$/i.test(expectedHead) || parentSha !== expectedHead))
    throw new GitHubError("Il branch remoto è cambiato dopo la verifica: aggiorna o importa prima di pubblicare. Nessun commit inviato.");
  const parent = await request<{ tree: { sha: string } }>(root + "/git/commits/" + parentSha, token);
  const tree = await request<{ sha: string }>(root + "/git/trees", token, {
    method: "POST", body: JSON.stringify({ base_tree: parent.tree.sha, tree: Object.entries(files).map(([path, content]) => ({
      path, mode: "100644", type: "blob", content,
    })) }),
  });
  const commit = await request<{ sha: string }>(root + "/git/commits", token, {
    method: "POST", body: JSON.stringify({ message: "feat: generate application scaffold with SoftwareFactory", tree: tree.sha, parents: [parentSha] }),
  });
  // GitHub rejects non-fast-forward ref updates: no implicit merge, no force push.
  await request(root + "/git/refs/heads/" + git.branch.split("/").map(encodeURIComponent).join("/"), token, {
    method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return { sha: commit.sha, url: "https://github.com/" + git.owner + "/" + git.repo + "/commit/" + commit.sha, branch: git.branch };
}
