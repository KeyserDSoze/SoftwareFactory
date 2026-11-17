/** Exclusive browser writer lease for a SoftwareFactory project (#92).
 *
 * A long-lived Web Lock prevents two tabs in the same origin from both
 * persisting edits to the same local project. Fail closed when unsupported.
 * This is intentionally NOT a server-side/multi-device lease or an IDB CAS.
 */
const ID = /^[0-9a-f-]{36}$/i;
export interface ProjectWriterLease {
  readonly projectId: string;
  release(): void;
}
export async function acquireProjectWriterLease(projectId: string): Promise<ProjectWriterLease> {
  if (typeof projectId !== "string" || !ID.test(projectId))
    throw Error("ID progetto non valido per il blocco di scrittura.");
  if (!globalThis.navigator?.locks?.request)
    throw Error("Web Locks non disponibili: modifica locale in sola lettura per evitare sovrascritture fra schede.");
  return new Promise<ProjectWriterLease>((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (!settled) { settled = true; reject(error); }
    };
    const resolveOnce = (lease: ProjectWriterLease) => {
      if (!settled) { settled = true; resolve(lease); }
    };
    // Never wait for a rival browser tab: that tab may remain open all day.
    // Always acquire with ifAvailable and offer explicit recovery/retry in UI.
    void navigator.locks.request(
      "softwarefactory:local-writer:" + projectId.toLowerCase(),
      { mode: "exclusive", ifAvailable: true },
      async lock => {
        if (!lock) {
          rejectOnce(Error("Progetto già in modifica in un'altra scheda. Chiudi l'altra scheda e riprova."));
          return;
        }
        let releaseHold: (() => void) | undefined;
        const held = new Promise<void>(done => { releaseHold = done; });
        let active = true;
        resolveOnce({
          projectId,
          release: () => { if (active) { active = false; releaseHold?.(); } },
        });
        await held;
      },
    ).catch(() => rejectOnce(Error("Impossibile mantenere il blocco di scrittura locale.")));
  });
}
