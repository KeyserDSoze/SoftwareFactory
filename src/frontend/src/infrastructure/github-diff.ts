/** Read-only GitHub recovery preview. Never apply, merge or fetch secrets.
 * Diff compares the actual generated/approved source tree of each workspace,
 * not just the project names or a remote SHA.
 */
import type { FactoryProject, GitConfig } from "../domain/types";
import { workspaceFiles } from "../domain/development";
import { githubBindingMatches, githubProjectDirty } from "./github-workspace";

export type GithubWorkspaceComparison = {
  repository: string; branch: string; headSha: string;
  projectId: string; projectName: string;
  sameProject: boolean; lastKnownSha: string | null;
  localDirty: boolean; remoteAdvanced: boolean;
  onlyLocal: string[]; onlyRemote: string[]; changed: string[];
  localStages: string[]; remoteStages: string[];
  pendingLocal: boolean; pendingRemote: boolean;
  truncated: boolean;
};
export function compareGithubWorkspaces(
  local: FactoryProject, remote: FactoryProject, git: GitConfig, headSha: string,
): GithubWorkspaceComparison {
  if (!/^[a-f0-9]{40}$/i.test(headSha))
    throw Error("SHA del checkpoint remoto non valido.");
  const localFiles = workspaceFiles(local);
  const remoteFiles = workspaceFiles(remote);
  const a = Object.keys(localFiles);
  const b = Object.keys(remoteFiles);
  if (a.length > 1000 || b.length > 1000)
    throw Error("Troppi file per un confronto GitHub affidabile.");
  const localPaths = new Set(a), remotePaths = new Set(b);
  const onlyLocal = a.filter(path => !remotePaths.has(path)).sort();
  const onlyRemote = b.filter(path => !localPaths.has(path)).sort();
  const changed = a.filter(path => remotePaths.has(path) &&
    localFiles[path] !== remoteFiles[path]).sort();
  // Output the full names of the bounded generated source paths, never file
  // content. A capped display avoids overwhelming a narrow browser screen.
  const CAP = 80;
  const lastKnownSha = githubBindingMatches(local, git) ?
    local.githubSync!.lastCommit : null;
  return {
    repository: git.owner + "/" + git.repo, branch: git.branch, headSha,
    projectId: remote.id, projectName: remote.config.name,
    sameProject: remote.id === local.id, lastKnownSha,
    localDirty: githubProjectDirty(local, git),
    remoteAdvanced: lastKnownSha !== headSha,
    onlyLocal: onlyLocal.slice(0, CAP), onlyRemote: onlyRemote.slice(0, CAP),
    changed: changed.slice(0, CAP),
    localStages: local.stages.filter(s => s.status === "complete").map(s => s.id),
    remoteStages: remote.stages.filter(s => s.status === "complete").map(s => s.id),
    pendingLocal: Boolean(local.development?.pending),
    pendingRemote: Boolean(remote.development?.pending),
    truncated: [onlyLocal,onlyRemote,changed].some(v => v.length > CAP),
  };
}
