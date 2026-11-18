import type { FactoryProject } from "../domain/types";
import { BATCH_STEP_ORDER, validatePmTestProposal, type PmTestProposal } from "../domain/pm-test-plan";
import { runnerEndpoint, runnerRequestDigest, runnerSourceFiles,
  type RunnerBatchRequest, type RunnerStep } from "../infrastructure/runner";

export { BATCH_STEP_ORDER } from "../domain/pm-test-plan";

/** Preview from the approved workspace ONLY. The independent repair/review
 * path must not be bypassed by a batch of unapproved proposed edits.
 */
export function planRunnerBatch(
  project: FactoryProject, chosen: RunnerStep[], proposal?: PmTestProposal,
): RunnerBatchRequest {
  if (project.development?.pending)
    throw new Error("Review pending: use the independent repair/test approval flow.");
  if (!Array.isArray(chosen) || chosen.length < 2 || chosen.length > 5 ||
      new Set(chosen).size !== chosen.length ||
      chosen.some(step => !BATCH_STEP_ORDER.includes(step)))
    throw new Error("Choose two to five distinct allowlisted runner steps.");
  const sorted = BATCH_STEP_ORDER.filter(step => chosen.includes(step));
  // A PM proposal changes dependencies only, not the user-selected steps.
  const ordered = proposal ? validatePmTestProposal(proposal, sorted).tasks :
    sorted.map((id, i) => ({
      id, reason: "Operator selected step",
      dependsOn: i === 0 ? [] : [sorted[i - 1]],
    }));
  const files = runnerSourceFiles(project, false);
  const name = project.config.name.trim() || "Factory project";
  return {
    consent: true, enforced: true, label: (name + " - verified DAG").slice(0, 120),
    tasks: ordered.map(task => ({
      id: task.id, role: task.id.includes("build") ? "devops_engineer" : "tester",
      dependsOn: [...task.dependsOn],
      request: { label: (name + " - " + task.id).slice(0, 160),
        files, steps: [task.id] },
    })),
  };
}
/** Store only this non-secret digest-based signature and a retry UUID in
 * sessionStorage, NEVER the source snapshot or the bearer credential.
 */
export async function runnerBatchSignature(
  endpoint: string, project: FactoryProject, plan: RunnerBatchRequest,
): Promise<string> {
  const digests = await Promise.all(plan.tasks.map(task =>
    runnerRequestDigest(task.request.label, task.request.files, task.request.steps)));
  return JSON.stringify({
    endpoint: runnerEndpoint(endpoint), projectId: project.id,
    revision: project.development?.revision ?? 0,
    tasks: plan.tasks.map((task, i) =>
      ({ id: task.id, role: task.role, dependsOn: task.dependsOn, digest: digests[i] })),
  });
}
