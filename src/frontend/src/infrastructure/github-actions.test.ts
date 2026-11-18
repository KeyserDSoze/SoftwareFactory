import { describe, expect, it, afterEach, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { launchGithubTests, checkActionReceipt, findGithubActionRun,
  verifyGithubActionReport, loadGithubActionReport, githubActionRunUrl } from "./github-actions";
import type { GithubActionReceipt, GitHubWorkflowRun } from "./github-actions";
import type { GitConfig } from "../domain/types";

const git: GitConfig = { owner: "octocat", repo: "myapp", branch: "main",
  authMode: "pat", appGateway: "", privateRepo: true };
const token = "github_pat_" + "a".repeat(50);
const sha = "a".repeat(40);
const uuid = "123e4567-e89b-42d3-a456-426614174000";
const receipt: GithubActionReceipt = {
  requestId: uuid, repository: "octocat/myapp", branch: "main",
  commitSha: sha, createdAt: new Date().toISOString(), selected: ["dotnet-build", "web-build"],
};
const run: GitHubWorkflowRun = {
  id: 456, name: "SoftwareFactory selectable tests",
  event: "workflow_dispatch", display_title: "SoftwareFactory tests " + uuid,
  head_branch: "main", head_sha: sha, status: "completed", conclusion: "success",
  html_url: "https://github.com/octocat/myapp/actions/runs/456", run_attempt: 1,
  created_at: new Date().toISOString(),
};
const step = (id: string) => ({ id, status: "passed", exitCode: 0,
  durationMs: 200, reason: "", output: "built successfully" });
const report = () => ({
  schemaVersion: 1, requestId: uuid, repository: "octocat/myapp", ref: "main",
  commitSha: sha, runId: 456, runAttempt: 1, startedAt: "2026-11-17T08:00:00.000Z",
  finishedAt: "2026-11-17T08:00:10.000Z", state: "passed",
  summary: { requested: 2, passed: 2, failed: 0, incomplete: 0 },
  steps: [step("dotnet-build"), step("web-build")],
});
describe("PAT-only GitHub Actions test backend", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("dispatches exactly the allowlisted test inputs, bound to branch HEAD and UUID", async () => {
    const requests: Array<[string, RequestInit]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push([url, init]);
      return url.includes("/git/ref/heads/main") ?
        { ok: true, status: 200, json: async () => ({ object: { sha } }) } :
        { ok: true, status: 204 };
    }));
    vi.stubGlobal("crypto", { randomUUID: () => uuid });
    const launched = await launchGithubTests(git, token, ["dotnet-build", "playwright"]);
    expect(launched.requestId).toBe(uuid);
    expect(launched.commitSha).toBe(sha);
    expect(requests).toHaveLength(2);
    expect(requests[1][0]).toBe("https://api.github.com/repos/octocat/myapp/actions/workflows/softwarefactory-tests.yml/dispatches");
    expect(requests[1][1].method).toBe("POST");
    expect(requests.every(([_, opt]) => (opt.headers as Record<string,string>).Authorization === "Bearer " + token)).toBe(true);
    expect(JSON.parse(requests[1][1].body as string)).toEqual({
      ref: "main", inputs: { request_id: uuid, dotnet_build: "true", dotnet_test: "false",
        web_build: "false", web_test: "false", playwright: "true" },
    });
    await expect(launchGithubTests(git, token, ["playwright", "playwright"])).rejects.toThrow(/duplicati/);
    await expect(launchGithubTests(git, token, [])).rejects.toThrow(/Seleziona/);
  });
  it("finds only exact correlated workflow run, never associates 'last run' or wrong SHA", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ workflow_runs: [{ ...run, id: 999,
        display_title: "Unrelated run" }, run] }) }));
    expect(await findGithubActionRun(git, token, receipt)).toMatchObject({ id: 456 });
    expect(githubActionRunUrl(receipt, run)).toBe("https://github.com/octocat/myapp/actions/runs/456");
    await expect(findGithubActionRun(git, token, { ...receipt, commitSha: "b".repeat(40) })).rejects.toThrow(/SHA|branch/);
  });
  it("re-checks SHA, timestamp and attempt when resuming a bound runId", async () => {
    const resumed = { ...receipt, runId: 456 };
    const fetchRun = (candidate: GitHubWorkflowRun) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200,
        json: async () => ({ workflow_runs: [candidate] }) }));
    };
    fetchRun(run);
    expect(await findGithubActionRun(git, token, resumed)).toMatchObject({ id: 456 });
    for (const invalid of [
      { ...run, head_sha: "b".repeat(40) },
      { ...run, created_at: "2000-01-01T00:00:00.000Z" },
      { ...run, created_at: "invalid" },
      { ...run, run_attempt: 0 },
    ]) {
      fetchRun(invalid);
      await expect(findGithubActionRun(git, token, resumed)).rejects.toThrow(/non correlato/);
    }
    fetchRun({ ...run, display_title: "Unrelated run" });
    expect(await findGithubActionRun(git, token, resumed)).toBeNull();
    fetchRun({ ...run, id: 999 });
    expect(await findGithubActionRun(git, token, resumed)).toBeNull();
  });
  it("rejects uncorrelated runs before reading artifacts, parsing reports or linking them", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const unrelated = [
      { ...run, event: "push" },
      { ...run, display_title: "Unrelated run" },
      { ...run, head_sha: "b".repeat(40) },
      { ...run, created_at: "invalid" },
      { ...run, run_attempt: 0 },
      { ...run, id: 123 },
    ];
    for (const wrong of unrelated) {
      expect(() => verifyGithubActionReport(report(), { ...receipt, runId: 456 }, wrong)).toThrow(/non correlato/);
      await expect(loadGithubActionReport(git, token, { ...receipt, runId: 456 }, wrong)).rejects.toThrow(/non correlato/);
      expect(() => githubActionRunUrl({ ...receipt, runId: 456 }, wrong)).toThrow(/non correlato/);
    }
    await expect(loadGithubActionReport({ ...git, repo: "other" }, token, receipt, run))
      .rejects.toThrow(/Repository o branch diversi/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("verifies schema, step set, counters, run attempt, SHA and GitHub conclusion", () => {
    expect(verifyGithubActionReport(report(), receipt, run)).toMatchObject({ state: "passed" });
    for (const invalid of [
      { ...report(), commitSha: "b".repeat(40) },
      { ...report(), requestId: "x".repeat(30) },
      { ...report(), runId: 333 },
      { ...report(), runAttempt: 2 },
      { ...report(), state: "failed" },
      { ...report(), summary: { requested: 2, passed: 999, failed: 0, incomplete: 0 } },
      { ...report(), steps: [step("dotnet-build"), step("dotnet-build")] },
      { ...report(), steps: [step("dotnet-build")] },
      { ...report(), steps: [...report().steps, step("secret-leak")] },
      { ...report(), steps: [{ ...step("dotnet-build"), output: "x".repeat(3000) }, step("web-build")] },
      { ...report(), steps: [{ ...step("dotnet-build"), status: "incomplete" }, step("web-build")] },
      { ...report(), credentials: token },
    ]) expect(() => verifyGithubActionReport(invalid, receipt, run)).toThrow();
    expect(() => verifyGithubActionReport(report(), receipt, { ...run, conclusion: "failure" })).toThrow();
    expect(() => checkActionReceipt({ ...receipt, requestId: "bad" })).toThrow();
  });
  it("downloads small GitHub artifact ZIP and rejects missing or unauthenticated data", async () => {
    const files = zipSync({ "report.json": strToU8(JSON.stringify(report())) });
    let read = 0;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/artifacts?"))
        return { ok: true, status: 200, json: async () =>
          ({ artifacts: [{ id: 100, name: "softwarefactory-test-report",
            expired: false, size_in_bytes: 340 }] }) };
      read++;
      return { ok: true, blob: async () => new Blob([new Uint8Array(files)]) };
    }));
    expect((await loadGithubActionReport(git, token, receipt, run)).state).toBe("passed");
    expect(read).toBe(1);
    expect(calls[1]).toContain("/actions/artifacts/100/zip");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ artifacts: [] }) }));
    await expect(loadGithubActionReport(git, token, receipt, run)).rejects.toThrow(/Artifact/);
  });
});
