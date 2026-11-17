/** CI-only fixture: produce exact Git blob object IDs from the current Factory
 * generator and local Chromium project. No remote writes, fake file contents,
 * PAT/keys or application test evidence. Executed only within isolated CI.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { workspaceFiles } from "../../frontend/src/domain/development";
import { encodeGithubWorkspace, GITHUB_WORKSPACE_PATH } from "../../frontend/src/infrastructure/github-workspace";
import type { FactoryProject } from "../../frontend/src/domain/types";

const project = JSON.parse(readFileSync(0, "utf8")) as FactoryProject;
const files = { ...workspaceFiles(project),
  [GITHUB_WORKSPACE_PATH]: encodeGithubWorkspace(project) };
const tree = Object.entries(files).map(([filePath,content]) => {
  const bytes=Buffer.from(content, "utf8");
  const blobId=createHash("sha1").update("blob "+bytes.byteLength+"\\0").update(bytes).digest("hex");
  return {path:filePath,sha:blobId,type:"blob",mode:"100644"};
});
process.stdout.write(JSON.stringify({checkpoint:files[GITHUB_WORKSPACE_PATH],tree}));
