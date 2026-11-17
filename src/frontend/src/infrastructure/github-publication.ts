/** One GitHub publication operation: read the remote HEAD, compare it against
 * the last acknowledged checkpoint, create a single fast-forward commit, then
 * record the SHA only after the GitHub ref PATCH succeeds. No force push.
 */
import type { FactoryProject, GitConfig } from "../domain/types";
import { workspaceFiles } from "../domain/development";
import { ensureRepository, pushGeneratedFiles, verifyGithubCommitFiles } from "./github";
import { inspectGithubRepository } from "./github-discovery";
import { encodeGithubWorkspace, inspectGithubWorkspace,
  GITHUB_WORKSPACE_PATH, githubBindingMatches, portableGithubProject } from "./github-workspace";
export type PublishedGithubWorkspace = {
  project: FactoryProject; url: string; sha: string; branch: string;
};
export async function publishGithubWorkspace(
  project: FactoryProject, git: GitConfig, token: string, explicitPublicConsent = false,
): Promise<PublishedGithubWorkspace> {
  const prepared = { ...workspaceFiles(project),
    [GITHUB_WORKSPACE_PATH]: encodeGithubWorkspace(project) };
  // Consent is bound to the exact owner/repo/branch previously acknowledged.
  // Never inherit public consent when switching destination with the same PAT.
  const priorConsent = githubBindingMatches(project, git) &&
    project.githubSync?.publicConsent === true;
  if (!git.privateRepo && !explicitPublicConsent && !priorConsent)
    throw Error("Repository impostata come PUBBLICA: serve consenso esplicito prima della creazione o della pubblicazione.");
  await ensureRepository(git, token);
  const target = await inspectGithubRepository(git, token);
  if (!target.privateRepo && !explicitPublicConsent && !priorConsent)
    throw Error("GitHub conferma che la repository è PUBBLICA: autorizza esplicitamente il contenuto prima di pubblicare.");
  const remote = await inspectGithubWorkspace(git, token);
  if (githubBindingMatches(project, git)) {
    if (project.githubSync?.lastCommit !== remote.headSha)
      throw Error("Conflitto GitHub: un altro dispositivo ha avanzato il branch. Verifica e importa, non sovrascrivere.");
  } else if (remote.project) {
    throw Error("La repository contiene già un checkpoint SoftwareFactory. Importalo prima di pubblicare: un nuovo progetto non può sovrascriverlo.");
  }
  const pushed = await pushGeneratedFiles(git, token, prepared, remote.headSha);
  return {
    project: { ...project,
      githubSync: { owner: git.owner, repo: git.repo, branch: git.branch,
        lastCommit: pushed.sha, syncedLocalUpdatedAt: project.updatedAt,
        syncedAt: new Date().toISOString(), publicConsent: !target.privateRepo &&
          (explicitPublicConsent || priorConsent) } },
    url: pushed.url, sha: pushed.sha, branch: pushed.branch,
  };
}
export async function importGithubWorkspace(
  current: FactoryProject, git: GitConfig, token: string,
): Promise<{ project: FactoryProject; sha: string }> {
  const remote = await inspectGithubWorkspace(git, token);
  if (!remote.project) throw Error("La repository non contiene ancora un checkpoint SoftwareFactory importabile.");
  const original = remote.project;
  // A remote checkpoint contains the project, NOT this browser's session
  // secrets, auth profiles or local autosync preferences.
  return { project: { ...original,
    githubSync: { owner: git.owner, repo: git.repo, branch: git.branch,
      lastCommit: remote.headSha, syncedLocalUpdatedAt: original.updatedAt,
      syncedAt: new Date().toISOString() } }, sha: remote.headSha };
}


/** Read-only reconciliation of a commit that may have succeeded after a lost
 * HTTP response or after the remote write but before local acknowledgement.
 * Never push again, import another project, or call this from autosync.
 *
 * This proves the CURRENT remote HEAD has the exact portable project content
 * and every exact source blob that the current local snapshot would produce.
 * A previously acknowledged binding additionally requires one direct parent
 * equal to its last known commit, rejecting other devices' advanced branches.
 */
export async function recoverGithubAcknowledgement(
  project: FactoryProject, git: GitConfig, token: string,
): Promise<PublishedGithubWorkspace & { verifiedFiles: number; parentSha: string; firstBinding: boolean }> {
  // Validate and re-render locally before trusting any remote data.
  const files = { ...workspaceFiles(project),
    [GITHUB_WORKSPACE_PATH]: encodeGithubWorkspace(project) };
  const previouslyBound = githubBindingMatches(project, git);
  const previousSha = previouslyBound ? project.githubSync!.lastCommit : undefined;
  const remote = await inspectGithubWorkspace(git, token);
  if (!remote.project)
    throw Error("Nessun checkpoint GitHub da riconciliare. Nessuna modifica remota eseguita.");
  if (previousSha === remote.headSha)
    throw Error("HEAD GitHub già nota: non esiste un nuovo commit da riconciliare.");
  if (project.id !== remote.project.id ||
      JSON.stringify(portableGithubProject(project)) !==
        JSON.stringify(portableGithubProject(remote.project)))
    throw Error("Checkpoint remoto diverso dal progetto locale: importazione manuale necessaria. Nessun ack.");
  const evidence = await verifyGithubCommitFiles(
    git, token, remote.headSha, files, previousSha,
  );
  const priorConsent = previouslyBound && project.githubSync?.publicConsent === true;
  return {
    project: { ...project, githubSync: {
      owner: git.owner, repo: git.repo, branch: git.branch,
      lastCommit: remote.headSha, syncedLocalUpdatedAt: project.updatedAt,
      syncedAt: new Date().toISOString(),
      publicConsent: priorConsent,
    } },
    sha: remote.headSha,
    branch: git.branch,
    url: "https://github.com/" + git.owner + "/" + git.repo + "/commit/" + remote.headSha,
    verifiedFiles: evidence.verifiedFiles, parentSha: evidence.parentSha,
    firstBinding: !previouslyBound,
  };
}
