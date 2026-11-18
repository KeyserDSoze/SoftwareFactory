# ADR 0060 — Ammissione atomica con marker per DAG enforced

- Data: 18 novembre 2026
- Stato: accettato per incremento #103 (sottoissue #89)

## Contesto

Il gate della #102 impone l'ordine quando il worker prende una claim, ma
richiede che un operatore registri prima i job indipendentemente, con rischio
che un worker online li inizi prima che il DAG sia stato creato.

## Decisione

Un batch a consenso esplicito registra insieme due-sei snapshot validati con
la stessa policy del job singolo. Sotto admission lock POSIX verifica quote
globali/tenant, rate limit per N, recheck credenziali file/tenant e idempotenza
namespaced. Staged input, report e journal accepted sono scritti fuori dalla
vera coda; i file sorgente non entrano nel manifest e non sono esposti nei GET.

Il marker di sicurezza è pubblicato con rename POSIX della directory completa
di intent, contenente ID e digest dei job, tenant e manifestHash. Da quel punto
il worker non può claimare job finché il publish non è finito. Il batch sposta
i job interamente preparati in jobs/, scrive ultimo il manifest enforced v2,
verifica il piano journal-bound e rimuove il marker, rilasciando il lock.

Se il processo termina dopo il marker ma prima dell'ultimo rename, il marker
rimane e ferma la coda globalmente. Un tool host-only a scelta esplicita
consente finalize del manifest committed oppure abort dei soli job verificati
queued/unclaimed, con journal accepted valido e digest corrispondenti.
Il tool rifiuta manifest o intent manipolati e job avviati; abort è riavviabile
se un crash ha interrotto la rimozione dei file. Niente endpoint di recovery.

## Limiti

POSIX locale e lock single-host non garantiscono multi-host transactions o
fsync contro power loss arbitraria. La hash-chain locale non è una firma.
Stage incompleti prima del marker non sono visibili dal worker ma richiedono
garbage collection controllata. Un lock di admission rimasto dopo crash non
viene rimosso automaticamente: l'operatore deve prima fermare i processi.
Questo protocollo esegue solo test richiesti; non è un PM AI autonomo, non
applica patch, non attesta rootless Docker/Cloudflare su host reale.
Le epic #89/#2/#87 mantengono scope autonomo e acceptance on-host.



## Recupero pre-marker aggiuntivo

Per lo staging orfano creato prima di .pending-UUID, il tool host-only
supporta anche discard-stage. Può eliminare i file mai pubblicati solo in
assenza di manifest, marker e ID job già apparsi in jobs/. Un ID sovrapposto
o un file inatteso blocca la pulizia per evitare cancellazioni di lavoro live.
Questo non è un'autorità automatica di riparazione o un batch auto-retry.
