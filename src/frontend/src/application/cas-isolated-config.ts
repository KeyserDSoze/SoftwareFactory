/**
 * A deliberately isolated IndexedDB-only configuration edit (#149/#139).
 * This is NOT the live React editor: it never touches localStorage, settings,
 * PATs, cloud, GitHub or the active Factory workspace.
 *
 * Recompute from an EXACT CAS snapshot; never merge a stale form with a
 * newer remote version. Stage evidence must not survive a config edit.
 */
import type { FactoryProject } from "../domain/types";
import type { CasProjectSnapshot } from "../infrastructure/project-cas";
import { serializeCasProject } from "../infrastructure/project-cas";
import { invalidateStages } from "./pipeline";
import { updateConfig } from "../domain/defaults";

export const CAS_ISOLATED_NAME_MAX = 120;
export const CAS_ISOLATED_DESCRIPTION_MAX = 8_000;
export const CAS_ISOLATED_REQUIREMENTS_MAX = 12_000;

export function buildCasIsolatedConfigEdit(
  expected: CasProjectSnapshot, name: string, description: string,
  requirements: string,
): FactoryProject {
  if (typeof name !== "string" || name.trim().length === 0 ||
      name.length > CAS_ISOLATED_NAME_MAX || typeof description !== "string" ||
      description.length > CAS_ISOLATED_DESCRIPTION_MAX ||
      typeof requirements !== "string" ||
      requirements.length > CAS_ISOLATED_REQUIREMENTS_MAX)
    throw Error("Nome o descrizione IndexedDB non validi o troppo lunghi.");

  let original: FactoryProject;
  try {
    original=JSON.parse(expected.raw) as FactoryProject;
    if (original.id !== expected.id || serializeCasProject(original) !== expected.raw)
      throw Error("Invalid");
  } catch {
    throw Error("Snapshot IndexedDB non canonico: modifica bloccata.");
  }

  // Historical IDB fixtures can lack requirements, while canonical new
  // projects always contain it. Never accept an unexpected non-string value.
  const previousRequirements = original.config.requirements === undefined
    ? "" : original.config.requirements;
  if (typeof previousRequirements !== "string")
    throw Error("Requisiti IndexedDB non validi.");
  if (original.config.name === name &&
      original.config.description === description &&
      previousRequirements === requirements)
    throw Error("Nessuna modifica IndexedDB da salvare.");

  const updated = invalidateStages(updateConfig(original, {
    ...original.config, name, description, requirements,
  }));
  // Re-validate final serialized size and identity BEFORE calling CAS.
  serializeCasProject(updated);
  return updated;
}
