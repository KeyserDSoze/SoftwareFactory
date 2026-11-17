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
  if (!(path.startsWith("/repos/") || path === "/user" || path === "/user/repos"))
    throw new GitHubError("Destinazione GitHub API non permessa.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch("https://api.github.com" + path, {
      ...init, method: init.method || "GET", mode: "cors", cache: "no-store",
      credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", Authorization: "Bearer " + token,
        ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
    if (!r.ok) {
      if (r.status === 404) throw new GitHubError("GitHub: risorsa inesistente o token senza permessi (404).");
      if (r.status === 409 || r.status === 422) throw new GitHubError(
        "GitHub: conflitto / branch cambiato (HTTP " + r.status + "). Nessun force push.");
      throw new GitHubError("GitHub: HTTP " + r.status + ". Controlla permessi e repository.");
    }
    if (r.status === 204) return {} as T;
    // Prevent unbounded JSON responses (and accidental logging of GitHub's raw
    // response). Git Data writes only need tiny acknowledgement structures.
    const size = Number(r.headers?.get("content-length") || "0");
    if (!Number.isFinite(size) || size > 2_000_000)
      throw new GitHubError("Risposta GitHub troppo grande.");
    const payload = await r.text();
    if (payload.length > 2_000_000) throw new GitHubError("Risposta GitHub troppo grande.");
    try { return JSON.parse(payload) as T; }
    catch { throw new GitHubError("Risposta JSON GitHub non valida."); }
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError("GitHub non raggiungibile, timeout o CORS. Nessun retry automatico del commit: verifica la HEAD prima.");
  } finally { clearTimeout(timeout); }
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
  const shaPattern = /^[a-f0-9]{40}$/i;
  if (!shaPattern.test(commit.sha)) throw new GitHubError("GitHub non ha restituito lo SHA di commit valido.");
  const advanced = await request<{ object: { sha: string } }>(
    root + "/git/refs/heads/" + git.branch.split("/").map(encodeURIComponent).join("/"), token, {
      method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }),
    });
  if (advanced?.object?.sha !== commit.sha)
    throw new GitHubError("Il ref update non ha confermato il commit atteso: controlla la HEAD prima di continuare.");
  // Explicit readback is required before calling this a remote write success.
  const verified = await request<{ object: { sha: string } }>(refPath, token);
  if (verified?.object?.sha !== commit.sha)
    throw new GitHubError("GitHub HEAD diversa dal commit appena creato: la sincronizzazione locale resta non confermata.");
  return { sha: commit.sha, url: "https://github.com/" + git.owner + "/" + git.repo + "/commit/" + commit.sha, branch: git.branch };
}


/** Verify a remote commit's complete generated source snapshot without writing.
 *
 * For an ambiguous/lost GitHub PUSH acknowledgement we accept only a single
 * current HEAD whose Git tree contains exact blob IDs for EVERY generated
 * source plus the portable checkpoint. A matching JSON checkpoint alone is
 * insufficient: someone may have updated the checkpoint but not the sources.
 * This does not prove the author of a commit or the absence of other files.
 */
export async function gitBlobObjectSha(content: string): Promise<string> {
  if (typeof content !== "string" || typeof globalThis.crypto?.subtle?.digest !== "function")
    throw new GitHubError("Hash Git non disponibile nel browser: nessun riconoscimento automatico.");
  const bytes = new TextEncoder().encode(content);
  const prefix = new TextEncoder().encode("blob " + bytes.byteLength + "\0");
  const full = new Uint8Array(prefix.length + bytes.length);
  full.set(prefix);
  full.set(bytes, prefix.length);
  const digest = await globalThis.crypto.subtle.digest("SHA-1", full);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function verifyGithubCommitFiles(
  git: GitConfig, token: string, headSha: string, files: Record<string, string>,
  previousHeadSha?: string,
): Promise<{ verifiedFiles: number; parentSha: string }> {
  validateGitConfig(git);
  const SHA = /^[a-f0-9]{40}$/i;
  if (!SHA.test(headSha) || (previousHeadSha && !SHA.test(previousHeadSha)))
    throw new GitHubError("SHA GitHub non valido per la verifica.");
  const entries = Object.entries(files);
  if (!entries.length || entries.length > 1000 || entries.some(([path, data]) =>
    typeof data !== "string" || !path || path.includes("\\") || path.includes("..") ||
    path.startsWith("/") || path.split("/").some(part => !part || part === ".")))
    throw new GitHubError("Sorgenti GitHub non validi per la verifica.");
  const root = "/repos/" + git.owner + "/" + git.repo;
  const commit = await request<{ sha?: string; parents?: Array<{sha?: string}>; tree?: {sha?: string} }>(
    root + "/git/commits/" + headSha, token);
  if (commit.sha?.toLowerCase() !== headSha.toLowerCase() ||
      !Array.isArray(commit.parents) || commit.parents.length !== 1 ||
      !SHA.test(commit.parents[0]?.sha || "") ||
      (previousHeadSha && commit.parents[0].sha?.toLowerCase() !== previousHeadSha.toLowerCase()) ||
      !SHA.test(commit.tree?.sha || ""))
    throw new GitHubError("Commit GitHub non figlio della HEAD attesa o metadata non verificabili. Nessun ack.");
  const tree = await request<{ truncated?: boolean;
    tree?: Array<{path?: string; sha?: string; type?: string; mode?: string}> }>(
    root + "/git/trees/" + commit.tree!.sha + "?recursive=1", token);
  if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 5000)
    throw new GitHubError("Albero GitHub incompleto o troppo grande: impossibile verificare i file.");
  const expected = new Map<string,string>();
  // Do not trust SHA-1 digests received in the JSON: compute Git blob IDs
  // from the exact UTF-8 bytes that SoftwareFactory would publish right now.
  for (const [path, data] of entries) {
    if (expected.has(path)) throw new GitHubError("Percorso file GitHub duplicato.");
    expected.set(path, await gitBlobObjectSha(data));
  }
  const found = new Set<string>();
  for (const entry of tree.tree) {
    if (!entry.path || !expected.has(entry.path)) continue;
    if (found.has(entry.path) || entry.type !== "blob" || entry.mode !== "100644" ||
        entry.sha?.toLowerCase() !== expected.get(entry.path))
      throw new GitHubError("Contenuto dei file GitHub diverso dal workspace locale: ack vietato.");
    found.add(entry.path);
  }
  if (found.size !== expected.size)
    throw new GitHubError("Sorgenti mancanti nel commit remoto: ack vietato.");
  const ref = await request<{object?: {sha?: string}}>(root + "/git/ref/heads/" +
    git.branch.split("/").map(encodeURIComponent).join("/"), token);
  if (ref.object?.sha?.toLowerCase() !== headSha.toLowerCase())
    throw new GitHubError("HEAD GitHub cambiata durante il controllo: nessun ack.");
  return { verifiedFiles: found.size, parentSha: commit.parents[0].sha! };
}
