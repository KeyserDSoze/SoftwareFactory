/** Browser client for the durable, operator-declared repair checkpoint ledger.
 * Does not send source files or credentials to storage, and does not execute AI.
 */
import type { RepairSessionBinding, RunnerJobEvidence, FeatureProposal } from "../domain/development";
import type { RunnerStep } from "./runner";
import { runnerEndpoint, runnerRequest } from "./runner";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
type State = "awaiting_patch" | "awaiting_review" | "awaiting_retest" |
  "awaiting_approval" | "recorded_approval" | "retest_failed" | "review_blocked";
export type RemoteRepairAttempt = {
  digest: string;
  verdict: "pass" | "changes_required" | null;
  retestJobId: string | null;
  retestState: "passed" | "failed" | null;
};
export type RemoteRepairSession = {
  version: 1;
  id: string;
  rootJobId: string;
  rootDigest: string;
  proposalId: string;
  paths: string[];
  requiredSteps: RunnerStep[];
  state: State;
  attempts: RemoteRepairAttempt[];
  checkpointCount: number;
  checkpointHead: string;
  createdAt: string;
};
const STATES = new Set<State>(["awaiting_patch", "awaiting_review", "awaiting_retest",
  "awaiting_approval", "recorded_approval", "retest_failed", "review_blocked"]);
const allowedSteps = new Set<RunnerStep>(["dotnet-build", "dotnet-test", "web-build",
  "web-test", "playwright"]);
const invalid = (): never => { throw new Error("Checkpoint remoto non valido: operazione bloccata."); };
export function repairPaths(patch: FeatureProposal): string[] {
  return patch.edits.map(e => e.path).sort();
}
export function verifyRemoteRepairSession(raw: RemoteRepairSession): RemoteRepairSession {
  if (!raw || raw.version !== 1 || !UUID.test(raw.id) ||
      !UUID.test(raw.rootJobId) || !UUID.test(raw.proposalId) ||
      !HASH.test(raw.rootDigest) || !STATES.has(raw.state) ||
      !Array.isArray(raw.paths) || !raw.paths.length || raw.paths.length > 8 ||
      raw.paths.some(p => typeof p !== "string" || p.length > 180) ||
      raw.paths.some((p,i) => i && raw.paths[i-1] >= p) ||
      !Array.isArray(raw.requiredSteps) || !raw.requiredSteps.length ||
      raw.requiredSteps.some(s => !allowedSteps.has(s)) ||
      !Array.isArray(raw.attempts) || raw.attempts.length > 2 ||
      raw.attempts.some(a => !HASH.test(a.digest) ||
        (a.verdict !== null && a.verdict !== "pass" && a.verdict !== "changes_required") ||
        (a.retestJobId !== null && !UUID.test(a.retestJobId)) ||
        (a.retestState !== null && a.retestState !== "passed" && a.retestState !== "failed")) ||
      !Number.isInteger(raw.checkpointCount) || raw.checkpointCount < 1 ||
      !HASH.test(raw.checkpointHead))
    return invalid();
  return raw;
}
function assertBinding(
  result: RemoteRepairSession, binding: RepairSessionBinding,
  paths: string[],
  endpoint: string,
): RemoteRepairSession {
  const validated = verifyRemoteRepairSession(result);
  if (runnerEndpoint(endpoint) !== binding.endpoint ||
      result.id !== binding.id ||
      result.rootJobId !== binding.rootJobId ||
      result.proposalId !== binding.rootProposalId ||
      JSON.stringify(result.paths) !== JSON.stringify(paths))
    return invalid();
  return validated;
}
export async function getRepairCheckpoint(
  baseUrl: string, key: string, binding: RepairSessionBinding, paths: string[],
  signal?: AbortSignal,
): Promise<RemoteRepairSession> {
  if (!UUID.test(binding.id)) return invalid();
  const response = await runnerRequest<RemoteRepairSession>(baseUrl, key,
    "/v1/repair-sessions/" + binding.id, { signal });
  return assertBinding(response, binding, paths, baseUrl);
}
async function checkpoint(
  baseUrl: string, key: string, binding: RepairSessionBinding,
  paths: string[], payload: Record<string, unknown>, signal?: AbortSignal,
): Promise<RemoteRepairSession> {
  const response = await runnerRequest<RemoteRepairSession>(baseUrl, key,
    "/v1/repair-sessions/" + binding.id + "/checkpoints", {
      method: "POST", body: JSON.stringify({ ...payload, consent: true }), signal,
    });
  return assertBinding(response, binding, paths, baseUrl);
}

/** First repair starts a session; second repair records the real failed retest
 * before letting AI receive new logs. Existing sessions survive network retries.
 */
