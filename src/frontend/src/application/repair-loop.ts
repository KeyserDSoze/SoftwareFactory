/** Pure, supervised repair-to-retest policy. No source is sent or approved here. */
import type { FactoryProject } from "../domain/types";
import { developmentOf, allowedCodePath } from "../domain/development";
import type { RunnerStep, RunnerJobReceipt } from "../infrastructure/runner";

const ORDER: RunnerStep[] = ["dotnet-build", "dotnet-test", "web-build", "web-test", "playwright"];
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export type RepairRetestPlan = {
  attempt: 1 | 2;
  failedJobId: string;
  proposalId: string;
  steps: RunnerStep[];
  requiredBuilds: RunnerStep[];
  label: string;
};

/** Preserve all original failed-job checks, add mandatory builds and user-selected
 * steps. Never let UI selection suppress a failed test or the relevant compiler.
 */
export function planRepairRetest(project: FactoryProject, selected: RunnerStep[] = []): RepairRetestPlan {
  const dev = developmentOf(project), pending = dev.pending;
  const count = pending?.repairCount ?? 0;
  if (!pending || (count !== 1 && count !== 2) || pending.revision !== dev.revision ||
      pending.review?.verdict !== "pass")
    throw new Error("La patch riparata richiede una nuova review indipendente positiva.");
  const trail = pending.repairTrail;
  if (!trail || trail.length !== count || trail.some((entry, i) =>
    entry.attempt !== i + 1 || !UUID.test(entry.failedJobId) ||
    !HASH.test(entry.failedDigest) || !Array.isArray(entry.steps) ||
    !entry.steps.length || entry.steps.some(step => !ORDER.includes(step))))
    throw new Error("Provenienza dei test falliti incompleta: ripetere il workflow di repair.");
  if (selected.some(step => !ORDER.includes(step)))
    throw new Error("Step non autorizzato nel re-test.");
  const required = new Set<RunnerStep>();
  for (const edit of pending.edits) {
    if (!allowedCodePath(edit.path)) throw new Error("La patch contiene un path non consentito.");
    if (edit.path.endsWith(".cs")) required.add("dotnet-build");
    if (edit.path.startsWith("src/frontend/web/src/")) required.add("web-build");
    if (edit.path.startsWith("src/frontend/web/e2e/")) required.add("playwright");
  }
  if (!required.size) throw new Error("Nessun controllo di build adatto ai file riparati.");
  const steps = new Set<RunnerStep>([...trail[count - 1].steps, ...required, ...selected]);
  return {
    attempt: count as 1 | 2, proposalId: pending.id,
    failedJobId: trail[count - 1].failedJobId,
    steps: ORDER.filter(step => steps.has(step)),
    requiredBuilds: ORDER.filter(step => required.has(step)),
    label: (project.config.name + " · repair " + count + ": " + pending.summary).slice(0, 160),
  };
}

/** A rejected or ambiguous response is NOT a verified test receipt. */
export function verifyRepairRetestReceipt(
  receipt: RunnerJobReceipt, digest: string,
): void {
  if (!receipt || !UUID.test(receipt.id) || !HASH.test(digest) ||
      receipt.digest !== digest || receipt.state !== "queued")
    throw new Error("Ricevuta re-test diversa dallo snapshot: esito non verificabile.");
}
