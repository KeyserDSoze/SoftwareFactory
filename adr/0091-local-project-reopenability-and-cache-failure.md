# ADR 0091 — Riapribilità dello snapshot locale e cache best-effort dopo commit confermato

**Data:** 2026-11-20  
**Issue:** #137 (milestone delle #92 e #91)  
**Stato:** accepted — correzione di disponibilità locale, NON CAS multi-device.

## Contesto

`loadLocalProject` rifiutava snapshot oltre 1.000.000 caratteri, ma `persistProject` poteva salvarli restituendo successo. La libreria enumerata scartava subito il progetto salvato e, con un puntatore per-tab che tentava di riaprirlo, dopo il reload la SPA poteva mostrare un nuovo progetto. Inoltre `persistProject` scriveva prima lo slot autorevole e poi l'ultimo progetto globale e l'indice cache; un `QuotaExceededError` su una cache dopo il commit faceva segnalare errore nonostante i dati fossero già persistiti.

## Decisione

- Preflight sincrono *prima di qualsiasi modifica*: validazione ID, config.name, stages, updatedAt e `JSON.stringify` senza riferimenti ciclici; rigettare stringhe serializzate più lunghe di **1.000.000 caratteri**, applicando lo stesso limite dello slot reader. La lunghezza si misura in caratteri JS per coerenza retrocompatibile, non è un bound sulla quota reale del browser (dipendente dall'implementazione).
- Lo slot `softwarefactory.project.library.v1.<id>` viene scritto **prima** di qualsiasi metadato e confermato con un readback stringa identico. Errori/quote sullo slot o adapter che non persiste rifiutano il salvataggio senza avanzare altri puntatori.
- Il progetto globale legacy `softwarefactory.project.v1` e l'indice `softwarefactory.project.index.v1` sono viste recuperabili (ADR 0088), non il checkpoint autorevole. Dopo un commit dello slot confermato i due aggiornamenti sono best-effort: un errore di quota non deve generare un errore che invogli a ripetere un salvataggio che **è già avvenuto**. Tentare comunque il pointer per-tab in `sessionStorage`.
- `loadProject` applica anche al puntatore globale legacy il bound pre-parse. Il recupero da metadati non aggiornabili è possibile dalla libreria degli slot; dove sessionStorage è disabilitato e il puntatore legacy non si aggiorna, la selezione all'avvio potrebbe richiedere una scelta manuale.

## Limiti, test e conseguenze

Questo evita due tipi di false acknowledgement, ma non prova atomicità tra dati+metadati, persistenza di crash-safe fsync, Web Locks cross-profile né CAS transazionale dei writer non cooperativi. I backup esterni restano necessari. Test Vitest con storage Map emulato simulano quota del commit e delle cache, silent adapter, payload al limite e oltre, vecchi dati intatti, ID/schema/timestamp invalidi, CAS stale e selezione per-tab. Nessun provider cloud, PAT o disco reale è stato esercitato. #92/#91 restano aperte per i test multi-dispositivo e l'adozione di un database CAS persistente.
