# ADR 0058 — Registro multi-job durevole come manifest osservativo

- Data: 18 novembre 2026
- Stato: accettato per tranche #100 (sottoissue #89)

## Contesto

La SPA ha un DAG di pianificazione derivato da checkpoint (#98); il runner un piano
per singolo job verificato contro journal SHA e inode (#99). Mancava una relazione
persistente tra più job distinti, con confini tenant e retry senza duplicazioni.

## Decisione

Introdurre un manifest **operatore esplicito** a consenso, senza job creation o
autonomous scheduling. Fino a 6 job già ammessi con IDs/sha di snapshot,
dipendenze topologicamente ordinate e owner role allowlisted, solo descrittivi.
POST e GET usano la stessa Bearer dell'API runner, recheck revoca on demand
(file key o tenant registry), scope tenant stretto, idempotenza UUIDv4 e
\`withAdmissionLock\` sul volume POSIX. Un file privato 0600 per workflow,
hash locale dell'intero manifest, O_NOFOLLOW, fstat inizio/fine e limite 8KB.
Le API espongono solo metadata non segreti, e falliscono se un report manca
o non coincide con snapshot o tenant.

Gli stati dei nodi vengono **ricomputati** da ogni report+hash chain verificata
attraverso il proiettore #99. Dipendente già partito senza upstream passato
diventa \`out_of_order\`, anziché successo. Una receipt non equivale a test;
se i dati del job sono eliminati dalla retention, il workflow diventa
non verificabile senza inventare un risultato. Non eseguire su worker alcuna
azione nuova, né mettere prompt/file/secret dentro il manifest.

## Limiti e prossimi gate

La registrazione di job esistenti non è un scheduler: non impone la precedenza
all'ammissione o all'esecuzione. Atomic rename e hash SHA locale proteggono da
errori e corruzione accidentale, non da attaccante host che può riscrivere il file
e ricalcolare hash. Nessuna firma, identity/MFA, off-host attestation, budget
o PM AI automating. Questi requisiti rimangono nell'epica #89 e #2/#87.
