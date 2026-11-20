# ADR 0081 — AI Code Reviewer: gate OpenAI-compatible sulla terminazione della risposta

**Data:** 2026-11-20  
**Issue:** #127 (segue #123 e #113)  
**Stato:** accepted, non provider-attested.

## Problema

L'esecutore opt-in off-host `ai-review-execute.mjs` fino a questa modifica estraeva `choices[0].message.content` e validava il rapporto `ReviewDocument`, ma non il metadata `finish_reason`, il `role` o l'unicità della choice. Un provider può restituire HTTP 200 con JSON valido e contemporaneamente dichiarare `length` (interruzione), `content_filter` oppure una tool-call. Il client avrebbe firmato quell'output come osservazione di review, benché l'endpoint non dichiarasse una conclusione normale.

## Decisione

Una nuova funzione pura lato client verifica il minimo envelope OpenAI-compatible dopo la lettura bounded HTTPS: oggetto con array `choices` di **esattamente un elemento**, `choice.finish_reason === "stop"`, `message.role === "assistant"`, contenuto stringa entro 8192 byte e nessun `refusal`, `tool_calls` o `function_call` attivo (null ammesso). Quindi si valida il JSON strutturato esistente. `length`, `content_filter`, `tool_calls`, `function_call`, null/missing, roles inattesi e choices multiple falliscono con `AI_REVIEW_INVALID` senza firma né retry. Nessuna modifica a `requestBody` (necessario per la verifica di receipts v1 precedenti), formula dei digest, modello di costo o schema della receipt.

## Limiti e verifica

Il metadata appartiene alla risposta HTTP del provider scelto, non a una firma verificabile dell'esecuzione AI: un endpoint controllato dall'operatore può falsificare `finish_reason:"stop"` e il report. Non si autorizza `review_submit`, `review_approve`, deploy o spese non approvate. Test Node con mock HTTP per casi negativi e positivi, nessun provider reale in CI; la protezione di rete pubblica DNS/TLS #125 e teardown #126 restano vigenti. #113/#109/#105 restano aperte.
