import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureProposal, RepairSessionBinding, RunnerJobEvidence } from "../domain/development";
import {
  beginOrResumeRepair, getRepairCheckpoint, prepareRepairRetest, repairPaths,
  recordVerifiedRepairApproval, syncRepairRetest, type RemoteRepairSession,
} from "./repair-coordinator";

const endpoint = "https://runner.example.test";
const key = "1234567890abcdef1234567890abcdef1234567890abcdef";
const rootId = "00000000-0000-4000-a000-000000000026";
const rootProposal = "00000000-0000-4000-a000-000000000027";
const remoteId = "00000000-0000-4000-a000-000000000028";
const testId = "00000000-0000-4000-a000-000000000029";
const fixedProposalId = "00000000-0000-4000-a000-000000000030";
const backend = "src/backend/domain/Invoice.cs";
const web = "src/frontend/web/src/Invoice.tsx";
const rootDigest = "a".repeat(64);
const fixedDigest = "b".repeat(64);
const binding: RepairSessionBinding = {
  id: remoteId, rootJobId: rootId, rootProposalId: rootProposal, endpoint,
};
function initialRemote(): RemoteRepairSession {
  return { version: 1, id: remoteId, rootJobId: rootId, rootDigest,
    proposalId: rootProposal, paths: [backend, web],
    requiredSteps: ["dotnet-build", "dotnet-test", "web-build"],
    state: "awaiting_patch", attempts: [],
    checkpointCount: 1, checkpointHead: "0".repeat(64),
    createdAt: "2026-11-15T21:00:00.000Z",
  };
}
function proposal(id = rootProposal, count = 0): FeatureProposal {
  return {
    id, revision: 0, request: "Repair invoice",
    summary: "Fix a test", createdAt: "2026-11-15T21:00:00Z",
    edits: [backend,web].map(path => ({
      path, content: "source", reason: "fix", previous: null,
    })), tests: [], assumptions: [],
    ...(count ? { repairCount: count, repairSession: binding } : {}),
    review: { verdict: "pass", report: "reviewed independently",
      completedAt: "2026-11-15T21:05:00Z" },
  };
}
const failure = (id = rootId, digest = rootDigest, proposalId = rootProposal): RunnerJobEvidence => ({
  id, digest, proposalId, revision: 0,
  endpoint, label: "failed job", steps: ["dotnet-test"],
  submittedAt: "2026-11-15T21:00:00Z",
});
function backendMock(state = initialRemote()) {
  const stored = state;
  const calls: { path: string; method: string; data: Record<string, unknown> | null; auth?: string }[] = [];
  const handle = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname, method = init.method || "GET";
    const headers = init.headers as Record<string, string>;
    const data = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ path, method, data, auth: headers.Authorization });
    expect(init.redirect).toBe("error");
    expect(headers.Authorization).toBe("Bearer " + key);
    if (path === "/v1/repair-sessions" && method === "POST") {
      expect(data?.consent).toBe(true);
      return new Response(JSON.stringify(stored), { status: 201 });
    }
    if (path === "/v1/repair-sessions/" + remoteId && method === "GET")
      return new Response(JSON.stringify(stored), { status: 200 });
    if (path === "/v1/repair-sessions/" + remoteId + "/checkpoints" && method === "POST") {
      expect(data?.consent).toBe(true);
      if (data?.action === "patch") {
        stored.attempts.push({ digest: String(data.digest), verdict: null,
          retestJobId: null, retestState: null });
        stored.state = "awaiting_review";
      } else if (data?.action === "review") {
        stored.attempts.at(-1)!.verdict = "pass";
        stored.state = "awaiting_retest";
      } else if (data?.action === "retest") {
        stored.attempts.at(-1)!.retestJobId = String(data.jobId);
        stored.attempts.at(-1)!.retestState = "passed";
        stored.state = "awaiting_approval";
      } else if (data?.action === "record_approval") {
        stored.state = "recorded_approval";
      } else throw new Error("unexpected action");
      stored.checkpointCount++;
      stored.checkpointHead = String(stored.checkpointCount).padStart(64, "a");
      return new Response(JSON.stringify(stored), { status: 200 });
    }
    throw new Error("unexpected path: " + path + " " + method);
  });
  vi.stubGlobal("fetch", handle);
  return { stored, calls, handle };
}
afterEach(() => vi.unstubAllGlobals());

