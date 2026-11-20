# ADR 0086 — Client AI browser: rifiuto delle completions dichiarate incomplete

**Data:** 2026-11-20  
**Issue:** #132 (progresso #109, #113)  
**Stato:** accepted con compatibilità legacy; non provider-attested.

## Problema
Il client `aiComplete` usato da tutte le fasi della SPA, il Code Agent e il PM planning sceglieva sempre `choices[0].message.content` quando non vuoto, anche in HTTP 2xx con `finish_reason: "length"`, `content_filter`, tool calls o `message.refusal`. Un testo troncato poteva diventare output di pianificazione o review e attivare una osservazione `onUsage`; questo non era coerente con il gate off-host dell'AI Reviewer (#127).

## Decisione
Validare l'envelope della risposta prima di inoltrare testo o `onUsage`: l'array `choices` deve avere cardinalità esatta 1 con `message` oggetto e contenuto stringa non vuota. Se `finish_reason` è presente, deve essere **esattamente** `"stop"`; se `message.role` è presente, deve essere **esattamente** `"assistant"`. Rifiutare anche `refusal`, `tool_calls`, `function_call` non-null. Nessun retry automatico né impegno monetario o approvazione implicita.

I provider OpenAI-compatible legacy che omettono completamente `finish_reason` o `role` restano accettati per non bloccare retroattivamente i client configurati; `null`, unknown o altri valori **esplicitamente presenti** falliscono. Questo è un controllo di coerenza dell'envelope **auto-dichiarata dal server**, non una attestazione che il modello abbia realmente eseguito o finito una task. Il client off-host #127, che firma receipt operatore e invia codice sorgente, mantiene il contratto più rigoroso richiedendo entrambi i campi.

## Verifica e limiti
Test Vitest di rifiuto fail-closed sui finish reason, role, refusal/tool call, cardinalità e contenuti malformati; regressioni integrate sulle chiamate a `runStage` e `reviewCode` con `onUsage` non invocato e senza checkpoint/review prodotta. Nessun provider reale o addebito testato. I token (se dichiarati in risposta accettata) restano `provider_reported_unverified`, volatili e non riconciliati; la spesa verificabile e provider identity restano nelle epiche #109/#113, orchestrazione #105.