export async function beginOrResumeRepair(
  baseUrl: string, key: string, patch: FeatureProposal,
  failure: RunnerJobEvidence, signal?: AbortSignal,
): Promise<RepairSessionBinding> {
  const paths = repairPaths(patch);
  if (!UUID.test(patch.id) || !UUID.test(failure.id) || !HASH.test(failure.digest) ||
      patch.id !== failure.proposalId) return invalid();
  const endpoint = runnerEndpoint(baseUrl);
  const binding = patch.repairSession;
  if (!binding) {
    if ((patch.repairCount ?? 0) !== 0) return invalid();
    const session = verifyRemoteRepairSession(await runnerRequest<RemoteRepairSession>(
      baseUrl, key, "/v1/repair-sessions", { method: "POST", signal,
        body: JSON.stringify({
          failedJobId: failure.id, proposalId: patch.id, paths, consent: true,
        }),
      }));
    if (session.rootJobId !== failure.id || session.rootDigest !== failure.digest ||
        session.proposalId !== patch.id || session.state !== "awaiting_patch" ||
        JSON.stringify(session.paths) !== JSON.stringify(paths))
      return invalid();
    return { id: session.id, rootJobId: failure.id,
      rootProposalId: patch.id, endpoint };
  }
  if ((patch.repairCount ?? 0) < 1 || binding.endpoint !== endpoint)
    return invalid();
  const session = await syncRepairRetest(baseUrl, key, binding, paths,
    failure.id, failure.digest, "failed", signal);
  if (session.state !== "retest_failed" ||
      session.attempts.length !== patch.repairCount) return invalid();
  return binding;
}

/** Establish the exact test snapshot to be submitted. If a network response was
 * lost, GET the remote state and reuse the existing valid checkpoint, not another patch.
 */
export async function prepareRepairRetest(
  baseUrl: string, key: string, patch: FeatureProposal,
  digest: string, requestedSteps: RunnerStep[], signal?: AbortSignal,
): Promise<RemoteRepairSession> {
  const binding = patch.repairSession, count = patch.repairCount ?? 0;
  if (!binding || !HASH.test(digest) || count < 1 || count > 2 ||
      patch.review?.verdict !== "pass") return invalid();
  const paths = repairPaths(patch);
  let session = await getRepairCheckpoint(baseUrl, key, binding, paths, signal);
  if (session.requiredSteps.some(step => !requestedSteps.includes(step)))
    return invalid();
  if (["awaiting_patch","retest_failed","review_blocked"].includes(session.state)) {
    if (session.attempts.length !== count - 1) return invalid();
    session = await checkpoint(baseUrl, key, binding, paths,
      { action: "patch", digest, paths }, signal);
  }
  if (!["awaiting_review","awaiting_retest"].includes(session.state) ||
      session.attempts.length !== count ||
      session.attempts[count - 1].digest !== digest) return invalid();
  if (session.state === "awaiting_review") {
    session = await checkpoint(baseUrl, key, binding, paths,
      { action: "review", verdict: "pass" }, signal);
  }
  if (session.state !== "awaiting_retest" ||
      session.attempts[count - 1].verdict !== "pass") return invalid();
  return session;
}

/** Save a terminal test result after the user has explicitly authorized
 * its submission. API verifies the actual journal and all mandated steps.
 */
export async function syncRepairRetest(
  baseUrl: string, key: string, binding: RepairSessionBinding, paths: string[],
  jobId: string, digest: string, expected: "passed" | "failed",
  signal?: AbortSignal,
): Promise<RemoteRepairSession> {
  if (!UUID.test(jobId) || !HASH.test(digest)) return invalid();
  let session = await getRepairCheckpoint(baseUrl, key, binding, paths, signal);
  const attempt = session.attempts.at(-1);
  if (!attempt || attempt.digest !== digest) return invalid();
  if (session.state === "awaiting_retest") {
    session = await checkpoint(baseUrl, key, binding, paths,
      { action: "retest", jobId }, signal);
  }
  const refreshed = session.attempts.at(-1);
  if (!refreshed || refreshed.retestJobId !== jobId ||
      refreshed.retestState !== expected ||
      session.state !== (expected === "passed" ? "awaiting_approval" : "retest_failed"))
    return invalid();
  return session;
}
export async function recordVerifiedRepairApproval(
  baseUrl: string, key: string, binding: RepairSessionBinding,
  paths: string[], jobId: string, digest: string, signal?: AbortSignal,
): Promise<RemoteRepairSession> {
  let session = await getRepairCheckpoint(baseUrl, key, binding, paths, signal);
  const attempt = session.attempts.at(-1);
  if (!attempt || attempt.digest !== digest || !UUID.test(jobId)) return invalid();
  if (session.state === "recorded_approval") {
    if (attempt.retestJobId !== jobId || attempt.retestState !== "passed") return invalid();
    return session;
  }
  session = await syncRepairRetest(baseUrl, key, binding, paths, jobId, digest,
    "passed", signal);
  session = await checkpoint(baseUrl, key, binding, paths,
    { action: "record_approval", confirmSessionId: binding.id }, signal);
  if (session.state !== "recorded_approval" ||
      session.attempts.at(-1)?.retestJobId !== jobId) return invalid();
  return session;
}
