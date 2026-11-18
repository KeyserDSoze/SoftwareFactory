import type { RunnerStep } from "../infrastructure/runner";

/** An AI PM may suggest precedence, never new tests, arbitrary shell steps,
 * permissions, provider credentials or execution outcomes.
 */
export const BATCH_STEP_ORDER: readonly RunnerStep[] = [
  "dotnet-build", "dotnet-test", "web-build", "web-test", "playwright",
];
export type PmTestTask = {
  id: RunnerStep;
  dependsOn: RunnerStep[];
  reason: string;
};
export type PmTestProposal = {
  summary: string;
  tasks: PmTestTask[];
};
function fail(): never {
  throw new Error("Proposta PM non valida: test, dipendenze o descrizioni non verificabili.");
}
function safeText(input: unknown, min: number, max: number): input is string {
  return typeof input === "string" && input.trim().length >= min &&
    input.length <= max && !/[\u0000-\u001f\u007f]/.test(input);
}
function keysMatch(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
export function validatePmTestProposal(
  value: unknown, selectedSteps: readonly RunnerStep[],
): PmTestProposal {
  if (selectedSteps.length < 2 || selectedSteps.length > 5 ||
      new Set(selectedSteps).size !== selectedSteps.length ||
      selectedSteps.some(step => !BATCH_STEP_ORDER.includes(step))) return fail();
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    if (parsed.length < 2 || parsed.length > 6000) return fail();
    try { parsed = JSON.parse(parsed); } catch { return fail(); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      !keysMatch(parsed, ["summary", "tasks"])) return fail();
  const root = parsed as Record<string, unknown>;
  if (!safeText(root.summary, 5, 500) ||
      !Array.isArray(root.tasks) || root.tasks.length !== selectedSteps.length) return fail();
  const allSelected = new Set(selectedSteps);
  const seen = new Set<RunnerStep>();
  const tasks: PmTestTask[] = [];
  for (const value of root.tasks) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !keysMatch(value, ["id", "dependsOn", "reason"])) return fail();
    const item = value as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || !allSelected.has(id as RunnerStep) ||
        seen.has(id as RunnerStep) || !safeText(item.reason, 4, 260) ||
        !Array.isArray(item.dependsOn) || item.dependsOn.length > 3 ||
        new Set(item.dependsOn).size !== item.dependsOn.length ||
        item.dependsOn.some(d => typeof d !== "string" || !seen.has(d as RunnerStep)))
      return fail();
    seen.add(id as RunnerStep);
    tasks.push({ id: id as RunnerStep,
      dependsOn: [...item.dependsOn] as RunnerStep[], reason: item.reason.trim() });
  }
  if (seen.size !== allSelected.size) return fail();
  const ancestors = new Map<RunnerStep, Set<RunnerStep>>();
  for (const task of tasks) {
    const upstream = new Set<RunnerStep>();
    for (const d of task.dependsOn) {
      upstream.add(d);
      for (const prev of ancestors.get(d) ?? []) upstream.add(prev);
    }
    ancestors.set(task.id, upstream);
  }
  for (const [testStep, buildStep] of [
    ["dotnet-test", "dotnet-build"], ["web-test", "web-build"],
  ] as const) {
    if (allSelected.has(testStep) && allSelected.has(buildStep) &&
        !ancestors.get(testStep)?.has(buildStep)) return fail();
  }
  if (allSelected.has("playwright") && [...allSelected].some(step =>
    step !== "playwright" && !ancestors.get("playwright")?.has(step)))
    return fail();
  return { summary: root.summary.trim(), tasks };
}
