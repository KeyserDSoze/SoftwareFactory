# ADR 0049 — Browser Web Locks: singola scheda writer per progetto

Data: 17 novembre 2026 · Stato: **implementato; smoke Chromium reale passato in CI intermedia, collaudo finale in corso**
Issue [#92](https://github.com/KeyserDSoze/SoftwareFactory/issues/92), epica [#91](https://github.com/KeyserDSoze/SoftwareFactory/issues/91). Complementa [ADR 0048](0048-github-pat-project-sync-bookwriter-parity.md).

## Problema

La libreria locale usa localStorage e una copia per-progetto `softwarefactory.project.library.v1.<uuid>`. Prima di questa modifica, `persistProjectIfUnchanged` controllava la stringa serializzata prima del PUT ma due schede potevano entrambe superare il check ed eseguire una scrittura concorrente. I listener `storage` e il guard di SHA remoto non rendono transazionale il salvataggio locale. GitHub autosync aveva già Web Locks per i commit remoti, ma **non** per tutti i cambi locali.

## Decisione

- Un progetto ha **una sola scheda editor per origin**. `acquireProjectWriterLease(id)` acquisisce `navigator.locks.request('softwarefactory:local-writer:' + id.toLowerCase(), { mode:'exclusive', ifAvailable:true }, callback)` e trattiene il lock per l'intera permanenza sul progetto. Chiudendo/ricaricando la pagina, il browser rilascia il lock; non occorrono heartbeat/TTL in localStorage.
- Il tentativo di lock concorrente **non aspetta**: mostra avviso e blocca creazione progetti, modifica, Code Agent, pipeline AI, import, backup che sovrascriva e publish finché la scheda non ottiene il controllo. In assenza di Web Locks, browser fall-closed e backup/ripristino manuale; **non** si torna a scritture in chiaro senza protezione.
- Il `persistProjectIfUnchanged` confronta inoltre l'ultima versione vista nella scheda con la libreria, come protezione contro client obsoleti che non rispettano i Web Locks, estensioni e altre scritture `localStorage` non cooperative. Il listener `storage` segnala subito copie cambiate. Le due protezioni sono complementari.
- Nuovo progetto, passaggio a un altro progetto locale, import remoto con nuovo ID e restore cloud acquisiscono **prima il lock del progetto destinazione**. Se il nuovo lock non è disponibile, il progetto attivo resta quello vecchio e il vecchio lock rimane attivo. Solo a salvataggio confermato il vecchio viene rilasciato. Il cambio viene serializzato per evitare due navigazioni simultanee.
- React StrictMode monta e smonta gli effects due volte in sviluppo: si differisce l'acquisizione di una microtask per non interpretare il proprio cleanup come una scheda concorrente; un lease ottenuto da un effect cancellato viene immediatamente rilasciato.
- Recovery esplicito: se una seconda scheda trova il progetto occupato, può salvare il proprio snapshot come JSON; dopo chiusura della prima scheda e un secondo consenso, tenta l'acquisizione del lock, rilegge la copia più recente e abilita la modifica. Nessun contenuto viene unito o sovrascritto automaticamente.
- GitHub autosync continua ad usare lock separati per repository/branch e recheck HEAD remoto; non confondere lock browser per-progetto con coordinazione globale tra dispositivi.

## Verifica

Unit test `project-writer-lease.test.ts`: stesso ID conteso, due ID indipendenti, release idempotente, assenza browser API = fail-closed. Real Chromium smoke `src/runner/scripts/factory-browser-lock-smoke.mjs` usa due/tre schede sulla Factory compilata, verifica bloccaggio ed esplicito export/restore del JSON dopo aver chiuso il writer. Eseguito dalla Factory CI in container Playwright networkless, read-only, no extra caps, socket Docker mai montato nel browser. Step Chromium passato nel run [44144764617](https://github.com/KeyserDSoze/SoftwareFactory/actions/runs/44144764617); il test copre anche il rifiuto della conferma e una scrittura da scheda obsoleta nelle versioni successive.

## Limitazioni e minacce

- Web Locks è coordinazione **same-origin/browser profile**, non cross-origin, cross-profile, tra dispositivi, tra browser indipendenti o contro script ostili eseguiti nella stessa origin. È necessario testare browser Web Locks supportati e gestione browser crash/suspend.
- Le versioni precedenti della SPA che ignorano il lease possono ancora scrivere localStorage; il guard baseline e il listener riducono il rischio ma non garantiscono serializzabilità contro codice non cooperativo. Per una futura fase multi-versione/doppio profilo considerare transazioni IndexedDB e protocollo di migrazione, senza attribuire a Web Locks una CAS persistente universale.
- La finestra di rilascio del vecchio lease e acquisizione del nuovo è serializzata nella scheda; un altro dispositivo può comunque modificare GitHub: i commit remoti rimangono protetti dal recheck di HEAD e dall'assenza di force push.
- Il download via blob non garantisce che l'utente conservi il file. La UI chiede un secondo consenso esplicito; l'utente resta responsabile del backup off-host.
