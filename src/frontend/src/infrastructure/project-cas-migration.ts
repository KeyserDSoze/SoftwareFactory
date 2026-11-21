/** Non-destructive legacy slot staging for a future opt-in async editor cutover.
 * UI must download the exact raw JSON and obtain a separate positive backup
 * acknowledgement before calling copyLegacyCasTicket (#141/#139).
 */
import type { FactoryProject } from "../domain/types";
import { localProjectSnapshot } from "./store";
import { insertCasProjectNeverSeen, serializeCasProject } from "./project-cas";
import type { CasProjectSnapshot } from "./project-cas";

export type LegacyCasCopyTicket = Readonly<{ id: string; raw: string }>;

function validatedProject(ticket: LegacyCasCopyTicket): FactoryProject {
  let project: FactoryProject;
  try { project = JSON.parse(ticket.raw) as FactoryProject; }
  catch { throw Error("JSON legacy non valido: copia annullata."); }
  try {
    if (project.id !== ticket.id || serializeCasProject(project) !== ticket.raw)
      throw Error("Mismatch");
  } catch {
    throw Error("Snapshot legacy corrotto o non identico: copia annullata.");
  }
  return project;
}
function assertUnchanged(ticket: LegacyCasCopyTicket): void {
  let current: string | null;
  try { current = localProjectSnapshot(ticket.id); }
  catch { throw Error("Lettura del progetto legacy non disponibile."); }
  if (current !== ticket.raw)
    throw Error("Il progetto legacy è cambiato: nuovo backup e consenso necessari.");
}
export function prepareLegacyCasCopy(id: string): LegacyCasCopyTicket {
  let raw: string | null;
  try { raw = localProjectSnapshot(id); }
  catch { throw Error("Lettura del progetto legacy non disponibile."); }
  if (!raw) throw Error("Progetto legacy non trovato.");
  const ticket = {id,raw};
  validatedProject(ticket);
  assertUnchanged(ticket);
  return ticket;
}
/** Download this exact source JSON before requesting the saved-file consent. */
export function legacyCasBackupJson(ticket: LegacyCasCopyTicket): string {
  validatedProject(ticket);
  assertUnchanged(ticket);
  return ticket.raw;
}
export async function copyLegacyCasTicket(
  ticket: LegacyCasCopyTicket, backupConfirmed: boolean,
): Promise<CasProjectSnapshot> {
  if (backupConfirmed !== true)
    throw Error("Conferma del backup JSON obbligatoria.");
  const project = validatedProject(ticket);
  assertUnchanged(ticket);
  const inserted = await insertCasProjectNeverSeen(project,ticket.raw);
  // localStorage and IndexedDB are NOT one atomic storage transaction.
  try { assertUnchanged(ticket); }
  catch {
    throw Error("Il legacy è cambiato durante la copia: la copia IndexedDB potrebbe essere obsoleta. Nessuna versione è stata cancellata o sovrascritta.");
  }
  return inserted;
}
