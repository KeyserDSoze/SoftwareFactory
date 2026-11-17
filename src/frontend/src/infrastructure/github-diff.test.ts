import { describe, expect, it } from "vitest";
import { createProject } from "../domain/defaults";
import { compareGithubWorkspaces } from "./github-diff";
import type { GitConfig } from "../domain/types";
const git: GitConfig={owner:"example",repo:"software",branch:"main",privateRepo:true,
  authMode:"pat",appGateway:""};
const make = () => { const p=createProject();
  p.config.name="Test app";p.config.description="A generated app";return p; };
describe("read-only GitHub recovery comparison", () => {
  it("compares approved source content without mutating either project", () => {
    const a=make(), b=structuredClone(a);
    const sha="a".repeat(40);
    b.stages[0].output="different feature spec";
    const output=compareGithubWorkspaces(a,b,git,sha);
    expect(output.sameProject).toBe(true);
    expect(output.remoteAdvanced).toBe(true);
    expect(output.changed).toContain("docs/features.md");
    expect(output.onlyLocal).toEqual([]);
    expect(output.onlyRemote).toEqual([]);
    expect(a.stages[0].output).toBe("");
    expect(b.stages[0].output).toBe("different feature spec");
  });
  it("does not treat the same name as proof of project identity or SHA equality", () => {
    const a=make(), b=make();
    const sha="b".repeat(40);
    a.githubSync={owner:"example",repo:"software",branch:"main",lastCommit:sha,
      syncedLocalUpdatedAt:a.updatedAt,syncedAt:new Date().toISOString()};
    const output=compareGithubWorkspaces(a,b,git,sha);
    expect(output.sameProject).toBe(false);
    expect(output.localDirty).toBe(false);
    expect(output.remoteAdvanced).toBe(false);
    expect(output.projectId).toBe(b.id);
    expect(() => compareGithubWorkspaces(a,b,git,"wrong")).toThrow(/SHA/);
  });
  it("indicates local and remote pending patches without applying or approving them", () => {
    const a=make(), b=structuredClone(a);
    a.development={revision:1,overrides:{},originals:{},history:[],
      pending:{id:"id",request:"r",summary:"s",createdAt:a.createdAt,revision:1,
        edits:[],tests:[],assumptions:[]}};
    const diff=compareGithubWorkspaces(a,b,git,"c".repeat(40));
    expect(diff.pendingLocal).toBe(true);
    expect(diff.pendingRemote).toBe(false);
  });
});