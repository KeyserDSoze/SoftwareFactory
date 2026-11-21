/**
 * Local backup-file preflight for explicit, isolated IndexedDB tombstone restore
 * (#148). Both historical raw JSON and existing SoftwareFactory local recovery
 * envelopes are accepted. Never read localStorage, tokens, cloud or GitHub.
 */
import type { FactoryProject } from "../domain/types";
import { serializeCasProject } from "./project-cas";

export const MAX_CAS_RESTORE_FILE_BYTES = 1_500_000;

export type CasRestoreFileProject = Readonly<{
  id: string;
  name: string;
  raw: string;
}>;

/**
 * A saved JSON may contain pretty-print whitespace or the v1 backup envelope.
 * Normalize the *project* to the canonical CAS raw (byte-identical to the
 * serialized project, not necessarily the formatted file envelope).
 * Restore still needs a current tombstone ticket and separate user consent.
 */
export function parseCasRestoreBackupFile(source: string): CasRestoreFileProject {
  if (typeof source !== "string" || source.length === 0 ||
      source.length > MAX_CAS_RESTORE_FILE_BYTES)
    throw Error("Backup JSON IndexedDB vuoto o troppo grande (massimo 1,5 MB).");
  let input: unknown;
  try { input = JSON.parse(source); }
  catch { throw Error("Backup JSON IndexedDB non valido."); }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Backup JSON IndexedDB non valido.");
  const object = input as Record<string, unknown>;
  let candidate: unknown = input;
  if ("kind" in object || "schemaVersion" in object || "exportedAt" in object) {
    if (object.kind !== "softwarefactory-local-recovery" ||
        object.schemaVersion !== 1 || !object.project ||
        Object.keys(object).sort().join(",") !== "exportedAt,kind,project,schemaVersion" ||
        typeof object.exportedAt !== "string" ||
        !Number.isFinite(Date.parse(object.exportedAt)))
      throw Error("Formato backup SoftwareFactory non riconosciuto.");
    candidate = object.project;
  }
  try {
    const project = candidate as FactoryProject;
    const raw = serializeCasProject(project);
    return Object.freeze({id:project.id,name:project.config.name,raw});
  } catch {
    throw Error("Backup JSON IndexedDB non canonico o progetto non valido.");
  }
}
