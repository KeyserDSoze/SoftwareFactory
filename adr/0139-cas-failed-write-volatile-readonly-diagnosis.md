# ADR 0139 — Diagnostica read-only di scrittura CAS bloccata (#197/#139)

## Contesto
Il controller opt-in IndexedDB ammette un ACK soltanto su `tx.oncomplete`. Conflitti, quota, versionchange o perdita dell'ACK possono lasciare il controller `blocked` e il draft React ancora visibile, ma senza la versione RAW della proposta rifiutata non si può distinguere l'esito attuale dall'eventuale commit di un'altra scheda.

## Decisione
Gli **otto** `controller.commit` nell'editor isolato passano per `commitSelectedWithProbe`: prima della transazione costruiscono ticket canonico e immutable `old(id,rev,raw)` + `proposed(id,rev+1,raw)`; conservano ticket SOLO in RAM dopo un'eccezione con sessione `blocked`, non dopo un commit riuscito o preflight respinto. Reset su nuova selezione, commit riuscito, chiusura o refresh che scarta la selezione; nessuna persistenza, rete, provider o credenziali. Le transazioni della pipeline AI lunga sono fuori scope.

Il pulsante esplicito di sola lettura, disponibile anche a controller bloccato e mentre il draft rimane sporco, esegue `readCasProjectSlot` e classifica: `unchanged` (revisione/RAW di partenza), `candidate_present` (rev/RAW byte-esatti della proposta), `diverged` (versione concorrente diversa), `tombstone` e `missing`. Rifiutare raw non canonici, revisioni regressive, same-revision-different-RAW e tombstone non monotone. Gli errori di lettura sono `unavailable`, non successi. **La presenza dei byte proposti non dimostra che questa scheda abbia scritto né fornisce un ACK `tx.oncomplete`**: non c'è attribuzione del writer. Diagnosi non modifica selezione, draft, prove reviewer/runner, legacy, IDB, cloud o GitHub; nessun retry, merge o adopt automatico. Il recupero resta manuale con #194/#195/#196 e nuova autorizzazione CAS.

## Test e limiti
Vitest con 5 esiti, RAW/ID/revisione, tamper, assenza di I/O storage/provider non autorizzati; Chromium reale con conflitto a due schede, read-only `diverged` e bozza/copia vincitrice invariata; marker `FACTORY_CAS_FAILED_WRITE_DIAGNOSIS_E2E_PASS`. Validare Factory CI, Pages e Installer candidate sullo stesso SHA. Non migra gli altri writer dell'editor live legacy (#139), né prova provider GitHub/PAT/OneDrive (#91/#92).
