/** One GitHub publication operation: read the remote HEAD, compare it against
 * the last acknowledged checkpoint, create a single fast-forward commit, then
 * record the SHA only after the GitHub ref PATCH succeeds. No force push.
 */
import type { FactoryProject, GitConfig } from "../domain/types";
import { workspaceFiles } from "../domain/development";
import { ensureRepository, pushGeneratedFiles } from "./github";
import { encodeGithubWorkspace, inspectGithubWorkspace,
  GITHUB_WORKSPACE_PATH, githubBindingMatches } from "./github-workspace";
export type PublishedGithubWorkspace = {
  project: FactoryProject; url: string; sha: string; branch: string;
};
export async function publishGithubWorkspace(
  project: FactoryProject, git: GitConfig, token: string,
): Promise<PublishedGithubWorkspace> {
  const prepared = { ...workspaceFiles(project),
    [GITHUB_WORKSPACE_PATH]: encodeGithubWorkspace(project) };
  await ensureRepository(git, token);
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
        syncedAt: new Date().toISOString() } },
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
