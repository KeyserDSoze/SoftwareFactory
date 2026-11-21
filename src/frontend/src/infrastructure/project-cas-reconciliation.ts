/** Read-only legacy-vs-IDB reconciliation, NOT a cross-store CAS (#142).
 * Both sources are sampled twice; any detected race rejects the whole report.
 * A stable result remains a point-in-time observation, not durable authority.
 */
import { prepareLegacyCasCopy } from "./project-cas-migration";
import { readCasProjectSlot } from "./project-cas";
import type { CasProjectSlot, CasProjectSnapshot } from "./project-cas";

export type CasCopyInspection = Readonly<{
  id: string;
  status: "missing" | "tombstone" | "identical" | "diverged";
  revision?: number;
}>;

function sameSlot(a: CasProjectSlot, b: CasProjectSlot): boolean {
  if (a.state !== b.state) return false;
  if (a.state === "missing") return true;
  if (a.state === "tombstone" && b.state === "tombstone")
    return a.revision === b.revision;
  return a.state === "present" && b.state === "present" &&
    a.snapshot.revision === b.snapshot.revision &&
    a.snapshot.raw === b.snapshot.raw;
}

function sameSnapshot(slot: CasProjectSlot, snapshot: CasProjectSnapshot): boolean {
  return slot.state === "present" && slot.snapshot.id === snapshot.id &&
    slot.snapshot.revision === snapshot.revision &&
    slot.snapshot.raw === snapshot.raw;
}

export async function inspectLegacyCasCopy(id: string): Promise<CasCopyInspection> {
  const before = prepareLegacyCasCopy(id).raw; // exact canonical local slot
  const first = await readCasProjectSlot(id);
  const during = prepareLegacyCasCopy(id).raw;
  const second = await readCasProjectSlot(id);
  const after = prepareLegacyCasCopy(id).raw;
  if (before !== during || before !== after || !sameSlot(first, second))
    throw Error("Le copie locali sono cambiate durante la verifica: ripeti il confronto.");
  if (first.state === "missing") return {id,status:"missing"};
  if (first.state === "tombstone")
    return {id,status:"tombstone",revision:first.revision};
  return {
    id, revision:first.snapshot.revision,
    status:first.snapshot.raw === before ? "identical" : "diverged",
  };
}

/** Export is a manually approved HISTORICAL snapshot. It does not imply
 * IDB is current or trusted. Exact revision+raw are checked before returning
 * bytes, and the caller must still ask for explicit browser download consent.
 */
export async function readCasExportSnapshot(
  id: string, expectedRevision: number,
): Promise<CasProjectSnapshot> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw Error("Revisione IndexedDB non valida per il recupero.");
  const first = await readCasProjectSlot(id);
  if (first.state !== "present" || first.snapshot.revision !== expectedRevision)
    throw Error("La copia IndexedDB è cambiata: ripeti la verifica prima di esportare.");
  const second = await readCasProjectSlot(id);
  if (!sameSnapshot(second, first.snapshot))
    throw Error("La copia IndexedDB è cambiata: ripeti la verifica prima di esportare.");
  return first.snapshot;
}