describe("SPA durable supervised repair coordinator", () => {
  it("begins once for the original verified failure; only non-secret IDs are returned", async () => {
    const remote = backendMock();
    const root = proposal();
    const result = await beginOrResumeRepair(endpoint, key, root, failure());
    expect(result).toEqual(binding);
    expect(repairPaths(root)).toEqual([backend, web]);
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0].data).toEqual({
      failedJobId: rootId, proposalId: rootProposal, paths: [backend, web], consent: true,
    });
    expect(JSON.stringify(remote.calls[0].data)).not.toContain("source");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(remote.calls[0].auth).toBe("Bearer " + key);
  });
  it("registers patch digest and operator-declared review once, then safely replays a retry", async () => {
    const remote = backendMock();
    const fixed = proposal(fixedProposalId, 1);
    const steps = ["dotnet-build","dotnet-test","web-build"] as const;
    const first = await prepareRepairRetest(endpoint, key, fixed, fixedDigest, [...steps]);
    expect(first.state).toBe("awaiting_retest");
    expect(first.attempts[0].digest).toBe(fixedDigest);
    expect(remote.calls.map(c => c.data?.action).filter(Boolean)).toEqual(["patch", "review"]);
    const repeated = await prepareRepairRetest(endpoint, key, fixed, fixedDigest, [...steps]);
    expect(repeated.state).toBe("awaiting_retest");
    expect(remote.calls.map(c => c.data?.action).filter(Boolean)).toEqual(["patch", "review"]);
    expect(remote.calls.filter(c => c.method === "POST").every(c =>
      !JSON.stringify(c.data).includes("source"))).toBe(true);
    expect(() => JSON.stringify(repeated).includes(key)).not.toThrow();
  });
  it("requires server retest evidence, records explicit approval and replays uncertain completion", async () => {
    const remote = backendMock();
    const fixed = proposal(fixedProposalId, 1);
    await prepareRepairRetest(endpoint, key, fixed, fixedDigest,
      ["dotnet-build", "dotnet-test", "web-build"]);
    const synced = await syncRepairRetest(endpoint, key, binding, repairPaths(fixed),
      testId, fixedDigest, "passed");
    expect(synced.state).toBe("awaiting_approval");
    const approved = await recordVerifiedRepairApproval(endpoint, key, binding,
      repairPaths(fixed), testId, fixedDigest);
    expect(approved.state).toBe("recorded_approval");
    expect((await recordVerifiedRepairApproval(endpoint, key, binding,
      repairPaths(fixed), testId, fixedDigest)).state).toBe("recorded_approval");
    expect(remote.calls.map(c => c.data?.action).filter(Boolean))
      .toEqual(["patch", "review", "retest", "record_approval"]);
    expect(remote.calls.filter(c => c.data?.action === "record_approval")[0].data)
      .toEqual({ action: "record_approval", consent: true, confirmSessionId: remoteId });
  });
  it("fails closed for missing mandatory steps, changed endpoint, digest and forged response", async () => {
    const remote = backendMock();
    const fixed = proposal(fixedProposalId, 1);
    await expect(prepareRepairRetest(endpoint, key, fixed, fixedDigest,
      ["dotnet-test", "web-build"])).rejects.toThrow(/Checkpoint remoto/);
    expect(remote.calls.every(c => !c.data?.action)).toBe(true);
    await prepareRepairRetest(endpoint, key, fixed, fixedDigest,
      ["dotnet-build","dotnet-test","web-build"]);
    await expect(prepareRepairRetest(endpoint, key, fixed, "c".repeat(64),
      ["dotnet-build","dotnet-test","web-build"])).rejects.toThrow(/Checkpoint remoto/);
    await expect(getRepairCheckpoint(endpoint, key, {
      ...binding, endpoint: "https://elsewhere.example.org",
    }, repairPaths(fixed))).rejects.toThrow(/Checkpoint remoto/);
    await expect(syncRepairRetest(endpoint, key, binding, repairPaths(fixed),
      testId, "c".repeat(64), "passed")).rejects.toThrow(/Checkpoint remoto/);
    remote.stored.proposalId = "00000000-0000-4000-a000-000000000099";
    await expect(getRepairCheckpoint(endpoint, key, binding,
      repairPaths(fixed))).rejects.toThrow(/Checkpoint remoto/);
  });
  it("second repair records the previous real failed retest; rejects a third or mismatched provenance", async () => {
    const remote = backendMock();
    remote.stored.state = "awaiting_retest";
    remote.stored.attempts = [{
      digest: fixedDigest, verdict: "pass", retestJobId: null, retestState: null,
    }];
    const second = proposal(fixedProposalId, 1);
    // This mock models an existing legitimately failed retest; unlike the live API,
    // it cannot attest the journal, which is separately exercised by Node tests.
    const run = remote.handle.getMockImplementation()!;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const result = await run(url, init);
      if (init.body && JSON.parse(String(init.body)).action === "retest") {
        remote.stored.state = "retest_failed";
        remote.stored.attempts[0].retestState = "failed";
        return new Response(JSON.stringify(remote.stored), { status: 200 });
      }
      return result;
    });
    const resumed = await beginOrResumeRepair(endpoint, key, second,
      failure(testId, fixedDigest, fixedProposalId));
    expect(resumed).toEqual(binding);
    expect(remote.stored.state).toBe("retest_failed");
    expect((await beginOrResumeRepair(endpoint, key, second,
      failure(testId, fixedDigest, fixedProposalId))).id).toBe(remoteId);
    await expect(beginOrResumeRepair(endpoint, key,
      { ...second, repairCount: 2 }, failure(testId, fixedDigest, fixedProposalId)))
      .rejects.toThrow(/Checkpoint remoto/);
  });
});
