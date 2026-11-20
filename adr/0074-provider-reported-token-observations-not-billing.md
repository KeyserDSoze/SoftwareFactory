# ADR 0074 — Osservazioni di usage dalle risposte provider, non billing certificato

**Data:** 2026-11-20  
**Issue:** #121 (incremento di #109/#89)  
**Stato:** accepted per telemetria volatile, non per contabilità monetaria.

## Problema

La SPA usa `aiComplete` per pianificazione, generazione, review e repair e scarta l'eventuale campo `usage` restituito dai provider OpenAI-compatible. Nel runner il budget resta volutamente una stima e `executions:0`: mostrare un importo con prezzi presunti creerebbe falsi consuntivi. Occorre visibilità strettamente distinta da una prova di costo o esecuzione.

## Decisione

Preservare `aiComplete: Promise<string>` e supportare un observer facoltativo `onUsage` nel suo ultimo parametro. Valorizzarlo solo dopo una risposta HTTP 2xx con testo non vuoto e `usage` conforme ai tre interi non negativi `prompt_tokens`, `completion_tokens`, `total_tokens`, max un miliardo e `prompt + completion === total`. Nessuna estrapolazione di token dai caratteri e nessun evento di usage in presenza di campo mancante, risposta errata, abort o contatori incoerenti. Il callback è best-effort e non cambia il risultato del modello.

Il record in-memory `AiUsageObservation` dichiara `assurance:provider_reported_unverified`, profilo e modello richiesto, e soli contatori. Non includere body, prompt, URL, provider response id, token, secret o prezzi. La UI pipeline (log temporaneo) e Code Agent (ultima chiamata: writer/reviewer/repair) mostrano etichette IT/EN inequivocabili e nessun importo. Non serializzare in `FactoryProject`, cloud, GitHub, checkpoint runner o log permanenti.

## Rischi residui e prossime prove

I provider OpenAI-compatible possono non offrire usage, descriverlo con campi diversi o dichiarare numeri inesatti; la normalizzazione qui è **conservativa** e non misura provider billing. Non esiste ricevuta firmata/off-host né sincronizzazione con una risposta di fatturazione. Mancano pricing versionato per endpoint/modello, valuta, identità del provider, receipt idempotente server-side e reconciliation: rimangono #109/#105/#113. Non incrementare `executions` sul runner né sbloccare approvazioni della review per il solo field `usage`.
