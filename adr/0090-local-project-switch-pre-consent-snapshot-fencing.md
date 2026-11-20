# ADR 0090 — Snapshot pre-consenso per cambio progetto e lease destination

**Data:** 2026-11-20  
**Issue:** #136, milestone #92 e #91  
**Stato:** accepted come fix di perdita dati locale, non CAS transazionale.

## Contesto

L'editor React è local-first e usa `persistProjectIfUnchanged` con Web Lock per ID per evitare writer concorrenti cooperativi. Il percorso `switchProject` presentava una race: leggeva `selected = loadLocalProject(id)` prima di `confirm()` ma catturava `selectedOnRequest = localProjectSnapshot(id)` solo **dopo**. Una scheda rivale poteva aggiornare il progetto mentre la conferma rimaneva aperta; la scheda corrente prendeva il lock poi persisteva `selected` obsoleto con baseline corrente, passando l'uguaglianza in `persistProjectIfUnchanged`.

Inoltre i flussi `changeProjectWithLease` (nuovo progetto, import GitHub, cloud restore) leggevano talvolta il baseline target solo quando già in possesso del lease, consentendo un cambio non riconosciuto durante l'attesa.

## Decisione

1. Apre il prompt soltanto dopo `prepareLocalProjectSwitch(id)`, che acquisisce il raw snapshot e un nome visualizzabile, controllando che un'ulteriore lettura rimanga identica. Il ticket porta uno snapshot esatto fissato prima di qualsiasi conferma umana.
2. Dopo l'acquisizione esclusiva Web Lock del target, `readConfirmedLocalProjectSwitch(ticket)` confronta prima e dopo una nuova `loadLocalProject(id)` il valore con **lo snapshot originale**; lo stato riletto sotto lock è l'unico candidato al salvataggio. Se uno qualsiasi dei controlli fallisce, non si scrive il target, il lease nuovo viene rilasciato e il vecchio viene conservato.
3. `changeProjectWithLease` cattura `localProjectSnapshot(nextProject.id)` **prima** dell'attesa del lease, ricontrolla esattamente lo stesso valore sotto lock e ripristina/rilascia correttamente i lease anche sulle eccezioni. Il guard esistente `persistProjectIfUnchanged` resta invariato.
4. Nessun auto-merge, push automatico, replay PAT/runner evidence o accettazione di un progetto remoto senza consenso. Se si verifica un conflitto serve ripetere la selezione dopo aver verificato lo stato aggiornato.

## Verifica e limiti

Vitest simula intervalli di mutazione tra letture, durante la conferma, durante l'ultimo readback, creazione/aggiornamento destinazione prima del lease, normalizzazione running->pending, ID invalido e record corrotto. La Factory CI include già E2E Chromium per Web Locks. La protezione ferma la specifica sovrascrittura stale nel flusso cooperativo ma non trasforma localStorage in una transazione atomicamente serializzabile, non può proteggere browser/profili/dispositivi separati e non costituisce IndexedDB CAS. Mantenere #92/#91 aperte per quelle acceptance; il collaudo live PAT/OAuth è indipendente.
