# ADR 0061 — UI operatore per DAG batch enforced

- Data: 18 novembre 2026
- Stato: accettato per #104, epic #89

## Contesto

La #103 offre un endpoint e un SDK di ammissione atomica, ma non una
schermata utilizzabile senza invocare l'API manualmente. Il Code Agent
ha già un percorso separato per approvazioni e repair con review.

## Decisione

Il Runner Panel espone un drawer/dettaglio avanzato con anteprima
deterministica di 2–5 step selezionati, dipendenze e ruoli, a partire dal
solo workspace approvato. La presenza di patch pending blocca il batch.
Una checkbox non preselezionata e una conferma con URL del runner e lista
di step precedono ogni invio di codice. Nessun effetto React invia POST.

La lettura dello stato è autenticata e verificata dal server via journal;
il frontend impone una validazione aggiuntiva su versione, UUID, ruoli,
DAG, status, head e count. Polling transitorio è limitato; perdita di auth
o integrità elimina il precedente report visibile. La sessione conserva
soltanto metadata UUID/digest/endpoint/revisione per retry dopo risposta
perduta, non segreti o file sorgenti. Un progetto modificato marca il
workflow come storico; il batch non aggiorna `lastRunnerEvidence` né
approva o applica patch. Le etichette sono parte dell'i18n IT/EN.

## Limiti

Il batch non è un agente PM/Tester indipendente e non prova un sandbox
rootless su VM reale. La firma SHA è identità di contenuti, non una
firma server o attestation off-host. Workflow e idempotency sono
conservati solo nella stessa sessione browser (e nel runner server);
nessun sync cloud multi-device è dichiarato.
